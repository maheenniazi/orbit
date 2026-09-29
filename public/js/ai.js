// Client for the server AI proxy. Falls back gracefully when no key is configured.
let status = { ai: false, provider: null, model: null, spotifyClientId: null };

export async function loadStatus() {
  try {
    status = await (await fetch('/api/status')).json();
  } catch {
    /* offline */
  }
  return status;
}
export const getStatus = () => status;
export const aiEnabled = () => status.ai;

export async function ask({ system, messages, maxTokens }) {
  const r = await fetch('/api/ai', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ system, messages, maxTokens }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `AI request failed (${r.status})`);
  return data.text;
}
