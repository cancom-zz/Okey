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

## Problems

| Problem | Fix |
|---|---|
| Deploy failed | Build command must be empty; deploy command `npx wrangler deploy`. Retry. |
| Friends' tables don't connect | Check `/api/rooms/<code>` returns JSON; WebSockets need the Worker route, not a static-only deploy. |
| The address doesn't load | Settings → Domains & Routes: the Production `workers.dev` switch must be on. |

## Before going public (not code)
- Trademark check on the final name (never "Rummikub" or lookalikes).
- Ko-fi: same page as The Felt (https://ko-fi.com/thefelt).
