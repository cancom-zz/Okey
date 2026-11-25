// Bot brains (see DESIGN.md "Bots"). Pure: a bot is fed its seat's events and views, nothing else.
//
//   const bot = createBot({ level: 'usta', params: { defense: 0.9 }, seed: 'room-ABC-seat-2' });
//   bot.observe(event)        // every event its seat receives (eventsFor(events, seat))
//   bot.delayMs(view) -> ms   // thinking time before acting on this view
//   bot.decide(view) -> action | null   (null: not this bot's move; 101: one step per call)
//   bot.snapshot() -> JSON    // restore with createBot({ ..., saved })
//
// Every bot owns its RNG, memory and per-round state; there is no module-level mutable state, so bots
// cannot share or leak information to each other.

import { seededRng } from '../okey/rng.js';
import { Memory } from './memory.js';
import { plan } from './classic.js';
import { plan101 } from './okey101.js';
import { createChatter } from './chatter.js';

export const LEVEL_IDS = ['cirak', 'kalfa', 'usta', 'uzman'];

const freeze = (o) => Object.freeze(o);

/** Ladder order. name: Turkish display name, en: English. params: see DESIGN.md "Bots". */
export const LEVELS = freeze({
  cirak: freeze({
    id: 'cirak', name: 'Çırak', en: 'Apprentice',
    params: freeze({ memory: 0.25, decay: 0.12, lookahead: 1, defense: 0, pairsBias: 0.85, blunder: 0.25,
      takeDiscard: 0.7, gamble: 0, speed: 1.35, read: 0, bluff: 0 }),
    params101: freeze({ blunder: 0.32 }),
  }),
  kalfa: freeze({
    id: 'kalfa', name: 'Kalfa', en: 'Journeyman',
    params: freeze({ memory: 0.5, decay: 0.07, lookahead: 2, defense: 0.3, pairsBias: 0.95, blunder: 0.12,
      takeDiscard: 0.6, gamble: 0, speed: 1.15, read: 0.3, bluff: 0 }),
    params101: freeze({ blunder: 0.22 }),
  }),
  usta: freeze({
    id: 'usta', name: 'Usta', en: 'Master',
    params: freeze({ memory: 0.7, decay: 0.04, lookahead: 3, defense: 0.6, pairsBias: 1, blunder: 0.09,
      takeDiscard: 0.4, gamble: 0.1, speed: 1.0, read: 0.7, bluff: 0 }),
    // 101: opens as soon as it can (no waiting for sets over pairs, no holding), less patient, more slips.
    params101: freeze({ lookahead: 2, blunder: 0.13, gamble: 0 }),
  }),
  uzman: freeze({
    id: 'uzman', name: 'Uzman', en: 'Expert',
    params: freeze({ memory: 0.85, decay: 0.02, lookahead: 4, defense: 0.85, pairsBias: 1, blunder: 0.02,
      takeDiscard: 0.3, gamble: 0.25, speed: 0.9, read: 0.9, bluff: 0.12 }),
  }),
});

export const DEFAULT_LEVEL = 'kalfa';

// Hard limits for any bot, custom ones included: memory is never perfect.
export const MAX_MEMORY = 0.9;
export const MIN_DECAY = 0.005;

const clamp = (x, lo, hi, dflt) => (typeof x === 'number' && Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : dflt);

/** Level params with overrides applied and clamped to legal ranges. */
export function resolveParams(level, overrides = {}) {
  const base = (LEVELS[level] ?? LEVELS[DEFAULT_LEVEL]).params;
  const o = overrides && typeof overrides === 'object' ? overrides : {};
  return {
    memory: clamp(o.memory, 0, MAX_MEMORY, Math.min(base.memory, MAX_MEMORY)),
    decay: clamp(o.decay, MIN_DECAY, 1, Math.max(base.decay, MIN_DECAY)),
    lookahead: Math.round(clamp(o.lookahead, 1, 4, base.lookahead)),
    defense: clamp(o.defense, 0, 1, base.defense),
    pairsBias: clamp(o.pairsBias, 0, 2, base.pairsBias),
    blunder: clamp(o.blunder, 0, 1, base.blunder),
    takeDiscard: clamp(o.takeDiscard, 0, 1, base.takeDiscard),
    gamble: clamp(o.gamble, 0, 1, base.gamble),
    speed: clamp(o.speed, 0.25, 3, base.speed),
    read: clamp(o.read, 0, 1, base.read ?? 0),
    bluff: clamp(o.bluff, 0, 1, base.bluff ?? 0),
  };
}

const BASE_DELAY = { show: 1000, draw: 750, take: 1300, discard: 1000, finish: 1700, open: 1500, play: 800 };
const MIN_DELAY = 350;
const MAX_DELAY = 4000;

/** A bot's own tempo (0.85..1.15): some think a little quicker, others more deliberately. Seeded. */
function tempoOf(seed) {
  return 0.85 + 0.3 * seededRng(`${seed}:tempo`).random();
}

export function createBot({ level = DEFAULT_LEVEL, params, seed = 1, saved } = {}) {
  const lvl = LEVELS[saved?.level ?? level] ? (saved?.level ?? level) : DEFAULT_LEVEL;
  // Custom overrides win over the level, in both variants; 101 starts from the level's 101 params.
  const custom = (saved ? saved.custom ?? saved.params : params) ?? {};
  const p = resolveParams(lvl, custom);
  const p101 = resolveParams(lvl, { ...(LEVELS[lvl].params101 ?? {}), ...custom });
  const rng0 = seededRng(saved ? saved.rng : seed);
  const rng = {
    next: rng0.random,
    chance: (x) => rng0.random() < x,
    int: rng0.int,
    range: (lo, hi) => lo + rng0.random() * (hi - lo),
    state: rng0.state,
  };
  const mem = new Memory(p, rng, saved?.memory);
  const st = { round: null, indicator: null, gambled: false, took: null, ...(saved?.state ?? {}) };
  const st101 = { round: null, mark: null, steps: 0, lazy: false, openedAt: null, ...(saved?.state101 ?? {}) };
  const tempo = saved?.tempo ?? tempoOf(seed);
  const chatter = createChatter({ level: lvl, seed, saved: saved?.chatter });
  let cache = null; // { v, result } so delayMs and decide agree on one decision per view

  function think(view) {
    if (!view || typeof view !== 'object') return null;
    if (cache && cache.v === view.v && view.v !== undefined) return cache.result;
    // The variant comes from the view's public settings: one brain plays classic or 101.
    const result = view.settings?.variant === '101' ? plan101(view, mem, p101, rng, st101) : plan(view, mem, p, rng, st);
    cache = { v: view.v, result };
    return result;
  }

  return {
    level: lvl,
    params: { ...p },
    params101: { ...p101 },
    tempo,
    observe(event) {
      if (event && typeof event === 'object') mem.observe(event);
    },
    decide(view) {
      const res = think(view);
      cache = null;
      return res ? res.action : null;
    },
    delayMs(view) {
      const res = think(view);
      if (!res) return 0;
      const a = res.action;
      const kind = a?.type === 'draw' && a.from === 'discard' ? 'take' : res.kind; // taking is a real decision
      let ms = BASE_DELAY[kind] * (1 + 0.9 * res.hardness);
      // 101: a longer first look at the turn, then quicker table steps (the plan is already made); opening
      // and taking stay slow.
      if (res.first === true) ms *= 1.4;
      else if (res.first === false && kind !== 'open' && kind !== 'take') ms *= kind === 'discard' ? 0.7 : 0.55;
      if (res.kind === 'discard' && view.round.firstTurn[view.you]) ms += 500; // first look at a new hand
      const speed = view.settings?.variant === '101' ? p101.speed : p.speed;
      ms *= speed * tempo * rng.range(0.85, 1.15);
      return Math.round(Math.min(MAX_DELAY, Math.max(MIN_DELAY, ms)));
    },
    /**
     * Table talk (chatter.js): give it a public event; it may answer with an emote id. It sees only the event's
     * type, seat and round, never the hand, so what it says carries no information about the bot's tiles.
     */
    chat(event) {
      if (!event || typeof event !== 'object' || event.to !== undefined) return null;
      chatter.setSeat(mem.you);
      return chatter.chat({ type: event.type, seat: event.seat, round: event.round });
    },
    /** Counters for tests and tuning: classic discards and how many of them were bluffs. */
    stats() {
      return { discards: st.discards ?? 0, bluffs: st.bluffs ?? 0 };
    },
    /** A human has been thinking a while (online): maybe 'hadi'. */
    hurry() {
      return chatter.hurry();
    },
    snapshot() {
      return structuredClone({ v: 2, level: lvl, custom, rng: rng.state(), memory: mem.snapshot(), state: st, state101: st101,
        tempo, chatter: chatter.snapshot() });
    },
  };
}
