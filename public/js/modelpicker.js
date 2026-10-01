// Model picker: a pill showing the current model that opens a searchable menu grouped by provider.
import { aiEnabled, loadModels, getCatalog, getModel, setModel, modelInfo, onModelChange } from './ai.js';
import { esc } from './util.js';
import { toast } from './ui.js';

// Put popular picks first within each provider
function rank(m) {
  const id = m.model.toLowerCase();
  if (id === 'default' || id === 'auto') return -100;
  let r = 0;
  if (/opus|pro\b|-pro|gpt-5(?!.*(mini|nano))|sol\b/.test(id)) r -= 30;
  if (/sonnet|flash(?!-lite)|gpt-4\.1|gpt-4o(?!-mini)|terra/.test(id)) r -= 20;
  if (/haiku|mini|lite|nano|luna/.test(id)) r -= 10;
  if (/preview|exp|experimental/.test(id)) r += 5;
  const v = parseFloat((id.match(/(\d+(?:\.\d+)?)/) || [])[1] || 0);
  return r - v; // newer versions first
}

export function mountModelPicker(host, { compact = false } = {}) {
  if (!aiEnabled()) { host.innerHTML = ''; return () => {}; }
  let open = false;
  let query = '';

  const draw = () => {
    const cat = getCatalog();
    const cur = modelInfo();
    host.innerHTML = `
      <div class="mp ${compact ? 'compact' : ''}">
        <button class="mp-btn" type="button" aria-haspopup="listbox" aria-expanded="${open}">
          <span class="mp-dot" data-p="${esc(cur.provider || '')}"></span>
          <span class="mp-cur">${esc(cur.label)}</span>
          ${compact ? '' : `<span class="mp-prov">${esc(cur.providerLabel || '')}</span>`}
          <span class="mp-caret"></span>
        </button>
        ${open ? menu(cat, cur.id) : ''}
      </div>`;
    const btn = host.querySelector('.mp-btn');
    btn.onclick = (e) => { e.stopPropagation(); open = !open; query = ''; draw(); if (open) host.querySelector('.mp-search')?.focus(); };
    if (!open) return;
    placeMenu(btn, host.querySelector('.mp-menu'));
    const search = host.querySelector('.mp-search');
    search.oninput = () => { query = search.value; const list = host.querySelector('.mp-list'); list.outerHTML = listHTML(getCatalog(), getModel(), query); wireList(); };
    search.onkeydown = (e) => {
      if (e.key === 'Escape') { open = false; draw(); btn.focus(); }
      if (e.key === 'Enter') { const first = host.querySelector('[data-model]'); if (first) choose(first.dataset.model); }
    };
    host.querySelector('.mp-refresh').onclick = async (e) => {
      e.stopPropagation();
      e.target.textContent = 'refreshing…';
      await loadModels({ refresh: true });
      draw();
    };
    host.querySelector('.mp-menu').onclick = (e) => e.stopPropagation();
    wireList();
  };

  const wireList = () => host.querySelectorAll('[data-model]').forEach((b) => (b.onclick = () => choose(b.dataset.model)));
  const choose = (id) => {
    open = false; // before setModel, which redraws
    setModel(id);
    toast(`now using ${modelInfo(id).label}`);
  };

  const closeOnOutside = () => { if (open) { open = false; draw(); } };
  document.addEventListener('click', closeOnOutside);
  const closeOnMove = (e) => { if (open && !host.querySelector('.mp-menu')?.contains(e.target)) { open = false; draw(); } };
  window.addEventListener('resize', closeOnMove);
  document.addEventListener('scroll', closeOnMove, true);
  const off = onModelChange(draw);
  loadModels().then(draw);
  draw();
  return () => { document.removeEventListener('click', closeOnOutside); window.removeEventListener('resize', closeOnMove); document.removeEventListener('scroll', closeOnMove, true); off(); };
}

// Float the menu above everything (so pop-up windows and cards can't clip it),
// opening downward if there's room, otherwise upward, and staying on screen.
function placeMenu(btn, m) {
  if (!m) return;
  const r = btn.getBoundingClientRect();
  const pad = 8;
  const width = Math.min(330, window.innerWidth - pad * 2);
  const below = window.innerHeight - r.bottom - pad;
  const above = r.top - pad;
  const up = below < 300 && above > below;
  const maxH = Math.max(200, Math.min(440, (up ? above : below) - 6));
  Object.assign(m.style, {
    position: 'fixed',
    width: `${width}px`,
    maxHeight: `${maxH}px`,
    left: `${Math.max(pad, Math.min(r.right - width, window.innerWidth - width - pad))}px`,
    top: up ? 'auto' : `${r.bottom + 6}px`,
    bottom: up ? `${window.innerHeight - r.top + 6}px` : 'auto',
    right: 'auto',
  });
}

function menu(cat, currentId) {
  const errs = Object.entries(cat.errors || {});
  return `<div class="mp-menu" role="listbox">
    <input class="mp-search" placeholder="search models…" value="">
    ${listHTML(cat, currentId, '')}
    ${errs.length ? `<div class="mp-err">${errs.map(([p, e]) => `<div><b>${esc(p)}:</b> ${esc(e)}</div>`).join('')}</div>` : ''}
    <div class="mp-foot"><span>used for chat, notes, syllabus &amp; careers</span><button class="mp-refresh" type="button">refresh list</button></div>
  </div>`;
}

function listHTML(cat, currentId, q) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const models = cat.models.filter((m) => { const hay = `${m.label} ${m.model} ${m.providerLabel}`.toLowerCase(); return words.every((w) => hay.includes(w)); });
  if (!cat.models.length) return '<div class="mp-list"><div class="mp-empty">loading models…</div></div>';
  if (!models.length) return '<div class="mp-list"><div class="mp-empty">no models match</div></div>';
  const groups = {};
  for (const m of models) (groups[m.providerLabel] ||= []).push(m);
  return `<div class="mp-list">${Object.entries(groups).map(([label, list]) => `
    <div class="mp-group">${esc(label)}</div>
    ${list.sort((a, b) => rank(a) - rank(b)).map((m) => `<button class="mp-item ${m.id === currentId ? 'on' : ''}" data-model="${esc(m.id)}" role="option" aria-selected="${m.id === currentId}">
      <span>${esc(m.label)}</span>${m.label.toLowerCase() !== m.model.toLowerCase() ? `<small>${esc(m.model)}</small>` : ''}${m.id === currentId ? '<i></i>' : ''}
    </button>`).join('')}`).join('')}</div>`;
}
