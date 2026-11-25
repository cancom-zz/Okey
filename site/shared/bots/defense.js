// Taşlamak: reading the players next to you from public information only, shared by the variants.
//
// Everything here comes from the bot's own view and its own imperfect, decaying Memory (what each seat
// picked up from its left stack, what it threw, what it passed on). Nothing about other hands or the pile.
// A bot reads seats by position (the next player can take our discard, the previous player feeds us),
// never by who they are: humans and bots are read the same way.
//
// - dangerFn: how much the NEXT player (seat + 1) seems to want a face we might throw (defense).
//     read < 0.5 (Kalfa): only what they picked up from us. read >= 0.5 (Usta, Uzman): also what they passed
//     on, what they threw, and the colours / numbers they keep dumping (safe-ish to feed).
// - readPrevious: what the PREVIOUS player (seat - 1) is unlikely to throw us (offense; read >= 0.5): faces
//     next to what it collects, and colours it never throws, count one copy less in the live table, so the
//     bot stops waiting on them.
// - tellPenalty: (read >= 0.6) a discard right next to tiles we keep tells the reader what we collect.
// - bluffPick: (bluff > 0, Uzman) now and then, when it costs almost nothing, throw a loose tile of a colour
//     we ARE collecting, so a reader thinks we are dumping it.

import { faceColor, faceNum, runNeighbors, groupNeighbors, FACES } from './faces.js';

export const DEFENSE_CAP = 0.5;       // defense never outweighs breaking a complete set (or a good partial)
export const DEFENSE_BONUS_CAP = 0.2; // how much a known-safe tile is preferred
export const LATE_BOOST = 1.6;        // `late`: urgency and cap multiplier once the pile is a quarter full
export const FULL_READ = 0.5;         // from here on: passes, throws, dumped colours/numbers, previous player
export const TELL_READ = 0.6;         // from here on: avoid discards that tell
const TELL_WEIGHT = 0.06;             // per kept neighbour (max 2), times `read`

const runDist = (a, b) => {
  if (faceColor(a) !== faceColor(b)) return 99;
  const x = faceNum(a), y = faceNum(b);
  return Math.min(Math.abs(x - y), Math.abs((x === 1 ? 14 : x) - y), Math.abs(x - (y === 1 ? 14 : y)));
};

/**
 * Defense: penalty for throwing face f, judged from the next player's remembered behaviour. Relative: an
 * unremarkable tile costs nothing, a tile next to what they picked up costs more, a tile they passed on or
 * threw (or of a colour / number they keep dumping) is slightly preferred. Grows as the pile shrinks, as they
 * pick up more, and (`urgent`, 101) when they are close to going out.
 */
export function dangerFn(view, mem, params, live, { pileStart = 48, late = false, urgent = 1 } = {}) {
  if (!(params.defense > 0)) return null;
  const okey = view.round.okey;
  const full = (params.read ?? 0) >= FULL_READ;
  const nextSeat = (view.you + 1) % 4;
  const picks = mem.facesOf(mem.picks[nextSeat], okey);
  const passed = full ? mem.facesOf(mem.passed[nextSeat], okey) : [];
  const throws = full ? mem.facesOf(mem.throws[nextSeat], okey) : [];
  const dumpColor = [0, 0, 0, 0];
  const dumpNum = new Array(14).fill(0);
  for (const g of throws) { dumpColor[faceColor(g)]++; dumpNum[faceNum(g)]++; }
  const pileLeft = Math.max(0, Math.min(1, view.round.pileCount / pileStart));
  let urgency = Math.min(1.3, 0.3 + 0.7 * (1 - pileLeft) + 0.1 * picks.length) * urgent;
  // `late` (the strongest level): defend much harder in the last quarter of the pile.
  const lateBoost = late && pileLeft <= 0.25 ? LATE_BOOST : 1;
  urgency *= lateBoost;
  const cache = new Map();
  return (f) => {
    if (cache.has(f)) return cache.get(f);
    let want = 0;
    for (const g of picks) {
      const rd = runDist(f, g);
      if (g === f) want += 0.1;
      else if (rd === 1) want += 0.5;
      else if (rd === 2) want += 0.25;
      else if (faceNum(g) === faceNum(f)) want += 0.4;
    }
    // A tile with no live neighbours is hard for anyone to use.
    let conn = 0;
    for (const { f: g, d: dist } of runNeighbors(f)) if (dist === 1) conn += live[g];
    for (const g of groupNeighbors(f)) conn += live[g];
    if (conn === 0) want *= 0.3;
    // Colours and numbers they keep throwing away are safe-ish to feed.
    if (dumpColor[faceColor(f)] >= 3) want *= 0.75;
    if (dumpNum[faceNum(f)] >= 2) want *= 0.8;
    let safe = 0;
    if (passed.includes(f)) safe += 0.3;
    if (throws.includes(f)) safe += 0.2;
    const pen = params.defense * urgency * 0.6 * (want - safe);
    const out = Math.max(-DEFENSE_BONUS_CAP, Math.min(DEFENSE_CAP * lateBoost, pen));
    cache.set(f, out);
    return out;
  };
}

/**
 * Offense: a copy of `live` with one copy less of the faces the previous player is unlikely to throw us:
 * next to what it picked up (it collects there), or of a colour it has never thrown in many throws.
 * Unchanged below FULL_READ.
 */
export function readPrevious(view, mem, params, live) {
  if ((params.read ?? 0) < FULL_READ) return live;
  const okey = view.round.okey;
  const prev = (view.you + 3) % 4;
  const picks = mem.facesOf(mem.picks[prev], okey);
  const throws = mem.facesOf(mem.throws[prev], okey);
  if (!picks.length && throws.length < 8) return live;
  const thrownColor = [0, 0, 0, 0];
  for (const g of throws) thrownColor[faceColor(g)]++;
  const out = Int8Array.from(live);
  for (let f = 0; f < FACES; f++) {
    if (!out[f]) continue;
    let held = false;
    for (const g of picks) if (g === f || runDist(f, g) <= 2 || (faceNum(g) === faceNum(f))) { held = true; break; }
    if (!held && throws.length >= 8 && thrownColor[faceColor(f)] === 0) held = live[f] >= 2;
    if (held) out[f]--;
  }
  return out;
}

/** Tell: how plainly throwing face f (from `handFaces`, f removed) shows what we collect. 0 below TELL_READ. */
export function tellPenalty(params, f, restFaces) {
  const read = params.read ?? 0;
  if (read < TELL_READ) return 0;
  let mates = 0;
  for (const g of restFaces) if (g !== f && (runDist(f, g) <= 2 || (faceNum(g) === faceNum(f) && faceColor(g) !== faceColor(f)))) mates++;
  return TELL_WEIGHT * read * Math.min(2, mates);
}

/**
 * Bluff: with chance bluff x (0.4 + 0.6 x share of the pile left), among discards within `margin` of the
 * best, pick a loose tile (no kept neighbour) of a colour we hold 2+ other tiles of: a reader then thinks we
 * are dumping that colour. -> the chosen entry, or null (no bluff this time). `faceOf(entry)` gives its face.
 */
export function bluffPick({ params, rng, ranked, margin, faceOf, handFaces, pileLeft }) {
  if (!(params.bluff > 0) || ranked.length < 2) return null;
  if (!rng.chance(params.bluff * (0.4 + 0.6 * pileLeft))) return null;
  const best = ranked[0].score;
  for (const x of ranked.slice(1)) {
    if (x.score < best - margin) break;
    const f = faceOf(x);
    if (f >= FACES) continue;
    const others = handFaces.filter((g) => g !== f);
    const loose = !others.some((g) => runDist(f, g) <= 2 || faceNum(g) === faceNum(f));
    const sameColor = others.filter((g) => faceColor(g) === faceColor(f)).length;
    if (loose && sameColor >= 2) return x;
  }
  return null;
}
