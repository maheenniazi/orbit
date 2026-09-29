// Home: greeting, focus banner, up-next agenda, exam countdowns, quick add, notes, soundtrack.
import { store, addEvents, courseColor, getCourse } from './store.js';
import { esc, todayISO, addDays, fmtDate, fmtTime, relDay, daysUntil, TYPE_META, EXAM_TYPES } from './util.js';
import { toast } from './ui.js';
import { getFocusState, syncStudyPlans } from './focus.js';
import { parseQuick } from './syllabus.js';
import { openEventModal } from './calendar.js';
import { renderSpotify } from './spotify.js';

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'Up late' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export function render(el) {
  const draw = () => {
    const s = store.get();
    const today = todayISO();
    const f = getFocusState();
    const week = s.events
      .filter((e) => e.date >= today && e.date <= addDays(today, 6) && e.type !== 'class')
      .sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
    const exams = s.events.filter((e) => EXAM_TYPES.includes(e.type) && e.date >= today).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 6);
    const notes = [...s.notes].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 4);
    const dueToday = week.filter((e) => e.date === today && !e.done).length;

    let agenda = '';
    let last = '';
    for (const e of week) {
      if (e.date !== last) { agenda += `<div class="day-label">${relDay(e.date)} · ${fmtDate(e.date, { month: 'short', day: 'numeric' })}</div>`; last = e.date; }
      agenda += `<div class="ev ${e.done ? 'done' : ''}" data-ev="${e.id}" style="--c:${courseColor(e.courseId)}">
        <input type="checkbox" data-done="${e.id}" ${e.done ? 'checked' : ''}><span class="bar"></span>
        <div><div class="t">${TYPE_META[e.type]?.emoji || ''} ${esc(e.title)}</div><div class="s">${esc(getCourse(e.courseId)?.code || getCourse(e.courseId)?.name || TYPE_META[e.type]?.label)}${e.notes ? ' · ' + esc(e.notes) : ''}</div></div>
        <span class="when">${fmtTime(e.time)}</span></div>`;
    }

    el.innerHTML = `
      <div class="page-head view-enter">
        <div>
          <h1>${greeting()}${s.settings.name ? `, <em>${esc(s.settings.name)}</em>` : ''}.</h1>
          <p>${fmtDate(today, { weekday: 'long', month: 'long', day: 'numeric' })} · ${dueToday ? `${dueToday} thing${dueToday > 1 ? 's' : ''} on today` : 'Nothing due today'}</p>
        </div>
      </div>
      <div class="stack view-enter">
        <div class="card hero-focus">
          <div class="small muted" style="text-transform:uppercase;letter-spacing:.1em;font-weight:600">Focus mode${f.auto ? ' · auto' : ''}</div>
          <div class="mode"><em>${esc(f.mode.label)}</em>${f.exam ? ` · ${esc(f.exam.title)} ${f.days === 0 ? 'is today' : `in ${f.days} day${f.days === 1 ? '' : 's'}`}` : ''}</div>
          <p>${esc(f.mode.blurb)}</p>
          <div class="row"><a class="btn" href="#/focus">◉ Start a ${f.mode.work}-min session</a>${f.exam ? '' : '<a class="btn ghost" href="#/import">⇪ Import a syllabus</a>'}</div>
        </div>

        <div class="grid dash">
          <div class="stack">
            <div class="card">
              <h2>Up next <a class="small muted" href="#/calendar" style="text-transform:none;letter-spacing:0">Calendar →</a></h2>
              <div class="quick-add" style="margin-bottom:10px"><input id="qa" placeholder="Quick add: “bio quiz fri 2pm” or “essay due tomorrow”"><button class="btn sm" id="qa-go">Add</button></div>
              ${week.length ? `<div class="ev-list">${agenda}</div>` : s.events.length ? '<div class="empty">Clear week ahead ✦</div>' : `<div class="cta"><div class="big">🗓️</div><h3>Start with your syllabus</h3><p class="muted">Drop it in and every deadline shows up here on its own.</p><a class="btn" href="#/import">Import syllabus</a></div>`}
            </div>
          </div>
          <div class="stack">
            ${exams.length ? `<div class="card"><h2>Countdowns</h2><div class="countdowns">${exams.map((e) => `<div class="countdown" data-ev="${e.id}" style="--c:${courseColor(e.courseId)}"><div class="n">${daysUntil(e.date)}<small>days</small></div><div class="l">${esc(e.title)}</div><div class="small muted">${esc(getCourse(e.courseId)?.code || '')} · ${fmtDate(e.date, { month: 'short', day: 'numeric' })}</div></div>`).join('')}</div></div>` : ''}
            <div class="card"><h2>Soundtrack</h2><div id="spotify"></div></div>
            <div class="card">
              <h2>Recent notes <a class="small muted" href="#/notes" style="text-transform:none;letter-spacing:0">All →</a></h2>
              ${notes.length ? `<div class="ev-list">${notes.map((n) => `<a class="ev" href="#/notes" data-note="${n.id}" style="--c:${courseColor(n.courseId)};grid-template-columns:4px 1fr auto;text-decoration:none"><span class="bar"></span><div><div class="t">${esc(n.title)}</div><div class="s">${esc(getCourse(n.courseId)?.name || 'General')}</div></div><span class="when">${fmtDate(new Date(n.updatedAt).toISOString().slice(0, 10), { month: 'short', day: 'numeric' })}</span></a>`).join('')}</div>` : '<div class="empty">Generate notes from any lecture ✎ <br><a class="btn ghost sm" href="#/notes" style="margin-top:10px">Open notes</a></div>'}
            </div>
          </div>
        </div>
      </div>`;

    el.querySelectorAll('[data-ev]').forEach((r) => (r.onclick = (ev) => {
      if (ev.target.matches('input')) return;
      openEventModal(store.get().events.find((x) => x.id === r.dataset.ev));
    }));
    el.querySelectorAll('[data-done]').forEach((c) => (c.onchange = () =>
      store.update((st) => { const e = st.events.find((x) => x.id === c.dataset.done); if (e) e.done = c.checked; })));
    const qa = () => {
      const v = el.querySelector('#qa').value.trim();
      if (!v) return;
      const e = parseQuick(v);
      addEvents([{ ...e, source: 'manual' }]);
      if (EXAM_TYPES.includes(e.type)) syncStudyPlans();
      toast(`Added “${e.title}” · ${relDay(e.date)}${e.time ? ' ' + fmtTime(e.time) : ''}`);
    };
    el.querySelector('#qa-go').onclick = qa;
    el.querySelector('#qa').onkeydown = (e) => e.key === 'Enter' && qa();
    renderSpotify(el.querySelector('#spotify'), f.mode.playlist);
  };
  draw();
  return store.subscribe(draw);
}
