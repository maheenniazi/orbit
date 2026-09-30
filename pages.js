// Fetch the readable text of a public web page (used for program requirement pages in academic calendars).
const { htmlToText, isPrivateHost, UA } = require('./jobs');

const MAX_CHARS = 60_000;

async function pageText(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl).trim()); } catch { throw new Error('That doesn’t look like a link'); }
  if (!/^https?:$/.test(u.protocol) || isPrivateHost(u.hostname)) throw new Error('Only public links are supported');

  const r = await fetch(u, { headers: { ...UA, accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5' }, redirect: 'follow', signal: AbortSignal.timeout(25_000) });
  if (!r.ok) throw new Error(`the site returned ${r.status}`);
  const type = r.headers.get('content-type') || '';
  if (/pdf/i.test(type)) throw new Error('that link is a PDF. Download it and upload the file instead');
  const raw = await r.text();
  if (!/html/i.test(type) && !/<html|<body/i.test(raw)) return { title: u.hostname, text: raw.slice(0, MAX_CHARS), url: r.url };

  const title = htmlToText((raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').trim();
  // Prefer the main content area; calendars wrap requirements in <main>, #content or <article>
  const main =
    raw.match(/<main[\s\S]*?<\/main>/i)?.[0] ||
    raw.match(/<article[\s\S]*?<\/article>/i)?.[0] ||
    raw.match(/<div[^>]+id=["'](?:content|main-content|main|page-content)["'][\s\S]*<\/div>/i)?.[0] ||
    raw.match(/<body[\s\S]*<\/body>/i)?.[0] ||
    raw;
  // Keep table rows on one line so "PSY100H1 | Introductory Psychology | 0.5" stays together
  const tabled = main.replace(/<\/t[dh]>\s*<t[dh][^>]*>/gi, ' | ');
  const text = htmlToText(tabled);
  if (text.length < 400) {
    throw new Error('this calendar loads with JavaScript, so it can’t be read from a link. Open it, press ⌘P and choose “Save as PDF”, then upload that file (or copy and paste the requirements)');
  }
  return { title, text: text.slice(0, MAX_CHARS), url: r.url };
}

module.exports = { pageText };
