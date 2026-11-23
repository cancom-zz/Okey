// 101 Okey: melds on the table, opening values, işleme (adding to table melds) and the solver helpers used by
// the engine's auto-play, the client and (later) 101 bots. See DESIGN.md "101 Okey".
//
// Tiles, faces, okeys and false jokers are the classic ones (../okey/tiles.js). Sets are the classic sets:
// runs (same color, consecutive, 12-13-1 allowed, 13-1-2 not) and groups (same number, 3-4 different colors);
// okeys are wild, false jokers play as the okey's face.
//
// A table meld is plain JSON:
//   { owner, kind: 'run',   tiles: [ids in playing order], color, start }   position p stands for start + p
//                                                                            (14 = the 1 after 13)
//   { owner, kind: 'group', tiles: [ids], num }                              okeys stand for the missing colors
//   { owner, kind: 'pair',  tiles: [a, b] }                                  pairs openers only
//
// Values (opening totals): a tile counts its number; an okey counts the number it stands for; the 1 after 13
// counts `aceHighValue` (default 1; some houses use 11 or 14). Hand penalties: the face number of each tile
// (a false joker counts the okey's number), an okey in hand counts `okeyInHand` (default 101).
//
// The solver reduces a hand to counts per face (52 faces, false jokers count as the okey face) plus the
// number of wild okeys, and searches "first face present: leftover, or in one of the sets that contain it",
// memoized on the remaining counts. The classic engine's two shortcuts stay valid when maximizing value: a run
// position is filled with a real tile whenever one is left, and a group only takes wilds once every other
// available color is in it (swapping a wild with the real tile it stands for never changes any set's value).

import { faceOf, isTile, isOkey } from '../okey/tiles.js';
import { isPair } from '../okey/rules.js';

const FACES = 52;
const WILD = -1;
const faceIdx = (c, n) => c * 13 + (n - 1);
const posVal = (p, ace) => (p === 14 ? ace : p);
const posNum = (p) => (p === 14 ? 1 : p);

// ---------------------------------------------------------------------------------------------------------
// Values

/** Penalty value of a tile left in hand (okey: `okeyInHand`). */
export function tileValue(id, okey, { okeyInHand = 101 } = {}) {
  const f = faceOf(id, okey);
  return f.wild ? okeyInHand : f.num;
}

/** Sum of the penalty values of a hand. */
export function handValue(ids, okey, opts = {}) {
  let s = 0;
  for (const id of ids) s += tileValue(id, okey, opts);
  return s;
}

/** Opening value of a parsed meld (run/group: the numbers the tiles stand for; pair: 2 x the pair's face). */
export function meldValue(meld, okey, { aceHighValue = 1 } = {}) {
  if (meld.kind === 'run') {
    let s = 0;
    for (let p = 0; p < meld.tiles.length; p++) s += posVal(meld.start + p, aceHighValue);
    return s;
  }
  if (meld.kind === 'group') return meld.num * meld.tiles.length;
  if (meld.kind === 'pair') {
    const real = meld.tiles.map((t) => faceOf(t, okey)).find((f) => !f.wild);
    return real ? 2 * real.num : 0;
  }
  return 0;
}

// ---------------------------------------------------------------------------------------------------------
// Parsing melds

function distinct(ids) {
  return ids.every(isTile) && new Set(ids).size === ids.length;
}

/** Run interpretations of `ids` with a fixed order: the start s such that position p holds s + p. */
function orderedRun(ids, okey) {
  const faces = ids.map((id) => faceOf(id, okey));
  const real = faces.map((f, p) => ({ f, p })).filter((x) => !x.f.wild);
  if (!real.length) return null;
  const c = real[0].f.color;
  if (real.some((x) => x.f.color !== c)) return null;
  const { f, p } = real[0];
  for (const v of f.num === 1 ? [1, 14] : [f.num]) {
    const s = v - p;
    const e = s + ids.length - 1;
    if (s < 1 || e > 14) continue;
    if (real.every((x) => posNum(s + x.p) === x.f.num && (x.f.num !== 1 || s + x.p === 1 || s + x.p === 14))) {
      return { kind: 'run', tiles: ids.slice(), color: c, start: s };
    }
  }
  return null;
}

/** Every run interpretation of `ids` in any order: [{ start, tiles (ordered) }]. */
function anyRuns(ids, okey) {
  const len = ids.length;
  const faces = ids.map((id) => faceOf(id, okey));
  const real = ids.filter((_, i) => !faces[i].wild);
  const wild = ids.filter((_, i) => faces[i].wild);
  if (!real.length) return [];
  const c = faceOf(real[0], okey).color;
  if (real.some((id) => faceOf(id, okey).color !== c)) return [];
  const out = [];
  for (let s = 1; s + len - 1 <= 14; s++) {
    const slots = Array(len).fill(null);
    let ok = true;
    for (const id of real) {
      const n = faceOf(id, okey).num;
      const cand = n === 1 ? [1, 14] : [n];
      const p = cand.map((v) => v - s).find((q) => q >= 0 && q < len && slots[q] === null);
      if (p === undefined) { ok = false; break; }
      slots[p] = id;
    }
    if (!ok) continue;
    const w = wild.slice();
    out.push({ kind: 'run', tiles: slots.map((x) => (x === null ? w.shift() : x)), color: c, start: s });
  }
  return out;
}

function asGroup(ids, okey) {
  if (ids.length < 3 || ids.length > 4) return null;
  const real = ids.map((id) => faceOf(id, okey)).filter((f) => !f.wild);
  if (!real.length || real.some((f) => f.num !== real[0].num)) return null;
  if (new Set(real.map((f) => f.color)).size !== real.length) return null;
  return { kind: 'group', tiles: ids.slice(), num: real[0].num };
}

/**
 * Parse a set: `spec` is an array of tile ids, or `{ kind?: 'run' | 'group', tiles }`.
 * Runs: when the ids, in the order given, form a run, that run is used (so the client decides where an okey
 * stands); otherwise every placement is considered. The highest-value interpretation wins (ties: run).
 * With `anyOrder` the given order is ignored (the best value of the tiles, wherever the okeys stand).
 * -> { kind, tiles, color?, start?, num?, value } | null.
 */
export function meldOf(spec, okey, { aceHighValue = 1, anyOrder = false } = {}) {
  let kind = null;
  let ids = spec;
  if (spec && !Array.isArray(spec) && typeof spec === 'object') {
    ids = spec.tiles;
    kind = spec.kind ?? null;
    if (kind !== null && kind !== 'run' && kind !== 'group') return null;
  }
  if (!Array.isArray(ids) || ids.length < 3 || ids.length > 13 || !distinct(ids)) return null;
  const opts = [];
  if (kind !== 'group') {
    const ordered = anyOrder ? null : orderedRun(ids, okey);
    if (ordered) opts.push(ordered);
    else opts.push(...anyRuns(ids, okey));
  }
  if (kind !== 'run') {
    const g = asGroup(ids, okey);
    if (g) opts.push(g);
  }
  let best = null;
  for (const m of opts) {
    const value = meldValue(m, okey, { aceHighValue });
    if (!best || value > best.value) best = { ...m, value };
  }
  return best;
}

/** A pair meld for two ids (identical faces, or an okey with anything), or null. */
export function pairOf(spec, okey) {
  const ids = Array.isArray(spec) ? spec : spec?.tiles;
  if (!Array.isArray(ids) || ids.length !== 2 || !distinct(ids) || !isPair(ids[0], ids[1], okey)) return null;
  const m = { kind: 'pair', tiles: ids.slice() };
  return { ...m, value: meldValue(m, okey) };
}

// ---------------------------------------------------------------------------------------------------------
// Adding to table melds (işleme) and taking okeys back

/**
 * The meld after adding `tile`, or null if it does not fit. Runs: `side` 'start' | 'end' (omitted: the end
 * when it fits there, else the start). Groups: any missing color while below 4. Pairs never take tiles.
 */
export function addTile(meld, tile, okey, side) {
  if (!meld || !isTile(tile) || meld.tiles.includes(tile)) return null;
  const f = faceOf(tile, okey);
  if (meld.kind === 'group') {
    if (meld.tiles.length >= 4 || side === 'start') return null;
    if (!f.wild) {
      if (f.num !== meld.num) return null;
      const colors = meld.tiles.map((t) => faceOf(t, okey)).filter((x) => !x.wild).map((x) => x.color);
      if (colors.includes(f.color)) return null;
    }
    return { ...meld, tiles: [...meld.tiles, tile] };
  }
  if (meld.kind !== 'run' || meld.tiles.length >= 13) return null;
  const end = meld.start + meld.tiles.length - 1;
  const fitsEnd = end + 1 <= 14 && (f.wild || (f.color === meld.color && f.num === posNum(end + 1)));
  const fitsStart = meld.start - 1 >= 1 && (f.wild || (f.color === meld.color && f.num === meld.start - 1));
  const useEnd = side === 'end' ? fitsEnd : side === 'start' ? false : fitsEnd;
  const useStart = side === 'start' ? fitsStart : side === 'end' ? false : !fitsEnd && fitsStart;
  if (useEnd) return { ...meld, tiles: [...meld.tiles, tile] };
  if (useStart) return { ...meld, tiles: [tile, ...meld.tiles], start: meld.start - 1 };
  return null;
}

/** The face { color, num } an okey at position `i` of a meld stands for, or null if it is open (group). */
function okeyStandsFor(meld, i, okey) {
  if (meld.kind === 'run') return { color: meld.color, num: posNum(meld.start + i) };
  if (meld.kind === 'pair') {
    const other = faceOf(meld.tiles[1 - i], okey);
    return other.wild ? null : { color: other.color, num: other.num };
  }
  return null;
}

/**
 * Swap a real `tile` for an okey in `meld`: -> { meld, okey: okeyTileId } or null. The tile must be exactly
 * what the okey stands for (run: its position; pair: the partner's face; group: any color not yet in it).
 * `which` optionally names the okey tile to take.
 */
export function swapTile(meld, tile, okey, which) {
  if (!meld || !isTile(tile)) return null;
  const f = faceOf(tile, okey);
  if (f.wild) return null;
  for (let i = 0; i < meld.tiles.length; i++) {
    const t = meld.tiles[i];
    if (!isOkey(t, okey) || (which !== undefined && which !== t)) continue;
    let ok = false;
    if (meld.kind === 'group') {
      const colors = meld.tiles.map((x) => faceOf(x, okey)).filter((x) => !x.wild).map((x) => x.color);
      ok = f.num === meld.num && !colors.includes(f.color);
    } else {
      const want = okeyStandsFor(meld, i, okey);
      ok = !!want && want.color === f.color && want.num === f.num;
    }
    if (ok) {
      const tiles = meld.tiles.slice();
      tiles[i] = tile;
      return { meld: { ...meld, tiles }, okey: t };
    }
  }
  return null;
}

/** Every (tile, meld, side) by which a tile of `hand` can be added to a table meld. */
export function layoffs(hand, table, okey) {
  const out = [];
  for (const tile of hand) {
    table.forEach((m, i) => {
      if (m.kind === 'run') {
        for (const side of ['end', 'start']) if (addTile(m, tile, okey, side)) out.push({ tile, meld: i, side });
      } else if (m.kind === 'group' && addTile(m, tile, okey)) out.push({ tile, meld: i, side: null });
    });
  }
  return out;
}

/** Every (tile, meld, okey) by which a held real tile can take an okey back from the table. */
export function swaps(hand, table, okey) {
  const out = [];
  for (const tile of hand) {
    table.forEach((m, i) => {
      for (const t of m.tiles) {
        if (isOkey(t, okey) && swapTile(m, tile, okey, t)) out.push({ tile, meld: i, okey: t });
      }
    });
  }
  return out;
}

/**
 * İşlek taş: a tile that could be added to a run or group on the table (or, with `swap`, could take an okey
 * back from it). An okey is işlek whenever any meld can take one.
 */
export function isIslek(tile, table, okey, { swap = true } = {}) {
  for (const m of table) {
    if (m.kind === 'pair') {
      if (swap && swapTile(m, tile, okey)) return true;
      continue;
    }
    if (addTile(m, tile, okey, 'end') || addTile(m, tile, okey, 'start')) return true;
    if (swap && swapTile(m, tile, okey)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------------
// Solver

function analyze(ids, okey) {
  const counts = new Uint8Array(FACES);
  const pools = Array.from({ length: FACES }, () => []);
  const wilds = [];
  for (const id of ids) {
    const f = faceOf(id, okey);
    if (f.wild) wilds.push(id);
    else {
      const i = faceIdx(f.color, f.num);
      counts[i]++;
      pools[i].push(id);
    }
  }
  const faces = [];
  for (let i = 0; i < FACES; i++) if (counts[i]) faces.push(i);
  return { counts, pools, wilds, faces };
}

const keyOf = (counts, faces, w) => {
  if (faces.length > 30) return w + ':' + faces.map((i) => counts[i]).join('');
  let k = w;
  for (const i of faces) k = k * 3 + counts[i];
  return k;
};

/** Every set containing face f (display-ordered slots), with its value. */
function candidates(counts, w, f, ace) {
  const out = [];
  const c = Math.floor(f / 13);
  const n = (f % 13) + 1;
  const at = (v) => faceIdx(c, v === 14 ? 1 : v);
  for (const v of n === 1 ? [1, 14] : [n]) {
    let lowNeed = 0;
    for (let s = v; s >= Math.max(1, v - 12); s--) {
      if (s < v && counts[at(s)] === 0) lowNeed++;
      if (lowNeed > w) break;
      let need = lowNeed;
      for (let e = v; e <= Math.min(14, s + 12); e++) {
        if (e > v && counts[at(e)] === 0) need++;
        if (need > w) break;
        if (e - s < 2) continue;
        const slots = [];
        let value = 0;
        for (let p = s; p <= e; p++) {
          slots.push(p === v ? f : counts[at(p)] ? at(p) : WILD);
          value += posVal(p, ace);
        }
        out.push({ kind: 'run', slots, wilds: need, value });
      }
    }
  }
  const others = [];
  for (let c2 = 0; c2 < 4; c2++) if (c2 !== c && counts[faceIdx(c2, n)]) others.push(faceIdx(c2, n));
  const all = (1 << others.length) - 1;
  for (let mask = 0; mask <= all; mask++) {
    const picked = others.filter((_, i) => (mask >> i) & 1);
    for (let u = 0; u <= w; u++) {
      const size = 1 + picked.length + u;
      if (size < 3 || size > 4 || (u > 0 && mask !== all)) continue;
      out.push({ kind: 'group', slots: [f, ...picked, ...Array(u).fill(WILD)], wilds: u, value: n * size });
    }
  }
  return out;
}

function take(counts, cand, sign) {
  for (const s of cand.slots) if (s !== WILD) counts[s] -= sign;
}

const firstFace = (counts, faces) => {
  for (const i of faces) if (counts[i] > 0) return i;
  return -1;
};

const NONE = { score: 0, list: null };
const IMPOSSIBLE = { score: -Infinity, list: null };

/**
 * Max (value, then tiles) disjoint sets. Score = value * 32 + tiles (tiles < 32). With `need`, at least one
 * tile (a real one, or an unused okey) must stay out of the sets. memo: [memo without need, memo with need].
 */
function solveValue(counts, faces, w, ace, memo, need) {
  const f = firstFace(counts, faces);
  if (f < 0) return need && w === 0 ? IMPOSSIBLE : NONE;
  const key = keyOf(counts, faces, w);
  const mm = memo[need ? 1 : 0];
  const hit = mm.get(key);
  if (hit) return hit;
  counts[f]--;
  let best = solveValue(counts, faces, w, ace, memo, false);
  counts[f]++;
  for (const cand of candidates(counts, w, f, ace)) {
    take(counts, cand, 1);
    const rest = solveValue(counts, faces, w - cand.wilds, ace, memo, need);
    take(counts, cand, -1);
    const score = rest.score + cand.value * 32 + cand.slots.length;
    if (score > best.score) best = { score, list: { cand, next: rest.list } };
  }
  mm.set(key, best);
  return best;
}

function materialize(cands, pools, wilds) {
  const p = pools.map((a) => a.slice());
  const wl = wilds.slice();
  return cands.map((cand) => cand.slots.map((s) => (s === WILD ? wl.shift() : p[s].shift())));
}

function setsOf(ids, okey, ace, need, memo) {
  const { counts, pools, wilds, faces } = analyze(ids, okey);
  const best = solveValue(counts, faces, wilds.length, ace, memo, need);
  const cands = [];
  for (let l = best.list; l; l = l.next) cands.push(l.cand);
  const groups = materialize(cands, pools, wilds);
  return {
    groups,
    value: cands.reduce((s, c) => s + c.value, 0),
    tiles: groups.reduce((s, g) => s + g.length, 0),
  };
}

/**
 * The highest-value collection of disjoint sets in `ids` (ties: more tiles), leaving at least one tile out
 * when `keep` is 1 (a player must keep a tile to discard). -> { groups: [[ids in playing order]], value, tiles }.
 */
export function bestSets(ids, okey, { aceHighValue = 1, keep = 1 } = {}) {
  ids = (Array.isArray(ids) ? ids : []).filter(isTile);
  const memo = [new Map(), new Map()];
  const best = setsOf(ids, okey, aceHighValue, false, memo);
  if (!keep || best.tiles < ids.length) return best;
  // Everything fits into sets: search again with "one tile stays out" (shares the memo).
  return ids.length ? setsOf(ids, okey, aceHighValue, true, memo) : best;
}

/**
 * As many pairs as possible (real pairs first; okeys pair with the highest singles, then with each other),
 * keeping at least `keep` tiles out. -> { groups: [[a, b]], count, value }.
 */
export function bestPairs(ids, okey, { keep = 1 } = {}) {
  ids = (Array.isArray(ids) ? ids : []).filter(isTile);
  const { pools, wilds } = analyze(ids, okey);
  const pairs = [];
  const singles = [];
  for (const pool of pools) {
    for (let i = 0; i + 1 < pool.length; i += 2) pairs.push([pool[i], pool[i + 1]]);
    if (pool.length % 2) singles.push(pool[pool.length - 1]);
  }
  const val = (id) => faceOf(id, okey).num;
  singles.sort((a, b) => val(b) - val(a));
  const wl = wilds.slice();
  while (wl.length && singles.length) pairs.push([singles.shift(), wl.shift()]);
  while (wl.length >= 2) pairs.push([wl.shift(), wl.shift()]);
  const pv = (g) => meldValue({ kind: 'pair', tiles: g }, okey);
  pairs.sort((a, b) => pv(b) - pv(a));
  while (pairs.length && pairs.length * 2 > ids.length - keep) pairs.pop();
  return { groups: pairs, count: pairs.length, value: pairs.reduce((s, g) => s + pv(g), 0) };
}

/**
 * Opening options for a hand: the best sets (max value) and, with `allowPairs`, the most pairs.
 * -> { sets: { groups, value, tiles }, pairs: { groups, count, value } | null,
 *      best: { kind: 'sets' | 'pairs', groups, value, count? } | null }
 * `best` is the legal opening (sets when value >= `minValue`, else pairs when count >= `minPairs`).
 */
export function bestOpening(hand, okey, { allowPairs = true, aceHighValue = 1, minValue = 101, minPairs = 5, keep = 1 } = {}) {
  const sets = bestSets(hand, okey, { aceHighValue, keep });
  const pairs = allowPairs ? bestPairs(hand, okey, { keep }) : null;
  let best = null;
  if (sets.value >= minValue) best = { kind: 'sets', groups: sets.groups, value: sets.value };
  else if (pairs && pairs.count >= minPairs) best = { kind: 'pairs', groups: pairs.groups, value: pairs.value, count: pairs.count };
  return { sets, pairs, best };
}
