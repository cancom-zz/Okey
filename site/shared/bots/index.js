// Bot brains (see DESIGN.md "Bots"). Pure: a bot is fed its seat's events and views, nothing else.
//
//   const bot = createBot({ level: 'usta', params: { defense: 0.9 }, seed: 'room-ABC-seat-2' });
//   bot.observe(event)        // every event its seat receives (eventsFor(events, seat))
//   bot.delayMs(view) -> ms   // thinking time before acting on this view
//   bot.decide(view) -> action | null   (null: not this bot's move)
//   bot.snapshot() -> JSON    // restore with createBot({ ..., saved })
//
// Every bot owns its RNG, memory and per-round state; there is no module-level mutable state, so bots
// cannot share or leak information to each other.

import { seededRng } from '../okey/rng.js';
import { Memory } from './memory.js';
import { plan } from './policy.js';

export const LEVEL_IDS = ['cirak', 'kalfa', 'usta', 'uzman'];

const freeze = (o) => Object.freeze(o);

/** Ladder order. name: Turkish display name, en: English. params: see DESIGN.md "Bots". */
export const LEVELS = freeze({
  cirak: freeze({
    id: 'cirak', name: 'Çırak', en: 'Apprentice',
    params: freeze({ memory: 0.25, decay: 0.12, lookahead: 1, defense: 0, pairsBias: 0.85, blunder: 0.25,
      takeDiscard: 0.7, gamble: 0, speed: 1.35 }),
  }),
  kalfa: freeze({
    id: 'kalfa', name: 'Kalfa', en: 'Journeyman',
    params: freeze({ memory: 0.5, decay: 0.07, lookahead: 2, defense: 0.3, pairsBias: 0.95, blunder: 0.12,
      takeDiscard: 0.6, gamble: 0, speed: 1.15 }),
  }),
  usta: freeze({
    id: 'usta', name: 'Usta', en: 'Master',
    params: freeze({ memory: 0.7, decay: 0.04, lookahead: 3, defense: 0.6, pairsBias: 1, blunder: 0.06,
      takeDiscard: 0.5, gamble: 0.2, speed: 1.0 }),
  }),
  uzman: freeze({
    id: 'uzman', name: 'Uzman', en: 'Expert',
    params: freeze({ memory: 0.85, decay: 0.02, lookahead: 3, defense: 0.85, pairsBias: 1, blunder: 0.02,
      takeDiscard: 0.5, gamble: 0.4, speed: 0.9 }),
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
    lookahead: Math.round(clamp(o.lookahead, 1, 3, base.lookahead)),
    defense: clamp(o.defense, 0, 1, base.defense),
    pairsBias: clamp(o.pairsBias, 0, 2, base.pairsBias),
    blunder: clamp(o.blunder, 0, 1, base.blunder),
    takeDiscard: clamp(o.takeDiscard, 0, 1, base.takeDiscard),
    gamble: clamp(o.gamble, 0, 1, base.gamble),
    speed: clamp(o.speed, 0.25, 3, base.speed),
  };
}

const BASE_DELAY = { show: 1000, draw: 750, discard: 1000, finish: 1700 };
const MIN_DELAY = 350;
const MAX_DELAY = 4000;

export function createBot({ level = DEFAULT_LEVEL, params, seed = 1, saved } = {}) {
  const lvl = LEVELS[saved?.level ?? level] ? (saved?.level ?? level) : DEFAULT_LEVEL;
  const p = resolveParams(lvl, saved?.params ?? params);
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
  let cache = null; // { v, result } so delayMs and decide agree on one decision per view

  function think(view) {
    if (!view || typeof view !== 'object') return null;
    if (cache && cache.v === view.v && view.v !== undefined) return cache.result;
    const result = plan(view, mem, p, rng, st);
    cache = { v: view.v, result };
    return result;
  }

  return {
    level: lvl,
    params: { ...p },
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
      let ms = BASE_DELAY[res.kind] * (1 + 0.9 * res.hardness);
      if (res.kind === 'discard' && view.round.firstTurn[view.you]) ms += 500; // first look at a new hand
      ms *= p.speed * rng.range(0.85, 1.15);
      return Math.round(Math.min(MAX_DELAY, Math.max(MIN_DELAY, ms)));
    },
    snapshot() {
      return structuredClone({ v: 1, level: lvl, params: p, rng: rng.state(), memory: mem.snapshot(), state: st });
    },
  };
}
