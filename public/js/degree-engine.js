// Degree math: credits, averages, requirement matching. No DOM, so it can be tested in Node.

// Credit systems at Canadian universities (credit value of a typical one-term course, and a typical
// 4-year honours total). Totals vary by program, so the total is a starting guess the user confirms.
export const SCHOOLS = [
  { name: 'University of Toronto', re: /toronto(?!.*metropolitan)|\buoft\b|\butsc\b|\butm\b/i, credit: 0.5, unit: 'credits', total: 20 },
  { name: 'University of Waterloo', re: /waterloo(?!.*laurier)|\buw\b|uwaterloo/i, credit: 0.5, unit: 'units', total: 20 },
  { name: 'Western University', re: /western|\buwo\b/i, credit: 0.5, unit: 'courses', total: 20 },
  { name: 'Wilfrid Laurier University', re: /laurier|\bwlu\b/i, credit: 0.5, unit: 'credits', total: 20 },
  { name: 'University of Guelph', re: /guelph/i, credit: 0.5, unit: 'credits', total: 20 },
  { name: 'Carleton University', re: /carleton/i, credit: 0.5, unit: 'credits', total: 20 },
  { name: 'York University', re: /\byork\b|yorku/i, credit: 3, unit: 'credits', total: 120 },
  { name: 'McMaster University', re: /mcmaster|\bmac\b/i, credit: 3, unit: 'units', total: 120 },
  { name: "Queen's University", re: /queen'?s/i, credit: 3, unit: 'units', total: 120 },
  { name: 'University of Ottawa', re: /ottawa|uottawa/i, credit: 3, unit: 'units', total: 120 },
  { name: 'Toronto Metropolitan University', re: /metropolitan|\btmu\b|ryerson/i, credit: 1, unit: 'courses', total: 40 },
  { name: 'University of British Columbia', re: /british columbia|\bubc\b/i, credit: 3, unit: 'credits', total: 120 },
  { name: 'Simon Fraser University', re: /simon fraser|\bsfu\b/i, credit: 3, unit: 'units', total: 120 },
  { name: 'University of Victoria', re: /victoria|\buvic\b/i, credit: 1.5, unit: 'units', total: 60 },
  { name: 'McGill University', re: /mcgill/i, credit: 3, unit: 'credits', total: 120 },
  { name: 'Concordia University', re: /concordia/i, credit: 3, unit: 'credits', total: 120 },
  { name: 'University of Alberta', re: /alberta|ualberta/i, credit: 3, unit: 'units', total: 120 },
  { name: 'University of Calgary', re: /calgary|ucalgary/i, credit: 3, unit: 'units', total: 120 },
  { name: 'University of Manitoba', re: /manitoba/i, credit: 3, unit: 'credit hours', total: 120 },
  { name: 'University of Saskatchewan', re: /saskatchewan|usask/i, credit: 3, unit: 'credit units', total: 120 },
  { name: 'Dalhousie University', re: /dalhousie|\bdal\b/i, credit: 3, unit: 'credit hours', total: 120 },
];
export const schoolPreset = (name = '') => SCHOOLS.find((s) => s.re.test(name) || s.name.toLowerCase() === name.trim().toLowerCase()) || null;

// ---------- course codes ----------
export const normCode = (c = '') => String(c).toUpperCase().replace(/[\s\-_.]/g, '');

// "PSY100" matches "PSY100H1"; "PSY3XX" matches any 300-level PSY; "*4XX" any 400-level; alternatives use "|"
export function codeMatches(pattern, code) {
  const target = normCode(code);
  return String(pattern).split(/\s*\|\s*|\s+or\s+/i).some((alt) => {
    const p = normCode(alt);
    return p ? patternRegex(p).test(target) : false;
  });
}
const reCache = new Map();
function patternRegex(p) {
  if (reCache.has(p)) return reCache.get(p);
  let subj;
  let rest;
  if (p.startsWith('*')) { subj = '[A-Z]+'; rest = p.slice(1); }
  else {
    // Subject = leading letters up to the first digit / X wildcard / *  ("PSYXXX" → PSY + XXX)
    const m = p.match(/^[A-Z]{2,}?(?=[\dX*]|$)/) || p.match(/^[A-Z]*/);
    subj = m[0];
    rest = p.slice(subj.length);
  }
  let re;
  if (!rest) re = new RegExp(`^${subj}(?=\\d)`); // bare subject ("PSY") = any PSY course
  else {
    const body = rest.replace(/[^A-Z0-9*]/g, '').replace(/X/g, '\\d').replace(/\*/g, '.*');
    re = new RegExp(`^${subj}${body}${rest.endsWith('*') ? '' : '(?!\\d)'}`);
  }
  reCache.set(p, re);
  return re;
}

// ---------- grades ----------
const LETTER = { 'A+': 4.0, A: 4.0, 'A-': 3.7, 'B+': 3.3, B: 3.0, 'B-': 2.7, 'C+': 2.3, C: 2.0, 'C-': 1.7, 'D+': 1.3, D: 1.0, 'D-': 0.7, F: 0, E: 0 };
export function parseGrade(g) {
  const s = String(g ?? '').trim().toUpperCase();
  if (!s) return null;
  if (/^\d{1,3}(\.\d+)?%?$/.test(s)) { const n = parseFloat(s); return n <= 100 ? { pct: n, pass: n >= 50 } : null; }
  if (s in LETTER) return { gpa: LETTER[s], pass: LETTER[s] > 0 };
  if (/^(CR|P|PASS|S|SAT)$/.test(s)) return { pass: true };
  if (/^(NCR|FAIL|NC|U|WF)$/.test(s)) return { pass: false };
  return null;
}

const STATUS_RANK = { completed: 0, 'in-progress': 1, planned: 2 };
// Courses that can count, one per course code (retakes keep the best attempt)
export function countable(years) {
  const best = new Map();
  for (const y of years || []) {
    for (const c of y.courses || []) {
      let status = c.status || 'completed';
      if (status === 'failed' || status === 'dropped') continue;
      const g = parseGrade(c.grade);
      if (status === 'completed' && g && g.pass === false) continue;
      const credits = Number(c.credits) || 0;
      const key = normCode(c.code) || c.id;
      const item = { ...c, status, credits, yearId: y.id, yearLabel: y.label, key };
      const prev = best.get(key);
      if (!prev || STATUS_RANK[status] < STATUS_RANK[prev.status]) best.set(key, item);
    }
  }
  return [...best.values()];
}

export function sumCredits(list, status) {
  return round(list.filter((c) => !status || c.status === status).reduce((a, c) => a + c.credits, 0));
}
export const round = (n) => Math.round(n * 100) / 100;

export function averages(years) {
  let pw = 0, pSum = 0, gw = 0, gSum = 0;
  for (const y of years || []) for (const c of y.courses || []) {
    if ((c.status || 'completed') !== 'completed' && c.status !== 'failed') continue;
    const g = parseGrade(c.grade);
    const w = Number(c.credits) || 0;
    if (!g || !w) continue;
    if (g.pct != null) { pSum += g.pct * w; pw += w; }
    if (g.gpa != null) { gSum += g.gpa * w; gw += w; }
  }
  return { percent: pw ? Math.round((pSum / pw) * 10) / 10 : null, gpa: gw ? Math.round((gSum / gw) * 100) / 100 : null };
}

// ---------- requirements ----------
// Specific course lists first, then narrow "choose" lists, then broad ones, so a course
// isn't used up by a broad requirement when a specific one needed it.
function breadth(pattern) {
  const p = normCode(pattern);
  if (p.startsWith('*')) return 20;
  const subj = (p.match(/^[A-Z]{2,}?(?=[\dX*]|$)/) || [''])[0];
  const rest = p.slice(subj.length);
  if (!rest) return 10; // whole subject
  return (rest.match(/X/g) || []).length + (rest.includes('*') ? 6 : 0);
}
function specificity(r) {
  if (r.type === 'courses') return 0;
  const list = (r.courses || []).filter(Boolean);
  if (!list.length) return 100;
  return 1 + Math.max(...list.map(breadth)) + list.length / 1000;
}

export function evaluate(degree) {
  const courses = countable(degree.years);
  const reqs = degree.requirements || [];
  const used = new Set();
  const results = {};
  const byStatus = (a, b) => STATUS_RANK[a.status] - STATUS_RANK[b.status] || b.credits - a.credits;
  const amount = (list, unit) => round(unit === 'courses' ? list.length : list.reduce((a, c) => a + c.credits, 0));

  for (const r of [...reqs].sort((a, b) => specificity(a) - specificity(b))) {
    const pool = courses.filter((c) => r.overlap || !used.has(c.key));
    if (r.type === 'manual') {
      results[r.id] = { state: r.done ? 'met' : 'manual', done: r.done ? 1 : 0, need: 1, matched: [], missing: [] };
      continue;
    }
    if (r.type === 'total') {
      const need = Number(r.min) || Number(degree.totalCredits) || 0;
      const done = sumCredits(courses, 'completed');
      const withIp = round(done + sumCredits(courses, 'in-progress'));
      const withPlan = round(withIp + sumCredits(courses, 'planned'));
      results[r.id] = { state: stateOf(done, withIp, withPlan, need), done, inProgress: round(withIp - done), planned: round(withPlan - withIp), need, unit: 'credits', matched: [], missing: [] };
      continue;
    }
    if (r.type === 'courses') {
      const entries = (r.courses || []).filter(Boolean);
      const need = Math.min(Number(r.min) || entries.length, entries.length);
      const matched = [];
      const missing = [];
      const taken = new Set();
      for (const entry of entries) {
        const hit = pool.filter((c) => !taken.has(c.key) && codeMatches(entry, c.code)).sort(byStatus)[0];
        if (hit) { matched.push({ ...hit, entry }); taken.add(hit.key); } else missing.push(entry);
      }
      const chosen = matched.sort(byStatus).slice(0, need);
      if (!r.overlap) chosen.forEach((c) => used.add(c.key));
      const done = chosen.filter((c) => c.status === 'completed').length;
      const ip = chosen.filter((c) => c.status === 'in-progress').length;
      const pl = chosen.filter((c) => c.status === 'planned').length;
      results[r.id] = { state: stateOf(done, done + ip, done + ip + pl, need), done, inProgress: ip, planned: pl, need, unit: 'courses', matched: chosen, missing: done + ip + pl >= need ? [] : missing };
      continue;
    }
    // choose: X credits (or courses) from a list / pattern
    const unit = r.unit === 'courses' ? 'courses' : 'credits';
    const need = Number(r.min) || 0;
    const candidates = pool.filter((c) => (r.courses || []).some((p) => codeMatches(p, c.code))).sort(byStatus);
    const chosen = [];
    for (const c of candidates) {
      if (amount(chosen, unit) >= need) break;
      chosen.push(c);
    }
    if (!r.overlap) chosen.forEach((c) => used.add(c.key));
    const done = amount(chosen.filter((c) => c.status === 'completed'), unit);
    const ip = amount(chosen.filter((c) => c.status === 'in-progress'), unit);
    const pl = amount(chosen.filter((c) => c.status === 'planned'), unit);
    results[r.id] = { state: stateOf(done, done + ip, done + ip + pl, need), done, inProgress: ip, planned: pl, need, unit, matched: chosen, missing: [] };
  }
  return results;
}

function stateOf(done, withIp, withPlan, need) {
  if (!need) return 'met';
  if (done >= need - 1e-9) return 'met';
  if (withIp >= need - 1e-9) return 'in-progress';
  if (withPlan >= need - 1e-9) return 'planned';
  return 'missing';
}

export function summary(degree) {
  const courses = countable(degree.years);
  const earned = sumCredits(courses, 'completed');
  const inProgress = sumCredits(courses, 'in-progress');
  const planned = sumCredits(courses, 'planned');
  const totalReq = (degree.requirements || []).find((r) => r.type === 'total');
  const total = Number(degree.totalCredits) || Number(totalReq?.min) || 0;
  const results = evaluate(degree);
  const reqs = (degree.requirements || []).filter((r) => r.type !== 'total');
  const met = reqs.filter((r) => results[r.id]?.state === 'met').length;
  // Pace = average credits earned in years that are finished (nothing in progress or planned),
  // so a half-done current year doesn't drag the estimate down
  const finished = (degree.years || []).filter((y) => (y.courses || []).length && y.courses.every((c) => ['completed', 'failed', 'dropped', undefined].includes(c.status)));
  const finishedKeys = new Set(finished.map((y) => y.id));
  const finishedEarned = courses.filter((c) => c.status === 'completed' && finishedKeys.has(c.yearId)).reduce((a, c) => a + c.credits, 0);
  const pace = finished.length ? finishedEarned / finished.length : 0;
  const left = round(Math.max(0, total - earned));
  const leftAfterCurrent = round(Math.max(0, total - earned - inProgress));
  const leftAfterPlan = round(Math.max(0, total - earned - inProgress - planned));
  return {
    earned, inProgress, planned, total, left, leftAfterCurrent, leftAfterPlan,
    pct: total ? Math.min(100, (earned / total) * 100) : 0,
    pctIp: total ? Math.min(100, ((earned + inProgress) / total) * 100) : 0,
    pctPlan: total ? Math.min(100, ((earned + inProgress + planned) / total) * 100) : 0,
    yearsLeft: pace > 0 ? Math.ceil((leftAfterCurrent / pace) * 2) / 2 : null,
    pace: round(pace),
    reqMet: met, reqCount: reqs.length,
    ...averages(degree.years),
    results,
  };
}

// ---------- transcript text → years (offline, used when AI isn't connected) ----------
const CODE_RE = /\b([A-Z]{2,5})[\s-]?(\d{3,4}[A-Z]?\d?)\b/;
const TERM_RE = /\b(fall|autumn|winter|spring|summer|intersession|f|w|s)\b[\s/-]*(20\d{2})|\b(20\d{2})[\s/-]*(fall|autumn|winter|spring|summer|f|w|s)\b/i;
export function parseTranscript(text) {
  const years = new Map();
  let term = null;
  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    const t = line.match(TERM_RE);
    if (t && !CODE_RE.test(line.replace(TERM_RE, ''))) {
      const season = (t[1] || t[4]).toLowerCase();
      const year = +(t[2] || t[3]);
      const name = { f: 'Fall', autumn: 'Fall', fall: 'Fall', w: 'Winter', winter: 'Winter', s: 'Summer', summer: 'Summer', spring: 'Summer', intersession: 'Summer' }[season];
      const start = name === 'Fall' ? year : year - 1;
      term = { name, start };
      continue;
    }
    const m = line.match(CODE_RE);
    if (!m || !term) continue;
    const rest = line.slice(m.index + m[0].length);
    const nums = [...rest.matchAll(/(?<![\w.])(\d{1,3}(?:\.\d{1,2})?)(?![\w.])/g)].map((x) => x[1]);
    const letter = rest.match(/(?:^|\s)(A\+|A-|A|B\+|B-|B|C\+|C-|C|D\+|D-|D|F|CR|NCR|P|IP)(?=\s|$)/);
    // credits look like 0.50 / 1.00 / 3.00 / 3; grades look like 85 or letters
    const credit = nums.find((n) => /\.\d/.test(n) || (+n > 0 && +n <= 6));
    const pct = nums.find((n) => +n > 6 && +n <= 100 && n !== credit);
    const title = rest.replace(/(?<![\w.])\d{1,3}(?:\.\d{1,2})?(?![\w.])/g, '').replace(/(?:^|\s)(A\+|A-|A|B\+|B-|B|C\+|C-|C|D\+|D-|D|F|CR|NCR|P|IP)(?=\s|$)/g, ' ').replace(/[|:]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
    const grade = letter && letter[1] !== 'IP' ? letter[1] : pct || '';
    const status = letter?.[1] === 'IP' || (!grade && /in progress|ip\b/i.test(line)) ? 'in-progress' : grade ? 'completed' : 'in-progress';
    const key = term.start;
    if (!years.has(key)) years.set(key, { start: key, courses: [] });
    years.get(key).courses.push({ code: `${m[1]} ${m[2]}`, title: title.slice(0, 80), credits: credit ? +credit : null, term: term.name, grade: String(grade), status });
  }
  return [...years.values()].sort((a, b) => a.start - b.start);
}

export const yearLabel = (n, start) => `Year ${n}${start ? ` · ${start}–${String((start + 1) % 100).padStart(2, '0')}` : ''}`;
export function currentTerm(d = new Date()) {
  const m = d.getMonth();
  return m >= 8 ? 'Fall' : m <= 3 ? 'Winter' : 'Summer';
}
export function academicStart(d = new Date()) {
  return d.getMonth() >= 7 ? d.getFullYear() : d.getFullYear() - 1;
}
