# Okey: design contract

This file is the contract every part of the codebase follows. If you change an interface here, change it
everywhere and update this file in the same commit.

## Goals

- Classic Turkish Okey (4 seats, 106 tiles), playable in the browser with friends and/or bots.
- No app, no login. Open a link, pick a name, play. Installable as a PWA (Add to Home Screen).
- Fast and secure: the server is authoritative. A client only ever receives what its seat may see.
- Bots from beginner to expert that play like people and **never cheat**: a bot gets exactly the same view a
  human in that seat gets (same projection function), plus the same public event stream, and it has an
  imperfect, decaying memory. Bots never share state, never know which seats are bots, never collude.
- Turkish first, English second. Every user-visible string goes through i18n.
- Skeuomorphic: green felt, wooden ıstaka (two-tier rack), ivory bakelite tiles with engraved numbers,
  great animations (deal, indicator flip, draw, discard, finish reveal, match end).
- Statistics and achievements, recorded by the server (so they can't be faked).
- No money. A Ko-fi link only (`KOFI_URL` in `site/js/config.js`).

## Stack (same as daily-puzzles)

- Cloudflare Workers + Durable Objects, deployed with `npx wrangler deploy`. No build step on Cloudflare.
- `site/` is published as static files. Plain ES modules, no framework, no bundler for the client.
- `worker/index.js` answers `/api/*`. One `Room` Durable Object per table (WebSocket Hibernation API).
  One `Stats` Durable Object (SQLite) for player stats and achievements (phase 2).
- Tests: `node --test` (Node 22). No test framework dependency.

## Layout

```
site/                      static, public
  index.html               single page app (home, lobby, table)
  css/                     styles (felt, rack, tiles, animations)
  js/                      client code (app.js entry, net.js, table.js, rack.js, anim.js, i18n.js, config.js, sound.js)
  i18n/tr.js, i18n/en.js   string tables (export default { key: 'text' })
  shared/okey/             rules engine, pure, used by BOTH the worker and the client
    tiles.js rules.js game.js rng.js index.js
  shared/okey101/          101 Okey engine, same API shape (game.js rules.js index.js; tiles/rng from okey/)
  shared/bots/             bot brains, pure (index.js exports createBot)
  shared/host.js           TableHost: the room protocol (seats, bots, timers, views) with no I/O
  js/local.js              LocalTable: runs a TableHost in the browser for solo practice vs bots
worker/
  index.js                 routing
  room.js                  Room Durable Object: a TableHost + WebSockets + storage
  stats.js                 Stats Durable Object (phase 2)
test/                      node --test files (engine, bots, host) + Playwright tests (*.pw.mjs)
```

The worker imports from `../site/shared/...` (wrangler bundles it).

### One host, two transports

`TableHost` (site/shared/host.js) holds a room: seats, settings, the match, bots, timers. It has no I/O.
It is driven through injected functions:

```js
new TableHost({ code, settings, now: () => ms, schedule: (atMs | null) => void, send: (connId, msg) => void,
                close?: (connId, code, reason) => void, rng: { int(n) }, onResult?: (summary) => void, saved?,
                engine?, createBot? })      // engine/createBot: injectable for tests (default: the real modules)
host.connect(connId) -> bool               // false: room full (12 sockets); the socket got error 'full' and close()
host.disconnect(connId) / host.message(connId, msg) / host.wake()  // wake: scheduled time reached
host.snapshot() -> JSON                    // persist when host.dirty (then clear it); restore with `saved`
host.bind(connId, playerId | null)         // after a restore: re-attach a live socket (sends nothing)
host.pauseIfEmpty()                        // after a restore + binds: no socket left -> timers paused
host.playerOf(connId) -> playerId | null   // keep it in the socket's attachment so bind() can rebuild the map
host.summary() -> { code, phase, settings, seats: [{ kind, name, avatar, connected, bot }], connections }
host.nextWakeAt() -> ms | null
```

- `schedule(at)` always carries the single earliest pending time and replaces the previous one; `null` means
  nothing is pending. Timers: a bot's move (after `bot.delayMs`), a human's turn deadline, auto-play of an
  away seat, the next round. With no socket connected the room is **paused** (no timers); when a socket
  connects again every deadline is shifted by the pause, so nobody times out while the room is empty.
- The connection -> seat map is not in the snapshot: a seat belongs to a player id, and each socket's player
  id lives in the transport (the Room DO's WebSocket attachment). After a restore the transport calls
  `bind(connId, playerId)` for each live socket, then `pauseIfEmpty()`.
- A bot decides when it becomes its move (`delayMs(view)` then `decide(view)` on the same view); the action
  is stored in the snapshot and played at the deadline, so a restore replays exactly. A bot sees
  `viewFor(match, seat)` with `seats[].kind/bot/id` removed (bots never know seat kinds) and is fed
  `eventsFor(events, seat)`. An illegal or missing bot action falls back to `timeoutAction`.
- `onResult(summary)` fires at every round end (`type: 'round'`) and at match end (`type: 'match'`, right
  after the last round's): `{ type, code, match, round, at, winner, kind, okeyFinish, winners, seats: [{ seat,
  kind, playerId, secret, name, botLevel, won, finish, okeyFinish, delta, score, turns, showedIndicator }] }`.
  `delta` is the seat's total score change in that round (indicator penalties included); `secret` lets the
  Stats DO check the id. Never sent to clients.
- Exports used by clients: `AVATARS`, `BOT_AVATAR`, `LEVELS`, `EMOTES` (must equal `site/js/config.js`; a test
  checks), `BOT_PARAM_RANGES`, `cleanName`, `cleanSettings`.

- **Online:** the Room DO wraps a TableHost; `send` writes to the WebSocket, `schedule` sets the DO alarm,
  `snapshot` goes to DO storage, `rng` is crypto-backed, `onResult` writes stats.
- **Solo practice:** `site/js/local.js` wraps a TableHost in the page with `setTimeout`. Same protocol, same
  bots, same views. Works offline and inside a claude.ai artifact (playtest). Practice results are local
  only and never count toward server stats. `createSoloTable({ name, avatar, levels: [l1, l2, l3], settings?,
  autoStart = true, resume = false, onResult? })` returns a `LocalTable` that, on `connect()`, says hello,
  sits you in seat 0 (host), adds the three bots and starts. It saves its snapshot in localStorage
  (`okey.solo`) after every change; `hasSoloTable()` says whether one can be resumed
  (`createSoloTable({ ..., resume: true })`). Messages are delivered asynchronously, as JSON copies.

The client talks to either through one interface (`site/js/net.js`): `connect()`, `send(msg)`,
`onmessage(msg)`, `close()`.

## Tiles

A tile is an integer id `0..105`.

- `id < 104`: `color = Math.floor(id / 26)`, `num = (id % 13) + 1`, `copy = Math.floor((id % 26) / 13)`.
- `104`, `105`: the two false jokers (sahte okey).
- Colors, index order: `0 red (kırmızı)`, `1 yellow (sarı)`, `2 blue (mavi)`, `3 black (siyah)`.
- Two tiles have the same *face* when color and num are equal (the two copies).

Indicator (gösterge) and okey:

- After dealing, one tile from the pile is turned face up: the **indicator**. It may not be a false joker
  (engine: a random position among the undealt tiles; if it holds a false joker, the next position). The
  indicator is **removed from the pile** and sits face up beside it; it is never drawable. The pile starts at
  106 - 15 - 3 x 14 - 1 = **48** tiles.
- The **okey** (joker) is the tile of the same color and `num = indicator.num % 13 + 1` (13 → 1).
  Both copies of that face are okeys: fully wild.
- The **false jokers** stand for the okey's face (they are *not* wild; they play as that color and number).

Engine helpers (`tiles.js`): `COLORS`, `TILE_COUNT`, `FALSE_JOKERS`, `isFalseJoker(id)`, `isTile(id)`,
`color(id)`, `num(id)`, `copy(id)` (color/num are `null` for false jokers), `tileId(color, num, copy = 0)`,
`otherCopy(id)`, `allTiles()`, `okeyFace(indicatorId) -> { color, num }`, `isOkey(id, okey)`,
`faceOf(id, okey) -> { color, num, wild }` (okey -> wild true; false joker -> the okey face, wild false;
normal -> its own face), `sameFace(a, b, okey)` (identical non-wild faces).

Randomness (`rng.js`): `cryptoRng() -> { int(n) }` (crypto.getRandomValues + rejection sampling),
`seededRng(seed: number | string) -> { int(n), random(), state() }` (mulberry32, for tests and bots;
`seededRng(r.state())` resumes a sequence), `shuffle(arr, rng) -> new array` (Fisher–Yates, input untouched).

## Sets and finishing

- **Run (seri):** 3+ tiles, same color, consecutive numbers. `12-13-1` is allowed (1 after 13);
  `13-1-2` is not. Max length 13.
- **Group (per):** 3 or 4 tiles, same number, all different colors.
- Okeys substitute any tile in either.
- **Normal finish:** after drawing, a player holds 15 tiles. They discard one to the center (instead of to the
  right) and the remaining 14 must split entirely into valid sets.
- **Pairs finish (çift):** the remaining 14 are 7 pairs of identical faces. An okey pairs with anything.
- **Okey finish:** the finishing discard is an okey. Scores double.

Engine (`rules.js`):

- `validSet(ids, okey) -> 'run' | 'group' | null` (ids unordered).
- `isPair(a, b, okey)`: identical faces, or at least one okey.
- `findFinish(ids14, okey) -> { kind: 'sets' | 'pairs', groups: number[][] } | null` (exhaustive backtracking
  with memo; ~0.02 ms average, a few ms worst case; prefers 'sets' if both work).
- `bestFinish(ids14, okey)`: same, but prefers the higher-scoring 'pairs' when both work. **A finish is always
  scored with bestFinish.**
- `partitionKind(groups, ids, okey) -> 'sets' | 'pairs' | null`: is `groups` an exact partition of `ids`?
- `finishOptions(ids15, okey) -> [{ discard, kind, okeyFinish, groups }]`: one entry per finishing discard id
  (both copies of a face are listed separately); `kind` is the bestFinish kind; `groups` exclude the discard.
- `arrange(ids, okey, mode: 'runs' | 'groups' | 'pairs') -> number[][]` (client "sort" buttons, bots): sets that
  cover as many tiles as possible (ties: more tiles in the preferred kind, which is listed first), then
  **always one trailing leftovers array** (possibly empty). Runs are in playing order with okeys in the gap they
  fill. 'pairs': as many pairs as possible (okeys pair with singles), then leftovers.

`arrangeRack(ids, okey, mode: 'runs' | 'pairs') -> { sets, partials, singles }` is the rack sort behind
"Seri diz" / "Çift diz": the most tiles in sets (runs and groups; ties go to the better leftovers), then
near-sets one tile short (two of a number in different colours, neighbours or a one-gap in one colour, twins),
chosen as a maximum-weight matching by how many faces would complete each, then the true singles together.

## Round flow

1. Seats `0..3` in **turn order** (turn passes to `seat + 1 mod 4`, counter-clockwise at a real table: the
   next player sits on your right).
2. Shuffle 106 tiles with a CSPRNG (`crypto.getRandomValues`, rejection sampling, Fisher–Yates).
3. Dealer gets 15 tiles, others 14. Indicator is turned up. The rest is the pile (closed, order secret).
4. Dealer starts by discarding (no draw). Each later turn: **draw** (from the pile, or the top tile of the
   previous player's discard stack), then **discard** onto your own discard stack (it sits at your right,
   which is the next player's left) or **finish**.
5. Discard stacks: only the top tile of each stack is visible. Buried tiles are not sent to anyone
   (memory is a skill). The view sends `top` and `count` per stack.
6. **Showing the indicator:** during their first turn of a round (it is their turn, in either stage, and they
   have not discarded yet this round), a player holding the indicator's other copy may show it once
   (`showIndicator`). The others lose the points immediately.
7. Pile runs out: the round ends with no winner and no score as soon as a discard passes the turn to a player
   while the pile is empty (that player would have to draw). Whoever drew the last pile tile still discards or
   finishes normally.
8. Dealer rotates to `dealer + 1` each round.

## Scoring (defaults; all in `settings.scoring`)

Each player starts at `startPoints: 20`. Points only go down; at match end the highest score wins.

| Event | Every *other* player loses |
|---|---|
| Normal finish | 2 |
| Finish by discarding an okey | 4 |
| Pairs finish | 4 |
| Pairs finish discarding an okey | 8 |
| Showing the indicator | 1 |

The match ends when any score reaches 0 or below, or after `settings.rounds` rounds if set (default:
play to 0). Ties are shared.

Engine details: `settings.scoring = { normal: 2, okey: 4, pairs: 4, pairsOkey: 8, indicator: 1 }` (partial
overrides are merged with these defaults; `DEFAULT_SETTINGS` = `{ turnSeconds: 30, rounds: null,
startPoints: 20, scoring }`). A finish is scored as the best kind its 14 tiles allow (pairs if possible). A
false joker is not an okey: discarding one is not an okey finish. The match-end check runs only at round end
(a shown indicator never cuts a round short). `rounds` counts every round, including pile-exhaustion rounds.

## Game state machine (`game.js`)

Pure, deterministic given the injected `rng` (`{ int(n) -> 0..n-1 }`). Never mutates input; returns new
state.

```js
newMatch({ settings, seats: [{ id, name, kind: 'human' | 'bot' | 'empty', bot?, avatar? }] x4,
           code?, dealer? = 0 }) -> match       // phase 'lobby', no round yet; dealer = first dealer
startRound(match, rng) -> { match, events }     // from 'lobby' or 'roundEnd'; round k dealt by (dealer + k - 1) % 4
nextRound(match, rng) -> { match, events }      // same, only from 'roundEnd' ('matchEnd' -> GameError roundOver)
act(match, seat, action) -> { match, events }   // throws GameError(code) on illegal action
viewFor(match, seat | null) -> view             // seat null = spectator
eventsFor(events, seat | null) -> events        // routing: what that seat (or a spectator) may receive
timeoutAction(match, seat) -> action | null     // auto-play: draw from pile; finish if possible, else discard
                                                // an arrange() leftover (never an okey if avoidable)
isLegal(match, seat, action) -> bool            // dry run of act
tileLocations(match) -> [location x 106]        // sanity check: throws if a tile is in two places
class GameError extends Error { code }
```

The match is plain JSON (persist it as is): `{ v, code, phase, settings, seats, scores, firstDealer,
roundNumber, round, result, winners, history }`. `phase`: `'lobby' | 'playing' | 'roundEnd' | 'matchEnd'`.
`round` holds the secret state (`pile` with top = last, `hands`, `discards` with top = last, `indicator`, `okey`,
`turn`, `stage`, `firstTurn`, `showed`, `turns` = completed turns per seat, `center` = the finishing discard).
`v` increases by 1 per change. `history`: per round `{ round, winner, kind, okeyFinish, deltas }`. Every
tile is always in exactly one place: a hand, the pile, a discard stack, the indicator, or the center.

Actions: `{ type: 'draw', from: 'pile' | 'discard' }`, `{ type: 'discard', tile }`,
`{ type: 'finish', tile, groups? }` (`groups` optional: the client's layout, kept for the reveal when it is a
valid partition of the remaining 14 of the best-scoring kind; otherwise the server's `bestFinish` groups are
used; no finish at all -> `cannotFinish`), `{ type: 'showIndicator' }`.

Error precedence: phase not 'playing' -> `roundOver`; seat not an integer 0..3 -> `notYourTurn`; malformed
action or unknown type -> `badAction`; not your turn -> `notYourTurn`; then the action's own checks.
`emptyDiscard` cannot happen in normal play (a stack is only emptied by the next seat, who then discards).

Error codes (i18n keys `err.<code>`): `notYourTurn`, `mustDraw`, `mustDiscard`, `noTile`, `emptyDiscard`,
`cannotFinish`, `cannotShow`, `badAction`, `roundOver`.

Events (public unless `to` is set; `to` events go only to that seat; a public event with `except: s` is not
sent to seat `s`. `eventsFor(events, seat)` applies these rules):

```
{ type: 'roundStart', round, dealer, indicator, pileCount }
{ type: 'dealt', to: seat, hand }                        // private
{ type: 'draw', seat, from: 'discard', tile }            // public
{ type: 'draw', seat, from: 'pile', except: seat }       // public, but not sent to the drawer...
{ type: 'draw', seat, from: 'pile', tile, to: seat }     // ...who gets this private copy instead
{ type: 'discard', seat, tile }
{ type: 'showIndicator', seat, tile }
{ type: 'finish', seat, tile, kind, okeyFinish, groups, hands }   // hands: every seat's hand revealed
{ type: 'pileEmpty', hands }                             // round over, no winner; hands revealed
{ type: 'score', deltas: [d0, d1, d2, d3], scores: [...] }
{ type: 'matchEnd', scores, winners: [seat...] }
```

## View (what a client or bot receives)

```js
{
  v,                          // state version, increases by 1 per change
  code,                       // room code
  phase: 'lobby' | 'playing' | 'roundEnd' | 'matchEnd',
  settings: { turnSeconds, rounds, scoring: {...}, startPoints },
  host,                       // seat index of the host, or null
  you,                        // your seat index, or null for a spectator
  seats: [ {                  // always 4, in seat order
    kind: 'empty' | 'human' | 'bot',
    name, avatar,             // avatar: emoji or preset id
    connected, away,          // away: timed out / auto-playing
    bot: { level } | null,
    score,
    handCount,
    discard: { top: tileId | null, count },   // this seat's discard stack (to its right)
    showedIndicator,
    ready                     // roundEnd/matchEnd: pressed next (bots always true); false otherwise
  } x4 ],
  round: null | {
    number, dealer, turn, stage: 'draw' | 'discard',
    indicator, okey: { color, num },
    pileCount,
    turnEndsAt,               // epoch ms, server clock
    firstTurn: [bool x4]      // still in first turn (indicator may be shown)
  },
  hand: [tileIds] | null,     // only yours, unordered: the client owns rack layout
  result: null | { winner, kind, okeyFinish, tile, groups, hands, deltas, scores, turns },
                              // winner/kind/tile/groups null after pile exhaustion; turns: completed turns per seat
  winners: null | [seat...],  // set at 'matchEnd'
  now                         // server epoch ms, for clock sync
}
```

`viewFor(match, seat)` builds everything it can from the match; the host-owned fields (`host`, `seats[].connected`,
`seats[].away`, `round.turnEndsAt`, `now`) come out as defaults (`null`, `connected` from the seat object or
`true`, `away` from the seat object or `false`) for TableHost to overwrite. `seats[].bot` is only `{ level }`
(never params). During `roundEnd`/`matchEnd`, `round` still describes the finished round (discard tops etc.).

The client keeps the rack layout (which slot each tile sits in) locally, keyed by room + round, so a
reconnect restores it.

## Network protocol (WebSocket, JSON)

- `POST /api/rooms` body `{ settings? }` -> `{ code }` (400 on bad settings, 429 when one IP creates too many).
  Codes are 6 characters from `ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (crypto random). Lower case is accepted.
- `GET /api/rooms/:code` -> `host.summary()` for the join screen (404 if no such room; no hidden information).
- `GET /api/rooms/:code/ws` upgrades to a WebSocket handled by the Room DO (404 if no such room).
- `GET /api/stats/:playerId` -> `{ name, stats, achievements: [{ id, at }] }` (404 when none yet).

Client -> server:

```
{ t: 'hello', player: { id, secret, name, avatar }, lang }   // first message; id/secret = device identity
{ t: 'sit', seat }            { t: 'stand' }
{ t: 'addBot', seat, level, params? }   { t: 'removeBot', seat }     // host only, lobby only
{ t: 'settings', settings }   { t: 'start' }                          // host only
{ t: 'act', action, v }       // game action; v = view version it was based on (stale -> error 'stale')
{ t: 'emote', id }            // preset emotes only, no free chat (safe by design), rate limited
{ t: 'next' }                 // ready for next round / rematch
{ t: 'ping' }
```

Server -> client:

```
{ t: 'view', view, events }   // full view for this socket's seat + events since its last view
{ t: 'emote', seat, id }
{ t: 'error', code }
{ t: 'pong', now? }           // online, {"t":"ping"} is answered at the edge without `now`: use view.now
```

Semantics (TableHost):

- Nothing is sent before a valid `hello`. `hello` may be repeated with the same id + secret to change name or
  avatar. `name`: control/invisible characters removed, spaces collapsed, 1–20 visible characters (graphemes),
  at least one letter, digit or symbol; else `badName`. `avatar` not in `AVATARS` -> `AVATARS[0]`.
  `id`/`secret`: `[A-Za-z0-9_-]{8,64}`. The first `hello` for an id claims its secret in this room.
- Each change (any seat, the match, connected/away/ready) sends every socket its own `view` (v + 1) and the
  events of that change filtered for its seat (`eventsFor`: `to` only to that seat, `except` not to it).
- Seating (`sit`, `stand`, `addBot`, `removeBot`, `settings`) is allowed in `lobby` and `matchEnd`; doing it at
  `matchEnd` goes back to the lobby. The first human to sit is the host. The host passes to another human
  (connected first) when the host stands up, or to a connected human when the host disconnects.
  `removeBot` also removes a human whose socket is gone (so the table can fill again). `start` needs 4 seats.
- `settings` is a partial update (`variant` `'classic'` | `'101'`, see "101 Okey" for its keys): `turnSeconds` 0 (no timer) or 10–120; `rounds` null/0 (play to 0) or 1–99;
  `startPoints` 1–99; `scoring` keys -> ints 0–99. Bot `params` are checked against `BOT_PARAM_RANGES`.
- `act`: `v` must be at least the version of the last game change (and not above the current one), else
  `stale`. Engine errors come back as their codes. Any `act`, `next` or `emote` clears `away`.
- Turn timer: `turnSeconds` per turn (draw + discard). On timeout the whole turn is auto-played and the seat is
  `away`. After 2 consecutive timeouts the seat is auto-played 1 s into each of its turns until the human acts.
  With `turnSeconds: 0`, a disconnected human still gets 30 s.
- Round end: the next round starts when every connected human pressed `next`, or after 20 s. Match end:
  `next` is a rematch vote; when every connected human voted, a new match starts with the same seats.
- `emote`: seated players only, ids from `EMOTES`, at most one per 1.5 s.

Error codes (i18n `err.<code>`), besides the engine's: `stale`, `rateLimited`, `badMessage`, `helloFirst`,
`badName`, `badIdentity` (id claimed by another secret), `replaced` (a newer socket took this identity; the
socket is closed), `full` (12 sockets), `notHost`, `notSeated`, `seatTaken`, `badSeat`, `wrongPhase`,
`seatsNotFull`, `badSettings`, `server`.

## Security rules (server)

- Never send another seat's hand, the pile order, or buried discards, to anyone, at any time, until the
  round ends (then hands are revealed in `result`).
- A seat is bound to a device `id` + `secret` (secret claimed on first use, checked afterwards). Reconnecting
  with the same identity takes the seat back.
- Validate every message: shape, sizes (name 1–20 visible chars), rate limit (20 msgs/s burst, 5/s steady),
  max 1 socket per identity per room, max 12 sockets per room (4 seats + spectators).
- Turn timer (`turnSeconds`, default 30, bots excluded): on timeout the server plays `timeoutAction` and marks
  the seat `away`; the human gets the seat back on any action.
- Rooms are deleted by an alarm after 30 minutes without connections. Frames over 4096 characters or invalid
  JSON are rejected (`badMessage`); messages over 2000 characters once parsed too.
- Views are built field by field (whitelist), never by passing engine objects through.

## Bots (`site/shared/bots/`)

```js
import { createBot, LEVELS, LEVEL_IDS, resolveParams } from './bots/index.js';
createBot({ level, params?, seed, saved? }) -> bot   // saved: a bot.snapshot() (JSON), restores everything
bot.observe(event)            // the events its seat receives: eventsFor(events, seat)
bot.delayMs(view) -> ms       // thinking time for this view (0 when it is not its move)
bot.decide(view) -> action | null   // null when it is not its move; same decision delayMs timed (cached by view.v)
bot.snapshot() -> JSON        // level, params, RNG state, memory, per-round state
bot.level, bot.params         // resolved (clamped) params
```

`view` is `viewFor(match, seat)` with the seats' `kind`/`bot`/`id` removed (host `botView`). A bot reads only:
`phase, you, hand`, `round.{number, turn, stage, indicator, okey, pileCount, firstTurn}`,
`seats[i].{discard.top, showedIndicator}`. It never reads names, kinds or levels, never writes to the view,
and has no other input (no match state, pile, other hands or other bots). `test/bots.test.mjs` plays games
through a Proxy view that throws on any other field and on any write.

Files: `faces.js` (face indices 0..51, wild okeys apart), `evaluate.js` (hand value, outs, one-draw
look-ahead), `memory.js` (imperfect event memory; understands classic `draw` and 101 `take`/`undoTake`) and
`defense.js` (what the next player seems to collect) are variant-neutral; `classic.js` is the classic turn
policy, `okey101.js` the 101 one; `index.js` holds levels and `createBot`. **One brain plays both variants:**
`decide`/`delayMs` pick the policy from `view.settings.variant`, with separate per-variant state (both in the
snapshot), so the API is the same. No module-level mutable state: each bot owns its seeded RNG (`seededRng`,
state in the snapshot), memory and round state. No `Math.random`.

**Levels** (`LEVELS[id] = { id, name (tr), en, params }`, frozen, ladder order in `LEVEL_IDS`):

| id | name | memory | decay | lookahead | defense | pairsBias | blunder | takeDiscard | gamble | speed |
|---|---|---|---|---|---|---|---|---|---|---|
| `cirak` | Çırak | 0.25 | 0.12 | 1 | 0 | 0.85 | 0.25 | 0.7 | 0 | 1.35 |
| `kalfa` | Kalfa | 0.5 | 0.07 | 2 | 0.3 | 0.95 | 0.12 | 0.6 | 0 | 1.15 |
| `usta` | Usta | 0.7 | 0.04 | 3 | 0.6 | 1 | 0.06 | 0.4 | 0.1 | 1.0 |
| `uzman` | Uzman | 0.85 | 0.02 | 4 | 0.85 | 1 | 0.02 | 0.3 | 0.25 | 0.9 |

Custom bots override any param; `resolveParams` clamps every bot, custom ones included: memory ≤ 0.9,
decay ≥ 0.005, lookahead 1..4, speed 0.25..3, the rest 0..1 (pairsBias 0..2). Unknown level → `kalfa`.

- `memory`: chance to remember each public fact when it happens (own discards: `memory + (1-memory)/2`);
  `decay`: chance per turn (each discard) to forget each remembered fact. Facts, per round: tiles discarded
  (dead) or picked up / shown (held by someone), and per seat what it picked up from its left stack, what it
  threw, and which tops it passed on. Stack tops and the indicator are on the table, so always counted.
  `live[face]` = 2 − own copies − visible − remembered gone: the outs it believes are left.
- `lookahead`: 1 = sets, partials and pairs only (a partial is a partial, no outs); 2 = partials valued by
  live outs and loose tiles by live neighbours (dead waits are dropped); 3 = plus one draw ahead: expected gain
  of the next pile draw for the discards close to the best and for the take-or-draw choice; 4 = the same,
  looking at twice as many discard candidates.
- `defense`: penalty for discarding what the next player (seat + 1, the only one who can take it) seems to
  collect, inferred from its remembered pickups (neighbours in a run, same number in a group); a small bonus
  for faces it passed on or threw; grows as the pile shrinks and as it picks up more; capped so it never
  makes a bot break a complete set.
- `pairsBias`: weight of the pairs route against the sets route.
- `blunder`: chance of a plausible slip: the best discard that is actually worse but within 1 point of value
  (breaks a partial, never a complete set while a loose tile exists, never an okey); half as often, missing a
  good discard pickup; forgetting to show the indicator.
- `takeDiscard`: readiness to take the previous player's discard (threshold on the value gain).
- `gamble`: with a finish in hand, an okey in it and ≥ 20 tiles in the pile, the chance to hold one more
  turn for an okey finish (double) when it believes ≥ 5 live tiles would allow it.
- `speed`: thinking-time multiplier. `delayMs` = base by move (draw 750, discard 1000, show 1000, finish
  1700, 101 open 1400, 101 table step 800 ms) × (1 + 0.9 × how close the call was) + 500 on a first
  discard; in 101 × 1.4 for the first step of a turn, × 0.55 for later table steps (× 0.7 for the final
  discard); then × speed × jitter 0.85..1.15, clamped to 350..4000 ms.

Always: finishes when it can (highest-scoring option: pairs+okey > pairs = okey > normal), takes a discard
that finishes or is an okey, never discards an okey otherwise, never throws back the tile it just took.

Strength (test/bots.test.mjs, 160 rounds, one bot of each level per table, every level in every seat):
round wins Çırak 9%, Kalfa 16%, Usta 34%, Uzman 37%. (800 rounds: 12 / 20 / 32 / 33%.)

**101 policy** (`okey101.js`, one action per `decide`; the host calls it again after each step). The view
adds `round.{table, opened, required, taken}`, `seats[i].handCount` and the public 101 settings
(`openingValue`, `minPairs`, `aceHighValue`, `pairsOpening`, `pairsOnly`, `pairsCanAdd`, `addOnOpeningTurn`,
`okeySwap`); table melds count as visible tiles in the live table.

- Draw: take the previous player's discard only when it reaches the table this turn (opens with it when not
  opened, else lays it off, takes an okey back with it, or completes a new set/pair); otherwise the pile.
  The plan is fixed before taking, so `undoTake` is only a fallback (never needed in tests). Blunder: half as
  often, missing a good take.
- Opening: with sets ≥ `required.value` (all of `bestSets`), else with pairs ≥ `required.pairs`. Beginners
  open as soon as they can. With `lookahead` ≥ 3 a bot waits for sets instead of a pairs opening (a pairs
  opener's hand counts double) while the pile has > 10 tiles, the round looks safe and sets are within 25.
  With `gamble`, it may hold a sets opening that would leave 2–4 tiles, hoping to open and finish in one
  turn (elden, double), only with ≥ 10 tiles in the pile and no opponent close to finishing.
- After opening, in order: take okeys back (`swapOkey`), lay new sets (pairs openers: pairs, okeys only
  when nearly out), lay off real tiles (highest first), then okeys: the last okey is kept to finish with
  (double); with one other tile left, `gamble` may keep the okey one more turn; otherwise okeys go to the
  table when the round looks close to ending or few tiles are left. Beginners sometimes forget to lay off
  for a turn (blunder × 0.4).
- Discard: never an okey, never an işlek tile while a safe one exists (blunder × 0.1: a beginner's slip,
  101 penalty). Unopened: keep structure (the classic evaluation) and opening value (`bestSets` value), and
  throw low tiles first; with `lookahead` ≥ 3, also the expected opening value gained by the next draw over
  live faces (top 4 discards, 6 at lookahead 4). In pairs mode (pairs opener, or ≥ 4 pairs and weak sets):
  keep pairs and singles whose copy is live. Opened: shed high tiles more as the round nears its end (an
  opponent opened with few tiles, or a short pile). Defense as classic (pile start 20).
- Finish: discarding the last tile (an okey last doubles).

101 strength (penalty points, lower is better; one bot of each level per table, every level in every seat):
1,440 rounds: Çırak 67.4, Kalfa 58.6, Usta 54.8, Uzman 54.8 per round; the engine's auto-play alone ≈ 115.
test/bots101.test.mjs (216 rounds): Çırak 65.6, Kalfa 70.3, Usta 60.6, Uzman 30.2 (one round's ±202 swings
make small samples noisy; the test asserts Uzman ≥ 10% below Çırak and below Kalfa).

## 101 Okey (`site/shared/okey101/`)

A second engine with the **same API shape** as the classic `game.js` (`newMatch, startRound, nextRound, act,
viewFor, eventsFor, timeoutAction, isLegal, tileLocations, GameError, DEFAULT_SETTINGS`), so TableHost picks
it by `settings.variant` (`'classic'` default | `'101'`). Tiles, indicator, okey, false jokers and the
classic `validSet/isPair/arrange` are imported from `okey/` (not copied). Every rule choice is also listed at
the top of `okey101/game.js`. Lower is better: scores are penalty points starting at 0.

**Settings** (`DEFAULT_SETTINGS`, house rules are flags; partial overrides merge):

```js
{ variant: '101', turnSeconds: 30, rounds: 9 /* 1..11, always fixed */, startPoints: 0,
  openingValue: 101, minPairs: 5, aceHighValue: 1 /* 1 | 11 | 14 */, raiseOpening: false,
  pairsOpening: true, pairsOnly: true, pairsCanAdd: true, addOnOpeningTurn: true, okeySwap: true,
  scoring: { finish: 101, unopened: 202, okeyInHand: 101, islek: 101, okeyDiscard: 0 },
  doubles: { okeyFinish: true, elden: true, pairsFinish: true, pairsOpener: true } }
```

**Rules.**

- Deal: dealer 22 tiles, others 21; indicator out of the pile as classic → the pile starts at **20**. The
  dealer starts by discarding; dealer rotates; turn order and draw (pile, or the previous player's discard top)
  as classic. Stages: `'draw'` → `'discard'` (drawn: may play to the table, must end the turn by discarding).
- Sets: classic runs/groups (12-13-1 yes, 13-1-2 no), okeys wild, false jokers = the okey face.
- **Opening** (one `layDown` action): sets whose values total ≥ `openingValue` (a tile counts its number, an
  okey the number it stands for, the 1 after 13 counts `aceHighValue`), or ≥ `minPairs` pairs (identical
  faces; an okey pairs with anything) when `pairsOpening`. Sets and pairs never mix. `raiseOpening`: each
  later opener must beat the highest opening of the same kind so far (value + 1 / one more pair).
- **After opening:** sets openers lay only sets; pairs openers only pairs (`pairsOnly`) and may add to runs and
  groups (`pairsCanAdd`). Anyone opened may add tiles (**işleme**) to ANY run/group on the table (either end of
  a run, a group up to 4) and take an okey back (`okeySwap`) with the exact tile it stands for (run: its
  position; pair: the partner's face; group: any color not in it); the okey goes to the hand. Allowed on the
  opening turn too (`addOnOpeningTurn`). Unopened players cannot touch the table. A table action must leave at
  least one tile in hand (`mustKeepOne`).
- **Taking the discard** (`draw` from `'discard'`): the tile becomes `round.taken` (public) and must reach the
  table this turn. Until it leaves the hand, `discard`/`finish` fail with `mustUseTaken`; a player who had not
  opened must open with it (an opening without it is `mustUseTaken`). `undoTake` (only while it is still in
  hand) puts it back on the stack and restores the hand, the table and the opening exactly as before the take
  (stage back to `'draw'`), so nobody gets stuck.
- **Penalties during play** (to the discarder at once, `penalty` + `score` events): an **işlek** tile (could
  be added to a run/group on the table, or could take an okey back) costs `scoring.islek`, for every player,
  opened or not. An okey is işlek whenever a run or group can take it. `scoring.okeyDiscard` (0 = off) is an
  extra flat penalty for any okey discard; an okey discard pays the larger, never both. The finishing discard
  is never penalized.
- **Finishing:** discarding your last tile. Multiplier m (stacking): ×2 okey as last tile, ×2 **elden**
  (opened in this same turn), ×2 finisher opened with pairs (each a `doubles` flag).
- **Scoring:** finisher −`finish`×m; unopened `unopened`×m; opened: hand value×m (a tile counts its number,
  a false joker the okey's number, an okey `okeyInHand`), a pairs opener's ×2 again (`doubles.pairsOpener`).
  Pile exhaustion (same trigger as classic): no finisher, m = 1, unopened 202, opened hand value (pairs ×2).
- **Match:** exactly `rounds` rounds; lowest total wins; ties share. No indicator showing in 101
  (`showIndicator` → `cannotShow`).

**Actions:** classic `draw` / `discard` / `finish` (`finish` = discarding the last tile), plus
`{ type: 'layDown', groups: [ids[] | { kind?: 'run' | 'group', tiles }] }` (a run's order decides where an
okey stands when it is a valid run in that order; otherwise the highest-value reading),
`{ type: 'addToSet', tile, meld, side?: 'start' | 'end' }`, `{ type: 'swapOkey', tile, meld, okey? }`,
`{ type: 'undoTake' }`. Error codes added: `notOpened`, `openTooLow`, `tooFewPairs`, `badSet`, `cannotAdd`,
`cannotSwap`, `mustUseTaken`, `noTake`, `mustKeepOne`, `setsOnly`, `pairsOnly`, `notThisTurn`.

**Events** (routing as classic): `roundStart`, `dealt`, `draw` (pile only), `take { seat, tile }`,
`undoTake { seat, tile }`, `layDown { seat, melds: [{ index, owner, kind, tiles, color?, start?, num? }],
opening: null | { kind, value, pairs } }`, `addToSet { seat, tile, meld, side, tiles }`,
`swapOkey { seat, tile, okey, meld }`, `discard`, `penalty { seat, reason: 'islek' | 'okeyDiscard', tile,
points }`, `finish { seat, tile, kind: 'sets' | 'pairs', okeyFinish, elden, multiplier, hands }`,
`pileEmpty { hands }`, `score { deltas, scores }`, `matchEnd`.

**State and view.** `match.variant = '101'`; `round` adds `table` (melds: `{ owner, kind: 'run' | 'group' |
'pair', tiles, color?, start? (runs: position p is start + p, 14 = the 1 after 13), num? (groups) }`),
`opened [false | 'sets' | 'pairs' ×4]`, `openings [{ kind, value, pairs, turn } | null ×4]`, `highest`,
`penalties` (this round's), `taken`, and the secret `undo`. `tileLocations` counts table melds too. The view
is the classic view plus, in `round`: `table`, `opened`, `openings [{ kind, value, pairs } | null]`,
`required { value, pairs }` (the opening needed now), `penalties`, `taken`; `seats[].score` = penalty totals;
`result` adds `elden`, `multiplier`, `opened`, `penalties` (`deltas` = round-end scoring only, `groups` null;
`history[].deltas` include the penalties). Never: other hands, the pile, buried discards, `undo`.

**Solver helpers** (`okey101/rules.js`, for the client, auto-play and future 101 bots): `meldOf(spec, okey,
{ aceHighValue, anyOrder })`, `pairOf`, `meldValue`, `tileValue`, `handValue`, `addTile(meld, tile, okey,
side)`, `swapTile(meld, tile, okey, which?)`, `layoffs(hand, table, okey) -> [{ tile, meld, side }]`,
`swaps(hand, table, okey) -> [{ tile, meld, okey }]`, `isIslek(tile, table, okey, { swap })`,
`bestSets(hand, okey, { aceHighValue, keep = 1 }) -> { groups, value, tiles }` (max value, then tiles; memoized
search on face counts, ~0.3 ms average on 22 tiles, worst cases ≈ 20 ms), `bestPairs(hand, okey, { keep })`,
`bestOpening(hand, okey, { allowPairs, aceHighValue, minValue, minPairs }) -> { sets, pairs, best }`.
`game.js` also exports `requiredOpening(round, settings)` and `pickDiscard(match, seat)`.

**Auto-play** (`timeoutAction`, one step per call; the host calls it until the turn passes): draw from the
pile; give back a take it cannot lay off (`undoTake`); open if possible (sets, else pairs); once opened take
okeys back, lay new sets/pairs, add tiles (okeys only with ≤ 3 tiles left); finish with the last tile; else
discard the highest-value `arrange` leftover, never an işlek tile or an okey if avoidable.

**Host.** `cleanSettings` validates `variant` (switching variant drops the other variant's scoring/rules;
101: `rounds` 1–11, default 9 when switching from "play to 0"; `scoring` keys above, ints 0–999; `doubles`
booleans; the rule flags; `openingValue` 1–300, `minPairs` 2–11, `aceHighValue` 1/11/14). `cleanAction`
knows the 101 actions. The view's `settings` always has `variant` (101 adds its rule fields). `onResult`
summaries carry `variant`. **101 bots** use the same brain as classic (it reads `settings.variant` from the
view): the host plans and times each step like a classic bot step (`delayMs` then `decide`; the bot makes the
first step of a turn slower and the table steps quicker). An illegal or missing bot step falls back to one
`timeoutAction` step, and a bot turn longer than `MAX_BOT_STEPS_101` (40) steps is finished by auto-play. A
timed-out human's whole turn is auto-played (up to 64 steps).

## Statistics and achievements (phase 2)

Recorded server side by the Room DO into the Stats DO when a round or match ends, keyed by device id (secret
checked). The client caches its own stats locally.

Stats: matches played/won, rounds played/won, finishes by kind (normal, pairs, okey, pairs+okey), indicators
shown, fastest finish (turns), current/best win streak, wins vs each bot level, points lost.

Achievements (id: tr / en): `ilk_zafer` İlk Zafer / First Win; `okey_atan` Okey Atan / Okey Finish;
`ciftci` Çiftçi / Pairs Finish; `cifte_okey` Çifte Okey / Pairs + Okey; `gostergeci` Göstergeci / 10
indicators shown; `seri_5` Seri / 5 wins in a row; `usta_avcisi` Usta Avcısı / beat a table of 3 experts;
`hizli_el` Yıldırım / finish within your first 5 turns; `yuz_el` Müdavim / 100 rounds; `dost_masasi` Dost Masası /
play a full match with 3 humans.

A device "transfer code" (phase 2) moves identity + stats to another device without accounts.
