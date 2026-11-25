// Analysis harness (not a unit test): how much each bot discard helps the NEXT player, measured with the
// true hands (analysis only; bots never see them). Compares the chosen discard with a random and the
// safest discard from the same hand.  node test/giftsim.mjs <level> [rounds] [nodef]
import * as C from '../site/shared/okey/index.js';
import { playRounds, botsFor } from './botsim.mjs';
// value of a hand for the analysis only: tiles locked in sets + half of the tiles in near-sets
const val = (ids, okey) => { const r = C.arrangeRack(ids, okey); return r.sets.flat().length + 0.5 * r.partials.flat().filter((x) => x !== null).length; };
const level = process.argv[2] || 'kalfa', rounds = +(process.argv[3] || 60), withDefense = process.argv[4];
const params = withDefense === 'nodef' ? [0,1,2,3].map(() => ({ defense: 0 })) : [];
let n = 0, chosen = 0, avg = 0, best = 0, worst = 0, taken = 0, okeysGiven = 0;
let lastDiscard = null;
playRounds({ bots: botsFor([level, level, level, level], 'gift-' + level, params), rounds, seed: 'gift-' + level,
  beforeAction: ({ seat, view, match }) => {
    const r = match.round; if (r.stage !== 'discard') return;
    const nx = (seat + 1) % 4, okey = r.okey, nh = r.hands[nx];
    const base = val(nh, okey);
    const g = (t) => val([...nh, t], okey) - base;
    const cand = r.hands[seat];
    const gs = cand.map(g);
    globalThis.__cand = { gs, cand, g, okey };
  },
  onAction: ({ seat, action, match }) => {
    if (action.type === 'draw' && action.from === 'discard') taken++;
    if (action.type !== 'discard' || !globalThis.__cand) return;
    const { gs, cand, g, okey } = globalThis.__cand; globalThis.__cand = null;
    n++; chosen += g(action.tile); avg += gs.reduce((a, b) => a + b, 0) / gs.length; best += Math.min(...gs); worst += Math.max(...gs);
    if (C.isOkey(action.tile, okey)) okeysGiven++;
  } });
console.log(level, withDefense || '', `discards ${n}  gift chosen ${(chosen/n).toFixed(3)}  random ${(avg/n).toFixed(3)}  safest ${(best/n).toFixed(3)}  worst ${(worst/n).toFixed(3)}  takes ${taken}  okeys thrown ${okeysGiven}`);
