// Syllabus import: file/paste -> events (AI when available, local parser otherwise) -> calendar, automatically.
import { store, addEvents, ensureCourse, removeEvents, courseColor, getCourse } from './store.js';
import { aiEnabled, ask } from './ai.js';
import { esc, toISO, todayISO, addDays, fmtDate, TYPE_META, extractJSON, fromISO, MONTHS } from './util.js';
import { toast, readFilesText, enableImagePaste, ACCEPT, spinner } from './ui.js';
import { syncStudyPlans } from './focus.js';

// ---------- Local (offline) parser ----------
const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const RE_MONTH = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?\b/i;
const RE_DAY_MONTH = /\b(\d{1,2})(?:st|nd|rd|th)?\s+(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b\.?(?:,?\s+(\d{4}))?/i;
const RE_ISO = /\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/;
const RE_NUM = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/;
const RE_TIME = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?=\W|$)/i;
const RE_WEEKDAY = /\b(mon|tues?|wed(?:nes)?|thu(?:rs?)?|fri|sat(?:ur)?|sun)(?:day)?\b\.?,?/gi;
const RE_CODE = /\b([A-Z]{2,5})[\s-]?(\d{3,4}[A-Z]?)\b/;

function inferYear(month, day, explicitYear) {
  if (explicitYear) return explicitYear < 100 ? 2000 + explicitYear : explicitYear;
  const now = new Date();
  let y = now.getFullYear();
  // A syllabus usually spans ~4 months back to ~8 months ahead of today.
  if (new Date(y, month, day) < new Date(now.getFullYear(), now.getMonth() - 4, 1)) y += 1;
  return y;
}

function findDate(line) {
  let m;
  if ((m = line.match(RE_ISO))) return { iso: toISO(new Date(+m[1], +m[2] - 1, +m[3])), match: m[0] };
  if ((m = line.match(RE_MONTH))) {
    const mo = MON[m[1].slice(0, 3).toLowerCase()];
    const d = +m[2];
    if (d >= 1 && d <= 31) return { iso: toISO(new Date(inferYear(mo, d, m[3] && +m[3]), mo, d)), match: m[0] };
  }
  if ((m = line.match(RE_DAY_MONTH))) {
    const mo = MON[m[2].slice(0, 3).toLowerCase()];
    const d = +m[1];
    if (d >= 1 && d <= 31) return { iso: toISO(new Date(inferYear(mo, d, m[3] && +m[3]), mo, d)), match: m[0] };
  }
  if ((m = line.match(RE_NUM))) {
    const mo = +m[1] - 1;
    const d = +m[2];
    if (mo >= 0 && mo < 12 && d >= 1 && d <= 31) return { iso: toISO(new Date(inferYear(mo, d, m[3] && +m[3]), mo, d)), match: m[0] };
  }
  return null;
}

function findTime(line) {
  const m = line.match(RE_TIME);
  if (!m) return null;
  let h = +m[1] % 12;
  if (/p/i.test(m[3])) h += 12;
  return { time: `${String(h).padStart(2, '0')}:${m[2] || '00'}`, match: m[0] };
}

export function classify(text) {
  const t = text.toLowerCase();
  if (/\bfinal\b(?!\s+(project|paper|presentation|report|essay|draft))|final exam/.test(t)) return 'final';
  if (/mid-?term/.test(t)) return 'midterm';
  if (/\bexam\b|\btest\b/.test(t)) return 'exam';
  if (/\bquiz/.test(t)) return 'quiz';
  if (/project|presentation|paper|essay|report|proposal/.test(t)) return 'project';
  if (/\blab\b/.test(t)) return 'lab';
  if (/\b(hw|homework|assignment|problem set|pset|ps ?\d+|due|submit|deliverable)\b/.test(t)) return 'assignment';
  if (/\bread(ing)?\b|chapter|\bch\.?\s?\d/.test(t)) return 'reading';
  if (/no class|holiday|break|recess|cancel/.test(t)) return 'other';
  return 'class';
}

function cleanTitle(line, strip) {
  let t = line;
  for (const s of strip) if (s) t = t.replace(s, ' ');
  t = t
    .replace(RE_WEEKDAY, ' ')
    .replace(/\bweek\s*\d+\b/i, ' ')
    .replace(/^\s*(finals?\s+week|finals|wk\.?\s*\d+|session\s*\d+|day\s*\d+)\b/i, ' ')
    .replace(/[|\t•·]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([,.;:)])/g, '$1')
    .replace(/[\s,]*\b(at|by|on|@)\s*$/i, '')
    .replace(/^[\s:,\-–—()]+|[\s:,\-–—(]+$/g, '')
    .trim();
  if (t.length > 90) t = t.slice(0, 87).trimEnd() + '…';
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// Table rows from Word/Excel/PDF look like "5 | Oct 21 | Midterm Exam | 25%".
// Drop cells that are just a week number, lecture number or grade weight so they don't end up in the title.
function tableAware(line) {
  if (!line.includes('|')) return line;
  return line
    .split('|')
    .map((c) => c.trim())
    .filter((c) => c && !/^(week|wk|lecture|lec|class|session|unit|module)?\s*#?\d{1,3}(\.\d+)?\s*%?$/i.test(c))
    .join('  ');
}

export function detectCourse(text) {
  const head = text.split('\n').slice(0, 25);
  for (const line of head) {
    const m = line.match(RE_CODE);
    if (m && !/^(ROOM|PAGE|UNIT)$/.test(m[1])) {
      const code = `${m[1]} ${m[2]}`;
      const name = line.replace(m[0], '').replace(/^[\s:–—\-|]+|[\s:–—\-|]+$/g, '').trim();
      return { code, name: name && name.length < 70 ? name : code };
    }
  }
  const first = head.find((l) => l.trim().length > 3);
  return { code: '', name: first ? first.trim().slice(0, 60) : '' };
}

export function parseLocal(text) {
  const events = [];
  const seen = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.length > 300) continue;
    const d = findDate(line);
    if (!d) continue;
    const tm = findTime(line);
    const type = classify(line);
    // Skip generic metadata lines (office hours, "last updated", etc.)
    if (/office hours|updated|revised|copyright|printed/i.test(line)) continue;
    const title = cleanTitle(tableAware(line), [d.match, tm?.match]) || TYPE_META[type].label;
    const key = `${d.iso}|${title.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    events.push({ title, type, date: d.iso, time: tm?.time || '', notes: '' });
  }
  return { course: detectCourse(text), events };
}

// Quick-add parser: "chem quiz fri 3pm", "essay due tomorrow", "bio midterm oct 14"
export function parseQuick(input) {
  let text = input.trim();
  let iso = null;
  const dayIdx = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  const lower = text.toLowerCase();
  let m;
  if (/\btoday\b/.test(lower)) { iso = todayISO(); text = text.replace(/\btoday\b/i, ''); }
  else if (/\btomorrow\b|\btmr\b/.test(lower)) { iso = addDays(todayISO(), 1); text = text.replace(/\btomorrow\b|\btmr\b/i, ''); }
  else if ((m = lower.match(/\b(next\s+)?(sun(?:day)?|mon(?:day)?|tue(?:s|sday)?|wed(?:nesday)?|thu(?:rs|rsday)?|fri(?:day)?|sat(?:urday)?)\b/))) {
    const target = dayIdx[m[2].slice(0, 3)];
    const now = fromISO(todayISO()).getDay();
    let diff = (target - now + 7) % 7 || 7;
    if (m[1]) diff += diff < 7 ? 7 : 0;
    iso = addDays(todayISO(), diff);
    text = text.replace(new RegExp(m[0], 'i'), '');
  } else {
    const d = findDate(text);
    if (d) { iso = d.iso; text = text.replace(d.match, ''); }
  }
  const tm = findTime(text);
  if (tm) text = text.replace(tm.match, '');
  text = text.replace(/\b(at|on|due by)\b\s*$/i, '').replace(/\s{2,}/g, ' ').trim();
  // Match a course by code or name mention
  const course = store.get().courses.find((c) =>
    [c.code, c.name].filter(Boolean).some((k) => {
      const first = k.toLowerCase().split(' ')[0];
      return lower.includes(k.toLowerCase()) || (first.length >= 3 && new RegExp(`\\b${first.replace(/[^a-z0-9]/g, '')}\\b`).test(lower));
    })
  );
  return { title: text.charAt(0).toUpperCase() + text.slice(1) || 'Untitled', date: iso || todayISO(), time: tm?.time || '', type: classify(input), courseId: course?.id || null };
}

// ---------- AI parser ----------
async function parseAI(text) {
  const system = `You extract calendar events from university course syllabi. Today is ${todayISO()}.
Return ONLY valid JSON (no prose) shaped like:
{"course":{"name":"","code":""},"events":[{"title":"","type":"final|midterm|exam|quiz|assignment|project|reading|lab|class|other","date":"YYYY-MM-DD","time":"HH:MM or empty","notes":"short detail e.g. weight, chapters, location"}]}
Rules:
- Include every dated exam, quiz, assignment, project milestone, reading, lab, and no-class/holiday day.
- For lecture schedule rows, use type "class" with the topic as the title.
- Infer the year from the term (e.g. "Fall 2026"); if absent, pick the year that places the date within the upcoming academic term.
- Titles should be concise (e.g. "Problem Set 3", "Midterm 1"). Never invent dates that aren't in the text.
- Weekly recurring items without explicit dates should be omitted.`;
  const reply = await ask({ system, messages: [{ role: 'user', content: text.slice(0, 60000) }], maxTokens: 8000 });
  const data = extractJSON(reply);
  const events = (data.events || [])
    .filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e.date))
    .map((e) => ({ title: String(e.title || 'Untitled').slice(0, 120), type: TYPE_META[e.type] ? e.type : classify(e.title || ''), date: e.date, time: /^\d{2}:\d{2}$/.test(e.time || '') ? e.time : '', notes: e.notes || '' }));
  return { course: data.course || detectCourse(text), events };
}

// ---------- Import pipeline ----------
export async function importSyllabus(text, { courseName, courseCode, useAI }) {
  let parsed;
  let method = 'local';
  if (useAI && aiEnabled()) {
    try {
      parsed = await parseAI(text);
      method = 'ai';
    } catch (e) {
      toast(`AI parsing failed (${e.message}), used the offline parser instead`);
    }
  }
  if (!parsed) parsed = parseLocal(text);
  const courseId = ensureCourse(courseName || parsed.course?.name || 'My course', courseCode || parsed.course?.code || '');
  const existing = new Set(store.get().events.map((e) => `${e.courseId}|${e.date}|${e.title.toLowerCase()}`));
  const fresh = parsed.events
    .map((e) => ({ ...e, courseId, source: 'syllabus' }))
    .filter((e) => !existing.has(`${courseId}|${e.date}|${e.title.toLowerCase()}`));
  const ids = addEvents(fresh);
  const planned = syncStudyPlans({ silent: true });
  return { ids, courseId, method, planned, events: store.get().events.filter((e) => ids.includes(e.id)) };
}

export function sampleSyllabus() {
  const t = todayISO();
  const f = (n) => { const d = fromISO(addDays(t, n)); return `${MONTHS[d.getMonth()].slice(0, 3)} ${d.getDate()}`; };
  return `PSYC 210 – Cognitive Psychology
Fall ${fromISO(t).getFullYear()} · Prof. Rivera · Tue/Thu 10:30am

Grading: Quizzes 15%, Problem sets 25%, Midterm 25%, Final 35%

Schedule
Week 1  ${f(-3)}  Intro: what is cognition?
Week 1  ${f(1)}   Perception & attention (read Ch. 2)
Week 2  ${f(2)}   Problem Set 1 due 11:59pm
Week 2  ${f(4)}   Quiz 1: Perception
Week 3  ${f(6)}   Memory systems (read Ch. 5-6)
Week 3  ${f(9)}   Midterm Exam 10:30am (Ch. 1-6)
Week 4  ${f(13)}  No class - Fall break
Week 5  ${f(16)}  Problem Set 2 due
Week 6  ${f(20)}  Final project proposal due
Week 7  ${f(24)}  Quiz 2: Language
Week 9  ${f(32)}  Final project presentations
Finals  ${f(38)}  Final Exam 9:00am, Hall B`;
}

// ---------- View ----------
export function render(el) {
  const ai = aiEnabled();
  el.innerHTML = `
    <div class="page-head view-enter">
      <div><div class="kicker">syllabus import</div><h1>drop in your <em>syllabus</em></h1><p>every exam, deadline and reading lands on your calendar automatically, plus study sessions before each exam.</p></div>
    </div>
    <div class="grid dash view-enter">
      <div class="stack">
        <div class="card">
          <label class="drop" id="drop">
            <input type="file" id="file" accept="${ACCEPT}" multiple hidden>
            <div class="big">drop it here.</div><b>your syllabus, in any format</b><span class="muted small">pdf, word, powerpoint, excel, photos or screenshots · several pages at once is fine</span>
          </label>
          <div class="row" style="margin:14px 0 8px"><span class="hand">…or paste it (screenshots too)</span><span style="flex:1"></span><button class="btn ghost sm" id="sample">try a sample syllabus</button></div>
          <textarea id="text" placeholder="Paste syllabus text here" style="min-height:200px"></textarea>
          <div class="row" style="margin-top:12px">
            <label class="field">Course name (optional)<input id="cname" placeholder="Auto-detected"></label>
            <label class="field" style="max-width:160px">Code<input id="ccode" placeholder="e.g. CHEM 101"></label>
          </div>
          <div class="row spread" style="margin-top:14px">
            <label class="check small ${ai ? '' : 'faint'}"><input type="checkbox" id="useai" ${ai ? 'checked' : 'disabled'}> Smart AI parsing ${ai ? '' : '(connect Kiro or an AI key to enable)'}</label>
            <button class="btn" id="go">import to calendar</button>
          </div>
        </div>
      </div>
      <div class="card" id="result"><h3>imported</h3><div class="empty"><span class="big">waiting…</span>your deadlines will land here</div></div>
    </div>`;

  const $ = (s) => el.querySelector(s);
  const drop = $('#drop');
  const status = (m) => { $('#text').value = ''; $('#text').placeholder = m; };
  const loadFiles = async (files) => {
    if (!files?.length) return;
    const ta = $('#text');
    ta.disabled = true;
    status('reading…');
    try {
      const text = await readFilesText(files, { onProgress: status });
      if (!text.trim()) throw new Error('No text found in that file.');
      ta.value = text;
      toast(files.length > 1 ? `read ${files.length} files` : `loaded ${files[0].name}`);
    } catch (e) {
      ta.value = '';
      toast(e.message, { timeout: 8000 });
    } finally {
      ta.disabled = false;
      ta.placeholder = 'Paste syllabus text here';
    }
  };
  $('#file').onchange = (e) => loadFiles(e.target.files);
  enableImagePaste($('#text'), { onProgress: (m) => ($('#text').placeholder = m), onDone: () => toast('read your screenshot'), onError: (e) => toast(e.message) });
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => loadFiles(e.dataTransfer.files));
  $('#sample').onclick = () => ($('#text').value = sampleSyllabus());

  $('#go').onclick = async () => {
    const text = $('#text').value.trim();
    if (!text) return toast('Add a syllabus first');
    const btn = $('#go');
    btn.disabled = true;
    $('#result').innerHTML = `<h3>Imported</h3>${spinner($('#useai').checked ? 'Reading your syllabus with AI…' : 'Parsing dates…')}`;
    try {
      const res = await importSyllabus(text, { courseName: $('#cname').value.trim(), courseCode: $('#ccode').value.trim(), useAI: $('#useai').checked });
      showResult(res);
      toast(`added ${res.ids.length} events${res.planned ? ` + ${res.planned} study sessions` : ''}`, {
        action: 'undo',
        onAction: () => { removeEvents(res.ids); $('#result').innerHTML = '<h3>Imported</h3><div class="empty">Import undone.</div>'; },
        timeout: 9000,
      });
    } catch (e) {
      $('#result').innerHTML = `<h3>Imported</h3><div class="empty">Something went wrong: ${esc(e.message)}</div>`;
    } finally {
      btn.disabled = false;
    }
  };

  function showResult(res) {
    const course = getCourse(res.courseId);
    const color = courseColor(res.courseId);
    const evs = [...res.events].sort((a, b) => a.date.localeCompare(b.date));
    $('#result').innerHTML = `
      <h3>imported <span class="tag" style="--c:${color}">${esc(course?.code || course?.name || '')}</span></h3>
      <p class="small muted" style="margin-top:-6px">${evs.length} events via ${res.method === 'ai' ? 'AI' : 'offline parser'}${res.planned ? ` · ${res.planned} study sessions auto-scheduled` : ''}. remove anything that looks off.</p>
      ${evs.length ? `<div class="ev-list">${evs.map((e) => `
        <div class="ev result-item" style="--c:${color};grid-template-columns:4px 1fr auto auto" data-id="${e.id}">
          <span class="bar"></span>
          <div><div class="t">${esc(e.title)}</div><div class="s">${TYPE_META[e.type]?.label}${e.time ? ' · ' + e.time : ''}${e.notes ? ' · ' + esc(e.notes) : ''}</div></div>
          <span class="when">${fmtDate(e.date)}</span>
          <button class="icon-btn" data-rm="${e.id}" title="Remove">✕</button>
        </div>`).join('')}</div>
        <div class="row" style="margin-top:14px"><a class="btn" href="#/calendar">Open calendar →</a></div>`
      : '<div class="empty">No new dated items found. If this is a scanned PDF, paste the text instead.</div>'}`;
    el.querySelectorAll('[data-rm]').forEach((b) => (b.onclick = () => { removeEvents([b.dataset.rm]); b.closest('.ev').remove(); }));
  }
}
