// Tile efficiency for the strongest level (lookahead 4): how many tiles a hand still needs, and how many live
// tiles would bring it closer. The classic method of strong rummy and mahjong players: first the fewest tiles
// missing (deficiency), then the most live tiles that reduce it (acceptance).
//
// Variant-neutral and pure. Uses the same search as evaluate.js with "kept tiles" weights: a tile in a set
// counts 1, a partial set with live outs counts 2 (it keeps both tiles), a dead partial or a loose tile 0, an
// okey 1 (it fills any one slot). Deficiency = handSize - kept. Nothing here sees anything but the bot's own
// tiles and its own `live` table.

import { FACES, handVector, runNeighbors, groupNeighbors } from './faces.js';
import { evaluateSets } from './evaluate.js';

const KEPT_PV = Float64Array.from([0, 2, 2, 2, 2]);
export const PAIRS_PENALTY = 2;

export function keptContext(live, handSize = 14) {
  return { live, single: new Float64Array(FACES), handSize, pv: KEPT_PV, jokerSets: true, jv: 1, lookahead: 2, strictUB: true };
}

/** Pairs route: pairs still missing (an okey pairs with anything). */
export function pairsDeficiency(counts, jokers, pairsNeeded = 7) {
  let pairs = 0, singles = 0;
  for (let f = 0; f < FACES; f++) { pairs += counts[f] >> 1; singles += counts[f] & 1; }
  const j = Math.min(jokers, singles);
  return Math.max(0, pairsNeeded - pairs - j - ((jokers - j) >> 1));
}

/**
 * Tiles still needed: the better of the sets route and (when allowed) the pairs route. `atMost`: the caller
 * only needs the exact answer when it is <= atMost (anything worse comes back as atMost + 1, much faster).
 */
export function deficiency(counts, jokers, kctx, { pairs = kctx.pairsRoute ?? true, atMost = Infinity } = {}) {
  // Pairs waits are thin (each single has one copy), so the pairs route counts PAIRS_PENALTY tiles further.
  const p = pairs ? pairsDeficiency(counts, jokers) + (kctx.pairsPenalty ?? PAIRS_PENALTY) : Infinity;
  const limit = Math.min(atMost, p - 1);                      // the sets route only matters if it beats this
  if (limit < 0) return p;
  const floor = Number.isFinite(limit) ? kctx.handSize - limit - 0.5 : -Infinity;
  const kept = evaluateSets(counts, jokers, kctx, floor);
  const sets = kept > floor ? Math.max(0, Math.round(kctx.handSize - kept)) : limit + 1;
  return Math.min(sets, p);
}

/**
 * Acceptance of a hand: live tiles whose draw lowers the deficiency (the hand then holds one tile more and
 * keeps its best handSize). liveOkeys: wild okeys the bot believes are still out.
 */
export function acceptance(counts, jokers, kctx, base, { pairs = kctx.pairsRoute ?? true, liveOkeys = 0 } = {}) {
  const live = kctx.live;
  const near = new Uint8Array(FACES);
  for (let f = 0; f < FACES; f++) {
    if (!counts[f]) continue;
    near[f] = 1;
    for (const { f: g } of runNeighbors(f)) near[g] = 1;
    for (const g of groupNeighbors(f)) near[g] = 1;
  }
  let acc = 0;
  for (let f = 0; f < FACES; f++) {
    if (!live[f] || !near[f]) continue;
    counts[f]++;
    if (deficiency(counts, jokers, kctx, { pairs, atMost: base - 1 }) < base) acc += live[f];
    counts[f]--;
  }
  if (liveOkeys > 0 && deficiency(counts, jokers + 1, kctx, { pairs, atMost: base - 1 }) < base) acc += liveOkeys;
  return acc;
}

/** Deficiency and acceptance of a list of tile ids. */
export function efficiencyOf(ids, okey, kctx, opts = {}) {
  const { counts, jokers } = handVector(ids, okey);
  const def = deficiency(counts, jokers, kctx, opts);   // opts.atMost: see deficiency
  return { def, counts, jokers };
}
