// Service worker: network first, the last good copy from the cache when offline. Everything solo practice needs is
// precached on install, so a table against the bots works with no connection. Never caches /api/ (rooms are live).
// Bump VERSION with every deploy that changes these files (the old cache is dropped on activate).
const VERSION = 'okey-v1-2026-11-25';
const CORE = [
  './', 'index.html', 'manifest.webmanifest', 'icon.svg', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/apple-touch-icon.png',
  'css/okey.css', 'css/stats.css',
  'i18n/tr.js', 'i18n/en.js',
  'js/app.js', 'js/anim.js', 'js/local-worker.js', 'js/stats.js', 'js/config.js', 'js/guide.js', 'js/home.js', 'js/i18n.js', 'js/lobby.js', 'js/local.js', 'js/net.js',
  'js/rack.js', 'js/result.js', 'js/sheets.js', 'js/sound.js', 'js/store.js', 'js/table.js', 'js/tiles.js', 'js/tip.js', 'js/ui.js', 'js/v101.js',
  'shared/host.js', 'shared/achievements.js',
  'shared/okey/index.js', 'shared/okey/game.js', 'shared/okey/rng.js', 'shared/okey/rules.js', 'shared/okey/tiles.js',
  'shared/okey101/index.js', 'shared/okey101/game.js', 'shared/okey101/rules.js',
  'shared/bots/index.js', 'shared/bots/chatter.js', 'shared/bots/classic.js', 'shared/bots/defense.js', 'shared/bots/efficiency.js',
  'shared/bots/evaluate.js', 'shared/bots/faces.js', 'shared/bots/memory.js', 'shared/bots/okey101.js',
];

self.addEventListener('install', e => {
  // one missing file must not block the rest: cache what loads
  e.waitUntil(caches.open(VERSION).then(c => Promise.all(CORE.map(u => c.add(u).catch(() => null)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k.startsWith('okey-') && k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const req = e.request, url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith(fetch(req).then(res => {
    if (res.ok && res.type === 'basic') { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req, { ignoreSearch: true }).then(hit => hit || (req.mode === 'navigate' ? caches.match('index.html') : Response.error()))));
});
