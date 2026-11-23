# Okey — project context

Turkish Okey in the browser: classic Okey and 101 Okey, with friends by link and/or fair bots. No app, no
login, no money. Owner: Can (same owner as The Felt and daily-puzzles). Prefers direct, opinionated answers
and will correct inaccuracies quickly.

**DESIGN.md is the contract** (tiles, rules, events, views, protocol, host, bots, stats). Read it before
changing any interface, and update it in the same commit as the code.

## Owner decisions (Nov 23, 2026)
- "Simple multiplayer, no app no login, simple fast secure play." → PWA + device identity (random id + secret
  in localStorage, claimed on first use server side). A device "transfer code" later instead of accounts.
- Human players and bots. Bots customizable beginner → expert (Çırak, Kalfa, Usta, Uzman + custom sliders).
  "Feel very natural." Experts strategize and remember more. **Bots never cheat** (no pile order, no other
  hands), **never collude**, and even the best has imperfect memory. Enforced structurally: a bot gets exactly
  `viewFor(match, seat)` (seat kinds stripped) and that seat's events; tests check it.
- Turkish first (default), English second. Every user-visible string goes through `t()` (site/i18n).
- "Fancy, skeuomorphic design, great animations especially on tiles, set up and finishing moves." Use The
  Felt's look and quality bar (felt with grain, wood, gold, serif display, sheets, toasts, celebrate,
  one screen that never scrolls on real phone heights ~550–660 px).
- Variants: **classic + 101 Okey now** (Can chose both).
- Chat: **emotes + preset quick phrases** only (no free text; nothing to moderate).
- Tables: **private links only** for now (`/#/m/CODE`); empty seats filled by bots. Public tables later.
- Statistics and achievements planned from the start (server-recorded so they can't be faked).
- No money changes hands. Ko-fi from day one: **https://ko-fi.com/thefelt** (same page as The Felt), with
  The Felt's polite tip-ask rules (between rounds only, not in the first 10 minutes, after a good moment or 30
  more minutes, 2 days apart, back-from-Ko-fi "did you tip?" once, never again once tipped). Tips never
  affect the game.

## Legal / naming
- "Rummikub" is a registered trademark: never use it (or lookalikes) anywhere shipped. "Okey" and "101 Okey"
  are traditional game names. No copied artwork or logos.
- Play only: no stakes, no prizes, nothing to buy.

## Architecture (details in DESIGN.md)
- Cloudflare Workers + Durable Objects (like daily-puzzles). `site/` is static; `worker/index.js` routes
  `/api/*`; one `Room` DO per table (WebSocket Hibernation API), one `Stats` DO.
- `site/shared/` is pure code used by both the worker and the browser: `okey/` (classic engine), `okey101/`
  (101 engine), `bots/`, `host.js` (TableHost: the whole room protocol with no I/O).
- The server is authoritative. A client only receives its own seat's view; buried discards and the pile order
  are never sent to anyone.
- Solo practice runs the same TableHost in the page (`site/js/local.js`): works offline and inside a
  claude.ai artifact for playtesting. Practice results never reach server stats.

## Tests
- `npm test` (= `node --test test/*.test.mjs`): engine, 101 engine, bots, host (incl. the no-leak security
  test that checks every message against the true match).
- `node test/layout.pw.mjs`: Playwright (pre-installed Chromium) screenshots + no-scroll/off-screen checks at
  phone, landscape-phone and laptop sizes (shots in test/shots/, gitignored).
- CI: `.github/workflows/tests.yml`.

## Deploy
See DEPLOY.md. Build command empty, deploy command `npx wrangler deploy`.
