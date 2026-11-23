// A bot's imperfect memory of the round, built ONLY from the events its seat receives.
//
// Each public fact is remembered with probability `memory` when it happens, and every remembered fact is
// forgotten with probability `decay` at the end of each turn (each discard). What is on top of the discard
// stacks and the indicator is not memory: it is on the table, in the view, and always counted.
//
// Facts kept (all per round):
//   gone:   tile id -> { seat, kind: 'dead' | 'held' }   discarded (dead unless picked up) or picked up / shown
//   picks:  per seat, faces it took from the discard stack on its left (what it collects)
//   throws: per seat, faces it discarded (what it does not need)
//   passed: per seat, faces it saw on top of its left stack and did not take
// The bot's own discards are remembered a little better (people remember what they threw).
// Variant-neutral: classic `draw` from the discard and 101 `take` / `undoTake` are both understood; a variant
// passes any other face-up tiles (101 table melds) to liveTable.

import { faceIndex, WILD } from './faces.js';

const OWN_BONUS = 0.5;   // own discards: memory + (1 - memory) * OWN_BONUS

export class Memory {
  constructor(params, rng, saved) {
    this.p = params;
    this.rng = rng;
    this.reset(saved);
  }

  reset(saved) {
    this.you = saved?.you ?? null;
    this.gone = new Map(saved?.gone ?? []);
    this.picks = saved?.picks?.map((a) => a.slice()) ?? [[], [], [], []];
    this.throws = saved?.throws?.map((a) => a.slice()) ?? [[], [], [], []];
    this.passed = saved?.passed?.map((a) => a.slice()) ?? [[], [], [], []];
    this.tops = saved?.tops?.slice() ?? [null, null, null, null]; // perceived, not remembered
    this.turns = saved?.turns ?? 0;
  }

  snapshot() {
    return {
      you: this.you, gone: [...this.gone], picks: this.picks, throws: this.throws,
      passed: this.passed, tops: this.tops, turns: this.turns,
    };
  }

  // Seat and stack tops come from the view (what is on the table right now), not from memory.
  see(view) {
    this.you = view.you;
    for (let s = 0; s < 4; s++) this.tops[s] = view.seats[s].discard.top;
  }

  remember(own) {
    const m = this.p.memory;
    return this.rng.chance(own ? m + (1 - m) * OWN_BONUS : m);
  }

  observe(e) {
    switch (e.type) {
      case 'roundStart': {
        const you = this.you;
        this.reset();
        this.you = you;
        break;
      }
      case 'dealt':
        if (typeof e.to === 'number') this.you = e.to;
        break;
      case 'discard': {
        const own = e.seat === this.you;
        if (this.remember(own)) {
          this.gone.set(e.tile, { seat: e.seat, kind: 'dead' });
          if (!own) this.throws[e.seat].push(e.tile);
        }
        this.tops[e.seat] = e.tile;
        this.endTurn();
        break;
      }
      case 'take':                                  // 101: taking the discard is its own event
        this.observe({ type: 'draw', seat: e.seat, from: 'discard', tile: e.tile });
        break;
      case 'undoTake': {                            // 101: the take went back on the stack
        const left = (e.seat + 3) % 4;
        if (this.gone.get(e.tile)?.kind === 'held') this.gone.delete(e.tile);
        const picks = this.picks[e.seat];
        const i = picks.lastIndexOf(e.tile);
        if (i >= 0) picks.splice(i, 1);
        this.tops[left] = e.tile;
        break;
      }
      case 'draw': {
        const left = (e.seat + 3) % 4;
        if (e.seat === this.you) break;            // own hand is in the view
        if (e.from === 'discard' && e.tile != null) {
          if (this.remember(false)) {
            this.gone.set(e.tile, { seat: e.seat, kind: 'held' });
            this.picks[e.seat].push(e.tile);
          }
          this.tops[left] = null;                   // the tile below is unknown to the event stream
        } else if (e.from === 'pile' && this.tops[left] != null) {
          // It saw the top of its left stack and did not want it.
          if (this.remember(left === this.you)) this.passed[e.seat].push(this.tops[left]);
        }
        break;
      }
      case 'showIndicator':
        if (e.seat !== this.you && this.remember(true)) this.gone.set(e.tile, { seat: e.seat, kind: 'held' });
        break;
      default:
        break;
    }
  }

  endTurn() {
    this.turns++;
    const d = this.p.decay;
    if (d <= 0) return;
    for (const id of [...this.gone.keys()]) if (this.rng.chance(d)) this.gone.delete(id);
    for (const list of [this.picks, this.throws, this.passed]) {
      for (let s = 0; s < 4; s++) {
        const a = list[s];
        for (let i = a.length - 1; i >= 0; i--) if (this.rng.chance(d)) a.splice(i, 1);
      }
    }
  }

  // live[f]: copies of face f the bot believes may still come its way (0..2).
  // hand: own tile ids; view: its seat's view (tops of the four stacks, indicator); visible: other face-up ids.
  liveTable(hand, view, visible = []) {
    const okey = view.round.okey;
    const goneCount = new Int8Array(53);
    const seen = new Set();
    const count = (id) => {
      if (id == null || seen.has(id)) return;
      seen.add(id);
      goneCount[faceIndex(id, okey)]++;
    };
    for (const id of hand) count(id);
    count(view.round.indicator);
    const seats = view.seats;
    for (let s = 0; s < 4; s++) count(seats[s].discard.top);
    for (const id of visible) count(id);          // e.g. 101 table melds
    for (const id of this.gone.keys()) count(id);
    const live = new Int8Array(52);
    for (let f = 0; f < 52; f++) live[f] = Math.max(0, 2 - goneCount[f]);
    return live;
  }

  facesOf(ids, okey) {
    const out = [];
    for (const id of ids) {
      const f = faceIndex(id, okey);
      if (f !== WILD) out.push(f);
    }
    return out;
  }
}
