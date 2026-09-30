// Client for the server AI proxy + the model you picked (shared by chat, notes, syllabus and careers).
let status = { ai: false, providers: [], provider: null, spotifyClientId: null };
let catalog = { models: [], errors: {}, default: null };
let catalogLoaded = null;
const MODEL_KEY = 'studyos:model';
const subs = new Set();

export async function loadStatus() {
  try {
    status = await (await fetch('/api/status')).json();
  } catch {
    /* offline */
  }
  return status;
}
export const getStatus = () => status;
export const aiEnabled = () => status.ai;

export function loadModels({ refresh = false } = {}) {
  if (!status.ai) return Promise.resolve(catalog);
  if (catalogLoaded && !refresh) return catalogLoaded;
  catalogLoaded = fetch('/api/models' + (refresh ? '?refresh=1' : ''))
    .then((r) => r.json())
    .then((d) => { catalog = { models: d.models || [], errors: d.errors || {}, default: d.default }; subs.forEach((f) => f()); return catalog; })
    .catch(() => catalog);
  return catalogLoaded;
}
export const getCatalog = () => catalog;
export const onModelChange = (fn) => (subs.add(fn), () => subs.delete(fn));

// The saved choice, if it's still available; otherwise the server default.
export function getModel() {
  const saved = localStorage.getItem(MODEL_KEY);
  if (saved && (!catalog.models.length || catalog.models.some((m) => m.id === saved))) return saved;
  return catalog.default || saved || null;
}
export function setModel(id) {
  localStorage.setItem(MODEL_KEY, id);
  subs.forEach((f) => f());
}
export function modelInfo(id = getModel()) {
  const m = catalog.models.find((x) => x.id === id);
  if (m) return m;
  if (!id) return { id: null, label: 'AI', providerLabel: '' };
  const [provider, ...rest] = id.split(':');
  return { id, provider, model: rest.join(':'), label: rest.join(':') || provider, providerLabel: provider };
}

export async function ask({ system, messages, maxTokens, model }) {
  const r = await fetch('/api/ai', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ system, messages, maxTokens, model: model || getModel() }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `AI request failed (${r.status})`);
  lastModel = data.model || null;
  return data.text;
}
let lastModel = null;
export const lastUsedModel = () => lastModel;
