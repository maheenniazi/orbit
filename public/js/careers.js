// Careers: find internships/jobs that fit you, tailor resumes/CVs/cover letters, track applications.
import { store, addEvents } from './store.js';
import { aiEnabled, ask } from './ai.js';
import { esc, md, uid, todayISO, fmtDate, extractJSON } from './util.js';
import { toast, readFileText, spinner, modal } from './ui.js';

const car = () => store.get().careers;
const updCar = (fn) => store.update((s) => fn(s.careers));

// ============ Query parsing ("summer 2027 software internships in nyc or remote") ============
const CITY_ALIASES = {
  nyc: 'New York', 'new york': 'New York', manhattan: 'New York', brooklyn: 'New York', sf: 'San Francisco', 'san francisco': 'San Francisco',
  'bay area': 'CA', 'silicon valley': 'CA', la: 'Los Angeles', 'los angeles': 'Los Angeles', boston: 'Boston', seattle: 'Seattle', chicago: 'Chicago',
  austin: 'Austin', dc: 'Washington', 'washington dc': 'Washington', atlanta: 'Atlanta', miami: 'Miami', denver: 'Denver', philly: 'Philadelphia',
  philadelphia: 'Philadelphia', pittsburgh: 'Pittsburgh', toronto: 'Toronto', london: 'London', california: 'CA', texas: 'TX', 'new jersey': 'NJ',
  massachusetts: 'MA', washington: 'WA', illinois: 'IL', 'north carolina': 'NC', georgia: 'GA', florida: 'FL', colorado: 'CO', 'san diego': 'San Diego',
  'san jose': 'San Jose', 'mountain view': 'Mountain View', 'palo alto': 'Palo Alto', 'menlo park': 'Menlo Park', dallas: 'Dallas', houston: 'Houston',
  canada: 'Canada', uk: 'UK',
};
const CATEGORY_WORDS = {
  software: /\b(software|swe|sde|developer|coding|full.?stack|back.?end|front.?end|web|mobile|ios|android)\b/,
  data: /\b(data|ml|machine learning|ai|analytics|data science)\b/,
  quant: /\b(quant|trading)\b/,
  product: /\b(product|pm|apm)\b/,
  hardware: /\b(hardware|electrical|embedded|robotics|mechanical)\b/,
  design: /\b(design|ux|ui)\b/,
  research: /\bresearch\b/,
  business: /\b(business|finance|consulting|marketing|banking|operations|strategy)\b/,
  psych: /\b(psych|psychology|behavioral|clinical|mental health)\b/,
};
export const CATEGORY_LABELS = { software: 'software', data: 'data / ai', quant: 'quant', product: 'product', hardware: 'hardware', design: 'design', research: 'research', business: 'business', psych: 'psych / people' };

export function parseJobQuery(q) {
  const t = ` ${q.toLowerCase()} `;
  const f = { types: [], terms: [], locations: [], categories: [], remote: false, remoteOk: false, postedWithinDays: 0, keywords: '' };
  if (/\bintern(ship)?s?\b|co-?op/.test(t)) f.types.push('internship');
  if (/new ?grad|entry.?level|early career|graduate role/.test(t)) f.types.push('newgrad');
  if (/\bfull.?time\b|\bjobs?\b(?!.*intern)/.test(t) && !f.types.length) f.types.push('newgrad', 'job');
  const now = new Date();
  for (const m of t.matchAll(/\b(summer|fall|autumn|spring|winter)\s*'?(20\d{2}|\d{2})?\b/g)) {
    const season = m[1] === 'autumn' ? 'Fall' : m[1][0].toUpperCase() + m[1].slice(1);
    let y = m[2] ? (m[2].length === 2 ? '20' + m[2] : m[2]) : String(now.getFullYear() + (now.getMonth() >= 5 && season === 'Summer' ? 1 : 0));
    f.terms.push(`${season} ${y}`);
  }
  if (/\bremote\b/.test(t)) {
    if (/\bor remote\b|remote or|remote ok|\+ ?remote/.test(t) || /\bin\b/.test(t.replace(/remote/g, ''))) f.remoteOk = true;
    else f.remote = true;
  }
  const aliasKeys = Object.keys(CITY_ALIASES).sort((a, b) => b.length - a.length);
  for (const k of aliasKeys) {
    if (new RegExp(`\\b${k}\\b`).test(t) && !f.locations.includes(CITY_ALIASES[k])) f.locations.push(CITY_ALIASES[k]);
  }
  if (f.locations.length && f.remote) { f.remote = false; f.remoteOk = true; }
  for (const [k, re] of Object.entries(CATEGORY_WORDS)) if (re.test(t)) f.categories.push(k);
  if (/\b(today|past day|last 24)/.test(t)) f.postedWithinDays = 1;
  else if (/\b(this week|past week|last week|new|recent)\b/.test(t)) f.postedWithinDays = 7;
  else if (/\b(this month|past month)\b/.test(t)) f.postedWithinDays = 30;
  const kw = t.match(/\b(?:at|with|using)\s+([a-z0-9+#.]+)/);
  if (kw && !CITY_ALIASES[kw[1]]) f.keywords = kw[1];
  return f;
}

// ============ Fit scoring against profile + resume ============
const STOP = new Set('and or the a an of to in for with on at by from as is are be this that your you our we will work team using experience skills ability strong'.split(' '));
function profileTokens() {
  const { profile: p, resume } = car();
  const skills = `${p.skills}`.toLowerCase().split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);
  const roles = `${p.targetRoles}`.toLowerCase().split(/[,;\n]+/).map((s) => s.trim()).filter(Boolean);
  const resumeWords = new Set((resume.toLowerCase().match(/[a-z][a-z+#.]{1,}/g) || []).filter((w) => !STOP.has(w)));
  return { skills, roles, resumeWords, prefLocs: `${p.locations}`.toLowerCase().split(/[,;]+/).map((s) => s.trim()).filter(Boolean) };
}
export function fitScore(job, tok = profileTokens()) {
  const hay = `${job.title} ${job.category} ${job.desc || ''}`.toLowerCase();
  const matched = tok.skills.filter((s) => s && hay.includes(s));
  const roleHit = tok.roles.some((r) => r.split(/\s+/).every((w) => hay.includes(w)));
  const resumeHits = (job.title.toLowerCase().match(/[a-z]{3,}/g) || []).filter((w) => !STOP.has(w) && tok.resumeWords.has(w)).length;
  const locHit = !tok.prefLocs.length || job.remote || tok.prefLocs.some((l) => job.locations.join(' ').toLowerCase().includes(l));
  const fresh = job.posted ? Math.max(0, 1 - (Date.now() - job.posted) / (30 * 86400000)) : 0.3;
  let score = 20 + (roleHit ? 30 : 0) + Math.min(30, matched.length * 10) + Math.min(10, resumeHits * 4) + (locHit ? 5 : 0) + fresh * 5;
  if (!tok.skills.length && !tok.roles.length && !tok.resumeWords.size) score = 0;
  return { score: Math.round(Math.min(99, score)), matched };
}

// ============ Document generation ============
const DOC_KINDS = {
  resume: { label: 'resume', desc: '1 page, tailored bullets' },
  cv: { label: 'CV', desc: 'full academic CV' },
  cover: { label: 'cover letter', desc: '3–4 paragraphs' },
};

function profileBlock() {
  const p = car().profile;
  return Object.entries({
    Name: p.name, Email: p.email, Phone: p.phone, Location: p.location, Links: p.links, School: p.school, Degree: p.degree,
    'Graduation': p.gradDate, GPA: p.gpa, 'Work authorization': { citizen: 'US citizen', permanent: 'Permanent resident', needs: 'Will need visa sponsorship' }[p.workAuth],
    'Target roles': p.targetRoles, Skills: p.skills, 'Other things about me': p.extra,
  }).filter(([, v]) => v && String(v).trim()).map(([k, v]) => `${k}: ${v}`).join('\n');
}

function docPrompt(kind, job) {
  const rules = `STRICT HONESTY RULES:
- Use ONLY facts found in the candidate's resume and profile. Never invent employers, titles, dates, degrees, awards, metrics, or technologies.
- You MAY reorder sections, choose which bullets to include, rephrase bullets with stronger verbs, and mirror the job's wording WHEN it truthfully describes what the candidate did.
- If a number isn't in the source, don't add one.`;
  const format = {
    resume: `Write a ONE-PAGE, ATS-friendly resume in Markdown using exactly this structure:
# Full Name
email · phone · location · links (one line, only what's provided)
## Education
### School — Degree | Dates
- GPA / relevant coursework / honors (only if provided)
## Experience
### Title — Organization | Location | Dates
- 2–4 bullets, strongest and most relevant to the job first
## Projects   (only if the source has projects)
## Leadership & Activities   (only if present)
## Skills
- **Category:** comma-separated items
Order experience and bullets by relevance to the job. Keep it to what fits on one page (about 450–600 words).`,
    cv: `Write a complete academic-style CV in Markdown:
# Full Name
contact line
## Education  ## Research Experience  ## Professional Experience  ## Publications & Presentations  ## Teaching  ## Honors & Awards  ## Skills  ## Activities
Only include sections that have real content in the source. Use "### Role — Organization | Dates" headings with bullets. A CV can be longer than one page; include everything relevant.`,
    cover: `Write a cover letter in Markdown:
# Full Name
contact line
Then the date, "Dear Hiring Team," (or the hiring manager's name if given), 3–4 short paragraphs: why this role/company specifically (use details from the posting), 2 concrete examples from the candidate's real experience that match the job's requirements, and a confident close. Sign off with the candidate's name. Warm and genuine, not generic; under 350 words.`,
  }[kind];
  return {
    system: `You are an expert career coach and resume writer for college students. ${rules}\n\n${format}\n\nAfter the document, output a line with exactly ===NOTES=== and then:\n- **What I tailored:** 2–4 bullets\n- **Keywords from the posting you're missing:** comma list (only real gaps, no fabrications)\n- **Tips:** 1–3 honest suggestions to strengthen the application`,
    user: `# Job posting\nCompany: ${job.company || 'unknown'}\nTitle: ${job.title || 'unknown'}\n${job.location ? 'Location: ' + job.location + '\n' : ''}\n${job.text.slice(0, 14000)}\n\n# Candidate profile\n${profileBlock() || '(none)'}\n\n# Candidate's default resume\n${car().resume.slice(0, 14000) || '(none provided)'}`,
  };
}

// Offline: keyword gap report so the tab still does something useful without AI.
function localKeywordReport(jobTextStr) {
  const words = (jobTextStr.toLowerCase().match(/[a-z][a-z+#.]{2,}/g) || []).filter((w) => !STOP.has(w));
  const freq = {};
  words.forEach((w) => (freq[w] = (freq[w] || 0) + 1));
  const resume = car().resume.toLowerCase() + ' ' + car().profile.skills.toLowerCase();
  const top = Object.entries(freq).filter(([w]) => w.length > 3).sort((a, b) => b[1] - a[1]).slice(0, 40).map(([w]) => w);
  const have = top.filter((w) => resume.includes(w));
  const missing = top.filter((w) => !resume.includes(w)).slice(0, 15);
  return { have, missing };
}

// ============ Printing (Save as PDF) ============
export function printDoc(body, title) {
  const w = window.open('', '_blank');
  if (!w) return toast('allow pop-ups to download the PDF');
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
  <link href="https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=DM+Sans:opsz,wght@9..40,400;9..40,600&display=swap" rel="stylesheet">
  <style>
    @page { size: letter; margin: .55in .6in; }
    body { font: 10.5pt/1.38 'DM Sans', Helvetica, Arial, sans-serif; color: #1d1712; margin: 0; }
    h2 { font: 400 25pt/1 'DM Serif Display', Georgia, serif; margin: 0 0 4px; letter-spacing: -.3px; }
    h2 + p { margin: 0 0 10px; color: #4a4038; font-size: 9.5pt; }
    h3 { font-size: 9pt; letter-spacing: .14em; text-transform: uppercase; border-bottom: 1px solid #1d1712; padding-bottom: 2px; margin: 12px 0 5px; font-weight: 600; }
    h4 { font-size: 10.5pt; margin: 7px 0 1px; font-weight: 600; }
    ul { margin: 2px 0 4px; padding-left: 16px; } li { margin: 1px 0; }
    p { margin: 4px 0; } mark { background: none; }
    .cover p { margin: 0 0 10px; font-size: 11pt; line-height: 1.5; }
  </style></head><body class="${/cover/i.test(title) ? 'cover' : ''}">${md(body)}</body></html>`);
  w.document.close();
  setTimeout(() => { w.focus(); w.print(); }, 700);
}

// ============ View ============
const ui = { tab: 'find', results: null, total: 0, sources: null, loading: false, shown: 40, aiRank: null, selectedDoc: null, jobDraft: null };
const STATUSES = ['saved', 'applied', 'interview', 'offer', 'rejected'];

function defaultFilters() {
  const p = car().profile;
  return { types: ['internship'], terms: [], locations: [], categories: [], remote: false, remoteOk: false, postedWithinDays: 0, keywords: '', workAuth: p.workAuth === 'needs' ? 'needs' : p.workAuth === 'permanent' ? 'permanent' : '' };
}

export function render(el) {
  if (!car().resume && ui.tab === 'find' && !car().profile.name) ui.tab = 'profile';

  const draw = () => {
    const c = car();
    el.innerHTML = `
      <div class="page-head view-enter">
        <div>
          <div class="kicker">careers · ${c.saved.length} tracked · ${c.docs.length} documents</div>
          <h1>your <em>next move</em></h1>
          <p>find internships and jobs that actually fit you, then get a resume tailored to each one.</p>
        </div>
        <div class="seg" id="tabs">${[['find', 'find'], ['tailor', 'tailor'], ['tracker', 'tracker'], ['profile', 'profile']].map(([k, l]) => `<button data-tab="${k}" class="${ui.tab === k ? 'on' : ''}">${l}</button>`).join('')}</div>
      </div>
      <div id="tab" class="view-enter"></div>`;
    el.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => { ui.tab = b.dataset.tab; draw(); }));
    const tab = el.querySelector('#tab');
    ({ find: drawFind, tailor: drawTailor, tracker: drawTracker, profile: drawProfile })[ui.tab](tab, draw);
  };
  draw();
}

// ---------- FIND ----------
function drawFind(el, redraw) {
  const c = car();
  const f = c.filters || defaultFilters();
  const hasProfile = Boolean(c.resume || c.profile.skills || c.profile.targetRoles);
  const chip = (on, attr, label) => `<span class="chip ${on ? 'on' : ''}" ${attr}>${label}</span>`;

  el.innerHTML = `
    <div class="card" style="margin-bottom:22px">
      <div class="quick-add"><input id="q" placeholder="try “summer 2027 software internships in nyc or remote”"><button class="btn" id="go">search</button></div>
      <div class="row" style="margin-top:16px;gap:18px;align-items:flex-start">
        <div class="stack" style="gap:8px;flex:1;min-width:260px">
          <div class="label small muted">type</div>
          <div class="filters">${chip(f.types.includes('internship'), 'data-type="internship"', 'internship')}${chip(f.types.includes('newgrad'), 'data-type="newgrad"', 'new grad')}${chip(f.types.includes('job'), 'data-type="job"', 'other jobs')}</div>
          <div class="label small muted" style="margin-top:6px">field</div>
          <div class="filters">${Object.entries(CATEGORY_LABELS).map(([k, l]) => chip(f.categories.includes(k), `data-cat="${k}"`, l)).join('')}</div>
        </div>
        <div class="stack" style="gap:10px;flex:1;min-width:260px">
          <div class="row"><label class="field">term<input id="f-term" value="${esc(f.terms.join(', '))}" placeholder="Summer 2027"></label><label class="field">location<input id="f-loc" value="${esc(f.locations.join(', '))}" placeholder="New York, Boston"></label></div>
          <div class="row">
            <label class="field">posted<select id="f-posted">${[[0, 'any time'], [1, 'past day'], [7, 'past week'], [30, 'past month']].map(([v, l]) => `<option value="${v}" ${+f.postedWithinDays === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
            <label class="field">keyword<input id="f-kw" value="${esc(f.keywords)}" placeholder="python, figma…"></label>
          </div>
          <div class="row" style="gap:18px">
            <label class="check small"><input type="checkbox" id="f-remote" ${f.remote ? 'checked' : ''}> remote only</label>
            <label class="check small"><input type="checkbox" id="f-remoteok" ${f.remoteOk ? 'checked' : ''}> include remote</label>
            <label class="check small"><input type="checkbox" id="f-auth" ${f.workAuth ? 'checked' : ''}> hide roles I can’t take (work auth)</label>
          </div>
        </div>
      </div>
      <details style="margin-top:14px"><summary class="small muted" style="cursor:pointer">sources: Simplify’s Summer 2027 + new-grad lists, plus these company boards</summary>
        <div class="row" style="margin-top:10px"><input id="boards" value="${esc(c.boards)}" placeholder="greenhouse:figma, lever:palantir, ashby:ramp" style="flex:1"><button class="btn ghost sm" id="save-boards">save</button></div>
        <p class="small muted" style="margin:6px 0 0">add any company that uses Greenhouse, Lever or Ashby: the part after <code>boards.greenhouse.io/</code>, <code>jobs.lever.co/</code> or <code>jobs.ashbyhq.com/</code> in their careers link.</p>
      </details>
    </div>
    ${hasProfile ? '' : '<div class="card" style="margin-bottom:22px"><div class="row spread"><span>add your resume in <b>profile</b> so results get a fit score and ranking.</span><button class="btn sm" id="to-profile">set up profile</button></div></div>'}
    <div id="results"></div>`;

  const $ = (q) => el.querySelector(q);
  const readFilters = () => ({
    ...f,
    terms: $('#f-term').value.split(',').map((s) => s.trim()).filter(Boolean),
    locations: $('#f-loc').value.split(',').map((s) => s.trim()).filter(Boolean),
    postedWithinDays: +$('#f-posted').value,
    keywords: $('#f-kw').value.trim(),
    remote: $('#f-remote').checked,
    remoteOk: $('#f-remoteok').checked,
    workAuth: $('#f-auth').checked ? (c.profile.workAuth === 'citizen' ? '' : c.profile.workAuth) || '' : '',
  });
  const saveFilters = (nf) => updCar((cc) => (cc.filters = nf));

  el.querySelectorAll('[data-type]').forEach((b) => (b.onclick = () => {
    const nf = readFilters(); const t = b.dataset.type;
    nf.types = nf.types.includes(t) ? nf.types.filter((x) => x !== t) : [...nf.types, t];
    saveFilters(nf); drawFind(el, redraw);
  }));
  el.querySelectorAll('[data-cat]').forEach((b) => (b.onclick = () => {
    const nf = readFilters(); const k = b.dataset.cat;
    nf.categories = nf.categories.includes(k) ? nf.categories.filter((x) => x !== k) : [...nf.categories, k];
    saveFilters(nf); drawFind(el, redraw);
  }));
  $('#to-profile')?.addEventListener('click', () => { ui.tab = 'profile'; redraw(); });
  $('#save-boards').onclick = () => { updCar((cc) => (cc.boards = $('#boards').value)); toast('sources saved'); };

  const run = async () => {
    let nf = readFilters();
    const q = $('#q').value.trim();
    if (q) {
      const p = parseJobQuery(q);
      nf = { ...nf, ...p, workAuth: nf.workAuth, types: p.types.length ? p.types : nf.types };
    }
    saveFilters(nf);
    const companies = car().boards.split(/[,\s]+/).map((s) => s.trim()).filter((s) => /^(greenhouse|lever|ashby):\S+$/.test(s));
    ui.loading = true; ui.aiRank = null; ui.shown = 40;
    drawFind(el, redraw);
    el.querySelector('#q').value = q;
    try {
      const r = await fetch('/api/jobs/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...nf, companies }) });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'search failed');
      const tok = profileTokens();
      ui.results = data.results.map((j) => ({ ...j, fit: fitScore(j, tok) }));
      if (hasProfile) ui.results.sort((a, b) => b.fit.score - a.fit.score || b.posted - a.posted);
      ui.total = data.total; ui.sources = data.sources;
    } catch (e) {
      ui.results = []; ui.total = 0; ui.sources = { error: { error: e.message, count: 0 } };
    }
    ui.loading = false;
    drawResults();
  };
  $('#go').onclick = run;
  $('#q').onkeydown = (e) => e.key === 'Enter' && run();

  function drawResults() {
    const box = el.querySelector('#results');
    if (!box) return;
    if (ui.loading) { box.innerHTML = `<div class="card">${spinner('scanning listings…')}</div>`; return; }
    if (!ui.results) { box.innerHTML = '<div class="empty"><span class="big">search the galaxy.</span>results show up here, ranked by how well they fit you</div>'; return; }
    const errs = Object.entries(ui.sources || {}).filter(([, v]) => v.error);
    const savedIds = new Set(car().saved.map((s) => s.id));
    const list = ui.aiRank ? [...ui.results].sort((a, b) => (ui.aiRank[b.id]?.score ?? -1) - (ui.aiRank[a.id]?.score ?? -1)) : ui.results;
    box.innerHTML = `
      <div class="row spread" style="margin-bottom:12px">
        <span class="label small muted">${ui.total} match${ui.total === 1 ? '' : 'es'}${hasProfile ? ' · sorted by fit' : ' · newest first'}</span>
        ${aiEnabled() && ui.results.length && hasProfile ? `<button class="btn ghost sm" id="ai-rank">${ui.aiRank ? 're-rank with ai' : 'rank top 30 with ai'}</button>` : ''}
      </div>
      ${errs.length ? `<div class="small muted" style="margin-bottom:14px">couldn’t reach: ${errs.map(([k, v]) => `<b>${esc(k)}</b> (${esc(v.error)})`).join(', ')}</div>` : ''}
      ${list.length ? `<div class="stack" style="gap:12px">${list.slice(0, ui.shown).map((j) => jobCard(j, savedIds.has(j.id))).join('')}</div>` : '<div class="card empty"><span class="big">no matches.</span>try fewer filters, or a different term like “Summer 2027”</div>'}
      ${list.length > ui.shown ? '<div class="row" style="justify-content:center;margin-top:16px"><button class="btn ghost" id="more">show more</button></div>' : ''}`;
    box.querySelector('#more')?.addEventListener('click', () => { ui.shown += 40; drawResults(); });
    box.querySelector('#ai-rank')?.addEventListener('click', aiRank);
    box.querySelectorAll('[data-save]').forEach((b) => (b.onclick = () => { saveJob(ui.results.find((j) => j.id === b.dataset.save)); drawResults(); }));
    box.querySelectorAll('[data-tailor]').forEach((b) => (b.onclick = () => {
      const j = ui.results.find((x) => x.id === b.dataset.tailor);
      ui.jobDraft = { url: j.url, company: j.company, title: j.title, location: j.locations.join('; '), text: j.desc || '' };
      ui.tab = 'tailor'; redraw();
    }));
  }

  async function aiRank() {
    const btn = el.querySelector('#ai-rank');
    btn.disabled = true; btn.textContent = 'ranking…';
    const top = ui.results.slice(0, 30);
    try {
      const reply = await ask({
        system: 'You are a career advisor. Rank job postings by fit for this student. Consider their target roles, skills, experience level, class year, location preferences and work authorization. Return ONLY JSON: [{"id":"...","score":0-100,"why":"max 14 words, specific"}].',
        messages: [{ role: 'user', content: `# Student\n${profileBlock()}\n\n# Resume\n${car().resume.slice(0, 6000)}\n\n# Postings\n${top.map((j) => `${j.id} | ${j.company} | ${j.title} | ${j.locations.slice(0, 3).join('; ')} | ${j.terms.join(', ')} | ${j.category} | ${j.sponsorship || ''}`).join('\n')}` }],
        maxTokens: 3000,
      });
      const arr = extractJSON(reply);
      ui.aiRank = Object.fromEntries(arr.filter((x) => x.id).map((x) => [x.id, x]));
      toast('ranked by ai');
    } catch (e) {
      toast(`ai ranking failed: ${e.message}`);
    }
    drawResults();
  }
  drawResults();
}

function jobCard(j, saved) {
  const ai = ui.aiRank?.[j.id];
  const score = ai?.score ?? j.fit?.score;
  const posted = j.posted ? Math.round((Date.now() - j.posted) / 86400000) : null;
  return `<div class="card job-card">
    <div class="job-main">
      <div class="label small muted">${esc(j.company)}${j.category ? ' · ' + esc(j.category.split(',')[0]) : ''}</div>
      <div class="job-title">${esc(j.title)}</div>
      <div class="small muted">${esc(j.locations.slice(0, 3).join(' · ') || 'location n/a')}${j.locations.length > 3 ? ` +${j.locations.length - 3}` : ''}</div>
      <div class="row" style="margin-top:8px;gap:6px">
        ${j.terms.slice(0, 3).map((t) => `<span class="chip">${esc(t)}</span>`).join('')}
        ${j.remote ? '<span class="chip">remote</span>' : ''}
        ${j.sponsorship ? `<span class="chip" title="sponsorship">${esc(j.sponsorship.toLowerCase())}</span>` : ''}
        ${posted != null ? `<span class="small faint">${posted === 0 ? 'posted today' : `${posted}d ago`}</span>` : ''}
      </div>
      ${ai?.why ? `<div class="hand" style="margin-top:8px;font-size:19px">${esc(ai.why)}</div>` : j.fit?.matched?.length ? `<div class="small muted" style="margin-top:8px">matches your: ${esc(j.fit.matched.slice(0, 5).join(', '))}</div>` : ''}
    </div>
    <div class="job-side">
      ${score ? `<div class="fit" style="--p:${score}"><span>${score}</span><small>fit</small></div>` : ''}
      <div class="row" style="justify-content:flex-end">
        <a class="btn ghost sm" href="${esc(j.url)}" target="_blank" rel="noopener">open</a>
        <button class="btn ghost sm" data-save="${esc(j.id)}" ${saved ? 'disabled' : ''}>${saved ? 'saved' : 'save'}</button>
        <button class="btn sm" data-tailor="${esc(j.id)}">tailor resume</button>
      </div>
    </div>
  </div>`;
}

function saveJob(j) {
  if (!j || car().saved.some((s) => s.id === j.id)) return;
  updCar((c) => c.saved.unshift({ id: j.id, company: j.company, title: j.title, url: j.url, locations: j.locations, terms: j.terms, type: j.type, status: 'saved', deadline: '', notes: '', savedAt: Date.now() }));
  toast(`saved ${j.company} to your tracker`);
}

// ---------- TAILOR ----------
function drawTailor(el, redraw) {
  const c = car();
  const d = ui.jobDraft || { url: '', company: '', title: '', location: '', text: '' };
  const doc = c.docs.find((x) => x.id === ui.selectedDoc);
  el.innerHTML = `
    <div class="grid dash">
      <div class="card stack" style="gap:14px">
        <h3>the job</h3>
        <div class="quick-add"><input id="j-url" value="${esc(d.url)}" placeholder="paste a job link (greenhouse, lever, workday…)"><button class="btn ghost" id="j-fetch">fetch</button></div>
        <div class="row"><label class="field">company<input id="j-company" value="${esc(d.company)}"></label><label class="field">role<input id="j-title" value="${esc(d.title)}"></label></div>
        <label class="field">job description<textarea id="j-text" style="min-height:230px" placeholder="paste the full job description here (or fetch it from the link above)">${esc(d.text)}</textarea></label>
        <div class="row spread">
          <div class="seg" id="kind">${Object.entries(DOC_KINDS).map(([k, v], i) => `<button data-kind="${k}" class="${i === 0 ? 'on' : ''}" title="${v.desc}">${v.label}</button>`).join('')}</div>
          <button class="btn" id="j-go">${aiEnabled() ? 'generate' : 'check keywords'}</button>
        </div>
        ${c.resume ? '' : '<p class="small" style="margin:0;color:var(--accent)">add your default resume in <b>profile</b> first, since everything is built from it.</p>'}
        ${aiEnabled() ? '<p class="small muted" style="margin:0">it only uses what’s in your resume and profile and never makes up experience.</p>' : '<p class="small muted" style="margin:0">offline mode: shows which keywords from the posting your resume covers. connect kiro or an ai key to generate tailored documents.</p>'}
        <div id="j-status"></div>
      </div>
      <div class="stack">
        <div class="card" id="doc-pane">${doc ? docView(doc) : '<div class="empty"><span class="big">nothing yet.</span>your tailored resume shows up here, ready to save as a pdf</div>'}</div>
        ${c.docs.length ? `<div class="card"><h3>saved documents</h3><div class="ev-list">${c.docs.map((x) => `<div class="ev" data-doc="${x.id}" style="--c:var(--accent);grid-template-columns:8px 1fr auto"><span class="bar"></span><div><div class="t">${esc(x.company || 'untitled')} <span class="kind">${esc(DOC_KINDS[x.kind]?.label || x.kind)}</span></div><div class="s">${esc(x.title || '')}</div></div><span class="when">${fmtDate(new Date(x.createdAt).toISOString().slice(0, 10), { month: 'short', day: 'numeric' }).toLowerCase()}</span></div>`).join('')}</div></div>` : ''}
      </div>
    </div>`;

  const $ = (q) => el.querySelector(q);
  let kind = 'resume';
  el.querySelectorAll('[data-kind]').forEach((b) => (b.onclick = () => { kind = b.dataset.kind; el.querySelectorAll('[data-kind]').forEach((x) => x.classList.toggle('on', x === b)); }));
  const readDraft = () => (ui.jobDraft = { url: $('#j-url').value.trim(), company: $('#j-company').value.trim(), title: $('#j-title').value.trim(), location: d.location, text: $('#j-text').value.trim() });
  ['#j-url', '#j-company', '#j-title', '#j-text'].forEach((s) => ($(s).oninput = readDraft));

  $('#j-fetch').onclick = async () => {
    const url = $('#j-url').value.trim();
    if (!url) return toast('paste a job link first');
    $('#j-status').innerHTML = spinner('reading the posting…');
    try {
      const r = await fetch('/api/job-text?url=' + encodeURIComponent(url));
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      if (data.company && !$('#j-company').value) $('#j-company').value = data.company;
      if (data.title && !$('#j-title').value) $('#j-title').value = data.title;
      $('#j-text').value = data.text;
      d.location = data.location;
      readDraft();
      $('#j-status').innerHTML = '';
      toast('got the job description');
    } catch (e) {
      $('#j-status').innerHTML = `<p class="small" style="color:var(--accent);margin:0">${esc(e.message)}</p>`;
    }
  };

  $('#j-go').onclick = async () => {
    const job = readDraft();
    if (job.text.length < 150) return toast('paste the job description (or fetch it from the link)');
    if (!aiEnabled()) {
      const rep = localKeywordReport(job.text);
      $('#j-status').innerHTML = `<div class="card" style="box-shadow:none"><h3>keyword check</h3>
        <p class="small" style="margin:0 0 8px"><b>you cover:</b> ${esc(rep.have.join(', ') || 'none yet')}</p>
        <p class="small" style="margin:0"><b>in the posting, not in your resume:</b> ${esc(rep.missing.join(', ') || 'nothing major')}</p></div>`;
      return;
    }
    if (!car().resume && !car().profile.name) return toast('add your resume in profile first');
    $('#j-go').disabled = true;
    $('#j-status').innerHTML = spinner(`writing your ${DOC_KINDS[kind].label}…`);
    try {
      const pr = docPrompt(kind, job);
      const reply = await ask({ system: pr.system, messages: [{ role: 'user', content: pr.user }], maxTokens: kind === 'cv' ? 5000 : 3000 });
      const [body, notes = ''] = reply.split(/^\s*===NOTES===\s*$/m);
      const id = uid();
      updCar((c) => c.docs.unshift({ id, kind, company: job.company, title: job.title, jobUrl: job.url, body: body.trim(), notes: notes.trim(), createdAt: Date.now() }));
      ui.selectedDoc = id;
      toast(`${DOC_KINDS[kind].label} ready`);
      redraw();
    } catch (e) {
      $('#j-status').innerHTML = `<p class="small" style="color:var(--accent);margin:0">${esc(e.message)}</p>`;
      $('#j-go').disabled = false;
    }
  };

  el.querySelectorAll('[data-doc]').forEach((r) => (r.onclick = () => { ui.selectedDoc = r.dataset.doc; drawTailor(el, redraw); }));
  wireDoc(el, redraw);
}

function docView(doc) {
  return `
    <div class="row spread" style="margin-bottom:12px">
      <span class="label small muted">${esc(DOC_KINDS[doc.kind]?.label || doc.kind)} · ${esc(doc.company || '')}</span>
      <div class="row">
        <button class="btn ghost sm" data-doc-edit>edit</button>
        <button class="btn ghost sm" data-doc-copy>copy</button>
        <button class="btn sm" data-doc-pdf>save as pdf</button>
        <button class="icon-btn" data-doc-del>delete</button>
      </div>
    </div>
    <div class="resume-sheet prose-resume">${md(doc.body)}</div>
    ${doc.notes ? `<div class="doc-notes prose">${md(doc.notes)}</div>` : ''}`;
}

function wireDoc(el, redraw) {
  const doc = car().docs.find((x) => x.id === ui.selectedDoc);
  if (!doc) return;
  el.querySelector('[data-doc-pdf]').onclick = () => printDoc(doc.body, `${car().profile.name || 'Resume'} - ${doc.company} ${DOC_KINDS[doc.kind]?.label || ''}`.trim());
  el.querySelector('[data-doc-copy]').onclick = () => navigator.clipboard.writeText(doc.body).then(() => toast('copied as text'));
  el.querySelector('[data-doc-del]').onclick = () => { updCar((c) => (c.docs = c.docs.filter((x) => x.id !== doc.id))); ui.selectedDoc = null; redraw(); };
  el.querySelector('[data-doc-edit]').onclick = () => modal('edit document', `<textarea class="editor" id="d-body" style="min-height:460px">${esc(doc.body)}</textarea><div class="row" style="justify-content:flex-end"><button class="btn" id="d-save">save</button></div>`, {
    wide: true,
    onMount(body, close) {
      body.querySelector('#d-save').onclick = () => { updCar((c) => (c.docs.find((x) => x.id === doc.id).body = body.querySelector('#d-body').value)); close(); redraw(); };
    },
  });
}

// ---------- TRACKER ----------
function drawTracker(el, redraw) {
  const c = car();
  if (!c.saved.length) {
    el.innerHTML = '<div class="card empty"><span class="big">nothing tracked yet.</span>save roles from <b>find</b> and they’ll land here</div>';
    return;
  }
  el.innerHTML = `<div class="tracker">${STATUSES.map((st) => {
    const items = c.saved.filter((s) => s.status === st);
    return `<div class="track-col"><div class="label small muted" style="margin-bottom:10px">${st} · ${items.length}</div>
      ${items.map((s) => `<div class="card track-card" data-id="${esc(s.id)}">
        <div class="label small muted">${esc(s.company)}</div>
        <div style="font-family:var(--serif);font-size:18px;line-height:1.2;margin:2px 0 6px">${esc(s.title)}</div>
        ${s.deadline ? `<div class="small" style="color:var(--accent)">due ${fmtDate(s.deadline, { month: 'short', day: 'numeric' }).toLowerCase()}</div>` : ''}
        <div class="row" style="margin-top:10px;gap:6px">
          <select data-status style="padding:5px 8px;font-size:12.5px;width:auto">${STATUSES.map((x) => `<option ${x === s.status ? 'selected' : ''}>${x}</option>`).join('')}</select>
          <button class="btn ghost sm" data-more>•••</button>
        </div>
      </div>`).join('') || '<div class="small faint">nothing here</div>'}
    </div>`;
  }).join('')}</div>`;

  el.querySelectorAll('.track-card').forEach((card) => {
    const id = card.dataset.id;
    const s = c.saved.find((x) => x.id === id);
    card.querySelector('[data-status]').onchange = (e) => {
      const status = e.target.value;
      updCar((cc) => (cc.saved.find((x) => x.id === id).status = status));
      if (status === 'applied') toast('applied, nice. add a follow-up reminder from •••');
      drawTracker(el, redraw);
    };
    card.querySelector('[data-more]').onclick = () => modal(`${s.company}`, `
      <div class="small muted">${esc(s.title)}</div>
      <div class="row"><label class="field">application deadline<input type="date" id="t-dl" value="${esc(s.deadline)}"></label></div>
      <label class="field">notes<textarea id="t-notes" style="min-height:90px" placeholder="referral, recruiter name, interview dates…">${esc(s.notes)}</textarea></label>
      <label class="check small"><input type="checkbox" id="t-cal" checked> put the deadline on my calendar</label>
      <div class="row spread">
        <div class="row"><a class="btn ghost sm" href="${esc(s.url)}" target="_blank" rel="noopener">open posting</a><button class="btn ghost sm" id="t-tailor">tailor resume</button><button class="btn ghost sm" id="t-follow">+ follow-up in 7 days</button></div>
        <div class="row"><button class="btn danger sm" id="t-del">remove</button><button class="btn sm" id="t-save">save</button></div>
      </div>`, {
      onMount(body, close) {
        const $ = (q) => body.querySelector(q);
        $('#t-save').onclick = () => {
          const deadline = $('#t-dl').value;
          const prevDeadline = s.deadline; // read before the update mutates the same object
          updCar((cc) => Object.assign(cc.saved.find((x) => x.id === id), { deadline, notes: $('#t-notes').value }));
          if (deadline && $('#t-cal').checked && deadline !== prevDeadline) {
            addEvents([{ title: `Apply: ${s.company}`, type: 'assignment', date: deadline, notes: s.title, source: 'careers' }]);
            toast('deadline added to your calendar');
          }
          close(); drawTracker(el, redraw);
        };
        $('#t-follow').onclick = () => {
          const date = new Date(); date.setDate(date.getDate() + 7);
          const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
          addEvents([{ title: `Follow up: ${s.company}`, type: 'other', date: iso, notes: s.title, source: 'careers' }]);
          toast('follow-up added to your calendar');
        };
        $('#t-tailor').onclick = () => { ui.jobDraft = { url: s.url, company: s.company, title: s.title, location: (s.locations || []).join('; '), text: '' }; ui.tab = 'tailor'; close(); redraw(); };
        $('#t-del').onclick = () => { updCar((cc) => (cc.saved = cc.saved.filter((x) => x.id !== id))); close(); drawTracker(el, redraw); };
      },
    });
  });
}

// ---------- PROFILE ----------
function drawProfile(el, redraw) {
  const c = car();
  const p = c.profile;
  const field = (k, label, ph = '') => `<label class="field">${label}<input data-p="${k}" value="${esc(p[k])}" placeholder="${esc(ph)}"></label>`;
  el.innerHTML = `
    <div class="grid dash">
      <div class="card stack" style="gap:14px">
        <h3>default resume <span>${c.resume ? `${c.resume.split(/\s+/).length} words` : 'empty'}</span></h3>
        <label class="drop" id="r-drop" style="padding:22px"><input type="file" id="r-file" accept=".pdf,.txt,.md" hidden><div class="big" style="font-size:30px">your resume.</div><span class="muted small">drop a pdf or click to upload · or paste below</span></label>
        <textarea id="r-text" style="min-height:340px" placeholder="paste your current resume here">${esc(c.resume)}</textarea>
        <div class="row spread"><span class="small muted">everything stays in this browser.</span><div class="row">${aiEnabled() ? '<button class="btn ghost sm" id="r-fill">fill profile from resume</button>' : ''}<button class="btn sm" id="r-save">save resume</button></div></div>
      </div>
      <div class="card stack" style="gap:12px">
        <h3>about you</h3>
        <div class="row">${field('name', 'name')}${field('email', 'email')}</div>
        <div class="row">${field('phone', 'phone')}${field('location', 'where you live', 'Boston, MA')}</div>
        ${field('links', 'links', 'linkedin.com/in/…, portfolio')}
        <div class="row">${field('school', 'school')}${field('degree', 'degree / major', 'B.A. Psychology, minor in CS')}</div>
        <div class="row">${field('gradDate', 'graduation', 'May 2028')}${field('gpa', 'gpa (optional)')}</div>
        <label class="field">work authorization<select data-p="workAuth">${[['citizen', 'US citizen'], ['permanent', 'green card / permanent resident'], ['needs', 'will need sponsorship']].map(([v, l]) => `<option value="${v}" ${p.workAuth === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        ${field('targetRoles', 'roles you want', 'software engineering, product, ux research')}
        ${field('skills', 'skills', 'python, react, figma, spss')}
        ${field('locations', 'preferred locations', 'New York, Boston, remote')}
        <label class="field">anything else (used for cover letters)<textarea data-p="extra" style="min-height:80px" placeholder="why you’re into this field, clubs, things you’re proud of…">${esc(p.extra)}</textarea></label>
        <div class="row" style="justify-content:flex-end"><button class="btn" id="p-save">save profile</button></div>
      </div>
    </div>`;

  const $ = (q) => el.querySelector(q);
  const drop = $('#r-drop');
  const load = async (file) => {
    if (!file) return;
    try { $('#r-text').value = await readFileText(file); toast(`loaded ${file.name}. hit save`); } catch (e) { toast(e.message); }
  };
  $('#r-file').onchange = (e) => load(e.target.files[0]);
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => load(e.dataTransfer.files[0]));

  const saveResume = () => {
    const text = $('#r-text').value.trim();
    updCar((cc) => (cc.resume = text));
    // Offline autofill of obvious fields
    const email = text.match(/[\w.+-]+@[\w-]+\.[\w.]+/)?.[0];
    const phone = text.match(/(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/)?.[0];
    const links = (text.match(/(linkedin\.com\/in\/[\w-]+|github\.com\/[\w-]+|[\w-]+\.(?:com|io|me|dev)\/?[\w-/]*)/gi) || []).filter((l) => !/@/.test(l)).slice(0, 3).join(', ');
    updCar((cc) => {
      const pr = cc.profile;
      if (!pr.email && email) pr.email = email;
      if (!pr.phone && phone) pr.phone = phone;
      if (!pr.links && links) pr.links = links;
      if (!pr.name) pr.name = text.split('\n').map((l) => l.trim()).find((l) => /^[A-Z][a-zA-Z'-]+(\s[A-Z][a-zA-Z'.-]+){1,3}$/.test(l)) || '';
    });
  };
  $('#r-save').onclick = () => { saveResume(); toast('resume saved'); drawProfile(el, redraw); };
  $('#p-save').onclick = () => {
    updCar((cc) => el.querySelectorAll('[data-p]').forEach((i) => (cc.profile[i.dataset.p] = i.value.trim())));
    toast('profile saved');
  };
  $('#r-fill')?.addEventListener('click', async () => {
    saveResume();
    const btn = $('#r-fill'); btn.disabled = true; btn.textContent = 'reading…';
    try {
      const reply = await ask({
        system: 'Extract profile fields from this resume. Return ONLY JSON with string values (empty string if unknown): {"name","email","phone","location","links","school","degree","gradDate","gpa","targetRoles","skills"}. targetRoles: 2-4 role types this person is clearly aiming for. skills: comma list of concrete skills/tools.',
        messages: [{ role: 'user', content: car().resume.slice(0, 12000) }],
        maxTokens: 800,
      });
      const data = extractJSON(reply);
      updCar((cc) => { for (const [k, v] of Object.entries(data)) if (k in cc.profile && v && !cc.profile[k]) cc.profile[k] = String(v); });
      toast('profile filled in. double-check it');
    } catch (e) {
      toast(`couldn’t read it: ${e.message}`);
    }
    drawProfile(el, redraw);
  });
}
