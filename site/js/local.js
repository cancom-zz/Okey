// LocalTable: runs a TableHost for solo practice (DESIGN.md "One host, two transports").
//
// Same protocol, same bots, same views as an online room; timers use setTimeout and dealing uses cryptoRng.
// The host runs in a module Web Worker (local-worker.js) so bot thinking never blocks the page's animations;
// where Workers are unavailable (or the worker fails to start) it runs in the page instead, same behaviour.
// Practice results stay on this device: onResult goes to stats.js (recordPractice), never to the server.
//
//   const table = createSoloTable({ name, avatar, levels: ['kalfa', 'usta', 'uzman'], settings });
//   table.onmessage = (msg) => ...;   // { t: 'view' | 'emote' | 'error' | 'pong', ... }
//   table.connect();                  // sits you in seat 0 with three bots and starts the match
//   table.send({ t: 'act', action, v });
//   table.close();
//   table.mode                        // 'worker' | 'page' (after connect)
//
// A solo table saves its snapshot in localStorage (key `okey.solo`) after every change (the worker can't use
// localStorage: it posts each snapshot to the page, which saves it), so a reload can continue it:
// createSoloTable({ resume: true }) picks up the saved table if there is one (check with hasSoloTable()).

import { TableHost } from '../shared/host.js';
import { cryptoRng } from '../shared/okey/index.js';

const CONN = 'local';
const SOLO_KEY = 'okey.solo';
const SOLO_PLAYER = { id: 'solo-player', secret: 'solo-secret-local' };
const WORKER_START_MS = 4000;

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

/**
 * A TableHost with setTimeout timers and one local connection. Used in the page and inside local-worker.js.
 *   emit(msg): a message for the page; persist(entry): { at, host: snapshot } after each change;
 *   result(summary): a round or match ended.
 */
export function createRunner({ code = 'SOLO', settings, saved, script = [], emit, persist, result }) {
  let timer = null;
  let open = false;
  const host = new TableHost({
    code, settings, saved,
    now: () => Date.now(),
    rng: cryptoRng(),
    schedule(at) {
      clearTimeout(timer);
      timer = null;
      if (at === null || at === undefined) return;
      timer = setTimeout(() => {
        timer = null;
        host.wake();
        flush();
      }, Math.max(0, at - Date.now()));
    },
    send: (connId, msg) => emit(msg),
    close: () => { open = false; },
    onResult: (s) => { try { result(s); } catch { /* stats never break the table */ } },
  });
  function flush() {
    if (!host.dirty) return;
    host.dirty = false;
    persist({ at: Date.now(), host: host.snapshot() });
  }
  return {
    host,
    connect() {
      if (open) return;
      open = true;
      host.connect(CONN);
      for (const msg of script) host.message(CONN, msg);
      script = [];
      flush();
    },
    message(msg) {
      if (!open) return;
      host.message(CONN, msg);
      flush();
    },
    close() {
      if (!open) return;
      open = false;
      clearTimeout(timer);
      timer = null;
      host.disconnect(CONN);
      flush();
    },
  };
}

/**
 * Use a worker unless: Workers are missing, the page asks not to (?worker=0), or the page's timers are not the
 * browser's own (a test clock such as Playwright's page.clock): the host must share the page's clock then.
 */
function canUseWorker() {
  if (typeof Worker === 'undefined' || typeof URL === 'undefined' || typeof location === 'undefined') return false;
  try { if (new URLSearchParams(location.search).get('worker') === '0') return false; } catch { /* ignore */ }
  try { return /\[native code\]/.test(Function.prototype.toString.call(setTimeout)); } catch { return false; }
}

export class LocalTable {
  /**
   * @param {object} o
   * @param {string} [o.code]        room code shown in views
   * @param {object} [o.settings]
   * @param {object} [o.saved]       a TableHost snapshot to continue
   * @param {string} [o.storageKey]  save the snapshot here after every change (localStorage)
   * @param {object[]} [o.script]    messages sent on connect(), before anything from the page
   * @param {(summary) => void} [o.onResult]  round / match summaries (local only)
   * @param {boolean} [o.worker]     run the host in a Web Worker (default: when available)
   */
  constructor({ code = 'SOLO', settings, saved, storageKey = null, script = [], onResult, worker = canUseWorker() } = {}) {
    this.onmessage = null;
    this.opts = { code, settings, saved, script };
    this.storageKey = storageKey;
    this.onResult = onResult || (() => {});
    this.useWorker = worker;
    this.open = false;
    this.discarded = false;
    this.mode = null;
    this.runner = null;     // in the page
    this.worker = null;     // or in a worker
    this.ready = false;
    this.queue = [];        // page -> worker messages until it says ready
  }

  connect() {
    if (this.open) return;
    this.open = true;
    if (this.useWorker && this.startWorker()) return;
    this.startPage();
  }

  setMode(mode) {
    this.mode = mode;
    globalThis.__okeyLocalMode = mode; // for tests and the console
  }

  send(msg) {
    if (!this.open) return;
    // Copy, as a network would: the page can never hold a reference into the host's state.
    const copy = JSON.parse(JSON.stringify(msg));
    if (this.runner) this.runner.message(copy);
    else if (this.worker) this.post({ op: 'send', msg: copy });
  }

  close() {
    if (!this.open) return;
    this.open = false;
    if (this.runner) this.runner.close();
    else if (this.worker) {
      this.post({ op: 'close' });
      // the worker answers 'closed' once its last snapshot is out; don't wait forever
      const w = this.worker;
      setTimeout(() => w.terminate(), 2000);
    }
  }

  /** Forget the saved table (e.g. the player left the match). */
  discard() {
    this.close();
    this.discarded = true;
    if (this.storageKey) storage.del(this.storageKey);
  }

  // ---- in the page ----
  startPage() {
    this.setMode('page');
    this.runner = createRunner({
      ...this.opts,
      emit: (msg) => this.deliver(JSON.stringify(msg)),
      persist: (entry) => this.persist(entry),
      result: (s) => this.onResult(JSON.parse(JSON.stringify(s))),
    });
    this.runner.connect();
  }

  deliver(json) {
    // Async, like a socket: the page never re-enters the host from inside its own send().
    setTimeout(() => {
      if (this.open && typeof this.onmessage === 'function') this.onmessage(JSON.parse(json));
    }, 0);
  }

  persist(entry) {
    if (this.storageKey && !this.discarded) storage.set(this.storageKey, entry);
  }

  // ---- in a worker ----
  startWorker() {
    let w;
    try {
      w = new Worker(new URL('./local-worker.js', import.meta.url), { type: 'module' });
    } catch {
      return false;
    }
    this.worker = w;
    this.setMode('worker');
    const fallback = () => {
      if (this.ready || this.worker !== w) return;
      clearTimeout(this.startT);
      try { w.terminate(); } catch { /* ignore */ }
      this.worker = null;
      this.queue = [];
      if (this.open) this.startPage(); // nothing ran in the worker yet: start over in the page
    };
    this.startT = setTimeout(fallback, WORKER_START_MS);
    w.onerror = (e) => { if (!this.ready) { e.preventDefault?.(); fallback(); } };
    w.onmessageerror = fallback;
    w.onmessage = (e) => {
      const m = e.data || {};
      if (m.op === 'ready') {
        this.ready = true;
        clearTimeout(this.startT);
        w.postMessage({ op: 'init', opts: this.opts });
        for (const q of this.queue.splice(0)) w.postMessage(q);
      } else if (m.op === 'msg') {
        if (this.open && typeof this.onmessage === 'function') this.onmessage(m.msg);
      } else if (m.op === 'save') {
        this.persist(m.entry);
      } else if (m.op === 'result') {
        this.onResult(m.summary);
      } else if (m.op === 'closed') {
        w.terminate();
      }
    };
    return true;
  }

  post(m) {
    if (!this.worker) return;
    if (this.ready) this.worker.postMessage(m);
    else this.queue.push(m);
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

/** Practice results go to stats.js on this device (only in a browser page). */
function practiceResult(summary) {
  if (typeof document === 'undefined') return;
  import('./stats.js').then((m) => m.recordPractice(summary)).catch(() => {});
}

/**
 * A solo practice table: you in seat 0 (host), bots of `levels` in seats 1..3, the match started on
 * connect() (pass autoStart: false to stay in the lobby). resume: true continues the saved table instead,
 * when there is one. onResult defaults to recording practice stats (stats.js).
 */
export function createSoloTable({ name, avatar, levels = ['kalfa', 'kalfa', 'kalfa'], settings, autoStart = true, resume = false, onResult = practiceResult, worker } = {}) {
  if (resume && hasSoloTable()) {
    return new LocalTable({
      saved: pausedSince(storage.get(SOLO_KEY)), storageKey: SOLO_KEY, onResult, worker,
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
  return new LocalTable({ storageKey: SOLO_KEY, script, onResult, worker });
}
