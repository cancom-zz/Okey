// Playwright: the tip-ask rules (ported from The Felt), on a fake clock.
//   node test/tip.pw.mjs
// Rounds end fast with the mock "a bot finishes at once" table; play time is set in the saved state.
// Rules: never mid-round; not before 10 minutes of play; after a good moment or 30 more minutes; asks at least 2 days
// apart; tapping Ko-fi → back on the page we ask "did you tip?" once; "I tipped" stops every ask for good.
import { createRequire } from 'node:module';
import { serve } from './serve.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const PORT = 9700 + Math.floor(Math.random() * 200);
const BASE = `http://localhost:${PORT}`;
const MIN = 60e3, DAY = 864e5;
const server = await serve(PORT);
const browser = await chromium.launch();
const failures = [];
const ok = m => console.log('  ✓ ' + m);
const fail = m => { failures.push(m); console.log('  ✗ ' + m); };
const T0 = new Date('2026-12-01T12:00:00Z').getTime();

const ctx = await browser.newContext({ viewport: { width: 390, height: 600 } });
const page = await ctx.newPage();
page.on('pageerror', e => fail('page error: ' + e.message));
await page.clock.install({ time: T0 });
const base = { name: 'Can', avatar: '🦊', id: 'tip-device-00000001', secret: 'tip-secret-00000001' };
const setTip = async tip => { await page.goto(BASE + '/manifest.webmanifest'); await page.evaluate(([prof, tp]) => { const s = { ...(JSON.parse(localStorage.getItem('okey.v1') || 'null') || {}), name: prof.name, avatar: prof.avatar }; s.tip = { ...(s.tip || {}), ...tp }; localStorage.setItem('okey.v1', JSON.stringify(s)); }, [base, tip]); };
const getTip = () => page.evaluate(() => JSON.parse(localStorage.getItem('okey.v1')).tip);
const asked = () => page.$('#tiplater').then(Boolean);
const thanks = () => page.$('#tipyes').then(Boolean);

// one round on a fresh mock table; returns whether the tip ask came up after the result (and checks mid-round)
// (time jumps happen after the page loads: a fresh document starts from the clock as it was before the jump)
async function round({ midRound = false, ff = 0 } = {}) {
  if (ff) { await page.goto(BASE + '/manifest.webmanifest'); await page.clock.setSystemTime((await page.evaluate(() => Date.now())) + ff); }   // jump on a page with no timers
  await page.goto(`${BASE}/?mock=1&anim=0&scenario=${midRound ? 'full' : 'reveal'}&fast=1#/solo`);
  if (midRound) {
    await page.clock.runFor(20_000);                           // a long stretch of a round in progress
    return asked();
  }
  for (let i = 0; i < 40 && !(await page.$('#result:not([hidden]) .rv-acts')); i++) await page.clock.runFor(500);
  if (!(await page.$('#result:not([hidden]) .rv-acts'))) { fail('the round never ended'); return false; }
  await page.clock.runFor(4_000);                              // the ask waits for the result to land
  return asked();
}
const closeSheets = () => page.evaluate(() => { const x = document.getElementById('mx'); if (x) x.click(); });

await page.goto(`${BASE}/#/`);
console.log('tip asks');
await setTip({ play: 5 * MIN, at: 0, next: 0, went: 0, done: false });
(await round()) ? fail('asked before 10 minutes of play') : ok('not in the first 10 minutes of play');

await setTip({ play: 12 * MIN, at: 0 });
(await round()) ? fail('asked at 12 minutes without a good moment or 30 minutes') : ok('12 minutes, no good moment: no ask');

await setTip({ play: 45 * MIN, at: 0 });
(await round({ midRound: true })) ? fail('asked in the middle of a round') : ok('never mid-round');
(await round()) ? ok('after 30 more minutes of play: asks between rounds') : fail('did not ask after 45 minutes');
await page.click('#tiplater');
let tp = await getTip();
tp.next - Date.now() > 1.9 * DAY && tp.at === tp.play ? ok('"Not now": next ask 2 days away') : fail(`"Not now" did not snooze 2 days (next ${tp.next})`);

await setTip({ play: tp.play + 40 * MIN });
(await round()) ? fail('asked again within 2 days') : ok('no second ask within 2 days, even after 40 more minutes');
await closeSheets();
(await round({ ff: 2 * DAY + MIN })) ? ok('asks again after 2 days and 30+ more minutes') : fail('no ask after 2 days');

// tapping Ko-fi: a new tab opens; back on the page we ask "did you tip?" once
const [popup] = await Promise.all([ctx.waitForEvent('page'), page.click('.tiplink')]);
await popup.close();
tp = await getTip();
tp.went > 0 ? ok('tapping Ko-fi is remembered') : fail('Ko-fi tap not recorded');
const flipVisibility = () => page.evaluate(() => {
  for (const st of ['hidden', 'visible']) { Object.defineProperty(document, 'visibilityState', { value: st, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); }
});
await page.goto(`${BASE}/#/`); await page.clock.runFor(500);
await flipVisibility();
(await thanks()) ? ok('back from Ko-fi: "did you tip?"') : fail('no "did you tip?" on return');
await page.click('#tipnot'); await page.clock.runFor(400);
await flipVisibility();
(await thanks()) ? fail('asked "did you tip?" twice') : ok('"did you tip?" only once');

// "I've already tipped": never again
await setTip({ play: (await getTip()).play + 60 * MIN });
(await round({ ff: 3 * DAY })) ? ok('the next ask comes after the gap') : fail('no ask before "already tipped"');
await page.click('#tipdone');
tp = await getTip();
tp.done ? ok('"I\'ve already tipped" is saved') : fail('done flag not saved');
await setTip({ play: tp.play + 120 * MIN });
(await round({ ff: 10 * DAY })) ? fail('asked after the player said they tipped') : ok('never asks again once tipped');
await flipVisibility();
(await thanks()) ? fail('"did you tip?" after tipping') : ok('no "did you tip?" once tipped');

await browser.close();
server.close();
console.log(failures.length ? `\n${failures.length} failure(s)` : '\nall good');
process.exit(failures.length ? 1 : 0);
