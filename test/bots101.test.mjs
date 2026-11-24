// 101 Okey bots: no cheating, no shared state, legal multi-step turns, plausible play, a strength ladder.
// node --test test/bots101.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../site/shared/okey101/index.js';
import { isIslek } from '../site/shared/okey101/rules.js';
import { createBot, LEVEL_IDS, LEVELS } from '../site/shared/bots/index.js';
import { guard } from './botguard.mjs';
import { playMatch101, seatsFor, botsFor, runTables, MAX_STEPS_101 } from './botsim.mjs';

const MAX_STEPS = MAX_STEPS_101;
const playMatch = playMatch101; // test/botsim.mjs: a bot-only 101 match through the engine's act()

// ---------------------------------------------------------------------------------------------------------
// No cheating, no shared state

test('101 no-cheat: decide/delayMs only read documented view fields (incl. table), never seat identity', () => {
  const seen = new Set();
  const mask = (v) => ({ ...v, seats: v.seats.map(({ kind, bot, id, ...rest }) => rest) });
  const res = playMatch({
    bots: botsFor(['uzman', 'cirak', 'usta', 'kalfa'], 'proxy'), seed: 'proxy', rounds: 2,
    wrap: (v) => guard(mask(v), 'root', 'view', seen),
  });
  assert.ok(res.steps > 50);
  assert.ok(seen.has('view.round.table'), 'the 101 policy reads the table');
  for (const p of seen) assert.ok(!/^view\.seats\.\d+\.(kind|bot|name|avatar|connected|away|id)$/.test(p), p);
});

test('101 no-cheat: the pile order and other hands never change a decision', () => {
  let match = E.newMatch({ seats: seatsFor(), settings: { rounds: 1 } });
  const res = E.startRound(match, E.seededRng('pile101'));
  match = res.match;
  const seat = match.round.dealer;
  const other = structuredClone(match);
  other.round.pile.reverse();
  const o1 = (seat + 1) % 4, o2 = (seat + 2) % 4;
  [other.round.hands[o1], other.round.hands[o2]] = [other.round.hands[o2], other.round.hands[o1]];
  for (const level of LEVEL_IDS) {
    const a = createBot({ level, seed: 'same' });
    const b = createBot({ level, seed: 'same' });
    for (const e of E.eventsFor(res.events, seat)) { a.observe(e); b.observe(e); }
    assert.deepEqual(a.decide(E.viewFor(match, seat)), b.decide(E.viewFor(other, seat)), level);
  }
});

test('101 bots never use Math.random, are deterministic per seed, and share nothing', () => {
  const orig = Math.random;
  Math.random = () => { throw new Error('Math.random used'); };
  try {
    const log = (seed, warm) => {
      const bots = botsFor(['cirak', 'kalfa', 'usta', 'uzman'], seed);
      // Feeding other bots (same seeds) a whole different match must not change these ones.
      if (warm) playMatch({ bots: botsFor(['cirak', 'kalfa', 'usta', 'uzman'], seed), seed: 'other', rounds: 1 });
      const out = [];
      playMatch({ bots, seed: 'det', rounds: 2, onStep: ({ action, ms }) => out.push(JSON.stringify(action) + ms) });
      return out;
    };
    const a = log('x', false);
    assert.deepEqual(a, log('x', true));
    assert.notDeepEqual(a, log('y', false));
  } finally {
    Math.random = orig;
  }
});

test('101 snapshot/restore mid-turn: restored bots (JSON round trip) play exactly like the originals', () => {
  const bots = botsFor(['uzman', 'usta', 'kalfa', 'cirak'], 'snap101');
  let twins = null;
  let pending = null;
  let compared = 0;
  playMatch({
    bots, seed: 'snap101', rounds: 3,
    beforeStep: ({ seat, view }) => {
      // Restore in the middle of a turn (discard stage) so multi-step state is covered too.
      if (!twins && view.round.stage === 'discard' && view.round.pileCount <= 14) {
        twins = bots.map((b) => createBot({ level: 'cirak', seed: 'ignored', saved: JSON.parse(JSON.stringify(b.snapshot())) }));
      }
      if (twins) {
        twins[seat].delayMs(view);
        pending = twins[seat].decide(view);
      }
    },
    onStep: ({ action }) => {
      if (twins) { assert.deepEqual(pending, action); compared++; }
    },
    onEvents: (events) => {
      if (twins) for (let s = 0; s < 4; s++) for (const e of E.eventsFor(events, s)) twins[s].observe(structuredClone(e));
    },
  });
  assert.ok(compared > 40, `compared ${compared}`);
  assert.equal(twins[0].level, 'uzman');
});

// ---------------------------------------------------------------------------------------------------------
// Crafted situations

/** A 101 match where seat 0 is on turn in the discard stage with `hand`; `table` melds already down. */
function crafted({ hand, table = [], opened = [false, false, false, false], indicator = E.tileId(3, 10, 1), taken = null }) {
  let match = E.newMatch({ seats: seatsFor(), settings: { rounds: 1 } });
  ({ match } = E.startRound(match, E.seededRng('craft101')));
  const m = structuredClone(match);
  const r = m.round;
  const used = new Set([...hand, indicator, ...table.flatMap((x) => x.tiles)]);
  const rest = [...r.pile, ...r.hands.flat(), r.indicator, ...r.discards.flat()].filter((t) => !used.has(t));
  r.indicator = indicator;
  r.okey = E.okeyFace(indicator);
  r.hands = [hand.slice(), rest.splice(0, 21), rest.splice(0, 21), rest.splice(0, 21)];
  r.pile = rest.splice(0, 10);
  r.discards = [[], [], [], rest.splice(0, 1)];
  r.table = table;
  r.opened = opened;
  r.openings = opened.map((o) => (o ? { kind: o, value: 101, pairs: 0, turn: -1 } : null));
  r.turn = 0;
  r.dealer = 1;
  r.stage = 'discard';
  r.firstTurn = [false, false, false, false];
  r.turns = [3, 3, 3, 3];
  return m;
}
const T = (c, n, cp = 0) => E.tileId(c, n, cp);

/** Let the bot on seat 0 play until its turn ends; returns its actions. */
function playTurn(match, bot) {
  const actions = [];
  for (let i = 0; i < MAX_STEPS && match.phase === 'playing' && match.round.turn === 0; i++) {
    const a = bot.decide(E.viewFor(match, 0));
    actions.push(a);
    match = E.act(match, 0, a).match;
  }
  return { actions, match };
}

test('opens when it can, lays off what fits, and finishes', () => {
  // Opened earlier; the table has a red 4-5-6 run. Hand: red 7, red 3 and a blue 9-10-11 run.
  const table = [{ owner: 1, kind: 'run', tiles: [T(0, 4), T(0, 5), T(0, 6)], color: 0, start: 4 }];
  const hand = [T(0, 7), T(0, 3), T(2, 9), T(2, 10), T(2, 11), T(1, 13)];
  for (const level of LEVEL_IDS) {
    const m = crafted({ hand, table, opened: ['sets', 'sets', false, false] });
    const { actions, match } = playTurn(m, createBot({ level, params: { blunder: 0 }, seed: 1 }));
    const types = actions.map((a) => a.type);
    assert.ok(types.includes('layDown'), `${level}: ${types}`);
    assert.equal(types.filter((t) => t === 'addToSet').length, 2, level);
    assert.ok(['roundEnd', 'matchEnd'].includes(match.phase), `${level} finishes with the last tile`);
    assert.equal(match.result.winner, 0);
  }
  // Unopened with 101+ in sets: everyone opens (beginners as soon as they can).
  const big = [T(0, 11), T(0, 12), T(0, 13), T(1, 11), T(1, 12), T(1, 13), T(2, 10), T(2, 11), T(2, 12), T(2, 13),
    T(3, 9), T(3, 10), T(3, 11), T(0, 1), T(1, 3), T(2, 5), T(3, 2), T(0, 8), T(1, 6), T(2, 2), T(3, 4)];
  const m2 = crafted({ hand: big });
  const a = createBot({ level: 'cirak', params: { blunder: 0 }, seed: 2 }).decide(E.viewFor(m2, 0));
  assert.equal(a.type, 'layDown');
  const after = E.act(m2, 0, a).match;
  assert.equal(after.round.opened[0], 'sets');
});

test('never discards an işlek tile (or an okey) when a safe tile exists', () => {
  const table = [{ owner: 1, kind: 'run', tiles: [T(0, 4), T(0, 5), T(0, 6)], color: 0, start: 4 }];
  // Unopened, so it cannot lay off: red 7 and red 3 fit the table and must not be thrown.
  const hand = [T(0, 7), T(0, 3), T(1, 2), T(2, 9), T(3, 12), T(1, 5), T(2, 1), T(3, 11, 0)];
  for (const level of ['kalfa', 'usta', 'uzman']) {
    for (let s = 0; s < 20; s++) {
      const m = crafted({ hand, table, opened: [false, 'sets', false, false] });
      const a = createBot({ level, seed: 'i' + s }).decide(E.viewFor(m, 0));
      assert.equal(a.type, 'discard');
      assert.ok(!isIslek(a.tile, table, m.round.okey), `${level} threw işlek ${a.tile}`);
      assert.notEqual(a.tile, T(3, 11, 0), 'never the okey');
    }
  }
});

test('takes a discard only when it can lay it down this turn', () => {
  const table = [{ owner: 1, kind: 'run', tiles: [T(0, 4), T(0, 5), T(0, 6)], color: 0, start: 4 }];
  const hand = [T(1, 2), T(2, 9), T(3, 12), T(1, 5), T(2, 1), T(1, 9)];
  const at = (top) => {
    const m = crafted({ hand, table, opened: ['sets', 'sets', false, false] });
    m.round.stage = 'draw';
    m.round.discards[3] = [top];
    return m;
  };
  const bot = () => createBot({ level: 'uzman', params: { blunder: 0 }, seed: 3 });
  // red 7 extends the table run: take it and lay it off in the same turn.
  const { actions, match } = playTurn(at(T(0, 7, 1)), bot());
  assert.deepEqual(actions[0], { type: 'draw', from: 'discard' });
  assert.equal(match.round.table[0].tiles.length, 4);
  assert.ok(!actions.some((a) => a.type === 'undoTake'));
  // black 6 fits nothing: draw from the pile.
  assert.deepEqual(bot().decide(E.viewFor(at(T(3, 6)), 0)), { type: 'draw', from: 'pile' });
});

test('sheds high tiles when an opponent is about to finish', () => {
  // Opened; nothing fits the table. Seat 1 is opened with 1 tile left: throw the 13, not the 2.
  const table = [{ owner: 1, kind: 'group', tiles: [T(0, 8), T(1, 8), T(2, 8)], num: 8 }];
  const hand = [T(0, 2), T(2, 13), T(1, 4), T(3, 6)];
  const m = crafted({ hand, table, opened: ['sets', 'sets', false, false] });
  m.round.hands[1] = m.round.hands[1].slice(0, 1);
  const a = createBot({ level: 'uzman', params: { blunder: 0 }, seed: 4 }).decide(E.viewFor(m, 0));
  assert.deepEqual(a, { type: 'discard', tile: T(2, 13) });
});

// ---------------------------------------------------------------------------------------------------------
// Legality, thinking time, strength (one shared simulation)

const LADDER_MATCHES = 32; // x 9 rounds, every level in every seat equally often (worker threads)
let ladder = null;
async function runLadder() {
  if (ladder) return ladder;
  const jobs = Array.from({ length: LADDER_MATCHES }, (_, k) => ({
    variant: '101', levels: LEVEL_IDS.map((_, i) => LEVEL_IDS[(i + k) % 4]), rounds: 9, seed: 'lad' + k,
  }));
  const total = {}, islek = {}, opened = {};
  const agg = { steps: 0, takes: 0, undo: 0, maxTurnSteps: 0, first: [], later: [], rounds: 0 };
  for (const id of LEVEL_IDS) { total[id] = 0; islek[id] = 0; opened[id] = 0; }
  for (const r of await runTables(jobs)) {
    r.levels.forEach((id, i) => { total[id] += r.scores[i]; islek[id] += r.islek[i]; opened[id] += r.opened[i]; });
    agg.steps += r.steps; agg.takes += r.takes; agg.undo += r.undo; agg.rounds += r.rounds;
    agg.maxTurnSteps = Math.max(agg.maxTurnSteps, r.maxTurnSteps);
    agg.first.push(...r.delays.first); agg.later.push(...r.delays.later);
  }
  ladder = { total, islek, opened, ...agg };
  return ladder;
}

test('101 legality: thousands of bot steps accepted by the engine; takes are always used', async () => {
  const l = await runLadder();
  assert.ok(l.steps > 5000, `${l.steps} steps`);
  assert.ok(l.takes > 100, `${l.takes} takes`);
  assert.equal(l.undo, 0, 'a bot only takes what it can lay down, so it never has to give a take back');
  assert.ok(l.maxTurnSteps <= MAX_STEPS);
  assert.equal(l.islek.uzman, 0, 'the expert never throws an işlek tile');
});

test('101 thinking time: first step of a turn slower than the follow-up steps, all within 350..4000 ms', async () => {
  const { first, later } = await runLadder();
  const all = [...first, ...later];
  assert.ok(all.every((d) => Number.isInteger(d) && d >= 350 && d <= 4000));
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  assert.ok(mean(later) < mean(first), `${mean(later)} vs ${mean(first)}`);
});

// 288 rounds with ±202 swings: robust for uzman vs cirak/kalfa; vs usta only a guard (see DESIGN.md "Bots").
test('101 strength ladder: lower total penalty is better; uzman clearly beats cirak and kalfa', async () => {
  const { total, rounds, islek, opened } = await runLadder();
  const rows = LEVEL_IDS.map((id) =>
    `${LEVELS[id].name.padEnd(6)} total ${String(total[id]).padStart(6)}  per round ${(total[id] / rounds).toFixed(1).padStart(5)}  opened ${(100 * opened[id] / rounds).toFixed(0)}%  işlek ${islek[id]}`);
  console.log(`101 ladder over ${rounds} rounds:\n  ${rows.join('\n  ')}`);
  assert.ok(total.uzman <= 0.9 * total.cirak, 'uzman at least 10% lower than cirak');
  assert.ok(total.uzman < total.kalfa, 'uzman below kalfa');
  assert.ok(total.uzman / rounds <= total.usta / rounds + 5, 'uzman not clearly above usta');
});

test('CPU budget (101): uzman thinks under 60 ms per step on average and under 300 ms at worst', () => {
  const cpu = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
  const times = [];
  const bots = botsFor(['uzman', 'uzman', 'uzman', 'uzman'], 'cpu101').map((b) => ({
    observe: (e) => b.observe(e),
    delayMs(v) { const t = cpu(); const r = b.delayMs(v); this.pending = cpu() - t; return r; },
    decide(v) { const t = cpu(); const r = b.decide(v); times.push(this.pending + cpu() - t); return r; },
  }));
  playMatch({ bots, seed: 'cpu101', rounds: 4 });
  const warm = times.slice(20);
  const avg = warm.reduce((a, b) => a + b, 0) / warm.length;
  const max = Math.max(...warm);
  console.log(`101 uzman decide: ${warm.length} steps, avg ${avg.toFixed(1)} ms, max ${max.toFixed(1)} ms (CPU)`);
  assert.ok(avg < 60, `avg ${avg}`);
  assert.ok(max < 300, `max ${max}`);
});
