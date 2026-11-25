// Regression for the "it keeps throwing me really good tiles" report (giftsim logic, test/giftsim.mjs).
// "Gift" = how much a discard improves the NEXT player's true hand (tiles in sets + half the tiles in
// near-sets, via arrangeRack; analysis only, bots never see it).
//
// Paired design, so a short run is enough: at every discard, the same bot (cloned from its snapshot) also
// decides with defense and reading switched off, on the very same view and RNG state. Where the two choices
// differ, the reading bot must feed the next player clearly less.
// node --test test/gift.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import * as C from '../site/shared/okey/index.js';
import { createBot } from '../site/shared/bots/index.js';
import { playRounds, botsFor } from './botsim.mjs';

const val = (ids, okey) => {
  const r = C.arrangeRack(ids, okey);
  return r.sets.flat().length + 0.5 * r.partials.flat().filter((x) => x !== null).length;
};

function paired(level, rounds, seed) {
  const bots = botsFor([level, level, level, level], seed);
  let blind = null, differ = 0, gain = 0, total = 0, state = null;
  playRounds({
    bots, rounds, seed,
    beforeAction: ({ seat, view, match }) => {
      blind = null;
      if (view.round.stage !== 'discard') return;
      const saved = JSON.parse(JSON.stringify(bots[seat].snapshot()));
      const twin = createBot({ level, saved: { ...saved, custom: { ...saved.custom, defense: 0, read: 0 } } });
      blind = twin.decide(view);
      state = match.round;
    },
    onAction: ({ seat, action }) => {
      if (!blind || action.type !== 'discard' || blind.type !== 'discard') return;
      total++;
      if (action.tile === blind.tile) return;
      const nh = state.hands[(seat + 1) % 4];
      differ++;
      gain += val([...nh, blind.tile], state.okey) - val([...nh, action.tile], state.okey);
    },
  });
  return { total, differ, saved: gain / Math.max(1, differ) };
}

test('defense works: where reading changes the discard, it feeds the next player less', () => {
  let differ = 0, saved = 0;
  for (const [level, rounds] of [['kalfa', 12], ['usta', 12], ['uzman', 6]]) {
    const r = paired(level, rounds, 'gift-t');
    console.log(`${level}: ${r.differ}/${r.total} discards changed by reading; gift saved per change ${r.saved.toFixed(2)}`);
    assert.ok(r.differ >= 20, `${level}: reading changes enough discards (${r.differ})`);
    // Uzman changes fewer discards (its efficiency already avoids some), so it counts in the pooled check only.
    if (level !== 'uzman') assert.ok(r.saved > 0, `${level}: the defended discard gives less (${r.saved})`);
    differ += r.differ;
    saved += r.saved * r.differ;
  }
  // Pooled: about 600 changed discards, so this is several standard errors from zero.
  assert.ok(saved / differ >= 0.05, `pooled gift saved per changed discard ${saved / differ}`);
});
