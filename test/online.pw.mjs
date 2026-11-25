// Playwright, online end to end against `npx wrangler dev` (the real Worker, Room and Stats Durable Objects):
//   node test/online.pw.mjs            (about 3 minutes; set PORT to choose the dev server's port)
//
// Two browser contexts open one room by link; the host adds two bots and starts. Classic: both humans play a
// whole round through the UI. 101: a short stretch. Every WebSocket frame either page receives is checked:
// views with the same version agree on everything public, the two humans' hands never share a tile, and no
// tile a page could not legitimately see reaches it. Then: the server recorded the round (POST /api/stats with
// id + secret; wrong secret 403), the Stats sheet renders, a transfer code moves the identity to a third
// context, a foreign Origin is refused, and the CSP from site/_headers holds (no console errors).
//
// wrangler dev runs on a copy of the project in a temp dir, so edits made while the test runs (live reload)
// can't restart the Durable Objects under it.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)('playwright');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = +process.env.PORT || 8900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const CLASSIC_MS = +process.env.CLASSIC_MS || 240_000;
const M101_MS = +process.env.M101_MS || 45_000;

const failures = [];
const fail = (msg) => { failures.push(msg); console.log('  ✗ ' + msg); };
const ok = (msg) => console.log('  ✓ ' + msg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- wrangler dev on a copy ----
const dir = mkdtempSync(join(tmpdir(), 'okey-e2e-'));
for (const f of ['site', 'worker', 'wrangler.jsonc', 'package.json']) cpSync(join(ROOT, f), join(dir, f), { recursive: true });
symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'));
const dev = spawn(join(ROOT, 'node_modules', '.bin', 'wrangler'), ['dev', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', join(dir, '.state')], {
  cwd: dir, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'],
});
let devLog = '';
dev.stdout.on('data', (d) => { devLog += d; });
dev.stderr.on('data', (d) => { devLog += d; });
const stop = () => { try { dev.kill('SIGTERM'); } catch { /* gone */ } rmSync(dir, { recursive: true, force: true }); };
process.on('exit', stop);
for (let i = 0; i < 120; i++) {
  if (/Ready on/.test(devLog)) break;
  if (dev.exitCode !== null) { console.log(devLog); throw new Error('wrangler dev exited'); }
  await sleep(500);
}
if (!/Ready on/.test(devLog)) { console.log(devLog); throw new Error('wrangler dev did not start'); }
ok(`wrangler dev on ${BASE}`);

// ---- browser ----
const browser = await chromium.launch();
const profile = (n) => ({ name: 'Oyuncu' + n, avatar: '🦊', id: `e2e-device-${n}-${Date.now()}`, secret: `e2e-secret-${n}-${Math.random().toString(36).slice(2, 12)}`, tip: { play: 0, at: 0, next: 0, went: 0, done: true } });

async function player(n, w = 390, h = 700) {
  const prof = profile(n);
  const ctx = await browser.newContext({ viewport: { width: w, height: h } });
  const p = await ctx.newPage();
  p.prof = prof;
  p.errors = [];
  p.frames = [];
  p.on('pageerror', (e) => p.errors.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) p.errors.push(m.text()); });
  p.on('websocket', (ws) => ws.on('framereceived', (f) => { try { p.frames.push(JSON.parse(f.payload)); } catch { /* not json */ } }));
  await p.addInitScript((pr) => {
    if (!localStorage.getItem('okey.v1')) localStorage.setItem('okey.v1', JSON.stringify(pr));
    localStorage.setItem('okey.guide.v1', JSON.stringify({ classic: true, 101: true })); // first-time guides seen
  }, prof);
  return p;
}

// ---- checks on the frames ----
const NON_TILE = new Set(['v', 'now', 'number', 'round', 'dealer', 'turn', 'pileCount', 'turnEndsAt', 'count', 'handCount', 'score',
  'scores', 'deltas', 'seat', 'to', 'except', 'winner', 'winners', 'host', 'you', 'color', 'num', 'turnSeconds', 'rounds',
  'startPoints', 'turns', 'owner', 'start', 'index', 'meld', 'value', 'pairs', 'points', 'penalties', 'multiplier', 'required',
  'openingValue', 'minPairs', 'aceHighValue', 'id']);
const tilesIn = (x, key, out = []) => {
  if (typeof x === 'number') { if (!NON_TILE.has(key)) out.push(x); } else if (Array.isArray(x)) x.forEach((y) => tilesIn(y, key, out));
  else if (x && typeof x === 'object') for (const [k, y] of Object.entries(x)) { if (!['settings', 'scoring', 'opening', 'openings'].includes(k)) tilesIn(y, k, out); }
  return out;
};
/** Per page: every tile in a frame must be in its hand, already public, or privately its own. Returns views by v. */
function checkFrames(p, label) {
  const byV = new Map();
  const tilesAt = new Map();
  let pub = new Set();
  let n = 0;
  for (const f of p.frames) {
    if (f.t !== 'view') continue;
    const v = f.view;
    for (const e of f.events || []) {
      if (e.type === 'roundStart') pub = new Set([e.indicator]);
      if (e.to !== undefined && e.to !== v.you) fail(`${label}: got another seat's private event ${e.type}`);
      if (e.type === 'dealt' && e.to !== v.you) fail(`${label}: a deal that is not its own`);
      if (e.type === 'draw' && e.from === 'pile' && 'tile' in e && e.to !== v.you) fail(`${label}: a pile draw showing its tile`);
      if (e.to === undefined) for (const t of tilesIn(e)) if (e.type !== 'finish' && e.type !== 'pileEmpty') pub.add(t);
    }
    if (v.phase === 'playing' && v.round) {
      pub.add(v.round.indicator);
      v.seats.forEach((s) => { if (s.discard.top !== null) pub.add(s.discard.top); });
      (v.round.table || []).forEach((m) => m.tiles.forEach((t) => pub.add(t)));
      if (v.round.taken !== null && v.round.taken !== undefined) pub.add(v.round.taken);
      const mine = new Set(v.hand || []);
      for (const e of f.events || []) if (e.to === v.you) for (const t of tilesIn(e)) mine.add(t); // dealt / own pile draw
      for (const t of tilesIn(f)) { n++; if (!mine.has(t) && !pub.has(t)) fail(`${label}: tile ${t} is neither public nor its own (v ${v.v})`); }
      if (v.hand && v.seats[v.you].handCount !== v.hand.length) fail(`${label}: handCount ${v.seats[v.you].handCount} != hand ${v.hand.length}`);
      if (v.result !== null) fail(`${label}: a result while playing`);
    }
    byV.set(v.v, v);
    tilesAt.set(v.v, { tiles: tilesIn(f), pub: new Set(pub) });
  }
  return { byV, n, tilesAt };
}
function crossCheck(a, b, label) {
  const A = checkFrames(a, label + ' A'), B = checkFrames(b, label + ' B');
  let same = 0;
  for (const [v, va] of A.byV) {
    const vb = B.byV.get(v);
    if (!vb || va.phase !== 'playing' || vb.phase !== 'playing') continue;
    same++;
    const pubOf = (x) => JSON.stringify({ seats: x.seats.map((s) => [s.kind, s.score, s.handCount, s.discard, s.away]), round: { ...x.round, turnEndsAt: 0 } });
    if (pubOf(va) !== pubOf(vb)) fail(`${label}: views ${v} disagree on public state`);
    const inter = (va.hand || []).filter((t) => (vb.hand || []).includes(t));
    if (inter.length) fail(`${label}: both hands hold ${inter} at v ${v}`);
    // what one page received at v never includes the other's hidden tiles (hidden = not public by then)
    for (const [X, Y, n] of [[A, vb, 'A'], [B, va, 'B']]) {
      const at = X.tilesAt.get(v);
      for (const t of at.tiles) if ((Y.hand || []).includes(t) && !at.pub.has(t)) fail(`${label}: page ${n} got the other's hidden tile ${t} at v ${v}`);
    }
  }
  if (same < 10) fail(`${label}: only ${same} common views to compare`); else ok(`${label}: ${same} common views agree, hands disjoint; ${A.n + B.n} tiles checked`);
}

// ---- play through the UI ----
async function playUI(p, ms, until) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const s = await p.evaluate(() => {
      const f = document.querySelector('.felt'), v = window.__okey.view();
      return { draw: !!f && f.classList.contains('can-draw'), discard: !!f && f.classList.contains('can-discard'),
        confirm: !!document.querySelector('#cYes'), tip: !!document.querySelector('#tiplater'), phase: v && v.phase };
    });
    if (until(s)) return s;
    if (s.tip) await p.click('#tiplater').catch(() => {});
    if (s.confirm) await p.click('#cYes').catch(() => {});
    else if (s.draw) await p.click('#pile').catch(() => {});
    else if (s.discard) {
      const tiles = await p.$$('.rack .rt:not(.gone)');
      if (tiles.length) await tiles[tiles.length - 1].dblclick().catch(() => {});
    }
    await sleep(s.draw || s.discard ? 350 : 700);
  }
  return null;
}

async function openRoom(a, b, variant) {
  const code = await a.evaluate(async () => (await (await fetch('/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json()).code);
  if (!/^[A-Z2-9]{6}$/.test(code || '')) throw new Error('no room code');
  await a.goto(`${BASE}/?anim=0#/m/${code}`);
  await a.waitForSelector('#lStart');
  await b.goto(`${BASE}/?anim=0#/m/${code}`);
  await b.waitForFunction(() => { const v = window.__okey.view(); return v && v.you !== null && v.you !== undefined; });
  for (let k = 0; k < 2; k++) {
    await a.click('.spot.empty.act[data-a="bot"]');
    await a.click('#bAdd');
    await a.waitForFunction((n) => window.__okey.view().seats.filter((s) => s.kind === 'bot').length === n, k + 1);
  }
  await a.click('#lTurn button[data-v="15"]');
  if (variant === '101') {
    await a.click('#lVar button[data-v="101"]');
    await a.waitForFunction(() => window.__okey.view().settings.variant === '101');
  }
  await a.waitForSelector('#lStart:not([disabled])');
  await a.click('#lStart');
  await a.waitForFunction(() => window.__okey.view().phase === 'playing');
  return code;
}

try {
  const a = await player(1), b = await player(2);
  await a.goto(`${BASE}/?anim=0#/`);

  // ---- classic: a whole round ----
  const code = await openRoom(a, b, 'classic');
  ok(`classic room ${code}: host + guest seated, two bots, started`);
  const both = (s) => s.phase === 'roundEnd' || s.phase === 'matchEnd';
  const [ra, rb] = await Promise.all([playUI(a, CLASSIC_MS, both), playUI(b, CLASSIC_MS, both)]);
  if (!ra || !rb) fail('classic: the round did not end in time'); else ok('classic: both humans played the round to its end');
  crossCheck(a, b, 'classic');
  const end = await a.evaluate(() => window.__okey.view());
  if (!end.result || !Array.isArray(end.result.hands)) fail('classic: no result with revealed hands at round end');

  // ---- the server recorded it ----
  await sleep(2500);
  const st = await a.evaluate(async (pr) => {
    const r = await fetch('/api/stats', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: pr.id, secret: pr.secret }) });
    const bad = await fetch('/api/stats', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: pr.id, secret: 'wrong-secret-123' }) });
    const get = await fetch('/api/stats/' + pr.id);
    return { status: r.status, data: await r.json(), bad: bad.status, get: get.status };
  }, a.prof);
  if (st.status === 200 && st.data.stats.classic.rounds >= 1) ok(`stats: the server recorded the round (classic rounds ${st.data.stats.classic.rounds})`);
  else fail(`stats: not recorded (${st.status} ${JSON.stringify(st.data).slice(0, 200)})`);
  if (st.bad === 403) ok('stats: a wrong secret is refused'); else fail(`stats: wrong secret gave ${st.bad}`);
  if (st.get !== 200) ok('stats: no GET by id'); else fail('stats: GET by id answered');

  // ---- the Stats sheet (from the home screen: the next round may already be dealt at the table) ----
  await a.goto(`${BASE}/?anim=0#/`);
  await a.click('#tStats');
  await a.waitForSelector('.sheet.stats .achp .ac');
  await a.click('#stScope button[data-v="online"]');
  await a.waitForFunction(() => /\d/.test(document.querySelector('#stBody .kv')?.textContent || ''));
  const achCount = await a.$$eval('.sheet.stats .achp .ac', (els) => els.length);
  if (achCount >= 10) ok(`stats sheet: online tab with ${achCount} achievements and progress`); else fail(`stats sheet: ${achCount} achievements`);
  await a.click('#stVar button[data-v="101"]');
  await a.waitForSelector('.achp .ac[data-ach="yuzbir"]');
  await a.click('#mx');

  // ---- transfer the identity to a third device ----
  const c = await player(3);
  await c.goto(`${BASE}/?anim=0#/`);
  await a.click('#tStats');
  await a.click('#stMove');
  await a.click('#trMake');
  const shown = await (await a.waitForSelector('#trShown')).textContent();
  await a.click('#mx');
  await c.click('#tStats');
  await c.click('#stMove');
  await c.fill('#trCode', shown.toLowerCase());
  await c.click('#trClaim');
  await c.click('#cYes');
  await c.waitForFunction((id) => JSON.parse(localStorage.getItem('okey.v1')).id === id, a.prof.id);
  const moved = await c.evaluate(() => JSON.parse(localStorage.getItem('okey.v1')));
  if (moved.secret === a.prof.secret && moved.name === a.prof.name) ok(`transfer: code ${shown} moved the identity`); else fail('transfer: identity not adopted');
  const again = await c.evaluate(async (code) => (await fetch('/api/transfer/claim', { method: 'POST', body: JSON.stringify({ code }) })).status, shown);
  if (again === 404) ok('transfer: a code works once'); else fail(`transfer: reused code gave ${again}`);

  // ---- origin check ----
  const foreign = await fetch(`${BASE}/api/rooms`, { method: 'POST', headers: { Origin: 'https://evil.example', 'content-type': 'application/json' }, body: '{}' });
  if (foreign.status === 403) ok('origin: a foreign Origin is refused'); else fail(`origin: foreign Origin gave ${foreign.status}`);
  const hdr = await fetch(`${BASE}/`);
  const csp = hdr.headers.get('content-security-policy') || '';
  if (/script-src 'self'/.test(csp) && hdr.headers.get('x-content-type-options') === 'nosniff') ok('headers: CSP and nosniff on the site'); else fail(`headers: CSP missing (${csp})`);

  // ---- 101, briefly ----
  a.frames = []; b.frames = [];
  await a.goto(`${BASE}/?anim=0#/`);
  await b.goto(`${BASE}/?anim=0#/`);
  const code101 = await openRoom(a, b, '101');
  ok(`101 room ${code101}: started`);
  await Promise.all([playUI(a, M101_MS, () => false), playUI(b, M101_MS, () => false)]);
  const v101 = await a.evaluate(() => window.__okey.view());
  if (v101.settings.variant !== '101' || !v101.round || !Array.isArray(v101.round.table)) fail('101: not a 101 view');
  crossCheck(a, b, '101');

  // ---- solo practice: the host runs in a Web Worker; snapshots reach localStorage; a reload resumes ----
  const d = await player(4);
  await d.goto(`${BASE}/?anim=0#/`);
  await d.goto(`${BASE}/?anim=0#/solo`);
  await d.waitForFunction(() => { const v = window.__okey.view(); return v && v.phase === 'playing'; });
  const mode = await d.evaluate(() => globalThis.__okeyLocalMode);
  if (mode === 'worker') ok('solo: the table runs in a Web Worker'); else fail(`solo: mode ${mode}`);
  await playUI(d, 12_000, () => false);
  const saved = await d.evaluate(() => JSON.parse(localStorage.getItem('okey.solo') || 'null'));
  if (saved && saved.host && saved.host.match) ok('solo: the worker\'s snapshots are saved in localStorage'); else fail('solo: no saved snapshot');
  const before = await d.evaluate(() => window.__okey.view());
  await d.reload();
  await d.waitForFunction(() => { const v = window.__okey.view(); return v && v.phase === 'playing'; });
  const after = await d.evaluate(() => window.__okey.view());
  const sameHand = JSON.stringify([...after.hand].sort()) === JSON.stringify([...before.hand].sort()) || after.v > before.v;
  if (after.round.number === before.round.number && sameHand) ok('solo: a reload continues the table'); else fail('solo: reload did not resume');
  // practice stats: a summary from the solo table is recorded with the shared rules and toasts the unlock
  const rec = await d.evaluate(async () => {
    const m = await import('/js/stats.js');
    const seat = (i, o) => ({ seat: i, kind: 'bot', playerId: null, botLevel: 'uzman', won: false, finish: null, okeyFinish: false, delta: -4, score: 16, turns: 6, showedIndicator: false, ...o });
    const unlocked = m.recordPractice({ type: 'round', variant: 'classic', winner: 0, seats: [seat(0, { kind: 'human', playerId: 'solo-player', botLevel: null, won: true, finish: 'sets', okeyFinish: true, delta: 0, turns: 4 }), seat(1), seat(2), seat(3)] });
    await new Promise((r) => setTimeout(r, 3000));
    return { unlocked, st: JSON.parse(localStorage.getItem('okey.v1')).stats, toast: document.querySelector('.toast.ach')?.textContent || '' };
  });
  if (rec.st.practice.classic.roundsWon >= 1 && rec.st.practiceAch.okey_atan && rec.unlocked.includes('okey_atan')) ok(`practice stats: recorded, unlocked ${rec.unlocked.join(', ')}`);
  else fail('practice stats: not recorded');
  if (/Başarım açıldı|Achievement unlocked/.test(rec.toast) && /İlk Zafer|First Win/.test(rec.toast)) ok('practice stats: unlock toast shown'); else fail(`practice stats: no unlock toast (${rec.toast})`);

  // a worker that can't load: the table falls back to the page
  const e = await player(5);
  await e.route('**/local-worker.js', (r) => r.abort());
  await e.goto(`${BASE}/?anim=0#/`);
  await e.goto(`${BASE}/?anim=0#/solo`);
  await e.waitForFunction(() => { const v = window.__okey.view(); return v && v.phase === 'playing'; }, null, { timeout: 15_000 });
  const fb = await e.evaluate(() => globalThis.__okeyLocalMode);
  if (fb === 'page') ok('solo: without the worker it runs in the page'); else fail(`solo fallback: mode ${fb}`);

  for (const [p, n] of [[a, 'A'], [b, 'B'], [c, 'C'], [d, 'D']]) {
    if (p.errors.length) fail(`page ${n} errors: ${p.errors.slice(0, 3).join(' | ')}`); else ok(`page ${n}: no errors (CSP included)`);
  }
} catch (e) {
  fail('crashed: ' + (e && e.stack || e));
  console.log(devLog.split('\n').slice(-30).join('\n'));
} finally {
  await browser.close();
  stop();
}
console.log(failures.length ? `\n${failures.length} failure(s)` : '\nall good');
process.exit(failures.length ? 1 : 0);
