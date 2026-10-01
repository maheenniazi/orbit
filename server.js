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
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '').trim();
  }
}

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC = path.join(__dirname, 'public');
const MAX_BODY = 8 * 1024 * 1024;

const ai = require('./ai-providers');

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

function readBody(req, { raw = false, limit = MAX_BODY } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('Body too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => resolve(raw ? Buffer.concat(chunks) : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const { execFile } = require('child_process');
const jobs = require('./jobs');
const pages = require('./pages');

// ---- File conversion helpers (macOS built-ins: textutil for old Word/RTF/ODT, sips for HEIC/TIFF photos) ----
const os = require('os');
const TEXTUTIL_EXT = new Set(['.doc', '.dot', '.docx', '.rtf', '.rtfd', '.odt', '.wordml', '.html', '.htm', '.webarchive', '.txt']);
const SIPS_EXT = new Set(['.heic', '.heif', '.tif', '.tiff', '.bmp', '.gif', '.png', '.jpg', '.jpeg', '.webp', '.avif', '.psd', '.jp2']);
const execP = (cmd, args) => new Promise((resolve, reject) =>
  execFile(cmd, args, { timeout: 60_000, maxBuffer: 30 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) =>
    err ? reject(new Error((stderr || err.message).toString().trim().split('\n').pop())) : resolve(stdout)));

async function convertFile(buf, name, to) {
  const ext = (path.extname(String(name)).toLowerCase().match(/^\.[a-z0-9]{1,8}$/) || ['.bin'])[0];
  const onMac = process.platform === 'darwin';
  const unsupported = (msg) => Object.assign(new Error(msg), { status: 415 });
  if (to === 'text' && !TEXTUTIL_EXT.has(ext)) throw unsupported(`can’t convert ${ext} files to text`);
  if (to === 'jpeg' && !SIPS_EXT.has(ext)) throw unsupported(`can’t convert ${ext} files to an image`);
  if (!onMac) throw unsupported(to === 'text' ? 'converting this file needs macOS' : 'converting this image type needs macOS');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orbit-'));
  try {
    const input = path.join(dir, 'input' + ext);
    fs.writeFileSync(input, buf);
    if (to === 'text') return { text: (await execP('/usr/bin/textutil', ['-convert', 'txt', '-stdout', input])).toString('utf8') };
    const out = path.join(dir, 'out.jpg');
    await execP('/usr/bin/sips', ['-s', 'format', 'jpeg', '-Z', '3000', input, '--out', out]);
    return { jpeg: fs.readFileSync(out) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
      const providers = ai.enabled();
      return send(res, 200, {
        ai: providers.length > 0,
        providers,
        provider: providers[0] || null,
        spotifyClientId: process.env.SPOTIFY_CLIENT_ID || null,
        webJobs: require('./websearch').status(),
      });
    }
    if (url.pathname === '/api/models' && req.method === 'GET') {
      return send(res, 200, await ai.catalog({ refresh: url.searchParams.has('refresh') }));
    }
    if (url.pathname === '/api/ai' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)) || '{}');
      try {
        return send(res, 200, await ai.callAI(body));
      } catch (e) {
        return send(res, e.status || 502, { error: e.message });
      }
    }
    if (url.pathname === '/api/jobs/test' && req.method === 'GET') {
      return send(res, 200, await require('./websearch').testSources());
    }
    if (url.pathname === '/api/jobs/search' && req.method === 'POST') {
      const filters = JSON.parse((await readBody(req)) || '{}');
      return send(res, 200, await jobs.search(filters));
    }
    if (url.pathname === '/api/convert' && req.method === 'POST') {
      const to = url.searchParams.get('to');
      if (!['text', 'jpeg'].includes(to)) return send(res, 400, { error: 'to must be text or jpeg' });
      try {
        const buf = await readBody(req, { raw: true, limit: 40 * 1024 * 1024 });
        const out = await convertFile(buf, url.searchParams.get('name') || '', to);
        return out.jpeg ? send(res, 200, out.jpeg, 'image/jpeg') : send(res, 200, out);
      } catch (e) {
        return send(res, e.status || 422, { error: e.message });
      }
    }
    if (url.pathname === '/api/page-text' && req.method === 'GET') {
      try {
        return send(res, 200, await pages.pageText(url.searchParams.get('url') || ''));
      } catch (e) {
        return send(res, 422, { error: e.name === 'TimeoutError' ? 'that site took too long to respond' : e.message });
      }
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
  const providers = ai.enabled();
  console.log(`  AI: ${providers.length ? providers.map((p) => ai.LABEL[p]).join(', ') + (process.env.AI_MODEL ? ` (default ${process.env.AI_MODEL})` : '') : 'offline mode (add a key to .env for full AI)'}`);
  ai.probeKiro();
  console.log(`  Spotify: ${process.env.SPOTIFY_CLIENT_ID ? 'client ID set' : 'embed-only (set SPOTIFY_CLIENT_ID for account connect)'}\n`);
});
