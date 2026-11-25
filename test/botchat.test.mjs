// Bot table talk (bots/chatter.js + host.js botTalk/botHurry) and thinking-time personality.
// node --test test/botchat.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../site/shared/okey/index.js';
import * as H from '../site/shared/okey101/index.js';
import { createBot, LEVEL_IDS } from '../site/shared/bots/index.js';
import { createChatter, CHATTER } from '../site/shared/bots/chatter.js';
import { TableHost, AVATARS, EMOTES, BOT_HURRY_MS } from '../site/shared/host.js';
import { playRounds, playMatch101, botsFor } from './botsim.mjs';

const ALLOWED = new Set(['luck', 'gg', 'hadi', ...Object.values(CHATTER).flatMap((c) => c.onFinish)]);

/** The public events of a few classic rounds (what every seat hears), plus each seat's private events. */
function recordedMatch(seed, rounds = 3) {
  const log = [];
  const bots = botsFor(['kalfa', 'kalfa', 'kalfa', 'kalfa'], seed);
  playRounds({ bots, rounds, seed, onEvents: (events) => log.push(...events) });
  return log;
}

test('emotes never depend on the hand: same public events, different hands -> same emotes', () => {
  const events = recordedMatch('talk');
  const pub = events.filter((e) => e.to === undefined);
  for (const level of LEVEL_IDS) {
    // Two bots in seat 2 with the same seed; one is dealt a different hand and sees different private draws.
    const a = createBot({ level, seed: 'same' });
    const b = createBot({ level, seed: 'same' });
    const said = [[], []];
    for (const e of events) {
      if (e.to !== undefined && e.to !== 2) continue;
      const eb = e.to === 2 && e.hand ? { ...e, hand: e.hand.map((t) => (t + 13) % 104) }
        : e.to === 2 && e.tile !== undefined ? { ...e, tile: (e.tile + 7) % 104 } : e;
      a.observe(e); b.observe(eb);
      said[0].push(a.chat(e)); said[1].push(b.chat(eb));
    }
    assert.deepEqual(said[0], said[1], level);
    assert.ok(said[0].some(Boolean) || level === 'uzman', `${level} said something`);
    // Private events never make a bot talk.
    const c = createBot({ level, seed: 'priv' });
    for (const e of events.filter((x) => x.to !== undefined)) assert.equal(c.chat(e), null);
    assert.ok(pub.length > 0);
  }
});

test('chatter: one emote per round at most, luck at the start, gg at the end, never about its own finish', () => {
  for (let s = 0; s < 200; s++) {
    const ch = createChatter({ level: 'cirak', seed: 's' + s });
    ch.setSeat(1);
    const out = [];
    for (let round = 1; round <= 4; round++) {
      out.push(['r' + round, ch.chat({ type: 'roundStart', round })]);
      for (const seat of [0, 1, 2, 3]) out.push(['r' + round, ch.chat({ type: 'finish', seat }), seat]);
      out.push(['r' + round, ch.hurry()]);
    }
    out.push(['end', ch.chat({ type: 'matchEnd' })]);
    const perSlot = {};
    for (const [slot, id, seat] of out) {
      if (!id) continue;
      perSlot[slot] = (perSlot[slot] ?? 0) + 1;
      assert.ok(ALLOWED.has(id) && EMOTES.includes(id), id);
      if (id === 'luck') assert.equal(slot, 'r1');
      if (id === 'gg') assert.equal(slot, 'end');
      assert.notEqual(seat, 1, 'no reaction to its own finish');
    }
    for (const n of Object.values(perSlot)) assert.ok(n <= 1);
  }
  // Level flavour: Çırak chats far more than Uzman.
  const count = (level) => {
    let n = 0;
    for (let s = 0; s < 300; s++) {
      const ch = createChatter({ level, seed: 'f' + s });
      ch.setSeat(0);
      n += [ch.chat({ type: 'roundStart', round: 1 }), ch.chat({ type: 'finish', seat: 2 }), ch.chat({ type: 'matchEnd' })].filter(Boolean).length;
    }
    return n;
  };
  assert.ok(count('cirak') > 2 * count('uzman'), `${count('cirak')} vs ${count('uzman')}`);
  // Deterministic and restorable.
  const x = createChatter({ level: 'kalfa', seed: 'r' });
  x.chat({ type: 'roundStart', round: 1 });
  const y = createChatter({ level: 'kalfa', seed: 'other', saved: JSON.parse(JSON.stringify(x.snapshot())) });
  for (const e of [{ type: 'finish', seat: 3 }, { type: 'roundStart', round: 2 }, { type: 'finish', seat: 2 }, { type: 'matchEnd' }]) {
    assert.equal(x.chat(e), y.chat(e));
  }
});

// ---------------------------------------------------------------------------------------------------------
// Host: bot emotes go through the human emote path, rate-limited; "Hadi!" only online after BOT_HURRY_MS.

function hostRun(code, { turnSeconds = 30, rounds = 3, levels = ['cirak', 'cirak', 'cirak'] } = {}) {
  const T0 = 1_800_000_000_000;
  const h = { t: T0, wakeAt: null, log: [] };
  h.host = new TableHost({
    code, settings: { turnSeconds, rounds }, rng: C.seededRng(5),
    now: () => h.t, schedule: (at) => { h.wakeAt = at; }, send: (id, m) => h.log.push([h.t, JSON.parse(JSON.stringify(m))]),
  });
  h.host.connect('c1');
  h.host.message('c1', { t: 'hello', player: { id: 'player-1-id', secret: 'secret-1-xyz', name: 'Oyuncu', avatar: AVATARS[0] }, lang: 'tr' });
  h.host.message('c1', { t: 'sit', seat: 0 });
  levels.forEach((level, i) => h.host.message('c1', { t: 'addBot', seat: i + 1, level }));
  h.host.message('c1', { t: 'start' });
  // The human never acts: its turns time out (then it is auto-played); bots play; rounds roll on.
  for (let i = 0; i < 20000 && h.wakeAt !== null; i++) {
    const v = h.log.filter(([, m]) => m.t === 'view').at(-1)?.[1].view;
    if (v?.phase === 'matchEnd') break;
    h.t = Math.max(h.t, h.wakeAt);
    h.host.wake();
  }
  h.emotes = h.log.filter(([, m]) => m.t === 'emote').map(([t, m]) => ({ t, seat: m.seat, id: m.id }));
  return h;
}

test('host: bot emotes use the emote path, are rate-limited and say only allowed things', () => {
  const h = hostRun('ABCDEF');
  assert.ok(h.emotes.length > 0, 'chatty Çıraks said something');
  const bySeat = {};
  for (const e of h.emotes) {
    assert.ok(e.seat >= 1 && e.seat <= 3, 'only bots talk here');
    assert.ok(ALLOWED.has(e.id), e.id);
    (bySeat[e.seat] ??= []).push(e);
  }
  for (const list of Object.values(bySeat)) {
    for (let i = 1; i < list.length; i++) assert.ok(list[i].t - list[i - 1].t >= 1500, 'rate limit');
    // at most one per round + one at the match end: 3 rounds -> at most 4
    assert.ok(list.length <= 4, `${list.length} emotes`);
    assert.ok(list.filter((e) => e.id === 'luck').length <= 1 && list.filter((e) => e.id === 'gg').length <= 1);
  }
});

test('host: "Hadi!" only online, only after a human has thought BOT_HURRY_MS', () => {
  const online = hostRun('ABCDEF', { levels: ['cirak', 'cirak', 'cirak'] });
  const hadi = online.emotes.filter((e) => e.id === 'hadi');
  assert.ok(hadi.length > 0, 'someone hurried the slow human');
  // Each "Hadi!" comes BOT_HURRY_MS into a human turn: find the turn start in the views.
  const views = online.log.filter(([, m]) => m.t === 'view');
  for (const e of hadi) {
    // When did the human's current turn start? (the last view before it in which the turn passed to seat 0)
    let start = null;
    let prev = null;
    for (const [t, m] of views) {
      if (t > e.t) break;
      const mine = m.view.phase === 'playing' && m.view.round.turn === 0;
      const key = mine ? `${m.view.round.number}` : null;
      if (mine && (prev === null || prev !== key)) start = t;
      prev = mine ? key : null;
    }
    assert.ok(start !== null, 'during a human turn');
    assert.ok(e.t - start >= BOT_HURRY_MS, `hurried after ${e.t - start} ms`);
  }
  const solo = hostRun('SOLO', { levels: ['cirak', 'cirak', 'cirak'] });
  assert.equal(solo.emotes.filter((e) => e.id === 'hadi').length, 0, 'never in solo practice');
});

// ---------------------------------------------------------------------------------------------------------
// Thinking time personality

test('tempo: each bot has its own seeded tempo; taking a discard and opening in 101 take visibly longer', () => {
  const tempos = Array.from({ length: 40 }, (_, i) => createBot({ level: 'usta', seed: 't' + i }).tempo);
  assert.ok(tempos.every((x) => x >= 0.85 && x <= 1.15));
  assert.ok(Math.max(...tempos) - Math.min(...tempos) > 0.2, 'some quicker, some more deliberate');
  assert.equal(createBot({ level: 'usta', seed: 't3' }).tempo, tempos[3], 'seeded');
  const saved = JSON.parse(JSON.stringify(createBot({ level: 'usta', seed: 't3' }).snapshot()));
  assert.equal(createBot({ level: 'cirak', seed: 'x', saved }).tempo, tempos[3], 'kept across snapshot/restore');

  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const take = [], pile = [];
  playRounds({
    bots: botsFor(['kalfa', 'kalfa', 'kalfa', 'kalfa'], 'tempo'), rounds: 4, seed: 'tempo',
    onAction: ({ action, ms }) => {
      assert.ok(ms >= 350 && ms <= 4000);
      if (action.type === 'draw') (action.from === 'discard' ? take : pile).push(ms);
    },
  });
  assert.ok(take.length > 5 && mean(take) > 1.3 * mean(pile), `take ${mean(take)} vs pile ${mean(pile)}`);

  const open = [], plays = [];
  playMatch101({
    bots: botsFor(['kalfa', 'kalfa', 'kalfa', 'kalfa'], 'tempo101'), seed: 'tempo101', rounds: 3,
    onStep: ({ view, action, ms }) => {
      assert.ok(ms >= 350 && ms <= 4000);
      if (action.type === 'layDown' && !view.round.opened[view.you]) open.push(ms);
      else if (action.type === 'addToSet' || action.type === 'swapOkey') plays.push(ms);
    },
  });
  assert.ok(open.length > 3 && plays.length > 3 && mean(open) > 1.5 * mean(plays), `open ${mean(open)} vs ${mean(plays)}`);
});
