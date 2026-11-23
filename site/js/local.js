// LocalTable: runs a TableHost in the page for solo practice (DESIGN.md "One host, two transports").
//
// Same protocol, same bots, same views as an online room; timers use setTimeout and dealing uses
// cryptoRng. Practice results stay local: onResult is never sent to the server.
//
//   const table = createSoloTable({ name, avatar, levels: ['kalfa', 'usta', 'uzman'], settings });
//   table.onmessage = (msg) => ...;   // { t: 'view' | 'emote' | 'error' | 'pong', ... }
//   table.connect();                  // sits you in seat 0 with three bots and starts the match
//   table.send({ t: 'act', action, v });
//   table.close();
//
// A solo table saves its snapshot in localStorage (key `okey.solo`) after every change, so a reload can
// continue it: createSoloTable({ resume: true }) picks up the saved table if there is one (check with
// hasSoloTable()).

import { TableHost } from '../shared/host.js';
import { cryptoRng } from '../shared/okey/index.js';

const CONN = 'local';
const SOLO_KEY = 'okey.solo';
const SOLO_PLAYER = { id: 'solo-player', secret: 'solo-secret-local' };

const storage = {
  get(key) {
    try { return JSON.parse(globalThis.localStorage?.getItem(key) ?? 'null'); } catch { return null; }
  },
  set(key, value) {
    try { globalThis.localStorage?.setItem(key, JSON.stringify(value)); } catch { /* private mode, full */ }
  },
  del(key) {
    try { globalThis.localStorage?.removeItem(key); } catch { /* ignore */ }
  },
};

export class LocalTable {
  /**
   * @param {object} o
   * @param {string} [o.code]        room code shown in views
   * @param {object} [o.settings]
   * @param {object} [o.saved]       a TableHost snapshot to continue
   * @param {string} [o.storageKey]  save the snapshot here after every change (localStorage)
   * @param {object[]} [o.script]    messages sent on connect(), before anything from the page
   * @param {(summary) => void} [o.onResult]  round / match summaries (local only)
   */
  constructor({ code = 'SOLO', settings, saved, storageKey = null, script = [], onResult } = {}) {
    this.onmessage = null;
    this.storageKey = storageKey;
    this.script = script;
    this.open = false;
    this.timer = null;
    this.host = new TableHost({
      code, settings, saved,
      now: () => Date.now(),
      rng: cryptoRng(),
      schedule: (at) => this.schedule(at),
      send: (connId, msg) => this.deliver(msg),
      close: () => { this.open = false; },
      onResult: onResult || (() => {}),
    });
  }

  connect() {
    if (this.open) return;
    this.open = true;
    this.host.connect(CONN);
    for (const msg of this.script) this.host.message(CONN, msg);
    this.script = [];
    this.save();
  }

  send(msg) {
    if (!this.open) return;
    // Copy, as a network would: the page can never hold a reference into the host's state.
    this.host.message(CONN, JSON.parse(JSON.stringify(msg)));
    this.save();
  }

  close() {
    if (!this.open) return;
    this.open = false;
    clearTimeout(this.timer);
    this.timer = null;
    this.host.disconnect(CONN);
    this.save();
  }

  /** Forget the saved table (e.g. the player left the match). */
  discard() {
    this.close();
    if (this.storageKey) storage.del(this.storageKey);
  }

  deliver(msg) {
    const copy = JSON.stringify(msg);
    // Async, like a socket: the page never re-enters the host from inside its own send().
    setTimeout(() => {
      if (this.open && typeof this.onmessage === 'function') this.onmessage(JSON.parse(copy));
    }, 0);
  }

  schedule(at) {
    clearTimeout(this.timer);
    this.timer = null;
    if (at === null || at === undefined) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.host.wake();
      this.save();
    }, Math.max(0, at - Date.now()));
  }

  save() {
    if (!this.storageKey || !this.host.dirty) return;
    this.host.dirty = false;
    storage.set(this.storageKey, { at: Date.now(), host: this.host.snapshot() });
  }
}

/** A saved table counts as paused since it was saved, so the time the page was closed doesn't run the clock. */
function pausedSince({ at, host }) {
  return host.pausedAt === null || host.pausedAt === undefined ? { ...host, pausedAt: at } : host;
}

/** Is there a saved solo table to continue? */
export const hasSoloTable = () => {
  const s = storage.get(SOLO_KEY)?.host;
  return !!(s && s.match && s.phase !== 'matchEnd');
};

/**
 * A solo practice table: you in seat 0 (host), bots of `levels` in seats 1..3, the match started on
 * connect() (pass autoStart: false to stay in the lobby). resume: true continues the saved table instead,
 * when there is one.
 */
export function createSoloTable({ name, avatar, levels = ['kalfa', 'kalfa', 'kalfa'], settings, autoStart = true, resume = false, onResult } = {}) {
  if (resume && hasSoloTable()) {
    return new LocalTable({
      saved: pausedSince(storage.get(SOLO_KEY)), storageKey: SOLO_KEY, onResult,
      script: [{ t: 'hello', player: { ...SOLO_PLAYER, name, avatar } }],
    });
  }
  storage.del(SOLO_KEY);
  const script = [
    { t: 'hello', player: { ...SOLO_PLAYER, name, avatar } },
    { t: 'sit', seat: 0 },
    ...(settings ? [{ t: 'settings', settings }] : []),
    ...levels.slice(0, 3).map((level, i) => ({ t: 'addBot', seat: i + 1, level })),
    ...(autoStart ? [{ t: 'start' }] : []),
  ];
  return new LocalTable({ storageKey: SOLO_KEY, script, onResult });
}
