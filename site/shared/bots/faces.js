// Face arithmetic for the bots, written straight from DESIGN.md "Tiles" (pure, no state).
// A face index is color * 13 + (num - 1), 0..51. The two real okeys (wild) map to WILD.
// False jokers map to the okey's face (they play as that color and number).

export const FACES = 52;
export const WILD = 52;

export const tileColor = (id) => Math.floor(id / 26);
export const tileNum = (id) => (id % 13) + 1;

export function okeyFaceIndex(okey) {
  return okey.color * 13 + okey.num - 1;
}

export function faceIndex(id, okey) {
  if (id >= 104) return okeyFaceIndex(okey);
  const c = Math.floor(id / 26);
  const n = (id % 13) + 1;
  if (c === okey.color && n === okey.num) return WILD;
  return c * 13 + n - 1;
}

export const faceColor = (f) => Math.floor(f / 13);
export const faceNum = (f) => (f % 13) + 1; // 1..13

// Counts per face plus the number of wild okeys, for a list of tile ids.
export function handVector(ids, okey) {
  const counts = new Int8Array(FACES);
  let jokers = 0;
  for (const id of ids) {
    const f = faceIndex(id, okey);
    if (f === WILD) jokers++;
    else counts[f]++;
  }
  return { counts, jokers };
}

// Faces that can complete a two-tile partial set, for out counting.
// Partial kinds: 'conn' (n, n+1 same color), 'gap' (n, n+2), 'wrap13' (13 and 1), 'wrap12' (12 and 1),
// 'group' (same num, colors c1 < c2).
export function runNeighbors(f) {
  // Faces that sit next to f in some run (distance 1 or 2), same color, honouring 12-13-1 but not 13-1-2.
  const c = faceColor(f), n = faceNum(f);
  const out = [];
  const add = (m, d) => out.push({ f: c * 13 + m - 1, d });
  if (n >= 2) add(n - 1, 1);
  if (n >= 3) add(n - 2, 2);
  if (n <= 12) add(n + 1, 1);
  if (n <= 11) add(n + 2, 2);
  if (n === 13) add(1, 1);           // 13-1 (end of 12-13-1)
  if (n === 12) add(1, 2);           // 12-_-1
  if (n === 1) { add(13, 1); add(12, 2); }
  return out;
}

export function groupNeighbors(f) {
  const c = faceColor(f), n = faceNum(f);
  const out = [];
  for (let k = 0; k < 4; k++) if (k !== c) out.push(k * 13 + n - 1);
  return out;
}
