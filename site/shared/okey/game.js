// The game state machine (see DESIGN.md "Round flow", "Scoring", "Game state machine").
//
// Pure and deterministic: every function returns new objects and never mutates its inputs; randomness only
// comes from the injected `rng` ({ int(n) }) in startRound. A match is plain JSON (it gets persisted).
//
// Decisions that refine DESIGN.md:
// - The indicator is taken OUT of the pile and sits face up beside it. It is not drawable. With the dealer's
//   15 and 3 x 14 dealt, the pile starts at 106 - 57 - 1 = 48 tiles. At any time every tile is in exactly one
//   place: a hand, the pile, a discard stack, the indicator, or (after a finish) the center.
// - The indicator position is chosen with rng among the undealt tiles; a false joker there moves it to the
//   next position.
// - Pile exhaustion: the round ends (no winner, no score) as soon as the turn passes to a player who must
//   draw while the pile is empty. The player who drew the last pile tile still discards or finishes.
// - A finish is always scored as the best kind its 14 tiles allow (pairs beat sets). The client's `groups`
//   are kept for display when they are a valid partition of that kind; otherwise the engine's are used.
// - Showing the indicator costs the others points immediately; whether the match is over is only checked
//   at round end, so a round always finishes.
// - The first dealer is `newMatch({ dealer })` (default 0); round k is dealt by (dealer + k - 1) % 4.
// - Drawing from the pile emits a public event without the tile (marked `except: seat`) plus a private copy
//   with the tile (`to: seat`). eventsFor(events, seat) does the routing.

import { TILE_COUNT, isFalseJoker, isTile, okeyFace, isOkey, otherCopy, allTiles } from './tiles.js';
import { shuffle } from './rng.js';
import { bestFinish, partitionKind, finishOptions, arrange } from './rules.js';

export class GameError extends Error {
  constructor(code) {
    super(code);
    this.name = 'GameError';
    this.code = code;
  }
}

export const DEFAULT_SETTINGS = {
  turnSeconds: 30,
  rounds: null, // null/0: play until a score reaches 0
  startPoints: 20,
  scoring: { normal: 2, okey: 4, pairs: 4, pairsOkey: 8, indicator: 1 },
};

const SEATS = 4;
const clone = (x) => structuredClone(x);
// Inputs from outside (seats, settings) go through JSON so the match stays plain JSON (no undefined etc.).
const jsonCopy = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
const next = (seat) => (seat + 1) % SEATS;
const prev = (seat) => (seat + SEATS - 1) % SEATS;

function mergeSettings(s = {}) {
  return {
    ...clone(DEFAULT_SETTINGS),
    ...jsonCopy(s),
    scoring: { ...DEFAULT_SETTINGS.scoring, ...(s.scoring ?? {}) },
  };
}

// ---------------------------------------------------------------------------------------------------------
// Match lifecycle

/**
 * seats: 4 x { id, name, kind: 'human' | 'bot' | 'empty', bot?, avatar? } (copied as given).
 * code: room code (copied into views). dealer: first dealer seat.
 */
export function newMatch({ settings, seats, code = null, dealer = 0 } = {}) {
  if (!Array.isArray(seats) || seats.length !== SEATS) throw new GameError('badAction');
  const merged = mergeSettings(settings);
  return {
    v: 0,
    code,
    phase: 'lobby', // 'lobby' (no round yet) | 'playing' | 'roundEnd' | 'matchEnd'
    settings: merged,
    seats: jsonCopy(seats),
    scores: Array(SEATS).fill(merged.startPoints),
    firstDealer: dealer,
    roundNumber: 0,
    round: null,
    result: null,
    winners: null,
    history: [], // per round: { round, winner, kind, okeyFinish, deltas }
  };
}

/** Deal a new round. Allowed from 'lobby' or 'roundEnd'. */
export function startRound(match, rng) {
  if (match.phase !== 'lobby' && match.phase !== 'roundEnd') throw new GameError('badAction');
  const m = clone(match);
  const number = m.roundNumber + 1;
  const dealer = (m.firstDealer + number - 1) % SEATS;

  const tiles = shuffle(allTiles(), rng);
  const hands = Array.from({ length: SEATS }, () => []);
  let pos = 0;
  for (let k = 0; k < SEATS; k++) {
    const seat = (dealer + k) % SEATS;
    const n = seat === dealer ? 15 : 14;
    hands[seat] = tiles.slice(pos, pos + n);
    pos += n;
  }
  const pile = tiles.slice(pos);
  // Indicator: a random position; if it holds a false joker, the next position (still uniform, and it
  // terminates even with a degenerate rng).
  let at = rng.int(pile.length);
  while (isFalseJoker(pile[at])) at = (at + 1) % pile.length;
  const [indicator] = pile.splice(at, 1);

  m.roundNumber = number;
  m.phase = 'playing';
  m.result = null;
  m.round = {
    number,
    dealer,
    turn: dealer,
    stage: 'discard', // the dealer starts by discarding
    indicator,
    okey: okeyFace(indicator),
    pile, // top = last element
    hands,
    discards: Array.from({ length: SEATS }, () => []), // top = last element
    firstTurn: Array(SEATS).fill(true),
    showed: Array(SEATS).fill(false),
    turns: Array(SEATS).fill(0), // completed turns per seat this round
    center: null, // the finishing discard
  };
  m.v++;

  const events = [{ type: 'roundStart', round: number, dealer, indicator, pileCount: pile.length }];
  for (let s = 0; s < SEATS; s++) events.push({ type: 'dealt', to: s, hand: hands[s].slice() });
  return { match: m, events };
}

/** Start the next round after 'roundEnd' (same as startRound, but only from 'roundEnd'). */
export function nextRound(match, rng) {
  if (match.phase !== 'roundEnd') throw new GameError(match.phase === 'matchEnd' ? 'roundOver' : 'badAction');
  return startRound(match, rng);
}

// ---------------------------------------------------------------------------------------------------------
// Actions

/** Apply one action for `seat`. Throws GameError on anything illegal. */
export function act(match, seat, action) {
  if (match.phase !== 'playing') throw new GameError('roundOver');
  if (!Number.isInteger(seat) || seat < 0 || seat >= SEATS) throw new GameError('notYourTurn');
  if (!action || typeof action !== 'object') throw new GameError('badAction');
  const handler = HANDLERS[action.type];
  if (!handler || !Object.hasOwn(HANDLERS, action.type)) throw new GameError('badAction');
  if (match.round.turn !== seat) throw new GameError('notYourTurn');
  const m = clone(match);
  const events = [];
  handler(m, seat, action, events);
  m.v++;
  return { match: m, events };
}

const HANDLERS = { draw, discard, finish, showIndicator };

function draw(m, seat, action, events) {
  const r = m.round;
  if (action.from !== 'pile' && action.from !== 'discard') throw new GameError('badAction');
  if (r.stage !== 'draw') throw new GameError('mustDiscard');
  if (action.from === 'pile') {
    // Unreachable in practice: the round ends when the turn reaches a drawer with an empty pile.
    if (r.pile.length === 0) throw new GameError('badAction');
    const tile = r.pile.pop();
    r.hands[seat].push(tile);
    events.push({ type: 'draw', seat, from: 'pile', except: seat });
    events.push({ type: 'draw', seat, from: 'pile', tile, to: seat });
  } else {
    const stack = r.discards[prev(seat)];
    if (stack.length === 0) throw new GameError('emptyDiscard');
    const tile = stack.pop();
    r.hands[seat].push(tile);
    events.push({ type: 'draw', seat, from: 'discard', tile });
  }
  r.stage = 'discard';
}

function takeFromHand(r, seat, tile) {
  if (r.stage !== 'discard') throw new GameError('mustDraw');
  const i = r.hands[seat].indexOf(tile);
  if (!isTile(tile) || i < 0) throw new GameError('noTile');
  r.hands[seat].splice(i, 1);
}

function discard(m, seat, action, events) {
  const r = m.round;
  takeFromHand(r, seat, action.tile);
  r.discards[seat].push(action.tile);
  r.firstTurn[seat] = false;
  r.turns[seat]++;
  events.push({ type: 'discard', seat, tile: action.tile });
  r.turn = next(seat);
  r.stage = 'draw';
  if (r.pile.length === 0) endRound(m, null, events);
}

function finish(m, seat, action, events) {
  const r = m.round;
  if (r.stage !== 'discard') throw new GameError('mustDraw');
  if (!r.hands[seat].includes(action.tile)) throw new GameError('noTile');
  const rest = r.hands[seat].filter((t) => t !== action.tile);
  const best = bestFinish(rest, r.okey);
  if (!best) throw new GameError('cannotFinish');
  const given = action.groups === undefined ? null : partitionKind(action.groups, rest, r.okey);
  const groups = given === best.kind ? action.groups.map((g) => g.slice()) : best.groups;

  r.hands[seat] = rest;
  r.center = action.tile;
  r.turns[seat]++;
  const okeyFinish = isOkey(action.tile, r.okey);
  const sc = m.settings.scoring;
  const loss = best.kind === 'pairs' ? (okeyFinish ? sc.pairsOkey : sc.pairs) : okeyFinish ? sc.okey : sc.normal;
  const deltas = Array.from({ length: SEATS }, (_, s) => (s === seat ? 0 : -loss));
  const hands = r.hands.map((h) => h.slice());
  events.push({ type: 'finish', seat, tile: action.tile, kind: best.kind, okeyFinish, groups, hands });
  applyScore(m, deltas, events);
  endRound(m, { winner: seat, kind: best.kind, okeyFinish, tile: action.tile, groups, deltas }, events);
}

function showIndicator(m, seat, action, events) {
  const r = m.round;
  const tile = otherCopy(r.indicator);
  if (!r.firstTurn[seat] || r.showed[seat] || !r.hands[seat].includes(tile)) throw new GameError('cannotShow');
  r.showed[seat] = true;
  events.push({ type: 'showIndicator', seat, tile });
  const loss = m.settings.scoring.indicator;
  applyScore(m, Array.from({ length: SEATS }, (_, s) => (s === seat ? 0 : -loss)), events);
}

function applyScore(m, deltas, events) {
  m.scores = m.scores.map((s, i) => s + deltas[i]);
  events.push({ type: 'score', deltas, scores: m.scores.slice() });
}

/** End the round: `fin` is the finish summary, or null when the pile ran out. Then check for match end. */
function endRound(m, fin, events) {
  const r = m.round;
  const hands = r.hands.map((h) => h.slice());
  if (!fin) events.push({ type: 'pileEmpty', hands });
  const deltas = fin ? fin.deltas : Array(SEATS).fill(0);
  m.result = {
    winner: fin ? fin.winner : null,
    kind: fin ? fin.kind : null,
    okeyFinish: fin ? fin.okeyFinish : false,
    tile: fin ? fin.tile : null,
    groups: fin ? fin.groups : null,
    hands,
    deltas,
    scores: m.scores.slice(),
    turns: r.turns.slice(),
  };
  m.history.push({
    round: r.number,
    winner: m.result.winner,
    kind: m.result.kind,
    okeyFinish: m.result.okeyFinish,
    deltas,
  });
  m.phase = 'roundEnd';
  const limit = m.settings.rounds;
  if (m.scores.some((s) => s <= 0) || (limit && m.roundNumber >= limit)) {
    const top = Math.max(...m.scores);
    m.winners = m.scores.flatMap((s, i) => (s === top ? [i] : []));
    m.phase = 'matchEnd';
    events.push({ type: 'matchEnd', scores: m.scores.slice(), winners: m.winners.slice() });
  }
}

// ---------------------------------------------------------------------------------------------------------
// Projection

/**
 * What `seat` (or a spectator: null) may see. This is the security boundary: no other hands, no pile order,
 * no buried discards (only top + count per stack). Hands are revealed in `result.hands` at round end.
 * Host-owned fields (host, connected, away, turnEndsAt, now) are filled with defaults for the host to
 * overwrite.
 */
export function viewFor(match, seat) {
  const r = match.round;
  const you = Number.isInteger(seat) && seat >= 0 && seat < SEATS ? seat : null;
  return {
    v: match.v,
    code: match.code,
    phase: match.phase,
    settings: clone(match.settings),
    host: null,
    you,
    seats: match.seats.map((s, i) => ({
      kind: s?.kind ?? 'empty',
      name: s?.name ?? '',
      avatar: s?.avatar ?? null,
      connected: s?.connected ?? true,
      away: s?.away ?? false,
      bot: s?.kind === 'bot' ? { level: s.bot?.level ?? null } : null,
      score: match.scores[i],
      handCount: r ? r.hands[i].length : 0,
      discard: r ? { top: r.discards[i].at(-1) ?? null, count: r.discards[i].length } : { top: null, count: 0 },
      showedIndicator: r ? r.showed[i] : false,
    })),
    round: r && {
      number: r.number,
      dealer: r.dealer,
      turn: r.turn,
      stage: r.stage,
      indicator: r.indicator,
      okey: { ...r.okey },
      pileCount: r.pile.length,
      turnEndsAt: null,
      firstTurn: r.firstTurn.slice(),
    },
    hand: r && you !== null ? r.hands[you].slice() : null,
    result: match.result ? clone(match.result) : null,
    winners: match.winners ? match.winners.slice() : null,
    now: null,
  };
}

/**
 * The events `seat` (null = spectator) may receive: public events, minus those marked `except: seat`,
 * plus private events with `to: seat`.
 */
export function eventsFor(events, seat) {
  return events.filter((e) => (e.to === undefined ? e.except !== seat : e.to === seat));
}

/** Is `action` currently legal for `seat`? (Cheap dry run of act.) */
export function isLegal(match, seat, action) {
  try {
    act(match, seat, action);
    return true;
  } catch (e) {
    if (e instanceof GameError) return false;
    throw e;
  }
}

/**
 * Auto-play for a seat that timed out (or null if it is not that seat's turn): draw from the pile; then
 * finish if possible, otherwise discard a leftover of the best arrangement (never an okey if avoidable).
 */
export function timeoutAction(match, seat) {
  if (match.phase !== 'playing' || match.round.turn !== seat) return null;
  const r = match.round;
  if (r.stage === 'draw') return { type: 'draw', from: 'pile' };
  const hand = r.hands[seat];
  const opts = finishOptions(hand, r.okey);
  if (opts.length) {
    const o = opts.find((x) => x.okeyFinish) ?? opts[0];
    return { type: 'finish', tile: o.discard, groups: o.groups };
  }
  const notOkey = (t) => !isOkey(t, r.okey);
  const leftovers = arrange(hand, r.okey, 'runs').at(-1).filter(notOkey);
  // Highest leftover number first (fewer points of use), deterministic.
  const pick = leftovers.at(-1) ?? hand.filter(notOkey).at(-1) ?? hand[0];
  return { type: 'discard', tile: pick };
}

/** Every tile id accounted for (for tests and sanity checks): returns where each id is. */
export function tileLocations(match) {
  const r = match.round;
  if (!r) return null;
  const where = Array(TILE_COUNT).fill(null);
  const put = (id, loc) => {
    if (where[id] !== null) throw new Error(`tile ${id} in ${where[id]} and ${loc}`);
    where[id] = loc;
  };
  r.hands.forEach((h, s) => h.forEach((id) => put(id, `hand${s}`)));
  r.discards.forEach((d, s) => d.forEach((id) => put(id, `discard${s}`)));
  r.pile.forEach((id) => put(id, 'pile'));
  put(r.indicator, 'indicator');
  if (r.center !== null) put(r.center, 'center');
  return where;
}
