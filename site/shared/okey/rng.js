// Random number sources. Everything in the engine takes an `rng` with one method: `int(n) -> 0..n-1`.

/**
 * Cryptographically secure rng (crypto.getRandomValues; works in browsers, Workers and Node).
 * Uses rejection sampling so every value is exactly equally likely.
 */
export function cryptoRng() {
  const buf = new Uint32Array(64);
  let pos = buf.length;
  const next32 = () => {
    if (pos === buf.length) {
      globalThis.crypto.getRandomValues(buf);
      pos = 0;
    }
    return buf[pos++];
  };
  return {
    int(n) {
      if (!Number.isInteger(n) || n < 1 || n > 2 ** 32) throw new RangeError('rng.int: bad n');
      const limit = 2 ** 32 - (2 ** 32 % n); // largest multiple of n that fits
      let x;
      do x = next32();
      while (x >= limit);
      return x % n;
    },
  };
}

/** FNV-1a: turns a string seed into 32 bits. */
function hashSeed(seed) {
  if (typeof seed === 'number') return seed >>> 0;
  let h = 0x811c9dc5;
  for (const ch of String(seed)) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Small, fast, deterministic rng (mulberry32) for tests and bots. Not for dealing real games.
 * `seed` may be a number or a string. `state()` returns the current state, so
 * `seededRng(r.state())` continues the same sequence (handy for serializable bots).
 */
export function seededRng(seed = 1) {
  let a = hashSeed(seed);
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    int(n) {
      return Math.floor(next() * n);
    },
    /** A float in [0, 1). */
    random: next,
    state: () => a,
  };
}

/** Fisher–Yates. Returns a new shuffled array; `arr` is not modified. */
export function shuffle(arr, rng) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.int(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
