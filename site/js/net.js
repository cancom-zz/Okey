// One interface to a table, wherever it runs: { connect(), send(msg), onmessage(msg), close() }.
//   online: WebSocket to /api/rooms/:code/ws (the Room Durable Object), with reconnect + ping.
//   solo:   LocalTable (site/js/local.js) running the same TableHost in the page; the mock until that exists.

const params = new URLSearchParams(location.search);
export const useMock = params.has('mock');
export const mockScenario = params.get('scenario') || '';
const mockFast = params.get('fast') === '1';

export async function createRoom(settings) {
  if (useMock) return { code: 'TEST42' };
  const res = await fetch('/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ settings: settings || {} }) });
  if (!res.ok) throw new Error('http ' + res.status);
  const j = await res.json();
  if (!j || typeof j.code !== 'string') throw new Error('bad response');
  return j;
}

// Practice: LocalTable sits you down, seats three bots, starts, and says hello itself (selfHello).
// resume: continue the table saved in localStorage after a reload.
export async function soloTransport(opts) {
  if (!useMock) {
    const m = await import('./local.js');
    const tr = m.createSoloTable({ name: opts.player.name, avatar: opts.player.avatar, levels: opts.levels, settings: opts.settings, resume: !!opts.resume });
    tr.selfHello = true;
    return tr;
  }
  const { createMockTable } = await import('./mock.js');
  return createMockTable({ code: 'SOLO', scenario: mockScenario, fast: mockFast, settings: opts && opts.settings });
}

export async function hasSoloTable() {
  if (useMock) return false;
  try { return (await import('./local.js')).hasSoloTable(); } catch { return false; }
}

export async function roomTransport(code) {
  if (useMock) {
    const { createMockTable } = await import('./mock.js');
    return createMockTable({ code, scenario: mockScenario || 'lobby', fast: mockFast });
  }
  // Ask first, so a dead link gets a clear message instead of a socket that never opens.
  const res = await fetch(`/api/rooms/${encodeURIComponent(code)}`).catch(() => null);
  if (res && res.status === 404) { const e = new Error('noRoom'); e.code = 'noRoom'; throw e; }
  return wsTransport(code);
}

// WebSocket with automatic reconnect (backoff 0.5s → 8s) and a keep-alive ping. onstatus('open'|'reconnecting'|'closed').
function wsTransport(code) {
  let ws = null, closed = false, tries = 0, pingT = 0, retryT = 0;
  const tr = { onmessage: null, onopen: null, onstatus: null, connect, send, close };
  const url = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/rooms/${encodeURIComponent(code)}/ws`;
  const status = s => { try { tr.onstatus && tr.onstatus(s); } catch { /* ignore */ } };
  function connect() {
    if (closed) return;
    try { ws = new WebSocket(url()); } catch { schedule(); return; }
    ws.onopen = () => {
      tries = 0; status('open');
      try { tr.onopen && tr.onopen(); } catch (e) { console.error(e); }
      clearInterval(pingT); pingT = setInterval(() => send({ t: 'ping' }), 25000);
    };
    ws.onmessage = e => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (m && typeof m === 'object') tr.onmessage && tr.onmessage(m);
    };
    ws.onclose = ev => {
      clearInterval(pingT);
      if (closed) return;
      // 4004 room gone, 4001 room full, 4002 this identity opened the table elsewhere: don't fight over it
      const final = { 4004: 'gone', 4404: 'gone', 4001: 'full', 4002: 'replaced' }[ev && ev.code];
      if (final) { closed = true; status(final); return; }
      status('reconnecting'); schedule();
    };
    ws.onerror = () => { /* onclose follows */ };
  }
  function schedule() { clearTimeout(retryT); retryT = setTimeout(connect, Math.min(8000, 500 * 2 ** tries++)); }
  function send(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }
  function close() { closed = true; clearInterval(pingT); clearTimeout(retryT); if (ws) try { ws.close(1000); } catch { /* ignore */ } status('closed'); }
  return tr;
}
