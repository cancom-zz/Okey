// Hand evaluation: how close is a 14-tile hand (plus wild okeys) to a finish, from this bot's point of view.
//
// Pure. Inputs are the bot's own tiles and a `live` table (how many copies of each face the bot believes are
// still obtainable: 2 minus its own copies minus what it can see or remembers as gone). Nothing here knows
// the pile order or anyone else's hand.
//
// Variant-neutral: classic and 101 Okey share tiles, runs and groups (handSize sets the slot count).
//
// Sets route: an exhaustive branch-and-bound search over the hand (wild okeys are kept aside: each okey
// fills any one slot) that maximises
//   1.0 per tile locked in a complete set (run or group, any length)
// + a value per two-tile partial set (connector, gap, group pair), driven by its outs
// + a small value per loose tile (its connectivity to live neighbours: 2-away structure, lookahead >= 2)
// with no more partials than fit in the handSize slots (each partial needs 3).
// Pairs route (classic: 7 pairs): 2 per identical pair, plus waiting singles (a single only pairs with its
// other copy).
// A finished hand scores about 14; each missing tile costs about 1.

import { FACES, handVector, runNeighbors, groupNeighbors } from './faces.js';

export const JOKER_VALUE = 1.25;
const OUTS_VALUE = [0.2, 0.85, 1.05, 1.2, 1.3];   // value of a two-tile partial by live outs (lookahead >= 2)

export function makeContext(live, { lookahead = 2, pairsBias = 1, handSize = 14 } = {}) {
  const single = new Float64Array(FACES);
  for (let f = 0; f < FACES; f++) {
    if (lookahead >= 2) {
      let conn = 0;
      for (const { f: g, d } of runNeighbors(f)) conn += live[g] * (d === 1 ? 1 : 0.6);
      for (const g of groupNeighbors(f)) conn += live[g] * 0.8;
      single[f] = 0.04 + 0.02 * Math.min(conn, 8);
    } else {
      single[f] = 0.1;
    }
  }
  return {
    live, lookahead, single, handSize,
    pv: lookahead >= 2 ? PV_OUTS : PV_FLAT,
    pairsBias,
    pairLive: lookahead >= 2 ? 0.55 : 0.5,
    pairDead: lookahead >= 2 ? 0.05 : 0.5,
  };
}

// Partial value by outs (index 0..4). Beginners (lookahead 1) do not count outs: a partial is a partial.
const PV_OUTS = Float64Array.from(OUTS_VALUE);
const PV_FLAT = Float64Array.from([1.05, 1.05, 1.05, 1.05, 1.05]);

/** Could a tile of face f be part of some complete set made of tiles present in counts? */
function canBeInSet(counts, f) {
  const c = (f / 13) | 0, n = f - c * 13, base = c * 13;
  let others = 0;
  for (let k = 0; k < 4; k++) if (k !== c && counts[k * 13 + n] > 0) others++;
  if (others >= 2) return true;
  // run positions 0..12 for 1..13, 13 for "1 after 13"
  const has = (v) => counts[base + (v === 13 ? 0 : v)] > 0;
  for (const v of n === 0 ? [0, 13] : [n]) {
    for (let s0 = v - 2; s0 <= v; s0++) {
      if (s0 < 0 || s0 + 2 > 13) continue;
      let ok = true;
      for (let x = s0; x <= s0 + 2; x++) if (x !== v && !has(x)) { ok = false; break; }
      if (ok) return true;
    }
  }
  return false;
}

/**
 * Sets route value. `floor` (optional): the caller only cares about values above it; the search prunes
 * against it and returns at least `floor` (exact whenever the true value is higher).
 */
export function evaluateSets(counts, jokers, ctx, floor = -Infinity) {
  const live = ctx.live, single = ctx.single, N = ctx.handSize, pv = ctx.pv;
  const val = (outs) => pv[outs > 4 ? 4 : outs];
  // Upper bound per tile: 1 if it could sit in a complete set with the tiles present, else at most half
  // of the best partial (or its loose value). Tiles only get used up, so this stays a valid bound.
  const ub = new Float64Array(FACES);
  const half = Math.max(pv[4], pv[0]) / 2;
  let remaining0 = 0;
  for (let f = 0; f < FACES; f++) {
    if (!counts[f]) continue;
    ub[f] = canBeInSet(counts, f) ? 1 : Math.max(half, single[f]);
    remaining0 += counts[f] * ub[f];
  }
  const cap = (setTiles) => (setTiles >= N ? 0 : Math.floor((N - setTiles) / 3));
  let best = floor - jokers * JOKER_VALUE;
  let tiles = 0;
  for (let f = 0; f < FACES; f++) tiles += counts[f];
  const others = Array.from({ length: tiles + 2 }, () => []); // scratch per search depth
  function rec(f, setTiles, nParts, acc, remaining, depth) {
    while (f < FACES && counts[f] === 0) f++;
    if (f === FACES) { if (acc > best) best = acc; return; }
    if (acc + remaining <= best + 1e-9) return;
    counts[f]--;
    const c = (f / 13) | 0, n = f - c * 13, base = c * 13;
    const rem = remaining - ub[f];
    if (n <= 10 && counts[f + 1] > 0 && counts[f + 2] > 0) {
      counts[f + 1]--; counts[f + 2]--;
      let len = 3, k = n + 3, r = rem - ub[f + 1] - ub[f + 2];
      for (;;) {
        if (nParts <= cap(setTiles + len)) rec(f, setTiles + len, nParts, acc + len, r, depth + 1);
        if (k > 12 || counts[base + k] === 0) break;
        counts[base + k]--; r -= ub[base + k]; len++; k++;
      }
      for (let j = n + 3; j < k; j++) counts[base + j]++;
      counts[f + 1]++; counts[f + 2]++;
    }
    if (n === 0 && counts[base + 12] > 0 && counts[base + 11] > 0) {
      counts[base + 12]--; counts[base + 11]--;
      let len = 3, k = 10, r = rem - ub[base + 12] - ub[base + 11];
      for (;;) {
        if (nParts <= cap(setTiles + len)) rec(f, setTiles + len, nParts, acc + len, r, depth + 1);
        if (k < 1 || counts[base + k] === 0) break;
        counts[base + k]--; r -= ub[base + k]; len++; k--;
      }
      for (let j = k + 1; j <= 10; j++) counts[base + j]++;
      counts[base + 12]++; counts[base + 11]++;
    }
    const o = others[depth]; o.length = 0;
    for (let c2 = c + 1; c2 < 4; c2++) if (counts[c2 * 13 + n] > 0) o.push(c2 * 13 + n);
    if (o.length >= 2) {
      if (o.length === 3 && nParts <= cap(setTiles + 4)) {
        counts[o[0]]--; counts[o[1]]--; counts[o[2]]--;
        rec(f, setTiles + 4, nParts, acc + 4, rem - ub[o[0]] - ub[o[1]] - ub[o[2]], depth + 1);
        counts[o[0]]++; counts[o[1]]++; counts[o[2]]++;
      }
      if (nParts <= cap(setTiles + 3)) {
        for (let i = 0; i < o.length; i++) for (let j = i + 1; j < o.length; j++) {
          counts[o[i]]--; counts[o[j]]--;
          rec(f, setTiles + 3, nParts, acc + 3, rem - ub[o[i]] - ub[o[j]], depth + 1);
          counts[o[i]]++; counts[o[j]]++;
        }
      }
    }
    if (nParts + 1 <= cap(setTiles)) {
      if (n <= 11 && counts[f + 1] > 0) {
        let outs = 0;
        if (n >= 1) outs += live[f - 1];
        if (n + 2 <= 12) outs += live[f + 2];
        if (n + 1 === 12) outs += live[base];
        counts[f + 1]--; rec(f, setTiles, nParts + 1, acc + val(outs), rem - ub[f + 1], depth + 1); counts[f + 1]++;
      }
      if (n <= 10 && counts[f + 2] > 0) { counts[f + 2]--; rec(f, setTiles, nParts + 1, acc + val(live[f + 1]), rem - ub[f + 2], depth + 1); counts[f + 2]++; }
      if (n === 0 && counts[base + 12] > 0) { counts[base + 12]--; rec(f, setTiles, nParts + 1, acc + val(live[base + 11]), rem - ub[base + 12], depth + 1); counts[base + 12]++; }
      if (n === 0 && counts[base + 11] > 0) { counts[base + 11]--; rec(f, setTiles, nParts + 1, acc + val(live[base + 12]), rem - ub[base + 11], depth + 1); counts[base + 11]++; }
      for (let i = 0; i < o.length; i++) {
        const g = o[i], cg = (g / 13) | 0;
        let outs = 0;
        for (let k = 0; k < 4; k++) if (k !== c && k !== cg) outs += live[k * 13 + n];
        counts[g]--; rec(f, setTiles, nParts + 1, acc + val(outs), rem - ub[g], depth + 1); counts[g]++;
      }
    }
    rec(f, setTiles, nParts, acc + single[f], rem, depth + 1);
    counts[f]++;
  }
  rec(0, 0, 0, 0, remaining0, 0);
  return best + jokers * JOKER_VALUE;
}

export function evaluatePairs(counts, jokers, ctx) {
  let pairs = 0;
  const singles = [];
  for (let f = 0; f < FACES; f++) {
    const k = counts[f];
    if (k >= 2) pairs += k >> 1;
    if (k & 1) singles.push(ctx.live[f] > 0 ? ctx.pairLive : ctx.pairDead);
  }
  singles.sort((a, b) => b - a);
  const useJ = Math.min(jokers, singles.length);
  singles.length -= useJ;                         // okeys pair the weakest singles
  const blocks = pairs + useJ + ((jokers - useJ) >> 1);
  const need = Math.max(0, 7 - blocks);
  let v = 2 * Math.min(blocks, 7) + jokers * (JOKER_VALUE - 1);
  for (let i = 0; i < need && i < singles.length; i++) v += singles[i];
  return v * ctx.pairsBias;
}

// Best of the two routes. `route` tells the caller which one is ahead.
export function evaluate(counts, jokers, ctx, floor = -Infinity) {
  const sets = evaluateSets(counts, jokers, ctx, floor);
  const pairs = evaluatePairs(counts, jokers, ctx);
  return pairs > sets ? { value: pairs, route: 'pairs' } : { value: sets, route: 'sets' };
}

/**
 * One draw ahead (lookahead >= 3): the expected gain of the next pile draw for a hand of tile ids, over the
 * faces the bot believes are live (weighted by live copies). Only faces that touch the hand can help; the
 * rest are skipped. A drawn tile that would only sit loose gains nothing.
 */
export function expectedDrawGain(hand, okey, ctx) {
  const { counts, jokers } = handVector(hand, okey);
  const base = evaluate(counts, jokers, ctx).value;
  const near = new Uint8Array(FACES);
  for (let f = 0; f < FACES; f++) {
    if (!counts[f]) continue;
    near[f] = 1;
    for (const { f: g } of runNeighbors(f)) near[g] = 1;
    for (const g of groupNeighbors(f)) near[g] = 1;
  }
  let total = 0, gain = 0;
  for (let f = 0; f < FACES; f++) {
    const n = ctx.live[f];
    if (!n) continue;
    total += n;
    if (!near[f]) continue;
    counts[f]++;
    const floor = base + ctx.single[f];     // a tile that only sits loose gains nothing
    const d = evaluate(counts, jokers, ctx, floor).value - floor;
    counts[f]--;
    if (d > 0) gain += n * d;
  }
  return total ? gain / total : 0;
}
