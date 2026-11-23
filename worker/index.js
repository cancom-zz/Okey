// Okey: serves the static site and the room API.
//
//   POST /api/rooms              { settings? } -> { code }       create a table (Room Durable Object)
//   GET  /api/rooms/:code        -> { code, phase, settings, seats: [{ kind, name, avatar, connected, bot }],
//                                     connections }               join screen; no hidden information
//   GET  /api/rooms/:code/ws     WebSocket upgrade, handled by the Room (DESIGN.md "Network protocol")
//   GET  /api/stats/:playerId    -> { name, stats, achievements }  (phase 2)
//
// Everything else is a static file from site/ (env.ASSETS).
import { cleanSettings } from '../site/shared/host.js';

export { Room } from './room.js';
export { Stats } from './stats.js';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;
const ID = /^[A-Za-z0-9_-]{8,64}$/;
const CREATE_LIMIT = { count: 20, windowMs: 10 * 60e3 }; // rooms per IP per window (per isolate, best effort)

const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

/** 6 characters from CODE_CHARS. 32 divides 256, so `byte & 31` is unbiased. */
function newCode() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => CODE_CHARS[b & 31]).join('');
}

const created = new Map(); // ip -> [timestamps]
function allowCreate(ip) {
  const now = Date.now();
  if (created.size > 5000) created.clear();
  const list = (created.get(ip) || []).filter((t) => now - t < CREATE_LIMIT.windowMs);
  if (list.length >= CREATE_LIMIT.count) return false;
  list.push(now);
  created.set(ip, list);
  return true;
}

const room = (env, code) => env.ROOM.get(env.ROOM.idFromName(code));

async function api(request, env, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', 'rooms', code?, 'ws'?]

  if (parts[1] === 'rooms' && parts.length === 2) {
    if (request.method !== 'POST') return json({ error: 'Method not allowed.' }, 405);
    if (!allowCreate(request.headers.get('cf-connecting-ip') || 'local')) return json({ error: 'Too many rooms.' }, 429);
    const text = await request.text();
    if (text.length > 2000) return json({ error: 'Bad request.' }, 400);
    let body = {};
    if (text.trim()) {
      try { body = JSON.parse(text); } catch { return json({ error: 'Bad JSON.' }, 400); }
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return json({ error: 'Bad request.' }, 400);
    const settings = cleanSettings(body.settings);
    if (!settings) return json({ error: 'Bad settings.' }, 400);
    for (let i = 0; i < 5; i++) {
      const code = newCode();
      if (await room(env, code).init(code, settings)) return json({ code });
    }
    return json({ error: 'Try again.' }, 503);
  }

  if (parts[1] === 'rooms' && (parts.length === 3 || (parts.length === 4 && parts[3] === 'ws'))) {
    const code = parts[2].toUpperCase();
    if (!CODE.test(code)) return json({ error: 'Bad room code.' }, 400);
    if (parts.length === 4) {
      if (request.method !== 'GET' || request.headers.get('Upgrade') !== 'websocket') return json({ error: 'Expected a WebSocket.' }, 426);
      return room(env, code).fetch(request);
    }
    if (request.method !== 'GET') return json({ error: 'Method not allowed.' }, 405);
    const info = await room(env, code).info();
    return info ? json(info) : json({ error: 'No such room.' }, 404);
  }

  if (parts[1] === 'stats' && parts.length === 3 && request.method === 'GET') {
    if (!ID.test(parts[2])) return json({ error: 'Bad request.' }, 400);
    const res = await env.STATS.get(env.STATS.idFromName('main')).get(parts[2]);
    return res ? json(res) : json({ error: 'No stats yet.' }, 404);
  }

  return json({ error: 'Not found.' }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) {
      try {
        return await api(request, env, url);
      } catch (err) {
        console.error(err?.stack || err);
        return json({ error: 'Something went wrong.' }, 500);
      }
    }
    return env.ASSETS.fetch(request);
  },
};
