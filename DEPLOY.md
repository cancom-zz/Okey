# Deploying Okey to Cloudflare

Same setup as daily-puzzles: a Worker with static assets and Durable Objects. No build step.

## One-time setup (Cloudflare dashboard, about 5 minutes)

1. **Workers & Pages → Create → Import a repository**, authorise GitHub, pick `cancom-zz/Okey`.
2. **Project name:** `okey` (must match `"name"` in `wrangler.jsonc`; if you choose another, change it there).
3. Fill in the form:

   | Field | Value |
   |---|---|
   | Build command | *(leave empty)* |
   | Deploy command | `npx wrangler deploy` |
   | Non-production branch deploy command | `npx wrangler versions upload` |
   | Builds for non-production branches | on |

4. **Deploy.** `wrangler.jsonc` publishes `site/` as static files, runs `worker/index.js` for `/api/*`, and
   creates the `Room` and `Stats` Durable Objects (SQLite-backed, free plan) on the first deploy.
5. **Settings → Domains & Routes:** turn on the Production `workers.dev` address, or attach a custom domain.

Every push to the production branch redeploys. Other branches get a preview URL, handy for playtesting.

## Checks after the first deploy

| Check | Expected |
|---|---|
| Open the site | The home screen, in Turkish |
| "Botlara karşı oyna" | A solo game starts instantly (runs in the browser) |
| "Arkadaşlarla oyna" | A table code and link; opening the link on a second device shows the same table |
| `POST /api/rooms` | `{ "code": "ABC234" }` |
| Response headers of `/` | `content-security-policy`, `x-content-type-options: nosniff` (from `site/_headers`) |
| 📊 → Çevrimiçi after a round with friends | Your rounds, recorded by the server |
| 📊 → Başka cihaza taşı → Kod oluştur | An 8-character code; entering it on another device moves your identity |

## Optional settings

| Variable (Settings → Variables) | What it does |
|---|---|
| `ALLOWED_ORIGINS` | Extra origins allowed to open tables and call the API, comma-separated (e.g. a second custom domain). The site's own address and `localhost` are always allowed. |

Rate limits, transfer codes and stats live in the `Stats` Durable Object: nothing to set up.

## Tests (CI runs all of them on every push)

| Command | What |
|---|---|
| `npm test` | engines, bots, host, achievements, Stats DO logic, no-leak security tests (classic + 101) |
| `npx wrangler deploy --dry-run --outdir /tmp/okey-dryrun` | the Worker bundles |
| `node test/layout.pw.mjs` | Playwright: layouts at phone/laptop sizes, practice matches end to end |
| `node test/online.pw.mjs` | Playwright against `npx wrangler dev`: two browsers play a classic round and some 101 online, no hidden tile reaches either; stats recorded; transfer code; Origin check; CSP; solo practice in a Web Worker |

Locally: `npm install`, then `npx playwright install chromium` once.

## Problems

| Problem | Fix |
|---|---|
| Deploy failed | Build command must be empty; deploy command `npx wrangler deploy`. Retry. |
| Friends' tables don't connect | Check `/api/rooms/<code>` returns JSON; WebSockets need the Worker route, not a static-only deploy. |
| Tables or the API answer 403 on a custom domain | The page's address must match the Worker's; add the other origin to `ALLOWED_ORIGINS`. |
| The address doesn't load | Settings → Domains & Routes: the Production `workers.dev` switch must be on. |

## Before going public (not code)
- Trademark check on the final name (never "Rummikub" or lookalikes).
- Ko-fi: same page as The Felt (https://ko-fi.com/thefelt).
