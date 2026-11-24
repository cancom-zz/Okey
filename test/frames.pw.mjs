// Frame sequences of the table's animations, laid out as contact sheets (for reviewing motion by eye).
//   node test/frames.pw.mjs [WxH] [classic|101]      -> test/shots/frames/<size>-<variant>/sheet_*.png
// Real timings (no fake clock): the deal, bot turns, your own draw and discard, and a finish (mock scenario).
import { createRequire } from 'node:module';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from './serve.mjs';

const { chromium } = createRequire(import.meta.url)('playwright');
const [W, H] = (process.argv[2] || '390x600').split('x').map(Number);
const variant = process.argv[3] || 'classic';
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'shots', 'frames', `${W}x${H}-${variant}`);
const PORT = 9100 + Math.floor(Math.random() * 500);
await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });
const server = await serve(PORT);
const browser = await chromium.launch();
const PROFILE = { name: 'Can', avatar: '🦊', id: 'frames-device-0001', secret: 'frames-secret-0001', tip: { play: 0, at: 0, next: 0, went: 0, done: true } };

async function page() {
  const p = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  p.on('pageerror', e => console.log('pageerror:', e.message));
  await p.addInitScript(prof => localStorage.setItem('okey.v1', JSON.stringify(prof)), PROFILE);
  return p;
}
async function grab(p, name, n, every) {
  const files = [];
  for (let i = 0; i < n; i++) {
    const f = join(OUT, `${name}${String(i).padStart(2, '0')}.png`);
    await p.screenshot({ path: f }); files.push(f);
    await p.waitForTimeout(every);
  }
  return files;
}
async function sheet(name, files, cols = 8) {
  const imgs = await Promise.all(files.map(async f => 'data:image/png;base64,' + (await readFile(f)).toString('base64')));
  const p = await browser.newPage({ viewport: { width: cols * (W / 2 + 6), height: 400 } });
  await p.setContent(`<body style="margin:0;background:#111;display:grid;grid-template-columns:repeat(${cols},${W / 2}px);gap:6px;padding:3px">${imgs.map((s, i) => `<div style="position:relative"><img src="${s}" style="width:${W / 2}px;display:block"><b style="position:absolute;left:3px;top:3px;font:11px sans-serif;color:#ff0;background:#000a;padding:1px 3px">${i}</b></div>`).join('')}</body>`);
  await p.screenshot({ path: join(OUT, `sheet_${name}.png`), fullPage: true });
  await p.close();
}
const state = p => p.evaluate(() => { const f = document.querySelector('.felt'); return f ? { draw: f.classList.contains('can-draw'), discard: f.classList.contains('can-discard') } : {}; });
async function untilMyTurn(p, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const s = await state(p); if (s.draw || s.discard) return s; await p.waitForTimeout(100); }
  return null;
}

const q = variant === '101' ? 'variant=101&' : '';
// 1. the deal, then bots playing
{
  const p = await page();
  await p.goto(`http://localhost:${PORT}/?${q}#/`);
  await p.waitForSelector('#hSolo');
  await p.click('#hSolo');
  await sheet('deal', await grab(p, 'deal', 40, 90), 8);
  // play our turn through (draw if needed, then discard) so the bots play next
  const discardStage = async () => { for (let i = 0; i < 50 && !(await state(p)).discard; i++) await p.waitForTimeout(80); };
  const s = await untilMyTurn(p, 30000);
  if (s) {
    if (s.draw) { await p.click('#pile'); await discardStage(); }
    const tl = await p.$$('.rack .rt:not(.gone)'); await tl[tl.length - 1].dblclick();
    await p.waitForTimeout(150); if (await p.$('#cYes')) await p.click('#cYes');
  }
  await sheet('bots', await grab(p, 'bots', 56, 70), 8);
  // our own draw and discard, filmed
  const s2 = await untilMyTurn(p, 30000);
  if (s2) {
    const files = [];
    if (s2.draw) { await p.click('#pile'); files.push(...await grab(p, 'me', 10, 45)); }
    await discardStage();
    const tl = await p.$$('.rack .rt:not(.gone)'); await tl[tl.length - 1].dblclick();
    if (await p.$('#cYes')) await p.click('#cYes');
    files.push(...await grab(p, 'me2', 14, 40));
    await sheet('me', files, 8);
  }
  await p.close();
}
// 2. a finish (mock: a bot finishes on its first turn), real timings
if (variant !== '101') {
  const p = await page();
  await p.goto(`http://localhost:${PORT}/?mock=1&scenario=reveal#/solo`);
  await p.waitForTimeout(3200);
  await sheet('finish', await grab(p, 'fin', 40, 110), 8);
  await p.close();
}
await browser.close();
server.close();
console.log('contact sheets in', OUT);
