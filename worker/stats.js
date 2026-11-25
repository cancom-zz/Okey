// Stats: player statistics, achievements, device transfer codes and rate limits, in one SQLite-backed Durable
// Object for everyone (DESIGN.md "Statistics and achievements"). Only Rooms write results (record), from
// server-side round/match summaries, so they can't be faked. The logic lives in stats-store.js.
import { DurableObject } from 'cloudflare:workers';
import { StatsStore } from './stats-store.js';

export class Stats extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.store = new StatsStore(ctx.storage.sql);
  }

  record(summary) { return this.store.record(summary); }
  get(id, secret) { return this.store.get(id, secret); }
  /** Several limits at once: [[key, max, windowMs], ...] -> true only if every one allows it. */
  limits(list) {
    let ok = true;
    for (const [key, max, windowMs] of list) if (!this.store.limit(key, max, windowMs)) ok = false;
    return ok;
  }
  createTransfer(payload) { return this.store.createTransfer(payload); }
  claimTransfer(code) { return this.store.claimTransfer(code); }
}
