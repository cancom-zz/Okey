// 101 Okey: the game state machine. Same API shape as the classic engine (../okey/game.js) so TableHost can
// pick either by `settings.variant`. Pure and deterministic: never mutates its inputs; randomness only comes
// from the injected `rng` ({ int(n) }) in startRound. A match is plain JSON.
//
// RULE CHOICES (the defaults are the common kahvehane rules; every house rule is a setting):
//
// Deal. 106 tiles, the classic tiles, indicator, okey and false jokers. 4 players: 21 tiles each, the dealer
//   22. The indicator is a random undealt tile (a false joker moves it to the next position) and is taken out
//   of the pile, so the pile starts at 106 - 85 - 1 = 20. The dealer starts by discarding. Dealer rotates.
// Turn. Draw from the pile or take the previous player's discard top, then lay down / add / swap (optional),
//   then discard. Stages are 'draw' and 'discard' (= drawn: may play to the table, must end by discarding).
// Sets. Classic runs and groups (12-13-1 yes, 13-1-2 no); okeys wild; false jokers play as the okey face.
// Opening (el açmak). A player's first lay-down (one `layDown` action) is either
//   - sets whose values total >= `openingValue` (101). A tile counts its number, an okey the number it stands
//     for, the 1 after 13 counts `aceHighValue` (1; some houses 11 or 14), or
//   - at least `minPairs` (5) pairs (çift açmak; identical faces, an okey pairs with anything), if
//     `pairsOpening` (true).
//   Mixed sets + pairs never open. With `raiseOpening` (false) each later opener must beat the highest opening
//   of the same kind so far (value + 1, or one more pair).
// After opening. Sets openers lay only sets. Pairs openers lay only pairs (`pairsOnly`, true) and may add to
//   runs/groups on the table (`pairsCanAdd`, true). Anyone opened may add tiles (işleme) to ANY run or group on
//   the table (extend a run at either end, complete a group to 4) and take an okey back (`okeySwap`, true) by
//   putting the exact tile it stands for in its place (run: its position; pair: the partner's face; group:
//   any color not yet in it). The okey goes to the hand. Everything is also allowed on the opening turn
//   itself (`addOnOpeningTurn`, true). Unopened players cannot touch the table. A player must always keep at
//   least one tile in hand (to discard): a table action that would empty the hand is `mustKeepOne`.
// Taking the discard. Allowed only if the tile goes to the table in the same turn. Flow:
//   { type: 'draw', from: 'discard' } puts the tile in hand as `round.taken` (public) and remembers the turn
//   state. Until the taken tile leaves the hand (to the table by layDown / addToSet / swapOkey), `discard` and
//   `finish` fail with `mustUseTaken`. A player who had not opened must open with it (an opening without the
//   taken tile is `mustUseTaken`). `{ type: 'undoTake' }` (only while the tile is still in hand) puts it back on
//   the stack and restores the hand, the table and the opening exactly as they were before the take (stage
//   back to 'draw'); so nobody can get stuck.
// Penalties during play (added to the discarder's score at once, `penalty` + `score` events):
//   - İşlek taş: discarding a tile that could be added to a run/group on the table, or could take an okey
//     back: +`scoring.islek` (101). Applies to every player (opened or not). An okey is işlek whenever any
//     run or group can take it, so throwing an okey while melds are on the table costs 101.
//   - `scoring.okeyDiscard` (0 = off): extra flat penalty for discarding an okey even with nothing on the
//     table (an okey discard pays the larger of the two, never both).
//   - The finishing discard is never penalized.
// Finishing. A player whose hand is down to one tile at the discard finishes by discarding it (`discard` or
//   `finish`). Multiplier m (they stack): x2 if the last tile is an okey (`doubles.okeyFinish`), x2 elden
//   (opened in this same turn, `doubles.elden`), x2 if the finisher opened with pairs (`doubles.pairsFinish`).
// Scoring (penalty points, lower is better; scores start at 0):
//   finisher -`scoring.finish` x m (-101); not opened `scoring.unopened` x m (202); opened: hand value x m,
//   an okey in hand counting `scoring.okeyInHand` (101), a false joker the okey's number; a pairs opener's
//   hand is doubled again (`doubles.pairsOpener`).
// Pile exhaustion. As classic: when a discard passes the turn to a player while the pile is empty, the round
//   ends with no finisher: unopened 202, opened their hand value (pairs openers x2), no multiplier.
// Match. Exactly `rounds` rounds (default 9, 1..11); lowest total wins; ties share the win.
// Not in 101: showing the indicator (`showIndicator` -> cannotShow).
//
// Events (public unless `to`; eventsFor as classic): roundStart, dealt (private), draw (pile: public
// `except` + private copy), take { seat, tile }, undoTake { seat, tile }, layDown { seat, melds: [{ index,
// ...meld }], opening: null | { kind, value, pairs } }, addToSet { seat, tile, meld, side, tiles },
// swapOkey { seat, tile, okey, meld }, discard, penalty { seat, reason: 'islek' | 'okeyDiscard', tile, points },
// finish { seat, tile, kind, okeyFinish, elden, multiplier, hands }, pileEmpty { hands }, score, matchEnd.

import { TILE_COUNT, isFalseJoker, isTile, okeyFace, isOkey, allTiles } from '../okey/tiles.js';
import { shuffle } from '../okey/rng.js';
import { arrange } from '../okey/rules.js';
import {
  meldOf, pairOf, addTile, swapTile, isIslek, handValue, tileValue, bestSets, bestPairs, layoffs, swaps,
} from './rules.js';

export class GameError extends Error {
  constructor(code) {
    super(code);
    this.name = 'GameError';
    this.code = code;
  }
}

export const VARIANT = '101';

export const DEFAULT_SETTINGS = {
  variant: '101',
  turnSeconds: 30,
  rounds: 9,
  startPoints: 0,
  openingValue: 101,
  minPairs: 5,
  aceHighValue: 1,
  raiseOpening: false,
  pairsOpening: true,
  pairsOnly: true,
  pairsCanAdd: true,
  addOnOpeningTurn: true,
  okeySwap: true,
  scoring: { finish: 101, unopened: 202, okeyInHand: 101, islek: 101, okeyDiscard: 0 },
  doubles: { okeyFinish: true, elden: true, pairsFinish: true, pairsOpener: true },
};

const SEATS = 4;
const HAND = 21;
const clone = (x) => structuredClone(x);
const jsonCopy = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
const next = (seat) => (seat + 1) % SEATS;
const prev = (seat) => (seat + SEATS - 1) % SEATS;

function mergeSettings(s = {}) {
  const d = clone(DEFAULT_SETTINGS);
  const given = jsonCopy(s) ?? {};
  const out = { ...d, ...given, variant: '101' };
  out.scoring = { ...d.scoring, ...(given.scoring ?? {}) };
  out.doubles = { ...d.doubles, ...(given.doubles ?? {}) };
  out.rounds = Number.isInteger(out.rounds) && out.rounds >= 1 ? out.rounds : d.rounds;
  out.startPoints = 0;
  return out;
}

// ---------------------------------------------------------------------------------------------------------
// Match lifecycle

export function newMatch({ settings, seats, code = null, dealer = 0 } = {}) {
  if (!Array.isArray(seats) || seats.length !== SEATS) throw new GameError('badAction');
  const merged = mergeSettings(settings);
  return {
    v: 0,
    variant: '101',
    code,
    phase: 'lobby',
    settings: merged,
    seats: jsonCopy(seats),
    scores: Array(SEATS).fill(0),
    firstDealer: dealer,
    roundNumber: 0,
    round: null,
    result: null,
    winners: null,
    history: [], // per round: { round, winner, kind, okeyFinish, elden, multiplier, deltas (incl. penalties) }
  };
}

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
    const n = seat === dealer ? HAND + 1 : HAND;
    hands[seat] = tiles.slice(pos, pos + n);
    pos += n;
  }
  const pile = tiles.slice(pos);
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
    stage: 'discard',
    indicator,
    okey: okeyFace(indicator),
    pile,
    hands,
    discards: Array.from({ length: SEATS }, () => []),
    firstTurn: Array(SEATS).fill(true),
    turns: Array(SEATS).fill(0),
    center: null,
    table: [], // public melds: { owner, kind, tiles, color?, start?, num? }
    opened: Array(SEATS).fill(false), // false | 'sets' | 'pairs'
    openings: Array(SEATS).fill(null), // { kind, value, pairs, turn }
    highest: { sets: 0, pairs: 0 }, // for raiseOpening
    penalties: Array(SEATS).fill(0), // in-round penalties (işlek etc.)
    taken: null, // the provisional discard take of the seat on turn
    undo: null, // secret: state before the take
  };
  m.v++;

  const events = [{ type: 'roundStart', round: number, dealer, indicator, pileCount: pile.length }];
  for (let s = 0; s < SEATS; s++) events.push({ type: 'dealt', to: s, hand: hands[s].slice() });
  return { match: m, events };
}

export function nextRound(match, rng) {
  if (match.phase !== 'roundEnd') throw new GameError(match.phase === 'matchEnd' ? 'roundOver' : 'badAction');
  return startRound(match, rng);
}

// ---------------------------------------------------------------------------------------------------------
// Actions

export function act(match, seat, action) {
  if (match.phase !== 'playing') throw new GameError('roundOver');
  if (!Number.isInteger(seat) || seat < 0 || seat >= SEATS) throw new GameError('notYourTurn');
  if (!action || typeof action !== 'object') throw new GameError('badAction');
  if (!Object.hasOwn(HANDLERS, action.type)) throw new GameError('badAction');
  if (match.round.turn !== seat) throw new GameError('notYourTurn');
  const m = clone(match);
  const events = [];
  HANDLERS[action.type](m, seat, action, events);
  m.v++;
  return { match: m, events };
}

const HANDLERS = { draw, discard, finish, layDown, addToSet, swapOkey, undoTake, showIndicator };

/** The opening the seat must reach now: { value, pairs }. */
export function requiredOpening(round, settings) {
  const raise = !!settings.raiseOpening;
  return {
    value: raise ? Math.max(settings.openingValue, round.highest.sets + 1) : settings.openingValue,
    pairs: raise ? Math.max(settings.minPairs, round.highest.pairs + 1) : settings.minPairs,
  };
}

function draw(m, seat, action, events) {
  const r = m.round;
  if (action.from !== 'pile' && action.from !== 'discard') throw new GameError('badAction');
  if (r.stage !== 'draw') throw new GameError('mustDiscard');
  if (action.from === 'pile') {
    if (r.pile.length === 0) throw new GameError('badAction');
    const tile = r.pile.pop();
    r.hands[seat].push(tile);
    events.push({ type: 'draw', seat, from: 'pile', except: seat });
    events.push({ type: 'draw', seat, from: 'pile', tile, to: seat });
  } else {
    const stack = r.discards[prev(seat)];
    if (stack.length === 0) throw new GameError('emptyDiscard');
    r.undo = {
      hand: r.hands[seat].slice(),
      table: clone(r.table),
      opened: r.opened[seat],
      opening: clone(r.openings[seat]),
      highest: { ...r.highest },
    };
    const tile = stack.pop();
    r.hands[seat].push(tile);
    r.taken = tile;
    events.push({ type: 'take', seat, tile });
  }
  r.stage = 'discard';
}

function undoTake(m, seat, action, events) {
  const r = m.round;
  if (r.stage !== 'discard' || r.taken === null || !r.undo) throw new GameError('noTake');
  const tile = r.taken;
  r.hands[seat] = r.undo.hand;
  r.table = r.undo.table;
  r.opened[seat] = r.undo.opened;
  r.openings[seat] = r.undo.opening;
  r.highest = r.undo.highest;
  r.discards[prev(seat)].push(tile);
  r.taken = null;
  r.undo = null;
  r.stage = 'draw';
  events.push({ type: 'undoTake', seat, tile });
}

function needDrawn(r) {
  if (r.stage !== 'discard') throw new GameError('mustDraw');
}

/** Remove `tiles` from the hand; the hand must keep at least one tile. Clears a used take. */
function useTiles(r, seat, tiles) {
  const hand = r.hands[seat];
  if (!tiles.every((t) => isTile(t) && hand.includes(t))) throw new GameError('noTile');
  if (tiles.length >= hand.length) throw new GameError('mustKeepOne');
  const set = new Set(tiles);
  r.hands[seat] = hand.filter((t) => !set.has(t));
  if (r.taken !== null && set.has(r.taken)) {
    r.taken = null;
    r.undo = null;
  }
}

/** May this (opened) seat play to the table right now? */
function checkTableTurn(m, seat) {
  const r = m.round;
  if (!r.opened[seat]) throw new GameError('notOpened');
  if (!m.settings.addOnOpeningTurn && r.openings[seat]?.turn === r.turns[seat]) throw new GameError('notThisTurn');
}

function layDown(m, seat, action, events) {
  const r = m.round;
  const st = m.settings;
  needDrawn(r);
  const specs = action.groups;
  if (!Array.isArray(specs) || specs.length === 0 || specs.length > 11) throw new GameError('badAction');
  const ids = specs.flatMap((g) => (Array.isArray(g) ? g : Array.isArray(g?.tiles) ? g.tiles : [null]));
  if (!ids.every(isTile) || new Set(ids).size !== ids.length) throw new GameError('badSet');
  if (!ids.every((t) => r.hands[seat].includes(t))) throw new GameError('noTile');
  const ace = { aceHighValue: st.aceHighValue };
  const sets = specs.map((g) => meldOf(g, r.okey, ace));
  const pairs = specs.map((g) => pairOf(g, r.okey));
  const allSets = sets.every(Boolean);
  const allPairs = !allSets && pairs.every(Boolean);
  if (!allSets && !allPairs) throw new GameError('badSet');

  let opening = null;
  if (!r.opened[seat]) {
    const need = requiredOpening(r, st);
    if (allSets) {
      const value = sets.reduce((s, x) => s + x.value, 0);
      if (value < need.value) throw new GameError('openTooLow');
      opening = { kind: 'sets', value, pairs: 0, turn: r.turns[seat] };
    } else {
      if (!st.pairsOpening) throw new GameError('badSet');
      if (pairs.length < need.pairs) throw new GameError('tooFewPairs');
      opening = { kind: 'pairs', value: pairs.reduce((s, x) => s + x.value, 0), pairs: pairs.length, turn: r.turns[seat] };
    }
    if (r.taken !== null && !ids.includes(r.taken)) throw new GameError('mustUseTaken');
  } else {
    checkTableTurn(m, seat);
    if (r.opened[seat] === 'sets' && !allSets) throw new GameError('setsOnly');
    if (r.opened[seat] === 'pairs' && st.pairsOnly && !allPairs) throw new GameError('pairsOnly');
  }
  useTiles(r, seat, ids);
  if (opening) {
    r.opened[seat] = opening.kind;
    r.openings[seat] = opening;
    if (opening.kind === 'sets') r.highest.sets = Math.max(r.highest.sets, opening.value);
    else r.highest.pairs = Math.max(r.highest.pairs, opening.pairs);
  }
  const melds = (allSets ? sets : pairs).map(({ value, ...meld }) => {
    const placed = { owner: seat, ...meld };
    r.table.push(placed);
    return { index: r.table.length - 1, ...clone(placed) };
  });
  events.push({
    type: 'layDown', seat, melds,
    opening: opening && { kind: opening.kind, value: opening.value, pairs: opening.pairs },
  });
}

function addToSet(m, seat, action, events) {
  const r = m.round;
  needDrawn(r);
  checkTableTurn(m, seat);
  if (r.opened[seat] === 'pairs' && !m.settings.pairsCanAdd) throw new GameError('pairsOnly');
  const { tile, meld: i } = action;
  if (!Number.isInteger(i) || i < 0 || i >= r.table.length) throw new GameError('badAction');
  if (action.side !== undefined && action.side !== null && action.side !== 'start' && action.side !== 'end') {
    throw new GameError('badAction');
  }
  if (!isTile(tile) || !r.hands[seat].includes(tile)) throw new GameError('noTile');
  const target = r.table[i];
  const added = target.kind === 'pair' ? null : addTile(target, tile, r.okey, action.side ?? undefined);
  if (!added) throw new GameError('cannotAdd');
  useTiles(r, seat, [tile]);
  r.table[i] = added;
  const side = added.kind === 'run' ? (added.tiles[0] === tile ? 'start' : 'end') : null;
  events.push({ type: 'addToSet', seat, tile, meld: i, side, tiles: added.tiles.slice() });
}

function swapOkey(m, seat, action, events) {
  const r = m.round;
  if (!m.settings.okeySwap) throw new GameError('cannotSwap');
  needDrawn(r);
  checkTableTurn(m, seat);
  const { tile, meld: i } = action;
  if (!Number.isInteger(i) || i < 0 || i >= r.table.length) throw new GameError('badAction');
  if (!isTile(tile) || !r.hands[seat].includes(tile)) throw new GameError('noTile');
  const which = isTile(action.okey) ? action.okey : undefined;
  const res = swapTile(r.table[i], tile, r.okey, which);
  if (!res) throw new GameError('cannotSwap');
  r.table[i] = res.meld;
  r.hands[seat] = r.hands[seat].filter((t) => t !== tile);
  r.hands[seat].push(res.okey);
  if (r.taken === tile) {
    r.taken = null;
    r.undo = null;
  }
  events.push({ type: 'swapOkey', seat, tile, okey: res.okey, meld: i });
}

function showIndicator() {
  throw new GameError('cannotShow');
}

function discard(m, seat, action, events) {
  const r = m.round;
  needDrawn(r);
  const tile = action.tile;
  if (!isTile(tile) || !r.hands[seat].includes(tile)) throw new GameError('noTile');
  if (r.taken !== null) throw new GameError('mustUseTaken');
  if (r.hands[seat].length === 1) return finishWith(m, seat, tile, events);

  const sc = m.settings.scoring;
  let points = 0;
  let reason = null;
  if (sc.islek && isIslek(tile, r.table, r.okey, { swap: m.settings.okeySwap })) {
    points = sc.islek;
    reason = 'islek';
  }
  if (isOkey(tile, r.okey) && sc.okeyDiscard > points) {
    points = sc.okeyDiscard;
    reason = 'okeyDiscard';
  }
  r.hands[seat] = r.hands[seat].filter((t) => t !== tile);
  r.discards[seat].push(tile);
  r.firstTurn[seat] = false;
  r.turns[seat]++;
  events.push({ type: 'discard', seat, tile });
  if (points) {
    r.penalties[seat] += points;
    events.push({ type: 'penalty', seat, reason, tile, points });
    applyScore(m, Array.from({ length: SEATS }, (_, s) => (s === seat ? points : 0)), events);
  }
  r.turn = next(seat);
  r.stage = 'draw';
  if (r.pile.length === 0) endRound(m, null, events);
}

function finish(m, seat, action, events) {
  const r = m.round;
  needDrawn(r);
  if (!isTile(action.tile) || !r.hands[seat].includes(action.tile)) throw new GameError('noTile');
  if (r.taken !== null) throw new GameError('mustUseTaken');
  if (r.hands[seat].length !== 1) throw new GameError('cannotFinish');
  finishWith(m, seat, action.tile, events);
}

function finishWith(m, seat, tile, events) {
  const r = m.round;
  const st = m.settings;
  const d = st.doubles;
  const okeyFinish = isOkey(tile, r.okey);
  const elden = r.openings[seat]?.turn === r.turns[seat];
  const kind = r.opened[seat];
  const multiplier = (okeyFinish && d.okeyFinish ? 2 : 1) * (elden && d.elden ? 2 : 1) * (kind === 'pairs' && d.pairsFinish ? 2 : 1);
  r.hands[seat] = [];
  r.center = tile;
  r.firstTurn[seat] = false;
  r.turns[seat]++;
  const deltas = roundPenalties(m, seat, multiplier);
  events.push({ type: 'finish', seat, tile, kind, okeyFinish, elden, multiplier, hands: r.hands.map((h) => h.slice()) });
  applyScore(m, deltas, events);
  endRound(m, { winner: seat, kind, okeyFinish, elden, multiplier, tile, deltas }, events);
}

/** Round-end penalty per seat (winner: the finisher or null after pile exhaustion). */
function roundPenalties(m, winner, multiplier) {
  const r = m.round;
  const st = m.settings;
  const sc = st.scoring;
  return Array.from({ length: SEATS }, (_, s) => {
    if (s === winner) return -sc.finish * multiplier;
    if (!r.opened[s]) return sc.unopened * multiplier;
    const pairsX = r.opened[s] === 'pairs' && st.doubles.pairsOpener ? 2 : 1;
    return handValue(r.hands[s], r.okey, { okeyInHand: sc.okeyInHand }) * multiplier * pairsX;
  });
}

function applyScore(m, deltas, events) {
  m.scores = m.scores.map((s, i) => s + deltas[i]);
  events.push({ type: 'score', deltas, scores: m.scores.slice() });
}

function endRound(m, fin, events) {
  const r = m.round;
  r.taken = null;
  r.undo = null;
  let deltas;
  if (fin) deltas = fin.deltas;
  else {
    deltas = roundPenalties(m, null, 1);
    events.push({ type: 'pileEmpty', hands: r.hands.map((h) => h.slice()) });
    applyScore(m, deltas, events);
  }
  m.result = {
    winner: fin ? fin.winner : null,
    kind: fin ? fin.kind : null,
    okeyFinish: fin ? fin.okeyFinish : false,
    elden: fin ? fin.elden : false,
    multiplier: fin ? fin.multiplier : 1,
    tile: fin ? fin.tile : null,
    groups: null,
    hands: r.hands.map((h) => h.slice()),
    opened: r.opened.slice(),
    deltas: deltas.slice(),
    penalties: r.penalties.slice(),
    scores: m.scores.slice(),
    turns: r.turns.slice(),
  };
  m.history.push({
    round: r.number,
    winner: m.result.winner,
    kind: m.result.kind,
    okeyFinish: m.result.okeyFinish,
    elden: m.result.elden,
    multiplier: m.result.multiplier,
    deltas: deltas.map((x, i) => x + r.penalties[i]),
  });
  m.phase = 'roundEnd';
  if (m.roundNumber >= m.settings.rounds) {
    const low = Math.min(...m.scores);
    m.winners = m.scores.flatMap((s, i) => (s === low ? [i] : []));
    m.phase = 'matchEnd';
    events.push({ type: 'matchEnd', scores: m.scores.slice(), winners: m.winners.slice() });
  }
}

// ---------------------------------------------------------------------------------------------------------
// Projection

/**
 * What `seat` (null = spectator) may see: own hand only; discard tops + counts; the table melds, openings
 * and the provisional take are public. Never the pile order, buried discards or the undo state.
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
      showedIndicator: false,
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
      table: r.table.map(publicMeld),
      opened: r.opened.slice(),
      openings: r.openings.map((o) => (o ? { kind: o.kind, value: o.value, pairs: o.pairs } : null)),
      required: requiredOpening(r, match.settings),
      penalties: r.penalties.slice(),
      taken: r.taken,
    },
    hand: r && you !== null ? r.hands[you].slice() : null,
    result: match.result ? clone(match.result) : null,
    winners: match.winners ? match.winners.slice() : null,
    now: null,
  };
}

function publicMeld(m) {
  const out = { owner: m.owner, kind: m.kind, tiles: m.tiles.slice() };
  if (m.kind === 'run') Object.assign(out, { color: m.color, start: m.start });
  if (m.kind === 'group') out.num = m.num;
  return out;
}

export function eventsFor(events, seat) {
  return events.filter((e) => (e.to === undefined ? e.except !== seat : e.to === seat));
}

export function isLegal(match, seat, action) {
  try {
    act(match, seat, action);
    return true;
  } catch (e) {
    if (e instanceof GameError) return false;
    throw e;
  }
}

// ---------------------------------------------------------------------------------------------------------
// Auto-play

/**
 * One step of auto-play for the seat on turn (null otherwise). Call repeatedly until the turn passes:
 * draw from the pile; give back an unusable take; open if possible (sets >= the requirement, else enough
 * pairs); once opened, take okeys back, lay new sets/pairs and add tiles to the table (okeys only when 3 tiles
 * or fewer are left); finish with the last tile; else discard the highest-value leftover, never an işlek tile
 * or an okey if avoidable.
 */
export function timeoutAction(match, seat) {
  if (match.phase !== 'playing' || match.round.turn !== seat) return null;
  const r = match.round;
  const st = match.settings;
  if (r.stage === 'draw') return { type: 'draw', from: 'pile' };
  const hand = r.hands[seat];
  const okey = r.okey;
  const ace = { aceHighValue: st.aceHighValue };
  const opened = r.opened[seat];

  if (r.taken !== null) {
    if (opened && canPlayTable(match, seat) && (opened === 'sets' || st.pairsCanAdd) && hand.length >= 2) {
      const lay = layoffs([r.taken], r.table, okey)[0];
      if (lay) return { type: 'addToSet', tile: lay.tile, meld: lay.meld, side: lay.side ?? undefined };
    }
    return { type: 'undoTake' };
  }
  if (hand.length === 1) return { type: 'discard', tile: hand[0] };

  if (!opened) {
    const need = requiredOpening(r, st);
    const sets = bestSets(hand, okey, { ...ace, keep: 1 });
    if (sets.value >= need.value) return { type: 'layDown', groups: sets.groups };
    if (st.pairsOpening) {
      const p = bestPairs(hand, okey, { keep: 1 });
      if (p.count >= need.pairs) return { type: 'layDown', groups: p.groups };
    }
  } else if (canPlayTable(match, seat)) {
    if (st.okeySwap) {
      const sw = swaps(hand, r.table, okey)[0];
      if (sw) return { type: 'swapOkey', tile: sw.tile, meld: sw.meld, okey: sw.okey };
    }
    if (opened === 'sets' || (opened === 'pairs' && !st.pairsOnly)) {
      const sets = bestSets(hand, okey, { ...ace, keep: 1 });
      if (sets.groups.length) return { type: 'layDown', groups: sets.groups };
    }
    if (opened === 'pairs') {
      const p = bestPairs(hand.filter((t) => !isOkey(t, okey)), okey, { keep: hand.some((t) => isOkey(t, okey)) ? 0 : 1 });
      if (p.count) return { type: 'layDown', groups: p.groups };
    }
    if (opened === 'sets' || st.pairsCanAdd) {
      const lay = layoffs(hand, r.table, okey).find((l) => !isOkey(l.tile, okey) || hand.length <= 3);
      if (lay) return { type: 'addToSet', tile: lay.tile, meld: lay.meld, side: lay.side ?? undefined };
    }
  }
  return { type: 'discard', tile: pickDiscard(match, seat) };
}

function canPlayTable(match, seat) {
  const r = match.round;
  return !!r.opened[seat] && (match.settings.addOnOpeningTurn || r.openings[seat]?.turn !== r.turns[seat]);
}

/** The least useful tile: not an okey, not işlek if avoidable; arrange() leftovers first, highest value. */
export function pickDiscard(match, seat) {
  const r = match.round;
  const hand = r.hands[seat];
  const okey = r.okey;
  const notOkey = hand.filter((t) => !isOkey(t, okey));
  const base = notOkey.length ? notOkey : hand;
  const safe = base.filter((t) => !isIslek(t, r.table, okey, { swap: match.settings.okeySwap }));
  const pool = safe.length ? safe : base;
  const left = new Set(arrange(hand, okey, 'runs').at(-1));
  const pref = pool.filter((t) => left.has(t));
  const from = pref.length ? pref : pool;
  let best = from[0];
  for (const t of from) {
    const a = tileValue(t, okey);
    const b = tileValue(best, okey);
    if (a > b || (a === b && t > best)) best = t;
  }
  return best;
}

/** Every tile accounted for: returns where each id is (throws if a tile is in two places). */
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
  r.table.forEach((mld, i) => mld.tiles.forEach((id) => put(id, `table${i}`)));
  r.pile.forEach((id) => put(id, 'pile'));
  put(r.indicator, 'indicator');
  if (r.center !== null) put(r.center, 'center');
  return where;
}

