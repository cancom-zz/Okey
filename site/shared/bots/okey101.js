// 101 Okey turn policy: one action per call (a 101 turn is several steps: draw or take, then lay down /
// add to sets / take okeys back, then discard or finish). The host calls decide() again after each step.
//
// Uses only the bot's own view (hand, table melds, who opened, the opening required, the take in progress,
// discard tops, hand counts, pile count, public settings) and its own Memory. Reuses faces.js, evaluate.js,
// memory.js and defense.js; the solver helpers come from the 101 engine's pure rules.js.

import { isOkey } from '../okey/tiles.js';
import { bestSets, bestPairs, layoffs, swaps, isIslek, tileValue } from '../okey101/rules.js';
import { FACES, faceIndex, handVector } from './faces.js';
import { makeContext, evaluate, strongOptions } from './evaluate.js';
import { dangerFn } from './defense.js';

const PILE_START = 20;
const BLUNDER_MARGIN = 1.0;
const OPEN_GAIN_WEIGHT = 3;   // lookahead 3+: weight of the next draw's expected opening gain
const OPEN_WAIT_REACH = 40;    // lookahead 4: count opening waits when the sets are within this of the opening
const OPEN_WAIT_WEIGHT = 0.3;  // value per live tile that would open
const BRIDGE_WEIGHT = 0.5;     // lookahead 4, opened: keep a tile one live tile away from the table

/** How likely the round is to end soon (someone opened with few tiles left, or the pile is nearly gone). */
function roundRisk(view) {
  const r = view.round;
  let risk = 0;
  for (let s = 0; s < 4; s++) {
    if (s === view.you || !r.opened[s]) continue;
    const n = view.seats[s].handCount;
    risk = Math.max(risk, n <= 1 ? 1 : n <= 3 ? 0.8 : n <= 5 ? 0.55 : n <= 8 ? 0.3 : 0.1);
  }
  const p = r.pileCount;
  return Math.max(risk, p <= 2 ? 1 : p <= 5 ? 0.6 : p <= 9 ? 0.3 : 0);
}

const without = (hand, ids) => {
  const drop = new Set(ids);
  return hand.filter((t) => !drop.has(t));
};

/** Pairs-route value of a hand: pairs held (okeys pair with anything) plus singles whose other copy is live. */
function pairsValue(ids, okey, live) {
  const { counts, jokers } = handVector(ids, okey);
  let pairs = 0, singles = 0, liveSingles = 0;
  for (let f = 0; f < FACES; f++) {
    pairs += counts[f] >> 1;
    if (counts[f] & 1) { singles++; if (live[f] > 0) liveSingles++; }
  }
  const j = Math.min(jokers, singles);
  return 2 * (pairs + j) + 0.5 * Math.max(0, liveSingles - j);
}

/** A tile id of face f that is not in `have` (for "what if I drew f"), or null. */
function tileOfFace(f, okey, have) {
  if (f === okey.color * 13 + okey.num - 1) return [104, 105].find((x) => !have.has(x)) ?? null;
  const c = Math.floor(f / 13), n = (f % 13) + 1;
  for (const cp of [0, 1]) {
    const id = c * 26 + cp * 13 + n - 1;
    if (!have.has(id)) return id;
  }
  return null;
}

/**
 * Lookahead >= 3, unopened: expected gain in opening value (best sets) from the next draw, over the faces the
 * bot believes are live. Only faces next to a hand tile can help.
 */
function openingGain(rest, okey, live, ace, base) {
  const have = new Set(rest);
  const near = new Uint8Array(FACES);
  for (const t of rest) {
    const f = faceIndex(t, okey);
    if (f >= FACES) continue;
    const c = Math.floor(f / 13), n = f % 13;
    for (let d = -2; d <= 2; d++) near[c * 13 + ((n + d + 13) % 13)] = 1;
    for (let k = 0; k < 4; k++) near[k * 13 + n] = 1;
  }
  let total = 0, gain = 0;
  for (let f = 0; f < FACES; f++) {
    if (!live[f]) continue;
    total += live[f];
    if (!near[f]) continue;
    const id = tileOfFace(f, okey, have);
    if (id === null) continue;
    const v = bestSets([...rest, id], okey, { ...ace, keep: 0 }).value;
    if (v > base) gain += live[f] * (v - base);
  }
  return total ? gain / total : 0;
}

/**
 * Lookahead 4, unopened: the opening value still to come from leftover partial sets (tiles not in the best
 * sets), each weighted by its chance to complete within the turns left: sum of P(complete) x set value.
 */
export function openingPotential(leftover, okey, live, turnsLeft, unknown) {
  const faces = [];
  for (const t of leftover) {
    const f = faceIndex(t, okey);
    if (f < FACES) faces.push(f);
  }
  const p = (outs) => 1 - Math.pow(Math.max(0, 1 - outs / unknown), turnsLeft);
  const cands = [];
  for (let i = 0; i < faces.length; i++) {
    for (let j = i + 1; j < faces.length; j++) {
      const a = faces[i], b = faces[j];
      if (a === b) continue;
      const ca = Math.floor(a / 13), cb = Math.floor(b / 13), na = (a % 13) + 1, nb = (b % 13) + 1;
      let outs = 0, value = 0;
      if (ca !== cb && na === nb) {                       // group pair: any missing color
        for (let k = 0; k < 4; k++) if (k !== ca && k !== cb) outs += live[k * 13 + na - 1];
        value = 3 * na;
      } else if (ca === cb) {
        const lo = Math.min(na, nb), hi = Math.max(na, nb), base = ca * 13;
        if (hi - lo === 1) {                              // connector: either end
          const ends = [lo - 1, hi + 1].filter((x) => x >= 1 && x <= 13);
          for (const e of ends) outs += live[base + e - 1];
          value = lo + hi + (ends.length ? ends.reduce((x, y) => x + y, 0) / ends.length : 0);
        } else if (hi - lo === 2) {                       // gap
          outs = live[base + lo];
          value = 3 * (lo + 1);
        }
      }
      if (outs > 0 && value > 0) cands.push({ a: i, b: j, w: p(outs) * value });
    }
  }
  cands.sort((x, y) => y.w - x.w);
  const used = new Set();
  let total = 0, n = 0;
  for (const c of cands) {
    if (used.has(c.a) || used.has(c.b)) continue;
    used.add(c.a); used.add(c.b);
    total += c.w;
    if (++n >= 4) break;
  }
  return total;
}

/**
 * Live copies of the one tile that would let `tile` join a table run next turn (the run ends two below or
 * two above it, and the tile between is still out). 0 if none.
 */
export function bridgeOuts(tile, table, okey, live) {
  const f = faceIndex(tile, okey);
  if (f >= FACES) return 0;
  const c = Math.floor(f / 13), n = (f % 13) + 1;
  let best = 0;
  for (const m of table) {
    if (m.kind !== 'run' || m.color !== c) continue;
    const end = m.start + m.tiles.length - 1;              // positions: 14 = the 1 after 13
    if (end + 2 <= 14 && (end + 2 === 14 ? 1 : end + 2) === n && end + 1 <= 13) best = Math.max(best, live[c * 13 + end]);
    if (m.start - 2 >= 1 && m.start - 2 === n) best = Math.max(best, live[c * 13 + m.start - 2]);
  }
  return best;
}

/** Live tiles that would let this hand open with sets on the next draw (keeping one tile to discard). */
export function openingWaits(rest, okey, live, ace, need) {
  const have = new Set(rest);
  const near = new Uint8Array(FACES);
  for (const t of rest) {
    const f = faceIndex(t, okey);
    if (f >= FACES) continue;
    const c = Math.floor(f / 13), n = f % 13;
    for (let d = -2; d <= 2; d++) near[c * 13 + ((n + d + 13) % 13)] = 1;
    for (let k = 0; k < 4; k++) near[k * 13 + n] = 1;
  }
  let waits = 0;
  for (let f = 0; f < FACES; f++) {
    if (!live[f] || !near[f]) continue;
    const id = tileOfFace(f, okey, have);
    if (id !== null && bestSets([...rest, id], okey, { ...ace, keep: 1 }).value >= need) waits += live[f];
  }
  return waits;
}

export function plan101(view, mem, params, rng, st) {
  const r = view.round;
  if (view.phase !== 'playing' || !r || view.you == null || r.turn !== view.you || !Array.isArray(view.hand)) {
    return null;
  }
  const you = view.you;
  mem.see(view);
  const S = view.settings || {};
  const okey = r.okey;
  const ace = { aceHighValue: S.aceHighValue ?? 1 };
  const table = r.table || [];
  const hand = view.hand.slice();
  const opened = r.opened[you];
  const req = r.required || { value: S.openingValue ?? 101, pairs: S.minPairs ?? 5 };
  const okeyOf = (t) => isOkey(t, okey);
  const swapOn = S.okeySwap !== false;

  // Per-turn bookkeeping (a turn ends with our discard, so our discard count marks it).
  const mark = `${r.number}:${view.seats[you].discard.count}`;
  if (st.mark !== mark) {
    if (st.round !== r.number) { st.round = r.number; st.openedAt = null; }
    st.mark = mark;
    st.steps = 0;
    st.lazy = rng.chance(params.blunder * 0.4); // a beginner sometimes forgets to lay off this turn
  }
  const first = st.steps === 0;
  st.steps++;
  const out = (action, kind, hardness = 0) => ({ action, kind, hardness, first });

  const canTable = !!opened && (S.addOnOpeningTurn !== false || st.openedAt !== mark);
  const canAdd = opened === 'sets' || (opened === 'pairs' && S.pairsCanAdd !== false);
  const risk = roundRisk(view);

  // ---- opening options for an unopened hand
  const openingOptions = (h) => {
    const sets = bestSets(h, okey, { ...ace, keep: 1 });
    const pairs = S.pairsOpening === false ? null : bestPairs(h, okey, { keep: 1 });
    return {
      sets: sets.value >= req.value ? { kind: 'sets', groups: sets.groups, value: sets.value, left: h.length - sets.tiles } : null,
      pairs: pairs && pairs.count >= req.pairs ? { kind: 'pairs', groups: pairs.groups, left: h.length - 2 * pairs.count } : null,
      setsValue: sets.value,
    };
  };
  // Which opening to make now (null: hold). `forced`: a take must be used this turn.
  const chooseOpening = (o, forced) => {
    if (o.sets) {
      // Experts sometimes hold a strong hand to open and finish in one go (elden, double), when it is safe.
      if (!forced && params.gamble > 0 && o.sets.left >= 2 && o.sets.left <= 4 && r.pileCount >= 10 && risk < 0.3 &&
          rng.chance(params.gamble)) return null;
      return o.sets;
    }
    if (o.pairs) {
      // A pairs opener's hand counts double: experts prefer to wait for sets while that is still realistic.
      if (params.lookahead >= 3 &&
          !forced && r.pileCount > 10 && risk < 0.4 && o.setsValue >= req.value - 25) return null;
      return o.pairs;
    }
    return null;
  };

  // ---- how a taken discard reaches the table this turn (hand already contains t), or null
  const takePlan = (h, t) => {
    if (!opened) {
      const o = openingOptions(h);
      const pick = o.sets?.groups.some((g) => g.includes(t)) ? o.sets
        : o.pairs?.groups.some((g) => g.includes(t)) ? o.pairs : null;
      if (!pick || chooseOpening({ ...o, sets: pick.kind === 'sets' ? pick : null, pairs: pick.kind === 'pairs' ? pick : null }, true) !== pick) return null;
      return { type: 'layDown', groups: pick.groups, opening: true };
    }
    if (!canTable || h.length < 2) return null;
    if (canAdd) {
      const lo = layoffs([t], table, okey)[0];
      if (lo) return { type: 'addToSet', tile: t, meld: lo.meld, side: lo.side ?? undefined };
    }
    if (swapOn) {
      const sw = swaps([t], table, okey)[0];
      if (sw) return { type: 'swapOkey', tile: t, meld: sw.meld, okey: sw.okey };
    }
    if (opened === 'sets' || S.pairsOnly === false) {
      const bs = bestSets(h, okey, { ...ace, keep: 1 });
      if (bs.groups.some((g) => g.includes(t))) return { type: 'layDown', groups: bs.groups };
    }
    if (opened === 'pairs') {
      const bp = bestPairs(h, okey, { keep: 1 });
      if (bp.groups.some((g) => g.includes(t))) return { type: 'layDown', groups: bp.groups };
    }
    return null;
  };
  const clean = (a) => {
    if (!a) return a;
    const { opening, ...rest } = a;
    if (opening) st.openedAt = mark;
    return rest;
  };

  // ---------------------------------------------------------------- draw stage
  if (r.stage === 'draw') {
    const left = (you + 3) % 4;
    const top = view.seats[left].discard.top;
    if (top != null && takePlan([...hand, top], top) && !rng.chance(params.blunder * 0.5)) {
      return out({ type: 'draw', from: 'discard' }, 'draw', 0.3);
    }
    return out({ type: 'draw', from: 'pile' }, 'draw', 0);
  }

  // ---------------------------------------------------------------- discard stage: table plays first
  if (r.taken != null) {
    const a = takePlan(hand, r.taken);
    return a ? out(clean(a), a.type === 'layDown' ? 'open' : 'play') : out({ type: 'undoTake' }, 'play');
  }
  if (hand.length === 1) return out({ type: 'finish', tile: hand[0] }, 'finish');

  if (!opened) {
    const choice = chooseOpening(openingOptions(hand), false);
    if (choice) {
      st.openedAt = mark;
      return out({ type: 'layDown', groups: choice.groups }, 'open', 0.4);
    }
  } else if (canTable) {
    const okeys = hand.filter(okeyOf);
    const real = hand.filter((t) => !okeyOf(t));
    // Take okeys back from the table.
    if (swapOn && !st.lazy) {
      const sw = swaps(real, table, okey)[0];
      if (sw) return out({ type: 'swapOkey', tile: sw.tile, meld: sw.meld, okey: sw.okey }, 'play');
    }
    // New sets (or pairs).
    if (opened === 'sets' || S.pairsOnly === false) {
      const bs = bestSets(hand, okey, { ...ace, keep: 1 });
      if (bs.groups.length) return out({ type: 'layDown', groups: bs.groups }, 'play', 0.2);
    }
    if (opened === 'pairs') {
      const pool = hand.length <= 3 ? hand : real;              // okeys stay in hand unless nearly out
      const bp = bestPairs(pool, okey, { keep: pool.length === hand.length ? 1 : 0 });
      if (bp.count) return out({ type: 'layDown', groups: bp.groups }, 'play', 0.2);
    }
    // Lay off real tiles, highest first.
    if (canAdd && !st.lazy) {
      const lays = layoffs(real, table, okey).sort((a, b) => tileValue(b.tile, okey) - tileValue(a.tile, okey));
      if (lays.length && hand.length >= 2) {
        const lo = lays[0];
        return out({ type: 'addToSet', tile: lo.tile, meld: lo.meld, side: lo.side ?? undefined }, 'play');
      }
    }
    // Okeys left in hand: an okey in hand costs 101 if the round ends, but finishing with one doubles.
    if (okeys.length && canAdd) {
      const lay = layoffs([okeys[0]], table, okey)[0];
      let layIt = false;
      if (real.length === 0) layIt = hand.length >= 2;                  // keep the last one to finish with
      else if (real.length === 1 && hand.length === 2) {
        // Finish now (okey to the table, discard the last tile), or keep the okey for a double next turn.
        layIt = !(params.gamble > 0 && risk < 0.3 && r.pileCount >= 4 && rng.chance(params.gamble));
      } else layIt = params.lookahead < 2 || risk >= 0.5 || hand.length <= 3;
      if (lay && layIt) return out({ type: 'addToSet', tile: okeys[0], meld: lay.meld, side: lay.side ?? undefined }, 'play');
    }
  }

  // ---------------------------------------------------------------- discard
  return chooseDiscard();

  function chooseDiscard() {
    const tableTiles = table.flatMap((m) => m.tiles);
    const live = mem.liveTable(hand, view, tableTiles);
    let cands = hand.filter((t) => !okeyOf(t));
    if (!cands.length) cands = hand.slice();
    const islek = (t) => isIslek(t, table, okey, { swap: swapOn });
    const safe = cands.filter((t) => !islek(t));
    // Beginners now and then miss that a tile fits the table (101 penalty); everyone else never does.
    if (safe.length && !rng.chance(params.blunder * 0.1)) cands = safe;
    // One candidate per face.
    const seen = new Set();
    cands = cands.filter((t) => { const f = faceIndex(t, okey); if (seen.has(f)) return false; seen.add(f); return true; });

    const ctx = makeContext(live, {
      lookahead: Math.min(params.lookahead, 2), pairsBias: 0, handSize: Math.max(3, hand.length - 1),
      ...(params.lookahead >= 4 ? strongOptions(live, r.pileCount) : {}),
    });
    const danger = dangerFn(view, mem, params, live, { pileStart: PILE_START });
    const pairsMode = opened === 'pairs' ||
      (!opened && S.pairsOpening !== false && bestPairs(hand, okey, { keep: 0 }).count >= Math.max(4, req.pairs - 1) &&
        bestSets(hand, okey, { ...ace, keep: 0 }).value < req.value * 0.6);
    const valueWeight = opened ? 0.02 + 0.15 * risk : 0;
    const scored = cands.map((t) => {
      const rest = without(hand, [t]);
      let value;
      if (pairsMode) value = pairsValue(rest, okey, live);
      else {
        const { counts, jokers } = handVector(rest, okey);
        value = evaluate(counts, jokers, ctx).value;
        if (!opened) {
          const bs = bestSets(rest, okey, { ...ace, keep: 0 });
          const sv = bs.value;
          value += sv / 20;                                               // progress toward the opening
          if (ctx.jokerSets) {
            const inSets = new Set(bs.groups.flat());
            value += openingPotential(rest.filter((x) => !inSets.has(x)), okey, live, ctx.turnsLeft, ctx.unknown) / 20;
          }
          return { tile: t, rest, sv, value };
        }
      }
      return { tile: t, rest, value };
    });
    if (!opened && !pairsMode && params.lookahead >= 3) {
      // Look one draw ahead for the most promising discards only.
      scored.sort((a, b) => b.value - a.value);
      const deep = params.lookahead >= 4 ? 6 : 4;
      for (let i = 0; i < scored.length && i < deep; i++) {
        const x = scored[i];
        x.value += OPEN_GAIN_WEIGHT * openingGain(x.rest, okey, live, ace, x.sv) / 20;
      }
      // Lookahead 4, one tile from opening: count the live tiles that would open (exact waits).
      if (params.lookahead >= 4) {
        for (let i = 0; i < scored.length && i < deep; i++) {
          const x = scored[i];
          if (x.sv < req.value - OPEN_WAIT_REACH) continue;
          x.value += OPEN_WAIT_WEIGHT * openingWaits(x.rest, okey, live, ace, req.value);
        }
      }
    }
    const ranked = scored.map(({ tile: t, value }) => {
      const num = tileValue(t, okey);
      // Unopened: keep high tiles (they reach 101 sooner). Opened: shed high tiles as the round nears its end.
      const shed = opened ? valueWeight * num : 0.02 * (13 - num);
      const pen = (danger ? danger(faceIndex(t, okey)) : 0) + (islek(t) ? 50 : 0);
      // Lookahead 4, opened: a tile one live tile away from fitting the table is worth keeping like a partial.
      const bridge = opened && ctx.jokerSets
        ? BRIDGE_WEIGHT * ctx.pv[Math.min(4, bridgeOuts(t, table, okey, live))] : 0;
      return { tile: t, value, score: value + shed - pen - bridge };
    });
    ranked.sort((a, b) => b.score - a.score);
    let pick = ranked[0];
    if (rng.chance(params.blunder)) {
      const slip = ranked.find((x) => x !== pick && x.value < pick.value - 0.01 && x.value >= pick.value - BLUNDER_MARGIN &&
        !islek(x.tile) === !islek(pick.tile));
      if (slip) pick = slip;
    }
    const gap = ranked[1] ? ranked[0].score - ranked[1].score : 1;
    const isLast = hand.length === 1;
    return out({ type: isLast ? 'finish' : 'discard', tile: pick.tile }, 'discard', Math.max(0, 1 - gap / 0.5));
  }
}

