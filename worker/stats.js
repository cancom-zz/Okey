// Stats: player statistics and achievements (DESIGN.md "Statistics and achievements"), one SQLite-backed
// Durable Object for everyone. Only Room objects write (record), from server-side round/match summaries,
// so results can't be faked. A player id is claimed by the first secret recorded for it; summaries that
// carry another secret for that id are ignored.
//
//   players       (id, secret, name, stats JSON, updated)
//   achievements  (id, achievement, at)
import { DurableObject } from 'cloudflare:workers';

export const ACHIEVEMENTS = ['ilk_zafer', 'okey_atan', 'ciftci', 'cifte_okey', 'gostergeci', 'seri_5',
  'usta_avcisi', 'hizli_el', 'yuz_el', 'dost_masasi'];
const LEVELS = ['cirak', 'kalfa', 'usta', 'uzman'];

export const emptyStats = () => ({
  matchesPlayed: 0, matchesWon: 0, roundsPlayed: 0, roundsWon: 0,
  finishes: { normal: 0, pairs: 0, okey: 0, pairsOkey: 0 },
  indicators: 0, fastestFinish: null, streak: 0, bestStreak: 0,
  winsVsBot: { cirak: 0, kalfa: 0, usta: 0, uzman: 0 },
  pointsLost: 0, humanMatches: 0,
});

/** Apply one summary (from TableHost onResult) to one seat's stats. Returns achievements newly earned. */
export function applySummary(stats, summary, seat) {
  const me = summary.seats[seat];
  const others = summary.seats.filter((s) => s.seat !== seat);
  const earned = [];
  if (summary.type === 'round') {
    stats.roundsPlayed += 1;
    stats.pointsLost += Math.max(0, -(me.delta || 0));
    if (me.showedIndicator) stats.indicators += 1;
    if (me.won) {
      stats.roundsWon += 1;
      const key = me.finish === 'pairs' ? (me.okeyFinish ? 'pairsOkey' : 'pairs') : me.okeyFinish ? 'okey' : 'normal';
      stats.finishes[key] += 1;
      if (Number.isInteger(me.turns) && me.turns > 0) {
        stats.fastestFinish = stats.fastestFinish === null ? me.turns : Math.min(stats.fastestFinish, me.turns);
        if (me.turns <= 5) earned.push('hizli_el');
      }
      if (key === 'okey' || key === 'pairsOkey') earned.push('okey_atan');
      if (key === 'pairs' || key === 'pairsOkey') earned.push('ciftci');
      if (key === 'pairsOkey') earned.push('cifte_okey');
    }
    if (stats.indicators >= 10) earned.push('gostergeci');
    if (stats.roundsPlayed >= 100) earned.push('yuz_el');
  } else if (summary.type === 'match') {
    stats.matchesPlayed += 1;
    const humans = others.every((s) => s.kind === 'human');
    if (humans) {
      stats.humanMatches += 1;
      earned.push('dost_masasi');
    }
    if (me.won) {
      stats.matchesWon += 1;
      stats.streak += 1;
      stats.bestStreak = Math.max(stats.bestStreak, stats.streak);
      for (const level of new Set(others.filter((s) => s.kind === 'bot').map((s) => s.botLevel))) {
        if (LEVELS.includes(level)) stats.winsVsBot[level] += 1;
      }
      earned.push('ilk_zafer');
      if (stats.streak >= 5) earned.push('seri_5');
      if (others.every((s) => s.kind === 'bot' && s.botLevel === 'uzman')) earned.push('usta_avcisi');
    } else stats.streak = 0;
  }
  return earned;
}

export class Stats extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS players (id TEXT PRIMARY KEY, secret TEXT NOT NULL, name TEXT,
      stats TEXT NOT NULL, updated INTEGER)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS achievements (id TEXT NOT NULL, achievement TEXT NOT NULL,
      at INTEGER NOT NULL, PRIMARY KEY (id, achievement))`);
  }

  /** A round or match summary from a Room (TableHost onResult). */
  record(summary) {
    if (!summary || !Array.isArray(summary.seats) || (summary.type !== 'round' && summary.type !== 'match')) return { ok: false };
    const now = Date.now();
    for (const s of summary.seats) {
      if (s.kind !== 'human' || typeof s.playerId !== 'string' || typeof s.secret !== 'string') continue;
      const row = this.sql.exec(`SELECT secret, stats FROM players WHERE id = ?`, s.playerId).toArray()[0];
      if (row && row.secret !== s.secret) continue; // someone else's id
      const stats = { ...emptyStats(), ...(row ? JSON.parse(row.stats) : {}) };
      const earned = applySummary(stats, summary, s.seat);
      this.sql.exec(`INSERT INTO players (id, secret, name, stats, updated) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET name = excluded.name, stats = excluded.stats, updated = excluded.updated`,
      s.playerId, s.secret, String(s.name ?? '').slice(0, 40), JSON.stringify(stats), now);
      for (const a of earned) {
        this.sql.exec(`INSERT OR IGNORE INTO achievements (id, achievement, at) VALUES (?, ?, ?)`, s.playerId, a, now);
      }
    }
    return { ok: true };
  }

  /** One player's stats and achievements (public: no secret), or null. */
  get(playerId) {
    const row = this.sql.exec(`SELECT name, stats FROM players WHERE id = ?`, playerId).toArray()[0];
    if (!row) return null;
    const achievements = this.sql.exec(`SELECT achievement, at FROM achievements WHERE id = ? ORDER BY at`, playerId)
      .toArray().map((r) => ({ id: r.achievement, at: r.at }));
    return { name: row.name, stats: { ...emptyStats(), ...JSON.parse(row.stats) }, achievements };
  }
}
