// Tiny static server for site/ (dev + Playwright). `node test/serve.mjs [port]` → http://localhost:8787
// /api/* is not served here (no worker): online tables need `npx wrangler dev`; use ?mock=1 to fake one.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'site');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon' };

export function serve(port = 8787) {
  const server = http.createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p.endsWith('/')) p += 'index.html';
      const file = normalize(join(ROOT, p));
      if (!file.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
      const s = await stat(file).catch(() => null);
      if (!s || !s.isFile()) {
        if (p.startsWith('/api/')) { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"no worker"}'); return; }
        res.writeHead(404, { 'content-type': TYPES['.html'] }); res.end(await readFile(join(ROOT, '404.html'))); return;
      }
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(await readFile(file));
    } catch (e) { res.writeHead(500); res.end(String(e)); }
  });
  return new Promise(r => server.listen(port, () => r(server)));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = +process.argv[2] || 8787;
  serve(port).then(() => console.log(`Okey on http://localhost:${port}/  (practice: #/solo, mock friends table: ?mock=1#/m/TEST42)`));
}
