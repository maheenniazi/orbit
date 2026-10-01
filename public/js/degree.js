// Degree planner: a folder per year with courses, credit totals, what's left, and automatic requirement checks.
import { store } from './store.js';
import { aiEnabled, ask } from './ai.js';
import { esc, uid, extractJSON, fmtDate } from './util.js';
import { toast, modal, spinner, readFilesText, ACCEPT } from './ui.js';
import { askAbout } from './chat.js';
import { SCHOOLS, schoolPreset, summary, evaluate, parseTranscript, yearLabel, currentTerm, academicStart, round, normCode } from './degree-engine.js';

const deg = () => store.get().degree;
const upd = (fn) => store.update((s) => fn(s.degree));
const TERMS = ['Fall', 'Winter', 'Summer', 'Full year'];
const STATUSES = [['completed', 'done'], ['in-progress', 'in progress'], ['planned', 'planned'], ['failed', 'failed'], ['dropped', 'dropped']];
const fmt = (n) => (Number.isInteger(n) ? String(n) : String(round(n)));

let busy = null; // label while an AI/fetch job runs

export function render(el) {
  const draw = () => {
    const d = deg();
    const s = summary(d);
    const unit = d.unit || 'credits';
    el.innerHTML = `
      <div class="page-head view-enter">
        <div>
          <div class="kicker">degree${d.school ? ' · ' + esc(d.school.toLowerCase()) : ''}${d.program ? ' · ' + esc(d.program.toLowerCase()) : ''}</div>
          <h1>the <em>long game</em></h1>
          <p>every course, every ${esc(unit.replace(/s$/, ''))}, and exactly what’s left before you graduate.</p>
        </div>
        <div class="row">
          <label class="btn ghost sm">import transcript<input type="file" id="tx-file" accept="${ACCEPT}" multiple hidden></label>
          <button class="btn sm" id="add-year">+ add year</button>
        </div>
      </div>

      ${summaryCard(d, s)}

      <div class="grid dash view-enter" style="margin-top:22px">
        <div class="stack" id="years">${d.years.length ? d.years.map((y, i) => yearFolder(d, y, i)).join('') : emptyYears()}</div>
        <div class="stack">${requirementsCard(d, s)}</div>
      </div>`;
    wire(el, draw);
  };
  draw();
}

// ---------------- pieces ----------------
function summaryCard(d, s) {
  const unit = d.unit || 'credits';
  const R = 70;
  const C = 2 * Math.PI * R;
  const arc = (pct, cls) => `<circle class="${cls}" cx="90" cy="90" r="${R}" fill="none" stroke-dasharray="${(C * pct) / 100} ${C}" transform="rotate(-90 90 90)"/>`;
  const noTotal = !s.total;
  return `<div class="card cover degree-cover view-enter">
    <div>
      <div class="label small muted">progress${d.checkedAt ? ` · requirements checked ${fmtDate(new Date(d.checkedAt).toISOString().slice(0, 10), { month: 'short', day: 'numeric' }).toLowerCase()}` : ''}</div>
      <div class="mode">${noTotal ? `<em>${fmt(s.earned)}</em> ${esc(unit)} earned` : s.left === 0 ? '<em>done.</em> you have enough to graduate' : `<em>${fmt(s.left)}</em> ${esc(unit)} left`}</div>
      <p>${noTotal ? 'set how many you need to graduate in <b>requirements</b> to see what’s left.' : `${fmt(s.earned)} of ${fmt(s.total)} earned${s.inProgress ? `, ${fmt(s.inProgress)} in progress` : ''}${s.planned ? `, ${fmt(s.planned)} planned` : ''}.${s.leftAfterPlan && (s.inProgress || s.planned) ? ` after everything you’ve planned: <b>${fmt(s.leftAfterPlan)}</b> to go.` : ''}${s.yearsLeft && s.leftAfterCurrent ? ` at your pace (~${fmt(s.pace)} a year) that’s about <b>${fmt(s.yearsLeft)} more year${s.yearsLeft === 1 ? '' : 's'}</b>.` : ''}`}</p>
      <div class="row" style="gap:28px">
        ${stat(s.percent != null ? s.percent + '%' : '–', 'average')}
        ${stat(s.gpa != null ? s.gpa.toFixed(2) : '–', 'gpa (4.0)')}
        ${stat(s.reqCount ? `${s.reqMet}/${s.reqCount}` : '–', 'requirements met')}
        ${stat(countCourses(d), 'courses')}
      </div>
    </div>
    <svg class="deg-ring" viewBox="0 0 180 180" aria-label="${Math.round(s.pct)}% complete">
      <circle cx="90" cy="90" r="${R}" fill="none" class="r-track"/>
      ${arc(s.pctPlan, 'r-plan')}${arc(s.pctIp, 'r-ip')}${arc(s.pct, 'r-done')}
      <text x="90" y="88" text-anchor="middle" class="r-pct">${noTotal ? '–' : Math.round(s.pct) + '%'}</text>
      <text x="90" y="110" text-anchor="middle" class="r-lbl">to graduation</text>
    </svg>
  </div>`;
}
const stat = (v, l) => `<div><div class="stat" style="font-size:32px">${esc(String(v))}</div><div class="small muted">${l}</div></div>`;
const countCourses = (d) => d.years.reduce((a, y) => a + y.courses.filter((c) => !['dropped', 'failed'].includes(c.status)).length, 0);

function emptyYears() {
  return `<div class="card cta">
    <div class="big">year one.</div>
    <h3>add your first year</h3>
    <p class="muted">make a folder for each school year and drop your courses in. or import your transcript and it’ll build the folders for you.</p>
    <div class="row" style="justify-content:center"><button class="btn" id="add-year-2">+ add year</button><label class="btn ghost">import transcript<input type="file" id="tx-file-2" accept="${ACCEPT}" multiple hidden></label></div>
  </div>`;
}

function yearFolder(d, y, i) {
  const credits = round(y.courses.filter((c) => !['dropped', 'failed'].includes(c.status)).reduce((a, c) => a + (Number(c.credits) || 0), 0));
  const done = round(y.courses.filter((c) => c.status === 'completed').reduce((a, c) => a + (Number(c.credits) || 0), 0));
  const groups = {};
  for (const c of y.courses) (groups[c.term || 'Fall'] ||= []).push(c);
  const order = [...TERMS, ...Object.keys(groups).filter((t) => !TERMS.includes(t))].filter((t) => groups[t]);
  const open = y.open !== false;
  return `<div class="folder ${open ? 'open' : ''}" data-year="${y.id}" style="--tilt:${i % 2 ? '0.4deg' : '-0.3deg'}">
    <div class="folder-tab"><span>${String(i + 1).padStart(2, '0')}</span></div>
    <div class="folder-body card">
      <div class="folder-head">
        <button class="icon-btn fold" data-toggle title="${open ? 'close' : 'open'} folder"><span class="chev ${open ? 'down' : ''}"></span></button>
        <input class="folder-title" data-label value="${esc(y.label)}" aria-label="year name">
        <span class="label small muted">${fmt(credits)} ${esc(d.unit || 'credits')}${done !== credits ? ` · ${fmt(done)} done` : ''} · ${y.courses.length} course${y.courses.length === 1 ? '' : 's'}</span>
        <button class="icon-btn" data-del-year title="delete year">delete</button>
      </div>
      ${open ? `
        ${order.map((t) => `<div class="term-label">${esc(t.toLowerCase())}</div>
          <div class="course-list">${groups[t].map((c) => courseRow(c)).join('')}</div>`).join('') || '<div class="small muted" style="padding:6px 2px 10px">no courses yet</div>'}
        <div class="add-course">
          <input data-f="code" placeholder="code, e.g. PSY100H1" style="max-width:150px">
          <input data-f="title" placeholder="course name (optional)">
          <input data-f="credits" type="number" step="0.25" min="0" value="${esc(String(d.defaultCredit ?? 0.5))}" title="${esc(d.unit || 'credits')}" style="max-width:78px">
          <select data-f="term">${TERMS.map((t) => `<option ${t === defaultTerm(y) ? 'selected' : ''}>${t}</option>`).join('')}</select>
          <select data-f="status">${STATUSES.slice(0, 3).map(([v, l]) => `<option value="${v}" ${v === defaultStatus(y, d) ? 'selected' : ''}>${l}</option>`).join('')}</select>
          <button class="btn sm" data-add>add</button>
        </div>
        ${i === d.years.length - 1 && currentCoursesToAdd(d).length ? `<button class="btn ghost sm" data-add-current style="margin-top:10px">+ add my current courses (${currentCoursesToAdd(d).map((c) => esc(c.code)).join(', ')})</button>` : ''}` : ''}
    </div>
  </div>`;
}

function courseRow(c) {
  return `<div class="course-row s-${c.status}" data-course="${c.id}">
    <span class="c-dot" title="${esc(c.status)}"></span>
    <input class="c-code" data-c="code" value="${esc(c.code)}" aria-label="course code">
    <input class="c-title" data-c="title" value="${esc(c.title || '')}" placeholder="—" aria-label="course name">
    <input class="c-num" data-c="credits" type="number" step="0.25" min="0" value="${esc(String(c.credits ?? ''))}" aria-label="credits">
    <input class="c-num" data-c="grade" value="${esc(c.grade || '')}" placeholder="grade" aria-label="grade">
    <select class="c-status" data-c="status">${STATUSES.map(([v, l]) => `<option value="${v}" ${v === c.status ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <button class="icon-btn" data-del-course title="remove">×</button>
  </div>`;
}

const defaultTerm = (y) => y.courses[y.courses.length - 1]?.term || 'Fall';
function defaultStatus(y, d) {
  const idx = d.years.indexOf(y);
  if (idx < d.years.length - 1) return 'completed';
  return y.courses.some((c) => c.status === 'in-progress') || !d.years.slice(0, idx).length ? 'in-progress' : y.courses.every((c) => c.status === 'planned') && y.courses.length ? 'planned' : 'in-progress';
}
function currentCoursesToAdd(d) {
  const have = new Set(d.years.flatMap((y) => y.courses.map((c) => normCode(c.code))));
  return store.get().courses.filter((c) => c.code && !have.has(normCode(c.code)));
}

function requirementsCard(d, s) {
  const res = s.results;
  const reqs = d.requirements;
  const presetHint = schoolPreset(d.school);
  const stateLabel = { met: 'met', 'in-progress': 'on track', planned: 'planned', missing: 'missing', manual: 'check yourself' };
  return `<div class="card taped" id="req-card">
    <h3>requirements <span>${reqs.length ? `${s.reqMet} of ${s.reqCount} met` : 'not set up'}</span></h3>

    <details class="req-setup" ${reqs.length ? '' : 'open'}>
      <summary>${reqs.length ? 'your program & sources' : 'set up your program'}</summary>
      <div class="stack" style="gap:10px;margin-top:12px">
        <label class="field">university<div class="combo"><input id="d-school" value="${esc(d.school)}" placeholder="University of Toronto" autocomplete="off" role="combobox" aria-expanded="false"><div class="combo-list" id="school-list" role="listbox" hidden></div></div></label>
        <label class="field">program / major<input id="d-program" value="${esc(d.program)}" placeholder="Honours BSc, Computer Science Major"></label>
        <label class="field">stream / option / concentration (if you know it)<input id="d-stream" value="${esc(d.stream || '')}" placeholder="e.g. CMP1, co-op, AI focus. leave blank and it’ll ask"></label>
        <label class="field">links to your program requirements (one per line)<textarea id="d-links" style="min-height:74px" placeholder="https://artsci.calendar.utoronto.ca/program/…&#10;add your minor’s page too">${esc(d.links)}</textarea></label>
        <details><summary class="small muted" style="cursor:pointer">or paste / upload the requirements</summary>
          <label class="drop" id="req-drop" style="padding:14px;margin-top:8px"><input type="file" id="req-file" accept="${ACCEPT}" multiple hidden><b style="font-size:18px">drop a pdf or screenshot</b><span class="muted small">e.g. the calendar page saved as pdf, or your degree audit</span></label>
          <textarea id="d-paste" style="min-height:90px;margin-top:8px" placeholder="paste requirement text here"></textarea>
        </details>
        <div class="row">
          <label class="field">needed to graduate<input id="d-total" type="number" step="0.5" min="0" value="${d.totalCredits || ''}" placeholder="${presetHint ? presetHint.total : '20'}"></label>
          <label class="field">one-term course =<input id="d-credit" type="number" step="0.25" min="0" value="${d.defaultCredit ?? ''}" placeholder="${presetHint ? presetHint.credit : '0.5'}"></label>
          <label class="field">called<input id="d-unit" value="${esc(d.unit || '')}" placeholder="${presetHint ? presetHint.unit : 'credits'}"></label>
        </div>
        <div class="row spread">
          <button class="btn ghost sm" id="d-save">save</button>
          <button class="btn sm" id="d-check" ${busy ? 'disabled' : ''}>${aiEnabled() ? (reqs.length ? 're-check requirements' : 'check my requirements') : 'check my requirements'}</button>
        </div>
        ${busy ? `<div>${spinner(busy)}</div>` : ''}
        <div id="d-status"></div>
        ${aiEnabled() ? '' : '<p class="small muted" style="margin:0">reading requirements automatically needs ai (connect kiro or a key in <code>.env</code>). you can still add requirements by hand below.</p>'}
        ${d.sources?.length ? `<p class="small muted" style="margin:0">read from: ${d.sources.map((x) => esc(x)).join(' · ')}</p>` : ''}
      </div>
    </details>

    ${streamPicker(d)}
    ${questionsBox(d)}
    ${reqs.length ? `<div class="req-list">${reqs.map((r) => reqRow(r, res[r.id], d, stateLabel)).join('')}</div>` : ''}
    <div class="row spread" style="margin-top:14px">
      <button class="btn ghost sm" id="req-add">+ add requirement</button>
      ${aiEnabled() && reqs.length ? '<button class="btn ghost sm" id="req-plan">what should i take next?</button>' : ''}
    </div>
    <p class="small faint" style="margin:14px 0 0">a planning helper, not an official audit. double-check with your registrar or your school’s degree audit tool before you enrol.</p>
  </div>`;
}

function streamPicker(d) {
  const streams = d.streams || [];
  if (streams.length < 2) return '';
  const chosen = streams.find((x) => x.name === d.stream);
  return `<div class="ask-card ${chosen ? 'answered' : ''}" id="stream-card">
    <div class="ask-q">${chosen ? 'your stream' : `your program has ${streams.length} streams with different requirements. which one are you in?`}</div>
    <div class="ask-opts">${streams.map((x, i) => `<button class="ask-opt ${x.name === d.stream ? 'on' : ''}" data-stream="${i}"><b>${esc(x.name)}</b>${x.description ? `<small>${esc(x.description)}</small>` : ''}</button>`).join('')}</div>
    ${chosen ? '' : '<p class="small muted" style="margin:8px 0 0">not sure? check your acceptance letter, ACORN/your student portal, or ask your program advisor.</p>'}
  </div>`;
}

function questionsBox(d) {
  const qs = (d.questions || []).filter((q) => q && q.question);
  if (!qs.length) return '';
  const answers = d.answers || {};
  const open = qs.filter((q) => !answers[q.question]);
  return `<div class="ask-card ${open.length ? '' : 'answered'}" id="q-card">
    <div class="ask-q">${open.length ? 'a few more questions so the checklist matches you exactly' : 'your answers'}</div>
    ${qs.map((q, i) => `<div class="ask-item">
      <div class="small" style="margin-bottom:6px">${esc(q.question)}</div>
      <div class="ask-opts">${(q.options?.length ? q.options : ['yes', 'no']).map((o) => `<button class="ask-opt sm ${answers[q.question] === o ? 'on' : ''}" data-q="${i}" data-a="${esc(o)}">${esc(o)}</button>`).join('')}</div>
    </div>`).join('')}
    ${!open.length && d.answersChanged ? '<button class="btn sm" id="q-recheck" style="margin-top:10px">update my requirements</button>' : ''}
  </div>`;
}

function applyStream(dd, stream) {
  const manualDone = new Map(dd.requirements.filter((r) => r.type === 'manual').map((r) => [r.name.toLowerCase(), r.done]));
  const reqs = (stream.requirements || []).map((r) => ({ ...r, id: uid(), done: r.type === 'manual' ? Boolean(manualDone.get(r.name.toLowerCase())) : false }));
  dd.requirements = [...reqs, ...dd.requirements.filter((r) => r.source === 'manual')];
  dd.stream = stream.name;
  if (stream.totalCredits) dd.totalCredits = Number(stream.totalCredits);
}

function reqRow(r, x, d, labels) {
  if (!x) return '';
  const unit = x.unit === 'courses' ? (x.need === 1 ? 'course' : 'courses') : d.unit || 'credits';
  const need = x.need || 0;
  const w = (v) => (need ? Math.min(100, (v / need) * 100) : 0);
  const done = x.done || 0, ip = x.inProgress || 0, pl = x.planned || 0;
  return `<div class="req s-${x.state}" data-req="${r.id}">
    <div class="row spread" style="flex-wrap:nowrap;align-items:flex-start">
      <div style="min-width:0">
        <div class="req-name">${esc(r.name || 'requirement')}</div>
        ${r.type === 'manual' ? '' : `<div class="small muted">${fmt(done)}${ip ? ` + ${fmt(ip)} in progress` : ''}${pl ? ` + ${fmt(pl)} planned` : ''} of ${fmt(need)} ${esc(unit)}</div>`}
      </div>
      <span class="req-state">${labels[x.state]}</span>
    </div>
    ${r.type === 'manual' ? `<label class="check small" style="margin-top:8px"><input type="checkbox" data-req-done ${r.done ? 'checked' : ''}> done</label>` : `
      <div class="req-bar"><span class="b-done" style="width:${w(done)}%"></span><span class="b-ip" style="width:${Math.max(0, w(done + ip) - w(done))}%"></span><span class="b-pl" style="width:${Math.max(0, w(done + ip + pl) - w(done + ip))}%"></span></div>
      ${x.matched?.length ? `<div class="small muted">counts: ${x.matched.map((m) => `<span class="code-chip s-${m.status}">${esc(m.code)}</span>`).join(' ')}</div>` : ''}
      ${x.missing?.length ? `<div class="small" style="color:var(--accent);margin-top:4px">still need: ${x.missing.map((m) => esc(m.replace(/\s*\|\s*/g, ' or '))).join(', ')}</div>` : ''}
      ${r.type === 'choose' && x.state !== 'met' && r.courses?.length ? `<div class="small faint" style="margin-top:4px">from: ${esc(r.courses.slice(0, 12).join(', ').replace(/\|/g, ' or '))}${r.courses.length > 12 ? '…' : ''}</div>` : ''}`}
    ${r.note ? `<div class="small faint" style="margin-top:4px">${esc(r.note)}</div>` : ''}
    <div class="req-actions"><button class="icon-btn" data-req-edit>edit</button><button class="icon-btn" data-req-del>remove</button></div>
  </div>`;
}

// ---------------- wiring ----------------
function wire(el, draw) {
  const $ = (q) => el.querySelector(q);

  const addYear = () => {
    const d = deg();
    const prev = d.years[d.years.length - 1];
    const prevStart = prev && +(prev.label.match(/(20\d{2})\s*[–-]/) || [])[1];
    const start = prevStart ? prevStart + 1 : academicStart();
    const id = uid();
    upd((dd) => dd.years.push({ id, label: yearLabel(dd.years.length + 1, start), open: true, courses: [] }));
    draw();
    setTimeout(() => el.querySelector(`[data-year="${id}"] [data-f="code"]`)?.focus(), 30);
  };
  $('#add-year').onclick = addYear;
  $('#add-year-2')?.addEventListener('click', addYear);
  [$('#tx-file'), $('#tx-file-2')].filter(Boolean).forEach((inp) => (inp.onchange = (e) => importTranscript(e.target.files, draw)));

  // ---- year folders ----
  el.querySelectorAll('[data-year]').forEach((f) => {
    const yid = f.dataset.year;
    const year = () => deg().years.find((y) => y.id === yid);
    f.querySelector('[data-toggle]').onclick = () => { upd((d) => { const y = d.years.find((x) => x.id === yid); y.open = y.open === false; }); draw(); };
    f.querySelector('[data-label]').onchange = (e) => upd((d) => (d.years.find((x) => x.id === yid).label = e.target.value.trim() || 'Year'));
    f.querySelector('[data-del-year]').onclick = () => {
      const y = year();
      if (y.courses.length && !confirm(`Delete “${y.label}” and its ${y.courses.length} courses?`)) return;
      const idx = deg().years.indexOf(y);
      upd((d) => (d.years = d.years.filter((x) => x.id !== yid)));
      draw();
      toast('year deleted', { action: 'undo', onAction: () => { upd((d) => d.years.splice(idx, 0, y)); draw(); } });
    };
    const add = f.querySelector('[data-add]');
    if (add) {
      const val = (k) => f.querySelector(`[data-f="${k}"]`).value.trim();
      const doAdd = () => {
        const code = val('code').toUpperCase();
        if (!code) return f.querySelector('[data-f="code"]').focus();
        upd((d) => d.years.find((x) => x.id === yid).courses.push({ id: uid(), code, title: val('title'), credits: Number(val('credits')) || 0, term: val('term'), status: val('status'), grade: '' }));
        draw();
        el.querySelector(`[data-year="${yid}"] [data-f="code"]`)?.focus();
      };
      add.onclick = doAdd;
      f.querySelectorAll('.add-course input').forEach((i) => (i.onkeydown = (e) => { if (e.key === 'Enter') doAdd(); }));
    }
    f.querySelector('[data-add-current]')?.addEventListener('click', () => {
      const d = deg();
      const list = currentCoursesToAdd(d);
      upd((dd) => dd.years.find((x) => x.id === yid).courses.push(...list.map((c) => ({ id: uid(), code: c.code.toUpperCase(), title: c.name !== c.code ? c.name : '', credits: dd.defaultCredit ?? 0.5, term: currentTerm(), status: 'in-progress', grade: '' }))));
      toast(`added ${list.length} current course${list.length === 1 ? '' : 's'}`);
      draw();
    });
    f.querySelectorAll('[data-course]').forEach((row) => {
      const cid = row.dataset.course;
      row.querySelectorAll('[data-c]').forEach((inp) => (inp.onchange = () => {
        const k = inp.dataset.c;
        let v = inp.value.trim();
        if (k === 'credits') v = Number(v) || 0;
        if (k === 'code') v = v.toUpperCase();
        upd((d) => {
          const c = d.years.find((x) => x.id === yid).courses.find((x) => x.id === cid);
          c[k] = v;
          // entering a grade on an in-progress course means it's finished
          if (k === 'grade' && v && c.status !== 'completed' && c.status !== 'failed') c.status = 'completed';
        });
        draw();
      }));
      row.querySelector('[data-del-course]').onclick = () => { upd((d) => { const y = d.years.find((x) => x.id === yid); y.courses = y.courses.filter((c) => c.id !== cid); }); draw(); };
    });
  });

  // ---- requirements setup ----
  const saveSetup = () => {
    const school = $('#d-school').value.trim();
    const p = schoolPreset(school);
    upd((d) => {
      const changedSchool = school && school !== d.school;
      d.school = school;
      d.program = $('#d-program').value.trim();
      const typed = $('#d-stream').value.trim();
      if (typed !== (d.stream || '')) {
        d.stream = typed;
        const hit = (d.streams || []).find((x) => matchStream(x.name, typed));
        if (hit) applyStream(d, hit);
      }
      d.links = $('#d-links').value.trim();
      d.totalCredits = Number($('#d-total').value) || (changedSchool && p && !d.totalCredits ? p.total : d.totalCredits || 0);
      d.defaultCredit = $('#d-credit').value !== '' ? Number($('#d-credit').value) : p ? p.credit : d.defaultCredit;
      d.unit = $('#d-unit').value.trim() || (p ? p.unit : d.unit || 'credits');
    });
  };
  mountCombo($('#d-school'), $('#school-list'), SCHOOLS.map((x) => x.name), () => $('#d-school').onchange());
  el.querySelectorAll('[data-stream]').forEach((b) => (b.onclick = () => {
    const st = deg().streams[+b.dataset.stream];
    upd((d) => applyStream(d, st));
    toast(`using the ${st.name} requirements`);
    draw();
  }));
  el.querySelectorAll('[data-q]').forEach((b) => (b.onclick = () => {
    const q = deg().questions[+b.dataset.q];
    upd((d) => { d.answers = { ...(d.answers || {}), [q.question]: b.dataset.a }; d.answersChanged = true; });
    draw();
  }));
  $('#q-recheck')?.addEventListener('click', () => { upd((d) => (d.answersChanged = false)); checkRequirements($('#d-paste')?.value.trim() || '', draw); });
  $('#d-school').onchange = () => {
    const p = schoolPreset($('#d-school').value);
    if (!p) return;
    if (!$('#d-credit').value) $('#d-credit').value = p.credit;
    if (!$('#d-unit').value) $('#d-unit').value = p.unit;
    if (!$('#d-total').value) $('#d-total').value = p.total;
  };
  $('#d-save').onclick = () => { saveSetup(); toast('saved'); draw(); };
  const reqFile = $('#req-file');
  const loadReqFiles = async (files) => {
    const ta = $('#d-paste');
    ta.placeholder = 'reading…';
    try { ta.value = (ta.value ? ta.value + '\n\n' : '') + (await readFilesText(files, { onProgress: (m) => (ta.placeholder = m) })); } catch (e) { toast(e.message, { timeout: 8000 }); }
    ta.placeholder = 'paste requirement text here';
  };
  reqFile.onchange = (e) => loadReqFiles(e.target.files);
  const drop = $('#req-drop');
  ['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
  drop.addEventListener('drop', (e) => loadReqFiles(e.dataTransfer.files));

  $('#d-check').onclick = () => {
    saveSetup();
    if (!aiEnabled()) {
      toast('reading requirements needs ai. add them with “+ add requirement” for now', { timeout: 7000 });
      draw();
      return;
    }
    checkRequirements($('#d-paste').value.trim(), draw);
  };

  // ---- requirement rows ----
  el.querySelectorAll('[data-req]').forEach((row) => {
    const rid = row.dataset.req;
    row.querySelector('[data-req-done]')?.addEventListener('change', (e) => { upd((d) => (d.requirements.find((r) => r.id === rid).done = e.target.checked)); draw(); });
    row.querySelector('[data-req-edit]').onclick = () => editRequirement(deg().requirements.find((r) => r.id === rid), draw);
    row.querySelector('[data-req-del]').onclick = () => {
      const r = deg().requirements.find((x) => x.id === rid);
      const idx = deg().requirements.indexOf(r);
      upd((d) => (d.requirements = d.requirements.filter((x) => x.id !== rid)));
      draw();
      toast('requirement removed', { action: 'undo', onAction: () => { upd((d) => d.requirements.splice(idx, 0, r)); draw(); } });
    };
  });
  $('#req-add').onclick = () => editRequirement(null, draw);
  $('#req-plan')?.addEventListener('click', () => askAbout(`Look at my degree progress and requirements. What should I take next term to stay on track to graduate? Point out anything I'm at risk of missing.`));
}

// ---------------- requirement editor ----------------
function editRequirement(r, draw) {
  const isNew = !r;
  const x = r || { name: '', type: 'choose', min: '', unit: 'credits', courses: [], note: '', overlap: false };
  modal(isNew ? 'add requirement' : 'edit requirement', `
    <label class="field">name<input id="r-name" value="${esc(x.name)}" placeholder="e.g. 1.0 credit of 300/400-level PSY"></label>
    <label class="field">type<select id="r-type">
      ${[['courses', 'take these specific courses'], ['choose', 'earn an amount from a list'], ['total', 'total needed to graduate'], ['manual', 'something i check off myself (gpa, breadth…)']].map(([v, l]) => `<option value="${v}" ${x.type === v ? 'selected' : ''}>${l}</option>`).join('')}
    </select></label>
    <div class="row" id="r-amount">
      <label class="field">how many<input id="r-min" type="number" step="0.5" min="0" value="${esc(String(x.min ?? ''))}" placeholder="leave empty = all"></label>
      <label class="field">counted in<select id="r-unit"><option value="credits" ${x.unit !== 'courses' ? 'selected' : ''}>${esc(deg().unit || 'credits')}</option><option value="courses" ${x.unit === 'courses' ? 'selected' : ''}>courses</option></select></label>
    </div>
    <label class="field" id="r-courses-f">courses (one per line)<textarea id="r-courses" style="min-height:110px" placeholder="PSY100H1&#10;PSY201H1 | STA220H1   ← either one&#10;PSY3XX   ← any 300-level PSY&#10;PSY   ← any PSY course">${esc((x.courses || []).join('\n'))}</textarea></label>
    <label class="check small" id="r-overlap-f"><input type="checkbox" id="r-overlap" ${x.overlap ? 'checked' : ''}> courses here can also count toward other requirements</label>
    <label class="field">note<input id="r-note" value="${esc(x.note || '')}" placeholder="optional"></label>
    <div class="row" style="justify-content:flex-end"><button class="btn" id="r-save">${isNew ? 'add' : 'save'}</button></div>`, {
    onMount(body, close) {
      const $ = (q) => body.querySelector(q);
      const sync = () => {
        const t = $('#r-type').value;
        $('#r-courses-f').style.display = t === 'courses' || t === 'choose' ? '' : 'none';
        $('#r-overlap-f').style.display = t === 'courses' || t === 'choose' ? '' : 'none';
        $('#r-amount').style.display = t === 'manual' ? 'none' : '';
        $('#r-unit').parentElement.style.display = t === 'choose' ? '' : 'none';
      };
      $('#r-type').onchange = sync;
      sync();
      $('#r-save').onclick = () => {
        const data = {
          name: $('#r-name').value.trim() || 'requirement',
          type: $('#r-type').value,
          min: $('#r-min').value === '' ? '' : Number($('#r-min').value),
          unit: $('#r-unit').value,
          courses: $('#r-courses').value.split(/\n|,(?![^|]*\|)/).map((s) => s.trim()).filter(Boolean),
          overlap: $('#r-overlap').checked,
          note: $('#r-note').value.trim(),
        };
        if (data.type === 'total' && data.min) upd((d) => (d.totalCredits = data.min));
        upd((d) => {
          if (isNew) d.requirements.push({ id: uid(), source: 'manual', done: false, ...data });
          else Object.assign(d.requirements.find((q) => q.id === r.id), data);
        });
        close();
        draw();
      };
    },
  });
}

// ---------------- combobox (styled replacement for <datalist>) ----------------
function mountCombo(input, list, options, onPick) {
  let active = -1;
  const show = () => {
    const q = input.value.trim().toLowerCase();
    const items = options.filter((o) => !q || o.toLowerCase().includes(q) || (schoolPreset(q)?.name === o)).slice(0, 8);
    if (!items.length || (items.length === 1 && items[0] === input.value)) return hide();
    active = Math.min(active, items.length - 1);
    list.innerHTML = items.map((o, i) => `<button type="button" class="combo-opt ${i === active ? 'on' : ''}" data-v="${esc(o)}" role="option">${esc(o)}</button>`).join('');
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    list.querySelectorAll('[data-v]').forEach((b) => (b.onmousedown = (e) => { e.preventDefault(); pick(b.dataset.v); }));
  };
  const hide = () => { list.hidden = true; active = -1; input.setAttribute('aria-expanded', 'false'); };
  const pick = (v) => { input.value = v; hide(); onPick?.(v); };
  input.addEventListener('focus', show);
  input.addEventListener('input', () => { active = -1; show(); });
  input.addEventListener('blur', () => setTimeout(hide, 120));
  input.addEventListener('keydown', (e) => {
    const opts = [...list.querySelectorAll('[data-v]')];
    if (list.hidden || !opts.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + opts.length) % opts.length;
      opts.forEach((o, i) => o.classList.toggle('on', i === active));
    } else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); pick(opts[active].dataset.v); }
    else if (e.key === 'Escape') hide();
  });
}

const normStream = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function matchStream(name, typed) {
  const a = normStream(name), b = normStream(typed);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a) || a.split(' ').some((w) => w.length > 2 && b.split(' ').includes(w) && /\d/.test(w));
}

// ---------------- automatic requirement check ----------------
async function checkRequirements(pasted, draw) {
  const d = deg();
  const links = d.links.split(/\s+/).map((s) => s.trim()).filter((s) => /^https?:\/\//i.test(s));
  if (!links.length && !pasted) return toast('add a link to your program page (or paste the requirements) first');
  busy = links.length ? `reading ${links.length} page${links.length === 1 ? '' : 's'}…` : 'reading requirements…';
  draw();
  const texts = [];
  const sources = [];
  const errors = [];
  for (const url of links) {
    try {
      const r = await fetch('/api/page-text?url=' + encodeURIComponent(url));
      const data = await r.json();
      if (!r.ok) throw new Error(data.error);
      texts.push(`# Source: ${data.title || url}\n${url}\n\n${data.text}`);
      sources.push(data.title ? data.title.slice(0, 60) : new URL(url).hostname);
    } catch (e) {
      errors.push(`${new URL(url).hostname}: ${e.message}`);
    }
  }
  if (pasted) { texts.push(`# Source: pasted / uploaded text\n\n${pasted}`); sources.push('pasted text'); }
  if (!texts.length) {
    busy = null;
    draw();
    return showStatus(`couldn’t read your links. ${errors.join(' · ')}`);
  }
  busy = 'working out your requirements…';
  draw();
  const sampleCodes = d.years.flatMap((y) => y.courses.map((c) => c.code)).slice(0, 25);
  const answers = Object.entries(d.answers || {}).map(([q, a]) => `- ${q} → ${a}`).join('\n');
  const reqSchema = '{"name":"short readable name","type":"courses|choose|total|manual","min":number|null,"unit":"credits|courses","courses":["CODE"],"note":"","overlap":false}';
  try {
    const reply = await ask({
      system: `You turn Canadian university program requirements into a precise checklist. Use ONLY the source text; never invent requirements, course codes or numbers.
Return ONLY JSON:
{"school":"","program":"","totalCredits":number|null,"unit":"credits|units|courses|credit hours","defaultCredit":number|null,
 "streams":[{"name":"short stream name exactly as the calendar calls it","description":"one line: who this stream is for / how you get in","totalCredits":number|null,"requirements":[${reqSchema}]}],
 "questions":[{"question":"","options":["",""]}],
 "warnings":["anything ambiguous the student should confirm"]}
STREAMS: Many programs have different requirement sets depending on stream, admission category, option, concentration, focus, co-op vs regular, specialist vs major, honours vs general, or year of entry (e.g. UTM Computer Science has a CMP1 admission category and other streams with different first-year requirements). If the source describes more than one such set, return ONE stream per set, each with its COMPLETE requirements (repeat shared requirements in every stream). If there is only one set, return exactly one stream.
QUESTIONS: Only for choices that change requirements but are NOT separate streams in the text (e.g. "Are you in co-op?", "Which minor are you pairing this with?", "Did you start before Fall 2024?"). Max 4, each with 2-5 short options. Don't ask anything the student already answered. Return [] if none.
REQUIREMENT TYPES:
- "courses": specific required courses. Alternatives in one entry joined with " | " (e.g. "PSY201H1 | STA220H1"). min = how many entries are required (null = all).
- "choose": "X credits/courses from a list or level". courses = codes or patterns: X is a digit wildcard ("CSC3XX" = any 300-level CSC), a bare subject ("CSC") = any course in that subject, "*4XX" = any 400-level course. min = the amount, unit = credits or courses.
- "total": total needed for the degree (also set totalCredits).
- "manual": things that can't be checked from course codes (minimum GPA/CGPA, breadth/distribution categories not defined by codes, residency, experiential learning, program admission/POSt requirements). Put the detail in note.
- overlap true for breadth/distribution-type requirements that may use courses also counted elsewhere, when the text allows it.
- Write course codes exactly as the calendar does. The student's codes look like: ${sampleCodes.join(', ') || '(none yet)'}.
- defaultCredit = credit value of a one-term course at this school; unit = what the school calls credits.
- Cover every program named (major AND minor), prefixing names ("Major: …", "Minor: …").`,
      messages: [{ role: 'user', content: `School: ${d.school || 'unknown'}\nProgram(s): ${d.program || 'see sources'}\nStream the student says they're in: ${d.stream || '(not given)'}\n${answers ? `Student's answers:\n${answers}\n` : ''}\n${texts.join('\n\n---\n\n').slice(0, 70000)}` }],
      maxTokens: 8000,
    });
    const data = extractJSON(reply);
    const cleanReqs = (list) => (list || [])
      .filter((r) => r && ['courses', 'choose', 'total', 'manual'].includes(r.type))
      .map((r) => ({
        id: uid(), source: 'ai', done: false,
        name: String(r.name || 'requirement').slice(0, 140),
        type: r.type,
        min: r.min == null || r.min === '' ? '' : Number(r.min),
        unit: r.unit === 'courses' ? 'courses' : 'credits',
        courses: (r.courses || []).map(String).filter(Boolean).slice(0, 200),
        note: String(r.note || '').slice(0, 300),
        overlap: Boolean(r.overlap),
      }));
    // older single-list replies still work
    let streams = (data.streams || []).filter((x) => x && x.requirements?.length).map((x) => ({ name: String(x.name || 'stream').slice(0, 80), description: String(x.description || '').slice(0, 200), totalCredits: x.totalCredits || null, requirements: cleanReqs(x.requirements) }));
    if (!streams.length && data.requirements) streams = [{ name: 'main', description: '', requirements: cleanReqs(data.requirements) }];
    const questions = (data.questions || []).filter((q) => q?.question).slice(0, 4).map((q) => ({ question: String(q.question).slice(0, 200), options: (q.options || []).map(String).filter(Boolean).slice(0, 5) }));
    let picked = null;
    upd((dd) => {
      dd.streams = streams.length > 1 ? streams : [];
      dd.questions = questions;
      dd.answers = Object.fromEntries(Object.entries(dd.answers || {}).filter(([q]) => questions.some((x) => x.question === q)));
      dd.answersChanged = false;
      if (data.totalCredits) dd.totalCredits = Number(data.totalCredits);
      if (data.defaultCredit) dd.defaultCredit = Number(data.defaultCredit);
      if (data.unit) dd.unit = String(data.unit);
      if (!dd.school && data.school) dd.school = String(data.school);
      if (!dd.program && data.program) dd.program = String(data.program);
      dd.sources = sources;
      dd.checkedAt = Date.now();
      picked = streams.length === 1 ? streams[0] : streams.find((x) => matchStream(x.name, dd.stream));
      if (picked) applyStream(dd, streams.length === 1 && !dd.stream ? { ...picked, name: '' } : picked);
      else { dd.requirements = dd.requirements.filter((r) => r.source === 'manual'); dd.stream = ''; }
    });
    busy = null;
    draw();
    const warn = [...errors, ...(data.warnings || [])];
    if (warn.length) showStatus(`<b>double-check:</b><ul style="margin:4px 0 0;padding-left:18px">${warn.map((w) => `<li>${esc(String(w))}</li>`).join('')}</ul>`, true);
    if (streams.length > 1 && !picked) {
      toast(`your program has ${streams.length} streams. pick yours`);
      document.querySelector('#stream-card')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else if (questions.length && questions.some((q) => !deg().answers?.[q.question])) {
      toast('answer a couple of questions to finish your checklist');
      document.querySelector('#q-card')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else toast(`found ${deg().requirements.length} requirement${deg().requirements.length === 1 ? '' : 's'}`);
  } catch (e) {
    busy = null;
    draw();
    showStatus(`couldn’t work out the requirements: ${esc(e.message)}`);
  }
}
function showStatus(html, isHtml) {
  const box = document.querySelector('#d-status');
  if (box) box.innerHTML = `<div class="small" style="color:var(--accent)">${isHtml ? html : esc(html)}</div>`;
}

// ---------------- transcript import ----------------
async function importTranscript(files, draw) {
  if (!files?.length) return;
  busy = 'reading your transcript…';
  toast('reading your transcript…');
  let text;
  try {
    text = await readFilesText(files);
  } catch (e) {
    busy = null;
    return toast(e.message, { timeout: 8000 });
  }
  let years = null;
  if (aiEnabled()) {
    try {
      const reply = await ask({
        system: `Extract every course from this university transcript / academic history. Return ONLY JSON:
{"school":"","years":[{"start":2025,"courses":[{"code":"","title":"","credits":number|null,"term":"Fall|Winter|Summer|Full year","grade":"","status":"completed|in-progress|failed|dropped"}]}]}
"start" = the calendar year the academic year began (Fall 2025 and Winter 2026 are both start 2025). Use credits exactly as shown (credits attempted/earned for the course). Withdrawn/"WDR"/"W" = dropped. No grade yet = in-progress. Never invent courses.`,
        messages: [{ role: 'user', content: text.slice(0, 60000) }],
        maxTokens: 6000,
      });
      const data = extractJSON(reply);
      years = (data.years || []).filter((y) => y.courses?.length);
      if (data.school && !deg().school) upd((d) => (d.school = String(data.school)));
    } catch (e) {
      toast(`ai couldn’t read it (${e.message}), trying the basic reader`);
    }
  }
  if (!years?.length) years = parseTranscript(text);
  busy = null;
  if (!years.length) return toast('couldn’t find any courses in that file. add them by hand instead', { timeout: 7000 });

  const def = deg().defaultCredit ?? 0.5;
  let added = 0;
  upd((d) => {
    const have = new Set(d.years.flatMap((y) => y.courses.map((c) => `${normCode(c.code)}|${c.term}|${y.label}`)));
    years.sort((a, b) => (a.start || 0) - (b.start || 0)).forEach((y, i) => {
      const labelStart = y.start ? `${y.start}–` : null;
      let folder = labelStart && d.years.find((f) => f.label.includes(labelStart));
      if (!folder) {
        folder = { id: uid(), label: yearLabel(d.years.length + 1, y.start), open: true, courses: [] };
        d.years.push(folder);
      }
      for (const c of y.courses) {
        const key = `${normCode(c.code)}|${c.term}|${folder.label}`;
        if (!c.code || have.has(key)) continue;
        have.add(key);
        folder.courses.push({ id: uid(), code: String(c.code).toUpperCase(), title: String(c.title || ''), credits: c.credits == null ? def : Number(c.credits), term: TERMS.includes(c.term) ? c.term : 'Fall', grade: String(c.grade ?? ''), status: ['completed', 'in-progress', 'failed', 'dropped', 'planned'].includes(c.status) ? c.status : 'completed' });
        added++;
      }
    });
    // keep folders in chronological order and renumber "Year N"
    d.years.sort((a, b) => (+(a.label.match(/(20\d{2})\s*[–-]/) || [])[1] || 9999) - (+(b.label.match(/(20\d{2})\s*[–-]/) || [])[1] || 9999));
    d.years.forEach((y, i) => { y.label = y.label.replace(/^Year \d+/, `Year ${i + 1}`); });
  });
  toast(`imported ${added} course${added === 1 ? '' : 's'}. check the credits and grades`);
  draw();
}

// Short text summary for the chat assistant
export function degreeContext() {
  const d = deg();
  if (!d.years.length && !d.requirements.length) return '';
  const s = summary(d);
  const res = evaluate(d);
  const open = d.requirements.filter((r) => r.type !== 'total' && res[r.id] && res[r.id].state !== 'met')
    .map((r) => `- ${r.name}: ${res[r.id].state}${res[r.id].missing?.length ? ` (missing ${res[r.id].missing.join(', ')})` : ''}${r.type === 'choose' ? ` (${res[r.id].done}/${res[r.id].need} ${r.unit}; from ${r.courses.slice(0, 8).join(', ')})` : ''}`);
  const courses = d.years.map((y) => `${y.label}: ${y.courses.map((c) => `${c.code} (${c.status}${c.grade ? ', ' + c.grade : ''})`).join(', ')}`).join('\n');
  return `\nDegree: ${d.program || '?'} at ${d.school || '?'}. ${s.earned}/${s.total || '?'} ${d.unit} earned, ${s.inProgress} in progress, ${s.planned} planned, ${s.left} left.${s.percent != null ? ` Average ${s.percent}%.` : ''}\nCourses by year:\n${courses}\nUnmet requirements:\n${open.join('\n') || '(none)'}`;
}
