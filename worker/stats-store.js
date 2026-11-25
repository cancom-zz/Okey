// The Stats Durable Object's logic, without the Durable Object (so node --test can run it on node:sqlite).
// `sql` is ctx.storage.sql (or an adapter with the same exec(query, ...args) -> { toArray(), one() } shape).
//
//   profiles   (id, secret_hash, name, stats JSON, unlocks JSON id -> ms, updated)
//   transfers  (key = sha256(code), data = AES-GCM(payload) keyed by the code, expires, owner)
//   limits     (key, start, count)                 fixed-window rate limits
//
// Secrets are stored as SHA-256 hex digests and compared in constant time. Rooms already hand over the
// digest (the Room hashes a socket's secret before the TableHost sees it), so summary.seats[].secret is a
// digest; clients send their raw secret, which is hashed here.
import { emptyStats, sanitizeStats, applySummary, unlockedIds, ACHIEVEMENT_IDS } from '../site/shared/achievements.js';
import { safeEqual } from '../site/shared/host.js';

export const TRANSFER_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const TRANSFER_LEN = 8;
export const TRANSFER_TTL = 10 * 60e3;
const enc = new TextEncoder();
const dec = new TextDecoder();

const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
export const sha256hex = async (s) => hex(await crypto.subtle.digest('SHA-256', enc.encode(String(s))));
const b64 = (u8) => btoa(String.fromCharCode(...u8));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** 8 characters from TRANSFER_CHARS (32 divides 256: `byte & 31` is unbiased). */
export function newTransferCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(TRANSFER_LEN));
  return Array.from(bytes, (b) => TRANSFER_CHARS[b & 31]).join('');
}
/** 'abcd-efgh' / 'ABCD EFGH' -> 'ABCDEFGH', or null if it can't be a code. */
export function normalizeCode(s) {
  if (typeof s !== 'string' || s.length > 20) return null;
  const c = s.toUpperCase().replace(/[\s-]/g, '');
  return c.length === TRANSFER_LEN && [...c].every((ch) => TRANSFER_CHARS.includes(ch)) ? c : null;
}

async function codeKey(code) {
  const raw = await crypto.subtle.digest('SHA-256', enc.encode('okey-transfer-key:' + code));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** Only known achievement ids with plausible times. */
export function cleanUnlocks(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const id of ACHIEVEMENT_IDS) {
    const v = raw[id];
    if (typeof v === 'number' && Number.isFinite(v) && v > 1.5e12 && v < 4.1e12) out[id] = Math.floor(v);
  }
  return out;
}

export class StatsStore {
  constructor(sql, { now = () => Date.now() } = {}) {
    this.sql = sql;
    this.now = now;
    sql.exec(`CREATE TABLE IF NOT EXISTS profiles (id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL, name TEXT,
      stats TEXT NOT NULL, unlocks TEXT NOT NULL, updated INTEGER)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS transfers (key TEXT PRIMARY KEY, data TEXT NOT NULL, expires INTEGER NOT NULL,
      owner TEXT NOT NULL)`);
    sql.exec(`CREATE TABLE IF NOT EXISTS limits (key TEXT PRIMARY KEY, start INTEGER NOT NULL, count INTEGER NOT NULL)`);
  }

  profile(id) {
    return this.sql.exec(`SELECT secret_hash, name, stats, unlocks FROM profiles WHERE id = ?`, id).toArray()[0] || null;
  }

  /** A round or match summary from a Room (TableHost onResult; seats[].secret is the secret's digest). */
  record(summary) {
    if (!summary || !Array.isArray(summary.seats) || (summary.type !== 'round' && summary.type !== 'match')) return { ok: false };
    const now = this.now();
    const unlocked = {};
    for (const s of summary.seats) {
      if (s.kind !== 'human' || typeof s.playerId !== 'string' || typeof s.secret !== 'string') continue;
      const row = this.profile(s.playerId);
      if (row && !safeEqual(row.secret_hash, s.secret)) continue; // somebody else's id
      const before = row ? sanitizeStats(JSON.parse(row.stats)) : emptyStats();
      const { stats, unlocked: ids } = applySummary(before, summary, s.seat);
      const unlocks = row ? cleanUnlocks(JSON.parse(row.unlocks)) : {};
      // unlocks follow the stats (they are derived); keep the first time each one was reached
      for (const id of unlockedIds(stats)) if (!unlocks[id]) unlocks[id] = now;
      this.sql.exec(`INSERT INTO profiles (id, secret_hash, name, stats, unlocks, updated) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET name = excluded.name, stats = excluded.stats, unlocks = excluded.unlocks,
        updated = excluded.updated`, s.playerId, s.secret, String(s.name ?? '').slice(0, 40), JSON.stringify(stats),
      JSON.stringify(unlocks), now);
      if (ids.length) unlocked[s.playerId] = ids;
    }
    return { ok: true, unlocked };
  }

  /** The owner's stats: { name, stats, achievements: { id: ms } }; empty when nothing is recorded; null if the secret is wrong. */
  async get(id, secret) {
    const row = this.profile(id);
    if (!row) return { name: null, stats: emptyStats(), achievements: {} };
    if (!safeEqual(row.secret_hash, await sha256hex(secret))) return null;
    return { name: row.name, stats: sanitizeStats(JSON.parse(row.stats)), achievements: cleanUnlocks(JSON.parse(row.unlocks)) };
  }

  /** Fixed-window counter: true while `key` has been hit fewer than `max` times in this window. */
  limit(key, max, windowMs) {
    const now = this.now();
    const row = this.sql.exec(`SELECT start, count FROM limits WHERE key = ?`, key).toArray()[0];
    if (!row || now - row.start >= windowMs) {
      this.sql.exec(`INSERT INTO limits (key, start, count) VALUES (?, ?, 1) ON CONFLICT (key) DO UPDATE SET start = excluded.start, count = 1`, key, now);
      if (Math.random() < 0.01) this.sql.exec(`DELETE FROM limits WHERE start < ?`, now - 864e5);
      return true;
    }
    if (row.count >= max) return false;
    this.sql.exec(`UPDATE limits SET count = count + 1 WHERE key = ?`, key);
    return true;
  }

  /**
   * A one-time transfer code for { id, secret, name, avatar, practice } (validated by the caller). The code is
   * the only key: the row is stored under its digest and encrypted with a key derived from it.
   * Returns { code, expires }, or { error: 'forbidden' } when the id belongs to another secret.
   */
  async createTransfer(payload) {
    const now = this.now();
    this.sql.exec(`DELETE FROM transfers WHERE expires < ?`, now);
    const row = this.profile(payload.id);
    if (row && !safeEqual(row.secret_hash, await sha256hex(payload.secret))) return { error: 'forbidden' };
    // one live code per identity: a new one replaces the old
    this.sql.exec(`DELETE FROM transfers WHERE owner = ?`, await sha256hex('owner:' + payload.id));
    const code = newTransferCode();
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await codeKey(code), enc.encode(JSON.stringify(payload))));
    const data = new Uint8Array(iv.length + ct.length);
    data.set(iv);
    data.set(ct, iv.length);
    const expires = now + TRANSFER_TTL;
    this.sql.exec(`INSERT OR REPLACE INTO transfers (key, data, expires, owner) VALUES (?, ?, ?, ?)`,
      await sha256hex('code:' + code), b64(data), expires, await sha256hex('owner:' + payload.id));
    return { code, expires };
  }

  /** Redeem a code once: the payload, or null (unknown, used or expired). */
  async claimTransfer(code) {
    const now = this.now();
    const key = await sha256hex('code:' + code);
    const row = this.sql.exec(`SELECT data, expires FROM transfers WHERE key = ?`, key).toArray()[0];
    if (!row) return null;
    this.sql.exec(`DELETE FROM transfers WHERE key = ?`, key); // single use, even if it turns out expired
    if (row.expires < now) return null;
    try {
      const data = unb64(row.data);
      const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.slice(0, 12) }, await codeKey(code), data.slice(12));
      return JSON.parse(dec.decode(pt));
    } catch {
      return null;
    }
  }
}
