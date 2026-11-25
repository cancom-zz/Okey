// SECURITY, 101 online: two humans, two bots and a spectator play a 101 match through TableHost. Every
// message is checked at the moment it is sent against the true match: no other hand, no pile tile, no
// buried discard; only whitelisted view fields; private events only to their seat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as classic from '../site/shared/okey/index.js';
import * as e101 from '../site/shared/okey101/index.js';
import { TableHost, AVATARS } from '../site/shared/host.js';

const T0 = 1_800_000_000_000;
const ident = (n) => ({ id: `player-${n}-id`, secret: `secret-${n}-xyz`, name: `Oyuncu ${n}`, avatar: AVATARS[n] });

test('SECURITY 101: no message carries a tile its seat may not see', () => {
  // Wrap the 101 engine to learn which tiles became public, at the moment each message is sent.
  let publicTiles = new Set();
  const note = (events) => {
    for (const e of events) {
      if (e.type === 'roundStart') publicTiles = new Set([e.indicator]);
      if (e.to !== undefined) continue;
      const add = (t) => { if (Number.isInteger(t)) publicTiles.add(t); };
      if (['discard', 'take', 'undoTake', 'showIndicator'].includes(e.type)) add(e.tile);
      if (e.type === 'draw' && e.from === 'discard') add(e.tile);
      if (e.type === 'layDown') for (const m of e.melds || []) (m.tiles || []).forEach(add);
      if (e.type === 'addToSet') { add(e.tile); (e.tiles || []).forEach(add); }
      if (e.type === 'swapOkey') { add(e.tile); add(e.okey); }
    }
  };
  const wrap = (fn) => (...args) => { const r = fn(...args); note(r.events); return r; };
  const eng = { ...e101, act: wrap(e101.act), startRound: wrap(e101.startRound), nextRound: wrap(e101.nextRound) };

  const NON_TILE = new Set(['v', 'now', 'number', 'round', 'dealer', 'turn', 'pileCount', 'turnEndsAt', 'count', 'handCount',
    'score', 'scores', 'deltas', 'seat', 'to', 'except', 'winner', 'winners', 'host', 'you', 'color', 'num', 'turnSeconds',
    'rounds', 'startPoints', 'turns', 'owner', 'start', 'index', 'meld', 'value', 'pairs', 'points', 'penalties',
    'multiplier', 'required', 'openingValue', 'minPairs', 'aceHighValue']);
  const VIEW_KEYS = ['v', 'code', 'phase', 'settings', 'host', 'you', 'seats', 'round', 'hand', 'result', 'winners', 'now'].sort();
  const ROUND_KEYS = ['number', 'dealer', 'turn', 'stage', 'indicator', 'okey', 'pileCount', 'turnEndsAt', 'firstTurn',
    'table', 'opened', 'openings', 'required', 'penalties', 'taken'].sort();
  const MELD_KEYS = new Set(['owner', 'kind', 'tiles', 'color', 'start', 'num']);
  const seatOf = { a: 0, b: 2, spec: null };
  let checked = 0;
  let views = 0;
  const tilesIn = (x, key, out) => {
    if (typeof x === 'number') { if (!NON_TILE.has(key)) out.push(x); } else if (Array.isArray(x)) x.forEach((y) => tilesIn(y, key, out));
    else if (x && typeof x === 'object') for (const [k, y] of Object.entries(x)) { if (k !== 'settings' && k !== 'scoring' && k !== 'opening' && k !== 'openings') tilesIn(y, k, out); }
    return out;
  };

  const onSend = (connId, msg, host) => {
    if (!(connId in seatOf)) return;
    const seat = seatOf[connId];
    const m = host.match;
    if (msg.t === 'view') {
      views += 1;
      const view = msg.view;
      assert.deepEqual(Object.keys(view).sort(), VIEW_KEYS);
      if (view.round) {
        assert.deepEqual(Object.keys(view.round).sort(), ROUND_KEYS);
        for (const meld of view.round.table) for (const k of Object.keys(meld)) assert.ok(MELD_KEYS.has(k), `meld key ${k}`);
      }
      if (seat === null) assert.equal(view.hand, null);
      if (view.phase !== 'lobby') assert.equal(view.you, seat);
    }
    if (!m || m.phase !== 'playing') return; // round over: hands are revealed on purpose
    const r = m.round;
    if (msg.t === 'view') {
      const view = msg.view;
      assert.equal(view.result, null);
      for (let i = 0; i < 4; i++) {
        assert.equal(view.seats[i].discard.top, r.discards[i].at(-1) ?? null, 'only the top of a stack');
        assert.equal(view.seats[i].handCount, r.hands[i].length);
      }
      if (seat !== null) assert.deepEqual([...view.hand].sort(), [...r.hands[seat]].sort());
      assert.equal(JSON.stringify(view).includes('"undo"'), false, 'the secret undo state never leaves');
    }
    const allowed = new Set(publicTiles);
    if (seat !== null) r.hands[seat].forEach((t) => allowed.add(t));
    for (const t of tilesIn(msg, null, [])) {
      assert.ok(allowed.has(t), `seat ${seat} was sent tile ${t} (${JSON.stringify(msg).slice(0, 300)})`);
      checked += 1;
    }
    for (const e of msg.events || []) {
      if (e.type === 'dealt' || (e.type === 'draw' && e.from === 'pile' && 'tile' in e)) assert.equal(e.to, seat);
      assert.ok(!('hands' in e) || e.type === 'finish' || e.type === 'pileEmpty');
    }
  };

  const h = { t: T0, wakeAt: null, log: [] };
  h.host = new TableHost({
    code: 'SEC101', settings: { variant: '101', rounds: 2, turnSeconds: 15 }, rng: classic.seededRng(101), engine: eng,
    now: () => h.t, schedule: (at) => { h.wakeAt = at; },
    send: (connId, msg) => { const c = JSON.parse(JSON.stringify(msg)); onSend(connId, c, h.host); h.log.push([connId, c]); },
  });
  const view = (id) => h.log.filter(([c, m]) => c === id && m.t === 'view').at(-1)?.[1].view;
  const say = (id, msg) => { h.t += 250; h.host.message(id, msg); };
  for (const [id, n] of [['a', 1], ['b', 2], ['spec', 3]]) { h.host.connect(id); say(id, { t: 'hello', player: ident(n) }); }
  say('a', { t: 'sit', seat: 0 });
  say('b', { t: 'sit', seat: 2 });
  say('a', { t: 'addBot', seat: 1, level: 'uzman' });
  say('a', { t: 'addBot', seat: 3, level: 'kalfa' });
  say('a', { t: 'start' });
  assert.equal(view('a').settings.variant, '101');
  // a plays legal 101 steps (auto-play's choice: draw, open, lay off, discard); b always runs out of time
  for (let i = 0; i < 50_000; i++) {
    const va = view('a');
    if (va.phase === 'matchEnd') break;
    if (va.phase === 'playing' && va.round.turn === 0) {
      const action = e101.timeoutAction(h.host.match, 0);
      if (action) { say('a', { t: 'act', action, v: va.v }); continue; }
    }
    if (va.phase === 'roundEnd' && !va.seats[0].ready) { say('a', { t: 'next' }); continue; }
    if (va.phase === 'roundEnd' && !view('b').seats[2].ready) { say('b', { t: 'next' }); continue; }
    h.t = Math.max(h.t, h.wakeAt);
    h.host.wake();
  }
  assert.equal(view('a').phase, 'matchEnd');
  assert.ok(views > 200, `views checked: ${views}`);
  assert.ok(checked > 1000, `tiles checked: ${checked}`);
  for (const [c, m] of h.log) if (c === 'spec') for (const e of m.events || []) assert.equal(e.to, undefined);
});
