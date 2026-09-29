// UI primitives: toast, modal, icons, file reading.
import { esc } from './util.js';

export function h(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function toast(msg, { action, onAction, timeout = 5000 } = {}) {
  const root = document.getElementById('toasts');
  const el = h(`<div class="toast"><span>${esc(msg)}</span>${action ? `<button class="btn ghost sm">${esc(action)}</button>` : ''}</div>`);
  root.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  const close = () => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 300);
  };
  el.querySelector('button')?.addEventListener('click', () => {
    onAction?.();
    close();
  });
  setTimeout(close, timeout);
}

export function modal(title, bodyHTML, { onMount, wide } = {}) {
  const root = h(`<div class="modal-backdrop">
    <div class="modal card ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
      <div class="modal-head"><h3>${esc(title)}</h3><button class="icon-btn" data-close aria-label="Close">✕</button></div>
      <div class="modal-body">${bodyHTML}</div>
    </div></div>`);
  const close = () => {
    root.classList.remove('show');
    setTimeout(() => root.remove(), 200);
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => e.key === 'Escape' && close();
  root.addEventListener('mousedown', (e) => e.target === root && close());
  root.querySelector('[data-close]').onclick = close;
  document.addEventListener('keydown', onKey);
  document.body.appendChild(root);
  requestAnimationFrame(() => root.classList.add('show'));
  onMount?.(root.querySelector('.modal-body'), close);
  return close;
}

// Read txt/md/pdf files into plain text. PDF uses pdf.js from a CDN (loaded on demand).
let pdfjs;
export async function readFileText(file) {
  if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
    if (!pdfjs) {
      pdfjs = await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs');
      pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';
    }
    const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
    const pages = [];
    for (let i = 1; i <= doc.numPages; i++) {
      const content = await (await doc.getPage(i)).getTextContent();
      // Rebuild lines using y-positions so dates stay on the same line as their items.
      let lastY = null;
      let line = '';
      const lines = [];
      for (const it of content.items) {
        const y = Math.round(it.transform[5]);
        if (lastY !== null && Math.abs(y - lastY) > 2) {
          lines.push(line);
          line = '';
        }
        line += (line && !line.endsWith(' ') ? ' ' : '') + it.str;
        lastY = y;
      }
      lines.push(line);
      pages.push(lines.join('\n'));
    }
    return pages.join('\n\n');
  }
  if (/\.docx$/i.test(file.name)) throw new Error('.docx is not supported yet. Export it as PDF or paste the text instead.');
  return file.text();
}

export function spinner(label = 'Thinking…') {
  return `<div class="thinking"><span class="dot"></span><span class="dot"></span><span class="dot"></span> ${esc(label)}</div>`;
}
