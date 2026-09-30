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

// File reading lives in fileread.js (pdf, word, powerpoint, excel, images via OCR, …)
export { readFileText, readFilesText, enableImagePaste, ACCEPT } from './fileread.js';

export function spinner(label = 'Thinking…') {
  return `<div class="thinking"><span class="dot"></span><span class="dot"></span><span class="dot"></span> ${esc(label)}</div>`;
}
