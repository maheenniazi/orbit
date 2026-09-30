// Job & internship sources for the careers section (zero dependencies).
//  - SimplifyJobs community lists (Summer 2027 internships, new grad), updated hourly by Simplify + Pitt CSC
//  - Any company's public ATS board: greenhouse:<token>, lever:<company>, ashby:<board>
// Listings are cached in memory, filtered here, and only matches are sent to the browser.

const TTL = 30 * 60 * 1000;
const UA = { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15' };

const FEEDS = {
  internships: {
    label: 'Simplify internships (Summer 2027)',
    type: 'internship',
    urls: [process.env.JOBS_INTERNSHIPS_URL || 'https://raw.githubusercontent.com/SimplifyJobs/Summer2027-Internships/dev/.github/scripts/listings.json'],
  },
  newgrad: {
    label: 'Simplify new grad',
    type: 'newgrad',
    urls: [process.env.JOBS_NEWGRAD_URL || 'https://raw.githubusercontent.com/SimplifyJobs/New-Grad-Positions/dev/.github/scripts/listings.json'],
  },
};

const cache = new Map(); // key -> { at, items, error }

const arr = (v) => (Array.isArray(v) ? v.filter(Boolean).map(String) : v ? [String(v)] : []);
const ms = (v) => {
  if (!v) return 0;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;
  const t = Date.parse(v);
  return Number.isNaN(t) ? 0 : t;
};
const isRemote = (locs) => locs.some((l) => /remote/i.test(l));

function inferType(title) {
  if (/\bintern(ship)?s?\b|co-?op/i.test(title)) return 'internship';
  if (/new grad|graduate|entry[- ]level|early career|university|campus|junior|associate/i.test(title)) return 'newgrad';
  return 'job';
}
function inferTerms(text) {
  const out = new Set();
  for (const m of String(text).matchAll(/\b(summer|fall|autumn|spring|winter)\s*'?(20\d{2}|\d{2})\b/gi)) {
    const y = m[2].length === 2 ? '20' + m[2] : m[2];
    const season = m[1].toLowerCase() === 'autumn' ? 'Fall' : m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
    out.add(`${season} ${y}`);
  }
  return [...out];
}

// ---------- HTML -> text ----------
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', bull: '•', hellip: '…' };
function decode(s) {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
}
function htmlToText(html = '') {
  let s = String(html);
  if (/&lt;\w/.test(s) && !/<\w/.test(s)) s = decode(s); // Greenhouse double-encodes HTML
  s = s
    .replace(/<(script|style|noscript|svg|head|nav|footer)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<\/(p|div|li|ul|ol|h[1-6]|tr|section|article)>|<br\s*\/?>/gi, '\n')
    .replace(/<h[1-6][^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, ' ');
  return decode(s)
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function getJSON(url) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(25_000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// ---------- Feeds ----------
function normalizeSimplify(l, type) {
  const locations = arr(l.locations);
  return {
    id: `sim:${l.id || `${l.company_name}-${l.title}-${l.date_posted}`}`,
    source: 'simplify',
    company: l.company_name || l.company || '',
    title: l.title || '',
    locations,
    remote: isRemote(locations),
    terms: arr(l.terms).length ? arr(l.terms) : inferTerms(l.title || ''),
    type,
    category: l.category || '',
    url: l.url || l.company_url || '',
    posted: ms(l.date_posted || l.date_updated),
    sponsorship: l.sponsorship || '',
    degrees: arr(l.degrees),
    active: l.active !== false && l.is_visible !== false,
    desc: '',
  };
}

async function loadFeed(key) {
  const feed = FEEDS[key];
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL && hit.items) return hit;
  let lastErr;
  for (const url of feed.urls) {
    try {
      const data = await getJSON(url);
      const list = Array.isArray(data) ? data : data.listings || data.jobs || [];
      const entry = { at: Date.now(), items: list.map((l) => normalizeSimplify(l, feed.type)), error: null };
      cache.set(key, entry);
      return entry;
    } catch (e) {
      lastErr = e;
    }
  }
  // Keep serving stale data if a refresh fails
  if (hit?.items) return { ...hit, error: `refresh failed (${lastErr.message}); showing cached` };
  return { at: Date.now(), items: [], error: lastErr?.message || 'unavailable' };
}

// ---------- Company boards ----------
async function fetchBoard(spec) {
  const [ats, slugRaw] = String(spec).split(':');
  const slug = encodeURIComponent((slugRaw || '').trim().toLowerCase());
  if (!slug) throw new Error('missing company');
  if (ats === 'greenhouse') {
    const d = await getJSON(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`);
    const company = decodeURIComponent(slug);
    return (d.jobs || []).map((j) => {
      const locations = arr(j.location?.name);
      const desc = htmlToText(j.content || '').slice(0, 4000);
      return { id: `gh:${slug}:${j.id}`, source: `greenhouse:${company}`, company: j.company_name || company, title: j.title, locations, remote: isRemote(locations), terms: inferTerms(`${j.title} ${desc.slice(0, 600)}`), type: inferType(j.title), category: (j.departments || []).map((x) => x.name).join(', '), url: j.absolute_url, posted: ms(j.first_published || j.updated_at), sponsorship: '', degrees: [], active: true, desc };
    });
  }
  if (ats === 'lever') {
    const d = await getJSON(`https://api.lever.co/v0/postings/${slug}?mode=json`);
    const company = decodeURIComponent(slug);
    return (Array.isArray(d) ? d : []).map((j) => {
      const locations = arr(j.categories?.allLocations?.length ? j.categories.allLocations : j.categories?.location);
      const desc = (j.descriptionPlain || htmlToText(j.description || '')).slice(0, 4000);
      return { id: `lv:${slug}:${j.id}`, source: `lever:${company}`, company, title: j.text, locations, remote: isRemote(locations) || j.workplaceType === 'remote', terms: inferTerms(`${j.text} ${j.categories?.commitment || ''} ${desc.slice(0, 600)}`), type: /intern/i.test(j.categories?.commitment || '') ? 'internship' : inferType(j.text), category: [j.categories?.team, j.categories?.department].filter(Boolean).join(', '), url: j.hostedUrl, posted: ms(j.createdAt), sponsorship: '', degrees: [], active: true, desc };
    });
  }
  if (ats === 'ashby') {
    const d = await getJSON(`https://api.ashbyhq.com/posting-api/job-board/${slug}`);
    const company = decodeURIComponent(slug);
    return (d.jobs || []).filter((j) => j.isListed !== false).map((j) => {
      const locations = [j.location, ...(j.secondaryLocations || []).map((x) => x.location)].filter(Boolean);
      const desc = (j.descriptionPlain || htmlToText(j.descriptionHtml || '')).slice(0, 4000);
      return { id: `ab:${slug}:${j.id}`, source: `ashby:${company}`, company, title: j.title, locations, remote: j.isRemote || isRemote(locations), terms: inferTerms(`${j.title} ${desc.slice(0, 600)}`), type: /intern/i.test(j.employmentType || '') ? 'internship' : inferType(j.title), category: [j.department, j.team].filter(Boolean).join(', '), url: j.jobUrl, posted: ms(j.publishedAt), sponsorship: '', degrees: [], active: true, desc };
    });
  }
  throw new Error(`unknown board type "${ats}" (use greenhouse:, lever: or ashby:)`);
}

async function loadBoard(spec) {
  const key = `board:${spec}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit;
  try {
    const entry = { at: Date.now(), items: await fetchBoard(spec), error: null };
    cache.set(key, entry);
    return entry;
  } catch (e) {
    return { at: Date.now(), items: hit?.items || [], error: e.message };
  }
}

// ---------- Search ----------
const CATEGORY_RE = {
  software: /software|\bswe\b|developer|engineer|full.?stack|back.?end|front.?end|mobile|ios|android|platform|infrastructure|devops|security/i,
  data: /data|machine learning|\bml\b|\bai\b|artificial intelligence|analytics|scien|statistic/i,
  quant: /quant|trading|trader/i,
  product: /product/i,
  hardware: /hardware|electrical|embedded|firmware|asic|fpga|robotics|mechanical/i,
  design: /design|\bux\b|\bui\b|creative/i,
  research: /research/i,
  business: /business|finance|financial|consult|marketing|operations|strategy|analyst|sales|accounting|banking/i,
  psych: /psycholog|behavior|clinical|mental health|counsel|human factors|user research|ux research|people|\bhr\b|human resources/i,
};

const lc = (s) => String(s || '').toLowerCase();

function matches(item, f) {
  if (!f.includeInactive && !item.active) return false;
  if (f.types?.length && !f.types.includes(item.type)) return false;
  if (f.terms?.length) {
    const hay = lc(`${item.terms.join(' ')} ${item.title}`);
    if (!f.terms.some((t) => hay.includes(lc(t)))) return false;
  }
  if (f.remote && !item.remote) return false;
  if (f.locations?.length) {
    const locs = lc(item.locations.join(' | '));
    const ok = f.locations.some((l) => locs.includes(lc(l))) || (f.remoteOk && item.remote);
    if (!ok) return false;
  }
  if (f.categories?.length) {
    const hay = `${item.category} ${item.title}`;
    if (!f.categories.some((c) => (CATEGORY_RE[c] || new RegExp(c, 'i')).test(hay))) return false;
  }
  if (f.keywords) {
    const hay = lc(`${item.title} ${item.company} ${item.category} ${item.desc}`);
    if (!lc(f.keywords).split(/[\s,]+/).filter(Boolean).every((w) => hay.includes(w))) return false;
  }
  if (f.company && !lc(item.company).includes(lc(f.company))) return false;
  if (f.workAuth === 'needs' && /does not offer|no sponsorship|citizenship|u\.?s\.? citizen|clearance/i.test(item.sponsorship)) return false;
  if (f.workAuth === 'permanent' && /citizenship|u\.?s\.? citizen|clearance/i.test(item.sponsorship)) return false;
  if (f.postedWithinDays && item.posted && Date.now() - item.posted > f.postedWithinDays * 86400000) return false;
  return true;
}

async function search(f = {}) {
  const wantTypes = f.types?.length ? f.types : ['internship', 'newgrad', 'job'];
  const feedKeys = [];
  if (wantTypes.includes('internship')) feedKeys.push('internships');
  if (wantTypes.includes('newgrad') || wantTypes.includes('job')) feedKeys.push('newgrad');
  const boards = (f.companies || []).slice(0, 25);

  const [feeds, boardRes] = await Promise.all([
    Promise.all(feedKeys.map((k) => loadFeed(k).then((r) => [k, r]))),
    Promise.all(boards.map((b) => loadBoard(b).then((r) => [b, r]))),
  ]);

  const sources = {};
  const all = [];
  for (const [k, r] of feeds) { sources[FEEDS[k].label] = { count: r.items.length, error: r.error, at: r.at }; all.push(...r.items); }
  for (const [b, r] of boardRes) { sources[b] = { count: r.items.length, error: r.error, at: r.at }; all.push(...r.items); }

  const seen = new Set();
  const results = [];
  for (const it of all) {
    if (!matches(it, f)) continue;
    const key = lc(`${it.company}|${it.title}|${it.locations[0] || ''}`);
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(it);
  }
  results.sort((a, b) => b.posted - a.posted);
  const limit = Math.min(Number(f.limit) || 300, 600);
  return { total: results.length, results: results.slice(0, limit), sources };
}

// ---------- Job description fetch ----------
function isPrivateHost(host) {
  return /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[?::1\]?$)/i.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host) || host.endsWith('.local');
}

async function jobText(rawUrl) {
  let u;
  try { u = new URL(rawUrl); } catch { throw new Error('That doesn’t look like a link'); }
  if (!/^https?:$/.test(u.protocol) || isPrivateHost(u.hostname)) throw new Error('Only public job links are supported');

  // Clean APIs for common ATSes
  let m;
  if (/greenhouse\.io$/.test(u.hostname) && (m = u.pathname.match(/^\/(?:embed\/job_app\?.*)?([^/]+)\/jobs\/(\d+)/))) {
    const d = await getJSON(`https://boards-api.greenhouse.io/v1/boards/${m[1]}/jobs/${m[2]}`);
    return { title: d.title, company: d.company_name || m[1], location: d.location?.name || '', text: htmlToText(d.content || '') };
  }
  if (/greenhouse\.io$/.test(u.hostname) && u.searchParams.get('gh_jid') && (m = u.searchParams.get('for'))) {
    const d = await getJSON(`https://boards-api.greenhouse.io/v1/boards/${m}/jobs/${u.searchParams.get('gh_jid')}`);
    return { title: d.title, company: d.company_name || m, location: d.location?.name || '', text: htmlToText(d.content || '') };
  }
  if (u.hostname === 'jobs.lever.co' && (m = u.pathname.match(/^\/([^/]+)\/([0-9a-f-]{36})/))) {
    const d = await getJSON(`https://api.lever.co/v0/postings/${m[1]}/${m[2]}`);
    const lists = (d.lists || []).map((l) => `${l.text}\n${htmlToText(l.content)}`).join('\n\n');
    return { title: d.text, company: m[1], location: d.categories?.location || '', text: `${d.descriptionPlain || htmlToText(d.description)}\n\n${lists}\n\n${d.additionalPlain || ''}`.trim() };
  }

  // Generic page: prefer schema.org JobPosting JSON-LD (Workday, iCIMS, many career sites), else visible text
  const r = await fetch(u, { headers: UA, redirect: 'follow', signal: AbortSignal.timeout(20_000) });
  if (!r.ok) throw new Error(`The site returned ${r.status}. Paste the description instead.`);
  const html = await r.text();
  for (const block of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(block[1].trim());
      const list = [].concat(data['@graph'] || data);
      const jp = list.find((x) => x && (x['@type'] === 'JobPosting' || (Array.isArray(x['@type']) && x['@type'].includes('JobPosting'))));
      if (jp?.description) {
        const loc = [].concat(jp.jobLocation || [])[0]?.address;
        return { title: jp.title || '', company: jp.hiringOrganization?.name || '', location: loc ? [loc.addressLocality, loc.addressRegion].filter(Boolean).join(', ') : '', text: htmlToText(jp.description) };
      }
    } catch { /* ignore bad JSON-LD */ }
  }
  const title = decode((html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').trim();
  const text = htmlToText((html.match(/<main[\s\S]*?<\/main>/i) || html.match(/<body[\s\S]*<\/body>/i) || [html])[0]);
  if (text.length < 300) throw new Error('This site loads its job description with JavaScript, so I can’t read it. Paste the description instead.');
  return { title, company: '', location: '', text: text.slice(0, 20000) };
}

module.exports = { search, jobText, htmlToText, inferTerms, _cache: cache };
