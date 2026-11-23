// Test helper: a view that throws when a bot reads anything it must not use, or writes anything.
// Shared by bots.test.mjs (classic) and bots101.test.mjs.

/**
 * A view wrapped so that reading anything a bot must not use throws, and writing anything throws.
 * Allowed: the DESIGN.md "View" fields, minus everything that identifies a seat (kind, bot, name, avatar,
 * connected, away, id).
 */
export const ALLOWED = {
  root: ['v', 'code', 'phase', 'settings', 'host', 'you', 'seats', 'round', 'hand', 'result', 'now', 'winners'],
  // public settings a bot may read: the variant, and the 101 rule settings (DESIGN.md "101 Okey")
  settings: ['variant', 'openingValue', 'minPairs', 'aceHighValue', 'raiseOpening', 'pairsOpening', 'pairsOnly',
    'pairsCanAdd', 'addOnOpeningTurn', 'okeySwap', 'scoring', 'doubles'],
  scoring: ['finish', 'unopened', 'okeyInHand', 'islek', 'okeyDiscard'],
  // 101: table melds and the public opening state
  meld: ['owner', 'kind', 'tiles', 'color', 'start', 'num'],
  seat: ['score', 'handCount', 'discard', 'showedIndicator'],
  discard: ['top', 'count'],
  round: ['number', 'dealer', 'turn', 'stage', 'indicator', 'okey', 'pileCount', 'turnEndsAt', 'firstTurn',
    'table', 'opened', 'openings', 'required', 'penalties', 'taken'],
  required: ['value', 'pairs'],
  okey: ['color', 'num'],
};
const ARRAY_OK = new Set(['length', 'constructor', 'slice', 'map', 'filter', 'includes', 'indexOf', 'some',
  'every', 'forEach', 'find', 'findIndex', 'reduce', 'at', 'concat', 'join', 'entries', 'keys', 'values', 'flatMap', 'flat']);

export function guard(value, kind, path, log) {
  if (value === null || typeof value !== 'object') return value;
  const allowed = new Set(ALLOWED[kind] ?? []);
  const childKind = (prop) => {
    if (kind === 'root') return { seats: 'seats', round: 'round', hand: 'array', settings: 'settings', result: 'opaque', winners: 'array' }[prop];
    if (kind === 'seats') return 'seat';
    if (kind === 'seat' && prop === 'discard') return 'discard';
    if (kind === 'settings') return prop === 'scoring' ? 'scoring' : prop === 'doubles' ? 'opaque' : undefined;
    if (kind === 'round') {
      return { okey: 'okey', firstTurn: 'array', table: 'melds', opened: 'array', openings: 'array', required: 'required',
        penalties: 'array' }[prop];
    }
    if (kind === 'meld' && prop === 'tiles') return 'array';
    return undefined;
  };
  return new Proxy(value, {
    get(target, prop, receiver) {
      if (typeof prop === 'symbol') return Reflect.get(target, prop, receiver);
      const isArray = Array.isArray(target);
      const ok = isArray ? (/^\d+$/.test(prop) || ARRAY_OK.has(prop)) : allowed.has(prop);
      if (!ok || kind === 'opaque') throw new Error(`bot read forbidden view field ${path}.${prop}`);
      log?.add(`${path}.${isArray && /^\d+$/.test(prop) ? '[]' : prop}`);
      const v = Reflect.get(target, prop, receiver);
      const ck = isArray && /^\d+$/.test(prop) ? ({ seats: 'seat', melds: 'meld' }[kind] ?? 'array') : childKind(prop);
      return ck ? guard(v, ck, `${path}.${prop}`, log) : v;
    },
    set() { throw new Error(`bot wrote to the view at ${path}`); },
    defineProperty() { throw new Error(`bot wrote to the view at ${path}`); },
    deleteProperty() { throw new Error(`bot deleted from the view at ${path}`); },
    // Melds are wholly public (the 101 helpers copy them with a spread); anything else may not be enumerated.
    ownKeys(target) {
      if (kind === 'meld') return Reflect.ownKeys(target);
      throw new Error(`bot enumerated ${path}`);
    },
  });
}

