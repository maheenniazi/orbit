// Zero-dependency server: static files + AI proxy + config.
// Run: node server.js   (Node 18+ for global fetch)
const http = require('http');
const fs = require('fs');
const path = require('path');

// --- tiny .env loader ---
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC = path.join(__dirname, 'public');
const MAX_BODY = 8 * 1024 * 1024;

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || '';
const OPENAI_KEY = process.env.OPENAI_API_KEY || '';
const KIRO_CLI = process.env.KIRO_CLI_PATH || 'kiro-cli';
// Kiro runs through the official CLI in headless mode: either KIRO_API_KEY is set,
// or AI_PROVIDER=kiro and you've already run `kiro-cli login` on this machine.
let provider = (process.env.AI_PROVIDER || '').toLowerCase() ||
  (process.env.KIRO_API_KEY ? 'kiro' : ANTHROPIC_KEY ? 'anthropic' : OPENAI_KEY ? 'openai' : '');
if (!['kiro', 'anthropic', 'openai'].includes(provider)) provider = null;
const MODEL =
  provider === 'kiro' ? 'Kiro CLI' :
  process.env.AI_MODEL || (provider === 'anthropic' ? 'claude-sonnet-4-5' : 'gpt-4o-mini');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('Body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function callAI({ system = '', messages = [], maxTokens = 2048 }) {
  const clean = messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.content)
    .map((m) => ({ role: m.role, content: String(m.content) }));
  if (!clean.length) throw new Error('No messages');

  if (provider === 'kiro') return callKiro(system, clean);

  if (provider === 'anthropic') {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, system, messages: clean }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data?.error?.message || `Anthropic error ${r.status}`);
    return (data.content || []).map((b) => b.text || '').join('');
  }

  if (provider === 'openai') {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${OPENAI_KEY}` },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: maxTokens,
        messages: [{ role: 'system', content: system }, ...clean],
      }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data?.error?.message || `OpenAI error ${r.status}`);
    return data.choices?.[0]?.message?.content || '';
  }

  throw new Error('No AI provider configured');
}

// ---- Kiro CLI (headless) ----
// Runs inside kiro-agent/ with the text-only "study-os" agent (no tools), so a prompt
// can never make Kiro run shell commands or edit files.
const { execFile } = require('child_process');
const jobs = require('./jobs');
const KIRO_DIR = path.join(__dirname, 'kiro-agent');
const KIRO_AGENT = process.env.KIRO_AGENT || 'study-os';
const MAX_PROMPT = 100_000; // stay under the OS argument-length limit

const stripAnsi = (s) => s.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07/g, '');

function cleanKiroOutput(out) {
  const lines = stripAnsi(out).replace(/\r/g, '').split('\n');
  const kept = lines.filter((l) => !/^\s*[▸•]?\s*(Credits|Time|Tokens?|Model|Agent)\s*:/i.test(l)); // usage/status footers
  return kept.join('\n').replace(/^\s*>\s?/, '').trim();
}

function flattenPrompt(system, messages) {
  const convo = messages
    .map((m) => `${m.role === 'user' ? 'Student' : 'Assistant'}: ${m.content}`)
    .join('\n\n');
  const prompt = `${system}\n\n# Conversation\n${convo}\n\nReply as the Assistant to the student's last message. Output only the reply itself: no preamble, and do not use any tools.`;
  return prompt.length > MAX_PROMPT ? prompt.slice(0, MAX_PROMPT) + '\n\n[input truncated]' : prompt;
}

function callKiro(system, messages) {
  return new Promise((resolve, reject) => {
    execFile(
      KIRO_CLI,
      ['chat', '--no-interactive', '--agent', KIRO_AGENT, flattenPrompt(system, messages)],
      { cwd: KIRO_DIR, env: process.env, timeout: 180_000, maxBuffer: 10 * 1024 * 1024, windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          if (err.code === 'ENOENT') return reject(new Error(`Kiro CLI not found. Install it (https://kiro.dev/cli) or set KIRO_CLI_PATH.`));
          if (err.killed) return reject(new Error('Kiro took too long to respond (3 min timeout).'));
          const msg = cleanKiroOutput(stderr || stdout || '').split('\n').slice(-3).join(' ');
          return reject(new Error(`Kiro CLI error: ${msg || err.message}`));
        }
        const text = cleanKiroOutput(stdout);
        text ? resolve(text) : reject(new Error('Kiro returned an empty response'));
      }
    );
  });
}

let kiroReady = null; // null = unchecked, true/false after probing
function probeKiro() {
  execFile(KIRO_CLI, ['--version'], { timeout: 15_000, windowsHide: true }, (err, out) => {
    kiroReady = !err;
    console.log(kiroReady ? `  Kiro CLI: ${stripAnsi(out).trim()}` : `  ⚠ Kiro CLI not found at "${KIRO_CLI}". Install it or set KIRO_CLI_PATH`);
  });
}

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === '/' || rel === '/callback') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) return send(res, 403, { error: 'Forbidden' });
  fs.readFile(file, (err, buf) => {
    if (err) {
      // SPA fallback
      return fs.readFile(path.join(PUBLIC, 'index.html'), (e2, html) =>
        e2 ? send(res, 404, 'Not found', 'text/plain') : send(res, 200, html, MIME['.html'])
      );
    }
    send(res, 200, buf, MIME[path.extname(file)] || 'application/octet-stream');
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname === '/api/status' && req.method === 'GET') {
      return send(res, 200, {
        ai: Boolean(provider) && !(provider === 'kiro' && kiroReady === false),
        provider,
        model: provider ? MODEL : null,
        spotifyClientId: process.env.SPOTIFY_CLIENT_ID || null,
      });
    }
    if (url.pathname === '/api/ai' && req.method === 'POST') {
      if (!provider) return send(res, 503, { error: 'AI not configured. Add KIRO_API_KEY, ANTHROPIC_API_KEY or OPENAI_API_KEY to .env' });
      const body = JSON.parse((await readBody(req)) || '{}');
      const text = await callAI(body);
      return send(res, 200, { text });
    }
    if (url.pathname === '/api/jobs/search' && req.method === 'POST') {
      const filters = JSON.parse((await readBody(req)) || '{}');
      return send(res, 200, await jobs.search(filters));
    }
    if (url.pathname === '/api/job-text' && req.method === 'GET') {
      try {
        return send(res, 200, await jobs.jobText(url.searchParams.get('url') || ''));
      } catch (e) {
        return send(res, 422, { error: e.name === 'TimeoutError' ? 'That site took too long. Paste the description instead.' : e.message });
      }
    }
    if (req.method === 'GET') return serveStatic(req, res, url.pathname);
    send(res, 405, { error: 'Method not allowed' });
  } catch (e) {
    console.error('[server]', e.message);
    send(res, 500, { error: e.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  ✦ orbit running at http://${HOST}:${PORT}`);
  console.log(`  AI: ${provider ? `${provider} (${MODEL})` : 'offline mode (add a key to .env for full AI)'}`);
  if (provider === 'kiro') probeKiro();
  console.log(`  Spotify: ${process.env.SPOTIFY_CLIENT_ID ? 'client ID set' : 'embed-only (set SPOTIFY_CLIENT_ID for account connect)'}\n`);
});
