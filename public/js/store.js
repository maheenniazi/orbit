// Local-first state persisted to localStorage, with pub/sub.
import { uid } from './util.js';

const KEY = 'studyos:v1';

// Earthy "vintage" palette: terracotta, sage, dusty navy, mustard, mauve, cocoa, teal, rose
export const COURSE_COLORS = ['#c0582f', '#6f7f4f', '#3f5a78', '#b98a2e', '#a0526b', '#7a5c45', '#4f7d74', '#c27c86'];
// Canadian employers with public job boards (verified slugs): Cohere, Ada, Faire (Waterloo/Toronto), U of T PEY co-op board
const CA_BOARDS = 'ashby:cohere, greenhouse:ada18, greenhouse:faire, greenhouse:uoft';
const OLD_BOARDS = 'greenhouse:figma, greenhouse:airbnb, lever:palantir, ashby:ramp';
const OLD_COLORS = ['#a78bfa', '#f472b6', '#60a5fa', '#34d399', '#fbbf24', '#fb7185', '#22d3ee', '#c084fc'];

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
  careers: {
    profile: { name: '', email: '', phone: '', location: '', links: '', school: '', degree: '', gradDate: '', gpa: '', workAuth: 'citizen', targetRoles: '', skills: '', locations: '', extra: '' },
    resume: '', // default resume, plain text/markdown
    saved: [], // {id, company, title, url, locations, terms, type, status, deadline, notes, savedAt}
    docs: [], // {id, kind, company, title, body, notes, jobUrl, createdAt}
    boards: CA_BOARDS,
    filters: null,
  },
  settings: {
    theme: 'light',
    orbitTheme: true,
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
    // One-time switch to the new paper theme for data saved before the orbit redesign
    if (raw.settings && !raw.settings.orbitTheme) Object.assign(raw.settings, { theme: 'light', orbitTheme: true });
    if (raw.careers?.boards === OLD_BOARDS) raw.careers.boards = CA_BOARDS;
    // Swap neon course colors from the old theme for the new palette
    (raw.courses || []).forEach((c) => {
      const i = OLD_COLORS.indexOf(c.color);
      if (i >= 0) c.color = COURSE_COLORS[i];
    });
    return {
      ...d,
      ...raw,
      settings: { ...d.settings, ...raw.settings, playlists: { ...d.settings.playlists, ...(raw.settings?.playlists || {}) } },
      careers: { ...d.careers, ...(raw.careers || {}), profile: { ...d.careers.profile, ...(raw.careers?.profile || {}) } },
    };
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
    state = { ...d, ...parsed, settings: { ...d.settings, ...parsed.settings }, careers: { ...d.careers, ...(parsed.careers || {}), profile: { ...d.careers.profile, ...(parsed.careers?.profile || {}) } } };
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
