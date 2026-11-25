// Taşlamak: reading the neighbours from public information (defense, offense, tells) and bluffing.
// node --test test/taslamak.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../site/shared/okey/index.js';
import { createBot, LEVELS } from '../site/shared/bots/index.js';
import { playRounds, botsFor, seatsFor } from './botsim.mjs';

const T = (c, n, cp = 0) => C.tileId(c, n, cp);
const R = 0, Y = 1, B = 2, K = 3;

/**
 * Seat 0 (dealer) to discard with `hand` (15 tiles); the bot has seen the public events `history`
 * (its own discards and the next player's pickups), fed in order before deciding.
 */
function decideAfter({ hand, history, level, params, seed, pileCount = 12 }) {
  const indicator = T(B, 12, 1); // okey: blue 13
  let match = C.newMatch({ seats: seatsFor() });
  ({ match } = C.startRound(match, C.seededRng('tas')));
  const m = structuredClone(match);
  const r = m.round;
  const used = new Set([...hand, indicator, ...history.map((e) => e.tile)]);
  const rest = [...r.pile, ...r.hands.flat(), r.indicator].filter((t) => !used.has(t));
  r.indicator = indicator;
  r.okey = C.okeyFace(indicator);
  r.hands = [hand.slice(), rest.splice(0, 14), rest.splice(0, 14), rest.splice(0, 14)];
  r.pile = rest.splice(0, pileCount);
  r.turn = 0; r.dealer = 0; r.stage = 'discard';
  r.firstTurn = [false, false, false, false];
  const bot = createBot({ level, params, seed });
  bot.observe({ type: 'roundStart', round: 1, dealer: 0, indicator, pileCount: 40 });
  bot.observe({ type: 'dealt', to: 0, hand });
  for (const e of history) bot.observe(e);
  return bot.decide(C.viewFor(m, 0));
}

test('defense: the next player picked up R5 and R6 from us, so a reader does not feed R4/R7', () => {
  // Complete runs plus three loose tiles; R7 is the natural throw for a bot that does not read
  // (R5 and R6 are gone, so R7 has the fewest live neighbours).
  const hand = [T(Y, 1), T(Y, 2), T(Y, 3), T(B, 4), T(B, 5), T(B, 6), T(K, 9), T(K, 10), T(K, 11),
    T(Y, 9), T(Y, 10), T(Y, 11), T(R, 7), T(K, 2), T(Y, 6)];
  const history = [
    { type: 'discard', seat: 0, tile: T(R, 5) }, { type: 'draw', seat: 1, from: 'discard', tile: T(R, 5) },
    { type: 'discard', seat: 1, tile: T(B, 1) },
    { type: 'discard', seat: 0, tile: T(R, 6) }, { type: 'draw', seat: 1, from: 'discard', tile: T(R, 6) },
    { type: 'discard', seat: 1, tile: T(K, 13) },
  ];
  const feeds = (params, level) => {
    let n = 0;
    for (let s = 0; s < 30; s++) {
      const a = decideAfter({ hand, history, level, params: { memory: 0.9, decay: 0.005, blunder: 0, ...params }, seed: 'd' + s });
      assert.equal(a.type, 'discard');
      if (a.tile === T(R, 7) || a.tile === T(R, 4)) n++;
    }
    return n;
  };
  const blind = feeds({ read: 0, defense: 0 }, 'usta');
  const reader = feeds({}, 'usta');
  const expert = feeds({}, 'uzman');
  console.log(`R7 or R4 thrown: blind ${blind}/30, usta ${reader}/30, uzman ${expert}/30`);
  assert.ok(blind >= 20, `a bot that does not read throws R7 (${blind}/30)`);
  assert.ok(reader <= 3, `usta avoids feeding R7 (${reader}/30)`);
  assert.ok(expert <= 3, `uzman avoids feeding R7 (${expert}/30)`);
  // Kalfa reads pickups too (basic defense); Çırak does not read at all.
  assert.ok(feeds({ blunder: 0 }, 'cirak') >= 20);
});

test('bluff: Uzman bluffs now and then (bounded, seeded); the others never', () => {
  const run = (level, seed, params) => {
    const bots = botsFor([level, level, level, level], seed, [params, params, params, params]);
    playRounds({ bots, rounds: 4, seed });
    return bots.map((b) => b.stats()).reduce((a, x) => ({ discards: a.discards + x.discards, bluffs: a.bluffs + x.bluffs }), { discards: 0, bluffs: 0 });
  };
  const u = run('uzman', 'bl');
  const rate = u.bluffs / u.discards;
  assert.ok(u.bluffs > 0, 'it does bluff');
  assert.ok(rate <= LEVELS.uzman.params.bluff, `rate ${rate} within the bluff param`);
  assert.deepEqual(run('uzman', 'bl'), u, 'seeded');
  assert.equal(run('usta', 'bl').bluffs, 0);
  assert.equal(run('uzman', 'bl', { bluff: 0 }).bluffs, 0, 'a custom uzman can be told not to bluff');
  const all = run('uzman', 'bl2', { bluff: 1 });
  assert.ok(all.bluffs / all.discards <= 1 && all.bluffs > u.bluffs, 'bounded by cost even at bluff 1');
});

test('levels: read and bluff by level, clamped for custom bots', () => {
  assert.deepEqual(['cirak', 'kalfa', 'usta', 'uzman'].map((l) => [LEVELS[l].params.read, LEVELS[l].params.bluff]),
    [[0, 0], [0.3, 0], [0.7, 0], [0.9, 0.12]]);
  const b = createBot({ level: 'kalfa', params: { read: 2, bluff: -1 }, seed: 1 });
  assert.equal(b.params.read, 1);
  assert.equal(b.params.bluff, 0);
});
