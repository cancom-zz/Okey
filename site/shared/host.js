// TableHost: one Okey table (a room) with no I/O. See DESIGN.md "One host, two transports".
//
//   const host = new TableHost({ code, settings, now, schedule, send, close?, rng, onResult?, saved?,
//                                engine?, createBot? })
//   host.connect(connId) -> bool       a socket opened (false: room full, the socket was told and closed)
//   host.bind(connId, playerId|null)   re-attach a live socket after a restore (no messages sent)
//   host.disconnect(connId)            a socket closed
//   host.message(connId, msg)          a parsed client message (DESIGN.md "Network protocol")
//   host.wake()                        the time last passed to schedule() was reached
//   host.snapshot() -> JSON            persist after every change (host.dirty says one happened)
//   host.playerOf(connId) -> id|null   identity bound to a socket (store it in the socket's attachment)
//   host.summary() -> {...}            public room summary for the join screen (no hidden information)
//   host.nextWakeAt() -> ms|null       the pending timer, if any
//
// Injected I/O:
//   now() -> epoch ms; schedule(atMs | null): call wake() at atMs (null: nothing pending; replaces any
//   earlier request); send(connId, msg); close(connId, code, reason): drop a socket (replaced / room full);
//   rng: { int(n) } (crypto in production); onResult(summary): a round or the match ended (stats).
//
// The host never sends another seat's hand, the pile, or buried discards: views come from the engine's
// viewFor(match, seat) and are copied field by field (whitelist), and private events (`to`) go only to
// their seat. Bots get the same projection and the same event stream as a human in their seat.

import * as engineLib from './okey/index.js';
import * as botLib from './bots/index.js';

// Keep these in step with site/js/config.js (a test checks it).
export const AVATARS = ['🦊', '🐻', '🐱', '🦁', '🐼', '🐯', '🐸', '🦉', '🐢', '🐧', '🐙', '🦄', '🐝', '🐺', '🦜', '🐨', '🌻', '☕', '🎩', '⚓'];
export const BOT_AVATAR = { cirak: '🐣', kalfa: '🦊', usta: '🦉', uzman: '🐺' };
export const LEVELS = ['cirak', 'kalfa', 'usta', 'uzman'];
export const EMOTES = ['clap', 'smile', 'wow', 'fire', 'think', 'hadi', 'eyvallah', 'luck', 'gg'];
// Custom bot params: [min, max]. memory stays below perfect and decay above zero (DESIGN.md "Bots").
// The bots clamp further (site/shared/bots resolveParams); this only rejects garbage.
export const BOT_PARAM_RANGES = {
  memory: [0, 0.9], decay: [0.005, 1], lookahead: [1, 4], defense: [0, 1], pairsBias: [0, 2],
  blunder: [0, 1], takeDiscard: [0, 1], gamble: [0, 1], speed: [0.25, 3],
};
export const BOT_NAMES = ['Ayşe', 'Mehmet', 'Fatma', 'Ali', 'Zeynep', 'Mustafa', 'Elif', 'Hasan', 'Emine',
  'Hüseyin', 'Hatice', 'İbrahim', 'Leyla', 'Osman', 'Selin', 'Murat', 'Sevgi', 'Kemal', 'Nermin', 'Cem'];

export const MAX_CONNECTIONS = 12;
export const NEXT_ROUND_MS = 20_000;      // round end -> next round, unless every connected human pressed next
export const AUTOPLAY_MS = 1_000;         // a seat away for 2+ timeouts is auto-played after this
export const AWAY_AUTOPLAY_AFTER = 2;     // consecutive timeouts
export const OFFLINE_TURN_SECONDS = 30;   // turn limit for a disconnected human when turnSeconds is 0 (off)
export const EMOTE_GAP_MS = 1_500;
export const RATE = { burst: 20, perSec: 5 };
export const MAX_MESSAGE_CHARS = 2_000;
export const DEFAULT_SETTINGS = { turnSeconds: 30, rounds: null, startPoints: 20 };

const ID = /^[A-Za-z0-9_-]{8,64}$/;
const LANG = /^[a-z]{2}(-[A-Za-z]{2})?$/;
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isTile = (v) => isInt(v, 0, 105);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));

const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter() : null;
const visibleLength = (s) => (segmenter ? [...segmenter.segment(s)].length : [...s].length);

/** A display name: no control/invisible characters, spaces collapsed, 1–20 visible characters. null if bad. */
export function cleanName(v) {
  if (typeof v !== 'string' || v.length > 200) return null;
  const s = v.normalize('NFC')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}ᅟᅠㅤﾠ]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
  const n = visibleLength(s);
  if (n < 1 || n > 20 || !/[\p{L}\p{N}\p{S}]/u.test(s)) return null;
  return s;
}

/** Validates a game action and rebuilds it with known keys only. null if malformed. */
export function cleanAction(a) {
  if (!isObj(a)) return null;
  switch (a.type) {
    case 'draw': return a.from === 'pile' || a.from === 'discard' ? { type: 'draw', from: a.from } : null;
    case 'discard': return isTile(a.tile) ? { type: 'discard', tile: a.tile } : null;
    case 'showIndicator': return { type: 'showIndicator' };
    case 'finish': {
      if (!isTile(a.tile)) return null;
      const out = { type: 'finish', tile: a.tile };
      if (a.groups !== undefined && a.groups !== null) {
        if (!Array.isArray(a.groups) || a.groups.length > 14) return null;
        let total = 0;
        for (const g of a.groups) {
          if (!Array.isArray(g) || g.length > 14 || !g.every(isTile)) return null;
          total += g.length;
        }
        if (total > 15) return null;
        out.groups = a.groups.map((g) => g.slice());
      }
      return out;
    }
    default: return null;
  }
}

/** Validates bot params against BOT_PARAM_RANGES (unknown keys rejected). null if bad. */
export function cleanBotParams(p) {
  if (p === undefined || p === null) return undefined;
  if (!isObj(p)) return null;
  const out = {};
  for (const [k, v] of Object.entries(p)) {
    const r = BOT_PARAM_RANGES[k];
    if (!r || typeof v !== 'number' || !Number.isFinite(v) || v < r[0] || v > r[1]) return null;
    out[k] = k === 'lookahead' ? Math.round(v) : v;
  }
  return out;
}

/** Validates a (partial) settings object; returns the merged settings or null if bad. */
export function cleanSettings(s, base = DEFAULT_SETTINGS) {
  if (s === undefined || s === null) return clone(base);
  if (!isObj(s)) return null;
  const out = clone(base);
  for (const [k, v] of Object.entries(s)) {
    if (k === 'turnSeconds') {
      if (!(v === 0 || isInt(v, 10, 120))) return null;
      out.turnSeconds = v;
    } else if (k === 'rounds') {
      if (!(v === null || isInt(v, 0, 99))) return null;
      out.rounds = v || null; // 0 and null both mean: play until a score reaches 0
    } else if (k === 'startPoints') {
      if (!isInt(v, 1, 99)) return null;
      out.startPoints = v;
    } else if (k === 'scoring') {
      if (!isObj(v) || Object.keys(v).length > 12) return null;
      const sc = {};
      for (const [sk, sv] of Object.entries(v)) {
        if (!/^[A-Za-z]{1,20}$/.test(sk) || !isInt(sv, 0, 99)) return null;
        sc[sk] = sv;
      }
      out.scoring = { ...(out.scoring || {}), ...sc };
    } else return null;
  }
  return out;
}

/** The events one seat may see (seat null = spectator). Private events (`to`) only reach their seat. */
export function eventsFor(events, seat) {
  const out = [];
  for (const e of events) {
    if (e.to !== undefined && e.to !== null) {
      if (e.to === seat) out.push(e);
      continue;
    }
    if (e.except !== undefined && e.except === seat) continue; // the drawer gets the private copy instead
    // Defensive: a public pile draw never carries the tile, except to the drawer.
    if (e.type === 'draw' && e.from === 'pile' && 'tile' in e && e.seat !== seat) {
      const { tile, ...rest } = e;
      out.push(rest);
      continue;
    }
    out.push(e);
  }
  return out;
}

const emptySeat = () => ({ kind: 'empty' });

export class TableHost {
  constructor({ code, settings, now, schedule, send, close, rng, onResult, saved, engine, createBot }) {
    this.engine = engine || engineLib;
    this.createBot = createBot || botLib.createBot;
    this.now = now || (() => Date.now());
    this._schedule = schedule || (() => {});
    this._send = send || (() => {});
    this._close = close || (() => {});
    this.rng = rng;
    this.onResult = onResult || (() => {});
    this.conns = new Map(); // connId -> { playerId, name, avatar, lang, tokens, last, lastEmote }
    this.bots = [null, null, null, null];
    this.scheduledAt = undefined;
    this.dirty = false;
    if (saved) this.restore(saved);
    else {
      this.code = code;
      this.settings = cleanSettings(settings) || cleanSettings();
      this.v = 1;           // view version: +1 per change
      this.gameV = 0;       // v of the last game change (actions based on older views are stale)
      this.seats = [emptySeat(), emptySeat(), emptySeat(), emptySeat()];
      this.hostSeat = null;
      this.players = {};    // playerId -> secret (claimed on first hello in this room)
      this.match = null;
      this.phase = 'lobby';
      this.deadline = null; // when wake() has work: bot move, auto-play, timeout, or next round
      this.turnEndsAt = null;
      this.turnKey = null;
      this.turnNo = 0;
      this.turns = [0, 0, 0, 0];
      this.botActs = 0;     // bot actions this turn (guards against a bot that never ends its turn)
      this.botAction = null; // the move the bot on turn decided, played at `deadline`
      this.ready = [false, false, false, false];
      this.roundInfo = null; // { winner, kind, okeyFinish, showed: [bool x4] }
      this.matchNo = 0;
      this.pausedAt = null;
      this.dirty = true;
    }
  }

  // ---------------------------------------------------------------- persistence

  snapshot() {
    return clone({
      format: 1, code: this.code, settings: this.settings, v: this.v, gameV: this.gameV, seats: this.seats,
      hostSeat: this.hostSeat, players: this.players, match: this.match, phase: this.phase,
      deadline: this.deadline, turnEndsAt: this.turnEndsAt, turnKey: this.turnKey, turnNo: this.turnNo,
      turns: this.turns, botActs: this.botActs, botAction: this.botAction, ready: this.ready, roundInfo: this.roundInfo,
      matchNo: this.matchNo, pausedAt: this.pausedAt,
      bots: this.bots.map((b) => (b && typeof b.snapshot === 'function' ? b.snapshot() : null)),
    });
  }

  restore(s) {
    const d = clone(s);
    for (const k of ['code', 'settings', 'v', 'gameV', 'seats', 'hostSeat', 'players', 'match', 'phase',
      'deadline', 'turnEndsAt', 'turnKey', 'turnNo', 'turns', 'botActs', 'botAction', 'ready', 'roundInfo', 'matchNo', 'pausedAt']) {
      this[k] = d[k];
    }
    // No socket is attached after a restore: the transport calls bind() for each live one before wake().
    this.bots = d.seats.map((seat, i) => (seat.kind === 'bot' && this.match
      ? this.createBot({ level: seat.level, params: seat.params, seed: seat.seed, saved: d.bots?.[i] ?? undefined })
      : null));
    this.dirty = false;
  }

  // ---------------------------------------------------------------- connections

  connect(connId) {
    if (this.conns.has(connId)) return true;
    if (this.conns.size >= MAX_CONNECTIONS) {
      this._send(connId, { t: 'error', code: 'full' });
      this._close(connId, 4001, 'full');
      return false;
    }
    this.conns.set(connId, this.newConn(null));
    this.resume();
    this.reschedule();
    return true;
  }

  /** Re-attach a socket that survived a restore (hibernation). Sends nothing. */
  bind(connId, playerId = null) {
    const c = this.newConn(playerId && this.players[playerId] !== undefined ? playerId : null);
    if (c.playerId) {
      const seat = this.seatOf(c.playerId);
      if (seat !== null) { c.name = this.seats[seat].name; c.avatar = this.seats[seat].avatar; }
      for (const [id, o] of this.conns) if (o.playerId === c.playerId) this.conns.delete(id);
    }
    this.conns.set(connId, c);
    this.resume();
    this.reschedule();
  }

  disconnect(connId) {
    const c = this.conns.get(connId);
    if (!c) return;
    this.conns.delete(connId);
    const seat = c.playerId ? this.seatOf(c.playerId) : null;
    if (seat !== null) {
      if (this.hostSeat === seat) this.passHost(seat, true);
      // A disconnected human on turn with no timer still gets one, so the table never stalls.
      if (this.phase === 'playing' && this.currentTurn() === seat && !this.settings.turnSeconds && this.seats[seat].timeouts < AWAY_AUTOPLAY_AFTER) {
        this.turnEndsAt = this.deadline = this.now() + OFFLINE_TURN_SECONDS * 1000;
      }
      this.changed([]);
      if (this.phase === 'roundEnd' || this.phase === 'matchEnd') this.checkReady();
    }
    if (this.conns.size === 0) {
      this.pausedAt = this.now();
      this.dirty = true;
    }
    this.reschedule();
  }

  /** After restoring and binding every live socket: with none left, the room is paused (timers stop). */
  pauseIfEmpty() {
    if (this.conns.size === 0 && (this.pausedAt === null || this.pausedAt === undefined)) {
      this.pausedAt = this.now();
      this.dirty = true;
    }
    this.reschedule();
  }

  playerOf(connId) {
    return this.conns.get(connId)?.playerId ?? null;
  }

  newConn(playerId) {
    return { playerId, name: null, avatar: null, lang: null, tokens: RATE.burst, last: this.now(), lastEmote: -Infinity };
  }

  resume() {
    if (this.pausedAt === null || this.pausedAt === undefined) return;
    const shift = Math.max(0, this.now() - this.pausedAt);
    this.pausedAt = null;
    if (this.deadline !== null) this.deadline += shift;
    if (this.turnEndsAt !== null) this.turnEndsAt += shift;
    this.dirty = true;
  }

  // ---------------------------------------------------------------- messages

  message(connId, msg) {
    const c = this.conns.get(connId);
    if (!c) return;
    const now = this.now();
    c.tokens = Math.min(RATE.burst, c.tokens + ((now - c.last) / 1000) * RATE.perSec);
    c.last = now;
    if (c.tokens < 1) return this.error(connId, 'rateLimited');
    c.tokens -= 1;
    if (!isObj(msg) || typeof msg.t !== 'string') return this.error(connId, 'badMessage');
    let size;
    try { size = JSON.stringify(msg).length; } catch { return this.error(connId, 'badMessage'); }
    if (size > MAX_MESSAGE_CHARS) return this.error(connId, 'badMessage');
    if (msg.t === 'ping') return this._send(connId, { t: 'pong', now });
    if (msg.t === 'hello') return this.hello(connId, c, msg);
    if (!c.playerId) return this.error(connId, 'helloFirst');
    const seat = this.seatOf(c.playerId);
    switch (msg.t) {
      case 'sit': return this.sit(connId, c, seat, msg);
      case 'stand': return this.stand(connId, seat);
      case 'addBot': return this.addBot(connId, seat, msg);
      case 'removeBot': return this.removeBot(connId, seat, msg);
      case 'settings': return this.setSettings(connId, seat, msg);
      case 'start': return this.start(connId, seat);
      case 'act': return this.act(connId, seat, msg);
      case 'emote': return this.emote(connId, c, seat, msg);
      case 'next': return this.next(connId, seat);
      default: return this.error(connId, 'badMessage');
    }
  }

  error(connId, code) {
    this._send(connId, { t: 'error', code });
  }

  hello(connId, c, msg) {
    const p = msg.player;
    if (!isObj(p) || typeof p.id !== 'string' || !ID.test(p.id) || typeof p.secret !== 'string' || !ID.test(p.secret)) {
      return this.error(connId, 'badMessage');
    }
    const name = cleanName(p.name);
    if (!name) return this.error(connId, 'badName');
    const avatar = AVATARS.includes(p.avatar) ? p.avatar : AVATARS[0];
    if (c.playerId && c.playerId !== p.id) return this.error(connId, 'badIdentity');
    const known = this.players[p.id];
    if (known !== undefined && known !== p.secret) return this.error(connId, 'badIdentity');
    if (known === undefined) {
      this.prunePlayers();
      this.players[p.id] = p.secret;
    }
    // One live socket per identity: the newer one replaces the older.
    for (const [id, o] of this.conns) {
      if (id !== connId && o.playerId === p.id) {
        this.conns.delete(id);
        this._send(id, { t: 'error', code: 'replaced' });
        this._close(id, 4002, 'replaced');
      }
    }
    c.playerId = p.id;
    c.name = name;
    c.avatar = avatar;
    c.lang = typeof msg.lang === 'string' && LANG.test(msg.lang) ? msg.lang : null;
    const seat = this.seatOf(p.id);
    if (seat !== null) {
      const s = this.seats[seat];
      s.name = name;
      s.avatar = avatar;
      if (this.hostSeat === null) this.hostSeat = seat;
      this.changed([]);
    } else {
      this.dirty = true;
      this.sendView(connId, []);
    }
  }

  prunePlayers() {
    const ids = Object.keys(this.players);
    if (ids.length < 200) return;
    const keep = new Set(this.seats.map((s) => s.playerId).filter(Boolean));
    for (const c of this.conns.values()) if (c.playerId) keep.add(c.playerId);
    for (const id of ids) if (!keep.has(id)) delete this.players[id];
  }

  get seatingOpen() {
    return this.phase === 'lobby' || this.phase === 'matchEnd';
  }

  sit(connId, c, seat, msg) {
    if (!isInt(msg.seat, 0, 3)) return this.error(connId, 'badMessage');
    if (!this.seatingOpen) return this.error(connId, 'wrongPhase');
    if (seat === msg.seat) return this.sendView(connId, []);
    if (this.seats[msg.seat].kind !== 'empty') return this.error(connId, 'seatTaken');
    this.seats[msg.seat] = {
      kind: 'human', playerId: c.playerId, name: c.name, avatar: c.avatar, away: false, timeouts: 0,
    };
    if (seat !== null) {
      this.seats[seat] = emptySeat();
      if (this.hostSeat === seat) this.hostSeat = msg.seat;
    }
    if (this.hostSeat === null) this.hostSeat = msg.seat;
    this.ready = [false, false, false, false];
    this.leaveFinishedMatch();
    this.changed([]);
  }

  stand(connId, seat) {
    if (seat === null) return this.error(connId, 'notSeated');
    if (!this.seatingOpen) return this.error(connId, 'wrongPhase');
    this.seats[seat] = emptySeat();
    if (this.hostSeat === seat) this.passHost(seat, false);
    this.ready = [false, false, false, false];
    this.leaveFinishedMatch();
    this.changed([]);
  }

  /** The host left (stood up or disconnected): pass it to another seated human, connected ones first. */
  passHost(seat, keepIfAlone) {
    const humans = [1, 2, 3].map((k) => (seat + k) % 4).filter((i) => this.seats[i].kind === 'human');
    const next = humans.find((i) => this.isConnected(i)) ?? (keepIfAlone ? seat : humans[0] ?? null);
    this.hostSeat = next ?? null;
  }

  isHost(connId, seat) {
    if (seat === null || seat !== this.hostSeat) {
      this.error(connId, 'notHost');
      return false;
    }
    return true;
  }

  addBot(connId, seat, msg) {
    if (!this.isHost(connId, seat)) return;
    if (!isInt(msg.seat, 0, 3) || !LEVELS.includes(msg.level)) return this.error(connId, 'badMessage');
    const params = cleanBotParams(msg.params);
    if (params === null) return this.error(connId, 'badMessage');
    if (!this.seatingOpen) return this.error(connId, 'wrongPhase');
    if (this.seats[msg.seat].kind !== 'empty') return this.error(connId, 'seatTaken');
    const used = new Set(this.seats.map((s) => s.name));
    const free = BOT_NAMES.filter((n) => !used.has(n));
    // Each bot gets its own avatar (the level shows as a label); BOT_AVATAR stays the level picker's icon.
    const usedAv = new Set(this.seats.map((s) => s.avatar));
    const freeAv = AVATARS.filter((a) => !usedAv.has(a));
    this.seats[msg.seat] = {
      kind: 'bot', level: msg.level, params, name: free[this.rng.int(free.length)],
      avatar: freeAv[this.rng.int(freeAv.length)], seed: this.rng.int(0x7fffffff),
    };
    this.leaveFinishedMatch();
    this.changed([]);
  }

  /** Remove a bot, or (lobby / match end) a human whose socket is gone, so the table can fill up again. */
  removeBot(connId, seat, msg) {
    if (!this.isHost(connId, seat)) return;
    if (!isInt(msg.seat, 0, 3)) return this.error(connId, 'badMessage');
    if (!this.seatingOpen) return this.error(connId, 'wrongPhase');
    const s = this.seats[msg.seat];
    if (!(s.kind === 'bot' || (s.kind === 'human' && msg.seat !== seat && !this.isConnected(msg.seat)))) {
      return this.error(connId, 'badSeat');
    }
    this.seats[msg.seat] = emptySeat();
    this.bots[msg.seat] = null;
    this.leaveFinishedMatch();
    this.changed([]);
  }

  setSettings(connId, seat, msg) {
    if (!this.isHost(connId, seat)) return;
    if (!this.seatingOpen) return this.error(connId, 'wrongPhase');
    const s = cleanSettings(msg.settings, this.settings);
    if (!s) return this.error(connId, 'badSettings');
    this.settings = s;
    this.leaveFinishedMatch();
    this.changed([]);
  }

  /** Changing the table after a match ended goes back to the lobby (the old result is dropped). */
  leaveFinishedMatch() {
    if (this.phase !== 'matchEnd') return;
    this.match = null;
    this.phase = 'lobby';
    this.roundInfo = null;
    this.bots = [null, null, null, null];
    for (const s of this.seats) if (s.kind === 'human') { s.away = false; s.timeouts = 0; }
  }

  start(connId, seat) {
    if (!this.isHost(connId, seat)) return;
    if (!this.seatingOpen) return this.error(connId, 'wrongPhase');
    if (this.seats.some((s) => s.kind === 'empty')) return this.error(connId, 'seatsNotFull');
    this.startMatch();
  }

  startMatch() {
    const E = this.engine;
    this.matchNo += 1;
    this.bots = this.seats.map((s, i) => {
      if (s.kind !== 'bot') return null;
      s.seed = this.rng.int(0x7fffffff);
      return this.createBot({ level: s.level, params: s.params, seed: s.seed });
    });
    for (const s of this.seats) if (s.kind === 'human') { s.away = false; s.timeouts = 0; }
    const match = E.newMatch({
      code: this.code,
      dealer: this.rng.int(4),
      settings: this.settings,
      seats: this.seats.map((s, i) => ({
        id: s.kind === 'human' ? s.playerId : `bot${i}`, name: s.name, kind: s.kind,
        ...(s.kind === 'bot' ? { bot: { level: s.level, params: s.params } } : {}),
      })),
    });
    this.turnKey = null;
    const res = E.startRound(match, this.rng);
    this.applyGame(res.match, res.events);
  }

  startNextRound() {
    const E = this.engine;
    const fn = typeof E.nextRound === 'function' ? E.nextRound : E.startRound;
    const res = fn(this.match, this.rng);
    this.applyGame(res.match, res.events);
  }

  // ---------------------------------------------------------------- the game

  act(connId, seat, msg) {
    if (seat === null) return this.error(connId, 'notSeated');
    const action = cleanAction(msg.action);
    if (!action || !Number.isInteger(msg.v)) return this.error(connId, 'badAction');
    if (this.phase !== 'playing') return this.error(connId, 'roundOver');
    if (msg.v < this.gameV || msg.v > this.v) return this.error(connId, 'stale');
    this.clearAway(seat);
    let res;
    try {
      res = this.engine.act(this.match, seat, action);
    } catch (err) {
      if (this.dirty) this.changed([]); // `away` was cleared
      return this.error(connId, err && typeof err.code === 'string' ? err.code : 'badAction');
    }
    this.applyGame(res.match, res.events);
  }

  /** Any action by a human brings them back from `away`. */
  clearAway(seat) {
    const s = this.seats[seat];
    if (s.kind !== 'human' || (!s.away && !s.timeouts)) return;
    s.away = false;
    s.timeouts = 0;
    this.dirty = true;
    // If their turn was being auto-played, they get a full turn back.
    if (this.phase === 'playing' && this.currentTurn() === seat) this.setHumanDeadline(seat);
  }

  currentTurn() {
    return this.match ? this.publicView().round?.turn ?? null : null;
  }

  publicView() {
    return this.engine.viewFor(this.match, null);
  }

  /** Bots see exactly the engine's projection for their seat; seat kinds are masked (bots never know). */
  botView(seat) {
    const view = this.engine.viewFor(this.match, seat);
    if (Array.isArray(view.seats)) {
      view.seats = view.seats.map((s) => {
        if (!isObj(s)) return s;
        const { kind, bot, id, ...rest } = s;
        return rest;
      });
    }
    return view;
  }

  /** Apply a new match state and its events: bookkeeping, bots, timers, views, results. */
  applyGame(match, events) {
    this.match = match;
    let matchEnded = null;
    for (const e of events) {
      switch (e.type) {
        case 'roundStart':
          this.turnNo = 0;
          this.turns = [0, 0, 0, 0];
          this.roundInfo = {
            round: e.round, winner: null, kind: null, okeyFinish: false,
            showed: [false, false, false, false], deltas: [0, 0, 0, 0],
          };
          this.ready = [false, false, false, false];
          break;
        case 'discard':
        case 'finish':
          this.turnNo += 1;
          this.turns[e.seat] += 1;
          if (e.type === 'finish') Object.assign(this.roundInfo, { winner: e.seat, kind: e.kind, okeyFinish: !!e.okeyFinish });
          break;
        case 'showIndicator':
          this.roundInfo.showed[e.seat] = true;
          break;
        case 'score': // a finish, or an indicator shown mid-round
          this.roundInfo.deltas = this.roundInfo.deltas.map((d, i) => d + (e.deltas?.[i] ?? 0));
          break;
        case 'matchEnd':
          matchEnded = e;
          break;
        default:
      }
    }
    for (let i = 0; i < 4; i++) {
      const bot = this.bots[i];
      if (bot) for (const e of eventsFor(events, i)) bot.observe(clone(e));
    }
    const prevPhase = this.phase;
    this.phase = this.publicView().phase || this.phase;
    const roundEnded = prevPhase === 'playing' && (this.phase === 'roundEnd' || this.phase === 'matchEnd');
    this.updateTimers(prevPhase);
    this.gameV = this.v + 1;
    this.changed(events);
    if (roundEnded) this.report('round', null);
    if (matchEnded) this.report('match', matchEnded);
    this.reschedule();
  }

  updateTimers(prevPhase) {
    const now = this.now();
    if (this.phase === 'playing') {
      const turn = this.currentTurn();
      const key = `${this.matchNo}:${this.roundInfo?.round}:${this.turnNo}`;
      const s = this.seats[turn];
      if (key !== this.turnKey) {
        this.turnKey = key;
        this.botActs = 0;
        if (s.kind === 'bot') {
          this.turnEndsAt = null;
          this.planBot(turn);
        } else this.setHumanDeadline(turn);
      } else if (s.kind === 'bot') {
        this.planBot(turn); // same turn, next step (drew, now discards)
      }
    } else if (this.phase === 'roundEnd') {
      this.turnEndsAt = null;
      if (prevPhase !== 'roundEnd') this.deadline = now + NEXT_ROUND_MS;
    } else {
      this.turnEndsAt = null;
      this.deadline = null;
    }
  }

  setHumanDeadline(seat) {
    const now = this.now();
    const s = this.seats[seat];
    if (s.timeouts >= AWAY_AUTOPLAY_AFTER) {
      this.turnEndsAt = this.deadline = now + AUTOPLAY_MS;
      return;
    }
    const secs = this.settings.turnSeconds || (this.isConnected(seat) ? 0 : OFFLINE_TURN_SECONDS);
    this.turnEndsAt = this.deadline = secs ? now + secs * 1000 : null;
  }

  /**
   * A bot decides as soon as it is its move (nothing can change the match before then) and the move is
   * played after its thinking time. The planned action is part of the snapshot, so a restore replays it.
   */
  planBot(seat) {
    const bot = this.bots[seat];
    const view = this.botView(seat);
    let ms = 800;
    let action = null;
    try {
      const d = bot.delayMs(view);
      if (Number.isFinite(d)) ms = d;
      action = cleanAction(bot.decide(view));
    } catch { /* falls back to auto-play */ }
    this.botAction = action;
    this.deadline = this.now() + Math.min(15_000, Math.max(150, Math.round(ms)));
  }

  wake() {
    if (this.pausedAt !== null && this.pausedAt !== undefined) return this.reschedule();
    const now = this.now();
    for (let guard = 0; guard < 8 && this.deadline !== null && now >= this.deadline; guard++) {
      if (this.phase === 'playing') {
        const turn = this.currentTurn();
        if (this.seats[turn].kind === 'bot') this.botMove(turn);
        else this.timeoutMove(turn);
      } else if (this.phase === 'roundEnd') {
        this.startNextRound();
      } else {
        this.deadline = null;
      }
    }
    this.reschedule();
  }

  botMove(seat) {
    const action = this.botAction;
    this.botAction = null;
    this.botActs += 1;
    if (action && this.botActs <= 4) {
      try {
        const res = this.engine.act(this.match, seat, action);
        return this.applyGame(res.match, res.events);
      } catch { /* an illegal bot move falls back to auto-play */ }
    }
    this.autoStep(seat);
  }

  /** A human ran out of time (or is away): auto-play the whole turn and mark them away. */
  timeoutMove(seat) {
    const s = this.seats[seat];
    s.away = true;
    s.timeouts = (s.timeouts || 0) + 1;
    const key = this.turnKey;
    for (let i = 0; i < 3 && this.phase === 'playing' && this.turnKey === key; i++) this.autoStep(seat);
  }

  autoStep(seat) {
    const E = this.engine;
    let res = null;
    try {
      res = E.act(this.match, seat, E.timeoutAction(this.match, seat));
    } catch {
      // Last resort: draw from the pile, or discard the first tile in hand.
      const v = E.viewFor(this.match, seat);
      const a = v.round?.stage === 'draw' ? { type: 'draw', from: 'pile' } : { type: 'discard', tile: v.hand?.[0] };
      res = E.act(this.match, seat, a);
    }
    this.applyGame(res.match, res.events);
  }

  // ---------------------------------------------------------------- round end, rematch

  next(connId, seat) {
    if (seat === null) return this.error(connId, 'notSeated');
    if (this.phase !== 'roundEnd' && this.phase !== 'matchEnd') return this.error(connId, 'wrongPhase');
    this.clearAway(seat);
    if (!this.ready[seat]) {
      this.ready[seat] = true;
      this.changed([]);
    }
    this.checkReady();
  }

  checkReady() {
    const humans = [0, 1, 2, 3].filter((i) => this.seats[i].kind === 'human' && this.isConnected(i));
    if (!humans.length || !humans.every((i) => this.ready[i])) return;
    if (this.phase === 'roundEnd') this.startNextRound();
    else if (this.phase === 'matchEnd' && !this.seats.some((s) => s.kind === 'empty')) this.startMatch();
    this.reschedule();
  }

  emote(connId, c, seat, msg) {
    if (seat === null) return this.error(connId, 'notSeated');
    if (!EMOTES.includes(msg.id)) return this.error(connId, 'badMessage');
    const now = this.now();
    if (now - c.lastEmote < EMOTE_GAP_MS) return this.error(connId, 'rateLimited');
    c.lastEmote = now;
    if (this.seats[seat].away) {
      this.clearAway(seat);
      this.changed([]);
      this.reschedule();
    }
    for (const [id, o] of this.conns) if (o.playerId) this._send(id, { t: 'emote', seat, id: msg.id });
  }

  // ---------------------------------------------------------------- results

  /**
   * onResult(summary) at each round end (type 'round') and at match end (type 'match', right after the
   * last round's summary). Per seat: playerId + secret (humans; the Stats DO checks the secret), kind,
   * botLevel, won, finish kind, okeyFinish, delta (round: all score changes this round, indicator included),
   * score, turns taken, showedIndicator.
   */
  report(type, e) {
    const info = this.roundInfo || {};
    const scores = this.publicView().seats.map((s) => s.score);
    const isRound = type === 'round';
    const winners = isRound ? (Number.isInteger(info.winner) ? [info.winner] : []) : e.winners.slice();
    const summary = {
      type, code: this.code, match: this.matchNo, round: info.round ?? null, at: this.now(),
      winner: isRound ? info.winner ?? null : null,
      kind: isRound ? info.kind ?? null : null,
      okeyFinish: isRound ? !!info.okeyFinish : false,
      winners,
      seats: this.seats.map((s, i) => ({
        seat: i,
        kind: s.kind,
        playerId: s.kind === 'human' ? s.playerId : null,
        secret: s.kind === 'human' ? this.players[s.playerId] ?? null : null,
        name: s.name,
        botLevel: s.kind === 'bot' ? s.level : null,
        won: winners.includes(i),
        finish: isRound && info.winner === i ? info.kind : null,
        okeyFinish: isRound && info.winner === i ? !!info.okeyFinish : false,
        delta: isRound ? info.deltas?.[i] ?? 0 : null,
        score: scores[i],
        turns: isRound ? this.turns[i] : null,
        showedIndicator: isRound ? !!info.showed?.[i] : false,
      })),
    };
    try { this.onResult(summary); } catch { /* stats never break the table */ }
  }

  // ---------------------------------------------------------------- views

  seatOf(playerId) {
    const i = this.seats.findIndex((s) => s.kind === 'human' && s.playerId === playerId);
    return i < 0 ? null : i;
  }

  isConnected(seat) {
    const s = this.seats[seat];
    if (s.kind === 'bot') return true;
    if (s.kind !== 'human') return false;
    for (const c of this.conns.values()) if (c.playerId === s.playerId) return true;
    return false;
  }

  /** A change everyone should see: bump the version and send each socket its view + its events. */
  changed(events) {
    this.v += 1;
    this.dirty = true;
    for (const [connId, c] of this.conns) {
      if (!c.playerId) continue;
      const seat = this.seatOf(c.playerId);
      this.sendView(connId, eventsFor(events, seat), seat);
    }
  }

  sendView(connId, events, seat) {
    const c = this.conns.get(connId);
    if (!c) return;
    if (seat === undefined) seat = c.playerId ? this.seatOf(c.playerId) : null;
    this._send(connId, { t: 'view', view: this.viewFor(seat), events: clone(events) });
  }

  /** The full view for a seat (null = spectator). Every field is copied explicitly: nothing else leaks. */
  viewFor(seat) {
    const base = this.match ? this.engine.viewFor(this.match, seat) : null;
    const st = this.settings;
    const settings = { turnSeconds: st.turnSeconds, rounds: st.rounds ?? null, startPoints: st.startPoints, scoring: clone(base?.settings?.scoring ?? st.scoring ?? {}) };
    const seats = this.seats.map((s, i) => {
      const b = base?.seats?.[i] || {};
      const top = b.discard?.top;
      return {
        kind: s.kind,
        name: s.kind === 'empty' ? null : s.name,
        avatar: s.kind === 'empty' ? null : s.avatar,
        connected: this.isConnected(i),
        away: s.kind === 'human' ? !!s.away : false,
        bot: s.kind === 'bot' ? { level: s.level } : null,
        score: Number.isFinite(b.score) ? b.score : st.startPoints,
        handCount: Number.isInteger(b.handCount) ? b.handCount : 0,
        discard: { top: isTile(top) ? top : null, count: Number.isInteger(b.discard?.count) ? b.discard.count : 0 },
        showedIndicator: !!b.showedIndicator,
        ready: (this.phase === 'roundEnd' || this.phase === 'matchEnd') ? (s.kind === 'bot' || !!this.ready[i]) : false,
      };
    });
    let round = null;
    if (base?.round && this.phase !== 'lobby') {
      const r = base.round;
      round = {
        number: r.number, dealer: r.dealer, turn: r.turn, stage: r.stage,
        indicator: isTile(r.indicator) ? r.indicator : null,
        okey: r.okey ? { color: r.okey.color, num: r.okey.num } : null,
        pileCount: r.pileCount,
        turnEndsAt: this.phase === 'playing' ? this.turnEndsAt : null,
        firstTurn: Array.isArray(r.firstTurn) ? r.firstTurn.map(Boolean) : [false, false, false, false],
      };
    }
    let result = null;
    if (base?.result && (this.phase === 'roundEnd' || this.phase === 'matchEnd')) {
      const r = base.result;
      result = {
        winner: r.winner ?? null, kind: r.kind ?? null, okeyFinish: !!r.okeyFinish, tile: r.tile ?? null,
        groups: clone(r.groups ?? null), hands: clone(r.hands ?? null), deltas: clone(r.deltas ?? null),
        scores: clone(r.scores ?? null), turns: clone(r.turns ?? null),
      };
    }
    const winners = this.phase === 'matchEnd' && Array.isArray(base?.winners) ? base.winners.slice() : null;
    const hand = seat !== null && Array.isArray(base?.hand) ? base.hand.filter(isTile) : null;
    return {
      v: this.v, code: this.code, phase: this.phase, settings, host: this.hostSeat, you: seat,
      seats, round, hand, result, winners, now: this.now(),
    };
  }

  /** Public summary for the join screen. */
  summary() {
    return {
      code: this.code, phase: this.phase, settings: clone(this.settings),
      seats: this.seats.map((s, i) => ({
        kind: s.kind, name: s.kind === 'empty' ? null : s.name, avatar: s.kind === 'empty' ? null : s.avatar,
        connected: this.isConnected(i), bot: s.kind === 'bot' ? { level: s.level } : null,
      })),
      connections: this.conns.size,
    };
  }

  nextWakeAt() {
    if (this.pausedAt !== null && this.pausedAt !== undefined) return null;
    return this.deadline ?? null;
  }

  reschedule() {
    const at = this.nextWakeAt();
    if (at === this.scheduledAt) return;
    this.scheduledAt = at;
    this._schedule(at);
  }
}
