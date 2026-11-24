// Set rules, finish detection and hand arrangement (see DESIGN.md "Sets and finishing").
//
// Internally a hand is reduced to `counts` (how many tiles of each of the 52 faces, 0..2; false jokers count
// as the okey's face) plus `w`, the number of wild okeys. Searches pick the first face still present and try
// every set that can contain it. Two shortcuts keep that small without losing solutions:
//   - In a run, a position is filled with a real tile whenever one is left. (If a solution uses a wild there
//     while the real tile sits elsewhere, swapping the two keeps both sets valid.)
//   - Likewise a group only takes wilds once every other available color is in it.
// Dead states are memoized, so 14 tiles with 2 okeys stay well under a millisecond on typical hands.

import { faceOf, isTile } from './tiles.js';

const FACES = 52;
const WILD = -1; // slot marker for a wild okey
const faceIdx = (c, n) => c * 13 + (n - 1);

// ---------------------------------------------------------------------------------------------------------
// validSet

/** 'run' | 'group' | null for an unordered set of tile ids. */
export function validSet(ids, okey) {
  if (!Array.isArray(ids) || ids.length < 3 || ids.length > 13) return null;
  if (!ids.every(isTile) || new Set(ids).size !== ids.length) return null;
  const real = ids.map((id) => faceOf(id, okey)).filter((f) => !f.wild);
  if (isRun(real, ids.length)) return 'run';
  if (isGroup(real, ids.length)) return 'group';
  return null;
}

function isGroup(real, len) {
  if (len > 4) return false;
  if (real.some((f) => f.num !== real[0].num)) return false;
  return new Set(real.map((f) => f.color)).size === real.length;
}

// Values: 1..13, plus 14 meaning "1 after 13". A run is a window [s, s+len-1] inside 1..14 (len <= 13, so it
// can never hold both 1 and 14: 12-13-1 is fine, 13-1-2 is not).
function isRun(real, len) {
  if (real.length === 0) return true;
  if (real.some((f) => f.color !== real[0].color)) return false;
  const hasOne = real.some((f) => f.num === 1);
  for (const oneHigh of hasOne ? [false, true] : [false]) {
    const vals = real.map((f) => (f.num === 1 && oneHigh ? 14 : f.num));
    if (new Set(vals).size !== vals.length) continue;
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    if (Math.max(1, hi - len + 1) <= Math.min(lo, 15 - len)) return true; // some start s fits
  }
  return false;
}

/** Two tiles form a pair: identical faces, or at least one okey. */
export function isPair(a, b, okey) {
  if (a === b) return false;
  const fa = faceOf(a, okey);
  const fb = faceOf(b, okey);
  return fa.wild || fb.wild || (fa.color === fb.color && fa.num === fb.num);
}

// ---------------------------------------------------------------------------------------------------------
// Search core

/** Reduce ids to counts/pools. `faces` lists the distinct face indices present (for compact memo keys). */
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
  if (faces.length > 30) return w + ':' + faces.map((i) => counts[i]).join(''); // beyond exact integers
  let k = w;
  for (const i of faces) k = k * 3 + counts[i];
  return k; // < 3^32, an exact integer
};

/**
 * Every set (as display-ordered slots: face index or WILD) that contains face `f`, under the two shortcuts
 * described at the top of this file.
 */
function candidates(counts, w, f) {
  const out = [];
  const c = Math.floor(f / 13);
  const n = (f % 13) + 1;
  const at = (v) => faceIdx(c, v === 14 ? 1 : v);

  // Runs through value v (1 may also sit at 14, after 13).
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
        for (let p = s; p <= e; p++) slots.push(p === v ? f : counts[at(p)] ? at(p) : WILD);
        out.push({ kind: 'run', slots, wilds: need });
      }
    }
  }

  // Groups: same number, distinct colors.
  const others = [];
  for (let c2 = 0; c2 < 4; c2++) if (c2 !== c && counts[faceIdx(c2, n)]) others.push(faceIdx(c2, n));
  const all = (1 << others.length) - 1;
  for (let mask = 0; mask <= all; mask++) {
    const picked = others.filter((_, i) => (mask >> i) & 1);
    for (let u = 0; u <= w; u++) {
      const size = 1 + picked.length + u;
      if (size < 3 || size > 4 || (u > 0 && mask !== all)) continue;
      out.push({ kind: 'group', slots: [f, ...picked, ...Array(u).fill(WILD)], wilds: u });
    }
  }
  return out;
}

function take(counts, cand, sign) {
  for (const s of cand.slots) if (s !== WILD) counts[s] -= sign;
}

const firstFace = (counts, faces) => faces.find((i) => counts[i] > 0) ?? -1;

/** Partition everything into sets. Returns a list of candidates, or null. */
function solveSets(counts, faces, w, dead) {
  const f = firstFace(counts, faces);
  if (f < 0) return w === 0 ? [] : null; // 1-2 lone okeys can't form a set
  const key = keyOf(counts, faces, w);
  if (dead.has(key)) return null;
  for (const cand of candidates(counts, w, f)) {
    take(counts, cand, 1);
    const rest = solveSets(counts, faces, w - cand.wilds, dead);
    take(counts, cand, -1);
    if (rest) return [cand, ...rest];
  }
  dead.add(key);
  return null;
}

/**
 * Best partial partition: maximize tiles in sets, then tiles in sets of kind `prefer`.
 * Returns { score, list } where list is a shared linked list { cand, next } (cheap to memoize).
 */
function solveMax(counts, faces, w, prefer, memo) {
  const f = firstFace(counts, faces);
  if (f < 0) return { score: 0, list: null };
  const key = keyOf(counts, faces, w);
  const hit = memo.get(key);
  if (hit) return hit;
  // Option 1: this tile is a leftover.
  counts[f]--;
  let best = solveMax(counts, faces, w, prefer, memo);
  counts[f]++;
  // Option 2: it is in some set.
  for (const cand of candidates(counts, w, f)) {
    take(counts, cand, 1);
    const rest = solveMax(counts, faces, w - cand.wilds, prefer, memo);
    take(counts, cand, -1);
    const len = cand.slots.length;
    const score = rest.score + len * 100 + (cand.kind === prefer ? len : 0);
    if (score > best.score) best = { score, list: { cand, next: rest.list } };
  }
  memo.set(key, best);
  return best;
}

/** Turn slot lists back into tile ids, drawing from copies of the pools. */
function materialize(cands, pools, wilds) {
  const p = pools.map((a) => a.slice());
  const wl = wilds.slice();
  return cands.map((cand) => cand.slots.map((s) => (s === WILD ? wl.shift() : p[s].shift())));
}

// ---------------------------------------------------------------------------------------------------------
// Finishing

function setsFinish(ids, okey) {
  const { counts, pools, wilds, faces } = analyze(ids, okey);
  const sol = solveSets(counts, faces, wilds.length, new Set());
  return sol && { kind: 'sets', groups: materialize(sol, pools, wilds) };
}

/** 7 pairs: identical faces, an okey pairs with anything. */
function pairsFinish(ids, okey) {
  if (ids.length !== 14) return null;
  const groups = pairUp(ids, okey);
  return groups.leftovers.length === 0 ? { kind: 'pairs', groups: groups.pairs } : null;
}

/** Greedy pairing (optimal: real pairs first, then each okey takes a single, then okeys pair up). */
function pairUp(ids, okey) {
  const { pools, wilds } = analyze(ids, okey);
  const pairs = [];
  const singles = [];
  for (const pool of pools) {
    for (let i = 0; i + 1 < pool.length; i += 2) pairs.push([pool[i], pool[i + 1]]);
    if (pool.length % 2) singles.push(pool[pool.length - 1]);
  }
  const wl = wilds.slice();
  while (wl.length && singles.length) pairs.push([singles.shift(), wl.shift()]);
  while (wl.length >= 2) pairs.push([wl.shift(), wl.shift()]);
  return { pairs, leftovers: [...singles, ...wl] };
}

function checkIds(ids, n) {
  return Array.isArray(ids) && ids.length === n && ids.every(isTile) && new Set(ids).size === n;
}

/**
 * Can these 14 tiles finish? -> { kind: 'sets' | 'pairs', groups } | null.
 * Prefers 'sets' when both work (DESIGN). Use bestFinish to score a finish.
 */
export function findFinish(ids14, okey) {
  if (!checkIds(ids14, 14)) return null;
  return setsFinish(ids14, okey) ?? pairsFinish(ids14, okey);
}

/** Like findFinish but prefers the higher-scoring kind ('pairs') when both work. Used to score finishes. */
export function bestFinish(ids14, okey) {
  if (!checkIds(ids14, 14)) return null;
  return pairsFinish(ids14, okey) ?? setsFinish(ids14, okey);
}

/**
 * Is `groups` an exact partition of `ids` into valid sets ('sets') or 7 pairs ('pairs')? -> kind | null.
 */
export function partitionKind(groups, ids, okey) {
  if (!Array.isArray(groups) || !groups.every(Array.isArray)) return null;
  const flat = groups.flat();
  if (flat.length !== ids.length || !flat.every(isTile) || new Set(flat).size !== flat.length) return null;
  const have = new Set(ids);
  if (!flat.every((id) => have.has(id))) return null;
  if (groups.every((g) => validSet(g, okey))) return 'sets';
  if (groups.length === 7 && groups.every((g) => g.length === 2 && isPair(g[0], g[1], okey))) return 'pairs';
  return null;
}

/**
 * For a 15-tile hand: every discard that finishes.
 * -> [{ discard, kind, okeyFinish, groups }] (groups exclude the discard; kind is the best-scoring one).
 */
export function finishOptions(ids15, okey) {
  if (!checkIds(ids15, 15)) return [];
  const out = [];
  const done = new Map(); // face key -> { id, fin } of the copy already solved
  for (const id of ids15) {
    const f = faceOf(id, okey);
    const fk = f.wild ? 'wild' : faceIdx(f.color, f.num);
    let fin;
    if (done.has(fk)) {
      // Same face as a tile already tried: same answer with the two ids swapped.
      const prev = done.get(fk);
      fin = prev.fin && {
        kind: prev.fin.kind,
        groups: prev.fin.groups.map((g) => g.map((x) => (x === id ? prev.id : x))),
      };
    } else {
      fin = bestFinish(ids15.filter((x) => x !== id), okey);
      done.set(fk, { id, fin });
    }
    if (fin) out.push({ discard: id, kind: fin.kind, okeyFinish: f.wild, groups: fin.groups });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Arrange (client sort buttons, bots)

const sortKey = (okey) => (id) => {
  const f = faceOf(id, okey);
  return f.wild ? 1000 + id : f.color * 100 + f.num * 2 + (id >= 104 ? 1 : 0);
};
const byFace = (okey) => {
  const k = sortKey(okey);
  return (a, b) => k(a) - k(b);
};

/**
 * Best layout of any number of tiles: sets that cover as many tiles as possible, then ONE trailing array of
 * leftovers (always present, possibly empty). Runs are in playing order with okeys in the gap they fill.
 *   mode 'runs'   : prefer runs on ties, runs listed first
 *   mode 'groups' : prefer groups on ties, groups listed first
 *   mode 'pairs'  : as many pairs as possible (okeys pair with singles), then leftovers
 */
export function arrange(ids, okey, mode = 'runs') {
  ids = (Array.isArray(ids) ? ids : []).filter(isTile);
  const cmp = byFace(okey);
  if (mode === 'pairs') {
    const { pairs, leftovers } = pairUp(ids, okey);
    return [...pairs, leftovers.sort(cmp)];
  }
  const prefer = mode === 'groups' ? 'group' : 'run';
  const { counts, pools, wilds, faces } = analyze(ids, okey);
  const best = solveMax(counts, faces, wilds.length, prefer, new Map());
  const cands = [];
  for (let l = best.list; l; l = l.next) cands.push(l.cand);
  const rank = (c) => (c.kind === prefer ? 0 : 1);
  const lead = (c) => c.slots.find((s) => s !== WILD);
  const order = (c) => (c.kind === 'group' ? (lead(c) % 13) * 4 + Math.floor(lead(c) / 13) : lead(c));
  cands.sort((a, b) => rank(a) - rank(b) || order(a) - order(b));
  const sets = materialize(cands, pools, wilds);
  const used = new Set(sets.flat());
  return [...sets, ids.filter((id) => !used.has(id)).sort(cmp)];
}

// ---------------------------------------------------------------------------------------------------
// Rack sort for the "Seri diz" / "Çift diz" buttons: complete sets first, then the near-sets that are
// one tile short (two of a number in different colours, neighbours or a one-gap in one colour, twins),
// then the true singles together at the end. Owner (Nov 24): "you can of course have 3 or 4 of the same
// tile (e.g. 7s)... auto sort intelligently with all outs next to each other".
//
// arrangeRack(ids, okey, mode = 'runs' | 'pairs') -> { sets, partials, singles }
//   'runs'  : sets maximise tiles in runs AND groups; ties are broken by the better leftovers.
//   'pairs' : identical pairs (an okey pairs with anything) first.
// Near-set weights = how many different faces would complete it (each face has 2 copies):
//   neighbours 5-6 -> 4 or 7 (2); 12-13 -> 11 or 1 (2); 1-2 -> 3 only (1); 13-1 -> 12 only (1)
//   one gap 5-7 -> 6 (1); 12-1 -> 13 (1); a number in two colours -> the 2 missing colours (2)
//   twins (same face) never make a run or group on their own, so they rank last (pairs play only).

const LINK = { adj: 2, edge: 1, gap: 1, group: 2, twin: 0.5 };

function linkScore(a, b, okey) {
  const fa = faceOf(a, okey);
  const fb = faceOf(b, okey);
  if (fa.wild || fb.wild) return 0;
  if (fa.color !== fb.color) return fa.num === fb.num ? LINK.group : 0;
  if (fa.num === fb.num) return LINK.twin;
  const lo = Math.min(fa.num, fb.num);
  const hi = Math.max(fa.num, fb.num);
  if (hi - lo === 1) return lo === 1 ? LINK.edge : LINK.adj; // 1-2 can only grow to 3
  if (hi - lo === 2) return LINK.gap;
  if (lo === 1 && hi === 13) return LINK.edge; // 13-1, grows only to 12-13-1
  if (lo === 1 && hi === 12) return LINK.gap; // 12-_-1
  return 0;
}

// Best set of disjoint two-tile near-sets (max total weight). Exact for up to 16 tiles, greedy above.
function bestLinks(ids, okey) {
  const n = ids.length;
  const w = ids.map((a) => ids.map((b) => (a === b ? 0 : linkScore(a, b, okey))));
  if (n > 16) {
    const edges = [];
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (w[i][j] > 0) edges.push([w[i][j], i, j]);
    edges.sort((x, y) => y[0] - x[0] || x[1] - y[1] || x[2] - y[2]);
    const used = new Set();
    const links = [];
    for (const [, i, j] of edges) if (!used.has(i) && !used.has(j)) { used.add(i); used.add(j); links.push([i, j]); }
    return links;
  }
  const memo = new Map();
  const best = (mask) => {
    if (memo.has(mask)) return memo.get(mask);
    let i = 0;
    while (i < n && mask & (1 << i)) i++;
    if (i === n) return { s: 0, links: [] };
    let res = best(mask | (1 << i)); // tile i stays single
    for (let j = i + 1; j < n; j++) {
      if (mask & (1 << j) || w[i][j] <= 0) continue;
      const r = best(mask | (1 << i) | (1 << j));
      if (r.s + w[i][j] > res.s) res = { s: r.s + w[i][j], links: [[i, j], ...r.links] };
    }
    memo.set(mask, res);
    return res;
  };
  return best(0).links;
}

function leftoverParts(left, okey) {
  const cmp = byFace(okey);
  const real = left.filter((id) => !faceOf(id, okey).wild);
  const wild = left.filter((id) => faceOf(id, okey).wild);
  const links = bestLinks(real, okey);
  const inLink = new Set(links.flat());
  const partials = links.map(([i, j]) => [real[i], real[j]].sort(cmp)).sort((a, b) => cmp(a[0], b[0]));
  const singles = [...real.filter((_, i) => !inLink.has(i)).sort(cmp), ...wild];
  const score = links.reduce((s, [i, j]) => s + linkScore(real[i], real[j], okey), 0);
  return { partials, singles, score };
}

export function arrangeRack(ids, okey, mode = 'runs') {
  ids = (Array.isArray(ids) ? ids : []).filter(isTile);
  if (mode === 'pairs') {
    const { pairs, leftovers } = pairUp(ids, okey);
    const { partials, singles } = leftoverParts(leftovers, okey);
    return { sets: pairs, partials, singles };
  }
  let best = null;
  for (const m of ['runs', 'groups']) {
    const g = arrange(ids, okey, m);
    const left = g.pop();
    const sets = g.filter((x) => x.length);
    const parts = leftoverParts(left, okey);
    const placed = sets.reduce((s, x) => s + x.length, 0);
    if (!best || placed > best.placed || (placed === best.placed && parts.score > best.parts.score)) {
      best = { placed, sets, parts };
    }
  }
  return { sets: best.sets, partials: best.parts.partials, singles: best.parts.singles };
}
