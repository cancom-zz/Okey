// PNG icons for the PWA, rendered from site/icon.svg with the pre-installed Chromium (Playwright).
//   node tools/icons.mjs   -> site/icons/icon-192.png, icon-512.png (maskable-safe), apple-touch-icon.png (180)
import { createRequire } from 'node:module';
import { readFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const { chromium } = createRequire(import.meta.url)('playwright');
const SITE = join(dirname(fileURLToPath(import.meta.url)), '..', 'site');
const svg = await readFile(join(SITE, 'icon.svg'), 'utf8');
await mkdir(join(SITE, 'icons'), { recursive: true });
const browser = await chromium.launch();
// maskable: platforms crop to a circle/squircle, so the art sits inside an 80% safe zone on the felt colour
for (const [name, size, pad] of [['icon-192.png', 192, 0], ['icon-512.png', 512, 0.1], ['apple-touch-icon.png', 180, 0.06]]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  const inner = Math.round(size * (1 - pad * 2));
  await page.setContent(`<body style="margin:0;width:${size}px;height:${size}px;display:grid;place-items:center;background:${pad ? '#0d5a3c' : 'transparent'}">
    <div style="width:${inner}px;height:${inner}px">${svg.replace('<svg ', `<svg width="${inner}" height="${inner}" `)}</div></body>`);
  await page.screenshot({ path: join(SITE, 'icons', name), omitBackground: !pad });
  await page.close();
  console.log('wrote', name);
}
await browser.close();
