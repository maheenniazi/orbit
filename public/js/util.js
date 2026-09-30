// Shared helpers: dates, escaping, markdown.
export const APP_NAME = 'orbit'; // rename here

export const pad = (n) => String(n).padStart(2, '0');
export const toISO = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const todayISO = () => toISO(new Date());
export const fromISO = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};
export const addDays = (iso, n) => {
  const d = fromISO(iso);
  d.setDate(d.getDate() + n);
  return toISO(d);
};
export const daysBetween = (a, b) => Math.round((fromISO(b) - fromISO(a)) / 86400000);
export const daysUntil = (iso) => daysBetween(todayISO(), iso);

export const MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
export const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function fmtDate(iso, opts = { weekday: 'short', month: 'short', day: 'numeric' }) {
  return fromISO(iso).toLocaleDateString(undefined, opts);
}
export function fmtTime(t) {
  if (!t) return '';
  const [h, m] = t.split(':').map(Number);
  const ampm = h >= 12 ? 'pm' : 'am';
  return `${((h + 11) % 12) + 1}${m ? ':' + pad(m) : ''}${ampm}`;
}
export function relDay(iso) {
  const n = daysUntil(iso);
  if (n === 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  if (n === -1) return 'Yesterday';
  if (n > 1 && n < 7) return `In ${n} days`;
  if (n < 0) return `${-n} days ago`;
  return fmtDate(iso);
}

export const esc = (s = '') =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const uid = () => Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);

export const EXAM_TYPES = ['exam', 'midterm', 'final'];
export const TYPE_META = {
  final: { label: 'Final' },
  midterm: { label: 'Midterm' },
  exam: { label: 'Exam' },
  quiz: { label: 'Quiz' },
  assignment: { label: 'Assignment' },
  project: { label: 'Project' },
  reading: { label: 'Reading' },
  lab: { label: 'Lab' },
  study: { label: 'Study' },
  class: { label: 'Class' },
  other: { label: 'Event' },
};

// Minimal, safe markdown renderer (escape first, then format).
export function md(src = '') {
  const lines = esc(src).split('\n');
  let html = '';
  let list = null;
  let inCode = false;
  const inline = (s) =>
    s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
      .replace(/==([^=]+)==/g, '<mark>$1</mark>');
  const closeList = () => {
    if (list) html += `</${list}>`;
    list = null;
  };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (line.startsWith('```')) {
      closeList();
      html += inCode ? '</code></pre>' : '<pre><code>';
      inCode = !inCode;
      continue;
    }
    if (inCode) { html += line + '\n'; continue; }
    let m;
    if ((m = line.match(/^(#{1,4})\s+(.*)/))) { closeList(); html += `<h${m[1].length + 1}>${inline(m[2])}</h${m[1].length + 1}>`; }
    else if ((m = line.match(/^\s*[-*]\s+\[( |x)\]\s+(.*)/i))) {
      if (list !== 'ul') { closeList(); html += '<ul class="checks">'; list = 'ul'; }
      html += `<li><input type="checkbox" disabled ${m[1].toLowerCase() === 'x' ? 'checked' : ''}> ${inline(m[2])}</li>`;
    }
    else if ((m = line.match(/^\s*[-*•]\s+(.*)/))) {
      if (list !== 'ul') { closeList(); html += '<ul>'; list = 'ul'; }
      html += `<li>${inline(m[1])}</li>`;
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)/))) {
      if (list !== 'ol') { closeList(); html += '<ol>'; list = 'ol'; }
      html += `<li>${inline(m[1])}</li>`;
    } else if ((m = line.match(/^&gt;\s?(.*)/))) { closeList(); html += `<blockquote>${inline(m[1])}</blockquote>`; }
    else if (/^---+$/.test(line)) { closeList(); html += '<hr>'; }
    else if (!line.trim()) { closeList(); }
    else { closeList(); html += `<p>${inline(line)}</p>`; }
  }
  closeList();
  if (inCode) html += '</code></pre>';
  return html;
}

// Pull the first JSON object/array out of an LLM response.
export function extractJSON(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.search(/[[{]/);
  if (start < 0) throw new Error('No JSON found');
  const open = candidate[start];
  const close = open === '{' ? '}' : ']';
  const end = candidate.lastIndexOf(close);
  return JSON.parse(candidate.slice(start, end + 1));
}
