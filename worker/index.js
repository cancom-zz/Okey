// Okey: serves the static site and the room API.
//
//   POST /api/rooms              { settings? } -> { code }       create a table (Room Durable Object)
//   GET  /api/rooms/:code        -> { code, phase, settings, seats: [{ kind, name, avatar, connected, bot }],
//                                     connections }               join screen; no hidden information
//   GET  /api/rooms/:code/ws     WebSocket upgrade, handled by the Room (DESIGN.md "Network protocol")
//   POST /api/stats              { id, secret } -> { name, stats, achievements: { id: ms } }   your own only
//   POST /api/transfer           { id, secret, name, avatar, practice: { stats, ach } } -> { code, expires }
//   POST /api/transfer/claim     { code } -> { id, secret, name, avatar, practice }     one time, 10 minutes
//
// Everything else is a static file from site/ (env.ASSETS; site/_headers sets CSP and friends).
//
// Security: a browser Origin header must be this site (or localhost / 127.0.0.1 for `wrangler dev`) for
// WebSockets and POSTs; request bodies are size-capped; rate limits live in the Stats Durable Object
// (fixed windows keyed by a digest of the client IP, never the IP itself).
import { cleanSettings, cleanName, AVATARS } from '../site/shared/host.js';
import { sanitizeStats } from '../site/shared/achievements.js';
import { sha256hex, normalizeCode, cleanUnlocks } from './stats-store.js';
import { originOk, readBody as body } from './security.js';

export { Room } from './room.js';
export { Stats } from './stats.js';

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/;
const ID = /^[A-Za-z0-9_-]{8,64}$/;
const HOUR = 3600e3;
const LIMITS = {
  room: [30, HOUR], roomAll: [3000, HOUR],               // rooms per IP / for everyone
  stats: [300, 10 * 60e3],                               // stats reads per IP
  transfer: [10, HOUR], transferId: [5, HOUR],           // codes made per IP / per identity
  claim: [10, 10 * 60e3],                                // code redemptions per IP (guessing)
};

const HEADERS = {
  'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
  'x-content-type-options': 'nosniff', 'referrer-policy': 'strict-origin-when-cross-origin',
};
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: HEADERS });

/** 6 characters from CODE_CHARS. 32 divides 256, so `byte & 31` is unbiased. */
function newCode() {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => CODE_CHARS[b & 31]).join('');
}

const room = (env, code) => env.ROOM.get(env.ROOM.idFromName(code));
const stats = (env) => env.STATS.get(env.STATS.idFromName('main'));
const ipKey = async (request) => (await sha256hex('ip:' + (request.headers.get('cf-connecting-ip') || 'local'))).slice(0, 32);
const limited = async (env, list) => !(await stats(env).limits(list.map(([key, [max, ms]]) => [key, max, ms])));

async function api(request, env, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', 'rooms', code?, 'ws'?]
  if (!originOk(request, url, env)) return json({ error: 'Forbidden.' }, 403);
  const post = request.method === 'POST';

  if (parts[1] === 'rooms' && parts.length === 2) {
    if (!post) return json({ error: 'Method not allowed.' }, 405);
    const b = await body(request, 2000);
    if (!b) return json({ error: 'Bad request.' }, 400);
    const settings = cleanSettings(b.settings);
    if (!settings) return json({ error: 'Bad settings.' }, 400);
    const ip = await ipKey(request);
    if (await limited(env, [['room:' + ip, LIMITS.room], ['room:*', LIMITS.roomAll]])) return json({ error: 'Too many rooms.' }, 429);
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

  if (parts[1] === 'stats' && parts.length === 2) {
    if (!post) return json({ error: 'Method not allowed.' }, 405);
    const b = await body(request, 500);
    if (!b || !ID.test(b.id || '') || !ID.test(b.secret || '')) return json({ error: 'Bad request.' }, 400);
    if (await limited(env, [['stats:' + await ipKey(request), LIMITS.stats]])) return json({ error: 'Too many requests.' }, 429);
    const res = await stats(env).get(b.id, b.secret);
    return res ? json(res) : json({ error: 'Forbidden.' }, 403);
  }

  if (parts[1] === 'transfer' && parts.length === 2) {
    if (!post) return json({ error: 'Method not allowed.' }, 405);
    const b = await body(request, 32_000);
    if (!b || !ID.test(b.id || '') || !ID.test(b.secret || '')) return json({ error: 'Bad request.' }, 400);
    const ip = await ipKey(request);
    if (await limited(env, [['transfer:' + ip, LIMITS.transfer], ['transferId:' + await sha256hex(b.id), LIMITS.transferId]])) {
      return json({ error: 'Too many requests.' }, 429);
    }
    const payload = {
      id: b.id, secret: b.secret, name: cleanName(b.name) || null, avatar: AVATARS.includes(b.avatar) ? b.avatar : null,
      practice: { stats: sanitizeStats(b.practice?.stats), ach: cleanUnlocks(b.practice?.ach) },
    };
    const res = await stats(env).createTransfer(payload);
    return res.error ? json({ error: 'Forbidden.' }, 403) : json(res);
  }

  if (parts[1] === 'transfer' && parts.length === 3 && parts[2] === 'claim') {
    if (!post) return json({ error: 'Method not allowed.' }, 405);
    const b = await body(request, 200);
    if (!b) return json({ error: 'Bad request.' }, 400);
    if (await limited(env, [['claim:' + await ipKey(request), LIMITS.claim]])) return json({ error: 'Too many requests.' }, 429);
    const code = normalizeCode(b.code);
    const res = code ? await stats(env).claimTransfer(code) : null;
    return res ? json(res) : json({ error: 'No such code.' }, 404);
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
