// TableHost with the 101 variant (node --test). No 101 bots exist yet: bot seats are auto-played with the
// engine's timeoutAction, and here the human never acts either, so the whole match runs on auto-play.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as E101 from '../site/shared/okey101/index.js';
import { seededRng } from '../site/shared/okey/rng.js';
import { TableHost, AVATARS, cleanSettings, cleanAction } from '../site/shared/host.js';

const T0 = 1_800_000_000_000;
const ident = (n) => ({ id: `player-${n}-id`, secret: `secret-${n}-xyz`, name: `Oyuncu ${n}`, avatar: AVATARS[n % AVATARS.length] });

function harness({ seed = 7, settings, saved, onSend } = {}) {
  const h = { t: T0, wakeAt: null, log: [], results: [] };
  h.make = (snap) => new TableHost({
    code: 'ABCDEF', settings, saved: snap, rng: seededRng(seed),
    now: () => h.t,
    schedule: (at) => { h.wakeAt = at; },
    send: (connId, msg) => {
      const m = JSON.parse(JSON.stringify(msg));
      if (onSend) onSend(connId, m, h.host);
      h.log.push([connId, m]);
    },
    onResult: (s) => h.results.push(JSON.parse(JSON.stringify(s))),
  });
  h.host = h.make(saved);
  h.msgs = (id) => h.log.filter(([c]) => c === id).map(([, m]) => m);
  h.view = (id) => h.msgs(id).filter((m) => m.t === 'view').at(-1)?.view;
  h.errors = (id) => h.msgs(id).filter((m) => m.t === 'error').map((m) => m.code);
  h.say = (id, msg) => { h.t += 250; h.host.message(id, msg); };
  h.join = (id, n) => { h.host.connect(id); h.say(id, { t: 'hello', player: ident(n), lang: 'tr' }); };
  h.step = () => {
    if (h.wakeAt === null) return false;
    h.t = Math.max(h.t, h.wakeAt);
    h.host.wake();
    return true;
  };
  return h;
}

test('cleanSettings / cleanAction: variant switching and 101 rules', () => {
  const c = cleanSettings({ variant: '101' });
  assert.equal(c.variant, '101');
  assert.equal(c.rounds, 9); // classic's "play to 0" has no meaning in 101
  assert.equal(cleanSettings({ variant: '101', rounds: 11 }).rounds, 11);
  assert.equal(cleanSettings({ variant: '101', rounds: 12 }), null);
  assert.equal(cleanSettings({ variant: '101', rounds: null }), null);
  assert.equal(cleanSettings({ variant: 'okey' }), null);
  const full = cleanSettings({
    variant: '101', scoring: { islek: 0, unopened: 404 }, doubles: { elden: false }, raiseOpening: true, aceHighValue: 14,
    openingValue: 120, minPairs: 6,
  });
  assert.deepEqual([full.scoring, full.doubles, full.raiseOpening, full.aceHighValue, full.openingValue, full.minPairs],
    [{ islek: 0, unopened: 404 }, { elden: false }, true, 14, 120, 6]);
  assert.equal(cleanSettings({ variant: '101', scoring: { normal: 2 } }), null);
  assert.equal(cleanSettings({ variant: '101', aceHighValue: 5 }), null);
  assert.equal(cleanSettings({ raiseOpening: true }), null); // classic: unknown key
  assert.equal(cleanSettings({ variant: 'classic', rounds: 3 }).variant, 'classic');
  // switching back drops the 101 rules
  const back = cleanSettings({ variant: 'classic' }, full);
  assert.deepEqual(back, { variant: 'classic', turnSeconds: 30, rounds: 9, startPoints: 20 });
  // a partial update keeps the variant
  assert.equal(cleanSettings({ turnSeconds: 45 }, c).variant, '101');
  // 101 actions
  assert.deepEqual(cleanAction({ type: 'layDown', groups: [[1, 2, 3], { kind: 'group', tiles: [4, 5, 6], x: 1 }], junk: 1 }),
    { type: 'layDown', groups: [[1, 2, 3], { kind: 'group', tiles: [4, 5, 6] }] });
  assert.equal(cleanAction({ type: 'layDown', groups: [] }), null);
  assert.equal(cleanAction({ type: 'layDown', groups: [[1, 2, 106]] }), null);
  assert.deepEqual(cleanAction({ type: 'addToSet', tile: 5, meld: 2, side: 'start' }), { type: 'addToSet', tile: 5, meld: 2, side: 'start' });
  assert.equal(cleanAction({ type: 'addToSet', tile: 5, meld: 2, side: 'up' }), null);
  assert.deepEqual(cleanAction({ type: 'swapOkey', tile: 5, meld: 0, okey: 27 }), { type: 'swapOkey', tile: 5, meld: 0, okey: 27 });
  assert.deepEqual(cleanAction({ type: 'undoTake', x: 1 }), { type: 'undoTake' });
});

test('a 101 match plays to the end on auto-play only (timeouts + bot seats), never leaking', () => {
  let views = 0;
  const onSend = (connId, msg, host) => {
    if (msg.t !== 'view' || !host?.match || host.match.phase !== 'playing') return;
    const v = msg.view;
    const r = host.match.round;
    views++;
    assert.equal(v.settings.variant, '101');
    assert.deepEqual([...v.hand].sort(), [...r.hands[0]].sort());
    // every tile id in the view is one seat 0 may see
    const allowed = new Set([...r.hands[0], r.indicator, ...r.table.flatMap((m) => m.tiles),
      ...r.discards.map((d) => d.at(-1)).filter((x) => x !== undefined), ...(r.taken !== null ? [r.taken] : [])]);
    const ids = [...v.hand, v.round.indicator, ...v.round.table.flatMap((m) => m.tiles), ...v.seats.map((s) => s.discard.top), v.round.taken]
      .filter((x) => x !== null);
    for (const id of ids) assert.ok(allowed.has(id), `leaked ${id}`);
    assert.ok(!('undo' in v.round) && !('pile' in v.round));
    assert.deepEqual(v.round.table.map((m) => m.tiles), r.table.map((m) => m.tiles));
    assert.deepEqual(v.round.opened, r.opened);
    v.seats.forEach((s, i) => assert.equal(s.handCount, r.hands[i].length));
  };
  const h = harness({ seed: 101, settings: { variant: '101', turnSeconds: 10, rounds: 2 }, onSend });
  h.join('c1', 1);
  h.say('c1', { t: 'sit', seat: 0 });
  ['kalfa', 'usta', 'uzman'].forEach((level, i) => h.say('c1', { t: 'addBot', seat: i + 1, level }));
  h.say('c1', { t: 'start' });
  let v = h.view('c1');
  assert.equal(v.phase, 'playing');
  assert.equal(v.settings.variant, '101');
  assert.equal(v.settings.openingValue, 101);
  assert.deepEqual(v.round.opened, [false, false, false, false]);
  assert.deepEqual(v.round.required, { value: 101, pairs: 5 });
  assert.equal(v.hand.length, v.round.dealer === 0 ? 22 : 21);
  assert.ok(h.host.bots.every((b) => b === null), 'no 101 bot brains: bot seats are auto-played');

  let steps = 0;
  let sawAway = false;
  let sawRoundEnd = false;
  while (h.view('c1').phase !== 'matchEnd' && steps < 20000) {
    assert.ok(h.step(), 'something is always scheduled');
    steps++;
    v = h.view('c1');
    if (v.seats[0].away) sawAway = true;
    if (v.phase === 'roundEnd' && !sawRoundEnd) {
      sawRoundEnd = true;
      assert.equal(v.result.hands.length, 4);
      assert.equal(typeof v.result.multiplier, 'number');
      assert.equal(v.result.deltas.length, 4);
    }
  }
  v = h.view('c1');
  assert.equal(v.phase, 'matchEnd');
  assert.ok(sawAway && sawRoundEnd);
  assert.ok(views > 50);
  const low = Math.min(...v.seats.map((s) => s.score));
  assert.deepEqual(v.winners, [0, 1, 2, 3].filter((i) => v.seats[i].score === low), 'lowest total wins');
  const rounds = h.results.filter((r) => r.type === 'round');
  assert.equal(rounds.length, 2);
  assert.ok(h.results.every((r) => r.variant === '101'));
  assert.equal(h.results.at(-1).type, 'match');
  const sum = [0, 1, 2, 3].map((i) => rounds.reduce((a, r) => a + r.seats[i].delta, 0));
  assert.deepEqual(sum, v.seats.map((s) => s.score));
  assert.ok(h.errors('c1').length === 0, `errors: ${h.errors('c1')}`);
});

test('101: a human acts (take, undoTake, draw, discard) and a snapshot restores mid-match', () => {
  const h = harness({ seed: 5, settings: { variant: '101', turnSeconds: 0, rounds: 1 } });
  h.join('c1', 1);
  h.say('c1', { t: 'sit', seat: 0 });
  [1, 2, 3].forEach((s) => h.say('c1', { t: 'addBot', seat: s, level: 'cirak' }));
  h.say('c1', { t: 'start' });
  // let the bots play until it is the human's turn in the draw stage with a discard to take
  for (let i = 0; i < 200; i++) {
    const v = h.view('c1');
    if (v.round.turn === 0 && v.round.stage === 'draw' && v.seats[3].discard.top !== null) break;
    if (v.round.turn === 0) {
      const a = E101.timeoutAction(h.host.match, 0);
      h.say('c1', { t: 'act', action: a, v: v.v });
    } else h.step();
  }
  let v = h.view('c1');
  assert.equal(v.round.turn, 0);
  const top = v.seats[3].discard.top;
  h.say('c1', { t: 'act', action: { type: 'draw', from: 'discard' }, v: v.v });
  v = h.view('c1');
  assert.equal(v.round.taken, top);
  assert.ok(v.hand.includes(top));
  h.say('c1', { t: 'act', action: { type: 'discard', tile: v.hand[0] }, v: v.v });
  assert.equal(h.errors('c1').at(-1), 'mustUseTaken');
  // snapshot + restore keeps the provisional take
  const snap = h.host.snapshot();
  h.host = h.make(snap);
  h.host.bind('c1', ident(1).id);
  h.say('c1', { t: 'hello', player: ident(1), lang: 'tr' });
  v = h.view('c1');
  assert.equal(v.round.taken, top);
  h.say('c1', { t: 'act', action: { type: 'undoTake' }, v: v.v });
  v = h.view('c1');
  assert.equal(v.round.taken, null);
  assert.equal(v.round.stage, 'draw');
  assert.equal(v.seats[3].discard.top, top);
  h.say('c1', { t: 'act', action: { type: 'draw', from: 'pile' }, v: v.v });
  v = h.view('c1');
  const a = E101.timeoutAction(h.host.match, 0);
  h.say('c1', { t: 'act', action: a, v: v.v });
  assert.notEqual(h.errors('c1').at(-1), undefined); // the earlier mustUseTaken only
  assert.equal(h.errors('c1').length, 1);
});
