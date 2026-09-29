// Calendar: month grid, day panel, event editor, course filters, .ics export.
import { store, addEvents, removeEvents, courseColor, getCourse, ensureCourse } from './store.js';
import { esc, toISO, todayISO, fromISO, addDays, MONTHS, WEEKDAYS, TYPE_META, fmtDate, fmtTime, EXAM_TYPES } from './util.js';
import { modal, toast } from './ui.js';
import { parseQuick } from './syllabus.js';
import { syncStudyPlans } from './focus.js';

export function openEventModal(evt = {}) {
  const isNew = !evt.id;
  const e = { title: '', type: 'assignment', date: todayISO(), time: '', notes: '', courseId: store.get().courses[0]?.id || '', done: false, ...evt };
  const courses = store.get().courses;
  modal(isNew ? 'New event' : 'Edit event', `
    <label class="field">Title<input id="e-title" value="${esc(e.title)}" placeholder="e.g. Problem Set 4"></label>
    <div class="row">
      <label class="field">Type<select id="e-type">${Object.entries(TYPE_META).map(([k, m]) => `<option value="${k}" ${k === e.type ? 'selected' : ''}>${m.emoji} ${m.label}</option>`).join('')}</select></label>
      <label class="field">Course<select id="e-course"><option value="">No course</option>${courses.map((c) => `<option value="${c.id}" ${c.id === e.courseId ? 'selected' : ''}>${esc(c.code || c.name)}</option>`).join('')}<option value="__new">+ New course…</option></select></label>
    </div>
    <div class="row">
      <label class="field">Date<input type="date" id="e-date" value="${e.date}"></label>
      <label class="field">Time<input type="time" id="e-time" value="${e.time || ''}"></label>
    </div>
    <label class="field">Notes<textarea id="e-notes" style="min-height:80px" placeholder="Chapters, room, weight…">${esc(e.notes || '')}</textarea></label>
    ${isNew ? '' : `<label class="check"><input type="checkbox" id="e-done" ${e.done ? 'checked' : ''}> Done</label>`}
    <div class="row spread" style="margin-top:6px">
      ${isNew ? '<span></span>' : '<button class="btn danger" id="e-del">Delete</button>'}
      <button class="btn" id="e-save">${isNew ? 'Add event' : 'Save'}</button>
    </div>`, {
    onMount(body, close) {
      const $ = (s) => body.querySelector(s);
      $('#e-title').focus();
      $('#e-course').onchange = (ev) => {
        if (ev.target.value !== '__new') return;
        const name = prompt('Course name or code (e.g. "BIO 150")');
        if (!name) return (ev.target.value = '');
        const id = ensureCourse(name, /\d/.test(name) ? name : '');
        ev.target.insertAdjacentHTML('afterbegin', `<option value="${id}">${esc(name)}</option>`);
        ev.target.value = id;
      };
      $('#e-save').onclick = () => {
        const data = {
          title: $('#e-title').value.trim() || 'Untitled',
          type: $('#e-type').value,
          courseId: $('#e-course').value === '__new' ? '' : $('#e-course').value,
          date: $('#e-date').value || todayISO(),
          time: $('#e-time').value,
          notes: $('#e-notes').value.trim(),
        };
        if (isNew) addEvents([{ ...data, source: 'manual' }]);
        else store.update((s) => Object.assign(s.events.find((x) => x.id === e.id), data, { done: $('#e-done').checked }));
        if (EXAM_TYPES.includes(data.type)) syncStudyPlans();
        close();
      };
      $('#e-del')?.addEventListener('click', () => {
        const snapshot = store.get().events.filter((x) => x.id === e.id || x.examId === e.id);
        removeEvents([e.id]);
        close();
        toast('Event deleted', { action: 'Undo', onAction: () => store.update((s) => s.events.push(...snapshot)) });
      });
    },
  });
}

function exportICS() {
  const s = store.get();
  const stamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  const escI = (t) => String(t).replace(/[\\;,]/g, (c) => '\\' + c).replace(/\n/g, '\\n');
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Study OS//EN', 'CALSCALE:GREGORIAN'];
  for (const e of s.events) {
    const d = e.date.replace(/-/g, '');
    const c = getCourse(e.courseId);
    lines.push('BEGIN:VEVENT', `UID:${e.id}@study-os`, `DTSTAMP:${stamp}`);
    if (e.time) {
      const t = e.time.replace(':', '') + '00';
      const [h, m] = e.time.split(':').map(Number);
      const end = `${String(Math.min(23, h + 1)).padStart(2, '0')}${String(m).padStart(2, '0')}00`;
      lines.push(`DTSTART:${d}T${t}`, `DTEND:${d}T${end}`);
    } else {
      lines.push(`DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${addDays(e.date, 1).replace(/-/g, '')}`);
    }
    lines.push(`SUMMARY:${escI((c ? `[${c.code || c.name}] ` : '') + e.title)}`);
    if (e.notes) lines.push(`DESCRIPTION:${escI(e.notes)}`);
    lines.push('END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([lines.join('\r\n')], { type: 'text/calendar' }));
  a.download = 'study-os.ics';
  a.click();
}

// Filters/cursor persist across navigation
const view = { cursor: null, selected: todayISO(), hidden: new Set(), hideStudy: false };

export function render(el) {
  if (!view.cursor) { const d = new Date(); view.cursor = new Date(d.getFullYear(), d.getMonth(), 1); }

  const draw = () => {
    const s = store.get();
    const y = view.cursor.getFullYear();
    const mo = view.cursor.getMonth();
    const start = new Date(y, mo, 1 - new Date(y, mo, 1).getDay());
    const today = todayISO();
    const visible = s.events.filter((e) => !view.hidden.has(e.courseId || 'none') && !(view.hideStudy && e.type === 'study'));
    const byDay = {};
    for (const e of visible) (byDay[e.date] ||= []).push(e);
    const rank = (e) => (EXAM_TYPES.includes(e.type) ? 0 : e.type === 'study' ? 3 : e.type === 'class' ? 2 : 1);
    Object.values(byDay).forEach((l) => l.sort((a, b) => rank(a) - rank(b) || (a.time || '').localeCompare(b.time || '')));

    let cells = '';
    for (let i = 0; i < 42; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
      const iso = toISO(d);
      const evs = byDay[iso] || [];
      cells += `<div class="cal-cell ${d.getMonth() !== mo ? 'other' : ''} ${iso === today ? 'today' : ''} ${iso === view.selected ? 'sel' : ''}" data-day="${iso}">
        <span class="num">${d.getDate()}</span>
        ${evs.slice(0, 3).map((e) => `<div class="cal-chip ${EXAM_TYPES.includes(e.type) ? 'exam' : ''} ${e.done ? 'done' : ''}" style="--c:${courseColor(e.courseId)}" data-ev="${e.id}" title="${esc(e.title)}">${TYPE_META[e.type]?.emoji || ''} ${esc(e.title)}</div>`).join('')}
        ${evs.length > 3 ? `<span class="cal-more">+${evs.length - 3} more</span>` : ''}
      </div>`;
    }

    const dayEvs = (byDay[view.selected] || []);
    el.innerHTML = `
      <div class="page-head">
        <div><h1>Calendar</h1><p>${s.events.length} events across ${s.courses.length} course${s.courses.length === 1 ? '' : 's'}</p></div>
        <div class="row">
          <button class="btn ghost sm" id="ics" title="Import into Google/Apple Calendar">⇩ Export .ics</button>
          <a class="btn ghost sm" href="#/import">⇪ Import syllabus</a>
          <button class="btn sm" id="new">+ New event</button>
        </div>
      </div>
      <div class="cal-layout">
        <div class="card">
          <div class="cal-head">
            <div class="row"><button class="icon-btn" id="prev">‹</button><span class="title">${MONTHS[mo]} <span class="faint">${y}</span></span><button class="icon-btn" id="next">›</button><button class="btn ghost sm" id="today">Today</button></div>
            <div class="filters">
              ${s.courses.map((c) => `<span class="chip ${view.hidden.has(c.id) ? '' : 'on'}" data-f="${c.id}"><span class="dot-c" style="background:${c.color}"></span>${esc(c.code || c.name)}</span>`).join('')}
              <span class="chip ${view.hideStudy ? '' : 'on'}" data-study>🧠 Study plan</span>
            </div>
          </div>
          <div class="cal-grid">${WEEKDAYS.map((d) => `<div class="cal-dow">${d}</div>`).join('')}${cells}</div>
        </div>
        <div class="card">
          <h3>${fmtDate(view.selected, { weekday: 'long', month: 'long', day: 'numeric' })}</h3>
          <div class="quick-add" style="margin-bottom:12px"><input id="qa" placeholder="Quick add: “lab report 5pm”"><button class="btn sm" id="qa-go">Add</button></div>
          ${dayEvs.length ? `<div class="ev-list">${dayEvs.map((e) => `
            <div class="ev ${e.done ? 'done' : ''}" data-ev="${e.id}" style="--c:${courseColor(e.courseId)}">
              <input type="checkbox" data-done="${e.id}" ${e.done ? 'checked' : ''}>
              <span class="bar"></span>
              <div><div class="t">${TYPE_META[e.type]?.emoji || ''} ${esc(e.title)}</div><div class="s">${esc(getCourse(e.courseId)?.code || getCourse(e.courseId)?.name || TYPE_META[e.type]?.label || '')}${e.notes ? ' · ' + esc(e.notes) : ''}</div></div>
              <span class="when">${fmtTime(e.time)}</span>
            </div>`).join('')}</div>` : '<div class="empty">Nothing planned. Enjoy it ✦</div>'}
        </div>
      </div>`;

    const $ = (q) => el.querySelector(q);
    $('#prev').onclick = () => { view.cursor = new Date(y, mo - 1, 1); draw(); };
    $('#next').onclick = () => { view.cursor = new Date(y, mo + 1, 1); draw(); };
    $('#today').onclick = () => { const d = new Date(); view.cursor = new Date(d.getFullYear(), d.getMonth(), 1); view.selected = todayISO(); draw(); };
    $('#new').onclick = () => openEventModal({ date: view.selected });
    $('#ics').onclick = exportICS;
    el.querySelectorAll('[data-day]').forEach((c) => {
      c.onclick = (ev) => {
        const chip = ev.target.closest('[data-ev]');
        if (chip) return openEventModal(s.events.find((x) => x.id === chip.dataset.ev));
        view.selected = c.dataset.day;
        draw();
      };
      c.ondblclick = () => openEventModal({ date: c.dataset.day });
    });
    el.querySelectorAll('.ev[data-ev]').forEach((r) => (r.onclick = (ev) => {
      if (ev.target.matches('input')) return;
      openEventModal(s.events.find((x) => x.id === r.dataset.ev));
    }));
    el.querySelectorAll('[data-done]').forEach((c) => (c.onchange = () =>
      store.update((st) => { const e = st.events.find((x) => x.id === c.dataset.done); if (e) e.done = c.checked; })));
    el.querySelectorAll('[data-f]').forEach((c) => (c.onclick = () => {
      const id = c.dataset.f;
      view.hidden.has(id) ? view.hidden.delete(id) : view.hidden.add(id);
      draw();
    }));
    $('[data-study]').onclick = () => { view.hideStudy = !view.hideStudy; draw(); };
    const qa = () => {
      const v = $('#qa').value.trim();
      if (!v) return;
      const parsed = parseQuick(v);
      // Quick add in the day panel defaults to the selected day unless a date was typed
      const typedDate = parsed.date !== todayISO() || /today/i.test(v);
      addEvents([{ ...parsed, date: typedDate ? parsed.date : view.selected, source: 'manual' }]);
      if (EXAM_TYPES.includes(parsed.type)) syncStudyPlans();
      toast(`Added “${parsed.title}”`);
    };
    $('#qa-go').onclick = qa;
    $('#qa').onkeydown = (e) => e.key === 'Enter' && qa();
  };

  draw();
  return store.subscribe(draw);
}
