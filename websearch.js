// Whole-web job sources. Each one needs its own free key in .env:
//  SERPAPI_KEY           → Google Jobs (Google's job index: LinkedIn, Indeed, Glassdoor, company career sites, startup boards…)
//  ADZUNA_APP_ID/_KEY    → Adzuna (large aggregator, Canada + US)
//  JOOBLE_API_KEY        → Jooble (large aggregator, Canada + US)
// Results are cached so repeat searches don't use up free quotas.
const env = process.env;
const TTL = 3 * 60 * 60 * 1000;
const cache = new Map();

const SOURCES = {
  google: { label: 'Google Jobs', ready: () => Boolean(env.SERPAPI_KEY) },
  adzuna: { label: 'Adzuna', ready: () => Boolean(env.ADZUNA_APP_ID && env.ADZUNA_APP_KEY) },
  jooble: { label: 'Jooble', ready: () => Boolean(env.JOOBLE_API_KEY) },
};
const status = () => Object.fromEntries(Object.entries(SOURCES).map(([k, v]) => [k, { label: v.label, ready: v.ready() }]));

const ROLE = { software: 'software engineer', data: 'data', quant: 'quantitative', product: 'product', hardware: 'hardware engineer', design: 'designer', research: 'research', business: 'business analyst', psych: 'psychology' };

// Turn filters into a few focused search queries: [{ what, where, country, text }]
function buildQueries(f) {
  const types = f.types?.length ? f.types : ['internship'];
  const typeWord = types.includes('internship') ? (f.region === 'US' ? 'intern' : 'intern co-op') : types.includes('newgrad') ? 'new grad' : '';
  const term = f.terms?.[0] || '';
  const roles = f.keywords ? [f.keywords] : (f.categories || []).slice(0, 3).map((c) => ROLE[c] || c);
  if (!roles.length) roles.push('');
  let places;
  if (f.locations?.length) places = f.locations.slice(0, 2).map((l) => ({ where: l, country: f.region === 'US' ? 'us' : 'ca' }));
  else if (f.region === 'US') places = [{ where: '', country: 'us' }];
  else if (f.region === 'CA_US') places = [{ where: '', country: 'ca' }, { where: '', country: 'us' }];
  else if (f.region === 'any') places = [{ where: '', country: 'ca' }];
  else places = [{ where: '', country: 'ca' }];
  if (f.remote) places = [{ where: 'remote', country: places[0].country }];
  const out = [];
  for (const role of roles) for (const p of places) {
    const what = [role, typeWord, term].filter(Boolean).join(' ').trim() || 'internship';
    const whereText = p.where || (p.country === 'us' ? 'United States' : 'Canada');
    out.push({ what, where: p.where, country: p.country, text: `${what} in ${whereText}` });
  }
  return out.slice(0, 4);
}

const clean = (s) => String(s ?? '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
function relTime(s) {
  const m = String(s || '').match(/(\d+)\+?\s*(minute|hour|day|week|month)s?\s+ago/i);
  if (!m) return /just posted|today/i.test(s) ? Date.now() : 0;
  const mult = { minute: 6e4, hour: 36e5, day: 864e5, week: 6048e5, month: 2592e6 }[m[2].toLowerCase()];
  return Date.now() - +m[1] * mult;
}
async function getJSON(url, opts = {}) {
  const r = await fetch(url, { ...opts, signal: AbortSignal.timeout(25_000) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) throw new Error(typeof d.error === 'string' ? d.error : d.error?.message || d.message || `HTTP ${r.status}`);
  return d;
}

const fetchers = {
  // SerpApi Google Jobs: 10 results/page, next_page_token for more. Each page = 1 search from your quota.
  async google(q, pages) {
    const out = [];
    let token = '';
    for (let i = 0; i < pages; i++) {
      const params = new URLSearchParams({ engine: 'google_jobs', q: q.text, gl: q.country, hl: 'en', google_domain: q.country === 'us' ? 'google.com' : 'google.ca', api_key: env.SERPAPI_KEY });
      if (token) params.set('next_page_token', token);
      const d = await getJSON(`https://serpapi.com/search.json?${params}`);
      for (const j of d.jobs_results || []) {
        const apply = (j.apply_options || []).find((a) => a.link && !/linkedin|indeed|glassdoor|ziprecruiter/i.test(a.title || a.link)) || (j.apply_options || [])[0];
        out.push({
          id: `g:${j.job_id || `${j.company_name}-${j.title}`}`.slice(0, 200),
          company: j.company_name || '', title: j.title || '', locations: [j.location].filter(Boolean),
          remote: Boolean(j.detected_extensions?.work_from_home) || /remote/i.test(j.location || ''),
          url: apply?.link || j.share_link || '', via: clean(j.via || '').replace(/^via\s+/i, ''),
          posted: relTime(j.detected_extensions?.posted_at), desc: clean(j.description).slice(0, 4000),
          schedule: j.detected_extensions?.schedule_type || '',
        });
      }
      token = d.serpapi_pagination?.next_page_token || '';
      if (!token) break;
    }
    return out;
  },
  // Adzuna: up to 50 per page
  async adzuna(q, pages, f) {
    const out = [];
    for (let page = 1; page <= pages; page++) {
      const params = new URLSearchParams({ app_id: env.ADZUNA_APP_ID, app_key: env.ADZUNA_APP_KEY, results_per_page: '50', what: q.what, 'content-type': 'application/json' });
      if (q.where && q.where !== 'remote') params.set('where', q.where);
      if (f.postedWithinDays) params.set('max_days_old', String(f.postedWithinDays));
      const d = await getJSON(`https://api.adzuna.com/v1/api/jobs/${q.country}/search/${page}?${params}`);
      for (const j of d.results || []) out.push({
        id: `az:${j.id}`, company: clean(j.company?.display_name), title: clean(j.title), locations: [clean(j.location?.display_name)].filter(Boolean),
        remote: /remote/i.test(`${j.title} ${j.description}`), url: j.redirect_url || '', via: 'Adzuna', posted: Date.parse(j.created) || 0,
        desc: clean(j.description).slice(0, 4000), schedule: [j.contract_time, j.contract_type].filter(Boolean).join(' '), category: j.category?.label || '',
      });
      if ((d.results || []).length < 50) break;
    }
    return out;
  },
  // Jooble: country-specific host (ca.jooble.org for Canada)
  async jooble(q, pages) {
    const out = [];
    const host = q.country === 'us' ? 'jooble.org' : 'ca.jooble.org';
    for (let page = 1; page <= pages; page++) {
      const d = await getJSON(`https://${host}/api/${encodeURIComponent(env.JOOBLE_API_KEY)}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ keywords: q.what, location: q.where === 'remote' ? '' : q.where || (q.country === 'us' ? '' : 'Canada'), page: String(page) }),
      });
      for (const j of d.jobs || []) out.push({
        id: `jb:${j.id || j.link}`, company: clean(j.company), title: clean(j.title), locations: [clean(j.location)].filter(Boolean),
        remote: /remote/i.test(`${j.location} ${j.title}`), url: j.link || '', via: clean(j.source) || 'Jooble', posted: Date.parse(j.updated) || 0,
        desc: clean(j.snippet).slice(0, 2000), schedule: j.type || '', salary: j.salary || '',
      });
      if ((d.jobs || []).length < 20) break;
    }
    return out;
  },
};

// Run every enabled source for every query. Returns raw items + per-source status.
async function searchWeb(f, wanted) {
  const queries = buildQueries(f);
  const pages = Math.max(1, Math.min(3, Number(env.WEB_JOB_PAGES) || 2));
  const keys = Object.keys(SOURCES).filter((k) => SOURCES[k].ready() && (!wanted || wanted.includes(k)));
  const sources = {};
  const items = [];
  await Promise.all(keys.map(async (k) => {
    const label = SOURCES[k].label;
    const errors = [];
    let count = 0;
    // Google Jobs uses a paid-per-search quota (free plan: 250/month), so keep it to 1 page × 2 queries by default
    const srcPages = k === 'google' ? Math.max(1, Math.min(3, Number(env.SERPAPI_PAGES) || 1)) : pages;
    for (const q of k === 'google' ? queries.slice(0, 2) : queries) {
      const ck = `${k}|${q.text}|${q.country}|${f.postedWithinDays || 0}|${srcPages}`;
      let hit = cache.get(ck);
      if (!hit || Date.now() - hit.at > TTL) {
        try {
          hit = { at: Date.now(), items: await fetchers[k](q, srcPages, f) };
          cache.set(ck, hit);
        } catch (e) {
          errors.push(e.name === 'TimeoutError' ? 'timed out' : e.message);
          continue;
        }
      }
      hit.items.forEach((it) => items.push({ ...it, source: k, query: q.text }));
      count += hit.items.length;
    }
    sources[label] = { count, error: errors.length ? [...new Set(errors)].join('; ') : null, at: Date.now(), queries: queries.map((q) => q.text) };
  }));
  return { items, sources, queries };
}

module.exports = { searchWeb, buildQueries, status, SOURCES };
