// Test helper: bot-only simulations for classic and 101 Okey, shared by the bot tests. Each seat's bot gets
// only its own events (eventsFor) and its own view (viewFor); every action goes through the engine's act(),
// which throws on anything illegal.
//
// Also a worker_threads entry point: `runTables(jobs)` plays independent tables in parallel threads (the
// ladders), each job { variant, levels, rounds, seed } -> a plain summary.

import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import * as C from '../site/shared/okey/index.js';
import * as H from '../site/shared/okey101/index.js';
import { createBot } from '../site/shared/bots/index.js';

export const MAX_STEPS_101 = 40; // host.js MAX_BOT_STEPS_101

export const seatsFor = () => [0, 1, 2, 3].map((i) => ({ id: 'p' + i, name: 'P' + i, kind: 'bot', bot: { level: 'x' } }));
export const botsFor = (levels, seed, params = []) =>
  levels.map((level, i) => createBot({ level, params: params[i], seed: `${seed}-${i}` }));

/** Classic: `rounds` rounds. -> { wins, points, actions, empty } per seat. */
export function playRounds({ bots, rounds, seed, wrap = (v) => v, onAction, beforeAction, onEvents }) {
  const deal = C.seededRng('deal-' + seed);
  let match = C.newMatch({ seats: seatsFor(), settings: { startPoints: 1e9 } });
  const wins = [0, 0, 0, 0];
  const points = [0, 0, 0, 0];
  let actions = 0;
  let empty = 0;
  const send = (events) => {
    onEvents?.(events);
    for (let s = 0; s < 4; s++) for (const e of C.eventsFor(events, s)) bots[s].observe(structuredClone(e));
  };
  for (let k = 0; k < rounds; k++) {
    let res = C.startRound(match, deal);
    match = res.match;
    send(res.events);
    while (match.phase === 'playing') {
      const seat = match.round.turn;
      const view = C.viewFor(match, seat);
      beforeAction?.({ seat, view, match });
      const ms = bots[seat].delayMs(wrap(view));
      const action = bots[seat].decide(wrap(view));
      onAction?.({ seat, view, action, ms, match });
      res = C.act(match, seat, action);
      match = res.match;
      send(res.events);
      actions++;
      if (actions > 1e6) throw new Error('runaway');
    }
    const r = match.result;
    if (r.winner === null) empty++;
    else wins[r.winner]++;
    for (let s = 0; s < 4; s++) points[s] += r.deltas[s];
  }
  return { wins, points, actions, empty };
}

/** 101: a match of `rounds` rounds. -> { scores, steps, takes, undo, islek, opened, maxTurnSteps, delays }. */
export function playMatch101({ bots, seed, rounds = 9, wrap = (v) => v, onStep, beforeStep, onEvents }) {
  const deal = H.seededRng('deal101-' + seed);
  let match = H.newMatch({ seats: seatsFor(), settings: { rounds } });
  const stats = { steps: 0, takes: 0, undo: 0, islek: [0, 0, 0, 0], opened: [0, 0, 0, 0], maxTurnSteps: 0, delays: { first: [], later: [] } };
  const send = (events) => {
    onEvents?.(events);
    for (let s = 0; s < 4; s++) for (const e of H.eventsFor(events, s)) bots[s].observe(structuredClone(e));
  };
  for (let k = 0; k < rounds; k++) {
    let res = H.startRound(match, deal);
    match = res.match;
    send(res.events);
    let turnSeat = -1;
    let turnSteps = 0;
    while (match.phase === 'playing') {
      const seat = match.round.turn;
      if (seat !== turnSeat) { turnSeat = seat; turnSteps = 0; }
      turnSteps++;
      stats.maxTurnSteps = Math.max(stats.maxTurnSteps, turnSteps);
      if (turnSteps > MAX_STEPS_101) throw new Error('a bot turn did not end');
      const view = H.viewFor(match, seat);
      beforeStep?.({ seat, view });
      const ms = bots[seat].delayMs(wrap(view));
      const action = bots[seat].decide(wrap(view));
      stats.delays[turnSteps === 1 ? 'first' : 'later'].push(ms);
      onStep?.({ seat, view, action, ms, match });
      if (action?.type === 'draw' && action.from === 'discard') stats.takes++;
      if (action?.type === 'undoTake') stats.undo++;
      res = H.act(match, seat, action);
      for (const e of res.events) if (e.type === 'penalty') stats.islek[e.seat]++;
      match = res.match;
      send(res.events);
      stats.steps++;
    }
    match.result.opened.forEach((o, i) => { if (o) stats.opened[i]++; });
    if (match.phase === 'matchEnd') break;
  }
  return { scores: match.scores, ...stats };
}

/** One ladder table (runs in a worker or inline). */
export function playTable({ variant, levels, rounds, seed }) {
  const bots = botsFor(levels, seed);
  if (variant === '101') {
    const r = playMatch101({ bots, seed, rounds });
    return { levels, scores: r.scores, steps: r.steps, takes: r.takes, undo: r.undo, islek: r.islek, opened: r.opened,
      maxTurnSteps: r.maxTurnSteps, delays: r.delays, rounds };
  }
  const delays = [[], [], [], []];
  const r = playRounds({ bots, rounds, seed, onAction: ({ seat, ms }) => delays[seat].push(ms) });
  return { levels, wins: r.wins, points: r.points, actions: r.actions, empty: r.empty, delays, rounds };
}

/** Play independent tables in parallel worker threads, at most one per CPU (results in job order). */
export async function runTables(jobs, limit = Math.max(1, Math.min(4, availableParallelism()))) {
  const out = new Array(jobs.length);
  let next = 0;
  const one = (job) => new Promise((resolve, reject) => {
    const w = new Worker(new URL(import.meta.url), { workerData: { job } });
    w.once('message', resolve);
    w.once('error', reject);
    w.once('exit', (code) => { if (code !== 0) reject(new Error(`worker exited with ${code}`)); });
  });
  const lane = async () => {
    while (next < jobs.length) {
      const i = next++;
      out[i] = await one(jobs[i]);
    }
  };
  await Promise.all(Array.from({ length: limit }, lane));
  return out;
}

if (!isMainThread && workerData?.job) parentPort.postMessage(playTable(workerData.job));
