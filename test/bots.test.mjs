// Bots: no cheating, no shared state, legal moves, plausible behaviour, and a strength ladder.
// node --test test/bots.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  newMatch, startRound, act, viewFor, eventsFor, seededRng, finishOptions, otherCopy, isOkey, tileId, okeyFace,
} from '../site/shared/okey/index.js';
import { createBot, LEVELS, LEVEL_IDS, resolveParams, MAX_MEMORY, MIN_DECAY } from '../site/shared/bots/index.js';
import { Memory } from '../site/shared/bots/memory.js';
import { guard } from './botguard.mjs';

// ---------------------------------------------------------------------------------------------------------
// Harness

function seatsFor(levels) {
  return levels.map((level, i) => ({ id: 'p' + i, name: 'P' + i, kind: 'bot', bot: { level } }));
}

/**
 * Plays `rounds` rounds with the given bots (only their own events and views). Every action goes through
 * the engine's act(), which throws on anything illegal. Returns wins and score changes per seat.
 */
function playRounds({ bots, rounds, seed, wrap = (v) => v, onAction, beforeAction, onEvents }) {
  const deal = seededRng('deal-' + seed);
  let match = newMatch({ seats: seatsFor(bots.map(() => 'x')), settings: { startPoints: 1e9 } });
  const wins = [0, 0, 0, 0];
  const points = [0, 0, 0, 0];
  let actions = 0;
  let empty = 0;
  const send = (events) => {
    onEvents?.(events);
    for (let s = 0; s < 4; s++) for (const e of eventsFor(events, s)) bots[s].observe(structuredClone(e));
  };
  for (let k = 0; k < rounds; k++) {
    let res = startRound(match, deal);
    match = res.match;
    send(res.events);
    while (match.phase === 'playing') {
      const seat = match.round.turn;
      const view = viewFor(match, seat);
      beforeAction?.({ seat, view, match });
      const ms = bots[seat].delayMs(wrap(view));
      const action = bots[seat].decide(wrap(view));
      onAction?.({ seat, view, action, ms, match });
      res = act(match, seat, action); // throws GameError on an illegal action
      match = res.match;
      send(res.events);
      actions++;
      if (actions > 1e6) throw new Error('runaway');
    }
    const r = match.result;
    if (r.winner === null) empty++;
    else wins[r.winner]++;
    for (let s = 0; s < 4; s++) points[s] += r.deltas[s];
  }
  return { wins, points, actions, empty };
}

const ladderBots = (levels, seed) => levels.map((level, i) => createBot({ level, seed: `${seed}-${i}` }));

// ---------------------------------------------------------------------------------------------------------
// API and levels

test('LEVELS: four levels in ladder order with Turkish names; memory is never perfect', () => {
  assert.deepEqual(LEVEL_IDS, ['cirak', 'kalfa', 'usta', 'uzman']);
  assert.deepEqual(Object.keys(LEVELS), LEVEL_IDS);
  assert.deepEqual(LEVEL_IDS.map((id) => LEVELS[id].name), ['Çırak', 'Kalfa', 'Usta', 'Uzman']);
  for (const id of LEVEL_IDS) {
    const p = LEVELS[id].params;
    assert.ok(p.memory <= MAX_MEMORY && p.memory <= 0.9, id);
    assert.ok(p.decay > 0, id);
    assert.equal(LEVELS[id].id, id);
  }
  const memories = LEVEL_IDS.map((id) => LEVELS[id].params.memory);
  assert.deepEqual(memories, [...memories].sort((a, b) => a - b), 'memory grows with level');
  const blunders = LEVEL_IDS.map((id) => LEVELS[id].params.blunder);
  assert.deepEqual(blunders, [...blunders].sort((a, b) => b - a), 'blunders shrink with level');
  assert.ok(Object.isFrozen(LEVELS) && Object.isFrozen(LEVELS.uzman.params));
});

test('custom params override a level and are clamped (even a custom bot forgets)', () => {
  const p = resolveParams('usta', { defense: 0.1, memory: 1, decay: 0, blunder: 7, speed: 'fast', bogus: 1 });
  assert.equal(p.defense, 0.1);
  assert.equal(p.memory, MAX_MEMORY);
  assert.equal(p.decay, MIN_DECAY);
  assert.equal(p.blunder, 1);
  assert.equal(p.speed, LEVELS.usta.params.speed);
  assert.equal('bogus' in p, false);
  assert.equal(createBot({ level: 'nope', seed: 1 }).level, 'kalfa');
  const bot = createBot({ level: 'cirak', params: { lookahead: 3 }, seed: 1 });
  assert.equal(bot.params.lookahead, 3);
  assert.equal(bot.params.memory, LEVELS.cirak.params.memory);
});

// ---------------------------------------------------------------------------------------------------------
// No cheating, no shared state

test('no-cheat: decide/delayMs only read documented view fields, never seat identity, never write', () => {
  const seen = new Set();
  const bots = ladderBots(['uzman', 'cirak', 'usta', 'kalfa'], 'proxy');
  const res = playRounds({ bots, rounds: 3, seed: 'proxy', wrap: (v) => guard(v, 'root', 'view', seen) });
  assert.ok(res.actions > 100);
  for (const p of seen) assert.ok(!/^view\.seats\.\d+\.(kind|bot|name|avatar|connected|away|id)$/.test(p), p);
  // Sanity of the guard itself.
  const g = guard(viewFor(newMatch({ seats: seatsFor(['a', 'b', 'c', 'd']) }), 0), 'root', 'view');
  assert.throws(() => g.seats[1].kind, /forbidden/);
  assert.throws(() => g.seats[1].name, /forbidden/);
  assert.throws(() => { g.you = 3; }, /wrote/);
});

test('no-cheat: a bot works on a deep-frozen view and on the host-style masked view', () => {
  const deepFreeze = (o) => {
    if (o && typeof o === 'object') { Object.values(o).forEach(deepFreeze); Object.freeze(o); }
    return o;
  };
  const mask = (v) => ({ ...v, seats: v.seats.map(({ kind, bot, id, ...rest }) => rest) });
  const bots = ladderBots(['usta', 'kalfa', 'uzman', 'cirak'], 'frozen');
  const res = playRounds({ bots, rounds: 2, seed: 'frozen', wrap: (v) => deepFreeze(mask(v)) });
  assert.ok(res.actions > 50);
});

test('no-cheat: the pile order and other hands never influence a decision', () => {
  // Two matches that differ only in the pile order beyond what has been drawn (and in other hands): the
  // bot on turn sees the same view and the same events, so it must make the same decision.
  const seat = 1;
  let match = newMatch({ seats: seatsFor(['a', 'b', 'c', 'd']) });
  ({ match } = startRound(match, seededRng('pile')));
  const events = startRound(newMatch({ seats: seatsFor(['a', 'b', 'c', 'd']) }), seededRng('pile')).events;
  const other = structuredClone(match);
  other.round.pile.reverse();
  // swap hands of seats 2 and 3 (seat 1 can't see them)
  [other.round.hands[2], other.round.hands[3]] = [other.round.hands[3], other.round.hands[2]];
  const a = createBot({ level: 'uzman', seed: 'same' });
  const b = createBot({ level: 'uzman', seed: 'same' });
  for (const e of eventsFor(events, seat)) { a.observe(e); b.observe(e); }
  // dealer (seat 0) discards first; give both the same public event
  const dealerTile = match.round.hands[0][0];
  const m1 = act(match, 0, { type: 'discard', tile: dealerTile });
  for (const e of eventsFor(m1.events, seat)) { a.observe(e); b.observe(e); }
  const otherHands = structuredClone(m1.match);
  otherHands.round.pile.reverse();
  otherHands.round.hands[2] = m1.match.round.hands[3];
  otherHands.round.hands[3] = m1.match.round.hands[2];
  assert.deepEqual(viewFor(otherHands, seat).hand, viewFor(m1.match, seat).hand);
  assert.deepEqual(a.decide(viewFor(m1.match, seat)), b.decide(viewFor(otherHands, seat)));
});

test('bots never use Math.random and are deterministic per seed', () => {
  const orig = Math.random;
  Math.random = () => { throw new Error('Math.random used'); };
  try {
    const log = (seed) => {
      const out = [];
      playRounds({ bots: ladderBots(['cirak', 'kalfa', 'usta', 'uzman'], seed), rounds: 2, seed: 'det',
        onAction: ({ action, ms }) => out.push(JSON.stringify(action) + ms) });
      return out;
    };
    assert.deepEqual(log('x'), log('x'));
    assert.notDeepEqual(log('x'), log('y'));
  } finally {
    Math.random = orig;
  }
});

test('two bots never share state: feeding one does not change another', () => {
  // c is a twin of b. a (same seed) is fed a whole other game first; b and c then see identical input
  // and must decide identically, and a's history must not leak into them.
  const a = createBot({ level: 'uzman', seed: 'twin' });
  const b = createBot({ level: 'uzman', seed: 'twin' });
  const c = createBot({ level: 'uzman', seed: 'twin' });
  playRounds({ bots: [a, ...ladderBots(['usta', 'kalfa', 'cirak'], 'noise')], rounds: 1, seed: 'noise' });
  const before = JSON.stringify(b.snapshot());
  assert.equal(before, JSON.stringify(c.snapshot()));
  assert.notEqual(JSON.stringify(a.snapshot()), before);
  const decisions = [[], []];
  playRounds({ bots: [b, ...ladderBots(['usta', 'kalfa', 'cirak'], 'n2')], rounds: 1, seed: 'pair',
    onAction: ({ seat, action }) => { if (seat === 0) decisions[0].push(action); } });
  playRounds({ bots: [c, ...ladderBots(['usta', 'kalfa', 'cirak'], 'n2')], rounds: 1, seed: 'pair',
    onAction: ({ seat, action }) => { if (seat === 0) decisions[1].push(action); } });
  assert.deepEqual(decisions[0], decisions[1]);
  assert.ok(decisions[0].length > 5);
});

test('snapshot/restore: a restored bot (JSON round trip) keeps playing exactly like the original', () => {
  const bots = ladderBots(['uzman', 'usta', 'kalfa', 'cirak'], 'snap');
  let twins = null;
  let compared = 0;
  playRounds({
    bots, rounds: 4, seed: 'snap',
    // Mid-round, clone every bot through JSON (as the host persists them); from then on the clones get the
    // same events and views and must choose exactly what the originals choose.
    beforeAction: ({ seat, view }) => {
      if (!twins && view.round.pileCount <= 30) {
        twins = bots.map((b) => createBot({ level: 'kalfa', seed: 'ignored', saved: JSON.parse(JSON.stringify(b.snapshot())) }));
      }
      if (twins) {
        twins[seat].delayMs(view);
        const mine = twins[seat].decide(view);
        twins.pending = { seat, mine };
      }
    },
    onAction: ({ seat, action }) => {
      if (twins?.pending) {
        assert.deepEqual(twins.pending.mine, action);
        assert.equal(twins.pending.seat, seat);
        twins.pending = null;
        compared++;
      }
    },
    onEvents: (events) => {
      if (twins) for (let s = 0; s < 4; s++) for (const e of eventsFor(events, s)) twins[s].observe(structuredClone(e));
    },
  });
  assert.ok(compared > 40, `compared ${compared}`);
  assert.equal(twins[0].level, 'uzman');
  assert.deepEqual(twins[0].params, bots[0].params);
});

// ---------------------------------------------------------------------------------------------------------
// Memory

test('memory: remembers about `memory` of what it sees, forgets with `decay`, resets each round', () => {
  const rng = seededRng('mem');
  const r = { chance: (p) => rng.random() < p };
  const mem = new Memory({ memory: 0.5, decay: 0 }, r);
  mem.observe({ type: 'roundStart', round: 1, dealer: 0, indicator: 5, pileCount: 48 });
  mem.observe({ type: 'dealt', to: 0, hand: [] });
  for (let i = 0; i < 400; i++) mem.observe({ type: 'discard', seat: 1 + (i % 3), tile: i % 104 });
  const throwsSeen = mem.throws[1].length + mem.throws[2].length + mem.throws[3].length;
  assert.ok(throwsSeen > 140 && throwsSeen < 260, `remembered ${throwsSeen} of 400`);

  const forget = new Memory({ memory: 0.9, decay: 0.2 }, r);
  forget.observe({ type: 'roundStart', round: 1, dealer: 0, indicator: 5, pileCount: 48 });
  forget.observe({ type: 'discard', seat: 2, tile: 7 });
  for (let i = 0; i < 40; i++) forget.observe({ type: 'discard', seat: 3, tile: 50 });
  assert.equal(forget.gone.has(7), false, 'an early discard is forgotten after many turns at decay 0.2');

  mem.observe({ type: 'roundStart', round: 2, dealer: 1, indicator: 9, pileCount: 48 });
  assert.equal(mem.gone.size, 0);
  assert.equal(mem.you, 0, 'seat survives the round reset');
});

test('memory: uzman remembers more than cirak, and neither remembers everything', () => {
  const remembered = (level) => {
    let total = 0, seen = 0;
    for (let k = 0; k < 6; k++) {
      const bot = createBot({ level, seed: 'm' + k });
      bot.observe({ type: 'roundStart', round: 1, dealer: 0, indicator: 5, pileCount: 48 });
      bot.observe({ type: 'dealt', to: 0, hand: [] });
      for (let t = 0; t < 30; t++) bot.observe({ type: 'discard', seat: 1 + (t % 3), tile: t });
      seen += 30;
      total += bot.snapshot().memory.gone.length;
    }
    return total / seen;
  };
  const cirak = remembered('cirak'), uzman = remembered('uzman');
  assert.ok(uzman > cirak + 0.3, `uzman ${uzman} vs cirak ${cirak}`);
  assert.ok(uzman < 0.95, `uzman remembers ${uzman}`);
});

// ---------------------------------------------------------------------------------------------------------
// Behaviour on crafted hands

/** A match where seat 0 (the dealer, 15 tiles, discard stage) holds `hand`. */
function craftedMatch(hand, indicator = tileId(3, 10, 1)) {
  let match = newMatch({ seats: seatsFor(['a', 'b', 'c', 'd']) });
  ({ match } = startRound(match, seededRng('craft')));
  const m = structuredClone(match);
  const r = m.round;
  const all = new Set([...hand, indicator]);
  const rest = [...r.pile, ...r.hands.flat(), r.indicator].filter((t) => !all.has(t));
  r.indicator = indicator;
  r.okey = okeyFace(indicator);
  r.hands = [hand.slice(), rest.splice(0, 14), rest.splice(0, 14), rest.splice(0, 14)];
  r.pile = rest;
  return m;
}
const T = (c, n, cp = 0) => tileId(c, n, cp);

test('finishes whenever it can, preferring a finish by throwing the okey', () => {
  // okey = black 11 (indicator black 10). Hand: 14 tiles in runs + an okey: it can finish by throwing
  // a run end (the okey stays in) or by throwing the okey itself (double points).
  const okeyTile = T(3, 11, 0);
  const hand = [T(0, 1), T(0, 2), T(0, 3), T(1, 4), T(1, 5), T(1, 6), T(2, 7), T(2, 8), T(2, 9),
    T(0, 9), T(0, 10), T(0, 11), T(0, 12), T(0, 13), okeyTile];
  const m = craftedMatch(hand);
  assert.ok(isOkey(okeyTile, m.round.okey));
  const opts = finishOptions(hand, m.round.okey);
  assert.ok(opts.some((o) => o.okeyFinish) && opts.some((o) => !o.okeyFinish));
  for (const level of LEVEL_IDS) {
    for (let s = 0; s < 5; s++) {
      const bot = createBot({ level, seed: s });
      const action = bot.decide(viewFor(m, 0));
      assert.equal(action.type, 'finish', level);
      assert.equal(action.tile, okeyTile, `${level} should finish with the okey`);
      act(m, 0, action);
    }
  }
});

test('blunders stay plausible: never break a complete set while a loose tile exists, never throw an okey', () => {
  const okeyTile = T(3, 11, 1);
  const sets = [T(0, 1), T(0, 2), T(0, 3), T(1, 7), T(1, 8), T(1, 9), T(2, 10), T(2, 11), T(2, 12),
    T(3, 4), T(3, 5), T(3, 6)];
  const loose = [T(0, 9), T(1, 2), T(2, 5)];
  const hand = [...sets.slice(0, 11), okeyTile, ...loose]; // the last black run becomes 4-5 + okey
  hand.splice(hand.indexOf(T(3, 4)), 1, T(3, 4));
  const m = craftedMatch([...sets, ...loose]);
  const m2 = craftedMatch([...sets.slice(0, 11), okeyTile, ...loose]);
  for (let s = 0; s < 60; s++) {
    const bot = createBot({ level: 'cirak', params: { blunder: 1 }, seed: 'b' + s });
    const a = bot.decide(viewFor(m, 0));
    assert.equal(a.type, 'discard');
    assert.ok(loose.includes(a.tile), `blunder broke a set with ${a.tile}`);
    const bot2 = createBot({ level: 'cirak', params: { blunder: 1 }, seed: 'c' + s });
    const a2 = bot2.decide(viewFor(m2, 0));
    assert.notEqual(a2.tile, okeyTile);
    assert.ok(!isOkey(a2.tile, m2.round.okey));
  }
});

test('shows the indicator on its first turn when holding the other copy; beginners sometimes forget', () => {
  const ind = T(3, 10, 1);
  const hand = [otherCopy(ind), T(0, 1), T(0, 2), T(0, 3), T(1, 4), T(1, 5), T(1, 6), T(2, 7), T(2, 8),
    T(2, 13), T(0, 9), T(0, 12), T(1, 12), T(1, 1), T(2, 3)];
  const m = craftedMatch(hand, ind);
  let shows = 0;
  for (let s = 0; s < 40; s++) {
    const a = createBot({ level: 'uzman', params: { blunder: 0 }, seed: s }).decide(viewFor(m, 0));
    assert.deepEqual(a, { type: 'showIndicator' });
    const c = createBot({ level: 'cirak', seed: s }).decide(viewFor(m, 0));
    if (c.type === 'showIndicator') shows++;
  }
  assert.ok(shows > 15 && shows < 40, `cirak showed ${shows}/40`);
  // After showing, the next decision is a normal move.
  const bot = createBot({ level: 'usta', params: { blunder: 0 }, seed: 1 });
  const { match } = act(m, 0, bot.decide(viewFor(m, 0)));
  const next = bot.decide(viewFor(match, 0));
  assert.ok(next.type === 'discard' || next.type === 'finish');
  act(match, 0, next);
});

test('decide returns null when it is not the bot\'s move', () => {
  const m = craftedMatch([T(0, 1), T(0, 2), T(0, 3), T(1, 4), T(1, 5), T(1, 6), T(2, 7), T(2, 8), T(2, 9),
    T(0, 9), T(0, 10), T(0, 11), T(1, 12), T(1, 13), T(2, 1)]);
  const bot = createBot({ level: 'usta', seed: 1 });
  assert.equal(bot.decide(viewFor(m, 2)), null);
  assert.equal(bot.delayMs(viewFor(m, 2)), 0);
  assert.equal(bot.decide(viewFor(m, null)), null);
});

// ---------------------------------------------------------------------------------------------------------
// Legality, thinking time, strength

// One shared simulation: 4 tables x 40 rounds, each level in every seat once.
const LADDER_ROUNDS = 40;
let ladder = null;
function runLadder() {
  if (ladder) return ladder;
  const wins = {}, points = {}, delays = {};
  let actions = 0, rounds = 0, empty = 0;
  for (const id of LEVEL_IDS) { wins[id] = 0; points[id] = 0; delays[id] = []; }
  for (let k = 0; k < 4; k++) {
    const order = LEVEL_IDS.map((_, i) => LEVEL_IDS[(i + k) % 4]);
    const res = playRounds({
      bots: ladderBots(order, 'ladder' + k), rounds: LADDER_ROUNDS, seed: 'ladder' + k,
      onAction: ({ seat, ms }) => delays[order[seat]].push(ms),
    });
    order.forEach((id, i) => { wins[id] += res.wins[i]; points[id] += res.points[i]; });
    actions += res.actions;
    rounds += LADDER_ROUNDS;
    empty += res.empty;
  }
  ladder = { wins, points, delays, actions, rounds, empty };
  return ladder;
}

test('legality: thousands of bot actions, all accepted by the engine', () => {
  const { actions, rounds } = runLadder();
  assert.ok(actions > 5000, `${actions} actions`);
  assert.equal(rounds, 4 * LADDER_ROUNDS);
});

test('thinking time: human-like, 350..4000 ms, beginners slower than experts', () => {
  const { delays } = runLadder();
  const all = Object.values(delays).flat();
  assert.ok(all.every((d) => Number.isInteger(d) && d >= 350 && d <= 4000));
  const sorted = all.slice().sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1];
  assert.ok(median >= 700 && median <= 2500, `median ${median}`);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  assert.ok(mean(delays.cirak) > mean(delays.uzman) * 1.2);
  assert.ok(new Set(all).size > 100, 'jittered');
});

test('strength ladder: uzman beats cirak decisively; usta > kalfa > cirak in round wins', () => {
  const { wins, points, rounds, empty } = runLadder();
  const share = (id) => wins[id] / rounds;
  const table = LEVEL_IDS.map((id) =>
    `${LEVELS[id].name.padEnd(6)} wins ${String(wins[id]).padStart(3)} (${(100 * share(id)).toFixed(1)}%)  points ${points[id]}`);
  console.log(`ladder over ${rounds} rounds (${empty} with an empty pile):\n  ${table.join('\n  ')}`);
  assert.ok(wins.uzman >= 2 * wins.cirak, 'uzman wins at least twice as often as cirak');
  assert.ok(share('uzman') - share('cirak') >= 0.12);
  assert.ok(wins.usta > wins.kalfa && wins.kalfa > wins.cirak);
  assert.ok(points.uzman > points.cirak);
});
