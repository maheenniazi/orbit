// Home: editorial cover + orbit map (today = sun, deadlines = planets), agenda, polaroid countdowns.
import { store, addEvents, courseColor, getCourse } from './store.js';
import { esc, todayISO, addDays, fmtDate, fmtTime, relDay, daysUntil, TYPE_META, EXAM_TYPES } from './util.js';
import { toast } from './ui.js';
import { getFocusState, syncStudyPlans } from './focus.js';
import { parseQuick } from './syllabus.js';
import { openEventModal } from './calendar.js';
import { renderSpotify } from './spotify.js';

function greeting() {
  const h = new Date().getHours();
  return h < 5 ? 'up late' : h < 12 ? 'good morning' : h < 18 ? 'good afternoon' : 'good evening';
}

// Planets sit on rings by how far away they are: 0-7d, 8-14d, 15-30d.
function orbitMap(events) {
  const W = 520, H = 300, cx = 190, cy = 150;
  const rings = [{ rx: 92, ry: 58, max: 7, l: '7 days' }, { rx: 158, ry: 98, max: 14, l: '14 days' }, { rx: 222, ry: 136, max: 30, l: '30 days' }];
  const today = todayISO();
  const upcoming = events
    .filter((e) => e.date >= today && e.date <= addDays(today, 30) && !e.done && !['class', 'study', 'reading'].includes(e.type))
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(0, 9);
  const perRing = [0, 0, 0];
  const placed = upcoming.map((e) => {
    const d = daysUntil(e.date);
    const ri = d <= 7 ? 0 : d <= 14 ? 1 : 2;
    const k = perRing[ri]++;
    // Each ring gets its own arc so labels on different rings don't pile up.
    const start = [-70, 25, 140][ri];
    const step = [95, 70, 62][ri];
    const ang = (start + k * step) * (Math.PI / 180);
    const r = rings[ri];
    const x = cx + r.rx * Math.cos(ang);
    return { e, d, x, y: cy + r.ry * Math.sin(ang), big: EXAM_TYPES.includes(e.type), left: x > W - 150 };
  });
  return `<svg class="orbit-map" viewBox="0 0 ${W} ${H}" role="img" aria-label="Upcoming deadlines in orbit around today">
    ${rings.map((r, i) => `<ellipse class="ring ${i === 1 ? 'dash' : ''}" cx="${cx}" cy="${cy}" rx="${r.rx}" ry="${r.ry}"/><text class="rlabel" x="${cx + r.rx * 0.72}" y="${cy - r.ry * 0.72 - 4}">${r.l}</text>`).join('')}
    <g class="spin" style="--cx:${cx}px;--cy:${cy}px"><circle cx="${cx + 222}" cy="${cy}" r="2" fill="currentColor" opacity=".35"/><circle cx="${cx - 158}" cy="${cy + 10}" r="1.6" fill="currentColor" opacity=".35"/></g>
    <circle class="sun" cx="${cx}" cy="${cy}" r="28"/>
    <text class="sunlabel" x="${cx}" y="${cy + 5}" text-anchor="middle">today</text>
    ${placed.map((p) => `<g class="pl" data-ev="${p.e.id}">
        <circle class="planet" cx="${p.x}" cy="${p.y}" r="${p.big ? 10 : 6}" fill="${courseColor(p.e.courseId)}"/>
        ${p.big ? `<ellipse cx="${p.x}" cy="${p.y}" rx="17" ry="5" fill="none" stroke="${courseColor(p.e.courseId)}" stroke-width="1.2" transform="rotate(-18 ${p.x} ${p.y})"/>` : ''}
        <text class="plabel" x="${p.left ? p.x - 15 : p.x + 15}" y="${p.y - 3}" text-anchor="${p.left ? 'end' : 'start'}">${esc(p.e.title.length > 20 ? p.e.title.slice(0, 19) + '…' : p.e.title)}</text>
        <text class="pdays" x="${p.left ? p.x - 15 : p.x + 15}" y="${p.y + 12}" text-anchor="${p.left ? 'end' : 'start'}">${p.d === 0 ? 'today' : p.d === 1 ? 'tomorrow' : `in ${p.d} days`}</text>
      </g>`).join('')}
    ${placed.length ? '' : `<text class="pdays" x="${cx + 60}" y="${cy + 120}">nothing in orbit yet</text>`}
  </svg>`;
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
      if (e.date !== last) { agenda += `<div class="day-label">${relDay(e.date).toLowerCase()} · ${fmtDate(e.date, { month: 'short', day: 'numeric' })}</div>`; last = e.date; }
      agenda += `<div class="ev ${e.done ? 'done' : ''}" data-ev="${e.id}" style="--c:${courseColor(e.courseId)}">
        <input type="checkbox" data-done="${e.id}" ${e.done ? 'checked' : ''}><span class="bar"></span>
        <div><div class="t">${esc(e.title)}<span class="kind">${TYPE_META[e.type]?.label || ''}</span></div><div class="s">${esc(getCourse(e.courseId)?.code || getCourse(e.courseId)?.name || '')}${e.notes ? ' · ' + esc(e.notes) : ''}</div></div>
        <span class="when">${fmtTime(e.time)}</span></div>`;
    }

    const cover = `<div class="card cover">
          <div>
            <div class="label small muted">current phase${f.auto ? ' · automatic' : ''}</div>
            <div class="mode"><em>${esc(f.mode.label)}</em>${f.exam ? `<br>${esc(f.exam.title)} ${f.days === 0 ? 'is today' : `in ${f.days} day${f.days === 1 ? '' : 's'}`}` : ''}</div>
            <p>${esc(f.mode.blurb)}</p>
            <div class="row"><a class="btn" href="#/focus">start a ${f.mode.work}-min session</a>${f.exam ? '' : '<a class="btn ghost" href="#/import">import a syllabus</a>'}</div>
          </div>
          ${orbitMap(s.events)}
        </div>`;
    const weekCard = `<div class="card">
              <h2>this week <a href="#/calendar">view calendar</a></h2>
              ${week.length ? `<div class="ev-list">${agenda}</div>` : s.events.length ? '<div class="empty"><span class="big">clear skies.</span>nothing due this week</div>' : `<div class="cta"><div class="big">hi.</div><h3>start with your syllabus</h3><p class="muted">drop it in and every deadline shows up here on its own.</p><a class="btn" href="#/import">import syllabus</a></div>`}
            </div>`;
    const countdownsCard = exams.length ? `<div class="card taped"><h2>countdowns</h2><div class="countdowns">${exams.map((e) => `<div class="countdown" data-ev="${e.id}" style="--c:${courseColor(e.courseId)}"><div class="pic">${daysUntil(e.date)}<small>days</small></div><div class="l">${esc(e.title)}</div><div class="sub">${esc(getCourse(e.courseId)?.code || '')} · ${fmtDate(e.date, { month: 'short', day: 'numeric' })}</div></div>`).join('')}</div></div>` : '';
    const soundCard = `<div class="card"><h2>soundtrack</h2><div id="spotify"></div></div>`;
    const notesCard = `<div class="card">
              <h2>recent notes <a href="#/notes">view all</a></h2>
              ${notes.length ? `<div class="ev-list">${notes.map((n) => `<a class="ev" href="#/notes" data-note="${n.id}" style="--c:${courseColor(n.courseId)};grid-template-columns:8px 1fr auto;text-decoration:none"><span class="bar"></span><div><div class="t" style="font-family:var(--serif);font-size:18px">${esc(n.title)}</div><div class="s">${esc(getCourse(n.courseId)?.name || 'general')}</div></div><span class="when">${fmtDate(new Date(n.updatedAt).toISOString().slice(0, 10), { month: 'short', day: 'numeric' }).toLowerCase()}</span></a>`).join('')}</div>` : '<div class="empty">turn any lecture into notes<br><a class="btn ghost sm" href="#/notes" style="margin-top:12px">open notes</a></div>'}
            </div>`;

    el.innerHTML = `
      <div class="page-head view-enter">
        <div>
          <div class="kicker">${fmtDate(today, { weekday: 'long', month: 'long', day: 'numeric' }).toLowerCase()} · ${dueToday ? `${dueToday} thing${dueToday > 1 ? 's' : ''} due today` : 'nothing due today'}</div>
          <h1>${greeting()}${s.settings.name ? `, <em>${esc(s.settings.name.toLowerCase())}</em>` : ''}.</h1>
        </div>
        <div class="row" style="gap:10px;justify-content:flex-end"><div class="quick-add" style="min-width:min(320px,100%)"><input id="qa" placeholder="add something… “bio quiz fri 2pm”"><button class="btn" id="qa-go">add</button></div><button class="btn ghost sm" id="customize">${editing ? 'done' : 'customize'}</button></div>
      </div>

      <div class="view-enter" id="home-layout">${layoutHTML({ cover, week: weekCard, countdowns: countdownsCard, soundtrack: soundCard, notes: notesCard })}</div>`;

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
      toast(`added “${e.title}” · ${relDay(e.date).toLowerCase()}${e.time ? ' ' + fmtTime(e.time) : ''}`);
    };
    el.querySelector('#qa-go').onclick = qa;
    el.querySelector('#qa').onkeydown = (e) => { if (e.key === 'Enter') qa(); };
    const sp = el.querySelector('#spotify');
    if (sp) renderSpotify(sp, f.mode.playlist);
    el.querySelectorAll('[data-note]').forEach((a) => (a.onclick = () => sessionStorage.setItem('studyos:open-note', a.dataset.note)));
    el.querySelector('#customize').onclick = () => { editing = !editing; draw(); };
    wireLayout(el, draw);
  };
  draw();
  return store.subscribe(draw);
}

// ---------------- movable home layout ----------------
// Zones: top (full width), left (wide column), right (column). Each widget is full or half width within its zone.
const WIDGETS = { cover: 'focus + orbit map', week: 'this week', countdowns: 'countdowns', soundtrack: 'soundtrack', notes: 'recent notes' };
const DEFAULT_LAYOUT = { top: [{ id: 'cover' }], left: [{ id: 'week' }], right: [{ id: 'countdowns' }, { id: 'soundtrack', half: true }, { id: 'notes', half: true }], hidden: [] };
let editing = false;

export function getLayout() {
  const saved = store.get().settings.home;
  const L = saved ? JSON.parse(JSON.stringify(saved)) : JSON.parse(JSON.stringify(DEFAULT_LAYOUT));
  for (const z of ['top', 'left', 'right']) L[z] = (L[z] || []).filter((w) => WIDGETS[w.id]);
  L.hidden = (L.hidden || []).filter((id) => WIDGETS[id]);
  const placed = new Set([...L.top, ...L.left, ...L.right].map((w) => w.id).concat(L.hidden));
  for (const id of Object.keys(WIDGETS)) if (!placed.has(id)) L.right.push({ id }); // new widgets appear on the right
  return L;
}
const saveLayout = (L) => store.update((s) => (s.settings.home = L));

function layoutHTML(cards) {
  const L = getLayout();
  const zone = (z) => `<div class="hz hz-${z} ${editing ? 'editing' : ''}" data-zone="${z}">${L[z].map((w, i) => {
    const html = cards[w.id];
    if (!html && !editing) return '';
    return `<div class="hw ${w.half ? 'half' : ''}" data-w="${w.id}" ${editing ? 'draggable="true"' : ''}>
      ${editing ? `<div class="hw-bar"><span class="hw-grip" aria-hidden="true"></span><b>${WIDGETS[w.id]}</b>
        <span class="hw-btns">
          <button data-act="up" title="move up" ${i === 0 ? 'disabled' : ''}>↑</button><button data-act="down" title="move down" ${i === L[z].length - 1 ? 'disabled' : ''}>↓</button>
          <button data-act="left" title="move to the left column" ${z === 'left' ? 'disabled' : ''}>←</button><button data-act="right" title="move to the right column" ${z === 'right' ? 'disabled' : ''}>→</button>
          <button data-act="top" title="move to the top, full width" ${z === 'top' ? 'disabled' : ''}>⤒</button>
          <button data-act="size">${w.half ? 'full width' : 'half width'}</button><button data-act="hide">hide</button>
        </span></div>` : ''}
      ${html || `<div class="card empty small">${WIDGETS[w.id]} shows up when there’s something to show</div>`}
    </div>`;
  }).join('')}${editing ? '<div class="hz-drop">drop here</div>' : ''}</div>`;
  return `${editing ? `<div class="edit-banner small">drag cards by their bar to move them, or use the buttons. ${L.hidden.length ? `hidden: ${L.hidden.map((id) => `<button class="link-btn" data-show="${id}">+ ${WIDGETS[id]}</button>`).join(' ')}` : ''} <button class="link-btn" id="reset-layout">reset layout</button></div>` : ''}
    ${zone('top')}
    <div class="grid dash home-cols">${zone('left')}${zone('right')}</div>`;
}

function wireLayout(el, draw) {
  if (!editing) return;
  const find = (L, id) => { for (const z of ['top', 'left', 'right']) { const i = L[z].findIndex((w) => w.id === id); if (i >= 0) return [z, i]; } return [null, -1]; };
  const commit = (fn) => { const L = getLayout(); fn(L); saveLayout(L); draw(); };
  el.querySelectorAll('.hw [data-act]').forEach((b) => (b.onclick = () => {
    const id = b.closest('.hw').dataset.w;
    commit((L) => {
      const [z, i] = find(L, id);
      const w = L[z][i];
      const act = b.dataset.act;
      if (act === 'up' && i > 0) [L[z][i - 1], L[z][i]] = [L[z][i], L[z][i - 1]];
      if (act === 'down' && i < L[z].length - 1) [L[z][i + 1], L[z][i]] = [L[z][i], L[z][i + 1]];
      if (['left', 'right', 'top'].includes(act)) { L[z].splice(i, 1); L[act].push(act === 'top' ? { ...w, half: false } : w); }
      if (act === 'size') w.half = !w.half;
      if (act === 'hide') { L[z].splice(i, 1); L.hidden.push(id); }
    });
  }));
  el.querySelectorAll('[data-show]').forEach((b) => (b.onclick = () => commit((L) => { L.hidden = L.hidden.filter((x) => x !== b.dataset.show); L.right.unshift({ id: b.dataset.show, half: false }); })));
  el.querySelector('#reset-layout').onclick = () => { store.update((s) => delete s.settings.home); draw(); };

  // drag and drop
  let dragId = null;
  el.querySelectorAll('.hw[draggable]').forEach((w) => {
    w.addEventListener('dragstart', (e) => { dragId = w.dataset.w; w.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragId); });
    w.addEventListener('dragend', () => { w.classList.remove('dragging'); el.querySelectorAll('.drop-before,.drop-end').forEach((x) => x.classList.remove('drop-before', 'drop-end')); });
  });
  const targetIndex = (zoneEl, x, y) => {
    const items = [...zoneEl.querySelectorAll(':scope > .hw')].filter((w) => w.dataset.w !== dragId);
    for (let i = 0; i < items.length; i++) {
      const r = items[i].getBoundingClientRect();
      const half = items[i].classList.contains('half');
      if (y < r.top + r.height / 2 && (!half || x < r.right)) return { i, el: items[i] };
      if (half && y < r.bottom && x < r.left + r.width / 2) return { i, el: items[i] };
    }
    return { i: items.length, el: null };
  };
  el.querySelectorAll('.hz').forEach((zoneEl) => {
    zoneEl.addEventListener('dragover', (e) => {
      if (!dragId) return;
      e.preventDefault();
      el.querySelectorAll('.drop-before,.drop-end').forEach((x) => x.classList.remove('drop-before', 'drop-end'));
      const t = targetIndex(zoneEl, e.clientX, e.clientY);
      (t.el || zoneEl).classList.add(t.el ? 'drop-before' : 'drop-end');
    });
    zoneEl.addEventListener('drop', (e) => {
      e.preventDefault();
      if (!dragId) return;
      const z = zoneEl.dataset.zone;
      const { i } = targetIndex(zoneEl, e.clientX, e.clientY);
      const id = dragId;
      dragId = null;
      commit((L) => {
        const [fz, fi] = find(L, id);
        const [w] = L[fz].splice(fi, 1);
        L[z].splice(Math.min(i, L[z].length), 0, z === 'top' ? { ...w, half: false } : w);
      });
    });
  });
}
