// Local-first state persisted to localStorage, with pub/sub.
import { uid } from './util.js';

const KEY = 'studyos:v1';

export const COURSE_COLORS = ['#a78bfa', '#f472b6', '#60a5fa', '#34d399', '#fbbf24', '#fb7185', '#22d3ee', '#c084fc'];

export const DEFAULT_PLAYLISTS = {
  chill: { name: 'Lofi Beats', id: '37i9dQZF1DWWQRwui0ExPn' },
  rampup: { name: 'Deep Focus', id: '37i9dQZF1DWZeKCadgRdKQ' },
  lockin: { name: 'Brain Food', id: '37i9dQZF1DWXLeA8Omikj7' },
  examday: { name: 'Peaceful Piano', id: '37i9dQZF1DX4sWSpwq3LiO' },
};

const defaults = () => ({
  courses: [], // {id, name, code, color}
  events: [], // {id, title, courseId, type, date, time, notes, source, examId, done}
  notes: [], // {id, title, courseId, body, createdAt, updatedAt}
  chat: [], // {role, content, ts}
  focusLog: [], // {date, minutes}
  settings: {
    theme: 'dark',
    name: '',
    autoFocus: true,
    focusOverride: null, // null = automatic, or a mode key
    autoStudyPlan: true,
    playlists: DEFAULT_PLAYLISTS,
  },
});

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY));
    if (!raw) return defaults();
    const d = defaults();
    return { ...d, ...raw, settings: { ...d.settings, ...raw.settings, playlists: { ...d.settings.playlists, ...(raw.settings?.playlists || {}) } } };
  } catch {
    return defaults();
  }
}

let state = load();
const subs = new Set();

export const store = {
  get: () => state,
  update(mutator) {
    mutator(state);
    localStorage.setItem(KEY, JSON.stringify(state));
    subs.forEach((fn) => fn(state));
  },
  subscribe(fn) {
    subs.add(fn);
    return () => subs.delete(fn);
  },
  reset() {
    state = defaults();
    localStorage.setItem(KEY, JSON.stringify(state));
    subs.forEach((fn) => fn(state));
  },
  export: () => JSON.stringify(state, null, 2),
  import(json) {
    const d = defaults();
    const parsed = JSON.parse(json);
    state = { ...d, ...parsed, settings: { ...d.settings, ...parsed.settings } };
    localStorage.setItem(KEY, JSON.stringify(state));
    subs.forEach((fn) => fn(state));
  },
};

// ---- domain helpers ----
export function getCourse(id) {
  return state.courses.find((c) => c.id === id);
}

export function ensureCourse(name, code = '') {
  const key = (code || name || '').trim().toLowerCase();
  if (!key) return null;
  let c = state.courses.find(
    (x) => (x.code && x.code.toLowerCase() === key) || x.name.toLowerCase() === key || (code && x.code.toLowerCase() === code.toLowerCase())
  );
  if (c) return c.id;
  const id = uid();
  store.update((s) => {
    s.courses.push({ id, name: name || code, code: code || '', color: COURSE_COLORS[s.courses.length % COURSE_COLORS.length] });
  });
  return id;
}

export function courseColor(id) {
  return getCourse(id)?.color || 'var(--accent)';
}

export function addEvents(list) {
  const ids = [];
  store.update((s) => {
    for (const e of list) {
      const id = e.id || uid();
      ids.push(id);
      s.events.push({ id, title: 'Untitled', type: 'other', time: '', notes: '', source: 'manual', done: false, ...e });
    }
  });
  return ids;
}

export function removeEvents(ids) {
  const set = new Set(ids);
  store.update((s) => {
    s.events = s.events.filter((e) => !set.has(e.id) && !set.has(e.examId));
  });
}
