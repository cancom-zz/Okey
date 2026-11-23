// Room: one Okey table. A TableHost (site/shared/host.js) behind the WebSocket Hibernation API.
//
//   - Each socket is accepted with a tag = its connId, and carries an attachment { connId, playerId } so the
//     host's connection -> seat map can be rebuilt after hibernation (host.bind for every live socket).
//   - The host's snapshot is saved to storage after every change; the host is rebuilt lazily on wake.
//   - One alarm serves both the host's timers (turns, bots, next round) and the idle cleanup: 30 minutes
//     without a socket deletes the room.
//   - {"t":"ping"} is answered at the edge with {"t":"pong"} without waking the room (no `now`; views
//     carry `now` for clock sync).
import { DurableObject } from 'cloudflare:workers';
import { TableHost } from '../site/shared/host.js';
import { cryptoRng } from '../site/shared/okey/index.js';

export const IDLE_MS = 30 * 60e3;
const MAX_FRAME = 4096; // characters per client message

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.host = null;
    this.wakeAt = null;     // what the host asked for
    this.alarmAt = undefined; // what is set (undefined: unknown after a wake)
    this.pending = [];      // stats writes in flight
    try {
      ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
    } catch { /* older runtimes: pings reach the host */ }
  }

  makeHost(opts) {
    return new TableHost({
      ...opts,
      now: () => Date.now(),
      rng: cryptoRng(),
      schedule: (at) => { this.wakeAt = at; },
      send: (connId, msg) => {
        for (const ws of this.ctx.getWebSockets(connId)) {
          try { ws.send(JSON.stringify(msg)); } catch { /* closing */ }
        }
      },
      close: (connId, code, reason) => {
        for (const ws of this.ctx.getWebSockets(connId)) {
          try { ws.close(code, reason); } catch { /* already closed */ }
        }
      },
      onResult: (summary) => this.pending.push(this.record(summary)),
    });
  }

  /** The host, rebuilt from storage (and re-bound to the live sockets) if this object just woke up. */
  async load() {
    if (this.host) return this.host;
    const saved = await this.ctx.storage.get('host');
    if (!saved) return null;
    const host = this.makeHost({ saved });
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (a?.connId) host.bind(a.connId, a.playerId ?? null);
    }
    host.pauseIfEmpty();
    this.host = host;
    return host;
  }

  /** Save the snapshot if it changed, then point the alarm at the next host timer or the idle cleanup. */
  async persist() {
    const host = this.host;
    if (!host) return;
    if (host.dirty) {
      host.dirty = false;
      await this.ctx.storage.put('host', host.snapshot());
    }
    let idleAt = null;
    if (host.conns.size === 0) {
      idleAt = (await this.ctx.storage.get('idleAt')) ?? null;
      if (!idleAt) {
        idleAt = Date.now() + IDLE_MS;
        await this.ctx.storage.put('idleAt', idleAt);
      }
    } else if (this.idle !== false) {
      await this.ctx.storage.delete('idleAt');
    }
    this.idle = idleAt !== null;
    const times = [host.nextWakeAt(), idleAt].filter((t) => Number.isFinite(t));
    const at = times.length ? Math.min(...times) : null;
    if (at !== this.alarmAt) {
      if (at === null) await this.ctx.storage.deleteAlarm();
      else await this.ctx.storage.setAlarm(at);
      this.alarmAt = at;
    }
    if (this.pending.length) await Promise.allSettled(this.pending.splice(0));
  }

  async record(summary) {
    try {
      await this.env.STATS.get(this.env.STATS.idFromName('main')).record(summary);
    } catch (err) {
      console.error('stats', err?.message);
    }
  }

  // ---------------------------------------------------------------- RPC from the worker

  /** Create the room. false if this code is already in use. */
  async init(code, settings) {
    if (this.host || (await this.ctx.storage.get('host'))) return false;
    this.host = this.makeHost({ code, settings });
    this.host.pauseIfEmpty();
    await this.persist();
    return true;
  }

  /** Public summary for the join screen, or null if there is no such room. */
  async info() {
    const host = await this.load();
    return host ? host.summary() : null;
  }

  // ---------------------------------------------------------------- sockets

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket.', { status: 426 });
    const host = await this.load();
    if (!host) return new Response('No such room.', { status: 404 });
    const [client, server] = Object.values(new WebSocketPair());
    const connId = crypto.randomUUID();
    this.ctx.acceptWebSocket(server, [connId]);
    server.serializeAttachment({ connId, playerId: null });
    host.connect(connId);
    await this.persist();
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, data) {
    const host = await this.load();
    const a = ws.deserializeAttachment() || {};
    if (!host || !a.connId) {
      try { ws.close(4004, 'gone'); } catch { /* closed */ }
      return;
    }
    let msg = null;
    if (typeof data === 'string' && data.length <= MAX_FRAME) {
      try { msg = JSON.parse(data); } catch { msg = null; }
    }
    if (msg === null) {
      try { ws.send(JSON.stringify({ t: 'error', code: 'badMessage' })); } catch { /* closed */ }
      return;
    }
    try {
      host.message(a.connId, msg);
    } catch (err) {
      console.error('host.message', err?.stack || err);
      try { ws.send(JSON.stringify({ t: 'error', code: 'server' })); } catch { /* closed */ }
    }
    const playerId = host.playerOf(a.connId);
    if (playerId !== (a.playerId ?? null)) ws.serializeAttachment({ connId: a.connId, playerId });
    await this.persist();
  }

  async webSocketClose(ws, code) {
    await this.closed(ws);
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, 'bye'); } catch { /* already closed */ }
  }

  async webSocketError(ws) {
    await this.closed(ws);
  }

  async closed(ws) {
    const host = await this.load();
    const a = ws.deserializeAttachment() || {};
    if (!host || !a.connId) return;
    try { host.disconnect(a.connId); } catch (err) { console.error('host.disconnect', err?.stack || err); }
    await this.persist();
  }

  async alarm() {
    this.alarmAt = undefined;
    const host = await this.load();
    if (!host) {
      await this.ctx.storage.deleteAll();
      return;
    }
    const idleAt = await this.ctx.storage.get('idleAt');
    if (host.conns.size === 0 && idleAt && Date.now() >= idleAt) {
      // 30 minutes without a socket: the room is gone.
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      this.host = null;
      return;
    }
    try { host.wake(); } catch (err) { console.error('host.wake', err?.stack || err); }
    await this.persist();
  }
}
