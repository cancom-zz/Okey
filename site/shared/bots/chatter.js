// Table talk: the preset emotes and quick phrases a bot uses now and then, like people at a kahvehane table.
//
// It reacts ONLY to public table moments (someone else finishes, the match starts or ends, a human is taking
// long) and is fed only { type, seat, round } of those events, never a tile, its hand or its plans. It has its
// own seeded RNG (separate from the bot's decision RNG), so what it says can never depend on what it holds:
// the same public events give the same emotes whatever the hands. At most one emote per round (the match
// start counts as round 1, the match end has its own slot). The host routes the result through the same
// emote path (and rate limit) as humans.

import { seededRng } from '../okey/rng.js';

// Per level: chance to react, and which emote ids it picks from. Çırak chats, Uzman is terse.
export const CHATTER = Object.freeze({
  cirak: { finish: 0.6, start: 0.6, end: 0.7, hurry: 0.35, onFinish: ['clap', 'eyvallah', 'wow', 'smile', 'fire'] },
  kalfa: { finish: 0.4, start: 0.45, end: 0.55, hurry: 0.2, onFinish: ['clap', 'eyvallah', 'wow'] },
  usta: { finish: 0.3, start: 0.35, end: 0.45, hurry: 0.1, onFinish: ['eyvallah', 'clap'] },
  uzman: { finish: 0.15, start: 0.25, end: 0.35, hurry: 0.05, onFinish: ['eyvallah'] },
});

export function createChatter({ level, seed, saved }) {
  const p = CHATTER[level] ?? CHATTER.kalfa;
  const rng = seededRng(saved ? saved.rng : `${seed}:chat`);
  const st = { seat: null, round: 0, spent: {}, ...(saved?.state ?? {}) }; // spent: slot -> true

  const say = (slot, chance, ids) => {
    const roll = rng.random();                      // always roll: the sequence depends only on events
    const pick = ids[rng.int(ids.length)];
    if (st.spent[slot] || roll >= chance) return null;
    st.spent[slot] = true;
    return pick;
  };

  return {
    /** A public event, reduced to { type, seat, round }. -> emote id or null. */
    chat({ type, seat, round } = {}) {
      switch (type) {
        case 'roundStart':
          st.round = round;
          if (round === 1) st.spent = {};             // a new match
          return round === 1 ? say(`r${round}`, p.start, ['luck']) : null;
        case 'finish':
          return seat !== st.seat ? say(`r${st.round}`, p.finish, p.onFinish) : null;
        case 'matchEnd':
          return say('end', p.end, ['gg']);
        default:
          return null;
      }
    },
    /** A human has been thinking for a while (the host decides when, online only). -> 'hadi' or null. */
    hurry() {
      return say(`r${st.round}`, p.hurry, ['hadi']);
    },
    setSeat(seat) { st.seat = seat; },
    snapshot() { return { rng: rng.state(), state: { ...st, spent: { ...st.spent } } }; },
  };
}
