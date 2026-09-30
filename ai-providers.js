// AI providers + model catalog (zero dependencies).
// Every provider with a key/CLI in .env is enabled at once; the browser picks a model per request.
// Model ids are "provider:modelId", e.g. "kiro:claude-opus-4.8", "gemini:gemini-2.5-pro".
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const env = process.env;
const KIRO_CLI = env.KIRO_CLI_PATH || 'kiro-cli';
const KIRO_DIR = path.join(__dirname, 'kiro-agent');
const KIRO_AGENT = env.KIRO_AGENT || 'study-os';
const MAX_PROMPT = 100_000; // stay under the OS argument-length limit
const LIST_TTL = 10 * 60 * 1000;

const BASE = {
  anthropic: (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, ''),
  openai: (env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''),
  gemini: (env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, ''),
};
const KEYS = { anthropic: env.ANTHROPIC_API_KEY || '', openai: env.OPENAI_API_KEY || '', gemini: env.GEMINI_API_KEY || env.GOOGLE_API_KEY || '' };

// Fallback default model per provider, used only when the model list can't be fetched.
const FALLBACK = { kiro: 'default', anthropic: 'claude-sonnet-4-5', openai: 'gpt-4o-mini', gemini: 'gemini-2.5-flash' };
const LABEL = { kiro: 'Kiro', anthropic: 'Anthropic', openai: 'OpenAI', gemini: 'Google Gemini' };

let kiroReady = null; // null = not probed yet
const enabled = () => {
  const list = [];
  const forced = (env.AI_PROVIDER || '').toLowerCase();
  if ((env.KIRO_API_KEY || forced === 'kiro') && kiroReady !== false) list.push('kiro');
  for (const p of ['anthropic', 'openai', 'gemini']) if (KEYS[p]) list.push(p);
  // AI_PROVIDER picks which provider's default comes first
  if (forced && list.includes(forced)) list.sort((a, b) => (a === forced ? -1 : b === forced ? 1 : 0));
  return list;
};

const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g, '');
const run = (cmd, args, opts = {}) => new Promise((resolve, reject) =>
  execFile(cmd, args, { env, timeout: 180_000, maxBuffer: 10 * 1024 * 1024, windowsHide: true, ...opts }, (err, stdout, stderr) => {
    if (err) { err.stdout = stdout; err.stderr = stderr; reject(err); } else resolve(stdout.toString());
  }));

function prettify(id) {
  if (id === 'default') return 'Kiro default';
  if (id === 'auto') return 'Auto';
  return id
    .replace(/^models\//, '')
    .replace(/-(\d{8}|\d{4}-\d{2}-\d{2}|latest)$/, '')
    .split(/[-_]/)
    .map((w) => (/^o\d$/i.test(w) ? w.toLowerCase() : /^(gpt|glm|ai|ml)$/i.test(w) ? w.toUpperCase() : /^\d/.test(w) ? w : w[0].toUpperCase() + w.slice(1)))
    .join(' ')
    .replace(/(\d) (\d)(?=\b)/g, '$1.$2') // "4 5" → "4.5" (Anthropic ids use dashes)
    .replace(/^GPT /, 'GPT-');
}

// ---------------- Model lists ----------------
async function getJSON(url, headers) {
  const r = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error?.message || `HTTP ${r.status}`);
  return d;
}

// `kiro-cli chat --list-models --format json`: the output shape isn't documented, so accept any
// reasonable JSON (array of strings/objects, or an object wrapping one) and fall back to plain text.
function parseKiroModels(out) {
  const text = stripAnsi(out).trim();
  const idOf = (x) => (typeof x === 'string' ? x : x?.id || x?.model_id || x?.modelId || x?.model || x?.name);
  const nameOf = (x) => (typeof x === 'object' && (x.display_name || x.displayName || x.label || (x.name !== idOf(x) && x.name))) || '';
  const findArray = (v, depth = 0) => {
    if (Array.isArray(v)) return v;
    if (v && typeof v === 'object' && depth < 3) {
      for (const k of ['models', 'data', 'items', 'availableModels', 'available_models']) if (Array.isArray(v[k])) return v[k];
      for (const val of Object.values(v)) { const a = findArray(val, depth + 1); if (a) return a; }
    }
    return null;
  };
  let json = null;
  try { json = JSON.parse(text); } catch {
    const m = text.match(/[[{][\s\S]*[\]}]/);
    if (m) try { json = JSON.parse(m[0]); } catch { /* not JSON */ }
  }
  const arr = json && findArray(json);
  if (arr) {
    return arr.map((x) => ({ id: String(idOf(x) || ''), name: String(nameOf(x) || '') })).filter((m) => /^[\w.:/-]{2,80}$/.test(m.id));
  }
  // Plain text: one model per line, e.g. "* claude-opus-4.8  (current)" or "claude-sonnet-4.5 - Claude Sonnet 4.5"
  const out2 = [];
  for (const line of text.split('\n')) {
    const m = line.match(/^\s*(?:[-*•>]|\d+[.)])?\s*([a-z][\w.-]*\d[\w.-]*|auto)\b/i);
    if (m && !/^(available|models?|name|id)$/i.test(m[1])) out2.push({ id: m[1], name: '' });
  }
  return out2;
}

const listers = {
  async kiro() {
    let models = [];
    try {
      models = parseKiroModels(await run(KIRO_CLI, ['chat', '--list-models', '--format', 'json'], { timeout: 30_000, cwd: KIRO_DIR }));
    } catch {
      models = parseKiroModels(await run(KIRO_CLI, ['chat', '--list-models'], { timeout: 30_000, cwd: KIRO_DIR }));
    }
    return [{ id: 'default', name: 'Kiro default' }, ...models.filter((m) => m.id !== 'default')];
  },
  async anthropic() {
    const d = await getJSON(`${BASE.anthropic}/v1/models?limit=1000`, { 'x-api-key': KEYS.anthropic, 'anthropic-version': '2023-06-01' });
    return (d.data || []).map((m) => ({ id: m.id, name: m.display_name || '' }));
  },
  async openai() {
    const d = await getJSON(`${BASE.openai}/models`, { authorization: `Bearer ${KEYS.openai}` });
    const notChat = /audio|realtime|transcribe|tts|image|embed|search|moderation|instruct|codex|dall|whisper|davinci|babbage|rerank/i;
    const official = /^https:\/\/api\.openai\.com/.test(BASE.openai);
    // Official API: only GPT/o-series chat models. Custom base URLs (OpenRouter, Ollama…) keep any chat-capable model.
    const models = (d.data || []).filter((m) => !notChat.test(m.id) && (!official || /^(gpt|o\d|chatgpt)/i.test(m.id)));
    return models.sort((a, b) => (b.created || 0) - (a.created || 0)).map((m) => ({ id: m.id, name: '' }));
  },
  async gemini() {
    const d = await getJSON(`${BASE.gemini}/models?pageSize=1000`, { 'x-goog-api-key': KEYS.gemini });
    return (d.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent') && /gemini|gemma/i.test(m.name) && !/embedding|image|tts|live|aqa|vision|native-audio/i.test(m.name))
      .map((m) => ({ id: m.name.replace(/^models\//, ''), name: m.displayName || '' }));
  },
};

const listCache = new Map();
async function listProvider(p) {
  const hit = listCache.get(p);
  if (hit && Date.now() - hit.at < LIST_TTL) return hit;
  try {
    const entry = { at: Date.now(), models: await listers[p](), error: null };
    if (!entry.models.length) throw new Error('no models returned');
    listCache.set(p, entry);
    return entry;
  } catch (e) {
    const msg = e.code === 'ENOENT' ? 'Kiro CLI not found' : stripAnsi(e.stderr || e.message || '').trim().split('\n').pop().slice(0, 160);
    // Keep the provider usable with its default model even if listing fails
    return { at: Date.now(), models: hit?.models || [{ id: FALLBACK[p], name: '' }], error: msg || 'couldn’t load models' };
  }
}

async function catalog({ refresh = false } = {}) {
  if (refresh) listCache.clear();
  const providers = enabled();
  const results = await Promise.all(providers.map(async (p) => [p, await listProvider(p)]));
  const models = [];
  const errors = {};
  for (const [p, r] of results) {
    if (r.error) errors[p] = r.error;
    for (const m of r.models) models.push({ id: `${p}:${m.id}`, provider: p, providerLabel: LABEL[p], model: m.id, label: m.name || prettify(m.id) });
  }
  return { models, errors, default: defaultModel(models) };
}

function defaultModel(models = []) {
  const want = env.AI_MODEL;
  if (want) {
    const hit = models.find((m) => m.id === want || m.model === want);
    if (hit) return hit.id;
  }
  const first = enabled()[0];
  if (!first) return null;
  return models.find((m) => m.provider === first)?.id || `${first}:${FALLBACK[first]}`;
}

// ---------------- Calling a model ----------------
function resolve(modelId) {
  const providers = enabled();
  if (!providers.length) throw Object.assign(new Error('AI not configured. Add KIRO_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY or GEMINI_API_KEY to .env'), { status: 503 });
  let [p, ...rest] = String(modelId || '').split(':');
  let model = rest.join(':');
  if (!providers.includes(p)) {
    // Unknown/removed choice: fall back to the default provider
    p = providers[0];
    model = env.AI_MODEL && !env.AI_MODEL.includes(':') ? env.AI_MODEL : env.AI_MODEL?.startsWith(p + ':') ? env.AI_MODEL.slice(p.length + 1) : FALLBACK[p];
  }
  return { provider: p, model: model || FALLBACK[p] };
}

async function callAI({ system = '', messages = [], maxTokens = 2048, model: modelId }) {
  const clean = messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content)
    .map((m) => ({ role: m.role, content: String(m.content) }));
  if (!clean.length) throw new Error('No messages');
  const { provider, model } = resolve(modelId);
  const text = await callers[provider]({ system, messages: clean, maxTokens, model });
  return { text, model: `${provider}:${model}` };
}

async function postJSON(url, headers, body, label) {
  const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(180_000) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d?.error?.message || `${label} error ${r.status}`);
  return d;
}

const callers = {
  async anthropic({ system, messages, maxTokens, model }) {
    const d = await postJSON(`${BASE.anthropic}/v1/messages`, { 'x-api-key': KEYS.anthropic, 'anthropic-version': '2023-06-01' }, { model, max_tokens: maxTokens, system, messages }, 'Anthropic');
    return (d.content || []).map((b) => b.text || '').join('');
  },
  async openai({ system, messages, maxTokens, model }) {
    const official = /^https:\/\/api\.openai\.com/.test(BASE.openai);
    const body = { model, messages: [{ role: 'system', content: system }, ...messages] };
    // Newer OpenAI models only accept max_completion_tokens (and reasoning models use some for thinking)
    if (official) body.max_completion_tokens = Math.max(maxTokens, /^(o\d|gpt-5)/.test(model) ? 8000 : 0);
    else body.max_tokens = maxTokens;
    const d = await postJSON(`${BASE.openai}/chat/completions`, { authorization: `Bearer ${KEYS.openai}` }, body, 'OpenAI');
    return d.choices?.[0]?.message?.content || '';
  },
  async gemini({ system, messages, maxTokens, model }) {
    const d = await postJSON(`${BASE.gemini}/models/${encodeURIComponent(model)}:generateContent`, { 'x-goog-api-key': KEYS.gemini }, {
      systemInstruction: { parts: [{ text: system }] },
      contents: messages.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
      generationConfig: { maxOutputTokens: Math.max(maxTokens, /pro|thinking|2\.5|3/.test(model) ? 8192 : 0) },
    }, 'Gemini');
    const cand = d.candidates?.[0];
    const text = (cand?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
    if (!text && cand?.finishReason && cand.finishReason !== 'STOP') throw new Error(`Gemini stopped early (${cand.finishReason.toLowerCase()})`);
    if (!text && d.promptFeedback?.blockReason) throw new Error(`Gemini blocked the request (${d.promptFeedback.blockReason.toLowerCase()})`);
    return text;
  },
  async kiro({ system, messages, model }) {
    const agent = kiroAgentFor(model);
    try {
      const out = await run(KIRO_CLI, ['chat', '--no-interactive', '--agent', agent, flattenPrompt(system, messages)], { cwd: KIRO_DIR });
      const text = cleanKiroOutput(out);
      if (!text) throw new Error('Kiro returned an empty response');
      return text;
    } catch (err) {
      if (err.code === 'ENOENT') throw new Error('Kiro CLI not found. Install it (https://kiro.dev/cli) or set KIRO_CLI_PATH.');
      if (err.killed) throw new Error('Kiro took too long to respond (3 min timeout).');
      if (!err.stderr && !err.stdout) throw err;
      const msg = cleanKiroOutput(err.stderr || err.stdout || '').split('\n').slice(-3).join(' ');
      throw new Error(`Kiro CLI error: ${msg || err.message}`);
    }
  },
};

// Kiro CLI has no per-run --model flag, but an agent can pin a model (documented `model` field).
// So each chosen model gets its own text-only copy of the study-os agent (no tools, no MCP).
function kiroAgentFor(model) {
  if (!model || model === 'default') return KIRO_AGENT;
  const slug = model.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
  const name = `${KIRO_AGENT}-m-${slug}`;
  const dir = path.join(KIRO_DIR, '.kiro', 'agents');
  const file = path.join(dir, `${name}.json`);
  const base = JSON.parse(fs.readFileSync(path.join(dir, `${KIRO_AGENT}.json`), 'utf8'));
  const cfg = JSON.stringify({ ...base, name, model, tools: [], allowedTools: [], mcpServers: {} }, null, 2);
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== cfg) fs.writeFileSync(file, cfg);
  return name;
}

function cleanKiroOutput(out) {
  const lines = stripAnsi(out).replace(/\r/g, '').split('\n');
  const kept = lines.filter((l) => !/^\s*[▸•]?\s*(Credits|Time|Tokens?|Model|Agent)\s*:/i.test(l) && !/falling back to (the )?default model/i.test(l));
  return kept.join('\n').replace(/^\s*>\s?/, '').trim();
}

function flattenPrompt(system, messages) {
  const convo = messages.map((m) => `${m.role === 'user' ? 'Student' : 'Assistant'}: ${m.content}`).join('\n\n');
  const prompt = `${system}\n\n# Conversation\n${convo}\n\nReply as the Assistant to the student's last message. Output only the reply itself: no preamble, and do not use any tools.`;
  return prompt.length > MAX_PROMPT ? prompt.slice(0, MAX_PROMPT) + '\n\n[input truncated]' : prompt;
}

function probeKiro() {
  if (!(env.KIRO_API_KEY || (env.AI_PROVIDER || '').toLowerCase() === 'kiro')) return;
  execFile(KIRO_CLI, ['--version'], { timeout: 15_000, windowsHide: true }, (err, out) => {
    kiroReady = !err;
    console.log(kiroReady ? `  Kiro CLI: ${stripAnsi(out).trim()}` : `  ⚠ Kiro CLI not found at "${KIRO_CLI}". Install it or set KIRO_CLI_PATH`);
  });
}

module.exports = { enabled, catalog, callAI, probeKiro, defaultModel, parseKiroModels, prettify, LABEL };
