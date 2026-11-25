// Statistics and achievements: one pure module shared by the Stats Durable Object (online, authoritative) and
// the client (solo practice, kept on the device). Same rules everywhere; see DESIGN.md "Statistics and
// achievements".
//
//   const stats = emptyStats();                      // { classic: {...}, '101': {...} }
//   const { stats: next, unlocked } = applySummary(stats, summary, seat);   // a TableHost onResult summary
//   progress(stats) -> [{ id, variant, value, goal, done }]                    // every achievement
//   unlockedIds(stats) -> Set                                                  // done ones
//   sanitizeStats(untrusted) -> stats                                          // localStorage, transfer codes
//
// Achievements are a pure function of the cumulative stats: what is unlocked is recomputed, never stored as
// a separate truth. Callers keep only the unlock time (id -> epoch ms) for display.

export const VARIANTS = ['classic', '101'];
export const LEVEL_IDS = ['cirak', 'kalfa', 'usta', 'uzman'];

const base = () => ({
  matches: 0, matchesWon: 0, rounds: 0, roundsWon: 0,
  streak: 0, bestStreak: 0,            // rounds won in a row
  matchStreak: 0, bestMatchStreak: 0,  // matches won in a row
  fastestFinish: null,                 // fewest own turns in a won round
  okeyFinishes: 0, pairsOkey: 0,
  winsVsBot: { cirak: 0, kalfa: 0, usta: 0, uzman: 0 }, // matches won at a table with that bot level
  beatExperts: 0,                      // matches won against three Uzman bots
  humanMatches: 0,                     // matches played with three other humans
});

export function emptyVariantStats(variant) {
  if (variant === '101') {
    return {
      ...base(),
      finishes: { sets: 0, pairs: 0 },
      elden: 0,
      openings: 0, setsOpenings: 0, pairsOpenings: 0,
      openingValueSum: 0,              // sets openings only (average = sum / setsOpenings)
      bestOpening: 0,
      islek: 0, islekPoints: 0,        // işlek penalties paid (count, points)
      penaltyPoints: 0,                // all points taken this variant (in-round penalties + round end)
      cleanRounds: 0,                  // rounds opened without paying an işlek penalty
    };
  }
  return {
    ...base(),
    finishes: { normal: 0, pairs: 0, okey: 0, pairsOkey: 0 },
    indicators: 0,
    pointsLost: 0,
  };
}

export const emptyStats = () => ({ classic: emptyVariantStats('classic'), 101: emptyVariantStats('101') });

const n0 = (x, max = 1e9) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? Math.min(max, Math.floor(x)) : 0);

/** Untrusted stats (localStorage, a transfer code, an old row) -> a clean stats object. */
export function sanitizeStats(raw) {
  const out = emptyStats();
  if (!raw || typeof raw !== 'object') return out;
  for (const v of VARIANTS) {
    const src = raw[v];
    if (!src || typeof src !== 'object') continue;
    const dst = out[v];
    for (const [k, def] of Object.entries(dst)) {
      if (k === 'fastestFinish') dst[k] = src[k] === null || src[k] === undefined ? null : n0(src[k], 999) || null;
      else if (def && typeof def === 'object') {
        for (const kk of Object.keys(def)) def[kk] = n0(src[k] && src[k][kk]);
      } else dst[k] = n0(src[k]);
    }
  }
  return out;
}

const clone = (x) => JSON.parse(JSON.stringify(x));

/**
 * Apply one TableHost onResult summary to the stats of the player in `seat`. Returns new stats (the input is
 * not changed) and the achievement ids that this summary unlocked.
 */
export function applySummary(stats, summary, seat) {
  const before = unlockedIds(stats);
  const next = clone(stats);
  const variant = summary && summary.variant === '101' ? '101' : 'classic';
  const st = next[variant];
  const me = summary && Array.isArray(summary.seats) ? summary.seats[seat] : null;
  if (!me) return { stats: next, unlocked: [] };
  const others = summary.seats.filter((s) => s.seat !== seat);

  if (summary.type === 'round') {
    st.rounds += 1;
    if (me.won) {
      st.roundsWon += 1;
      st.streak += 1;
      st.bestStreak = Math.max(st.bestStreak, st.streak);
      if (Number.isInteger(me.turns) && me.turns > 0) st.fastestFinish = st.fastestFinish === null ? me.turns : Math.min(st.fastestFinish, me.turns);
      if (me.okeyFinish) st.okeyFinishes += 1;
      if (me.okeyFinish && me.finish === 'pairs') st.pairsOkey += 1;
    } else if (summary.winner !== null && summary.winner !== undefined) {
      st.streak = 0; // somebody else finished (a pile-exhausted round keeps the streak)
    }
    if (variant === 'classic') {
      if (me.won) {
        const key = me.finish === 'pairs' ? (me.okeyFinish ? 'pairsOkey' : 'pairs') : me.okeyFinish ? 'okey' : 'normal';
        st.finishes[key] += 1;
      }
      if (me.showedIndicator) st.indicators += 1;
      st.pointsLost += Math.max(0, -(me.delta || 0));
    } else {
      if (me.won) {
        st.finishes[me.finish === 'pairs' ? 'pairs' : 'sets'] += 1;
        if (me.elden) st.elden += 1;
      }
      if (me.opened === 'sets' || me.opened === 'pairs') {
        st.openings += 1;
        if (me.opened === 'sets') {
          st.setsOpenings += 1;
          st.openingValueSum += n0(me.openingValue, 999);
          st.bestOpening = Math.max(st.bestOpening, n0(me.openingValue, 999));
        } else st.pairsOpenings += 1;
        if (!n0(me.islek)) st.cleanRounds += 1;
      }
      st.islek += n0(me.islek, 99);
      st.islekPoints += n0(me.islekPoints, 9999);
      st.penaltyPoints += Math.max(0, me.delta || 0);
    }
  } else if (summary.type === 'match') {
    st.matches += 1;
    if (others.length === 3 && others.every((s) => s.kind === 'human')) st.humanMatches += 1;
    if (me.won) {
      st.matchesWon += 1;
      st.matchStreak += 1;
      st.bestMatchStreak = Math.max(st.bestMatchStreak, st.matchStreak);
      for (const level of new Set(others.filter((s) => s.kind === 'bot').map((s) => s.botLevel))) {
        if (LEVEL_IDS.includes(level)) st.winsVsBot[level] += 1;
      }
      if (others.length === 3 && others.every((s) => s.kind === 'bot' && s.botLevel === 'uzman')) st.beatExperts += 1;
    } else st.matchStreak = 0;
  }
  const after = unlockedIds(next);
  return { stats: next, unlocked: [...after].filter((id) => !before.has(id)) };
}

// ---- achievements ----

const both = (st, f) => f(st.classic) + f(st['101']);
const best = (st, f) => Math.max(f(st.classic), f(st['101']));

/**
 * id, variant (null = either), goal, value(stats). Names and descriptions are i18n keys `ach.<id>` and
 * `achd.<id>` (the description may use {goal}).
 */
export const ACHIEVEMENTS = [
  { id: 'ilk_zafer', variant: null, goal: 1, value: (st) => both(st, (s) => s.roundsWon) },
  { id: 'okey_atan', variant: null, goal: 1, value: (st) => both(st, (s) => s.okeyFinishes) },
  { id: 'ciftci', variant: null, goal: 1, value: (st) => st.classic.finishes.pairs + st.classic.finishes.pairsOkey + st['101'].finishes.pairs },
  { id: 'cifte_okey', variant: null, goal: 1, value: (st) => both(st, (s) => s.pairsOkey) },
  { id: 'gostergeci', variant: 'classic', goal: 10, value: (st) => st.classic.indicators },
  { id: 'seri_5', variant: null, goal: 5, value: (st) => best(st, (s) => s.bestStreak) },
  { id: 'usta_avcisi', variant: null, goal: 1, value: (st) => both(st, (s) => s.beatExperts) },
  { id: 'hizli_el', variant: null, goal: 1, value: (st) => (VARIANTS.some((v) => st[v].fastestFinish !== null && st[v].fastestFinish <= 5) ? 1 : 0) },
  { id: 'yuz_el', variant: null, goal: 100, value: (st) => both(st, (s) => s.rounds) },
  { id: 'dost_masasi', variant: null, goal: 1, value: (st) => both(st, (s) => s.humanMatches) },
  { id: 'elden', variant: '101', goal: 1, value: (st) => st['101'].elden },
  { id: 'yuzbir', variant: '101', goal: 150, value: (st) => st['101'].bestOpening },
  { id: 'temiz_masa', variant: '101', goal: 10, value: (st) => st['101'].cleanRounds },
  { id: 'cift_acan', variant: '101', goal: 1, value: (st) => st['101'].pairsOpenings },
  { id: 'yuzbir_zafer', variant: '101', goal: 1, value: (st) => st['101'].matchesWon },
];
export const ACHIEVEMENT_IDS = ACHIEVEMENTS.map((a) => a.id);

export function progress(stats) {
  return ACHIEVEMENTS.map((a) => {
    const value = Math.max(0, a.value(stats) || 0);
    return { id: a.id, variant: a.variant, goal: a.goal, value: Math.min(value, a.goal), done: value >= a.goal };
  });
}

export const unlockedIds = (stats) => new Set(progress(stats).filter((p) => p.done).map((p) => p.id));

/** Averages and rates for display (null when there is nothing to average yet). */
export function derived(stats, variant) {
  const s = stats[variant];
  const avg = (a, b) => (b ? a / b : null);
  const out = { roundWinRate: avg(s.roundsWon, s.rounds), matchWinRate: avg(s.matchesWon, s.matches) };
  if (variant === '101') {
    out.avgOpening = avg(s.openingValueSum, s.setsOpenings);
    out.avgPenalty = avg(s.penaltyPoints, s.rounds);
    out.openRate = avg(s.openings, s.rounds);
  }
  return out;
}
