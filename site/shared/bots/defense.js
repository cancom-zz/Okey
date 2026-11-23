// Defense, shared by the variants: how much the next player (seat + 1, the only one who can take our discard)
// seems to want a face, judged only from the bot's own memory of that player's pickups, passes and throws.

import { faceColor, faceNum, runNeighbors, groupNeighbors } from './faces.js';

export const DEFENSE_CAP = 0.5;       // defense never outweighs breaking a complete set (or a good partial)
export const DEFENSE_BONUS_CAP = 0.2; // how much a known-safe tile is preferred

// Defense: how much the next player (on our right, who may take our discard) seems to want face f,
// judged only from remembered pickups, passes and throws of that player. Relative: an unremarkable tile
// costs nothing, a tile next to what they picked up costs more, a tile they already passed on or threw is
// slightly preferred. It grows as the pile shrinks and as they pick up more.
export function dangerFn(view, mem, params, live, { pileStart = 48 } = {}) {
  if (!(params.defense > 0)) return null;
  const okey = view.round.okey;
  const nextSeat = (view.you + 1) % 4;
  const picks = mem.facesOf(mem.picks[nextSeat], okey);
  const passed = mem.facesOf(mem.passed[nextSeat], okey);
  const throws = mem.facesOf(mem.throws[nextSeat], okey);
  const pileLeft = Math.max(0, Math.min(1, view.round.pileCount / pileStart));
  const urgency = Math.min(1.3, 0.3 + 0.7 * (1 - pileLeft) + 0.1 * picks.length);
  const runDist = (a, b) => {
    if (faceColor(a) !== faceColor(b)) return 99;
    const x = faceNum(a), y = faceNum(b);
    return Math.min(Math.abs(x - y), Math.abs((x === 1 ? 14 : x) - y), Math.abs(x - (y === 1 ? 14 : y)));
  };
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
    let safe = 0;
    if (passed.includes(f)) safe += 0.3;
    if (throws.includes(f)) safe += 0.2;
    const pen = params.defense * urgency * 0.6 * (want - safe);
    const out = Math.max(-DEFENSE_BONUS_CAP, Math.min(DEFENSE_CAP, pen));
    cache.set(f, out);
    return out;
  };
}

