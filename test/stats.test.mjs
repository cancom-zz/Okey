// The Stats Durable Object's logic (worker/stats-store.js) on node:sqlite: recording, secrets at rest,
// reading your own stats, one-time transfer codes, rate limits; plus the request checks (worker/security.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { StatsStore, sha256hex, normalizeCode, newTransferCode, TRANSFER_TTL, cleanUnlocks } from '../worker/stats-store.js';
import { originOk, readBody } from '../worker/security.js';
import { emptyStats, applySummary } from '../site/shared/achievements.js';
import { safeEqual } from '../site/shared/host.js';

/** ctx.storage.sql on top of node:sqlite. */
function sqlAdapter() {
  const db = new DatabaseSync(':memory:');
  return {
    db,
    exec(q, ...args) {
      const st = db.prepare(q);
      const rows = /^\s*SELECT/i.test(q) ? st.all(...args) : (st.run(...args), []);
      return { toArray: () => rows, one: () => rows[0] };
    },
  };
}

const ID = 'device-id-0001';
const SECRET = 'device-secret-0001';
const human = (seat, secretHash, o = {}) => ({ seat, kind: 'human', playerId: ID, secret: secretHash, name: 'Can', botLevel: null, won: false, finish: null, okeyFinish: false, delta: 0, score: 20, turns: 7, showedIndicator: false, ...o });
const bot = (seat, o = {}) => ({ seat, kind: 'bot', playerId: null, secret: null, name: 'Ali', botLevel: 'uzman', won: false, delta: -2, score: 18, turns: 7, ...o });

test('secrets are stored as digests; summaries with another secret are ignored', async () => {
  const sql = sqlAdapter();
  let now = 1.8e12;
  const store = new StatsStore(sql, { now: () => now });
  const h = await sha256hex(SECRET);
  assert.match(h, /^[0-9a-f]{64}$/);
  const r = store.record({ type: 'round', variant: 'classic', winner: 0, seats: [human(0, h, { won: true, finish: 'sets', turns: 3 }), bot(1), bot(2), bot(3)] });
  assert.deepEqual(r.unlocked[ID].sort(), ['hizli_el', 'ilk_zafer']);
  const row = sql.db.prepare('SELECT * FROM profiles').get();
  assert.equal(row.secret_hash, h);
  assert.ok(!JSON.stringify(row).includes(SECRET), 'no clear secret at rest');
  // a forged summary for the same id with another secret changes nothing
  store.record({ type: 'round', variant: 'classic', winner: 0, seats: [human(0, await sha256hex('another-secret'), { won: true }), bot(1), bot(2), bot(3)] });
  const mine = await store.get(ID, SECRET);
  assert.equal(mine.stats.classic.rounds, 1);
  assert.equal(mine.name, 'Can');
  assert.equal(mine.achievements.ilk_zafer, now);
  assert.equal(await store.get(ID, 'wrong-secret-xx'), null, 'wrong secret: nothing');
  const nobody = await store.get('unknown-device', 'whatever-secret');
  assert.deepEqual(nobody.stats, emptyStats());
  // the stored stats equal applying the same summary locally (one module, same rules)
  const local = applySummary(emptyStats(), { type: 'round', variant: 'classic', winner: 0, seats: [human(0, h, { won: true, finish: 'sets', turns: 3 }), bot(1), bot(2), bot(3)] }, 0).stats;
  assert.deepEqual(mine.stats, local);
  // unlock times stay the first ones
  now += 1000;
  store.record({ type: 'round', variant: 'classic', winner: 0, seats: [human(0, h, { won: true }), bot(1), bot(2), bot(3)] });
  assert.equal((await store.get(ID, SECRET)).achievements.ilk_zafer, now - 1000);
  assert.ok(safeEqual('abc', 'abc') && !safeEqual('abc', 'abd') && !safeEqual('abc', 'ab') && !safeEqual(null, 'x'));
});

test('transfer codes: 8 characters, encrypted at rest, one use, 10 minutes, one live code per identity', async () => {
  const sql = sqlAdapter();
  let now = 1.8e12;
  const store = new StatsStore(sql, { now: () => now });
  const payload = { id: ID, secret: SECRET, name: 'Can', avatar: '🦊', practice: { stats: emptyStats(), ach: { ilk_zafer: 1.8e12 } } };
  const { code, expires } = await store.createTransfer(payload);
  assert.match(code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
  assert.equal(expires, now + TRANSFER_TTL);
  const raw = JSON.stringify(sql.db.prepare('SELECT * FROM transfers').all());
  for (const s of [SECRET, ID, code, 'Can']) assert.ok(!raw.includes(s), `"${s}" is not readable at rest`);
  assert.deepEqual(await store.claimTransfer(code), payload);
  assert.equal(await store.claimTransfer(code), null, 'single use');
  // expiry
  const t2 = await store.createTransfer(payload);
  now += TRANSFER_TTL + 1;
  assert.equal(await store.claimTransfer(t2.code), null, 'expired');
  // a newer code replaces the older one
  const a = await store.createTransfer(payload);
  const b = await store.createTransfer(payload);
  assert.equal(await store.claimTransfer(a.code), null);
  assert.equal((await store.claimTransfer(b.code)).id, ID);
  // an identity with recorded stats needs its own secret to make a code
  store.record({ type: 'round', variant: 'classic', winner: null, seats: [human(0, await sha256hex(SECRET)), bot(1), bot(2), bot(3)] });
  assert.deepEqual(await store.createTransfer({ ...payload, secret: 'not-the-secret' }), { error: 'forbidden' });
  assert.ok((await store.createTransfer(payload)).code);
  // codes
  assert.equal(normalizeCode('abcd-efgh'), 'ABCDEFGH');
  assert.equal(normalizeCode(' ab cd ef gh '), 'ABCDEFGH');
  assert.equal(normalizeCode('ABCDEFG1'), null, '1 is not in the alphabet');
  assert.equal(normalizeCode('ABC'), null);
  assert.equal(normalizeCode({}), null);
  assert.equal(new Set(Array.from({ length: 200 }, newTransferCode)).size, 200);
  assert.deepEqual(cleanUnlocks({ ilk_zafer: 1.8e12, bogus: 1.8e12, elden: 'x', yuz_el: 5 }), { ilk_zafer: 1.8e12 });
});

test('rate limits: fixed windows', () => {
  let now = 1.8e12;
  const store = new StatsStore(sqlAdapter(), { now: () => now });
  for (let i = 0; i < 3; i++) assert.equal(store.limit('k', 3, 1000), true);
  assert.equal(store.limit('k', 3, 1000), false);
  assert.equal(store.limit('other', 3, 1000), true);
  now += 1000;
  assert.equal(store.limit('k', 3, 1000), true, 'a new window');
});

test('origin check and body limits', async () => {
  const url = new URL('https://okey.example.workers.dev/api/rooms');
  const req = (origin) => new Request(url, { method: 'POST', headers: origin ? { Origin: origin } : {} });
  assert.equal(originOk(req('https://okey.example.workers.dev'), url), true);
  assert.equal(originOk(req(null), url), true, 'not a browser');
  assert.equal(originOk(req('http://localhost:8787'), url), true);
  assert.equal(originOk(req('http://127.0.0.1:5173'), url), true);
  assert.equal(originOk(req('https://evil.example'), url), false);
  assert.equal(originOk(req('https://okey.example.workers.dev.evil.example'), url), false);
  assert.equal(originOk(req('null'), url), false);
  assert.equal(originOk(req('https://okey.app'), url, { ALLOWED_ORIGINS: 'https://okey.app, https://www.okey.app' }), true);
  const post = (text) => new Request(url, { method: 'POST', body: text });
  assert.deepEqual(await readBody(post('{"a":1}'), 100), { a: 1 });
  assert.deepEqual(await readBody(post(''), 100), {});
  assert.equal(await readBody(post('[1]'), 100), null);
  assert.equal(await readBody(post('nope'), 100), null);
  assert.equal(await readBody(post('{"a":"' + 'x'.repeat(200) + '"}'), 100), null);
});
