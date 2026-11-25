// Playwright: main-thread smoothness during a solo game, with the CPU throttled 4× (a mid-range phone).
//   node test/perf.pw.mjs [seconds=60] [classic|101]
// Records every tile flight (anim.js test hook) and every long task (PerformanceObserver), and fails if a long task
// over 100 ms lands while a tile is in the air. Reports the long tasks either way, so heavy work is easy to find.
import { createRequire } from 'node:module';
import { serve } from './serve.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const SECONDS = +(process.argv[2] || 60), variant = process.argv[3] || 'classic';
const PORT = 9300 + Math.floor(Math.random() * 300);
const server = await serve(PORT);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 600 } });
page.on('pageerror', e => console.log('pageerror:', e.message));
await page.addInitScript(() => {
  localStorage.setItem('okey.v1', JSON.stringify({ name: 'Can', avatar: '🦊', id: 'perf-device-000001', secret: 'perf-secret-000001', tip: { done: true } }));
  try { localStorage.setItem('okey.guide.v1', JSON.stringify({ classic: true, 101: true })); } catch { /* ignore */ }
  globalThis.__okeyFlights = [];
  globalThis.__okeyLong = [];
  new PerformanceObserver(list => { for (const e of list.getEntries()) globalThis.__okeyLong.push([e.startTime, e.duration]); }).observe({ type: 'longtask', buffered: true });
});
const cdp = await page.context().newCDPSession(page);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
await page.goto(`http://localhost:${PORT}/?${variant === '101' ? 'variant=101&' : ''}#/solo`);
await page.waitForSelector('.rack .rt', { timeout: 30_000 });

// play my turns like a person: draw from the pile, discard the last tile
const end = Date.now() + SECONDS * 1000;
while (Date.now() < end) {
  const st = await page.evaluate(() => { const f = document.querySelector('.felt'); return { draw: f.classList.contains('can-draw'), discard: f.classList.contains('can-discard'), result: !!document.querySelector('#result:not([hidden]) #rvNext:not([disabled])'), confirm: !!document.querySelector('#cYes') }; });
  if (st.confirm) await page.click('#cYes');
  else if (st.result) await page.click('#rvNext');
  else if (st.draw) await page.click('#pile');
  else if (st.discard) { const tl = await page.$$('.rack .rt:not(.gone)'); if (tl.length) await tl[tl.length - 1].dblclick(); }
  await page.waitForTimeout(300);
}
const { flights, long, mode } = await page.evaluate(() => ({ flights: globalThis.__okeyFlights, long: globalThis.__okeyLong, mode: globalThis.__okeyLocalMode }));
const bad = long.filter(([s, d]) => d > 100 && flights.some(([a, b]) => s < b && s + d > a));
console.log(`${variant} (host in the ${mode || '?'}): ${flights.length} flights, ${long.length} long tasks (max ${Math.round(Math.max(0, ...long.map(l => l[1])))} ms), ${bad.length} over 100 ms during a flight`);
for (const [s, d] of long.filter(l => l[1] > 100).slice(0, 12)) console.log(`  long task at ${Math.round(s)} ms: ${Math.round(d)} ms${bad.some(b => b[0] === s) ? '  ← during a flight' : ''}`);
await browser.close();
server.close();
process.exit(bad.length ? 1 : 0);
