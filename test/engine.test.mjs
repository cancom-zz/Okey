// Rules engine tests: node --test test/
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../site/shared/okey/index.js';

const {
  tileId: T, okeyFace, faceOf, isOkey, isFalseJoker, validSet, findFinish, bestFinish, finishOptions,
  arrange, partitionKind, GameError,
} = E;
const [R, Y, B, K] = [0, 1, 2, 3]; // red yellow blue black
const FJ = [104, 105];

// ---------------------------------------------------------------------------------------------------------
// Helpers

function deepFreeze(o) {
  if (o && typeof o === 'object' && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

const seats4 = () => [0, 1, 2, 3].map((i) => ({ id: `p${i}`, name: `P${i}`, kind: i ? 'bot' : 'human', bot: i ? { level: 'kalfa', params: { secret: 1 } } : undefined }));

function expectError(fn, code) {
  assert.throws(fn, (e) => e instanceof GameError && e.code === code, `expected GameError ${code}`);
}

/** Swap two tile ids wherever they are in a (cloned, mutable) round. */
function swapTiles(r, a, b) {
  if (a === b) return;
  const lists = [...r.hands, ...r.discards, r.pile];
  const locate = (id) => {
    if (r.indicator === id) return { ind: true };
    for (const l of lists) if (l.indexOf(id) >= 0) return { l, i: l.indexOf(id) };
    throw new Error('tile not found ' + id);
  };
  const la = locate(a);
  const lb = locate(b);
  const set = (loc, id) => (loc.ind ? (r.indicator = id) : (loc.l[loc.i] = id));
  set(la, b);
  set(lb, a);
}

/** A playing match with a chosen indicator and chosen hands (prefixes), all tiles still accounted for. */
function rigged({ indicator, hands = {}, seed = 1, settings, dealer } = {}) {
  let { match } = E.startRound(E.newMatch({ seats: seats4(), settings, dealer }), E.seededRng(seed));
  const m = structuredClone(match);
  const r = m.round;
  if (indicator !== undefined) swapTiles(r, r.indicator, indicator);
  r.okey = okeyFace(r.indicator);
  for (const [seat, ids] of Object.entries(hands)) {
    ids.forEach((id, i) => swapTiles(r, r.hands[seat][i], id));
  }
  E.tileLocations(m); // sanity
  return m;
}

const okeyOf = (c, n) => ({ color: c, num: n });

// ---------------------------------------------------------------------------------------------------------
describe('tiles', () => {
  test('decoding ids', () => {
    assert.deepEqual([E.color(0), E.num(0), E.copy(0)], [R, 1, 0]);
    assert.deepEqual([E.color(12), E.num(12), E.copy(12)], [R, 13, 0]);
    assert.deepEqual([E.color(13), E.num(13), E.copy(13)], [R, 1, 1]);
    assert.deepEqual([E.color(26), E.num(26), E.copy(26)], [Y, 1, 0]);
    assert.deepEqual([E.color(103), E.num(103), E.copy(103)], [K, 13, 1]);
    assert.equal(E.TILE_COUNT, 106);
    assert.deepEqual(E.COLORS, ['red', 'yellow', 'blue', 'black']);
    assert.ok(isFalseJoker(104) && isFalseJoker(105) && !isFalseJoker(103) && !isFalseJoker(0));
    assert.equal(E.color(104), null);
    const seen = new Set();
    for (let id = 0; id < 104; id++) {
      const key = `${E.color(id)}-${E.num(id)}-${E.copy(id)}`;
      assert.ok(!seen.has(key));
      seen.add(key);
      assert.equal(T(E.color(id), E.num(id), E.copy(id)), id);
      const o = E.otherCopy(id);
      assert.ok(o !== id && E.color(o) === E.color(id) && E.num(o) === E.num(id));
    }
    assert.equal(E.otherCopy(104), 105);
  });

  test('okey face and wraparound', () => {
    assert.deepEqual(okeyFace(T(R, 13)), { color: R, num: 1 });
    assert.deepEqual(okeyFace(T(B, 5, 1)), { color: B, num: 6 });
    assert.deepEqual(okeyFace(T(K, 1)), { color: K, num: 2 });
    const ok = okeyFace(T(R, 13));
    assert.ok(isOkey(T(R, 1, 0), ok) && isOkey(T(R, 1, 1), ok));
    assert.ok(!isOkey(T(Y, 1), ok) && !isOkey(104, ok) && !isOkey(105, ok));
  });

  test('false joker semantics', () => {
    const ok = okeyOf(Y, 7);
    assert.deepEqual(faceOf(104, ok), { color: Y, num: 7, wild: false });
    assert.deepEqual(faceOf(T(Y, 7), ok), { color: Y, num: 7, wild: true });
    assert.deepEqual(faceOf(T(Y, 8), ok), { color: Y, num: 8, wild: false });
    // A false joker plays as yellow 7 in a run, and not as anything else.
    assert.equal(validSet([T(Y, 6), 104, T(Y, 8)], ok), 'run');
    assert.equal(validSet([T(Y, 9), 104, T(Y, 10)], ok), null);
    assert.equal(validSet([T(R, 7), 105, T(B, 7)], ok), 'group');
    assert.equal(validSet([T(Y, 7, 0), 105, T(B, 7)], ok), 'group'); // okey + "yellow 7" + blue 7
    assert.equal(validSet([104, 105, T(B, 7)], ok), null); // two yellow 7s in a group
    assert.ok(E.sameFace(104, 105, ok));
    assert.ok(!E.sameFace(T(Y, 7, 0), T(Y, 7, 1), ok)); // okeys are wild, not a face
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('sets', () => {
  const ok = okeyOf(K, 13); // wilds: black 13 (ids 90, 103)
  const W = T(K, 13, 0);
  const W2 = T(K, 13, 1);
  const run = (c, ...ns) => ns.map((n) => T(c, n));

  test('runs', () => {
    assert.equal(validSet(run(R, 3, 4, 5), ok), 'run');
    assert.equal(validSet(run(R, 5, 3, 4), ok), 'run', 'order does not matter');
    assert.equal(validSet(run(R, 3, 4), ok), null, 'too short');
    assert.equal(validSet(run(R, 1, 2, 3), ok), 'run');
    assert.equal(validSet(run(R, 12, 13, 1), ok), 'run', '12-13-1');
    assert.equal(validSet(run(R, 11, 12, 13, 1), ok), 'run');
    assert.equal(validSet(run(R, 13, 1, 2), ok), null, '13-1-2');
    assert.equal(validSet(run(R, 12, 13, 1, 2), ok), null);
    assert.equal(validSet(run(R, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13), ok), 'run', '1..13');
    assert.equal(validSet(run(R, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 1), ok), 'run', '2..13-1');
    assert.equal(validSet([...run(R, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13), T(R, 1, 1)], ok), null, 'max 13');
    assert.equal(validSet([T(R, 3), T(Y, 4), T(R, 5)], ok), null, 'mixed colors');
    assert.equal(validSet([T(R, 3), T(R, 3, 1), T(R, 4)], ok), null, 'duplicate');
    assert.equal(validSet(run(R, 3, 4, 6), ok), null, 'gap');
    assert.equal(validSet([...run(R, 3, 4, 6), W], ok), 'run', 'gap filled by okey');
    assert.equal(validSet([...run(R, 12, 13), W], ok), 'run', 'okey as the 1 after 13');
    assert.equal(validSet([...run(R, 1, 2), W], ok), 'run');
    assert.equal(validSet([...run(R, 13, 2), W], ok), null, '13-W-2 would be 13-1-2');
    assert.equal(validSet([...run(R, 3, 7), W, W2], ok), null, 'gap of 3');
    assert.equal(validSet([...run(R, 3, 6), W, W2], ok), 'run');
    assert.equal(validSet([T(R, 9), W, W2], ok), 'run');
    // 13 tiles including okeys still fits; 1..13 + okey does not.
    assert.equal(validSet([...run(R, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12), W], ok), 'run');
    assert.equal(validSet([...run(R, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13), W], ok), null);
    // Black 13 is wild here, so a black run 11-12-13 is really 11-12-W.
    assert.equal(validSet([T(K, 11), T(K, 12), W], ok), 'run');
  });

  test('groups', () => {
    assert.equal(validSet([T(R, 7), T(Y, 7), T(B, 7)], ok), 'group');
    assert.equal(validSet([T(R, 7), T(Y, 7), T(B, 7), T(K, 7)], ok), 'group');
    assert.equal(validSet([T(R, 7), T(Y, 7), T(B, 7, 1), T(K, 7), W], ok), null, 'max 4');
    assert.equal(validSet([T(R, 7), T(R, 7, 1), T(B, 7)], ok), null, 'same color twice');
    assert.equal(validSet([T(R, 7), T(Y, 8), T(B, 7)], ok), null, 'different numbers');
    assert.equal(validSet([T(R, 7), T(Y, 7), W], ok), 'group');
    assert.equal(validSet([T(R, 7), T(Y, 7), T(B, 7), W], ok), 'group');
    assert.equal(validSet([T(R, 7), T(Y, 7), W, W2], ok), 'group');
    assert.equal(validSet([T(R, 7), T(Y, 7)], ok), null, 'too short');
  });

  test('bad input', () => {
    assert.equal(validSet([0, 0, 1], ok), null);
    assert.equal(validSet([0, 1, 200], ok), null);
    assert.equal(validSet('abc', ok), null);
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('finishing', () => {
  const ok = okeyOf(B, 10); // wilds: blue 10
  const W = T(B, 10, 0);
  const W2 = T(B, 10, 1);
  const pair = (c, n) => [T(c, n, 0), T(c, n, 1)];

  test('pairs with okeys and false jokers', () => {
    const seven = [...pair(R, 1), ...pair(R, 5), ...pair(Y, 3), ...pair(Y, 9), ...pair(B, 2), ...pair(K, 4), ...pair(K, 12)];
    assert.equal(findFinish(seven, ok)?.kind, 'pairs');
    const six = [...seven.slice(0, 12), T(K, 13), W];
    assert.equal(findFinish(six, ok)?.kind, 'pairs', 'okey pairs with a single');
    const five = [...seven.slice(0, 10), T(K, 13), T(Y, 13), W, W2];
    assert.equal(findFinish(five, ok)?.kind, 'pairs', 'two okeys pair two singles');
    const okPair = [...seven.slice(0, 12), W, W2];
    assert.equal(findFinish(okPair, ok)?.kind, 'pairs', 'two okeys pair together');
    const fj = [...seven.slice(0, 12), 104, 105];
    assert.equal(findFinish(fj, ok)?.kind, 'pairs', 'false jokers pair together');
    const fjOkey = [...seven.slice(0, 12), 104, T(B, 10, 0)];
    assert.equal(findFinish(fjOkey, ok)?.kind, 'pairs');
    const bad = [...seven.slice(0, 11), T(K, 13), T(Y, 13), W];
    assert.equal(findFinish(bad, ok), null, 'two singles, one okey');
    for (const h of [seven, six, five, okPair, fj]) assert.equal(partitionKind(findFinish(h, ok).groups, h, ok), 'pairs');
  });

  test('sets finishes', () => {
    const hand = [T(R, 1), T(R, 2), T(R, 3), T(Y, 12), T(Y, 13), T(Y, 1), T(R, 7), T(B, 7), T(K, 7),
      T(K, 9), T(K, 10), T(K, 11), T(K, 12), T(K, 13)];
    const f = findFinish(hand, ok);
    assert.equal(f.kind, 'sets');
    assert.equal(partitionKind(f.groups, hand, ok), 'sets');
    // With okeys filling holes.
    const h2 = [T(R, 1), W, T(R, 3), T(Y, 12), T(Y, 13), W2, T(R, 7), T(B, 7), T(K, 7),
      T(K, 9), T(K, 10), T(K, 11), T(K, 12), T(K, 13)];
    assert.equal(findFinish(h2, ok)?.kind, 'sets');
    // 13-1-2 is not a run.
    const h3 = [T(R, 13), T(R, 1), T(R, 2), ...hand.slice(3)];
    assert.equal(findFinish(h3, ok), null);
    // Needs to split a long run between two sets: 1-2-3-4-5-6 doubled into four runs.
    const h4 = [...[1, 2, 3, 4, 5, 6].flatMap((n) => pair(Y, n)), W, W2];
    assert.equal(findFinish(h4, ok)?.kind, 'sets', 'prefers sets when both work');
    assert.equal(bestFinish(h4, ok)?.kind, 'pairs', 'bestFinish prefers pairs');
    // Wrong size.
    assert.equal(findFinish(hand.slice(1), ok), null);
    // False joker plays as blue 10 in a run 9-10-11.
    const h5 = [T(B, 9), 104, T(B, 11), ...hand.slice(3)];
    assert.equal(findFinish(h5, ok)?.kind, 'sets');
    assert.equal(findFinish([T(B, 8), 104, T(B, 11), ...hand.slice(3)], ok), null);
  });

  test('finishOptions', () => {
    const fourteen = [T(R, 1), T(R, 2), T(R, 3), T(Y, 12), T(Y, 13), T(Y, 1), T(R, 7), T(B, 7), T(K, 7),
      T(K, 9), T(K, 10), T(K, 11), T(K, 12), T(K, 13)];
    const opts = finishOptions([...fourteen, T(Y, 5)], ok);
    assert.equal(opts.length, 1);
    assert.equal(opts[0].discard, T(Y, 5));
    assert.equal(opts[0].okeyFinish, false);
    // Holding an okey as the 15th tile: discarding it finishes as an okey finish; other discards may too.
    const o2 = finishOptions([...fourteen, W], ok);
    const okOpt = o2.find((o) => o.discard === W);
    assert.ok(okOpt && okOpt.okeyFinish && okOpt.kind === 'sets');
    for (const o of o2) {
      const rest = [...fourteen, W].filter((x) => x !== o.discard);
      assert.equal(partitionKind(o.groups, rest, ok), o.kind);
    }
    // Two copies of the same face both appear, each with its own groups.
    const dup = finishOptions([...fourteen, T(R, 1, 1)], ok);
    assert.deepEqual(dup.map((o) => o.discard).sort((a, b) => a - b), [T(R, 1), T(R, 1, 1)].sort((a, b) => a - b));
    for (const o of dup) assert.ok(!o.groups.flat().includes(o.discard));
    assert.deepEqual(finishOptions(fourteen, ok), []);
  });

  test('partitionKind', () => {
    const h = [T(R, 1), T(R, 2), T(R, 3), T(Y, 12), T(Y, 13), T(Y, 1), T(R, 7), T(B, 7), T(K, 7),
      T(K, 9), T(K, 10), T(K, 11), T(K, 12), T(K, 13)];
    const g = [h.slice(0, 3), h.slice(3, 6), h.slice(6, 9), h.slice(9)];
    assert.equal(partitionKind(g, h, ok), 'sets');
    assert.equal(partitionKind([h.slice(0, 3), h.slice(3, 6), h.slice(6, 9)], h, ok), null, 'missing tiles');
    assert.equal(partitionKind([...g, [h[0]]], h, ok), null, 'duplicate tile');
    assert.equal(partitionKind([h.slice(0, 2), h.slice(2, 6), h.slice(6, 9), h.slice(9)], h, ok), null);
    assert.equal(partitionKind('x', h, ok), null);
  });

  test('constructed finishable hands are always found (and fast)', (t) => {
    const rng = E.seededRng('construct');
    let worst = 0;
    let total = 0;
    const N = 3000;
    for (let i = 0; i < N; i++) {
      const { hand, okey } = constructFinish(rng);
      const { r: f, dt } = timed(() => findFinish(hand, okey));
      if (i > 50) worst = Math.max(worst, dt); // skip JIT warmup
      total += dt;
      assert.ok(f, `no finish found for ${JSON.stringify({ hand, okey })}`);
      assert.equal(partitionKind(f.groups, hand, okey), f.kind);
    }
    t.diagnostic(`findFinish: average ${(total / N).toFixed(3)} ms, worst ${worst.toFixed(2)} ms over ${N} hands`);
    assert.ok(total / N < 5, `average ${total / N} ms`);
    assert.ok(worst < 50, `worst ${worst} ms`);
  });

  test('benchmark: random and near-miss hands', (t) => {
    const rng = E.seededRng('bench');
    let worst = 0;
    let total = 0;
    const N = 4000;
    for (let i = 0; i < N; i++) {
      const okey = okeyOf(rng.int(4), 1 + rng.int(13));
      const deck = E.shuffle(E.allTiles(), rng);
      let hand;
      if (i % 2) {
        hand = deck.slice(0, 14);
      } else {
        // Concentrated: two colors, six numbers, plus okeys and false jokers -> many overlapping sets.
        const cols = [rng.int(4), rng.int(4)];
        const lo = 1 + rng.int(8);
        hand = deck.filter((id) => id >= 104 || isOkey(id, okey) || (cols.includes(E.color(id)) && E.num(id) >= lo && E.num(id) < lo + 6)).slice(0, 14);
        if (hand.length < 14) continue;
      }
      const { r: f, dt } = timed(() => findFinish(hand, okey));
      if (i > 50) worst = Math.max(worst, dt);
      total += dt;
      if (f) assert.equal(partitionKind(f.groups, hand, okey), f.kind);
      // Consistency with arrange: a sets finish exists iff arrange covers every tile.
      const lay = arrange(hand, okey, 'runs');
      assert.equal(lay.at(-1).length === 0, f?.kind === 'sets');
    }
    t.diagnostic(`findFinish: average ${(total / N).toFixed(3)} ms, worst ${worst.toFixed(2)} ms over ${N} hands`);
    assert.ok(total / N < 5, `average ${total / N} ms`);
    assert.ok(worst < 50, `worst ${worst} ms`);
  });
});

/** Time fn; a slow run is retried (min of 3) so a GC pause or a busy machine doesn't count as the algorithm. */
function timed(fn) {
  let best = Infinity;
  let r;
  for (let k = 0; k < 3; k++) {
    const t0 = performance.now();
    r = fn();
    best = Math.min(best, performance.now() - t0);
    if (best < 5) break;
  }
  return { r, dt: best };
}

/** Build a 14-tile hand that is a partition into random valid sets, with up to 2 tiles swapped for okeys. */
function constructFinish(rng) {
  for (;;) {
    const okey = okeyOf(rng.int(4), 1 + rng.int(13));
    const okeyIds = [T(okey.color, okey.num, 0), T(okey.color, okey.num, 1)];
    // Available normal faces (copies left), excluding the okey face (its copies are wild; use false jokers).
    const left = new Map();
    for (let id = 0; id < 104; id++) if (!isOkey(id, okey)) left.set(id, true);
    const fj = [104, 105];
    const take = (c, n) => {
      if (c === okey.color && n === okey.num) return fj.length ? fj.shift() : null;
      for (const cp of [0, 1]) if (left.get(T(c, n, cp))) return left.delete(T(c, n, cp)), T(c, n, cp);
      return null;
    };
    const sizes = [[3, 3, 4, 4], [3, 3, 3, 5], [3, 4, 7], [5, 9], [3, 3, 8], [4, 4, 3, 3], [3, 11]][rng.int(7)];
    const hand = [];
    let okSoFar = true;
    for (const size of sizes) {
      if (size <= 4 && rng.int(2)) {
        const n = 1 + rng.int(13);
        const cols = E.shuffle([0, 1, 2, 3], rng).slice(0, size);
        for (const c of cols) {
          const id = take(c, n);
          if (id === null) okSoFar = false;
          else hand.push(id);
        }
      } else {
        const c = rng.int(4);
        const start = 1 + rng.int(15 - size); // up to start + size - 1 <= 14 (14 = the 1 after 13)
        for (let v = start; v < start + size; v++) {
          const id = take(c, v === 14 ? 1 : v);
          if (id === null) okSoFar = false;
          else hand.push(id);
        }
      }
    }
    if (!okSoFar || hand.length !== 14) continue;
    const wilds = rng.int(3);
    for (let k = 0; k < wilds; k++) hand[rng.int(14)] = okeyIds[k];
    if (new Set(hand).size !== 14) continue;
    return { hand: E.shuffle(hand, rng), okey };
  }
}

// ---------------------------------------------------------------------------------------------------------
describe('arrange', () => {
  const ok = okeyOf(B, 10);
  const W = T(B, 10, 0);

  test('layout shape', () => {
    const hand = [T(R, 3), T(R, 4), T(R, 5), T(Y, 9), T(B, 9), T(K, 9), T(R, 9), W, T(K, 1), T(Y, 6), T(R, 11)];
    for (const mode of ['runs', 'groups', 'pairs']) {
      const lay = arrange(hand, ok, mode);
      assert.deepEqual(lay.flat().sort((a, b) => a - b), hand.slice().sort((a, b) => a - b), mode);
      const sets = lay.slice(0, -1);
      for (const s of sets) {
        if (mode === 'pairs') assert.ok(s.length === 2 && E.isPair(s[0], s[1], ok));
        else assert.ok(validSet(s, ok), `${mode}: ${s}`);
      }
    }
    const runs = arrange(hand, ok, 'runs');
    assert.equal(runs.at(-1).length, 2, 'only yellow 6 and red 11 left over');
    assert.equal(validSet(runs[0], ok), 'run', 'runs first');
    assert.equal(validSet(arrange(hand, ok, 'groups')[0], ok), 'group', 'groups first');
  });

  test('okey sits in the gap it fills', () => {
    const lay = arrange([T(R, 5), W, T(R, 3), T(K, 2)], ok, 'runs');
    assert.deepEqual(lay[0], [T(R, 3), W, T(R, 5)]);
    assert.deepEqual(lay.at(-1), [T(K, 2)]);
    assert.deepEqual(arrange([], ok, 'runs'), [[]]);
    assert.deepEqual(arrange([T(K, 2)], ok, 'groups'), [[T(K, 2)]]);
  });

  test('pairs mode', () => {
    const lay = arrange([T(R, 1), T(R, 1, 1), T(Y, 2), W, T(K, 5)], ok, 'pairs');
    assert.equal(lay.length, 3);
    assert.deepEqual(lay[0], [T(R, 1), T(R, 1, 1)]);
    assert.equal(lay.at(-1).length, 1);
  });

  test('coverage matches brute force on small concentrated hands', () => {
    const rng = E.seededRng('arrange-brute');
    for (let i = 0; i < 400; i++) {
      const okey = okeyOf(rng.int(4), 1 + rng.int(13));
      const col = rng.int(4);
      const lo = 1 + rng.int(9);
      const pool = E.allTiles().filter((id) => id >= 104 || isOkey(id, okey) || E.color(id) === col || (E.num(id) >= lo && E.num(id) < lo + 3));
      const hand = E.shuffle(pool, rng).slice(0, 5 + rng.int(5));
      const lay = arrange(hand, okey, rng.int(2) ? 'runs' : 'groups');
      const covered = hand.length - lay.at(-1).length;
      assert.equal(covered, bruteCoverage(hand, okey), JSON.stringify({ hand, okey }));
    }
  });
});

/** Max number of tiles coverable by disjoint valid sets (exponential; small hands only). */
function bruteCoverage(ids, okey, memo = new Map()) {
  if (ids.length < 3) return 0;
  const key = ids.join(',');
  if (memo.has(key)) return memo.get(key);
  const [first, ...rest] = ids;
  let best = bruteCoverage(rest, okey, memo); // first is a leftover
  const n = rest.length;
  for (let mask = 1; mask < 1 << n; mask++) {
    const pick = rest.filter((_, i) => (mask >> i) & 1);
    if (pick.length < 2 || !validSet([first, ...pick], okey)) continue;
    const others = rest.filter((_, i) => !((mask >> i) & 1));
    best = Math.max(best, pick.length + 1 + bruteCoverage(others, okey, memo));
  }
  memo.set(key, best);
  return best;
}

// ---------------------------------------------------------------------------------------------------------
describe('rng', () => {
  test('cryptoRng range and rough uniformity', () => {
    const r = E.cryptoRng();
    const counts = Array(6).fill(0);
    for (let i = 0; i < 6000; i++) counts[r.int(6)]++;
    for (const c of counts) assert.ok(c > 800 && c < 1200, String(counts));
    for (let i = 0; i < 100; i++) assert.equal(r.int(1), 0);
    assert.ok(r.int(2 ** 32) >= 0);
  });

  test('seededRng is deterministic and resumable', () => {
    const a = E.seededRng(42);
    const b = E.seededRng(42);
    const xs = Array.from({ length: 20 }, () => a.int(1000));
    assert.deepEqual(xs, Array.from({ length: 20 }, () => b.int(1000)));
    assert.notDeepEqual(xs, Array.from({ length: 20 }, () => E.seededRng(43).int(1000)));
    const c = E.seededRng(a.state());
    assert.equal(c.int(1e6), a.int(1e6));
    assert.equal(E.seededRng('x').int(1e9), E.seededRng('x').int(1e9));
  });

  test('shuffle is a permutation and does not mutate', () => {
    const arr = E.allTiles();
    const s = E.shuffle(arr, E.seededRng(1));
    assert.deepEqual(arr, E.allTiles());
    assert.notDeepEqual(s, arr);
    assert.deepEqual(s.slice().sort((x, y) => x - y), arr);
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('game', () => {
  test('deal', () => {
    const m0 = deepFreeze(E.newMatch({ seats: seats4(), code: 'ABC234', settings: { rounds: 3 } }));
    assert.equal(m0.phase, 'lobby');
    assert.deepEqual(m0.scores, [20, 20, 20, 20]);
    assert.equal(m0.settings.scoring.normal, 2);
    const { match, events } = E.startRound(m0, E.seededRng(7));
    const r = match.round;
    assert.equal(match.phase, 'playing');
    assert.deepEqual(r.hands.map((h) => h.length), [15, 14, 14, 14]);
    assert.equal(r.pile.length, 48);
    assert.ok(!isFalseJoker(r.indicator));
    assert.deepEqual(r.okey, okeyFace(r.indicator));
    assert.equal(r.turn, 0);
    assert.equal(r.stage, 'discard');
    assert.ok(E.tileLocations(match).every((x) => x !== null));
    assert.deepEqual(events[0], { type: 'roundStart', round: 1, dealer: 0, indicator: r.indicator, pileCount: 48 });
    assert.deepEqual(events.filter((e) => e.type === 'dealt').map((e) => e.to), [0, 1, 2, 3]);
    assert.deepEqual(JSON.parse(JSON.stringify(match)), match);
    // Same seed, same deal.
    assert.deepEqual(E.startRound(m0, E.seededRng(7)).match, match);
  });

  test('indicator is never a false joker', () => {
    for (let seed = 0; seed < 200; seed++) {
      const { match } = E.startRound(E.newMatch({ seats: seats4() }), E.seededRng(seed));
      assert.ok(!isFalseJoker(match.round.indicator));
    }
    // Degenerate rngs that keep pointing at the same position still terminate.
    for (const k of [0, 1, 47]) {
      const rng = { int: (n) => Math.min(k, n - 1) };
      const { match } = E.startRound(E.newMatch({ seats: seats4() }), rng);
      assert.ok(!isFalseJoker(match.round.indicator));
      E.tileLocations(match);
    }
    // Force the false joker under the chosen position: shuffle is identity-ish, then pick where 104 sits.
    const ids = E.shuffle(E.allTiles(), { int: (n) => n - 1 }); // j = i: identity
    assert.deepEqual(ids, E.allTiles());
    const pos104 = 104 - 57; // undealt tiles start at index 57
    let calls = 0;
    const rng = { int: (n) => (++calls > 105 ? pos104 : n - 1) };
    const { match } = E.startRound(E.newMatch({ seats: seats4() }), rng);
    assert.ok(!isFalseJoker(match.round.indicator));
  });

  test('turn flow and error codes', () => {
    let { match: m } = E.startRound(E.newMatch({ seats: seats4(), dealer: 2 }), E.seededRng(3));
    deepFreeze(m);
    const r = m.round;
    assert.equal(r.dealer, 2);
    assert.equal(r.turn, 2);
    expectError(() => E.act(m, 3, { type: 'draw', from: 'pile' }), 'notYourTurn');
    expectError(() => E.act(m, 2, { type: 'draw', from: 'pile' }), 'mustDiscard');
    expectError(() => E.act(m, 2, { type: 'discard', tile: r.hands[3][0] }), 'noTile');
    expectError(() => E.act(m, 2, { type: 'nope' }), 'badAction');
    expectError(() => E.act(m, 2, { type: 'toString' }), 'badAction');
    expectError(() => E.act(m, 2, null), 'badAction');
    expectError(() => E.act(m, 2, { type: 'draw', from: 'sky' }), 'badAction');
    const t = r.hands[2][0];
    let out = E.act(m, 2, { type: 'discard', tile: t });
    m = deepFreeze(out.match);
    assert.deepEqual(out.events, [{ type: 'discard', seat: 2, tile: t }]);
    assert.equal(m.round.turn, 3);
    assert.equal(m.round.stage, 'draw');
    assert.equal(m.v, 2);
    assert.deepEqual(m.round.firstTurn, [true, true, false, true]);
    expectError(() => E.act(m, 3, { type: 'discard', tile: m.round.hands[3][0] }), 'mustDraw');
    expectError(() => E.act(m, 3, { type: 'finish', tile: m.round.hands[3][0] }), 'mustDraw');
    out = E.act(m, 3, { type: 'draw', from: 'discard' });
    assert.deepEqual(out.events, [{ type: 'draw', seat: 3, from: 'discard', tile: t }]);
    assert.ok(out.match.round.hands[3].includes(t));
    assert.equal(out.match.round.discards[2].length, 0);
    // Pile draw: public event without the tile, private copy with it.
    out = E.act(m, 3, { type: 'draw', from: 'pile' });
    const drawn = m.round.pile.at(-1);
    assert.deepEqual(out.events, [
      { type: 'draw', seat: 3, from: 'pile', except: 3 },
      { type: 'draw', seat: 3, from: 'pile', tile: drawn, to: 3 },
    ]);
    assert.deepEqual(E.eventsFor(out.events, 3), [out.events[1]]);
    assert.deepEqual(E.eventsFor(out.events, 0), [out.events[0]]);
    assert.deepEqual(E.eventsFor(out.events, null), [out.events[0]]);
    // emptyDiscard: only reachable with a crafted state.
    const crafted = structuredClone(m);
    crafted.round.pile.push(...crafted.round.discards[2].splice(0));
    expectError(() => E.act(crafted, 3, { type: 'draw', from: 'discard' }), 'emptyDiscard');
    // cannotFinish.
    const m2 = out.match;
    expectError(() => E.act(m2, 3, { type: 'finish', tile: m2.round.hands[3][0] }), 'cannotFinish');
    expectError(() => E.act(m2, 3, { type: 'finish', tile: 999 }), 'noTile');
  });

  test('showing the indicator', () => {
    const ind = T(Y, 4);
    const other = T(Y, 4, 1);
    const m = deepFreeze(rigged({ indicator: ind, hands: { 1: [other] } }));
    expectError(() => E.act(m, 0, { type: 'showIndicator' }), 'cannotShow'); // dealer lacks it
    expectError(() => E.act(m, 1, { type: 'showIndicator' }), 'notYourTurn');
    const m1 = E.act(m, 0, { type: 'discard', tile: m.round.hands[0][14] }).match;
    const { match: m2, events } = E.act(m1, 1, { type: 'showIndicator' });
    assert.deepEqual(events, [
      { type: 'showIndicator', seat: 1, tile: other },
      { type: 'score', deltas: [-1, 0, -1, -1], scores: [19, 20, 19, 19] },
    ]);
    assert.equal(E.viewFor(m2, 0).seats[1].showedIndicator, true);
    expectError(() => E.act(m2, 1, { type: 'showIndicator' }), 'cannotShow'); // once
    // Still allowed after drawing (still the first turn), not after the first discard.
    const m3 = E.act(m1, 1, { type: 'draw', from: 'pile' }).match;
    assert.ok(E.isLegal(m3, 1, { type: 'showIndicator' }));
    const m4 = E.act(m3, 1, { type: 'discard', tile: m3.round.hands[1].at(-1) }).match;
    let m5 = m4;
    for (const s of [2, 3, 0]) {
      m5 = E.act(m5, s, { type: 'draw', from: 'pile' }).match;
      m5 = E.act(m5, s, { type: 'discard', tile: m5.round.hands[s][0] }).match;
    }
    assert.equal(m5.round.turn, 1);
    expectError(() => E.act(m5, 1, { type: 'showIndicator' }), 'cannotShow');
  });

  // A finishing dealer hand: 14 tiles in sets plus one spare. Indicator yellow 4 -> okey yellow 5.
  const IND = T(Y, 4);
  const OK1 = T(Y, 5, 0);
  const OK2 = T(Y, 5, 1);
  const SETS14 = [T(R, 1), T(R, 2), T(R, 3), T(Y, 12), T(Y, 13), T(Y, 1), T(R, 7), T(B, 7), T(K, 7),
    T(K, 9), T(K, 10), T(K, 11), T(K, 12), T(K, 13)];
  const PAIRS14 = [1, 2, 3, 6, 8, 9, 11].flatMap((n) => [T(B, n), T(B, n, 1)]);

  function finishCase(hand15, tile, groups, settings) {
    const m = deepFreeze(rigged({ indicator: IND, hands: { 0: hand15 }, settings }));
    return E.act(m, 0, { type: 'finish', tile, groups });
  }

  test('normal finish scoring and reveal', () => {
    const { match, events } = finishCase([...SETS14, T(B, 2)], T(B, 2));
    assert.equal(match.phase, 'roundEnd');
    assert.deepEqual(match.scores, [20, 18, 18, 18]);
    const fin = events.find((e) => e.type === 'finish');
    assert.equal(fin.kind, 'sets');
    assert.equal(fin.okeyFinish, false);
    assert.equal(fin.hands.length, 4);
    assert.equal(partitionKind(fin.groups, SETS14, okeyFace(IND)), 'sets');
    assert.deepEqual(events.map((e) => e.type), ['finish', 'score']);
    assert.equal(match.result.winner, 0);
    assert.equal(match.round.center, T(B, 2));
    E.tileLocations(match);
    expectError(() => E.act(match, 1, { type: 'draw', from: 'pile' }), 'roundOver');
    const v = E.viewFor(match, 2);
    assert.deepEqual(v.result.hands[0].slice().sort(), SETS14.slice().sort());
  });

  test('okey finish, pairs finish, pairs okey finish', () => {
    assert.deepEqual(finishCase([...SETS14, OK1], OK1).match.scores, [20, 16, 16, 16]);
    assert.deepEqual(finishCase([...PAIRS14, T(R, 4)], T(R, 4)).match.scores, [20, 16, 16, 16]);
    const po = finishCase([...PAIRS14, OK1], OK1).match;
    assert.deepEqual(po.scores, [20, 12, 12, 12]);
    assert.equal(po.result.kind, 'pairs');
    assert.equal(po.result.okeyFinish, true);
    // A false joker is not an okey: discarding it is a normal finish.
    assert.deepEqual(finishCase([...SETS14, 104], 104).match.scores, [20, 18, 18, 18]);
  });

  test('client groups: used when valid, replaced when not, best kind wins', () => {
    const groups = [SETS14.slice(0, 3), SETS14.slice(3, 6), SETS14.slice(6, 9), SETS14.slice(9)];
    const a = finishCase([...SETS14, T(B, 2)], T(B, 2), groups).match;
    assert.deepEqual(a.result.groups, groups);
    const bad = [SETS14.slice(0, 4), SETS14.slice(4)];
    const b = finishCase([...SETS14, T(B, 2)], T(B, 2), bad).match;
    assert.notDeepEqual(b.result.groups, bad);
    assert.equal(partitionKind(b.result.groups, SETS14, okeyFace(IND)), 'sets');
    const c = finishCase([...SETS14, T(B, 2)], T(B, 2), 'garbage').match;
    assert.equal(c.result.kind, 'sets');
    // Both kinds possible (1..6 doubled + 2 okeys): scored as pairs even if the client sends sets.
    const both = [...[1, 2, 3, 4, 5, 6].flatMap((n) => [T(R, n), T(R, n, 1)]), OK1, OK2];
    const okey = okeyFace(IND);
    const asSets = findFinish(both, okey);
    assert.equal(asSets.kind, 'sets');
    const d = finishCase([...both, T(K, 2)], T(K, 2), asSets.groups).match;
    assert.equal(d.result.kind, 'pairs');
    assert.deepEqual(d.scores, [20, 16, 16, 16]);
  });

  test('match end: scores to zero, ties, rounds limit', () => {
    const low = finishCase([...PAIRS14, OK1], OK1, undefined, { startPoints: 8 });
    assert.equal(low.match.phase, 'matchEnd');
    assert.deepEqual(low.match.winners, [0]);
    assert.deepEqual(low.events.at(-1), { type: 'matchEnd', scores: [8, 0, 0, 0], winners: [0] });
    expectError(() => E.nextRound(low.match, E.seededRng(1)), 'roundOver');
    const lim = finishCase([...SETS14, T(B, 2)], T(B, 2), undefined, { rounds: 1 });
    assert.equal(lim.match.phase, 'matchEnd');
    // Tie: nobody scored, rounds limit reached via pile exhaustion -> all four share the win.
    const m = autoplayRound(E.startRound(E.newMatch({ seats: seats4(), settings: { rounds: 1 } }), E.seededRng(11)).match, pileOnlyPolicy);
    assert.equal(m.phase, 'matchEnd');
    assert.equal(m.result.winner, null);
    assert.deepEqual(m.winners, [0, 1, 2, 3]);
  });

  test('pile exhaustion ends the round with no score; dealer rotates', () => {
    let m = E.startRound(E.newMatch({ seats: seats4() }), E.seededRng(5)).match;
    const allEvents = [];
    m = autoplayRound(m, pileOnlyPolicy, allEvents);
    assert.equal(m.phase, 'roundEnd');
    assert.equal(m.result.winner, null);
    assert.equal(m.round.pile.length, 0);
    assert.deepEqual(m.scores, [20, 20, 20, 20]);
    const pe = allEvents.find((e) => e.type === 'pileEmpty');
    assert.ok(pe && pe.hands.length === 4);
    assert.ok(!allEvents.some((e) => e.type === 'score'));
    const dealers = [m.round.dealer];
    for (let k = 0; k < 5; k++) {
      m = E.nextRound(m, E.seededRng(k)).match;
      dealers.push(m.round.dealer);
      assert.equal(m.round.turn, m.round.dealer);
      assert.equal(m.round.hands[m.round.dealer].length, 15);
      m = autoplayRound(m, pileOnlyPolicy);
    }
    assert.deepEqual(dealers, [0, 1, 2, 3, 0, 1]);
    assert.equal(m.roundNumber, 6);
  });

  test('timeoutAction always plays a legal move', () => {
    let m = E.startRound(E.newMatch({ seats: seats4(), settings: { rounds: 4 } }), E.seededRng('timeout')).match;
    let steps = 0;
    while (m.phase !== 'matchEnd') {
      if (m.phase === 'roundEnd') m = E.nextRound(m, E.seededRng(steps)).match;
      const seat = m.round.turn;
      assert.equal(E.timeoutAction(m, (seat + 1) % 4), null);
      const a = E.timeoutAction(m, seat);
      if (a.type === 'discard') assert.ok(!isOkey(a.tile, m.round.okey) || m.round.hands[seat].every((t) => isOkey(t, m.round.okey)));
      m = E.act(m, seat, a).match;
      steps++;
    }
    assert.ok(steps > 50);
    // Auto-play finishes when it can.
    const fin = rigged({ indicator: IND, hands: { 0: [...SETS14, T(B, 2)] } });
    assert.equal(E.timeoutAction(fin, 0).type, 'finish');
  });
});

// ---------------------------------------------------------------------------------------------------------
// Policies and the full simulation

function pileOnlyPolicy(m) {
  const r = m.round;
  if (r.stage === 'draw') return { type: 'draw', from: 'pile' };
  return { type: 'discard', tile: r.hands[r.turn][0] };
}

function autoplayRound(m, policy, sink = []) {
  while (m.phase === 'playing') {
    const out = E.act(m, m.round.turn, policy(m));
    sink.push(...out.events);
    m = out.match;
  }
  return m;
}

/** Random legal moves; finishes whenever possible; often discards an arrange() leftover so finishes happen. */
function dumbPolicy(m, rng) {
  const r = m.round;
  const seat = r.turn;
  const hand = r.hands[seat];
  if (r.firstTurn[seat] && !r.showed[seat] && hand.includes(E.otherCopy(r.indicator)) && rng.int(2)) {
    return { type: 'showIndicator' };
  }
  if (r.stage === 'draw') {
    const prevStack = r.discards[(seat + 3) % 4];
    return { type: 'draw', from: prevStack.length && rng.int(3) === 0 ? 'discard' : 'pile' };
  }
  const opts = finishOptions(hand, r.okey);
  if (opts.length) {
    const o = opts[rng.int(opts.length)];
    const groups = [o.groups, undefined, [[1, 2, 3]]][rng.int(3)];
    return { type: 'finish', tile: o.discard, groups };
  }
  if (rng.int(10) < 7) {
    const left = arrange(hand, r.okey, rng.int(2) ? 'runs' : 'groups').at(-1);
    if (left.length) return { type: 'discard', tile: left[rng.int(left.length)] };
  }
  return { type: 'discard', tile: hand[rng.int(hand.length)] };
}

/** Keys in a view whose integer values are NOT tile ids. Anything else that is an integer must be a tile. */
const NON_TILE_KEYS = new Set([
  'v', 'you', 'host', 'turnSeconds', 'rounds', 'startPoints', 'normal', 'okey', 'pairs', 'pairsOkey',
  'score', 'handCount', 'count', 'number', 'dealer', 'turn', 'pileCount', 'turnEndsAt',
  'color', 'num', 'winner', 'deltas', 'scores', 'turns', 'winners', 'now', 'round', 'seat', 'to', 'except',
]);
// `indicator` is a tile in round, but a points value in settings.scoring.
const isScoringPath = (path) => path.includes('scoring');

function tilesIn(value, path = [], out = []) {
  if (Array.isArray(value)) value.forEach((v) => tilesIn(v, path, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) tilesIn(v, [...path, k], out);
  else if (typeof value === 'number') {
    const key = path.at(-1);
    if (!NON_TILE_KEYS.has(key) && !isScoringPath(path)) out.push({ id: value, path: path.join('.') });
  }
  return out;
}

/** Tiles `seat` (null = spectator) may know about in this state. */
function visibleTo(m, seat) {
  const r = m.round;
  const vis = new Set([r.indicator]);
  for (const d of r.discards) if (d.length) vis.add(d.at(-1));
  if (seat !== null) for (const t of r.hands[seat]) vis.add(t);
  if (m.phase !== 'playing') {
    for (const h of r.hands) for (const t of h) vis.add(t);
    if (r.center !== null) vis.add(r.center);
  }
  return vis;
}

function checkInvariants(m) {
  const where = E.tileLocations(m);
  assert.ok(where.every((x) => x !== null), 'every tile accounted for');
  assert.deepEqual(JSON.parse(JSON.stringify(m)), m, 'JSON round trip');
  const r = m.round;
  const sizes = r.hands.map((h) => h.length);
  if (m.phase === 'playing') {
    sizes.forEach((n, s) => assert.equal(n, s === r.turn && r.stage === 'discard' ? 15 : 14));
  } else if (m.result.winner !== null) {
    assert.ok(sizes.every((n) => n === 14));
  }
}

function checkViews(m, before, events) {
  for (const seat of [0, 1, 2, 3, null]) {
    const view = E.viewFor(m, seat);
    const vis = visibleTo(m, seat);
    for (const { id, path } of tilesIn(view)) {
      assert.ok(vis.has(id), `seat ${seat} view leaks tile ${id} at ${path}`);
    }
    assert.ok(!JSON.stringify(view).includes('pile"'), 'no pile array');
    if (seat === null) assert.equal(view.hand, null);
    else assert.deepEqual(view.hand, m.round.hands[seat]);
    view.seats.forEach((s, i) => {
      assert.equal(s.discard.count, m.round.discards[i].length);
      if (s.bot) assert.deepEqual(Object.keys(s.bot), ['level']); // no bot params
    });
    // Events may only mention tiles visible to this seat before or after the step.
    const known = new Set([...vis, ...visibleTo(before, seat)]);
    for (const e of E.eventsFor(events, seat)) {
      if (e.type === 'showIndicator') known.add(e.tile);
      for (const { id, path } of tilesIn(e)) assert.ok(known.has(id), `seat ${seat} event ${e.type} leaks ${id} at ${path}`);
    }
  }
  for (const e of events) {
    if (e.type === 'dealt') assert.ok(Number.isInteger(e.to));
    if (e.type === 'draw' && e.from === 'pile' && e.to === undefined) assert.ok(!('tile' in e));
    // Private events only carry the recipient's own tiles.
    if (e.to !== undefined) for (const { id } of tilesIn(e)) assert.ok(m.round.hands[e.to].includes(id));
  }
}

describe('simulation', () => {
  test('random matches keep every invariant and never leak', () => {
    let finishes = 0;
    let pileEmpties = 0;
    let shows = 0;
    for (let seed = 0; seed < 24; seed++) {
      const rng = E.seededRng(`sim-${seed}`);
      const settings = seed % 3 === 0 ? { startPoints: 6 } : { rounds: 2 };
      let m = deepFreeze(E.newMatch({ seats: seats4(), settings, dealer: seed % 4, code: 'SIMSIM' }));
      let rounds = 0;
      while (m.phase !== 'matchEnd') {
        assert.ok(rounds++ < 300, 'match terminates');
        const started = m.phase === 'lobby' ? E.startRound(m, rng) : E.nextRound(m, rng);
        checkViews(started.match, started.match, started.events);
        m = deepFreeze(started.match);
        while (m.phase === 'playing') {
          checkInvariants(m);
          const seat = m.round.turn;
          // Out-of-turn actions are always refused.
          expectError(() => E.act(m, (seat + 1 + rng.int(3)) % 4, { type: 'draw', from: 'pile' }), 'notYourTurn');
          const action = dumbPolicy(m, rng);
          const before = m;
          const { match, events } = E.act(m, seat, action);
          assert.equal(match.v, before.v + 1);
          if (action.type === 'finish') finishes++;
          if (action.type === 'showIndicator') shows++;
          if (events.some((e) => e.type === 'pileEmpty')) pileEmpties++;
          checkViews(match, before, events);
          m = deepFreeze(match);
        }
        checkInvariants(m);
        assert.deepEqual(m.result.scores, m.scores);
      }
      const top = Math.max(...m.scores);
      assert.deepEqual(m.winners, [0, 1, 2, 3].filter((s) => m.scores[s] === top));
      if (!m.settings.rounds) assert.ok(m.scores.some((s) => s <= 0));
      assert.equal(m.history.length, m.roundNumber);
    }
    assert.ok(finishes > 10, `finishes ${finishes}`);
    assert.ok(pileEmpties > 5, `pile empties ${pileEmpties}`);
    assert.ok(shows > 0, `shows ${shows}`);
  });

  test('same seed, same match', () => {
    const play = () => {
      const rng = E.seededRng('det');
      let m = E.startRound(E.newMatch({ seats: seats4(), settings: { rounds: 2 } }), rng).match;
      while (m.phase !== 'matchEnd') {
        if (m.phase === 'roundEnd') m = E.nextRound(m, rng).match;
        else m = E.act(m, m.round.turn, dumbPolicy(m, rng)).match;
      }
      return m;
    };
    assert.deepEqual(play(), play());
  });
});

test('arrangeRack: sets, then near-sets side by side, then singles (Seri diz / Çift diz)', async () => {
  const E = await import('../site/shared/okey/index.js');
  const { arrangeRack, validSet, tileId, okeyFace, faceOf, seededRng, shuffle } = E;
  const okey = okeyFace(tileId(0, 1)); // red 2 is the okey
  // four 7s are a group; the 11s in two colours, 9-10, 3-4 and 13s sit together as near-sets
  const hand = [tileId(0, 7), tileId(1, 7), tileId(2, 7), tileId(3, 7), tileId(0, 9), tileId(0, 10), tileId(2, 3),
    tileId(2, 4), tileId(1, 11), tileId(3, 11), tileId(3, 1), tileId(1, 5), tileId(2, 13), tileId(0, 13)];
  const r = arrangeRack(hand, okey);
  assert.deepEqual(r.sets, [[tileId(0, 7), tileId(1, 7), tileId(2, 7), tileId(3, 7)]]);
  assert.ok(r.partials.length >= 3);
  assert.ok(r.singles.length <= 2);

  // the owner's own arrangement (Nov 25): B13 R13 R1 K1 as one chain, and R6 _ R8 with the gap left open
  const T = (c, n) => tileId(c, n);
  const own = arrangeRack([T(2, 13), T(0, 13), T(0, 1), T(3, 1), T(0, 6), T(0, 8), T(1, 4), T(1, 5), T(1, 6), T(3, 9),
    T(2, 9), T(2, 11), T(1, 10), T(3, 3)], okey);
  assert.deepEqual(own.sets, [[T(1, 4), T(1, 5), T(1, 6)]]);
  assert.ok(own.partials.some((c) => JSON.stringify(c) === JSON.stringify([T(2, 13), T(0, 13), T(0, 1), T(3, 1)])), 'B13 R13 R1 K1');
  assert.ok(own.partials.some((c) => JSON.stringify(c) === JSON.stringify([T(0, 6), null, T(0, 8)])), 'R6 _ R8');
  // twins sit together
  const tw = arrangeRack([tileId(3, 7, 0), tileId(1, 7), tileId(3, 7, 1), tileId(0, 12), tileId(2, 4)], okey);
  const k7 = [tileId(3, 7, 0), tileId(3, 7, 1)];
  const ch = tw.partials.find((c) => k7.every((x) => c.includes(x)));
  assert.ok(ch && Math.abs(ch.indexOf(k7[0]) - ch.indexOf(k7[1])) === 1, 'the two black 7s sit side by side');

  // random hands: every tile once, sets valid, near-sets real, no two singles could still pair up
  const near = (a, b, ok) => {
    const fa = faceOf(a, ok), fb = faceOf(b, ok);
    if (fa.wild || fb.wild) return false;
    if (fa.color !== fb.color) return fa.num === fb.num;
    const lo = Math.min(fa.num, fb.num), hi = Math.max(fa.num, fb.num);
    return hi - lo <= 2 || (lo === 1 && hi >= 12);
  };
  const rng = seededRng('arrangeRack');
  const all = Array.from({ length: 106 }, (_, i) => i);
  for (let k = 0; k < 400; k++) {
    const ind = shuffle(all.filter((i) => i < 104), rng)[0];
    const ok = okeyFace(ind);
    const h = shuffle(all.filter((i) => i !== ind), rng).slice(0, k % 3 === 0 ? 22 : 14);
    for (const mode of ['runs', 'pairs']) {
      const a = arrangeRack(h, ok, mode);
      const flat = [...a.sets.flat(), ...a.partials.flat().filter((x) => x !== null), ...a.singles];
      assert.deepEqual(flat.slice().sort((x, y) => x - y), h.slice().sort((x, y) => x - y));
      if (mode === 'runs') for (const s of a.sets) assert.ok(validSet(s, ok), 'set is valid');
      for (const p of a.partials) {
        const tiles = p.filter((x) => x !== null);
        assert.ok(tiles.length >= 2 && tiles.length <= 4 && p.length <= 6, 'chain within caps');
        assert.ok(p[0] !== null && p[p.length - 1] !== null, 'gaps only inside a chain');
      }
    }
    const a = arrangeRack(h, ok, 'runs');
    {
      const realSingles = a.singles.filter((id) => !faceOf(id, ok).wild);
      {
        for (let i = 0; i < realSingles.length; i++) for (let j = i + 1; j < realSingles.length; j++) {
          // twins only count in pairs play, so the 'runs' check ignores them
          const fa = faceOf(realSingles[i], ok), fb = faceOf(realSingles[j], ok);
          if (fa.color === fb.color && fa.num === fb.num) continue;
          assert.ok(!near(realSingles[i], realSingles[j], ok), 'two singles could form a near-set');
        }
      }
    }
  }
});
