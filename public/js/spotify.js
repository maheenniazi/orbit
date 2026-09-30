// Spotify: persistent embed player (no login needed) + optional account connect (PKCE OAuth)
// for now-playing, playback controls and your own playlists.
import { store } from './store.js';
import { getStatus } from './ai.js';
import { esc } from './util.js';
import { toast } from './ui.js';

const TK = 'studyos:spotify';
const SCOPES = 'user-read-playback-state user-modify-playback-state user-read-currently-playing playlist-read-private';
const redirectUri = () => `${location.origin}/callback`;
const API = 'https://api.spotify.com/v1';

export function parsePlaylistId(input = '') {
  const m = input.match(/playlist[/:]([A-Za-z0-9]{22})/) || input.trim().match(/^([A-Za-z0-9]{22})$/);
  return m ? m[1] : null;
}

// ---- Persistent dock (lives in the sidebar, never re-rendered by views) ----
let dockId = null;
export function loadDock(playlistId) {
  const dock = document.getElementById('player-dock');
  if (!dock || !playlistId || dockId === playlistId) return;
  dockId = playlistId;
  dock.innerHTML = `<iframe class="spotify-embed" title="Spotify player" src="https://open.spotify.com/embed/playlist/${esc(playlistId)}?utm_source=generator&theme=0" height="152" allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture" loading="lazy"></iframe>`;
}
export const dockPlaylist = () => dockId;

// ---- OAuth (PKCE, no client secret needed) ----
const tokens = () => JSON.parse(localStorage.getItem(TK) || 'null');
const saveTokens = (d, prev = {}) =>
  localStorage.setItem(TK, JSON.stringify({ access: d.access_token, refresh: d.refresh_token || prev.refresh, exp: Date.now() + d.expires_in * 1000 }));
export const isConnected = () => Boolean(tokens());
export function disconnect() {
  localStorage.removeItem(TK);
  toast('Spotify disconnected');
}

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export async function connect() {
  const clientId = getStatus().spotifyClientId;
  if (!clientId) return toast('Add SPOTIFY_CLIENT_ID to your .env to connect an account (see README)', { timeout: 7000 });
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  localStorage.setItem(TK + ':verifier', verifier);
  location.href = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
    client_id: clientId, response_type: 'code', redirect_uri: redirectUri(), scope: SCOPES,
    code_challenge_method: 'S256', code_challenge: challenge,
  });
}

export async function handleCallback() {
  const p = new URLSearchParams(location.search);
  history.replaceState(null, '', '/#/settings');
  if (p.get('error')) return toast(p.get('error') === 'access_denied' ? 'Spotify connect was cancelled' : `Spotify: ${p.get('error')}`, { timeout: 8000 });
  const code = p.get('code');
  const verifier = localStorage.getItem(TK + ':verifier');
  if (!code || !verifier) return;
  try {
    const r = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: getStatus().spotifyClientId, grant_type: 'authorization_code', code, redirect_uri: redirectUri(), code_verifier: verifier }),
    });
    const d = await r.json();
    if (!r.ok) {
      const why = d.error_description || d.error || '';
      throw new Error(/redirect/i.test(why)
        ? `redirect URI mismatch. In the Spotify dashboard it must be exactly ${redirectUri()}`
        : /client/i.test(why) ? 'wrong SPOTIFY_CLIENT_ID. Copy it again from the Spotify dashboard' : why);
    }
    saveTokens(d);
    localStorage.removeItem(TK + ':verifier');
    toast('Spotify connected 🎧');
  } catch (e) {
    toast(`Spotify connect failed: ${e.message}`);
  }
}

async function accessToken() {
  const t = tokens();
  if (!t) return null;
  if (Date.now() < t.exp - 60_000) return t.access;
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: t.refresh, client_id: getStatus().spotifyClientId }),
  });
  if (!r.ok) { localStorage.removeItem(TK); return null; }
  const d = await r.json();
  saveTokens(d, t);
  return d.access_token;
}

export async function api(path, { method = 'GET', body } = {}) {
  const token = await accessToken();
  if (!token) throw new Error('Not connected');
  const r = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 204 || r.status === 202) return null;
  const text = await r.text();
  const data = text ? JSON.parse(text) : null;
  if (!r.ok) {
    const err = new Error(data?.error?.message || `Spotify ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return data;
}

async function playOnDevice(playlistId) {
  try {
    await api('/me/player/play', { method: 'PUT', body: { context_uri: `spotify:playlist:${playlistId}` } });
    toast('Playing on your Spotify device');
  } catch (e) {
    loadDock(playlistId);
    toast(e.status === 404 ? 'No active Spotify device, so it\'s loaded in the sidebar player instead' : e.status === 403 ? 'Remote control needs Spotify Premium, so it\'s loaded in the sidebar player' : e.message);
  }
}

// ---- Panel used on Focus + Home ----
export function renderSpotify(el, modeKey = 'chill') {
  const pls = store.get().settings.playlists;
  if (!dockId) loadDock(pls[modeKey]?.id);
  const connected = isConnected();
  const modeLabels = { chill: 'Cruise / Warm-up', rampup: 'Ramp-up', lockin: 'Lock-in', examday: 'Exam day' };

  el.innerHTML = `
    ${connected ? `<div class="now-playing" id="np"><img alt=""><div><div class="t muted">Loading…</div><div class="small muted"></div></div></div>
      <div class="player-controls"><button class="icon-btn" data-c="previous" title="Previous">⏮</button><button class="icon-btn" data-c="toggle" title="Play/Pause">⏯</button><button class="icon-btn" data-c="next" title="Next">⏭</button></div>` : ''}
    <div class="small muted" style="margin:${connected ? '14px' : '0'} 0 8px">Mode playlists ${connected ? '' : '· plays in the sidebar'}</div>
    <div class="playlist-grid">
      ${Object.entries(pls).map(([k, p]) => `<button class="pl-btn ${dockId === p.id ? 'on' : ''}" data-pl="${esc(p.id)}"><b>${esc(p.name)}</b><small>${modeLabels[k] || k}${k === modeKey ? ' · now' : ''}</small></button>`).join('')}
    </div>
    <div id="mine"></div>
    ${connected ? '' : `<div class="row spread" style="margin-top:14px"><span class="small muted">Connect to see what's playing, control playback & use your playlists.</span><button class="btn spotify sm" id="sp-connect">Connect Spotify</button></div>`}
  `;

  el.querySelectorAll('[data-pl]').forEach((b) => (b.onclick = () => {
    if (connected) playOnDevice(b.dataset.pl);
    else loadDock(b.dataset.pl);
    el.querySelectorAll('.pl-btn').forEach((x) => x.classList.toggle('on', x === b));
  }));
  el.querySelector('#sp-connect')?.addEventListener('click', connect);
  if (!connected) return;

  el.querySelectorAll('[data-c]').forEach((b) => (b.onclick = async () => {
    try {
      const c = b.dataset.c;
      if (c === 'toggle') {
        const st = await api('/me/player');
        await api(st?.is_playing ? '/me/player/pause' : '/me/player/play', { method: 'PUT' });
      } else await api(`/me/player/${c}`, { method: 'POST' });
      setTimeout(poll, 400);
    } catch (e) {
      toast(e.status === 403 ? 'Playback control requires Spotify Premium' : e.status === 404 ? 'Open Spotify on a device first' : e.message);
    }
  }));

  const poll = async () => {
    const np = el.querySelector('#np');
    if (!np || !np.isConnected) return false;
    try {
      const d = await api('/me/player/currently-playing');
      const item = d?.item;
      np.querySelector('img').src = item?.album?.images?.[1]?.url || item?.album?.images?.[0]?.url || '';
      np.querySelector('.t').textContent = item ? item.name : 'Nothing playing';
      np.querySelector('.t').classList.toggle('muted', !item);
      np.querySelector('.small').textContent = item ? item.artists.map((a) => a.name).join(', ') + (d.is_playing ? '' : ' · paused') : 'Start something on any device';
    } catch (e) {
      np.querySelector('.t').textContent = e.status === 403
        ? 'Spotify blocked access: the app owner needs Premium, and your account must be added under User Management in the Spotify dashboard'
        : e.status === 401 ? 'Session expired, reconnect in Settings' : e.message;
    }
    return true;
  };
  poll();
  const iv = setInterval(async () => { if (!(await poll())) clearInterval(iv); }, 6000);

  api('/me/playlists?limit=12')
    .then((d) => {
      const mine = el.querySelector('#mine');
      if (!mine || !d?.items?.length) return;
      mine.innerHTML = `<div class="small muted" style="margin:14px 0 8px">Your playlists</div><div class="playlist-grid">${d.items.filter(Boolean).map((p) => `<button class="pl-btn" data-mine="${esc(p.id)}"><b>${esc(p.name)}</b><small>${p.tracks?.total ?? ''} tracks</small></button>`).join('')}</div>`;
      mine.querySelectorAll('[data-mine]').forEach((b) => (b.onclick = () => playOnDevice(b.dataset.mine)));
    })
    .catch(() => {});
}
