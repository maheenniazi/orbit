// Read (almost) any file into plain text, fully client-side where possible.
//  pdf (+ OCR for scanned pages) · docx/docm · pptx · xlsx · odt/ods/odp · rtf · html · csv/tsv · txt/md/…
//  images (png jpg webp gif bmp heic tiff …) via OCR · doc/heic/tiff via the local server on macOS (textutil / sips)
//  .pages/.key/.numbers via their embedded preview
const PDFJS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';
const PDFJS_WORKER = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
const TESSERACT = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';

export const ACCEPT = [
  '.pdf', '.doc', '.docx', '.docm', '.dot', '.dotx', '.rtf', '.odt', '.ott', '.pages',
  '.ppt', '.pptx', '.ppsx', '.odp', '.key', '.xlsx', '.xlsm', '.ods', '.numbers', '.csv', '.tsv',
  '.txt', '.md', '.markdown', '.html', '.htm', '.json', '.ics', '.eml', '.tex',
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.tif', '.tiff', '.heic', '.heif', '.avif',
  'image/*', 'application/pdf', 'text/*',
].join(',');

const extOf = (name) => (String(name).toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1] || '';
const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'bmp', 'webp', 'tif', 'tiff', 'heic', 'heif', 'avif', 'jfif']);
const tidy = (s) => s.replace(/\r\n?/g, '\n').replace(/[ \t\u00a0]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

// ---------------- ZIP (for docx/pptx/xlsx/odf/iwork) ----------------
async function unzip(buf) {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(buf);
  let eocd = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip');
  const count = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const entries = new Map();
  const dec = new TextDecoder();
  for (let n = 0; n < count && dv.getUint32(off, true) === 0x02014b50; n++) {
    const method = dv.getUint16(off + 10, true);
    const csize = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true);
    const extraLen = dv.getUint16(off + 30, true);
    const commLen = dv.getUint16(off + 32, true);
    const local = dv.getUint32(off + 42, true);
    entries.set(dec.decode(u8.subarray(off + 46, off + 46 + nameLen)), { method, csize, local });
    off += 46 + nameLen + extraLen + commLen;
  }
  const read = async (name) => {
    const e = entries.get(name);
    if (!e) return null;
    const start = e.local + 30 + dv.getUint16(e.local + 26, true) + dv.getUint16(e.local + 28, true);
    const data = u8.subarray(start, start + e.csize);
    if (e.method === 0) return data;
    if (e.method !== 8) throw new Error('unsupported zip compression');
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  };
  return { names: [...entries.keys()], read, text: async (name) => { const b = await read(name); return b ? dec.decode(b) : null; } };
}
const parseXML = (s) => new DOMParser().parseFromString(s, 'application/xml');
const kids = (el) => Array.from(el.children || []);
const numSort = (re) => (a, b) => +(a.match(re)?.[1] || 0) - +(b.match(re)?.[1] || 0);

// ---------------- Word (.docx) ----------------
function docxRun(node) {
  let out = '';
  for (const c of node.childNodes) {
    if (c.nodeType !== 1) continue;
    const n = c.localName;
    if (n === 't') out += c.textContent;
    else if (n === 'tab') out += '\t';
    else if (n === 'br' || n === 'cr') out += '\n';
    else if (n === 'noBreakHyphen') out += '-';
    else if (['del', 'delText', 'instrText', 'rPr', 'pPr', 'fldData'].includes(n)) continue;
    else out += docxRun(c);
  }
  return out;
}
function docxBlocks(node) {
  const lines = [];
  for (const c of kids(node)) {
    const n = c.localName;
    if (n === 'p') lines.push(docxRun(c));
    else if (n === 'tbl') {
      for (const tr of kids(c).filter((x) => x.localName === 'tr')) {
        const cells = kids(tr).filter((x) => x.localName === 'tc' || x.localName === 'sdt')
          .map((tc) => docxBlocks(tc).join(' ').replace(/\s+/g, ' ').trim());
        lines.push(cells.join(' | '));
      }
      lines.push('');
    } else if (['sdt', 'sdtContent', 'customXml', 'body', 'txbxContent', 'smartTag'].includes(n)) lines.push(...docxBlocks(c));
  }
  return lines;
}
async function docxText(zip) {
  const xml = await zip.text('word/document.xml');
  if (!xml) throw new Error('This Word file looks empty or damaged.');
  const body = parseXML(xml).getElementsByTagNameNS('*', 'body')[0];
  return docxBlocks(body).join('\n');
}

// ---------------- PowerPoint (.pptx) ----------------
async function pptxText(zip) {
  const re = /^ppt\/slides\/slide(\d+)\.xml$/;
  const slides = zip.names.filter((n) => re.test(n)).sort(numSort(re));
  const out = [];
  for (const [i, name] of slides.entries()) {
    const doc = parseXML(await zip.text(name));
    const paras = Array.from(doc.getElementsByTagNameNS('*', 'p'))
      .filter((p) => p.namespaceURI?.includes('drawingml'))
      .map((p) => Array.from(p.getElementsByTagNameNS('*', 't')).map((t) => t.textContent).join('').trim())
      .filter(Boolean);
    if (paras.length) out.push(`Slide ${i + 1}\n${paras.join('\n')}`);
  }
  return out.join('\n\n');
}

// ---------------- Excel (.xlsx) ----------------
const BUILTIN_DATE_FMTS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
function excelDate(serial) {
  const d = new Date(Date.UTC(1899, 11, 30) + Math.round(serial * 86400000));
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}
async function xlsxText(zip) {
  const shared = [];
  const ss = await zip.text('xl/sharedStrings.xml');
  if (ss) for (const si of parseXML(ss).getElementsByTagNameNS('*', 'si')) shared.push(Array.from(si.getElementsByTagNameNS('*', 't')).map((t) => t.textContent).join(''));
  // Which cell styles are dates?
  const dateStyles = new Set();
  const st = await zip.text('xl/styles.xml');
  if (st) {
    const sd = parseXML(st);
    const custom = new Set(Array.from(sd.getElementsByTagNameNS('*', 'numFmt')).filter((f) => /[dmy]/i.test((f.getAttribute('formatCode') || '').replace(/"[^"]*"|\[[^\]]*\]/g, ''))).map((f) => +f.getAttribute('numFmtId')));
    const xfs = sd.getElementsByTagNameNS('*', 'cellXfs')[0];
    kids(xfs || {}).forEach((xf, i) => { const id = +xf.getAttribute('numFmtId'); if (BUILTIN_DATE_FMTS.has(id) || custom.has(id)) dateStyles.add(i); });
  }
  const re = /^xl\/worksheets\/sheet(\d+)\.xml$/;
  const out = [];
  for (const name of zip.names.filter((n) => re.test(n)).sort(numSort(re))) {
    const rows = [];
    for (const row of parseXML(await zip.text(name)).getElementsByTagNameNS('*', 'row')) {
      const cells = [];
      for (const c of kids(row).filter((x) => x.localName === 'c')) {
        const t = c.getAttribute('t');
        const v = c.getElementsByTagNameNS('*', 'v')[0]?.textContent ?? '';
        let val;
        if (t === 's') val = shared[+v] ?? '';
        else if (t === 'inlineStr') val = Array.from(c.getElementsByTagNameNS('*', 't')).map((x) => x.textContent).join('');
        else if (t === 'b') val = v === '1' ? 'TRUE' : 'FALSE';
        else if (v !== '' && dateStyles.has(+c.getAttribute('s')) && !Number.isNaN(+v)) val = excelDate(+v);
        else val = v;
        if (String(val).trim()) cells.push(String(val).trim());
      }
      if (cells.length) rows.push(cells.join(' | '));
    }
    if (rows.length) out.push(rows.join('\n'));
  }
  return out.join('\n\n');
}

// ---------------- OpenDocument (.odt/.ods/.odp) ----------------
function odfWalk(node, lines) {
  for (const c of kids(node)) {
    const n = c.localName;
    if (n === 'table-row') {
      const cells = kids(c).filter((x) => x.localName === 'table-cell').map((x) => x.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean);
      if (cells.length) lines.push(cells.join(' | '));
    } else if (n === 'p' || n === 'h') {
      let s = '';
      const walk = (el) => { for (const k of el.childNodes) { if (k.nodeType === 3) s += k.textContent; else if (k.localName === 'tab') s += '\t'; else if (k.localName === 'line-break') s += '\n'; else if (k.localName === 's') s += ' '.repeat(+k.getAttribute('text:c') || 1); else walk(k); } };
      walk(c);
      lines.push(s);
    } else odfWalk(c, lines);
  }
  return lines;
}
async function odfText(zip) {
  const xml = await zip.text('content.xml');
  if (!xml) throw new Error('This OpenDocument file looks damaged.');
  return odfWalk(parseXML(xml).documentElement, []).join('\n');
}

// ---------------- RTF ----------------
const SKIP_DEST = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'header', 'footer', 'headerl', 'headerr', 'headerf', 'footerl', 'footerr', 'footerf', 'object', 'themedata', 'colorschememapping', 'latentstyles', 'datastore', 'xmlnstbl', 'listtable', 'listoverridetable', 'rsidtbl', 'generator', 'mmathPr', 'fldinst', 'bkmkstart', 'bkmkend', 'field', 'nonshppict', 'shppict', 'xe']);
const SPECIAL = { par: '\n', line: '\n', row: '\n', sect: '\n\n', page: '\n\n', tab: '\t', cell: ' | ', emdash: '—', endash: '–', bullet: '•', lquote: '‘', rquote: '’', ldblquote: '“', rdblquote: '”', emspace: ' ', enspace: ' ' };
export function rtfToText(s) {
  const cp = new TextDecoder('windows-1252');
  let out = '';
  const skip = [false];
  let ucSkip = 0;
  let i = 0;
  const top = () => skip[skip.length - 1];
  while (i < s.length) {
    const ch = s[i];
    if (ch === '{') { skip.push(top()); i++; continue; }
    if (ch === '}') { if (skip.length > 1) skip.pop(); i++; continue; }
    if (ch === '\\') {
      const rest = s.slice(i, i + 40);
      let m;
      if ((m = rest.match(/^\\([a-zA-Z]+)(-?\d+)? ?/))) {
        i += m[0].length;
        const w = m[1];
        if (SKIP_DEST.has(w)) { skip[skip.length - 1] = true; continue; }
        if (top()) continue;
        if (w === 'u') { let code = +m[2]; if (code < 0) code += 65536; out += String.fromCharCode(code); ucSkip = 1; continue; }
        if (SPECIAL[w]) out += SPECIAL[w];
        continue;
      }
      if ((m = rest.match(/^\\'([0-9a-fA-F]{2})/))) {
        i += 4;
        if (ucSkip) { ucSkip--; continue; }
        if (!top()) out += cp.decode(Uint8Array.of(parseInt(m[1], 16)));
        continue;
      }
      const sym = s[i + 1];
      i += 2;
      if (sym === '*') { skip[skip.length - 1] = true; continue; }
      if (top()) continue;
      if (sym === '~') out += ' ';
      else if (sym === '-' || sym === '_') out += sym === '_' ? '-' : '';
      else if ('\\{}'.includes(sym)) out += sym;
      else if (sym === '\n' || sym === '\r') out += '\n';
      continue;
    }
    i++;
    if (ch === '\r' || ch === '\n') continue;
    if (ucSkip) { ucSkip--; continue; }
    if (!top()) out += ch;
  }
  return out;
}

// ---------------- HTML ----------------
function htmlText(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style,noscript,svg,head').forEach((n) => n.remove());
  doc.querySelectorAll('tr').forEach((tr) => { tr.replaceWith(doc.createTextNode('\n' + Array.from(tr.children).map((td) => td.textContent.replace(/\s+/g, ' ').trim()).join(' | ') + '\n')); });
  doc.querySelectorAll('br').forEach((b) => b.replaceWith('\n'));
  doc.querySelectorAll('p,div,li,h1,h2,h3,h4,h5,h6,section,article,ul,ol').forEach((b) => b.append('\n'));
  return (doc.body?.textContent || '').replace(/[ \t]+/g, ' ');
}

// ---------------- Legacy .doc (fallback when the Mac converter isn't available) ----------------
function legacyDocGuess(buf) {
  const u8 = new Uint8Array(buf);
  const runs = (str) => (str.match(/[\p{L}\p{N}\p{P}\p{Zs}\t\r\n]{5,}/gu) || []).filter((r) => /\p{L}{3}/u.test(r));
  const a = runs(new TextDecoder('windows-1252').decode(u8));
  const b = runs(new TextDecoder('utf-16le').decode(u8.subarray(0, u8.length - (u8.length % 2))));
  const score = (list) => list.join('').replace(/[^\p{L}]/gu, '').length;
  const best = score(b) > score(a) ? b : a;
  return best.map((r) => r.replace(/\r/g, '\n')).join('\n');
}

// ---------------- Local server conversions (macOS textutil / sips) ----------------
async function serverConvert(file, to) {
  const r = await fetch(`/api/convert?to=${to}&name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file });
  if (!r.ok) {
    const e = await r.json().catch(() => ({}));
    throw new Error(e.error || `conversion failed (${r.status})`);
  }
  return to === 'text' ? (await r.json()).text : r.blob();
}

// ---------------- OCR (tesseract.js, loaded on demand) ----------------
let tessPromise;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  tessPromise ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = TESSERACT;
    s.onload = () => resolve(window.Tesseract);
    s.onerror = () => { tessPromise = null; reject(new Error('Couldn’t load the text-recognition engine. Check your internet connection.')); };
    document.head.appendChild(s);
  });
  return tessPromise;
}
async function withOcr(onProgress, fn) {
  const T = await loadTesseract();
  onProgress?.('loading text recognition…');
  let label = 'reading text';
  const worker = await T.createWorker('eng', 1, {
    logger: (m) => { if (m.status === 'recognizing text') onProgress?.(`${label}… ${Math.round(m.progress * 100)}%`); },
  });
  try {
    return await fn(async (img, lbl) => { if (lbl) label = lbl; return (await worker.recognize(img)).data.text; });
  } finally {
    await worker.terminate();
  }
}

// Decode any image to a canvas (applies EXIF rotation, downsizes huge phone photos).
async function imageToCanvas(blob) {
  const bmp = await createImageBitmap(blob);
  const scale = Math.min(1, 3000 / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return c;
}
async function imageText(file, onProgress) {
  let canvas;
  try {
    canvas = await imageToCanvas(file);
  } catch {
    // Browser can't decode it (e.g. HEIC/TIFF in Chrome): ask the Mac to convert it to JPEG
    onProgress?.('converting image…');
    try {
      canvas = await imageToCanvas(await serverConvert(file, 'jpeg'));
    } catch (e) {
      throw new Error(`Couldn’t open this image. ${e.message}. Try exporting it as JPG or PNG.`);
    }
  }
  const text = await withOcr(onProgress, (rec) => rec(canvas, 'reading photo'));
  if (!text.trim()) throw new Error('No readable text found in that image. Try a sharper, well-lit photo.');
  return text;
}

// ---------------- PDF (text layer, OCR fallback for scans) ----------------
let pdfjs;
async function pdfDoc(data) {
  if (!pdfjs) {
    pdfjs = await import(PDFJS);
    pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  }
  return pdfjs.getDocument({ data }).promise;
}
async function pdfText(buf, onProgress) {
  const doc = await pdfDoc(buf);
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    onProgress?.(`reading page ${i}/${doc.numPages}…`);
    const content = await (await doc.getPage(i)).getTextContent();
    // Rebuild lines from y-positions so a date stays on the same line as its item
    let lastY = null;
    let line = '';
    const lines = [];
    for (const it of content.items) {
      const y = Math.round(it.transform[5]);
      if (lastY !== null && Math.abs(y - lastY) > 2) { lines.push(line); line = ''; }
      line += (line && !line.endsWith(' ') ? ' ' : '') + it.str;
      lastY = y;
    }
    lines.push(line);
    pages.push(lines.join('\n'));
  }
  const text = pages.join('\n\n');
  const letters = (text.match(/\p{L}/gu) || []).length;
  if (letters > 40 * doc.numPages || letters > 400) return text;

  // Scanned / image-only PDF → OCR each page
  const maxPages = Math.min(doc.numPages, 25);
  return withOcr(onProgress, async (rec) => {
    const out = [];
    for (let i = 1; i <= maxPages; i++) {
      const page = await doc.getPage(i);
      const vp = page.getViewport({ scale: 2 });
      const c = document.createElement('canvas');
      c.width = vp.width;
      c.height = vp.height;
      await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
      out.push(await rec(c, `scanning page ${i}/${maxPages}`));
    }
    return out.join('\n\n');
  });
}

// ---------------- Apple iWork (.pages/.key/.numbers) ----------------
async function iworkText(zip, onProgress, file) {
  const pdfName = zip.names.find((n) => /(^|\/)(QuickLook\/)?Preview\.pdf$/i.test(n));
  if (pdfName) {
    const bytes = await zip.read(pdfName);
    return pdfText(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), onProgress);
  }
  const jpg = zip.names.find((n) => /preview(-web)?\.jpe?g$/i.test(n));
  if (jpg && /pages|key/.test(extOf(file.name))) {
    const bytes = await zip.read(jpg);
    return imageText(new File([bytes], 'preview.jpg', { type: 'image/jpeg' }), onProgress);
  }
  throw new Error('This Apple file doesn’t include a readable preview. In Pages/Keynote/Numbers use File → Export To → PDF, then upload that.');
}

// ---------------- Main entry ----------------
export async function readFileText(file, { onProgress } = {}) {
  const ext = extOf(file.name);
  const type = file.type || '';
  onProgress?.(`reading ${file.name}…`);

  if (ext === 'pdf' || type === 'application/pdf') return tidy(await pdfText(await file.arrayBuffer(), onProgress));
  if (IMAGE_EXT.has(ext) || type.startsWith('image/')) return tidy(await imageText(file, onProgress));

  if (['docx', 'docm', 'dotx', 'dotm', 'pptx', 'pptm', 'ppsx', 'potx', 'xlsx', 'xlsm', 'odt', 'ott', 'ods', 'odp', 'pages', 'key', 'numbers'].includes(ext)) {
    let zip;
    try { zip = await unzip(await file.arrayBuffer()); } catch {
      if (['pages', 'key', 'numbers'].includes(ext)) throw new Error('This Apple file is a folder bundle. In Pages use File → Export To → PDF, then upload that.');
      throw new Error('This file looks damaged or password-protected.');
    }
    if (/^doc|^dot/.test(ext)) return tidy(await docxText(zip));
    if (/^ppt|^pps|^pot/.test(ext)) return tidy(await pptxText(zip));
    if (/^xls/.test(ext)) return tidy(await xlsxText(zip));
    if (/^od|^ott/.test(ext)) return tidy(await odfText(zip));
    return tidy(await iworkText(zip, onProgress, file));
  }

  if (['doc', 'dot', 'wps', 'ppt', 'xls'].includes(ext)) {
    try {
      return tidy(await serverConvert(file, 'text'));
    } catch (e) {
      if (ext !== 'doc' && ext !== 'dot' && ext !== 'wps') throw new Error(`Old .${ext} files can’t be read here. Save it as .${ext}x or PDF and try again.`);
      const guess = legacyDocGuess(await file.arrayBuffer());
      if (guess.replace(/\s/g, '').length < 30) throw new Error('Couldn’t read this old Word file. Save it as .docx or PDF and try again.');
      return tidy(guess);
    }
  }

  const raw = await file.text();
  if (ext === 'rtf' || /^\{\\rtf/.test(raw)) return tidy(rtfToText(raw));
  if (['html', 'htm', 'xhtml'].includes(ext) || type === 'text/html') return tidy(htmlText(raw));
  if (ext === 'tsv') return tidy(raw.replace(/\t/g, ' | '));
  if (ext === 'eml') return tidy(/<html/i.test(raw) ? htmlText(raw) : raw.replace(/^[\s\S]*?\r?\n\r?\n/, ''));
  if (/\u0000/.test(raw.slice(0, 4000))) throw new Error(`.${ext || 'this'} files aren’t supported yet. Export it as PDF, Word or a photo and try again.`);
  return tidy(raw);
}

// Several files at once (e.g. photos of each syllabus page) → one text, in order.
export async function readFilesText(files, { onProgress } = {}) {
  const list = Array.from(files);
  const parts = [];
  for (const [i, f] of list.entries()) {
    const prefix = list.length > 1 ? `(${i + 1}/${list.length}) ` : '';
    parts.push(await readFileText(f, { onProgress: (m) => onProgress?.(prefix + m) }));
  }
  return parts.join('\n\n');
}

// Paste a screenshot (⌘⇧⌃4 on Mac) straight into a textarea → OCR text is inserted.
export function enableImagePaste(textarea, { onProgress, onDone, onError } = {}) {
  textarea.addEventListener('paste', async (e) => {
    const item = Array.from(e.clipboardData?.items || []).find((x) => x.kind === 'file' && x.type.startsWith('image/'));
    if (!item) return;
    e.preventDefault();
    const file = item.getAsFile();
    try {
      const text = await readFileText(new File([file], 'pasted-screenshot.png', { type: file.type }), { onProgress });
      const { selectionStart: a, selectionEnd: b, value } = textarea;
      textarea.value = value.slice(0, a) + text + value.slice(b);
      textarea.dispatchEvent(new Event('input'));
      onDone?.(text);
    } catch (err) {
      onError?.(err);
    }
  });
}
