// Focus modes: automatic escalation as exams approach, study-plan generation, pomodoro timer.
import { store, addEvents, courseColor, getCourse } from './store.js';
import { EXAM_TYPES, todayISO, addDays, daysUntil, fmtDate, esc, pad, TYPE_META } from './util.js';
import { toast } from './ui.js';
import { renderSpotify } from './spotify.js';
import { makePrep, prepFor, courseNotes } from './examprep.js';

export const MODES = {
  chill: { key: 'chill', label: 'drift', work: 25, brk: 5, playlist: 'chill',
    blurb: 'no exams in sight. stay on top of readings and assignments, and keep it soft.' },
  warmup: { key: 'warmup', label: 'rising', work: 30, brk: 5, playlist: 'chill',
    blurb: 'an exam is coming up within two weeks. gather your notes and list every topic.' },
  rampup: { key: 'rampup', label: 'gravity', work: 45, brk: 10, playlist: 'rampup',
    blurb: 'under a week out. daily sessions, practice problems, flashcards. main character energy.' },
  lockin: { key: 'lockin', label: 'eclipse', work: 50, brk: 10, playlist: 'lockin',
    blurb: '1–3 days left. the lights go down, distractions go away. long deep-work blocks and timed past exams.' },
  examday: { key: 'examday', label: 'liftoff', work: 20, brk: 10, playlist: 'examday',
    blurb: 'light review only. eat something, drink water, breathe. you prepared for this.' },
};

export function nextExam() {
  const today = todayISO();
  return store
    .get()
    .events.filter((e) => EXAM_TYPES.includes(e.type) && e.date >= today && !e.done)
    .sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')))[0];
}

export function autoMode(days) {
  if (days == null) return 'chill';
  if (days <= 0) return 'examday';
  if (days <= 3) return 'lockin';
  if (days <= 7) return 'rampup';
  if (days <= 14) return 'warmup';
  return 'chill';
}

export function getFocusState() {
  const { settings } = store.get();
  const exam = nextExam();
  const days = exam ? daysUntil(exam.date) : null;
  const auto = settings.autoFocus ? autoMode(days) : 'chill';
  const key = settings.focusOverride || auto;
  return { mode: MODES[key], auto: !settings.focusOverride, autoKey: auto, exam, days };
}

// ---- Study plan generation ----
const PLAN = [
  [-10, 'Gather materials & list every topic'],
  [-7, 'First-pass review of lectures & notes'],
  [-5, 'Practice problems on core topics'],
  [-3, 'Timed practice / past exam'],
  [-2, 'Weak spots + flashcards'],
  [-1, 'Light review, pack bag, sleep early'],
];

export function syncStudyPlans({ silent = false } = {}) {
  const s = store.get();
  if (!s.settings.autoStudyPlan) return 0;
  const today = todayISO();
  const planned = new Set(s.events.filter((e) => e.examId).map((e) => e.examId));
  const toAdd = [];
  for (const ex of s.events) {
    if (!EXAM_TYPES.includes(ex.type) || ex.date < today || planned.has(ex.id)) continue;
    for (const [off, task] of PLAN) {
      const date = addDays(ex.date, off);
      if (date < today) continue;
      toAdd.push({
        title: `Study: ${ex.title}`,
        type: 'study',
        courseId: ex.courseId,
        date,
        notes: task,
        source: 'auto-plan',
        examId: ex.id,
      });
    }
  }
  if (toAdd.length) {
    addEvents(toAdd);
    if (!silent) toast(`Scheduled ${toAdd.length} study sessions before your exams`);
  }
  return toAdd.length;
}

// ---- Pomodoro (module-level so it survives navigation) ----
const timer = { phase: 'work', running: false, endAt: 0, remaining: 0, total: 0, task: '', int: null };
const timerSubs = new Set();
export const onTimer = (fn) => (timerSubs.add(fn), () => timerSubs.delete(fn));
const emit = () => timerSubs.forEach((fn) => fn(timer));

function lengths() {
  const m = getFocusState().mode;
  return { work: m.work * 60, brk: m.brk * 60 };
}
export function resetTimer(phase = 'work') {
  clearInterval(timer.int);
  const L = lengths();
  Object.assign(timer, { phase, running: false, remaining: phase === 'work' ? L.work : L.brk });
  timer.total = timer.remaining;
  emit();
}
export function toggleTimer() {
  if (!timer.total) resetTimer();
  if (timer.running) {
    timer.running = false;
    timer.remaining = Math.max(0, Math.round((timer.endAt - Date.now()) / 1000));
    clearInterval(timer.int);
  } else {
    timer.running = true;
    timer.endAt = Date.now() + timer.remaining * 1000;
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission();
    timer.int = setInterval(tick, 500);
  }
  emit();
}
function tick() {
  timer.remaining = Math.max(0, Math.round((timer.endAt - Date.now()) / 1000));
  if (timer.remaining <= 0) {
    const finished = timer.phase;
    if (finished === 'work') {
      const mins = Math.round(timer.total / 60);
      store.update((s) => s.focusLog.push({ date: todayISO(), minutes: mins, task: timer.task }));
    }
    notify(finished === 'work' ? 'session done. go take a break' : 'break’s over. back to it');
    resetTimer(finished === 'work' ? 'brk' : 'work');
    return;
  }
  emit();
}
function notify(msg) {
  toast(msg);
  try {
    if ('Notification' in window && Notification.permission === 'granted') new Notification('orbit', { body: msg });
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.18].forEach((delay, i) => {
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = i ? 880 : 660;
      g.gain.setValueAtTime(0.0001, ctx.currentTime + delay);
      g.gain.exponentialRampToValueAtTime(0.2, ctx.currentTime + delay + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + delay + 0.5);
      o.connect(g).connect(ctx.destination);
      o.start(ctx.currentTime + delay);
      o.stop(ctx.currentTime + delay + 0.55);
    });
  } catch { /* ignore */ }
}
export const getTimer = () => timer;
export const fmtClock = (s) => `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;

// ---- Stats ----
export function focusStats() {
  const log = store.get().focusLog;
  const today = todayISO();
  const weekAgo = addDays(today, -6);
  const sum = (arr) => arr.reduce((a, b) => a + b.minutes, 0);
  return { today: sum(log.filter((l) => l.date === today)), week: sum(log.filter((l) => l.date >= weekAgo)) };
}

// ---- View ----
export function render(el) {
  const draw = () => {
    const s = store.get();
    const f = getFocusState();
    const today = todayISO();
    const tasks = s.events.filter((e) => e.date === today && e.type !== 'class');
    const stats = focusStats();
    const t = getTimer();
    const R = 132;
    el.innerHTML = `
      <div class="page-head view-enter">
        <div>
          <div class="kicker">focus · ${f.auto ? 'set automatically' : 'manual override'}</div>
          <h1>phase: <em>${esc(f.mode.label)}</em></h1>
          <p>${esc(f.mode.blurb)}</p>
        </div>
        <label class="check small"><input type="checkbox" id="zen" ${document.body.classList.contains('zen') ? 'checked' : ''}> zen mode (hide sidebar)</label>
      </div>
      <div class="focus-layout view-enter">
        <div class="stack">
          <div class="card timer-card">
            <div class="ring">
              <svg width="300" height="300" viewBox="0 0 300 300">
                <circle class="track" cx="150" cy="150" r="${R}" fill="none" stroke-width="2"/>
                <circle class="prog" id="prog" cx="150" cy="150" r="${R}" fill="none" stroke-width="2.5" stroke-dasharray="${2 * Math.PI * R}" stroke-dashoffset="0"/>
                <g id="moon" style="transform-origin:150px 150px"><circle class="moon-halo" cx="${150 + R}" cy="150" r="13"/><circle class="moon" cx="${150 + R}" cy="150" r="7"/></g>
              </svg>
              <div class="label"><div><div class="time" id="clock">${fmtClock(t.remaining || f.mode.work * 60)}</div><div class="phase" id="phase">${t.phase === 'work' ? 'focus' : 'break'} · ${f.mode.work}/${f.mode.brk}</div></div></div>
            </div>
            <input id="task" placeholder="what are you working on?" value="${esc(t.task)}" style="max-width:360px;text-align:center;border-radius:99px">
            <div class="row">
              <button class="btn" id="toggle">${t.running ? 'pause' : 'start'}</button>
              <button class="btn ghost" id="reset">reset</button>
              <button class="btn ghost" id="skip">skip to ${t.phase === 'work' ? 'break' : 'focus'}</button>
            </div>
          </div>
          <div class="card">
            <h3>phases <span>${f.auto ? 'auto' : 'manual'}</span></h3>
            <div class="modes">
              ${Object.values(MODES).map((m) => `<button class="mode-opt ${m.key === f.mode.key ? 'on' : ''}" data-mode="${m.key}"><b>${m.label}</b><small>${m.work}/${m.brk} min${m.key === f.autoKey ? ' · auto' : ''}</small></button>`).join('')}
            </div>
            ${f.auto ? '' : '<button class="btn ghost sm" id="auto" style="margin-top:12px">back to automatic</button>'}
          </div>
        </div>
        <div class="stack">
          ${f.exam ? `<div class="card taped">
            <h3>next exam</h3>
            <div class="row spread"><div><div style="font-family:var(--serif);font-size:26px;line-height:1.1">${esc(f.exam.title)}</div><div class="muted small" style="margin-top:4px">${esc(getCourse(f.exam.courseId)?.name || '')} · ${fmtDate(f.exam.date, { weekday: 'long', month: 'long', day: 'numeric' }).toLowerCase()}</div></div>
            <div class="stat" style="color:${courseColor(f.exam.courseId)}">${f.days}<span class="small muted" style="font-family:var(--mono)"> days</span></div></div>
            <div class="row" style="margin-top:14px">${prepFor(f.exam.id).length
              ? `<button class="btn sm" data-open-prep="${prepFor(f.exam.id).find((n) => n.prep.kind === 'cheatsheet')?.id || prepFor(f.exam.id)[0].id}">open cheat sheet</button><button class="btn ghost sm" data-open-prep="${prepFor(f.exam.id).find((n) => n.prep.kind === 'practice')?.id || ''}">practice test</button>`
              : courseNotes(f.exam.courseId).length ? '<button class="btn sm" id="make-prep">make cheat sheet + practice test</button>' : '<span class="small muted">add notes for this course and you’ll get a cheat sheet + practice test</span>'}</div>
          </div>` : ''}
          <div class="card">
            <h3>today</h3>
            ${tasks.length ? `<div class="ev-list">${tasks.map((e) => `<label class="ev ${e.done ? 'done' : ''}" style="--c:${courseColor(e.courseId)}"><input type="checkbox" data-done="${e.id}" ${e.done ? 'checked' : ''}><span class="bar"></span><div><div class="t">${esc(e.title)}</div>${e.notes ? `<div class="s">${esc(e.notes)}</div>` : ''}</div><span></span></label>`).join('')}</div>` : '<div class="empty">nothing scheduled today. pick something from your calendar.</div>'}
          </div>
          <div class="card">
            <h3>focus time</h3>
            <div class="row" style="gap:34px"><div><div class="stat">${stats.today}</div><div class="small muted">min today</div></div><div><div class="stat">${Math.round(stats.week / 6) / 10}</div><div class="small muted">hrs this week</div></div></div>
            <div class="progress" style="margin-top:16px"><span style="width:${Math.min(100, (stats.today / 180) * 100)}%"></span></div>
            <div class="hand" style="margin-top:8px;font-size:19px">goal: 3 hrs a day</div>
          </div>
          <div class="card"><h3>soundtrack</h3><div id="spotify"></div></div>
        </div>
      </div>`;

    el.querySelector('#toggle').onclick = () => { timer.task = el.querySelector('#task').value; toggleTimer(); };
    el.querySelector('#reset').onclick = () => resetTimer(t.phase);
    el.querySelector('#skip').onclick = () => resetTimer(t.phase === 'work' ? 'brk' : 'work');
    el.querySelector('#task').oninput = (e) => (timer.task = e.target.value);
    el.querySelector('#zen').onchange = (e) => document.body.classList.toggle('zen', e.target.checked);
    el.querySelectorAll('[data-mode]').forEach((b) => (b.onclick = () => {
      const k = b.dataset.mode;
      store.update((s) => (s.settings.focusOverride = k === f.autoKey ? null : k));
      if (!timer.running) resetTimer();
    }));
    el.querySelector('#auto')?.addEventListener('click', () => store.update((s) => (s.settings.focusOverride = null)));
    el.querySelectorAll('[data-done]').forEach((c) => (c.onchange = () =>
      store.update((s) => { const e = s.events.find((x) => x.id === c.dataset.done); if (e) e.done = c.checked; })));
    el.querySelectorAll('[data-open-prep]').forEach((b) => (b.onclick = () => { sessionStorage.setItem('studyos:open-note', b.dataset.openPrep); location.hash = '#/notes'; }));
    el.querySelector('#make-prep')?.addEventListener('click', async (e) => { e.target.disabled = true; e.target.textContent = 'making your prep…'; await makePrep(f.exam); draw(); });
    renderSpotify(el.querySelector('#spotify'), f.mode.playlist);
    paint(getTimer());
  };

  const paint = (t) => {
    const clock = el.querySelector('#clock');
    if (!clock) return;
    const total = t.total || getFocusState().mode.work * 60;
    const rem = t.total ? t.remaining : total;
    clock.textContent = fmtClock(rem);
    const c = 2 * Math.PI * 132;
    const done = 1 - rem / total;
    el.querySelector('#prog').style.strokeDashoffset = String(c * (1 - done));
    el.querySelector('#moon').style.transform = `rotate(${done * 360}deg)`;
    el.querySelector('#toggle').textContent = t.running ? 'pause' : 'start';
  };

  if (!timer.total) resetTimer();
  draw();
  let lastPhase = timer.phase;
  let lastRunning = timer.running;
  const offT = onTimer((t) => {
    if (t.phase !== lastPhase || t.running !== lastRunning) { lastPhase = t.phase; lastRunning = t.running; draw(); }
    else paint(t);
  });
  const offS = store.subscribe(draw);
  return () => { offT(); offS(); };
}
