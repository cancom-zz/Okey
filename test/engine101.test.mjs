// 101 Okey engine tests: node --test test/
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../site/shared/okey101/index.js';

const { tileId: T, okeyFace, GameError } = E;
const [R, Y, B, K] = [0, 1, 2, 3];
const FJ = [104, 105];

// Indicator blue 1 -> okey blue 2 (ids OK, OK2); false jokers play as blue 2.
const IND = T(B, 1);
const OK = T(B, 2, 0);
const OK2 = T(B, 2, 1);
const OKEY = okeyFace(IND);

// ---------------------------------------------------------------------------------------------------------
// Helpers

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

const seats4 = () => [0, 1, 2, 3].map((i) => ({ id: `p${i}`, name: `P${i}`, kind: i ? 'bot' : 'human' }));

function expectError(fn, code) {
  assert.throws(fn, (e) => e instanceof GameError && e.code === code, `expected GameError ${code}`);
}

/**
 * A playing match built to order. hands: { seat: [ids] } (filled up to `sizes[seat]`, default 22 for the seat
 * on turn in stage 'discard', else 21); table: [{ owner, tiles, kind? }]; discards: { seat: [ids] } (top =
 * last); opened: { seat: 'sets' | 'pairs' } (opened on an earlier turn); pile: pile size (extra tiles are
 * buried under seat (turn + 2)'s discards). Every tile stays accounted for.
 */
function rig({ indicator = IND, hands = {}, sizes = {}, table = [], discards = {}, opened = {}, turn = 0, stage = 'discard',
  pile, settings, seed = 1, scores } = {}) {
  const { match } = E.startRound(E.newMatch({ seats: seats4(), settings, dealer: turn }), E.seededRng(seed));
  const m = structuredClone(match);
  const r = m.round;
  const fixed = [indicator, ...Object.values(hands).flat(), ...table.flatMap((t) => t.tiles), ...Object.values(discards).flat()];
  assert.equal(new Set(fixed).size, fixed.length, 'rig: a tile is used twice');
  const used = new Set(fixed);
  let rest = E.shuffle(E.allTiles().filter((t) => !used.has(t)), E.seededRng(seed + 1000));
  const okey = okeyFace(indicator);
  r.indicator = indicator;
  r.okey = okey;
  r.turn = turn;
  r.stage = stage;
  r.hands = [0, 1, 2, 3].map((s) => {
    const want = sizes[s] ?? (s === turn && stage === 'discard' ? 22 : 21);
    const h = (hands[s] ?? []).slice();
    while (h.length < want) h.push(rest.pop());
    return h;
  });
  r.discards = [0, 1, 2, 3].map((s) => (discards[s] ?? []).slice());
  r.table = table.map((t) => {
    const parsed = t.kind === 'pair' ? E.pairOf(t.tiles, okey) : E.meldOf(t.kind ? { kind: t.kind, tiles: t.tiles } : t.tiles, okey);
    assert.ok(parsed, 'rig: bad table meld');
    const { value, ...meld } = parsed;
    return { owner: t.owner ?? 3, ...meld };
  });
  r.opened = [0, 1, 2, 3].map((s) => opened[s] ?? false);
  r.openings = r.opened.map((k) => (k ? { kind: k, value: k === 'sets' ? 101 : 0, pairs: k === 'pairs' ? 5 : 0, turn: -1 } : null));
  if (pile !== undefined) {
    const extra = rest.splice(0, Math.max(0, rest.length - pile));
    r.discards[(turn + 2) % 4].unshift(...extra);
  }
  r.pile = rest;
  if (scores) m.scores = scores.slice();
  E.tileLocations(m);
  assert.equal(E.tileLocations(m).filter((x) => x === null).length, 0);
  return m;
}

const play = (m, seat, action) => E.act(m, seat, action);
const evOf = (res, type) => res.events.filter((e) => e.type === type);

// ---------------------------------------------------------------------------------------------------------
describe('101 melds and values', () => {
  test('meldOf: runs, groups, okey positions, 12-13-1, values', () => {
    let m = E.meldOf([T(R, 3), T(R, 4), T(R, 5)], OKEY);
    assert.deepEqual([m.kind, m.start, m.value], ['run', 3, 12]);
    // unordered input: the best placement
    m = E.meldOf([T(R, 5), T(R, 3), T(R, 4)], OKEY);
    assert.deepEqual([m.kind, m.start, m.value, m.tiles], ['run', 3, 12, [T(R, 3), T(R, 4), T(R, 5)]]);
    // the okey stands where the client put it...
    m = E.meldOf([OK, T(R, 5), T(R, 6)], OKEY);
    assert.deepEqual([m.start, m.value], [4, 15]);
    m = E.meldOf([T(R, 5), OK, T(R, 7)], OKEY);
    assert.deepEqual([m.start, m.value], [5, 18]);
    // ...and when the order is not a run, the highest value
    m = E.meldOf([T(R, 6), OK, T(R, 5)], OKEY);
    assert.deepEqual([m.start, m.value, m.tiles], [5, 18, [T(R, 5), T(R, 6), OK]]);
    // 12-13-1: the 1 counts aceHighValue (1 by default)
    m = E.meldOf([T(R, 12), T(R, 13), T(R, 1)], OKEY);
    assert.deepEqual([m.kind, m.start, m.value], ['run', 12, 26]);
    assert.equal(E.meldOf([T(R, 12), T(R, 13), T(R, 1)], OKEY, { aceHighValue: 14 }).value, 39);
    assert.equal(E.meldOf([T(R, 1), T(R, 2), T(R, 3)], OKEY, { aceHighValue: 14 }).value, 6);
    assert.equal(E.meldOf([T(R, 13), T(R, 1), T(R, 2)], OKEY), null); // 13-1-2 never
    // groups; an okey counts the group's number
    m = E.meldOf([T(R, 13), T(Y, 13), OK], OKEY);
    assert.deepEqual([m.kind, m.num, m.value], ['group', 13, 39]);
    assert.equal(E.meldOf([T(R, 13), T(R, 13, 1), T(Y, 13)], OKEY), null);
    assert.equal(E.meldOf([T(R, 9), T(Y, 9), T(B, 9), T(K, 9), OK], OKEY), null);
    // a group of one real tile + 2 okeys vs the run: highest value, or the kind asked for
    assert.equal(E.meldOf([T(R, 12), OK, OK2], OKEY).kind, 'group'); // 36 > 12-13-1 (26)
    assert.equal(E.meldOf([T(R, 5), OK, OK2], OKEY).kind, 'run'); // 5-6-7 = 18 > 15
    assert.equal(E.meldOf({ kind: 'group', tiles: [T(R, 5), OK, OK2] }, OKEY).value, 15);
    // false jokers are the okey face (blue 2)
    m = E.meldOf([T(B, 1, 1), 104, T(B, 3)], OKEY);
    assert.deepEqual([m.kind, m.value], ['run', 6]);
    assert.equal(E.meldOf([T(R, 2), T(Y, 2), 105], OKEY).kind, 'group');
    // pairs
    assert.ok(E.pairOf([T(R, 5), T(R, 5, 1)], OKEY));
    assert.ok(E.pairOf([T(R, 5), OK], OKEY));
    assert.ok(E.pairOf([104, 105], OKEY));
    assert.equal(E.pairOf([T(R, 5), T(Y, 5)], OKEY), null);
    assert.equal(E.pairOf([T(R, 5), OK], OKEY).value, 10);
  });

  test('hand values: okey 101, false joker the okey number', () => {
    assert.equal(E.handValue([T(R, 13), T(Y, 1), 104, OK], OKEY), 13 + 1 + 2 + 101);
    assert.equal(E.handValue([OK], OKEY, { okeyInHand: 50 }), 50);
  });

  test('addTile: işleme on runs and groups, 12-13-1 extension, okeys at either end', () => {
    const run = { ...E.meldOf([T(R, 11), T(R, 12), T(R, 13)], OKEY), owner: 1 };
    const r1 = E.addTile(run, T(R, 1), OKEY);
    assert.deepEqual([r1.start, r1.tiles.length], [11, 4]);
    assert.equal(E.addTile(r1, T(R, 2), OKEY), null); // 13-1-2
    assert.equal(E.addTile(r1, T(R, 10), OKEY).start, 10);
    assert.equal(E.addTile(run, T(Y, 10), OKEY), null);
    const low = E.meldOf([T(R, 2), T(R, 3), T(R, 4)], OKEY);
    assert.equal(E.addTile(low, T(R, 1), OKEY).start, 1);
    assert.equal(E.addTile(low, OK, OKEY, 'start').start, 1);
    assert.deepEqual(E.addTile(low, OK, OKEY).tiles, [T(R, 2), T(R, 3), T(R, 4), OK]);
    const startOne = E.meldOf([T(R, 1), T(R, 2), T(R, 3)], OKEY);
    assert.equal(E.addTile(startOne, OK, OKEY, 'start'), null);
    const group = E.meldOf([T(R, 9), T(Y, 9), OK], OKEY);
    assert.ok(E.addTile(group, T(B, 9), OKEY));
    assert.equal(E.addTile(group, T(R, 9, 1), OKEY), null);
    const full = E.addTile(group, T(K, 9), OKEY);
    assert.equal(E.addTile(full, OK2, OKEY), null);
    // a 13-long run takes nothing
    const all = E.meldOf(Array.from({ length: 13 }, (_, i) => T(Y, i + 1)), OKEY);
    assert.equal(E.addTile(all, OK, OKEY), null);
  });

  test('layoffs, swaps, isIslek', () => {
    const table = [
      { owner: 1, ...strip(E.meldOf([T(R, 5), OK, T(R, 7)], OKEY)) },
      { owner: 2, ...strip(E.meldOf([T(Y, 9), T(B, 9), T(K, 9)], OKEY)) },
      { owner: 3, ...strip(E.pairOf([T(K, 4), T(K, 4, 1)], OKEY)) },
    ];
    const lay = E.layoffs([T(R, 4), T(R, 8), T(R, 9), T(R, 6), OK2], table, OKEY);
    assert.deepEqual(lay.filter((l) => l.tile !== OK2).map((l) => [l.tile, l.meld, l.side]).sort(),
      [[T(R, 4), 0, 'start'], [T(R, 8), 0, 'end'], [T(R, 9), 1, null]].sort());
    assert.ok(lay.some((l) => l.tile === OK2 && l.meld === 1));
    assert.deepEqual(E.swaps([T(R, 6), T(R, 6, 1), T(R, 8)], table, OKEY).map((s) => s.tile), [T(R, 6), T(R, 6, 1)]);
    assert.ok(E.isIslek(T(R, 8), table, OKEY));
    assert.ok(E.isIslek(T(R, 6), table, OKEY)); // takes the okey back
    assert.ok(!E.isIslek(T(R, 6), table, OKEY, { swap: false }));
    assert.ok(E.isIslek(T(R, 9), table, OKEY));
    assert.ok(!E.isIslek(T(K, 4), table, OKEY)); // pairs take nothing
    assert.ok(!E.isIslek(T(Y, 3), table, OKEY));
    assert.ok(E.isIslek(OK2, table, OKEY));
    assert.ok(!E.isIslek(OK2, [table[2]], OKEY));
  });
});

const strip = ({ value, ...m }) => m;

// ---------------------------------------------------------------------------------------------------------
describe('101 solver', () => {
  /** Brute force: the max (value, tiles) of disjoint valid sets, keeping `keep` tiles out. */
  function brute(ids, okey, keep) {
    let best = { value: 0, tiles: 0 };
    const rec = (rest, value, tiles) => {
      if (rest.length - 0 >= 0 && ids.length - tiles >= keep) {
        if (value > best.value || (value === best.value && tiles > best.tiles)) best = { value, tiles };
      }
      if (!rest.length) return;
      const [first, ...others] = rest;
      rec(others, value, tiles); // first is a leftover
      const n = others.length;
      for (let mask = 1; mask < 1 << n; mask++) {
        const pick = others.filter((_, i) => (mask >> i) & 1);
        if (pick.length < 2 || pick.length > 12) continue;
        const m = E.meldOf([first, ...pick], okey, { anyOrder: true });
        if (m) rec(others.filter((_, i) => !((mask >> i) & 1)), value + m.value, tiles + pick.length + 1);
      }
    };
    rec(ids, 0, 0);
    return best;
  }

  test('bestSets matches brute force on small concentrated hands', () => {
    const rng = E.seededRng(42);
    for (let i = 0; i < 250; i++) {
      const ind = T(rng.int(4), rng.int(13) + 1);
      const okey = okeyFace(ind);
      const pool = E.allTiles().filter((t) => t !== ind && (t >= 104 || E.num(t) <= 6 || E.isOkey(t, okey)) && (t >= 104 || E.color(t) < 3 || E.isOkey(t, okey)));
      const hand = E.shuffle(pool, rng).slice(0, 9);
      for (const keep of [0, 1]) {
        const got = E.bestSets(hand, okey, { keep });
        const want = brute(hand, okey, keep);
        assert.equal(got.value, want.value, `hand ${hand} keep ${keep}`);
        assert.ok(got.tiles <= hand.length - keep);
        // every returned group parses to the value the solver counted
        assert.equal(got.groups.reduce((s, g) => s + E.meldOf(g, okey).value, 0), got.value);
        assert.equal(new Set(got.groups.flat()).size, got.tiles);
        assert.ok(got.groups.flat().every((t) => hand.includes(t)));
      }
    }
  });

  test('bestOpening: sets or pairs, keeps a tile, okeys', () => {
    // 22 tiles that all fit into sets: one must stay out.
    const hand = [...Array.from({ length: 13 }, (_, i) => T(R, i + 1)), ...Array.from({ length: 9 }, (_, i) => T(Y, i + 1))];
    const o = E.bestOpening(hand, OKEY);
    assert.equal(o.sets.tiles, 21);
    assert.equal(o.best.kind, 'sets');
    assert.equal(o.sets.value, 91 + 45 - 1); // the yellow 1 stays out
    // pairs
    const pairs = [T(R, 3), T(R, 3, 1), T(Y, 5), T(Y, 5, 1), T(K, 7), T(K, 7, 1), T(K, 10), T(K, 10, 1), T(R, 13), OK, T(Y, 1)];
    const p = E.bestOpening(pairs, OKEY);
    assert.equal(p.pairs.count, 5);
    assert.equal(p.best.kind, 'pairs');
    assert.ok(p.pairs.groups.some((g) => g.includes(OK) && g.includes(T(R, 13))), 'the okey pairs with the highest single');
    assert.equal(E.bestOpening(pairs, OKEY, { allowPairs: false }).best, null);
    assert.equal(E.bestPairs([T(R, 3), T(R, 3, 1)], OKEY).count, 0); // must keep a tile
  });

  test('timing: bestOpening, layoffs and isIslek on 21-22 tile hands', () => {
    // CPU time of this process (not wall time), so other test files running in parallel do not count; a slow
    // sample is timed again (up to twice) and the fastest kept, so a GC pause or a busy core cannot fail it.
    const cpu = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
    const timeIt = (fn) => { const t0 = cpu(); fn(); return cpu() - t0; };
    const rng = E.seededRng(7);
    let total = 0;
    let worst = 0;
    const N = 4000;
    for (let i = 0; i < N; i++) {
      const ind = rng.int(104);
      const okey = okeyFace(ind);
      let pool = E.allTiles().filter((t) => t !== ind);
      // mix in concentrated hands (two colors, low numbers, one color): the hard cases
      if (i % 4 === 1) pool = pool.filter((t) => t >= 104 || E.color(t) < 2 || E.isOkey(t, okey));
      if (i % 4 === 2) pool = pool.filter((t) => t >= 104 || E.num(t) <= 6 || E.isOkey(t, okey));
      if (i % 4 === 3) pool = pool.filter((t) => t >= 104 || E.color(t) === i % 3 || E.isOkey(t, okey));
      let hand = E.shuffle(pool, rng).slice(0, 21 + (i % 2));
      if (i % 5 === 0) hand = [...hand.slice(0, hand.length - 2).filter((t) => !E.isOkey(t, okey)), ...E.allTiles().filter((t) => E.isOkey(t, okey))].slice(0, 22);
      let dt = timeIt(() => E.bestOpening(hand, okey));
      for (let k = 0; k < 2 && dt >= 50; k++) dt = Math.min(dt, timeIt(() => E.bestOpening(hand, okey)));
      total += dt;
      worst = Math.max(worst, dt);
    }
    const avg = total / N;
    assert.ok(avg < 10, `avg ${avg.toFixed(2)} ms`);
    assert.ok(worst < 100, `worst ${worst.toFixed(1)} ms`);

    const table = [];
    const t1 = cpu();
    for (let i = 0; i < 1000; i++) {
      const hand = E.shuffle(E.allTiles(), rng).slice(0, 22);
      if (table.length < 12) {
        const s = E.bestSets(E.shuffle(E.allTiles(), rng).slice(0, 22), OKEY);
        for (const g of s.groups) table.push(strip(E.meldOf(g, OKEY)));
      }
      E.layoffs(hand, table, OKEY);
      for (const t of hand) E.isIslek(t, table, OKEY);
    }
    const per = (cpu() - t1) / 1000;
    assert.ok(per < 10, `layoffs + 22 isIslek: ${per.toFixed(2)} ms`);
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('101 game', () => {
  test('deal: 22 + 3 x 21, pile 20, dealer discards first, okey from the indicator', () => {
    for (let seed = 1; seed <= 30; seed++) {
      const { match, events } = E.startRound(E.newMatch({ seats: seats4(), dealer: seed % 4 }), E.seededRng(seed));
      const r = match.round;
      assert.equal(r.dealer, seed % 4);
      assert.deepEqual(r.hands.map((h) => h.length), [0, 1, 2, 3].map((s) => (s === r.dealer ? 22 : 21)));
      assert.equal(r.pile.length, 20);
      assert.ok(!E.isFalseJoker(r.indicator));
      assert.deepEqual(r.okey, okeyFace(r.indicator));
      assert.equal(r.turn, r.dealer);
      assert.equal(r.stage, 'discard');
      assert.ok(E.tileLocations(match).every((x) => x !== null));
      assert.equal(events.filter((e) => e.type === 'dealt').length, 4);
      assert.deepEqual(match.scores, [0, 0, 0, 0]);
      assert.equal(match.settings.rounds, 9);
      assert.equal(match.variant, '101');
    }
  });

  test('error precedence and basic flow', () => {
    const m = rig({ turn: 0 });
    expectError(() => play(m, 1, { type: 'discard', tile: m.round.hands[1][0] }), 'notYourTurn');
    expectError(() => play(m, 7, { type: 'discard', tile: 0 }), 'notYourTurn');
    expectError(() => play(m, 0, { type: 'nope' }), 'badAction');
    expectError(() => play(m, 0, null), 'badAction');
    expectError(() => play(m, 0, { type: 'draw', from: 'pile' }), 'mustDiscard');
    expectError(() => play(m, 0, { type: 'discard', tile: m.round.hands[1][0] }), 'noTile');
    expectError(() => play(m, 0, { type: 'showIndicator' }), 'cannotShow');
    expectError(() => play(m, 0, { type: 'undoTake' }), 'noTake');
    const res = play(m, 0, { type: 'discard', tile: m.round.hands[0][0] });
    assert.equal(res.match.round.turn, 1);
    assert.equal(res.match.round.stage, 'draw');
    expectError(() => play(res.match, 1, { type: 'discard', tile: res.match.round.hands[1][0] }), 'mustDraw');
    expectError(() => play(res.match, 1, { type: 'layDown', groups: [[1, 2, 3]] }), 'mustDraw');
    const d = play(res.match, 1, { type: 'draw', from: 'pile' });
    assert.equal(d.match.round.hands[1].length, 22);
    assert.deepEqual(E.eventsFor(d.events, 2), [{ type: 'draw', seat: 1, from: 'pile', except: 1 }]);
    assert.equal(E.eventsFor(d.events, 1)[0].tile, d.match.round.hands[1].at(-1));
    expectError(() => play({ ...m, phase: 'roundEnd' }, 0, { type: 'discard', tile: 0 }), 'roundOver');
  });

  test('opening threshold: 100 fails, 101 passes, the okey counts what it stands for', () => {
    const open = [[T(R, 13), T(Y, 13), OK], [T(R, 12), T(Y, 12), T(B, 12)]]; // 39 + 36
    const k = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => T(K, a + i));
    const m = rig({ hands: { 0: [...open.flat(), ...k(3, 8)] } });
    expectError(() => play(m, 0, { type: 'layDown', groups: [...open, k(3, 7)] }), 'openTooLow'); // 100
    expectError(() => play(m, 0, { type: 'addToSet', tile: T(K, 3), meld: 0 }), 'notOpened');
    expectError(() => play(m, 0, { type: 'layDown', groups: [[T(R, 13), T(Y, 13), T(K, 3)]] }), 'badSet');
    expectError(() => play(m, 0, { type: 'layDown', groups: [...open, k(4, 7), [T(K, 3), T(K, 8)]] }), 'badSet'); // mixed
    const res = play(m, 0, { type: 'layDown', groups: [...open, k(5, 8)] }); // 101
    const r = res.match.round;
    assert.equal(r.opened[0], 'sets');
    assert.equal(r.openings[0].value, 101);
    assert.equal(r.table.length, 3);
    assert.equal(r.hands[0].length, 22 - 10);
    const ev = evOf(res, 'layDown')[0];
    assert.deepEqual(ev.opening, { kind: 'sets', value: 101, pairs: 0 });
    assert.deepEqual(ev.melds.map((x) => x.index), [0, 1, 2]);
    const v = E.viewFor(res.match, 2);
    assert.deepEqual(v.round.opened, ['sets', false, false, false]);
    assert.deepEqual(v.round.table[2], { owner: 0, kind: 'run', tiles: k(5, 8), color: K, start: 5 });
    // after opening (same turn, default): lay more and add
    const more = play(res.match, 0, { type: 'addToSet', tile: T(K, 4), meld: 2, side: 'start' });
    assert.deepEqual(more.match.round.table[2].tiles, k(4, 8));
  });

  test('opening: aceHighValue, raiseOpening, addOnOpeningTurn', () => {
    const sets = [[T(R, 12), T(R, 13), T(R, 1)], [T(Y, 13), T(B, 13), T(K, 13)], [T(Y, 11), T(B, 11), T(K, 11)]]; // 26 + 39 + 33
    expectError(() => play(rig({ hands: { 0: sets.flat() } }), 0, { type: 'layDown', groups: sets }), 'openTooLow');
    const hi = play(rig({ hands: { 0: sets.flat() }, settings: { aceHighValue: 14 } }), 0, { type: 'layDown', groups: sets });
    assert.equal(hi.match.round.openings[0].value, 111);

    const big = [[T(R, 13), T(Y, 13), T(K, 13)], [T(R, 12), T(Y, 12), T(K, 12)], [T(R, 10), T(Y, 10), T(K, 10)]]; // 105
    const m = rig({ hands: { 0: big.flat() }, settings: { raiseOpening: true } });
    m.round.highest.sets = 105;
    assert.deepEqual(E.viewFor(m, 0).round.required, { value: 106, pairs: 5 });
    expectError(() => play(m, 0, { type: 'layDown', groups: big }), 'openTooLow');
    m.round.highest.sets = 104;
    const ok = play(m, 0, { type: 'layDown', groups: big });
    assert.equal(E.viewFor(ok.match, 1).round.required.value, 106);

    const n = rig({ hands: { 0: [...big.flat(), T(R, 11), T(R, 12, 1), T(R, 13, 1)] }, settings: { addOnOpeningTurn: false } });
    const opened = play(n, 0, { type: 'layDown', groups: big });
    expectError(() => play(opened.match, 0, { type: 'addToSet', tile: T(R, 11), meld: 1 }), 'notThisTurn');
    expectError(() => play(opened.match, 0, { type: 'layDown', groups: [[T(R, 11), T(R, 12, 1), T(R, 13, 1)]] }), 'notThisTurn');
    // the next turn it may
    let nx = opened.match;
    for (const s of [0, 1, 2, 3]) {
      if (s) nx = play(nx, s, { type: 'draw', from: 'pile' }).match;
      nx = play(nx, s, { type: 'discard', tile: nx.round.hands[s].find((t) => ![T(R, 11), T(R, 12, 1), T(R, 13, 1)].includes(t) && !E.isIslek(t, nx.round.table, nx.round.okey)) }).match;
    }
    nx = play(nx, 0, { type: 'draw', from: 'pile' }).match;
    assert.equal(play(nx, 0, { type: 'layDown', groups: [[T(R, 11), T(R, 12, 1), T(R, 13, 1)]] }).match.round.table.length, 4);
  });

  test('pairs opening: 5 pairs, okeys pair with anything; pairs openers lay pairs only', () => {
    const four = [[T(R, 5), T(R, 5, 1)], [T(Y, 7), T(Y, 7, 1)], [T(K, 9), T(K, 9, 1)], [T(R, 11), T(R, 11, 1)]];
    const fifth = [T(Y, 12), OK];
    const extra = [[104, 105], [T(K, 1), T(K, 1, 1)]];
    const m = rig({ hands: { 0: [...four.flat(), ...fifth, ...extra.flat(), T(R, 1), T(R, 2), T(R, 3)] } });
    expectError(() => play(m, 0, { type: 'layDown', groups: four }), 'tooFewPairs');
    expectError(() => play(m, 0, { type: 'layDown', groups: [...four, [T(Y, 12), T(R, 1)]] }), 'badSet');
    expectError(() => play(rig({ hands: { 0: [...four.flat(), ...fifth] }, settings: { pairsOpening: false } }), 0,
      { type: 'layDown', groups: [...four, fifth] }), 'badSet');
    const res = play(m, 0, { type: 'layDown', groups: [...four, fifth] });
    const r = res.match.round;
    assert.equal(r.opened[0], 'pairs');
    assert.equal(r.openings[0].pairs, 5);
    assert.ok(r.table.every((x) => x.kind === 'pair'));
    expectError(() => play(res.match, 0, { type: 'layDown', groups: [[T(R, 1), T(R, 2), T(R, 3)]] }), 'pairsOnly');
    const more = play(res.match, 0, { type: 'layDown', groups: extra });
    assert.equal(more.match.round.table.length, 7);
    // pairsOnly off: sets allowed too
    const loose = rig({ hands: { 0: [...four.flat(), ...fifth, T(R, 1), T(R, 2), T(R, 3)] }, settings: { pairsOnly: false } });
    const l2 = play(play(loose, 0, { type: 'layDown', groups: [...four, fifth] }).match, 0, { type: 'layDown', groups: [[T(R, 1), T(R, 2), T(R, 3)]] });
    assert.equal(l2.match.round.table.at(-1).kind, 'run');
  });

  test('sets openers lay sets only; pairs openers may add to sets (pairsCanAdd)', () => {
    const table = [{ owner: 2, tiles: [T(R, 5), T(R, 6), T(R, 7)] }];
    const m = rig({ hands: { 0: [T(K, 3), T(K, 3, 1), T(R, 8)] }, opened: { 0: 'sets' }, table });
    expectError(() => play(m, 0, { type: 'layDown', groups: [[T(K, 3), T(K, 3, 1)]] }), 'setsOnly');
    const p = rig({ hands: { 0: [T(R, 8)] }, opened: { 0: 'pairs' }, table });
    assert.deepEqual(play(p, 0, { type: 'addToSet', tile: T(R, 8), meld: 0 }).match.round.table[0].tiles.length, 4);
    const q = rig({ hands: { 0: [T(R, 8)] }, opened: { 0: 'pairs' }, table, settings: { pairsCanAdd: false } });
    expectError(() => play(q, 0, { type: 'addToSet', tile: T(R, 8), meld: 0 }), 'pairsOnly');
  });

  test('işleme: extend any run (12-13-1 too), complete groups; errors', () => {
    const table = [
      { owner: 1, tiles: [T(R, 11), T(R, 12), T(R, 13)] },
      { owner: 2, tiles: [T(Y, 9), T(B, 9), T(K, 9)] },
      { owner: 3, kind: 'pair', tiles: [T(K, 4), T(K, 4, 1)] },
    ];
    const hand = [T(R, 1), T(R, 2), T(R, 10), T(R, 9, 1), T(R, 9), OK, T(Y, 3)];
    const m = rig({ hands: { 0: hand }, opened: { 0: 'sets' }, table });
    let res = play(m, 0, { type: 'addToSet', tile: T(R, 1), meld: 0 });
    assert.deepEqual(res.match.round.table[0].tiles, [T(R, 11), T(R, 12), T(R, 13), T(R, 1)]);
    assert.deepEqual(evOf(res, 'addToSet')[0], { type: 'addToSet', seat: 0, tile: T(R, 1), meld: 0, side: 'end', tiles: res.match.round.table[0].tiles });
    expectError(() => play(res.match, 0, { type: 'addToSet', tile: T(R, 2), meld: 0 }), 'cannotAdd'); // 13-1-2
    res = play(res.match, 0, { type: 'addToSet', tile: T(R, 10), meld: 0 });
    assert.equal(res.match.round.table[0].start, 10);
    res = play(res.match, 0, { type: 'addToSet', tile: T(R, 9), meld: 1 });
    assert.equal(res.match.round.table[1].tiles.length, 4);
    expectError(() => play(res.match, 0, { type: 'addToSet', tile: T(R, 9, 1), meld: 1 }), 'cannotAdd'); // full
    expectError(() => play(res.match, 0, { type: 'addToSet', tile: T(Y, 3), meld: 2 }), 'cannotAdd'); // pair
    expectError(() => play(res.match, 0, { type: 'addToSet', tile: T(Y, 3), meld: 9 }), 'badAction');
    expectError(() => play(res.match, 0, { type: 'addToSet', tile: T(Y, 3), meld: 0, side: 'middle' }), 'badAction');
    expectError(() => play(res.match, 0, { type: 'addToSet', tile: T(K, 9), meld: 0 }), 'noTile');
    res = play(res.match, 0, { type: 'addToSet', tile: OK, meld: 0, side: 'start' });
    assert.deepEqual([res.match.round.table[0].start, res.match.round.table[0].tiles[0]], [9, OK]);
    E.tileLocations(res.match);
    // not opened: no işleme
    const n = rig({ hands: { 0: hand }, table });
    expectError(() => play(n, 0, { type: 'addToSet', tile: T(R, 10), meld: 0 }), 'notOpened');
  });

  test('mustKeepOne: the hand never empties without a discard', () => {
    const table = [{ owner: 1, tiles: [T(R, 5), T(R, 6), T(R, 7)] }];
    const one = rig({ hands: { 0: [T(R, 8)] }, sizes: { 0: 1 }, opened: { 0: 'sets' }, table });
    expectError(() => play(one, 0, { type: 'addToSet', tile: T(R, 8), meld: 0 }), 'mustKeepOne');
    const three = rig({ hands: { 0: [T(K, 1), T(K, 2), T(K, 3)] }, sizes: { 0: 3 }, opened: { 0: 'sets' } });
    expectError(() => play(three, 0, { type: 'layDown', groups: [[T(K, 1), T(K, 2), T(K, 3)]] }), 'mustKeepOne');
  });

  test('okey swap: the exact tile takes the okey back to the hand', () => {
    const table = [
      { owner: 1, tiles: [T(R, 5), OK, T(R, 7)] },
      { owner: 2, tiles: [T(Y, 9), T(B, 9), OK2] },
    ];
    const hand = [T(R, 6), T(R, 8), T(K, 9), T(Y, 9, 1)];
    const m = rig({ hands: { 0: hand }, opened: { 0: 'sets' }, table });
    expectError(() => play(m, 0, { type: 'swapOkey', tile: T(R, 8), meld: 0 }), 'cannotSwap');
    let res = play(m, 0, { type: 'swapOkey', tile: T(R, 6), meld: 0 });
    assert.deepEqual(res.match.round.table[0].tiles, [T(R, 5), T(R, 6), T(R, 7)]);
    assert.ok(res.match.round.hands[0].includes(OK) && !res.match.round.hands[0].includes(T(R, 6)));
    assert.equal(res.match.round.hands[0].length, 22);
    assert.deepEqual(evOf(res, 'swapOkey')[0], { type: 'swapOkey', seat: 0, tile: T(R, 6), okey: OK, meld: 0 });
    expectError(() => play(res.match, 0, { type: 'swapOkey', tile: T(Y, 9, 1), meld: 1 }), 'cannotSwap'); // yellow is there
    res = play(res.match, 0, { type: 'swapOkey', tile: T(K, 9), meld: 1 });
    assert.deepEqual(res.match.round.table[1].tiles, [T(Y, 9), T(B, 9), T(K, 9)]);
    E.tileLocations(res.match);
    expectError(() => play(rig({ hands: { 0: hand }, table }), 0, { type: 'swapOkey', tile: T(R, 6), meld: 0 }), 'notOpened');
    expectError(() => play(rig({ hands: { 0: hand }, table, opened: { 0: 'sets' }, settings: { okeySwap: false } }), 0,
      { type: 'swapOkey', tile: T(R, 6), meld: 0 }), 'cannotSwap');
  });

  test('taking the discard: must be used this turn; undoTake restores everything', () => {
    const X = T(K, 8);
    const open = [[T(R, 13), T(Y, 13), OK], [T(R, 12), T(Y, 12), T(B, 12)], [T(K, 5), T(K, 6), T(K, 7)]]; // 93 without X
    const ten = [T(R, 10), T(Y, 10), T(B, 10)];
    const m = rig({ turn: 1, stage: 'draw', hands: { 1: [...open.flat(), ...ten] }, discards: { 0: [T(Y, 1), X] } });
    const taken = play(m, 1, { type: 'draw', from: 'discard' });
    let r = taken.match.round;
    assert.equal(r.taken, X);
    assert.deepEqual(evOf(taken, 'take'), [{ type: 'take', seat: 1, tile: X }]);
    assert.equal(E.viewFor(taken.match, 3).round.taken, X);
    assert.equal(E.viewFor(taken.match, 3).seats[0].discard.top, T(Y, 1));
    expectError(() => play(taken.match, 1, { type: 'discard', tile: X }), 'mustUseTaken');
    expectError(() => play(taken.match, 1, { type: 'discard', tile: T(R, 10) }), 'mustUseTaken');
    expectError(() => play(taken.match, 1, { type: 'finish', tile: X }), 'mustUseTaken');
    expectError(() => play(taken.match, 1, { type: 'layDown', groups: [...open, ten] }), 'mustUseTaken'); // 123, but without X
    // undo: the stack, the hand and the stage are back
    const undone = play(taken.match, 1, { type: 'undoTake' });
    assert.deepEqual(undone.match.round, m.round);
    assert.deepEqual(evOf(undone, 'undoTake'), [{ type: 'undoTake', seat: 1, tile: X }]);
    // open with it: the take is settled, the turn goes on normally
    const opened = play(taken.match, 1, { type: 'layDown', groups: [open[0], open[1], [...open[2], X]] });
    r = opened.match.round;
    assert.equal(r.taken, null);
    assert.equal(r.undo, null);
    expectError(() => play(opened.match, 1, { type: 'undoTake' }), 'noTake');
    const done = play(opened.match, 1, { type: 'discard', tile: T(R, 10) });
    assert.equal(done.match.round.turn, 2);
  });

  test('taking after opening: add it to any meld; undo also reverts other plays', () => {
    const X = T(R, 8);
    const table = [{ owner: 3, tiles: [T(R, 5), T(R, 6), T(R, 7)] }, { owner: 2, tiles: [T(K, 3), OK, T(K, 5)] }];
    const m = rig({ turn: 1, stage: 'draw', hands: { 1: [T(K, 4), T(Y, 1), T(Y, 2), T(Y, 3)] }, opened: { 1: 'sets' }, table, discards: { 0: [X] } });
    const t = play(m, 1, { type: 'draw', from: 'discard' });
    // other plays first, then undo: all reverted
    let s = play(t.match, 1, { type: 'swapOkey', tile: T(K, 4), meld: 1 });
    s = play(s.match, 1, { type: 'layDown', groups: [[T(Y, 1), T(Y, 2), T(Y, 3)]] });
    expectError(() => play(s.match, 1, { type: 'discard', tile: OK }), 'mustUseTaken');
    const u = play(s.match, 1, { type: 'undoTake' });
    assert.deepEqual(u.match.round, m.round);
    // or use it
    const a = play(t.match, 1, { type: 'addToSet', tile: X, meld: 0 });
    assert.equal(a.match.round.taken, null);
    // a swap that puts the taken tile on the table also uses it
    const m2 = rig({ turn: 1, stage: 'draw', opened: { 1: 'sets' }, table, discards: { 0: [T(K, 4)] } });
    const t2 = play(m2, 1, { type: 'draw', from: 'discard' });
    assert.equal(play(t2.match, 1, { type: 'swapOkey', tile: T(K, 4), meld: 1 }).match.round.taken, null);
    // empty stack
    expectError(() => play(rig({ turn: 1, stage: 'draw' }), 1, { type: 'draw', from: 'discard' }), 'emptyDiscard');
  });

  test('işlek penalty: +101 to the discarder; okeys; finishing discard never penalized', () => {
    const table = [{ owner: 2, tiles: [T(R, 5), T(R, 6), T(R, 7)] }];
    const m = rig({ hands: { 0: [T(R, 8), T(K, 11), OK, T(R, 6, 1)] }, table, scores: [10, 0, 0, 0] });
    let res = play(m, 0, { type: 'discard', tile: T(R, 8) });
    assert.deepEqual(evOf(res, 'penalty'), [{ type: 'penalty', seat: 0, reason: 'islek', tile: T(R, 8), points: 101 }]);
    assert.deepEqual(res.match.scores, [111, 0, 0, 0]);
    assert.deepEqual(E.viewFor(res.match, 1).round.penalties, [101, 0, 0, 0]);
    assert.equal(evOf(play(m, 0, { type: 'discard', tile: T(K, 11) }), 'penalty').length, 0);
    // an okey is işlek while a run or group can take it (one penalty, not two)
    res = play(m, 0, { type: 'discard', tile: OK });
    assert.deepEqual(evOf(res, 'penalty').map((e) => [e.reason, e.points]), [['islek', 101]]);
    // a tile that could take an okey back is işlek too
    const sw = rig({ hands: { 0: [T(R, 6)] }, table: [{ owner: 2, tiles: [T(R, 5), OK, T(R, 7)] }] });
    assert.equal(evOf(play(sw, 0, { type: 'discard', tile: T(R, 6) }), 'penalty').length, 1);
    // no table: an okey discard is free by default, okeyDiscard makes it cost
    const bare = rig({ hands: { 0: [OK] } });
    assert.equal(evOf(play(bare, 0, { type: 'discard', tile: OK }), 'penalty').length, 0);
    const strict = rig({ hands: { 0: [OK] }, settings: { scoring: { okeyDiscard: 101 } } });
    assert.deepEqual(evOf(play(strict, 0, { type: 'discard', tile: OK }), 'penalty').map((e) => e.reason), ['okeyDiscard']);
    // islek off
    const off = rig({ hands: { 0: [T(R, 8)] }, table, settings: { scoring: { islek: 0 } } });
    assert.equal(evOf(play(off, 0, { type: 'discard', tile: T(R, 8) }), 'penalty').length, 0);
    // the finishing discard is not penalized even when işlek
    const fin = rig({ hands: { 0: [T(R, 8)] }, sizes: { 0: 1 }, opened: { 0: 'sets' }, table });
    const f = play(fin, 0, { type: 'discard', tile: T(R, 8) });
    assert.equal(evOf(f, 'penalty').length, 0);
    assert.equal(evOf(f, 'finish').length, 1);
  });

  test('finish scoring: normal, okey, elden, pairs; okey in hand 101; pairs openers doubled', () => {
    const table = [{ owner: 2, tiles: [T(R, 5), T(R, 6), T(R, 7)] }];
    const others = { 2: [T(Y, 3), T(Y, 4), OK2], 3: [T(K, 10), T(K, 12)] };
    const base = (last, extra = {}) => rig({
      hands: { 0: [T(R, 8), last], ...others }, sizes: { 0: 2, 2: 3, 3: 2 }, opened: { 0: 'sets', 2: 'sets', 3: 'pairs' }, table, ...extra,
    });
    // normal
    let m = base(T(K, 1));
    let res = play(play(m, 0, { type: 'addToSet', tile: T(R, 8), meld: 0 }).match, 0, { type: 'discard', tile: T(K, 1) });
    let f = evOf(res, 'finish')[0];
    assert.deepEqual([f.seat, f.kind, f.okeyFinish, f.elden, f.multiplier], [0, 'sets', false, false, 1]);
    assert.deepEqual(res.match.result.deltas, [-101, 202, 3 + 4 + 101, (10 + 12) * 2]);
    assert.deepEqual(res.match.scores, [-101, 202, 108, 44]);
    assert.equal(res.match.phase, 'roundEnd');
    assert.equal(res.match.result.winner, 0);
    assert.equal(res.match.round.center, T(K, 1));
    assert.deepEqual(res.match.result.hands[0], []);
    E.tileLocations(res.match);
    // okey finish x2 (also through the 'finish' action)
    m = base(OK);
    res = play(play(m, 0, { type: 'addToSet', tile: T(R, 8), meld: 0 }).match, 0, { type: 'finish', tile: OK });
    f = evOf(res, 'finish')[0];
    assert.deepEqual([f.okeyFinish, f.multiplier], [true, 2]);
    assert.deepEqual(res.match.result.deltas, [-202, 404, 216, 88]);
    expectError(() => play(m, 0, { type: 'finish', tile: OK }), 'cannotFinish'); // two tiles left
    // doubles off
    m = base(OK, { settings: { doubles: { okeyFinish: false, pairsOpener: false } } });
    res = play(play(m, 0, { type: 'addToSet', tile: T(R, 8), meld: 0 }).match, 0, { type: 'discard', tile: OK });
    assert.deepEqual(res.match.result.deltas, [-101, 202, 108, 22]);
  });

  test('elden (open and finish in one turn) doubles; with an okey finish x4', () => {
    const red = Array.from({ length: 13 }, (_, i) => T(R, i + 1)); // 91
    const yellow = Array.from({ length: 8 }, (_, i) => T(Y, i + 1)); // 36
    for (const [last, mult] of [[T(K, 13), 2], [OK, 4]]) {
      const m = rig({ hands: { 0: [...red, ...yellow, last] } });
      const opened = play(m, 0, { type: 'layDown', groups: [red, yellow] });
      const res = play(opened.match, 0, { type: 'discard', tile: last });
      const f = evOf(res, 'finish')[0];
      assert.deepEqual([f.elden, f.multiplier], [true, mult]);
      assert.deepEqual(res.match.result.deltas, [-101 * mult, 202 * mult, 202 * mult, 202 * mult]);
    }
    // opened on an earlier turn: not elden
    const later = rig({ hands: { 0: [T(K, 13)] }, sizes: { 0: 1 }, opened: { 0: 'sets' } });
    assert.equal(evOf(play(later, 0, { type: 'discard', tile: T(K, 13) }), 'finish')[0].elden, false);
  });

  test('a pairs opener finishing doubles everything', () => {
    const m = rig({ hands: { 0: [T(K, 3), T(K, 3, 1), T(Y, 9)] }, sizes: { 0: 3, 1: 1, 2: 1, 3: 1 }, opened: { 0: 'pairs', 1: 'sets' } });
    const laid = play(m, 0, { type: 'layDown', groups: [[T(K, 3), T(K, 3, 1)]] });
    const res = play(laid.match, 0, { type: 'discard', tile: T(Y, 9) });
    const f = evOf(res, 'finish')[0];
    assert.deepEqual([f.kind, f.multiplier], ['pairs', 2]);
    const r = m.round;
    assert.deepEqual(res.match.result.deltas, [-202, E.handValue(r.hands[1], r.okey) * 2, 404, 404]);
  });

  test('pile exhaustion: no finisher; unopened 202, opened hand value (pairs x2)', () => {
    const m = rig({ pile: 0, opened: { 1: 'sets', 2: 'pairs' }, hands: { 1: [OK] }, sizes: { 1: 4, 2: 3 } });
    const res = play(m, 0, { type: 'discard', tile: m.round.hands[0][0] });
    assert.equal(res.match.phase, 'roundEnd');
    assert.equal(evOf(res, 'pileEmpty').length, 1);
    const r = res.match.round;
    assert.deepEqual(res.match.result.deltas, [202, E.handValue(r.hands[1], r.okey), E.handValue(r.hands[2], r.okey) * 2, 202]);
    assert.ok(E.handValue(r.hands[1], r.okey) >= 101);
    assert.equal(res.match.result.winner, null);
    assert.deepEqual(res.match.scores, res.match.result.deltas);
  });

  test('match: fixed rounds, lowest total wins, ties share, dealer rotates', () => {
    const tie = rig({ pile: 0, settings: { rounds: 1 } });
    const t = play(tie, 0, { type: 'discard', tile: tie.round.hands[0][0] });
    assert.equal(t.match.phase, 'matchEnd');
    assert.deepEqual(t.match.winners, [0, 1, 2, 3]);
    assert.deepEqual(evOf(t, 'matchEnd')[0], { type: 'matchEnd', scores: [202, 202, 202, 202], winners: [0, 1, 2, 3] });
    expectError(() => E.nextRound(t.match, E.seededRng(1)), 'roundOver');

    const rng = E.seededRng(99);
    let m = E.newMatch({ seats: seats4(), settings: { rounds: 3 }, dealer: 2 });
    m = E.startRound(m, rng).match;
    const dealers = [m.round.dealer];
    for (let guard = 0; m.phase !== 'matchEnd' && guard < 5000; guard++) {
      if (m.phase === 'roundEnd') {
        m = E.nextRound(m, rng).match;
        dealers.push(m.round.dealer);
        continue;
      }
      m = E.act(m, m.round.turn, E.timeoutAction(m, m.round.turn)).match;
    }
    assert.equal(m.phase, 'matchEnd');
    assert.deepEqual(dealers, [2, 3, 0]);
    assert.equal(m.history.length, 3);
    const totals = [0, 1, 2, 3].map((s) => m.history.reduce((a, h) => a + h.deltas[s], 0));
    assert.deepEqual(totals, m.scores);
    const low = Math.min(...m.scores);
    assert.deepEqual(m.winners, [0, 1, 2, 3].filter((s) => m.scores[s] === low));
  });

  test('timeoutAction: draws, opens, lays off, gives back an unusable take, avoids işlek', () => {
    // opens when it can
    const open = [[T(R, 13), T(Y, 13), T(K, 13)], [T(R, 12), T(Y, 12), T(K, 12)], [T(R, 10), T(Y, 10), T(K, 10)]];
    let m = rig({ hands: { 0: open.flat() } });
    let a = E.timeoutAction(m, 0);
    assert.equal(a.type, 'layDown');
    assert.ok(E.isLegal(m, 0, a));
    assert.equal(E.timeoutAction(m, 1), null);
    // gives back a take an unopened seat cannot use, then draws
    m = rig({ turn: 1, stage: 'draw', discards: { 0: [T(Y, 1)] } });
    m = play(m, 1, { type: 'draw', from: 'discard' }).match;
    assert.deepEqual(E.timeoutAction(m, 1), { type: 'undoTake' });
    m = play(m, 1, E.timeoutAction(m, 1)).match;
    assert.deepEqual(E.timeoutAction(m, 1), { type: 'draw', from: 'pile' });
    // never an işlek tile when another will do
    const table = [{ owner: 2, tiles: [T(R, 5), T(R, 6), T(R, 7)] }];
    m = rig({ hands: { 0: [T(R, 8), T(R, 13), T(K, 1), OK] }, sizes: { 0: 4 }, table });
    a = E.timeoutAction(m, 0);
    assert.equal(a.type, 'discard');
    assert.ok(a.tile !== T(R, 8) && a.tile !== OK);
    assert.equal(a.tile, T(R, 13)); // highest value
    // opened: lays off, then finishes
    m = rig({ hands: { 0: [T(R, 8), T(K, 1)] }, sizes: { 0: 2 }, opened: { 0: 'sets' }, table });
    a = E.timeoutAction(m, 0);
    assert.deepEqual([a.type, a.tile], ['addToSet', T(R, 8)]);
    m = play(m, 0, a).match;
    a = E.timeoutAction(m, 0);
    assert.deepEqual(a, { type: 'discard', tile: T(K, 1) });
    assert.equal(play(m, 0, a).match.result.winner, 0);
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('101 simulation', () => {
  const NON_TILE = new Set(['v', 'now', 'number', 'dealer', 'turn', 'pileCount', 'turnEndsAt', 'count', 'handCount',
    'score', 'scores', 'deltas', 'penalties', 'owner', 'start', 'num', 'color', 'value', 'pairs', 'winner', 'winners',
    'you', 'host', 'turns', 'multiplier', 'seat', 'meld', 'index', 'points', 'round', 'pileCountAt']);

  const tilesIn = (x, key, out) => {
    if (typeof x === 'number') {
      if (!NON_TILE.has(key)) out.push(x);
    } else if (Array.isArray(x)) x.forEach((y) => tilesIn(y, key, out));
    else if (x && typeof x === 'object') {
      for (const [k, y] of Object.entries(x)) if (k !== 'settings' && k !== 'okey' && k !== 'required') tilesIn(y, k, out);
    }
    return out;
  };

  function checkView(m, seat) {
    const view = E.viewFor(m, seat);
    const r = m.round;
    const allowed = new Set([r.indicator, ...r.table.flatMap((x) => x.tiles), ...r.discards.map((d) => d.at(-1)).filter((t) => t !== undefined)]);
    if (r.taken !== null) allowed.add(r.taken);
    if (seat !== null) r.hands[seat].forEach((t) => allowed.add(t));
    if (m.phase !== 'playing') {
      r.hands.flat().forEach((t) => allowed.add(t));
      if (r.center !== null) allowed.add(r.center);
    }
    for (const t of tilesIn(view, '', [])) assert.ok(allowed.has(t), `seat ${seat} sees tile ${t}`);
    assert.ok(!('undo' in view.round) && !('pile' in view.round) && !('hands' in view.round));
    assert.equal(view.hand === null, seat === null);
    view.seats.forEach((s, i) => assert.equal(s.handCount, r.hands[i].length));
    assert.deepEqual(JSON.parse(JSON.stringify(view)), view);
  }

  function checkEvents(events, m) {
    for (const seat of [0, 1, 2, 3, null]) {
      for (const e of E.eventsFor(events, seat)) {
        if (e.type === 'dealt') assert.equal(e.to, seat);
        if (e.type === 'draw' && e.from === 'pile' && 'tile' in e) assert.equal(e.seat, seat);
        if ((e.type === 'finish' || e.type === 'pileEmpty')) assert.notEqual(m.phase, 'playing');
      }
    }
  }

  test('random matches keep every invariant and never leak', () => {
    let rounds = 0;
    let finishes = 0;
    const seen = new Set();
    for (let seed = 1; seed <= 60; seed++) {
      const rng = E.seededRng(seed);
      const policy = E.seededRng(seed * 7 + 3);
      const settings = seed % 3 === 0 ? { rounds: 2, scoring: { okeyDiscard: 101 } } : seed % 3 === 1 ? { rounds: 2, raiseOpening: true } : { rounds: 2, addOnOpeningTurn: false, pairsOnly: false };
      let m = deepFreeze(E.newMatch({ seats: seats4(), settings, dealer: seed % 4 }));
      let res = E.startRound(m, rng);
      for (let step = 0; step < 20000; step++) {
        m = deepFreeze(res.match);
        assert.equal(JSON.stringify(JSON.parse(JSON.stringify(m))), JSON.stringify(m));
        const where = E.tileLocations(m);
        assert.equal(where.filter((x) => x === null).length, 0, 'all 106 tiles accounted for');
        for (const meld of m.round.table) {
          if (meld.kind === 'pair') assert.ok(E.pairOf(meld.tiles, m.round.okey));
          else assert.ok(E.validSet(meld.tiles, m.round.okey), 'table melds stay valid');
        }
        res.events.forEach((e) => seen.add(e.type));
        checkEvents(res.events, m);
        for (const seat of [0, 1, 2, 3, null]) checkView(m, seat);
        if (m.phase === 'playing') assert.ok(m.round.hands.every((h) => h.length >= 1));
        if (m.phase === 'matchEnd') break;
        if (m.phase === 'roundEnd') {
          rounds++;
          if (m.result.winner !== null) finishes++;
          res = E.nextRound(m, rng);
          continue;
        }
        const seat = m.round.turn;
        const r = m.round;
        let action = E.timeoutAction(m, seat);
        // explore: take discards, give them back, random (sometimes işlek) discards
        const x = policy.random();
        if (r.stage === 'draw' && r.discards[(seat + 3) % 4].length && x < 0.25) action = { type: 'draw', from: 'discard' };
        else if (action.type === 'discard' && r.taken === null && x < 0.1) action = { type: 'discard', tile: r.hands[seat][policy.int(r.hands[seat].length)] };
        const before = JSON.stringify(m);
        res = E.act(m, seat, action); // m is deep-frozen: any mutation would throw
        assert.equal(JSON.stringify(m), before);
        assert.equal(res.match.v, m.v + 1);
      }
      assert.equal(m.phase, 'matchEnd');
      assert.equal(m.roundNumber, 2);
      const totals = [0, 1, 2, 3].map((s) => m.history.reduce((a, h) => a + h.deltas[s], 0));
      assert.deepEqual(totals, m.scores);
    }
    assert.ok(rounds >= 60);
    assert.ok(finishes > 0, 'some rounds finish');
    for (const t of ['take', 'undoTake', 'layDown', 'addToSet', 'penalty', 'finish', 'pileEmpty', 'score', 'matchEnd']) {
      assert.ok(seen.has(t), `event ${t} happened`);
    }
  });

  test('same seed, same match', () => {
    const run = () => {
      const rng = E.seededRng('101-seed');
      let m = E.startRound(E.newMatch({ seats: seats4(), settings: { rounds: 2 } }), rng).match;
      while (m.phase !== 'matchEnd') {
        if (m.phase === 'roundEnd') m = E.nextRound(m, rng).match;
        else m = E.act(m, m.round.turn, E.timeoutAction(m, m.round.turn)).match;
      }
      return m;
    };
    assert.deepEqual(run(), run());
  });
});
