// Replaces every native <select> with a styled dropdown that matches the theme.
// The real <select> stays in the page (hidden), so existing code that reads .value or listens
// for "change" keeps working. New selects are picked up automatically as views render.
let openMenu = null;

function closeMenu() {
  if (!openMenu) return;
  openMenu.menu.remove();
  openMenu.btn.setAttribute('aria-expanded', 'false');
  openMenu.btn.classList.remove('open');
  openMenu = null;
}

function labelOf(sel) {
  const o = sel.options[sel.selectedIndex];
  return o ? o.textContent : '';
}

function enhance(sel) {
  if (sel.dataset.cs || sel.multiple || sel.dataset.native != null) return;
  sel.dataset.cs = '1';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = `cselect ${sel.className}`.trim();
  if (sel.style.cssText) btn.style.cssText = sel.style.cssText;
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-expanded', 'false');
  if (sel.title) btn.title = sel.title;
  const ariaLabel = sel.getAttribute('aria-label') || sel.closest('label')?.childNodes[0]?.textContent?.trim();
  if (ariaLabel) btn.setAttribute('aria-label', ariaLabel);
  btn.innerHTML = '<span class="cs-val"></span><span class="cs-caret" aria-hidden="true"></span>';
  sel.after(btn);
  sel.classList.add('cs-native');

  const refresh = () => { btn.querySelector('.cs-val').textContent = labelOf(sel); btn.disabled = sel.disabled; };
  refresh();
  sel.addEventListener('change', refresh);
  // keep the button in sync when code sets select.value directly
  const proto = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  Object.defineProperty(sel, 'value', { configurable: true, get() { return proto.get.call(this); }, set(v) { proto.set.call(this, v); refresh(); } });
  new MutationObserver(refresh).observe(sel, { childList: true, subtree: true, attributes: true, attributeFilter: ['selected', 'disabled'] });

  const choose = (i) => {
    if (sel.selectedIndex !== i) {
      sel.selectedIndex = i;
      refresh();
      sel.dispatchEvent(new Event('input', { bubbles: true }));
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    }
    closeMenu();
    btn.focus();
  };

  const open = () => {
    if (openMenu?.btn === btn) return closeMenu();
    closeMenu();
    const menu = document.createElement('div');
    menu.className = 'cs-menu';
    menu.setAttribute('role', 'listbox');
    menu.innerHTML = [...sel.options].map((o, i) => `<button type="button" role="option" class="cs-opt ${i === sel.selectedIndex ? 'on' : ''}" data-i="${i}" ${o.disabled ? 'disabled' : ''} aria-selected="${i === sel.selectedIndex}"></button>`).join('');
    [...menu.children].forEach((b, i) => (b.textContent = sel.options[i].textContent));
    document.body.appendChild(menu);
    const r = btn.getBoundingClientRect();
    const h = Math.min(menu.scrollHeight, 300);
    const below = window.innerHeight - r.bottom - 8;
    menu.style.minWidth = `${r.width}px`;
    menu.style.left = `${Math.min(r.left, window.innerWidth - Math.max(r.width, menu.offsetWidth) - 8)}px`;
    menu.style.top = below >= h || below > r.top ? `${r.bottom + 4}px` : `${r.top - h - 4}px`;
    menu.style.maxHeight = `${Math.max(140, Math.min(300, below >= h || below > r.top ? below : r.top - 12))}px`;
    menu.addEventListener('mousedown', (e) => e.preventDefault());
    menu.querySelectorAll('[data-i]').forEach((b) => (b.onclick = () => choose(+b.dataset.i)));
    menu.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
    btn.setAttribute('aria-expanded', 'true');
    btn.classList.add('open');
    openMenu = { menu, btn, sel, choose, active: sel.selectedIndex };
  };

  btn.addEventListener('click', (e) => { e.stopPropagation(); open(); });
  btn.addEventListener('keydown', (e) => {
    const n = sel.options.length;
    const isOpen = openMenu?.btn === btn;
    if (['ArrowDown', 'ArrowUp'].includes(e.key)) {
      e.preventDefault();
      if (!isOpen) return open();
      let a = openMenu.active;
      do { a = (a + (e.key === 'ArrowDown' ? 1 : -1) + n) % n; } while (sel.options[a].disabled && a !== openMenu.active);
      openMenu.active = a;
      openMenu.menu.querySelectorAll('.cs-opt').forEach((o, i) => o.classList.toggle('active', i === a));
      openMenu.menu.children[a]?.scrollIntoView({ block: 'nearest' });
    } else if ((e.key === 'Enter' || e.key === ' ') && isOpen) { e.preventDefault(); choose(openMenu.active); }
    else if (e.key === 'Escape' && isOpen) { e.preventDefault(); closeMenu(); }
    else if (e.key === 'Tab') closeMenu();
    else if (e.key.length === 1 && /\S/.test(e.key)) {
      // type a letter to jump to the next option starting with it
      const start = (isOpen ? openMenu.active : sel.selectedIndex) + 1;
      for (let k = 0; k < n; k++) {
        const i = (start + k) % n;
        if (!sel.options[i].disabled && sel.options[i].textContent.trim().toLowerCase().startsWith(e.key.toLowerCase())) {
          if (isOpen) { openMenu.active = i; openMenu.menu.querySelectorAll('.cs-opt').forEach((o, j) => o.classList.toggle('active', j === i)); openMenu.menu.children[i].scrollIntoView({ block: 'nearest' }); }
          else choose(i);
          break;
        }
      }
    }
  });
}

export function enhanceSelects(root = document) {
  root.querySelectorAll('select:not([data-cs])').forEach(enhance);
}

export function startSelects() {
  enhanceSelects();
  new MutationObserver((muts) => {
    if (muts.some((m) => [...m.addedNodes].some((n) => n.nodeType === 1 && (n.tagName === 'SELECT' || n.querySelector?.('select'))))) enhanceSelects();
  }).observe(document.body, { childList: true, subtree: true });
  document.addEventListener('click', (e) => { if (openMenu && !openMenu.menu.contains(e.target)) closeMenu(); });
  window.addEventListener('resize', closeMenu);
  document.addEventListener('scroll', (e) => { if (openMenu && !openMenu.menu.contains(e.target)) closeMenu(); }, true);
}
