// Playwright: your own moves must glide — one continuous move from the exact source pose to the exact target pose.
//   node test/motion.pw.mjs            -> test/shots/motion/<case>/f###.jpg + sheet_<case>.png
// For each case the page samples the flying tile every animation frame (rAF), and we check:
//   - the distance to the target never grows (no reversal) and the tile never passes it (no overshoot);
//   - a drag starts exactly where the finger let go (no snap back first);
//   - the last frame of the flight matches the real tile that replaces it (no jump, no pop).
// Cases: double-tap discard, drag discard, tap the left discard, drag the left discard, drag from the pile.
import { createRequire } from 'node:module';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from './serve.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'shots', 'motion');
const PORT = 9500 + Math.floor(Math.random() * 300);
await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
const server = await serve(PORT);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 390, height: 600 }, deviceScaleFactor: 1 });
const failures = [];
const ok = m => console.log('  ✓ ' + m), fail = m => { failures.push(m); console.log('  ✗ ' + m); };
page.on('pageerror', e => fail('page error: ' + e.message));
await page.addInitScript(() => {
  localStorage.setItem('okey.v1', JSON.stringify({ name: 'Can', avatar: '🦊', id: 'motion-device-0001', secret: 'motion-secret-0001', tip: { done: true } }));
  try { localStorage.setItem('okey.guide.v1', JSON.stringify({ classic: true, 101: true })); } catch { /* ignore */ }
  // the sampler: every animation frame, where each flying tile is
  globalThis.__samples = null;
  globalThis.__sample = () => {
    const out = [], seen = new Map(); let k = 0;
    const tick = () => {
      if (!globalThis.__samples) return;
      for (const el of document.querySelectorAll('#fx .fly')) {
        if (!seen.has(el)) seen.set(el, k++);
        const r = el.getBoundingClientRect();
        out.push({ k: seen.get(el), t: performance.now(), x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height });
      }
      requestAnimationFrame(tick);
    };
    globalThis.__samples = out; requestAnimationFrame(tick);
  };
});
const cdp = await page.context().newCDPSession(page);
let frames = null;
cdp.on('Page.screencastFrame', async f => { if (frames) frames.push(f.data); await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {}); });
await page.goto(`http://localhost:${PORT}/#/solo`);
await page.waitForSelector('.rack .rt', { timeout: 30_000 });

const state = () => page.evaluate(() => { const f = document.querySelector('.felt'), v = window.__okey.view(); return { draw: f.classList.contains('can-draw'), discard: f.classList.contains('can-discard'), left: v && v.round ? v.seats[(v.you + 3) % 4].discard.count : 0 }; });
async function until(pred, ms = 40_000) { const end = Date.now() + ms; while (Date.now() < end) { const s = await state(); if (pred(s)) return s; await page.waitForTimeout(60); } return null; }
const center = async sel => { const b = await (await page.$(sel)).boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; };

async function film(name, act, target) {
  frames = [];
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, everyNthFrame: 1 });
  await page.evaluate(() => globalThis.__sample());
  const release = await act();
  // measure the real tile the moment the flight hands over (a bot may take my discard soon after)
  await page.waitForFunction(() => globalThis.__samples && globalThis.__samples.length > 0 && !document.querySelector('#fx .fly'), null, { timeout: 5000, polling: 'raf' }).catch(() => {});
  const tgt = await target();
  await page.waitForTimeout(250);
  await cdp.send('Page.stopScreencast');
  const samples = await page.evaluate(() => { const s = globalThis.__samples; globalThis.__samples = null; return s; });
  // write the frames and a contact sheet
  const dir = join(OUT, name); await mkdir(dir, { recursive: true });
  const shots = frames.slice(0, 48); frames = null;
  await Promise.all(shots.map((b, i) => writeFile(join(dir, `f${String(i).padStart(3, '0')}.jpg`), Buffer.from(b, 'base64'))));
  const sheet = await browser.newPage({ viewport: { width: 8 * 201, height: 300 } });
  await sheet.setContent(`<body style="margin:0;background:#111;display:grid;grid-template-columns:repeat(8,195px);gap:6px;padding:3px">${shots.map((b, i) => `<div style="position:relative"><img src="data:image/jpeg;base64,${b}" style="width:195px;display:block"><b style="position:absolute;left:3px;top:3px;font:11px sans-serif;color:#ff0;background:#000a;padding:1px 3px">${i}</b></div>`).join('')}</body>`);
  await sheet.screenshot({ path: join(OUT, `sheet_${name}.png`), fullPage: true }); await sheet.close();
  // the motion checks, on the tile that went to the target
  if (!samples.length) { fail(`${name}: no flight sampled`); return; }
  const byK = new Map(); samples.forEach(s => { if (!byK.has(s.k)) byK.set(s.k, []); byK.get(s.k).push(s); });
  const path = [...byK.values()].sort((a, b) => Math.hypot(a.at(-1).x - tgt.x, a.at(-1).y - tgt.y) - Math.hypot(b.at(-1).x - tgt.x, b.at(-1).y - tgt.y))[0];
  const d = p => Math.hypot(p.x - tgt.x, p.y - tgt.y);
  let worse = 0; for (let i = 1; i < path.length; i++) if (d(path[i]) > d(path[i - 1]) + 0.75) worse++;
  const sx = path[0].x, sy = path[0].y, vx = tgt.x - sx, vy = tgt.y - sy, len2 = vx * vx + vy * vy || 1;
  const over = Math.max(...path.map(p => ((p.x - sx) * vx + (p.y - sy) * vy) / len2));
  const last = path.at(-1), endGap = d(last), sizeGap = Math.max(Math.abs(last.w - tgt.w), Math.abs(last.h - tgt.h));
  const startGap = release ? Math.hypot(path[0].x - release.x, path[0].y - release.y) : 0;
  if (process.env.MOTION_DEBUG) console.log(name, JSON.stringify(path.map(p => [Math.round(p.x), Math.round(p.y)])), JSON.stringify(tgt));
  const overPx = Math.max(0, (over - 1) * Math.sqrt(len2));
  const msg = `${name}: ${path.length} frames, end ${endGap.toFixed(1)}px/${sizeGap.toFixed(1)}px off, overshoot ${overPx.toFixed(1)}px${release ? `, start ${startGap.toFixed(1)}px from the release` : ''}`;
  (worse === 0 && overPx < 1 && endGap < 2 && sizeGap < 2 && startGap < 3) ? ok(msg) : fail(msg + (worse ? `, ${worse} frames moved away from the target` : ''));
}
const topOfMyStack = async () => { const b = await (await page.$('.ds.d0 .dtop')).boundingBox(); return { x: b.x + b.width / 2, y: b.y + b.height / 2, w: b.width, h: b.height }; };
const newestRackTile = before => async () => {
  const r = await page.evaluate(ids => { const el = [...document.querySelectorAll('.rack .rt')].find(e => !ids.includes(+e.dataset.id)); const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width, h: b.height }; }, before);
  return r;
};
const rackIds = () => page.evaluate(() => [...document.querySelectorAll('.rack .rt')].map(e => +e.dataset.id));
async function dragTo(fromSel, to) {
  const a = await center(fromSel);
  await page.mouse.move(a.x, a.y); await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 14 });
  await page.waitForTimeout(60);
  // where the dragged tile (or the ghost) actually is at the moment of release: the flight must start right there
  const at = await page.evaluate(() => { const el = document.querySelector('.dragghost') || document.querySelector('.rack .rt.drag'); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; });
  await page.mouse.up();
  return at || to;
}
const lastTileSel = async () => { const ids = await rackIds(); return `.rack .rt[data-id="${ids[ids.length - 1]}"]`; };
const freeSlot = () => page.evaluate(() => { const r = document.querySelector('.rack-tiles').getBoundingClientRect(); return { x: r.right - 12, y: r.bottom - 14 }; });

console.log('own moves at 60 fps (390x600)');
const plan = [
  { draw: 'tap-left', discard: 'double-tap' },
  { draw: 'drag-left', discard: 'drag' },
  { draw: 'drag-pile', discard: 'double-tap' },
];
const done = new Set();
for (let turn = 0; turn < 8 && done.size < 5; turn++) {
  const s = await until(x => x.draw || x.discard); if (!s) { fail('my turn never came'); break; }
  const p = plan.find(x => !done.has(x.draw)) || plan[2];
  if (s.draw) {
    const kind = p.draw === 'tap-left' || p.draw === 'drag-left' ? (s.left ? p.draw : null) : p.draw;
    const before = await rackIds();
    if (kind === 'tap-left') await film('tap-left', async () => { await page.click('.ds.d3'); return null; }, newestRackTile(before));
    else if (kind === 'drag-left') await film('drag-left', async () => dragTo('.ds.d3', await freeSlot()), newestRackTile(before));
    else if (kind === 'drag-pile') await film('drag-pile', async () => dragTo('#pile', await freeSlot()), newestRackTile(before));
    else await page.click('#pile');
    if (kind) done.add(kind);
    await until(x => x.discard, 8000);
  }
  const how = done.has('double-tap') && !done.has('drag') ? 'drag' : 'double-tap';
  const sel = await lastTileSel();
  if (how === 'drag') await film('drag-discard', async () => dragTo(sel, await center('.ds.d0 .dstack')), topOfMyStack);
  else await film('double-tap-discard', async () => { await page.dblclick(sel); return null; }, topOfMyStack);
  done.add(how);
}
await browser.close();
server.close();
console.log(failures.length ? `\n${failures.length} failure(s)` : '\nall good');
process.exit(failures.length ? 1 : 0);
