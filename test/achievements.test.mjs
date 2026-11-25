// Statistics and achievements (site/shared/achievements.js): the same rules for practice and online.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyStats, applySummary, progress, unlockedIds, sanitizeStats, derived, ACHIEVEMENTS, ACHIEVEMENT_IDS, VARIANTS,
} from '../site/shared/achievements.js';
import { TableHost } from '../site/shared/host.js';
import { seededRng } from '../site/shared/okey/index.js';
import tr from '../site/i18n/tr.js';
import en from '../site/i18n/en.js';

const seat = (i, o = {}) => ({ seat: i, kind: 'bot', playerId: null, botLevel: 'kalfa', won: false, finish: null, okeyFinish: false, delta: 0, score: 20, turns: 8, showedIndicator: false, ...o });
const round = (variant, seats, extra = {}) => ({ type: 'round', variant, winner: seats.findIndex((s) => s.won), seats, ...extra });
const me = (o) => seat(0, { kind: 'human', playerId: 'p1', botLevel: null, ...o });

test('every achievement has Turkish and English names and descriptions', () => {
  for (const id of ACHIEVEMENT_IDS) {
    for (const [lang, table] of [['tr', tr], ['en', en]]) {
      assert.ok(table['ach.' + id], `${lang} ach.${id}`);
      assert.ok(table['achd.' + id], `${lang} achd.${id}`);
    }
  }
  assert.equal(new Set(ACHIEVEMENT_IDS).size, ACHIEVEMENT_IDS.length);
});

test('classic round and match summaries update stats and unlock achievements', () => {
  let st = emptyStats();
  assert.equal(unlockedIds(st).size, 0);
  let r = applySummary(st, round('classic', [me({ won: true, finish: 'pairs', okeyFinish: true, turns: 4, showedIndicator: true }), seat(1, { delta: -8 }), seat(2, { delta: -8 }), seat(3, { delta: -8 })]), 0);
  st = r.stats;
  assert.deepEqual(r.unlocked.sort(), ['ciftci', 'cifte_okey', 'hizli_el', 'ilk_zafer', 'okey_atan']);
  assert.equal(st.classic.rounds, 1);
  assert.equal(st.classic.finishes.pairsOkey, 1);
  assert.equal(st.classic.indicators, 1);
  assert.equal(st.classic.fastestFinish, 4);
  assert.equal(st.classic.streak, 1);
  assert.equal(st['101'].rounds, 0, 'variants are kept apart');
  // somebody else finishes: streak over, points lost
  r = applySummary(st, round('classic', [me({ delta: -2 }), seat(1, { won: true, finish: 'sets' }), seat(2), seat(3)]), 0);
  assert.equal(r.stats.classic.streak, 0);
  assert.equal(r.stats.classic.pointsLost, 2);
  assert.deepEqual(r.unlocked, []);
  // a pile-exhausted round keeps the streak
  const pile = applySummary(st, { type: 'round', variant: 'classic', winner: null, seats: [me({}), seat(1), seat(2), seat(3)] }, 0);
  assert.equal(pile.stats.classic.streak, 1);
  // a match won against three experts
  const m = applySummary(st, { type: 'match', variant: 'classic', winners: [0], seats: [me({ won: true }), seat(1, { botLevel: 'uzman' }), seat(2, { botLevel: 'uzman' }), seat(3, { botLevel: 'uzman' })] }, 0);
  assert.deepEqual(m.unlocked, ['usta_avcisi']);
  assert.equal(m.stats.classic.winsVsBot.uzman, 1);
  assert.equal(m.stats.classic.matchesWon, 1);
  // three other humans
  const f = applySummary(st, { type: 'match', variant: 'classic', winners: [1], seats: [me({}), seat(1, { kind: 'human' }), seat(2, { kind: 'human' }), seat(3, { kind: 'human' })] }, 0);
  assert.deepEqual(f.unlocked, ['dost_masasi']);
  assert.equal(f.stats.classic.matchStreak, 0);
  assert.equal(st.classic.matches, 0, 'applySummary does not change its input');
});

test('101: openings, işlek penalties, elden, clean rounds, the 150 opening', () => {
  let st = emptyStats();
  const r1 = applySummary(st, round('101', [me({ won: true, finish: 'sets', elden: true, opened: 'sets', openingValue: 156, delta: -404, turns: 9 }), seat(1, { delta: 202 }), seat(2, { delta: 60 }), seat(3, { delta: 40 })], { elden: true, multiplier: 4 }), 0);
  st = r1.stats;
  assert.deepEqual(r1.unlocked.sort(), ['elden', 'ilk_zafer', 'yuzbir']);
  const s = st['101'];
  assert.equal(s.openings, 1);
  assert.equal(s.setsOpenings, 1);
  assert.equal(s.bestOpening, 156);
  assert.equal(s.elden, 1);
  assert.equal(s.cleanRounds, 1);
  assert.equal(s.penaltyPoints, 0);
  const r2 = applySummary(st, round('101', [me({ opened: 'pairs', openingPairs: 6, islek: 2, islekPoints: 202, delta: 260 }), seat(1, { won: true, finish: 'sets' }), seat(2), seat(3)]), 0);
  const s2 = r2.stats['101'];
  assert.deepEqual(r2.unlocked, ['cift_acan']);
  assert.equal(s2.pairsOpenings, 1);
  assert.equal(s2.islek, 2);
  assert.equal(s2.islekPoints, 202);
  assert.equal(s2.cleanRounds, 1, 'an işlek penalty is not a clean round');
  assert.equal(s2.penaltyPoints, 260);
  const d = derived(r2.stats, '101');
  assert.equal(d.avgOpening, 156);
  assert.equal(d.avgPenalty, 130);
  assert.equal(d.openRate, 1);
  const pr = progress(r2.stats).find((p) => p.id === 'temiz_masa');
  assert.deepEqual(pr, { id: 'temiz_masa', variant: '101', goal: 10, value: 1, done: false });
  assert.equal(progress(r2.stats).find((p) => p.id === 'yuzbir').value, 150, 'progress is capped at the goal');
});

test('sanitizeStats cleans untrusted data', () => {
  const clean = sanitizeStats({ classic: { rounds: 5, roundsWon: -3, finishes: { okey: 2.7, evil: 9 }, fastestFinish: 'x', extra: 1, winsVsBot: { uzman: 1e20 } }, '101': 'nope', __proto__: { x: 1 } });
  assert.equal(clean.classic.rounds, 5);
  assert.equal(clean.classic.roundsWon, 0);
  assert.equal(clean.classic.finishes.okey, 2);
  assert.equal(clean.classic.finishes.evil, undefined);
  assert.equal(clean.classic.fastestFinish, null);
  assert.equal(clean.classic.extra, undefined);
  assert.equal(clean.classic.winsVsBot.uzman, 1e9);
  assert.deepEqual(clean['101'], emptyStats()['101']);
  assert.deepEqual(sanitizeStats(null), emptyStats());
  assert.deepEqual(sanitizeStats(JSON.parse(JSON.stringify(clean))), clean, 'idempotent');
});

for (const variant of VARIANTS) {
  test(`${variant}: real TableHost summaries add up for every seat`, () => {
    let t = 1.8e12;
    let wakeAt = null;
    const results = [];
    const host = new TableHost({
      code: 'STATS1', settings: variant === '101' ? { variant, rounds: 3, turnSeconds: 10 } : { rounds: 3, turnSeconds: 10 },
      rng: seededRng(variant === '101' ? 12 : 21), now: () => t, schedule: (a) => { wakeAt = a; }, send: () => {},
      onResult: (s) => results.push(JSON.parse(JSON.stringify(s))),
    });
    host.connect('c');
    host.message('c', { t: 'hello', player: { id: 'stats-player', secret: 'stats-secret', name: 'S', avatar: '🦊' } });
    host.message('c', { t: 'sit', seat: 0 });
    for (const s of [1, 2, 3]) host.message('c', { t: 'addBot', seat: s, level: ['cirak', 'usta', 'uzman'][s - 1] });
    host.message('c', { t: 'start' });
    for (let i = 0; i < 20000 && host.phase !== 'matchEnd'; i++) { t = Math.max(t, wakeAt); host.wake(); }
    assert.equal(host.phase, 'matchEnd');
    const stats = [0, 1, 2, 3].map((i) => results.reduce((st, r) => applySummary(st, r, i).stats, emptyStats()));
    const rounds = results.filter((r) => r.type === 'round');
    assert.equal(rounds.length, 3);
    for (const st of stats) {
      assert.equal(st[variant].rounds, 3);
      assert.equal(st[variant].matches, 1);
      const other = variant === '101' ? 'classic' : '101';
      assert.equal(st[other].rounds, 0);
    }
    const won = stats.reduce((a, st) => a + st[variant].roundsWon, 0);
    assert.equal(won, rounds.filter((r) => r.winner !== null).length);
    assert.equal(stats.reduce((a, st) => a + st[variant].matchesWon, 0), results.at(-1).winners.length);
    if (variant === '101') {
      // penalty points add up to the positive deltas of the rounds
      const pos = rounds.reduce((a, r) => a + r.seats.reduce((b, s) => b + Math.max(0, s.delta), 0), 0);
      assert.equal(stats.reduce((a, st) => a + st['101'].penaltyPoints, 0), pos);
      for (const r of rounds) for (const s of r.seats) assert.ok(s.opened === null || s.opened === 'sets' || s.opened === 'pairs');
    }
    for (const a of ACHIEVEMENTS) assert.ok(a.variant === null || VARIANTS.includes(a.variant));
  });
}
