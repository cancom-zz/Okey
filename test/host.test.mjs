// TableHost tests (node --test). The host is driven with a fake clock, a fake scheduler and a recording send.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as engine from '../site/shared/okey/index.js';
import * as config from '../site/js/config.js';
import {
  TableHost, AVATARS, BOT_AVATAR, EMOTES, LEVELS, MAX_CONNECTIONS, NEXT_ROUND_MS, AUTOPLAY_MS, cleanName,
} from '../site/shared/host.js';

const T0 = 1_800_000_000_000;
const ident = (n) => ({ id: `player-${n}-id`, secret: `secret-${n}-xyz`, name: `Oyuncu ${n}`, avatar: AVATARS[n % AVATARS.length] });

/** A host with a fake clock. `rng` defaults to a seeded one; `engine` can be wrapped to observe raw events. */
function harness({ seed = 7, settings, saved, rng, eng, onSend } = {}) {
  const h = {
    t: saved ? null : T0, wakeAt: null, log: [], results: [], closed: [],
  };
  h.rng = rng || engine.seededRng(seed);
  h.host = new TableHost({
    code: 'ABCDEF', settings, saved, rng: h.rng, engine: eng,
    now: () => h.t,
    schedule: (at) => { h.wakeAt = at; },
    send: (connId, msg) => {
      const m = JSON.parse(JSON.stringify(msg));
      if (onSend) onSend(connId, m, h.host);
      h.log.push([connId, m]);
    },
    close: (connId, code) => h.closed.push([connId, code]),
    onResult: (s) => h.results.push(JSON.parse(JSON.stringify(s))),
  });
  h.msgs = (id) => h.log.filter(([c]) => c === id).map(([, m]) => m);
  h.view = (id) => h.msgs(id).filter((m) => m.t === 'view').at(-1)?.view;
  h.errors = (id) => h.msgs(id).filter((m) => m.t === 'error').map((m) => m.code);
  h.say = (id, msg) => { h.t += 250; h.host.message(id, msg); };
  h.join = (id, n, lang = 'tr') => { h.host.connect(id); h.say(id, { t: 'hello', player: ident(n), lang }); };
  /** Fire the next scheduled wake (advancing the clock to it). false if nothing is scheduled. */
  h.step = () => {
    if (h.wakeAt === null) return false;
    h.t = Math.max(h.t, h.wakeAt);
    h.host.wake();
    return true;
  };
  h.advance = (ms) => {
    const end = h.t + ms;
    while (h.wakeAt !== null && h.wakeAt <= end) h.step();
    h.t = end;
  };
  return h;
}

/** Seat a human in 0 (host) and bots in 1..3, then start. */
function soloTable(h, levels = ['kalfa', 'usta', 'uzman']) {
  h.join('c1', 1);
  h.say('c1', { t: 'sit', seat: 0 });
  levels.forEach((level, i) => h.say('c1', { t: 'addBot', seat: i + 1, level }));
  h.say('c1', { t: 'start' });
}

/** The scripted human: draw from the pile; finish if possible; else discard the last non-okey tile. */
function humanAction(view) {
  const r = view.round;
  if (r.stage === 'draw') return { type: 'draw', from: 'pile' };
  const opts = engine.finishOptions(view.hand, r.okey);
  if (opts.length) return { type: 'finish', tile: opts[0].discard, groups: opts[0].groups };
  const tile = view.hand.filter((t) => !engine.isOkey(t, r.okey)).at(-1) ?? view.hand[0];
  return { type: 'discard', tile };
}

/**
 * Plays the human on connection `id` until `stop()`: acts on its turn (skipping every `skipEvery`-th turn
 * so the timer runs out), presses next on even rounds, otherwise lets time run.
 */
function play(h, id, { stop, skipEvery = 6, maxSteps = 100_000 } = {}) {
  let turns = 0;
  let lastKey = null;
  let skipping = false;
  const pressed = new Set();
  for (let i = 0; i < maxSteps; i++) {
    const v = h.view(id);
    if (stop(v)) return v;
    if (v.phase === 'playing' && v.round.turn === v.you) {
      const key = h.host.turnKey;
      if (key !== lastKey) {
        lastKey = key;
        turns += 1;
        skipping = skipEvery > 0 && turns % skipEvery === 0;
      }
      if (!skipping) {
        h.say(id, { t: 'act', action: humanAction(v), v: v.v });
        continue;
      }
    }
    if (v.phase === 'roundEnd' && v.round.number % 2 === 0 && !pressed.has(v.round.number)) {
      pressed.add(v.round.number);
      h.say(id, { t: 'next' });
      continue;
    }
    assert.ok(h.step(), `nothing scheduled in phase ${v.phase}`);
  }
  throw new Error('game did not finish');
}

// ------------------------------------------------------------------------------------------------ lobby

test('config lists match the host (avatars, emotes, levels)', () => {
  assert.deepEqual(AVATARS, config.AVATARS);
  assert.deepEqual(EMOTES, config.EMOTES.map((e) => e.id));
  assert.deepEqual(LEVELS, config.LEVELS);
  assert.deepEqual(BOT_AVATAR, config.BOT_AVATAR);
});

test('lobby: sit, host, bots, settings, start; permissions', () => {
  const h = harness();
  h.join('a', 1);
  h.join('b', 2);
  let v = h.view('a');
  assert.equal(v.phase, 'lobby');
  assert.equal(v.you, null);
  assert.equal(v.host, null);
  h.say('b', { t: 'addBot', seat: 1, level: 'kalfa' });
  assert.deepEqual(h.errors('b'), ['notHost']); // spectator
  h.say('a', { t: 'sit', seat: 2 });
  h.say('b', { t: 'sit', seat: 2 });
  assert.deepEqual(h.errors('b').at(-1), 'seatTaken');
  h.say('b', { t: 'sit', seat: 0 });
  v = h.view('b');
  assert.equal(v.host, 2, 'first human to sit is the host');
  assert.equal(v.you, 0);
  assert.equal(v.seats[2].name, 'Oyuncu 1');
  assert.equal(v.seats[2].connected, true);
  // non-host can't do host things
  for (const msg of [{ t: 'addBot', seat: 1, level: 'usta' }, { t: 'removeBot', seat: 1 }, { t: 'settings', settings: { turnSeconds: 45 } }, { t: 'start' }]) {
    h.say('b', msg);
    assert.equal(h.errors('b').at(-1), 'notHost', msg.t);
  }
  h.say('a', { t: 'start' });
  assert.equal(h.errors('a').at(-1), 'seatsNotFull');
  h.say('a', { t: 'addBot', seat: 1, level: 'nope' });
  assert.equal(h.errors('a').at(-1), 'badMessage');
  h.say('a', { t: 'addBot', seat: 1, level: 'usta', params: { memory: 1 } });
  assert.equal(h.errors('a').at(-1), 'badMessage', 'perfect memory is not allowed');
  h.say('a', { t: 'addBot', seat: 1, level: 'usta', params: { defense: 0.9 } });
  h.say('a', { t: 'addBot', seat: 3, level: 'cirak' });
  h.say('a', { t: 'removeBot', seat: 3 });
  h.say('a', { t: 'addBot', seat: 3, level: 'uzman' });
  v = h.view('a');
  assert.deepEqual(v.seats.map((s) => s.kind), ['human', 'bot', 'human', 'bot']);
  assert.deepEqual(v.seats[1].bot, { level: 'usta' });
  assert.equal(v.seats[1].avatar, BOT_AVATAR.usta);
  assert.notEqual(v.seats[1].name, v.seats[3].name);
  h.say('a', { t: 'settings', settings: { turnSeconds: 5 } });
  assert.equal(h.errors('a').at(-1), 'badSettings');
  h.say('a', { t: 'settings', settings: { turnSeconds: 45, rounds: 3 } });
  assert.equal(h.view('b').settings.turnSeconds, 45);
  assert.equal(h.view('b').settings.rounds, 3);
  // the host stands up: host passes to the other human
  h.say('a', { t: 'stand' });
  assert.equal(h.view('b').host, 0);
  h.say('a', { t: 'sit', seat: 2 });
  assert.equal(h.view('a').host, 0);
  h.say('b', { t: 'start' });
  v = h.view('a');
  assert.equal(v.phase, 'playing');
  assert.equal(v.hand.length, v.round.dealer === 2 ? 15 : 14);
  assert.equal(h.view('b').hand.length, v.round.dealer === 0 ? 15 : 14);
  // no seat changes mid-match
  h.say('a', { t: 'stand' });
  assert.equal(h.errors('a').at(-1), 'wrongPhase');
  h.say('b', { t: 'addBot', seat: 1, level: 'kalfa' });
  assert.equal(h.errors('b').at(-1), 'wrongPhase');
});

test('host passes on disconnect; a disconnected human can be removed in the lobby', () => {
  const h = harness();
  h.join('a', 1);
  h.join('b', 2);
  h.say('a', { t: 'sit', seat: 0 });
  h.say('b', { t: 'sit', seat: 1 });
  h.host.disconnect('a');
  let v = h.view('b');
  assert.equal(v.host, 1);
  assert.equal(v.seats[0].connected, false);
  h.say('b', { t: 'removeBot', seat: 0 });
  v = h.view('b');
  assert.equal(v.seats[0].kind, 'empty');
});

test('validation: hello first, names, avatars, sizes, identity', () => {
  const h = harness();
  h.host.connect('a');
  h.say('a', { t: 'sit', seat: 0 });
  assert.equal(h.errors('a').at(-1), 'helloFirst');
  for (const name of ['', '   ', 'x'.repeat(21), '​​', '\u0007', 42, null]) {
    h.say('a', { t: 'hello', player: { ...ident(1), name } });
    assert.equal(h.errors('a').at(-1), 'badName', JSON.stringify(name));
  }
  assert.equal(cleanName('  Ali   Veli  '), 'Ali Veli');
  assert.equal(cleanName('Zeynep 🦊'), 'Zeynep 🦊');
  assert.equal(cleanName('a'.repeat(20)), 'a'.repeat(20));
  for (const player of [null, { ...ident(1), id: 'short' }, { ...ident(1), secret: 'has space in it' }, 'x']) {
    h.say('a', { t: 'hello', player });
    assert.equal(h.errors('a').at(-1), 'badMessage');
  }
  h.say('a', { t: 'hello', player: { ...ident(1), avatar: '<script>' } });
  h.say('a', { t: 'sit', seat: 0 });
  assert.equal(h.view('a').seats[0].avatar, AVATARS[0], 'unknown avatar falls back to a preset');
  h.say('a', { t: 'hello', player: { ...ident(1), name: 'x'.repeat(5000) } });
  assert.equal(h.errors('a').at(-1), 'badMessage', 'oversized message');
  for (const msg of [null, [], 'hi', { t: 'nope' }, { t: 'sit', seat: 9 }, { t: 'sit', seat: '0' }]) {
    h.say('a', msg);
    assert.equal(h.errors('a').at(-1), 'badMessage', JSON.stringify(msg));
  }
  // same id, wrong secret
  h.host.connect('b');
  h.say('b', { t: 'hello', player: { ...ident(1), secret: 'another-secret' } });
  assert.equal(h.errors('b').at(-1), 'badIdentity');
  assert.equal(h.view('b'), undefined);
});

test('max connections; one socket per identity (newer replaces older)', () => {
  const h = harness();
  for (let i = 0; i < MAX_CONNECTIONS; i++) assert.equal(h.host.connect(`c${i}`), true);
  assert.equal(h.host.connect('extra'), false);
  assert.deepEqual(h.errors('extra'), ['full']);
  assert.deepEqual(h.closed.at(-1), ['extra', 4001]);
  h.say('c0', { t: 'hello', player: ident(1) });
  h.say('c0', { t: 'sit', seat: 1 });
  h.say('c1', { t: 'hello', player: ident(1) });
  assert.deepEqual(h.errors('c0').at(-1), 'replaced');
  assert.deepEqual(h.closed.at(-1), ['c0', 4002]);
  assert.equal(h.view('c1').you, 1);
  h.say('c0', { t: 'stand' }); // the old socket is gone from the host
  assert.equal(h.view('c1').seats[1].kind, 'human');
});

test('rate limit: burst 20, then 5 per second', () => {
  const h = harness();
  h.host.connect('a');
  for (let i = 0; i < 25; i++) h.host.message('a', { t: 'ping' });
  const msgs = h.msgs('a');
  assert.equal(msgs.filter((m) => m.t === 'pong').length, 20);
  assert.equal(msgs.filter((m) => m.code === 'rateLimited').length, 5);
  h.t += 1000;
  for (let i = 0; i < 6; i++) h.host.message('a', { t: 'ping' });
  assert.equal(h.msgs('a').filter((m) => m.t === 'pong').length, 25);
  assert.equal(h.msgs('a').filter((m) => m.code === 'rateLimited').length, 6);
});

test('emotes: preset ids, seated only, rate limited, broadcast', () => {
  const h = harness();
  h.join('a', 1);
  h.join('b', 2);
  h.say('a', { t: 'emote', id: 'clap' });
  assert.equal(h.errors('a').at(-1), 'notSeated');
  h.say('a', { t: 'sit', seat: 3 });
  h.say('a', { t: 'emote', id: 'free text!' });
  assert.equal(h.errors('a').at(-1), 'badMessage');
  h.say('a', { t: 'emote', id: 'clap' });
  assert.deepEqual(h.msgs('b').at(-1), { t: 'emote', seat: 3, id: 'clap' });
  h.say('a', { t: 'emote', id: 'wow' });
  assert.equal(h.errors('a').at(-1), 'rateLimited');
  h.t += 2000;
  h.say('a', { t: 'emote', id: 'wow' });
  assert.deepEqual(h.msgs('b').at(-1), { t: 'emote', seat: 3, id: 'wow' });
});

// ------------------------------------------------------------------------------------------------ the game

test('reconnect with the same identity takes the seat back', () => {
  const h = harness();
  soloTable(h);
  const before = h.view('c1');
  assert.equal(before.phase, 'playing');
  h.host.disconnect('c1');
  assert.equal(h.host.nextWakeAt(), null, 'empty room is paused');
  h.t += 60_000;
  h.join('c9', 1);
  const v = h.view('c9');
  assert.equal(v.you, 0);
  assert.deepEqual([...v.hand].sort((a, b) => a - b), [...before.hand].sort((a, b) => a - b));
  assert.equal(v.seats[0].connected, true);
  assert.equal(v.host, 0);
  if (v.round.turn === 0) assert.ok(v.round.turnEndsAt - h.t > 25_000, 'pause shifted the turn timer');
});

test('stale version is rejected; illegal moves report the engine code', () => {
  const h = harness({ seed: 3 });
  soloTable(h);
  while (h.view('c1').round.turn !== 0) h.step();
  const v = h.view('c1');
  if (v.round.stage === 'draw') {
    h.say('c1', { t: 'act', action: { type: 'discard', tile: v.hand[0] }, v: v.v });
    assert.equal(h.errors('c1').at(-1), 'mustDraw');
    h.say('c1', { t: 'act', action: { type: 'draw', from: 'pile' }, v: v.v });
  } else {
    h.say('c1', { t: 'act', action: { type: 'draw', from: 'pile' }, v: v.v });
    assert.equal(h.errors('c1').at(-1), 'mustDiscard');
    h.say('c1', { t: 'act', action: { type: 'discard', tile: v.hand[0] }, v: v.v });
  }
  const errs = h.errors('c1').length;
  const v2 = h.view('c1');
  assert.ok(v2.v > v.v);
  h.say('c1', { t: 'act', action: humanAction(v2), v: v.v });
  assert.equal(h.errors('c1').at(-1), 'stale');
  assert.equal(h.errors('c1').length, errs + 1);
  h.say('c1', { t: 'act', action: { type: 'discard', tile: 999 }, v: v2.v });
  assert.equal(h.errors('c1').at(-1), 'badAction');
  h.say('c1', { t: 'act', action: { type: 'draw', from: 'pile' }, v: v2.v + 50 });
  assert.equal(h.errors('c1').at(-1), 'stale', 'a version from the future is stale too');
});

test('timeouts: auto-play marks away; 2+ timeouts auto-play at once; any action clears away', () => {
  const h = harness({ seed: 11, settings: { turnSeconds: 15 } });
  soloTable(h);
  const waitTurn = () => { while (!(h.view('c1').phase === 'playing' && h.view('c1').round.turn === 0)) h.step(); };
  waitTurn();
  let v = h.view('c1');
  const start = h.t;
  assert.ok(v.round.turnEndsAt >= h.t && v.round.turnEndsAt <= h.t + 15_000);
  h.step(); // the timer runs out: the whole turn is played
  assert.ok(h.t - start <= 15_000);
  v = h.view('c1');
  assert.equal(v.seats[0].away, true);
  assert.notEqual(v.round?.turn, 0);
  waitTurn();
  const t2 = h.t;
  h.step(); // second timeout, full time
  assert.ok(h.t - t2 > 10_000);
  waitTurn();
  v = h.view('c1');
  assert.ok(v.round.turnEndsAt - h.t <= AUTOPLAY_MS, 'away for 2 timeouts: auto-played right away');
  const t3 = h.t;
  h.step();
  assert.ok(h.t - t3 <= AUTOPLAY_MS);
  waitTurn();
  v = h.view('c1');
  h.say('c1', { t: 'act', action: humanAction(v), v: v.v });
  v = h.view('c1');
  assert.equal(v.seats[0].away, false, 'acting brings the player back');
});

test('full match: 1 human + 3 bots to match end, with results for stats', () => {
  const h = harness({ seed: 2024, settings: { rounds: 4 } });
  soloTable(h, ['cirak', 'kalfa', 'uzman']);
  const end = play(h, 'c1', { stop: (v) => v.phase === 'matchEnd' });
  assert.equal(end.phase, 'matchEnd');
  assert.ok(Array.isArray(end.winners) && end.winners.length >= 1);
  assert.ok(end.result && Array.isArray(end.result.hands));
  const rounds = h.results.filter((r) => r.type === 'round');
  const matches = h.results.filter((r) => r.type === 'match');
  assert.equal(rounds.length, 4);
  assert.equal(matches.length, 1);
  assert.equal(h.results.at(-1).type, 'match');
  for (const r of rounds) {
    assert.equal(r.seats.length, 4);
    assert.equal(r.seats[0].playerId, ident(1).id);
    assert.equal(r.seats[0].secret, ident(1).secret);
    assert.equal(r.seats[1].kind, 'bot');
    assert.equal(r.seats[1].botLevel, 'cirak');
    assert.equal(r.seats[1].playerId, null);
    for (const s of r.seats) {
      assert.ok(Number.isInteger(s.turns) && s.turns >= 0);
      assert.ok(Number.isInteger(s.delta) && s.delta <= 0);
    }
    if (r.winner !== null) assert.equal(r.seats[r.winner].finish, r.kind);
  }
  assert.deepEqual(matches[0].winners, end.winners);
  assert.deepEqual(matches[0].seats.map((s) => s.score), end.seats.map((s) => s.score));
  // rematch: every connected human presses next
  h.say('c1', { t: 'next' });
  const v = h.view('c1');
  assert.equal(v.phase, 'playing');
  assert.equal(v.round.number, 1);
  assert.ok(v.seats.every((s) => s.score === 20));
});

test('round end: next round after every human pressed next, or after 20 s', () => {
  const h = harness({ seed: 5, settings: { rounds: 3 } });
  soloTable(h);
  const toRoundEnd = () => play(h, 'c1', { stop: (v) => v.phase === 'roundEnd', skipEvery: 0 });
  let v = toRoundEnd();
  assert.equal(v.round.number, 1);
  const t = h.t;
  h.say('c1', { t: 'next' });
  v = h.view('c1');
  assert.equal(v.phase, 'playing');
  assert.equal(v.round.number, 2);
  assert.ok(h.t - t < 1000);
  v = toRoundEnd();
  const t2 = h.t;
  h.step();
  v = h.view('c1');
  assert.equal(v.round.number, 3);
  assert.equal(h.t - t2, NEXT_ROUND_MS);
});

test('snapshot -> restore mid-round behaves identically afterwards', () => {
  const run = (restoreAt) => {
    const h = harness({ seed: 99, settings: { rounds: 2 } });
    soloTable(h, ['kalfa', 'usta', 'uzman']);
    let steps = 0;
    let cur = h;
    let mark = 0;
    const stop = (v) => {
      steps += 1;
      if (restoreAt !== null && steps === restoreAt) {
        assert.equal(v.phase, 'playing', 'restore point is mid-round');
        // Persist, then rebuild from the snapshot as a Durable Object would after hibernation.
        const saved = JSON.parse(JSON.stringify(cur.host.snapshot()));
        const next = harness({ saved, rng: engine.seededRng(cur.rng.state()) });
        next.t = cur.t;
        next.log = cur.log; // keep one log
        next.results = cur.results;
        next.host.bind('c1', ident(1).id);
        next.wakeAt = next.host.nextWakeAt();
        Object.assign(cur, next); // `play` keeps using the same harness object
        mark = cur.log.length;
      }
      return v.phase === 'matchEnd';
    };
    play(cur, 'c1', { stop });
    return { log: cur.log, results: cur.results, mark, steps };
  };
  const a = run(null);
  const b = run(140);
  assert.ok(b.mark > 0);
  assert.equal(b.steps, a.steps);
  assert.deepEqual(b.log, a.log);
  assert.deepEqual(b.results, a.results);
});

// ------------------------------------------------------------------------------------------------ security

test('SECURITY: no message ever carries a tile its seat may not see (2 humans, 2 bots, a spectator)', () => {
  // Wrap the engine to know the true state and which tiles became public, at the moment each message is sent.
  let publicTiles = new Set();
  const notePublic = (events) => {
    for (const e of events) {
      if (e.type === 'roundStart') publicTiles = new Set([e.indicator]);
      if (e.to !== undefined) continue;
      if (e.type === 'discard' || e.type === 'showIndicator' || (e.type === 'draw' && e.from === 'discard')) publicTiles.add(e.tile);
    }
  };
  const wrap = (fn) => (...args) => {
    const res = fn(...args);
    notePublic(res.events);
    return res;
  };
  const eng = { ...engine, act: wrap(engine.act), startRound: wrap(engine.startRound), nextRound: wrap(engine.nextRound) };

  const NON_TILE = new Set(['v', 'now', 'number', 'round', 'dealer', 'turn', 'pileCount', 'turnEndsAt', 'count',
    'handCount', 'score', 'scores', 'deltas', 'seat', 'to', 'except', 'winner', 'winners', 'host', 'you', 'color',
    'num', 'turnSeconds', 'rounds', 'startPoints', 'turns']);
  const VIEW_KEYS = ['v', 'code', 'phase', 'settings', 'host', 'you', 'seats', 'round', 'hand', 'result', 'winners', 'now'].sort();
  const SEAT_KEYS = ['kind', 'name', 'avatar', 'connected', 'away', 'bot', 'score', 'handCount', 'discard', 'showedIndicator', 'ready'].sort();
  const ROUND_KEYS = ['number', 'dealer', 'turn', 'stage', 'indicator', 'okey', 'pileCount', 'turnEndsAt', 'firstTurn'].sort();
  const seatOf = { a: 0, b: 2, spec: null };
  let checked = 0;
  let views = 0;

  const tilesIn = (x, key, out) => {
    if (typeof x === 'number') {
      if (!NON_TILE.has(key)) out.push(x);
    } else if (Array.isArray(x)) x.forEach((y) => tilesIn(y, key, out));
    else if (x && typeof x === 'object') {
      for (const [k, y] of Object.entries(x)) {
        if (k === 'scoring' || k === 'settings') continue;
        tilesIn(y, k, out);
      }
    }
    return out;
  };

  const onSend = (connId, msg, host) => {
    if (!(connId in seatOf)) return;
    const seat = seatOf[connId];
    const m = host.match;
    if (msg.t === 'view') {
      const view = msg.view;
      views += 1;
      assert.deepEqual(Object.keys(view).sort(), VIEW_KEYS);
      view.seats.forEach((s) => assert.deepEqual(Object.keys(s).sort(), SEAT_KEYS));
      view.seats.forEach((s) => assert.deepEqual(Object.keys(s.discard).sort(), ['count', 'top']));
      if (view.round) assert.deepEqual(Object.keys(view.round).sort(), ROUND_KEYS);
      if (view.phase !== 'lobby') assert.equal(view.you, seat);
      if (seat === null) assert.equal(view.hand, null);
    }
    if (!m || m.phase !== 'playing') return; // round over: hands are revealed on purpose
    const r = m.round;
    if (msg.t === 'view') {
      const view = msg.view;
      assert.equal(view.result, null);
      for (let i = 0; i < 4; i++) {
        assert.equal(view.seats[i].discard.top, r.discards[i].at(-1) ?? null, 'only the top of a stack');
        assert.equal(view.seats[i].discard.count, r.discards[i].length);
        assert.equal(view.seats[i].handCount, r.hands[i].length);
      }
      if (seat !== null) assert.deepEqual([...view.hand].sort(), [...r.hands[seat]].sort());
    }
    const allowed = new Set(publicTiles);
    if (seat !== null) r.hands[seat].forEach((t) => allowed.add(t));
    for (const t of tilesIn(msg, null, [])) {
      assert.ok(allowed.has(t), `seat ${seat} was sent tile ${t} (${JSON.stringify(msg).slice(0, 300)})`);
      checked += 1;
    }
    // a pile draw never shows its tile to anyone but the drawer
    for (const e of msg.events || []) {
      if (e.type === 'dealt' || (e.type === 'draw' && e.from === 'pile' && 'tile' in e)) assert.equal(e.to, seat);
      assert.ok(!('hands' in e) || e.type === 'finish' || e.type === 'pileEmpty');
    }
  };

  const h = harness({ seed: 31337, settings: { rounds: 3 }, eng, onSend });
  h.join('a', 1);
  h.join('b', 2);
  h.join('spec', 3);
  h.say('a', { t: 'sit', seat: 0 });
  h.say('b', { t: 'sit', seat: 2 });
  h.say('a', { t: 'addBot', seat: 1, level: 'uzman' });
  h.say('a', { t: 'addBot', seat: 3, level: 'cirak' });
  h.say('a', { t: 'start' });
  // Both humans play; b lets every 4th turn time out.
  let bTurns = 0;
  let bKey = null;
  for (let i = 0; i < 100_000; i++) {
    const va = h.view('a');
    if (va.phase === 'matchEnd') break;
    let acted = false;
    for (const [id, skipEvery] of [['a', 0], ['b', 4]]) {
      const v = h.view(id);
      if (v.phase !== 'playing' || v.round.turn !== v.you) continue;
      if (id === 'b' && h.host.turnKey !== bKey) { bKey = h.host.turnKey; bTurns += 1; }
      if (skipEvery && bTurns % skipEvery === 0) continue;
      h.say(id, { t: 'act', action: humanAction(v), v: v.v });
      acted = true;
    }
    if (acted) continue;
    if (va.phase === 'roundEnd' && !va.seats[0].ready) { h.say('a', { t: 'next' }); continue; }
    if (va.phase === 'roundEnd' && !h.view('b').seats[2].ready) { h.say('b', { t: 'next' }); continue; }
    if (i % 50 === 0) h.say('a', { t: 'emote', id: 'clap' });
    assert.ok(h.step());
  }
  assert.equal(h.view('a').phase, 'matchEnd');
  assert.ok(views > 300, `views checked: ${views}`);
  assert.ok(checked > 1000, `tiles checked: ${checked}`);
  // spectators get public events only
  for (const m of h.msgs('spec')) for (const e of m.events || []) assert.equal(e.to, undefined);
});

// ------------------------------------------------------------------------------------------------ LocalTable

test('LocalTable: solo table starts with you in seat 0 and three bots; resumes from localStorage', async () => {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  try {
    const { createSoloTable, hasSoloTable } = await import('../site/js/local.js');
    const table = createSoloTable({ name: 'Deneme', avatar: AVATARS[2], levels: ['cirak', 'usta', 'uzman'], settings: { turnSeconds: 60 } });
    const got = [];
    table.onmessage = (m) => got.push(m);
    table.connect();
    assert.equal(got.length, 0, 'delivery is async');
    await new Promise((r) => setTimeout(r, 20));
    const v = got.filter((m) => m.t === 'view').at(-1).view;
    assert.equal(v.phase, 'playing');
    assert.equal(v.you, 0);
    assert.equal(v.host, 0);
    assert.equal(v.settings.turnSeconds, 60);
    assert.deepEqual(v.seats.map((s) => s.bot?.level ?? s.kind), ['human', 'cirak', 'usta', 'uzman']);
    assert.ok(v.hand.length >= 14);
    assert.ok(hasSoloTable());
    table.close();
    const again = createSoloTable({ name: 'Deneme', avatar: AVATARS[2], resume: true });
    const got2 = [];
    again.onmessage = (m) => got2.push(m);
    again.connect();
    await new Promise((r) => setTimeout(r, 20));
    const v2 = got2.filter((m) => m.t === 'view').at(-1).view;
    assert.equal(v2.you, 0);
    assert.deepEqual([...v2.hand].sort(), [...v.hand].sort(), 'same seat, same hand');
    assert.equal(v2.round.number, 1);
    again.discard();
    assert.equal(hasSoloTable(), false);
  } finally {
    delete globalThis.localStorage;
  }
});
