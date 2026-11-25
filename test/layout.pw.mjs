// Playwright: the client at phone, landscape-phone and laptop sizes, plus a full practice match end to end.
//   node test/layout.pw.mjs            (screenshots in test/shots/, gitignored)
// Fails on page scroll, on elements off screen, on page errors, or if the match doesn't reach its end.
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from './serve.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const SHOTS = join(dirname(fileURLToPath(import.meta.url)), 'shots');
const SIZES = [[390, 600], [375, 548], [844, 390], [1280, 800]];
const PORT = 8000 + Math.floor(Math.random() * 900);
const BASE = `http://localhost:${PORT}`;
const PROFILE = { name: 'Can', avatar: '🦊', id: 'pw-device-00000001', secret: 'pw-secret-00000001', tip: { play: 0, at: 0, next: 0, went: 0, done: true } };
const only = process.argv[2] || '';   // 'e2e' or 'layout' to run one part

const failures = [];
const fail = (msg) => { failures.push(msg); console.log('  ✗ ' + msg); };
const ok = (msg) => console.log('  ✓ ' + msg);

await mkdir(SHOTS, { recursive: true });
const server = await serve(PORT);
const browser = await chromium.launch();

async function page(w, h, { clock = false, profile = PROFILE } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  p.errors = [];
  p.on('pageerror', (e) => p.errors.push(e.message));
  p.on('console', (m) => { if (m.type() === 'error') p.errors.push(m.text()); });
  if (clock) await p.clock.install();
  await p.addInitScript((prof) => { if (prof && !localStorage.getItem('okey.v1')) localStorage.setItem('okey.v1', JSON.stringify(prof)); }, profile);
  return p;
}

// No page scroll, and every visible element of interest inside the viewport.
async function checkFit(p, label, selectors) {
  const r = await p.evaluate((sels) => {
    const W = innerWidth, H = innerHeight, de = document.documentElement, out = [];
    if (de.scrollHeight > H + 1 || de.scrollWidth > W + 1) out.push(`page scrolls (${de.scrollWidth}×${de.scrollHeight} in ${W}×${H})`);
    for (const sel of sels) {
      for (const el of document.querySelectorAll(sel)) {
        const b = el.getBoundingClientRect(), cs = getComputedStyle(el);
        if (!b.width || !b.height || cs.visibility === 'hidden' || el.closest('[hidden]')) continue;
        if (b.left < -1 || b.top < -1 || b.right > W + 1 || b.bottom > H + 1) out.push(`${sel} off screen (${Math.round(b.left)},${Math.round(b.top)} ${Math.round(b.width)}×${Math.round(b.height)})`);
      }
    }
    return out;
  }, selectors);
  if (r.length) r.slice(0, 6).forEach((m) => fail(`${label}: ${m}`)); else ok(`${label}: fits, no scroll`);
}

// Play my turns through the UI (tap the pile, double-tap a tile) while the fake clock runs the bots.
async function playTurns(p, ms) {
  let spent = 0;
  while (spent < ms) {
    const st = await p.evaluate(() => {
      const f = document.querySelector('.felt');
      return {
        draw: !!f && f.classList.contains('can-draw'), discard: !!f && f.classList.contains('can-discard'),
        result: !!document.querySelector('#result:not([hidden]) .rv-acts'), tip: !!document.querySelector('#tiplater'),
      };
    });
    if (st.result) return 'result';
    if (st.tip) await p.click('#tiplater');
    if (st.draw) await p.click('#pile');
    else if (st.discard) {
      const tiles = await p.$$('.rack .rt:not(.gone)');
      if (tiles.length) await tiles[tiles.length - 1].dblclick();
    }
    { const step = st.draw || st.discard ? 300 : 1200; await p.clock.runFor(step); spent += step; }
  }
  return 'time';
}

// 101: play my turns through the UI like a player would. Tries, once, taking the left discard and putting it
// back; opens with "Best opening" + "Open" when the counter allows; lays more sets; drags one tile onto a meld
// on the table when one fits; discards the last rack tile (confirming the işlek warning when it comes up).
async function play101(p, ms, stats) {
  let spent = 0;
  const st = () => p.evaluate(() => {
    const f = document.querySelector('.felt'), v = window.__okey.view();
    const btn = a => { const b = document.querySelector(`#o101:not([hidden]) button[data-a="${a}"]`); return b ? (b.disabled ? 'off' : 'on') : null; };
    return {
      draw: f.classList.contains('can-draw'), discard: f.classList.contains('can-discard'),
      result: !!document.querySelector('#result:not([hidden]) .rv-acts'), tip: !!document.querySelector('#tiplater'), confirm: !!document.querySelector('#cYes'),
      left: v && v.round ? v.seats[(v.you + 3) % 4].discard.count : 0, opened: v && v.round && v.round.opened ? v.round.opened[v.you] : false,
      open: btn('open'), lay: btn('lay'), undo: btn('undo'), best: btn('best'),
    };
  });
  while (spent < ms) {
    const s = await st();
    if (s.result) return 'result';
    if (s.tip) await p.click('#tiplater');
    if (s.confirm) { stats.islek++; await p.click('#cYes'); }
    else if (s.draw) {
      if (!stats.took && s.left) {
        await p.click('.ds.d3'); await p.clock.runFor(300);
        const u = await st();
        if (u.undo === 'on') {
          await p.screenshot({ path: join(SHOTS, 'e2e101-taken.png') });
          await p.click('#o101 button[data-a="undo"]'); await p.clock.runFor(300);
          const back = await st();
          if (back.draw && back.undo == null) stats.took = true; else fail('101: putting the taken tile back did not return to the draw stage');
        }
        continue;
      }
      await p.click('#pile');
    } else if (s.discard) {
      if (!s.opened && s.best) {
        await p.click('#o101 button[data-a="best"]');
        const again = await st();
        if (again.open === 'on') {
          if (!stats.openShot) { stats.openShot = true; await p.screenshot({ path: join(SHOTS, 'e2e101-open.png') }); }
          await p.click('#o101 button[data-a="open"]'); await p.clock.runFor(400); stats.opened++;
          continue;
        }
      }
      if (s.opened && s.lay === 'on') { await p.click('#o101 button[data-a="lay"]'); await p.clock.runFor(400); stats.laid++; continue; }
      if (s.opened && !stats.added) {
        const move = await p.evaluate(async () => {
          const R = await import('/shared/okey101/rules.js'), v = window.__okey.view();
          const offs = R.layoffs(v.hand, v.round.table, v.round.okey);
          return offs.length < v.hand.length && offs[0] ? { ...offs[0], before: v.round.table[offs[0].meld].tiles.length } : null;
        });
        if (move) {
          const tile = await (await p.$(`.rack .rt[data-id="${move.tile}"]`)).boundingBox();
          const meld = await (await p.$(`#melds .mg[data-i="${move.meld}"]`)).boundingBox();
          const tx = move.side === 'start' ? meld.x + 3 : meld.x + meld.width - 3, ty = meld.y + meld.height / 2;
          await p.mouse.move(tile.x + tile.width / 2, tile.y + tile.height / 2); await p.mouse.down();
          await p.mouse.move(tx, ty, { steps: 12 });
          await p.screenshot({ path: join(SHOTS, 'e2e101-addhint.png') });
          await p.mouse.up(); await p.clock.runFor(500);
          const after = await p.evaluate((i) => window.__okey.view().round.table[i].tiles.length, move.meld);
          if (after === move.before + 1) { stats.added = true; ok('101: dragged a tile onto a table meld (işleme)'); await p.screenshot({ path: join(SHOTS, 'e2e101-added.png') }); }
          else fail(`101: drag onto meld ${move.meld} did not add the tile`);
          continue;
        }
      }
      const tiles = await p.$$('.rack .rt:not(.gone)');
      if (tiles.length) await tiles[tiles.length - 1].dblclick();
    }
    { const step = s.draw || s.discard ? 300 : 1200; await p.clock.runFor(step); spent += step; }
  }
  return 'time';
}

// Opponents (plate + ıstaka) must never cover the pile, the indicator, a discard stack, the melds or my rack.
async function checkSeats(p, label) {
  const bad = await p.evaluate(() => {
    const hit = (a, b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
    const seats = [...document.querySelectorAll('.seat.opp')].map(e => [e.className.match(/p\d/)[0], e.getBoundingClientRect()]);
    const things = ['#pile', '.indt', '.okeyis:not([hidden])', '.ds .dstack', '#melds:not([hidden])', '#rack'].flatMap(sel => [...document.querySelectorAll(sel)].map(e => [sel, e.getBoundingClientRect()]));
    const out = [];
    for (const [sp, sr] of seats) for (const [tn, tr] of things) if (tr.width && hit(sr, tr)) out.push(`${sp} covers ${tn}`);
    return out;
  });
  if (bad.length) bad.slice(0, 4).forEach(m => fail(`${label}: ${m}`)); else ok(`${label}: opponents clear of the pile, discards and rack`);
}

const TABLE_SEL = ['.rack .rt', '#pile', '.seat .av', '.ds .dstack', '.bar .chip', '.top .ibtn', '.ind', '.status', '#o101 button', '#melds'];

if (only !== 'e2e') for (const [w, h] of SIZES) {
  const tag = `${w}x${h}`;
  console.log(`\n${tag}`);
  // home
  let p = await page(w, h);
  await p.goto(`${BASE}/?anim=0#/`);
  await p.waitForSelector('#hSolo');
  await p.screenshot({ path: join(SHOTS, `home-${tag}.png`) });
  await checkFit(p, 'home', ['#hSolo', '#hCreate', '#hCode', '.logo', '.hfoot', '.top .ibtn']);
  await p.context().close();

  // practice table a few turns in (the real LocalTable and bots)
  p = await page(w, h, { clock: true });
  await p.goto(`${BASE}/?anim=0#/solo`);
  await p.clock.runFor(500);
  await p.waitForSelector('.rack .rt', { timeout: 10_000 });
  await playTurns(p, 24_000);
  await p.screenshot({ path: join(SHOTS, `table-${tag}.png`) });
  await checkFit(p, 'table', TABLE_SEL);
  await checkSeats(p, 'table');
  const tw = await p.evaluate(() => document.querySelector('.rack .rt').getBoundingClientRect().width);
  if (tw < 24) fail(`table: rack tiles only ${tw.toFixed(1)}px wide`); else ok(`table: rack tiles ${tw.toFixed(1)}px wide`);
  await p.click('#bEmote');
  await p.screenshot({ path: join(SHOTS, `emotes-${tag}.png`) });
  await checkFit(p, 'emotes', ['#emotes button']);
  await p.click('#tRules');
  await p.waitForSelector('.sheet .x');
  await checkFit(p, 'rules sheet', ['.sheet .x']);
  if (p.errors.length) fail(`table: page errors: ${p.errors.slice(0, 3).join(' | ')}`);
  await p.context().close();

  // the lobby of a friends' table (mock transport: this static server has no worker)
  p = await page(w, h);
  await p.goto(`${BASE}/?mock=1&anim=0#/m/TEST42`);
  await p.waitForSelector('.lseat .spot');
  await p.waitForTimeout(3000);   // friends sit down
  await p.screenshot({ path: join(SHOTS, `lobby-${tag}.png`) });
  await checkFit(p, 'lobby', ['.lseat', '.lctl button', '.lplacard']);
  await p.context().close();

  // a round story: a bot finishes straight away (mock scenario), with the real animations
  p = await page(w, h);
  await p.goto(`${BASE}/?mock=1&fast=1&scenario=reveal#/solo`);
  await p.waitForSelector('#result:not([hidden]) .rv-acts', { timeout: 20_000 });
  await p.waitForTimeout(3500);
  await p.screenshot({ path: join(SHOTS, `result-${tag}.png`) });
  await checkFit(p, 'result', ['.rv-card .tile', '.rv-acts .btn', '.deltas .dl', '.rverd']);
  await p.context().close();

  // 101 Okey: a practice table some turns in (melds on the table once players open)
  p = await page(w, h, { clock: true });
  await p.goto(`${BASE}/?anim=0&variant=101&rounds=1#/solo`);
  await p.clock.runFor(500);
  await p.waitForSelector('.rack .rt', { timeout: 10_000 });
  const st101 = { took: false, opened: 0, laid: 0, added: true, islek: 0 };   // no drag here: just the layout
  const res101 = await play101(p, 40_000, st101);
  await p.screenshot({ path: join(SHOTS, `t101-${tag}.png`) });
  await checkFit(p, '101 table', TABLE_SEL);
  await checkSeats(p, '101 table');
  const tw101 = await p.evaluate(() => document.querySelector('.rack .rt').getBoundingClientRect().width);
  const min101 = h > w ? 28 : 21;   // portrait phones get three tiers so 101 tiles stay big
  if (tw101 < min101) fail(`101: rack tiles only ${tw101.toFixed(1)}px wide (want ≥ ${min101})`); else ok(`101: rack tiles ${tw101.toFixed(1)}px wide`);
  if (res101 === 'result') {
    await p.screenshot({ path: join(SHOTS, `r101-${tag}.png`) });
    await checkFit(p, '101 result', ['.rv-acts .btn', '.deltas .dl', '.rverd']);
  }
  if (p.errors.length) fail(`101 table: page errors: ${p.errors.slice(0, 3).join(' | ')}`);
  await p.context().close();
}

// ---- a full practice match on the real LocalTable: deal → turns → round end → next round → match end ----
if (only !== 'layout') {
  console.log('\nfull practice match (390x600, 2 rounds)');
  const p = await page(390, 600, { clock: true });
  await p.goto(`${BASE}/?anim=0&rounds=2#/solo`);
  await p.clock.runFor(500);
  await p.waitForSelector('.rack .rt', { timeout: 10_000 });
  for (let r = 0; r < 2; r++) {
    const res = await playTurns(p, 20 * 60_000);
    if (res !== 'result') { fail(`round ${r + 1} never ended`); break; }
    ok(`round ${r + 1} ended: “${(await p.textContent('.rverd')).trim()}”`);
    if (r === 0) {
      await p.screenshot({ path: join(SHOTS, 'e2e-round1.png') });
      await p.click('#rvNext');
      await p.clock.runFor(1500);
      const dealt = await p.waitForSelector('#result[hidden]', { state: 'attached', timeout: 5000 }).then(() => true, () => false);
      if (!dealt) fail('next round did not start'); else ok('next round dealt');
    }
  }
  await p.clock.runFor(3000);
  if (!(await p.$('.podium'))) fail('no podium at match end'); else ok('match end: podium shown');
  await p.screenshot({ path: join(SHOTS, 'e2e-matchend.png') });
  if (p.errors.length) fail(`e2e: page errors: ${p.errors.slice(0, 3).join(' | ')}`);
  await p.context().close();
}

// ---- 101 Okey end to end: take + put back, open, lay off onto a table meld, the işlek warning, the result ----
if (only !== 'layout') {
  console.log('\n101 practice (390x600, up to 4 rounds)');
  const p = await page(390, 600, { clock: true });
  await p.goto(`${BASE}/?anim=0&variant=101&rounds=4#/solo`);
  await p.clock.runFor(500);
  await p.waitForSelector('.rack .rt', { timeout: 10_000 });
  const stats = { took: false, opened: 0, laid: 0, added: false, islek: 0 };
  for (let r = 0; r < 4; r++) {
    const res = await play101(p, 30 * 60_000, stats);
    if (res !== 'result') { fail(`101 round ${r + 1} never ended`); break; }
    const story = (await p.textContent('.rverd')).trim();
    if (!(await p.$('.deltas.d101 .dl'))) fail('101 result has no per-seat rows');
    ok(`101 round ${r + 1} ended: “${story}”`);
    await p.screenshot({ path: join(SHOTS, `e2e101-round${r + 1}.png`) });
    if (stats.took && stats.opened && stats.added) break;
    await p.click('#rvNext'); await p.clock.runFor(1500);
  }
  stats.took ? ok('101: took the left discard and put it back') : fail('101: never took and put back a discard');
  stats.opened ? ok(`101: opened ${stats.opened}× with Best opening + Open (laid more ${stats.laid}×)`) : fail('101: never opened in 4 rounds');
  if (!stats.added) fail('101: never added a tile to a table meld');
  ok(`101: işlek warnings confirmed: ${stats.islek}`);
  if (p.errors.length) fail(`101 e2e: page errors: ${p.errors.slice(0, 3).join(' | ')}`);
  await p.context().close();
}

// ---- offline: the service worker precaches the app, so solo practice starts with no connection ----
if (only !== 'layout') {
  console.log('\noffline practice (service worker)');
  const p = await page(390, 600);
  await p.goto(`${BASE}/#/`);
  const cached = await p.waitForFunction(async () => {
    const keys = await caches.keys(); if (!keys.length) return 0;
    const n = (await (await caches.open(keys[0])).keys()).length; return n > 40 ? n : 0;
  }, null, { timeout: 20_000 }).then(h => h.jsonValue(), () => 0);
  cached ? ok(`service worker precached ${cached} files`) : fail('service worker did not precache the app');
  await p.context().setOffline(true);
  await p.goto(`${BASE}/?anim=0#/solo`);
  const dealt = await p.waitForSelector('.rack .rt', { timeout: 20_000 }).then(() => true, () => false);
  dealt ? ok('offline: solo practice deals') : fail('offline: solo practice did not start');
  await p.context().close();
}

await browser.close();
server.close();
console.log(failures.length ? `\n${failures.length} failure(s)` : '\nall good');
process.exit(failures.length ? 1 : 0);
