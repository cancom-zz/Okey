// Classic Okey turn policy: what to do with the view in front of the bot. (Variant-specific: a 101 Okey
// policy would live beside this file and reuse faces.js, evaluate.js and memory.js.)
//
// Uses only: the bot's own view (hand, discard tops and counts, indicator/okey, pile count, turn, stage,
// firstTurn, showedIndicator) and the bot's own Memory. Never the seat kinds, names or anything else.

import { finishOptions, findFinish } from '../okey/rules.js';
import { otherCopy } from '../okey/tiles.js';
import { FACES, WILD, faceIndex, handVector, faceColor, faceNum, okeyFaceIndex } from './faces.js';
import { makeContext, evaluate, expectedDrawGain, strongOptions } from './evaluate.js';
import { dangerFn, DEFENSE_CAP, readPrevious, tellPenalty, bluffPick, TELL_READ } from './defense.js';
import { keptContext, efficiencyOf, acceptance } from './efficiency.js';

const BLUNDER_MARGIN = 1.0;   // a blunder only picks a move at most this much worse (stays plausible:
                              // breaks a partial or keeps a weaker tile, never breaks a complete set)
const DEEP_CANDIDATES = 4;    // lookahead 3: discards that get the one-draw look-ahead
const DEEP_WINDOW = 0.5;      // lookahead 3: only discards within this much of the best get the look-ahead
const IRRELEVANT = BLUNDER_MARGIN + DEFENSE_CAP + 0.5; // DEFENSE_CAP from defense.js

const TURN_FACTOR = 1.3;      // lookahead 4: own draws per pile/4, counting tiles taken from the discard
const DEF_WEIGHT = 10;        // lookahead 4 discard score: one missing tile ...
const ACC_WEIGHT = 0.2;       // ... outweighs any acceptance (live tiles that help) ...
const VALUE_WEIGHT = 0.3;     // ... and the hand value only breaks ties
const DANGER_WEIGHT = 2;      // defense can override a few tiles of acceptance, never a missing tile
const ACC_CANDIDATES = 4;    // lookahead 4: discards whose acceptance is counted (best by value) ...
const SAFE_CANDIDATES = 2;   // ... plus the safest ones
const ACC_TAKE_MARGIN = 6;
const BLUFF_MARGIN = 0.25;    // a bluff discard costs at most this much hand value ...
const BLUFF_MARGIN_L4 = 0.5;  // ... (lookahead 4 scale: same deficiency, about 2 tiles of acceptance)    // lookahead 4: take a discard that keeps the deficiency only if it adds this many
const finishPoints = (o) => (o.kind === 'pairs' ? 4 : 2) * (o.okeyFinish ? 2 : 1);

/** Value of a tile list for this bot (higher = closer to finishing). */
function valueOf(ids, okey, ctx, floor = -Infinity) {
  const { counts, jokers } = handVector(ids, okey);
  return evaluate(counts, jokers, ctx, floor).value;
}

/** One representative tile per discardable face (never a wild okey). */
function discardCandidates(hand, okey, exclude) {
  const seen = new Set();
  const out = [];
  for (const id of hand) {
    const f = faceIndex(id, okey);
    if (f === WILD || seen.has(f) || id === exclude) continue;
    seen.add(f);
    out.push(id);
  }
  return out;
}

/** Rank discards of a 15-tile hand by remaining value (plus one-draw look-ahead) minus danger. */
function rankDiscards(hand, view, ctx, danger, exclude, deep = ctx.lookahead >= 3) {
  const okey = view.round.okey;
  let cands = discardCandidates(hand, okey, exclude);
  if (cands.length === 0) cands = discardCandidates(hand, okey, null);
  const out = [];
  let top = -Infinity;
  for (const id of cands) {
    const rest = hand.filter((x) => x !== id);
    // Candidates far below the best can never be picked (not even as a blunder), so prune against that.
    const value = valueOf(rest, okey, ctx, top - IRRELEVANT);
    if (value > top) top = value;
    out.push({ tile: id, rest, value, score: value });
  }
  if (ctx.kctx) {
    // Lookahead 4: tile efficiency. Fewest tiles missing first, then most live tiles that help, then value.
    let minDef = Infinity;
    for (const x of out) {
      Object.assign(x, efficiencyOf(x.rest, okey, ctx.kctx, { atMost: minDef }));
      if (x.def < minDef) minDef = x.def;
    }
    // Acceptance for the best few of the closest hands by value, and for the safest few (so safety is weighed
    // against real efficiency, not against a missing count); the rest keep 0.
    const closest = out.filter((x) => x.def === minDef);
    const close = new Set(closest.slice().sort((a, b) => b.value - a.value).slice(0, ACC_CANDIDATES));
    if (danger) {
      for (const x of closest.slice().sort((a, b) => danger(faceIndex(a.tile, okey)) - danger(faceIndex(b.tile, okey))).slice(0, SAFE_CANDIDATES)) close.add(x);
    }
    for (const x of out) x.acc = 0;
    for (const x of close) x.acc = acceptance(x.counts, x.jokers, ctx.kctx, x.def, { liveOkeys: ctx.liveOkeys });
    for (const x of out) x.value = -DEF_WEIGHT * x.def + ACC_WEIGHT * x.acc + VALUE_WEIGHT * x.value;
    for (const x of out) x.score = x.value - DANGER_WEIGHT * (danger ? danger(faceIndex(x.tile, okey)) : 0);
    out.sort((a, b) => b.score - a.score);
    return out;
  }
  if (deep) {
    // Lookahead 3: look one draw ahead for the discards that are close to the best (the others stay put).
    out.sort((a, b) => b.value - a.value);
    for (let i = 0; i < out.length && i < DEEP_CANDIDATES; i++) {
      if (out[i].value < top - DEEP_WINDOW) break;
      out[i].value += expectedDrawGain(out[i].rest, okey, ctx);
    }
  }
  for (const x of out) x.score = x.value - (danger ? danger(faceIndex(x.tile, okey)) : 0);
  out.sort((a, b) => b.score - a.score);
  return out;
}

/** Evaluation options by level: the strongest level (lookahead 4) gets the fuller model. */
export function contextOptions(params, live, pileCount) {
  const o = { lookahead: params.lookahead, pairsBias: params.pairsBias };
  return params.lookahead >= 4 ? { ...o, ...strongOptions(live, pileCount, TURN_FACTOR) } : o;
}

/** A tile id with face f that is not in `hand` (for "what if I drew f" checks). */
function tileForFace(f, okey, hand) {
  const have = new Set(hand);
  if (f === okeyFaceIndex(okey)) return [104, 105].find((x) => !have.has(x)) ?? null;
  const c = faceColor(f), n = faceNum(f);
  for (const cp of [0, 1]) {
    const id = c * 26 + cp * 13 + n - 1;
    if (!have.has(id)) return id;
  }
  return null;
}

/** Live outs for an okey finish if we keep this finished 14-tile hand and wait one more draw. */
function okeyFinishOuts(rest14, okey, live) {
  const wild = rest14.find((id) => faceIndex(id, okey) === WILD);
  if (wild === undefined) return 0;
  const base = rest14.filter((id) => id !== wild);
  let outs = 0;
  for (let f = 0; f < FACES; f++) {
    if (live[f] === 0) continue;
    const id = tileForFace(f, okey, rest14);
    if (id != null && findFinish([...base, id], okey)) outs += live[f];
  }
  return outs;
}

/**
 * -> { action, kind, hardness } or null when it is not this bot's move.
 * kind: 'show' | 'draw' | 'finish' | 'discard'; hardness 0..1 (how close the call was, for thinking time).
 */
export function plan(view, mem, params, rng, st) {
  const r = view.round;
  if (view.phase !== 'playing' || !r || view.you == null || r.turn !== view.you || !Array.isArray(view.hand)) {
    return null;
  }
  const you = view.you;
  mem.see(view);
  const hand = view.hand.slice();
  const okey = r.okey;
  if (st.round !== r.number) {
    st.round = r.number;
    st.indicator = null;
    st.gambled = false;
    st.took = null;
  }

  // Show the indicator (gösterge) on the first turn when holding its other copy. Beginners may forget.
  if (r.firstTurn[you] && !view.seats[you].showedIndicator && hand.includes(otherCopy(r.indicator))) {
    if (st.indicator === null) st.indicator = rng.chance(params.blunder) ? 'forget' : 'show';
    if (st.indicator === 'show') return { action: { type: 'showIndicator' }, kind: 'show', hardness: 0 };
  }

  const seenLive = mem.liveTable(hand, view);
  // Taşlamak, offense: what the previous player is unlikely to feed us counts one copy less (read >= 0.5).
  const live = readPrevious(view, mem, params, seenLive);
  const ctx = makeContext(live, contextOptions(params, live, r.pileCount));
  if (params.lookahead >= 4) {
    ctx.kctx = keptContext(live);
    const seen = [...hand, ...view.seats.map((x) => x.discard.top)].filter((t) => t != null && faceIndex(t, okey) === WILD);
    ctx.liveOkeys = Math.max(0, 2 - seen.length);
  }
  // Taşlamak, defense (what the next player collects) and tells (what our discard says about us).
  const handFaces = hand.map((t) => faceIndex(t, okey)).filter((f) => f !== WILD);
  const reader = dangerFn(view, mem, params, seenLive, { pileStart: 48, late: params.lookahead >= 4 });
  const telling = (params.read ?? 0) >= TELL_READ;
  const danger = reader || telling
    ? (f) => (reader ? reader(f) : 0) + tellPenalty(params, f, handFaces) / (params.lookahead >= 4 ? DANGER_WEIGHT : 1)
    : null;

  if (r.stage === 'draw') {
    const left = (you + 3) % 4;
    const top = view.seats[left].discard.top;
    const pile = { action: { type: 'draw', from: 'pile' }, kind: 'draw' };
    if (top == null) return { ...pile, hardness: 0 };
    if (r.pileCount === 0) return { action: { type: 'draw', from: 'discard' }, kind: 'draw', hardness: 0 };
    const take = { action: { type: 'draw', from: 'discard' }, kind: 'draw' };
    const with15 = [...hand, top];
    if (faceIndex(top, okey) === WILD) return { ...take, hardness: 0 };
    if (finishOptions(with15, okey).some((o) => o.discard !== top)) return { ...take, hardness: 0 };
    if (ctx.kctx) {
      // Lookahead 4: take it when it brings the hand a tile closer, or keeps the distance with much wider waits.
      const cur = efficiencyOf(hand, okey, ctx.kctx);
      const curAcc = acceptance(cur.counts, cur.jokers, ctx.kctx, cur.def, { liveOkeys: ctx.liveOkeys });
      const best = rankDiscards(with15, view, ctx, null, top, false)[0];
      const better = best.def < cur.def || (best.def === cur.def && best.acc >= curAcc + ACC_TAKE_MARGIN);
      const hardness = best.def === cur.def ? 0.6 : 0.1;
      if (better && !rng.chance(params.blunder * 0.5)) { st.took = top; return { ...take, hardness }; }
      return { ...pile, hardness };
    }
    const now = valueOf(hand, okey, ctx);
    const ranked = rankDiscards(with15, view, ctx, null, top, false);
    let gain = ranked[0].value - now;
    if (ctx.lookahead >= 3 && gain > 0) {
      // Compare against what a pile draw is worth on average, one draw ahead for both hands.
      gain += expectedDrawGain(ranked[0].rest, okey, ctx) - expectedDrawGain(hand, okey, ctx);
    }
    const threshold = (ctx.lookahead >= 3 ? 0.3 : 0.75) - 0.5 * params.takeDiscard;
    const hardness = Math.max(0, 1 - Math.abs(gain - threshold) / 0.4);
    if (gain > threshold) {
      if (rng.chance(params.blunder * 0.5)) return { ...pile, hardness };  // missed it
      st.took = top;
      return { ...take, hardness };
    }
    return { ...pile, hardness };
  }

  // Discard stage: 15 tiles.
  const opts = finishOptions(hand, okey);
  if (opts.length) {
    opts.sort((a, b) => finishPoints(b) - finishPoints(a));
    const best = opts[0];
    const holdsWild = hand.some((id) => faceIndex(id, okey) === WILD);
    // Expert gamble: keep the finished hand one more turn hoping to finish by throwing the okey (double).
    if (!best.okeyFinish && holdsWild && !st.gambled && r.pileCount >= 20 && params.gamble > 0 &&
        rng.chance(params.gamble)) {
      const rest14 = hand.filter((x) => x !== best.discard);
      if (okeyFinishOuts(rest14, okey, live) >= 5) {
        st.gambled = true;
        return { action: { type: 'discard', tile: best.discard }, kind: 'discard', hardness: 0.8 };
      }
    }
    return { action: { type: 'finish', tile: best.discard, groups: best.groups }, kind: 'finish', hardness: 0 };
  }

  const ranked = rankDiscards(hand, view, ctx, danger, st.took);
  st.took = null;
  let pick = ranked[0];
  const second = ranked[1];
  let slipped = false;
  if (rng.chance(params.blunder)) {
    // A plausible slip: the best discard that is actually worse, but not by much.
    const slip = ranked.find((x) => x.value < pick.value - 0.01 && x.value >= pick.value - BLUNDER_MARGIN);
    if (slip) { pick = slip; slipped = true; }
  }
  st.discards = (st.discards ?? 0) + 1;
  if (!slipped && params.bluff > 0) {
    // Taşlamak, bluff (Uzman): a loose tile of a colour we collect, when it costs almost nothing.
    const b = bluffPick({
      params, rng, ranked, margin: params.lookahead >= 4 ? BLUFF_MARGIN_L4 : BLUFF_MARGIN,
      faceOf: (x) => faceIndex(x.tile, okey), handFaces, pileLeft: Math.min(1, r.pileCount / 48),
    });
    if (b) { pick = b; st.bluffs = (st.bluffs ?? 0) + 1; }
  }
  const gap = second ? ranked[0].score - second.score : 1;
  const hardness = Math.max(0, 1 - gap / 0.5);
  return { action: { type: 'discard', tile: pick.tile }, kind: 'discard', hardness };
}
