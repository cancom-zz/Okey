// Classic Okey turn policy: what to do with the view in front of the bot. (Variant-specific: a 101 Okey
// policy would live beside this file and reuse faces.js, evaluate.js and memory.js.)
//
// Uses only: the bot's own view (hand, discard tops and counts, indicator/okey, pile count, turn, stage,
// firstTurn, showedIndicator) and the bot's own Memory. Never the seat kinds, names or anything else.

import { finishOptions, findFinish } from '../okey/rules.js';
import { otherCopy } from '../okey/tiles.js';
import { FACES, WILD, faceIndex, handVector, faceColor, faceNum, okeyFaceIndex } from './faces.js';
import { makeContext, evaluate, expectedDrawGain } from './evaluate.js';
import { dangerFn, DEFENSE_CAP } from './defense.js';

const BLUNDER_MARGIN = 1.0;   // a blunder only picks a move at most this much worse (stays plausible:
                              // breaks a partial or keeps a weaker tile, never breaks a complete set)
const DEEP_CANDIDATES = 4;    // lookahead 3: discards that get the one-draw look-ahead
const DEEP_WINDOW = 0.5;      // lookahead 3: only discards within this much of the best get the look-ahead
const IRRELEVANT = BLUNDER_MARGIN + DEFENSE_CAP + 0.5; // DEFENSE_CAP from defense.js

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
  if (deep) {
    // Look one draw ahead for the discards that are close to the best (the others stay where they are).
    out.sort((a, b) => b.value - a.value);
    const wide = ctx.lookahead >= 4;
    const maxDeep = wide ? 2 * DEEP_CANDIDATES : DEEP_CANDIDATES, window = wide ? 2 * DEEP_WINDOW : DEEP_WINDOW;
    for (let i = 0; i < out.length && i < maxDeep; i++) {
      if (out[i].value < top - window) break;
      out[i].value += expectedDrawGain(out[i].rest, okey, ctx);
    }
  }
  for (const x of out) x.score = x.value - (danger ? danger(faceIndex(x.tile, okey)) : 0);
  out.sort((a, b) => b.score - a.score);
  return out;
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

  const live = mem.liveTable(hand, view);
  const ctx = makeContext(live, params);
  const danger = dangerFn(view, mem, params, live, { pileStart: 48 });

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
  if (rng.chance(params.blunder)) {
    // A plausible slip: the best discard that is actually worse, but not by much.
    const slip = ranked.find((x) => x.value < pick.value - 0.01 && x.value >= pick.value - BLUNDER_MARGIN);
    if (slip) pick = slip;
  }
  const gap = second ? ranked[0].score - second.score : 1;
  const hardness = Math.max(0, 1 - gap / 0.5);
  return { action: { type: 'discard', tile: pick.tile }, kind: 'discard', hardness };
}
