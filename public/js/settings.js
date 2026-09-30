// Settings: profile, theme, automation, courses, playlists, integrations, data.
import { store, COURSE_COLORS } from './store.js';
import { getStatus } from './ai.js';
import { mountModelPicker } from './modelpicker.js';
import { esc } from './util.js';
import { toast } from './ui.js';
import { connect, disconnect, isConnected, parsePlaylistId, loadDock } from './spotify.js';

export function render(el) {
  let unmountPicker = null;
  const draw = () => {
    const s = store.get();
    const st = getStatus();
    const labels = { chill: 'drift / rising', rampup: 'gravity', lockin: 'eclipse', examday: 'liftoff' };
    el.innerHTML = `
      <div class="page-head"><div><div class="kicker">settings</div><h1>make it <em>yours</em></h1></div></div>
      <div class="grid cols-3">
        <div class="card stack">
          <h3>You</h3>
          <label class="field">Your name<input id="name" value="${esc(s.settings.name)}" placeholder="What should we call you?"></label>
          <div class="row spread"><span>Theme</span><div class="seg" id="theme"><button data-t="light" class="${s.settings.theme === 'light' ? 'on' : ''}">paper</button><button data-t="dark" class="${s.settings.theme === 'dark' ? 'on' : ''}">night</button></div></div>
        </div>
        <div class="card stack">
          <h3>Automation</h3>
          <label class="check"><input type="checkbox" id="autoFocus" ${s.settings.autoFocus ? 'checked' : ''}> Auto-escalate focus mode as exams approach</label>
          <label class="check"><input type="checkbox" id="autoPlan" ${s.settings.autoStudyPlan ? 'checked' : ''}> Auto-schedule study sessions before exams</label>
          <p class="small muted" style="margin:0">drift → rising (14 days out) → gravity (7) → eclipse (3) → liftoff (exam day).</p>
        </div>
        <div class="card stack">
          <h3>Integrations</h3>
          <div class="row spread"><span>AI model</span>${st.ai ? '<div id="set-picker"></div>' : '<span class="tag" style="--c:#b98a2e">offline</span>'}</div>
          ${st.ai ? `<p class="small muted" style="margin:0">connected: ${esc((st.providers || []).join(', '))}. add more keys in <code>.env</code> to get more models.</p>` : ''}
          <div class="row spread"><span>Spotify</span>${isConnected() ? '<button class="btn danger sm" id="sp-off">Disconnect</button>' : `<button class="btn spotify sm" id="sp-on" ${st.spotifyClientId ? '' : 'disabled title="Set SPOTIFY_CLIENT_ID in .env"'}>Connect</button>`}</div>
          ${st.spotifyClientId ? '' : `<div class="small muted">
            <b style="color:var(--text)">To connect your Spotify account:</b>
            <ol style="margin:6px 0 0;padding-left:18px;line-height:1.7">
              <li>Create an app at <a href="https://developer.spotify.com/dashboard" target="_blank" rel="noopener">developer.spotify.com/dashboard</a> (requires Spotify Premium)</li>
              <li>Redirect URI: <code>${esc(location.origin)}/callback</code> <button class="btn ghost sm" id="copy-uri" style="padding:2px 8px">Copy</button></li>
              <li>Tick <b>Web API</b>, save, then copy the <b>Client ID</b></li>
              <li>Add <code>SPOTIFY_CLIENT_ID=…</code> to <code>.env</code> and restart the server</li>
            </ol>
            <p style="margin:6px 0 0">The sidebar player works without any of this.</p></div>`}
        </div>
        <div class="card stack">
          <h3>Courses</h3>
          ${s.courses.length ? s.courses.map((c) => `<div class="row" data-c="${c.id}">
            <input type="color" value="${c.color}" data-color style="width:36px;height:36px;padding:2px;flex:none">
            <input value="${esc(c.code)}" data-code placeholder="Code" style="width:100px;flex:none">
            <input value="${esc(c.name)}" data-name placeholder="Name" style="flex:1;width:auto">
            <button class="icon-btn" data-del title="Delete course and its events">✕</button></div>`).join('') : '<div class="empty">Courses appear when you import a syllabus.</div>'}
        </div>
        <div class="card stack">
          <h3>Focus playlists</h3>
          ${Object.entries(s.settings.playlists).map(([k, p]) => `<label class="field">${labels[k] || k}<input data-pl="${k}" value="https://open.spotify.com/playlist/${esc(p.id)}" placeholder="Spotify playlist link"></label>`).join('')}
          <p class="small muted" style="margin:0">Paste any Spotify playlist link.</p>
        </div>
        <div class="card stack">
          <h3>Data</h3>
          <p class="small muted" style="margin:0">Everything is stored locally in this browser.</p>
          <div class="row"><button class="btn ghost sm" id="export">Export backup</button><label class="btn ghost sm">Import backup<input type="file" id="import" accept=".json" hidden></label></div>
          <button class="btn danger sm" id="reset" style="align-self:flex-start">Reset everything</button>
        </div>
      </div>`;

    const $ = (q) => el.querySelector(q);
    if ($('#set-picker')) { unmountPicker?.(); unmountPicker = mountModelPicker($('#set-picker'), { compact: true }); }
    $('#name').onchange = (e) => store.update((x) => (x.settings.name = e.target.value.trim()));
    el.querySelectorAll('[data-t]').forEach((b) => (b.onclick = () => store.update((x) => (x.settings.theme = b.dataset.t))));
    $('#autoFocus').onchange = (e) => store.update((x) => (x.settings.autoFocus = e.target.checked));
    $('#autoPlan').onchange = (e) => store.update((x) => (x.settings.autoStudyPlan = e.target.checked));
    $('#sp-on')?.addEventListener('click', connect);
    $('#sp-off')?.addEventListener('click', () => { disconnect(); draw(); });
    $('#copy-uri')?.addEventListener('click', () => navigator.clipboard.writeText(`${location.origin}/callback`).then(() => toast('Redirect URI copied')));
    el.querySelectorAll('[data-c]').forEach((row) => {
      const id = row.dataset.c;
      const upd = (patch) => store.update((x) => Object.assign(x.courses.find((c) => c.id === id), patch));
      row.querySelector('[data-color]').onchange = (e) => upd({ color: e.target.value });
      row.querySelector('[data-code]').onchange = (e) => upd({ code: e.target.value.trim() });
      row.querySelector('[data-name]').onchange = (e) => upd({ name: e.target.value.trim() });
      row.querySelector('[data-del]').onclick = () => {
        if (!confirm('Delete this course and all of its events?')) return;
        store.update((x) => { x.courses = x.courses.filter((c) => c.id !== id); x.events = x.events.filter((e) => e.courseId !== id); });
      };
    });
    el.querySelectorAll('[data-pl]').forEach((inp) => (inp.onchange = () => {
      const pid = parsePlaylistId(inp.value);
      if (!pid) return toast('That doesn’t look like a Spotify playlist link');
      store.update((x) => (x.settings.playlists[inp.dataset.pl] = { name: x.settings.playlists[inp.dataset.pl].name.replace(/^(Lofi Beats|Deep Focus|Brain Food|Peaceful Piano)$/, 'Custom') , id: pid }));
      loadDock(pid);
      toast('Playlist saved');
    }));
    $('#export').onclick = () => {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([store.export()], { type: 'application/json' }));
      a.download = `orbit-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
    };
    $('#import').onchange = async (e) => {
      try { store.import(await e.target.files[0].text()); toast('Backup restored'); } catch { toast('Invalid backup file'); }
    };
    $('#reset').onclick = () => confirm('Erase all courses, events, notes and chats?') && (store.reset(), toast('fresh start'));
  };
  draw();
  // Only re-render on non-text changes to avoid stealing input focus
  const offStore = store.subscribe(() => { if (!el.contains(document.activeElement) || document.activeElement.type === 'checkbox' || document.activeElement.tagName === 'BUTTON') draw(); });
  return () => { offStore(); unmountPicker?.(); };
}

export { COURSE_COLORS };
