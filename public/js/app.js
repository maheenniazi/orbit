// App shell: routing, theme, focus-mode palette, sidebar widgets.
import { store } from './store.js';
import { loadStatus } from './ai.js';
import { APP_NAME, esc } from './util.js';
import { getFocusState, syncStudyPlans, onTimer, getTimer, fmtClock } from './focus.js';
import { handleCallback, loadDock } from './spotify.js';
import * as dashboard from './dashboard.js';
import * as calendar from './calendar.js';
import * as syllabus from './syllabus.js';
import * as notes from './notes.js';
import * as chat from './chat.js';
import * as focus from './focus.js';
import * as settings from './settings.js';
import * as careers from './careers.js';
import * as degree from './degree.js';
import { autoPrep } from './examprep.js';

const routes = { dashboard, calendar, import: syllabus, notes, chat, focus, degree, careers, settings };
const viewEl = document.getElementById('view');
let cleanup = null;

function route() {
  const name = (location.hash.replace(/^#\/?/, '').split('/')[0] || 'dashboard');
  const mod = routes[name] || dashboard;
  if (typeof cleanup === 'function') cleanup();
  viewEl.innerHTML = '';
  if (name !== 'focus') document.body.classList.remove('zen');
  cleanup = mod.render(viewEl);
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.route === name));
  window.scrollTo(0, 0);
}

let lastFocusKey = null;
function applyChrome() {
  const s = store.get();
  const f = getFocusState();
  document.documentElement.dataset.theme = s.settings.theme;
  document.body.dataset.focus = f.mode.key;
  document.getElementById('focus-pill').innerHTML =
    `<small>phase</small><b>${esc(f.mode.label)}</b>${f.exam ? `<small>${esc(f.exam.title)} · ${f.days === 0 ? 'today' : `${f.days}d`}</small>` : ''}`;
  // When the mode escalates, switch the soundtrack to match.
  if (f.mode.key !== lastFocusKey) {
    lastFocusKey = f.mode.key;
    loadDock(s.settings.playlists[f.mode.playlist]?.id);
  }
}

function paintMiniTimer(t) {
  const el = document.getElementById('mini-timer');
  const active = t.running || (t.total && t.remaining < t.total);
  el.hidden = !active || location.hash.startsWith('#/focus');
  if (!el.hidden) el.innerHTML = `${t.phase === 'work' ? 'focus' : 'break'} · ${fmtClock(t.remaining)}${t.running ? '' : ' · paused'}`;
  document.title = t.running ? `${fmtClock(t.remaining)} · ${APP_NAME}` : APP_NAME;
}

async function boot() {
  // Spotify rejects "localhost" redirect URIs, and data is stored per address,
  // so always use 127.0.0.1.
  if (location.hostname === 'localhost') {
    location.replace(location.href.replace('//localhost', '//127.0.0.1'));
    return;
  }
  document.getElementById('brand-name').textContent = APP_NAME;
  document.getElementById('mini-timer').onclick = () => (location.hash = '#/focus');
  await loadStatus();
  if (location.pathname === '/callback') await handleCallback();
  syncStudyPlans({ silent: true });
  applyChrome();
  store.subscribe(applyChrome);
  onTimer(paintMiniTimer);
  window.addEventListener('hashchange', () => { route(); paintMiniTimer(getTimer()); });
  // Re-evaluate focus mode at midnight / when returning to the tab
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { applyChrome(); autoPrep(); } });
  route();
  setTimeout(autoPrep, 1500); // build exam prep for exams coming up (after the page is ready)
  setInterval(autoPrep, 60 * 60 * 1000);
}

boot();
