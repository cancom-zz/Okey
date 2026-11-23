// Tiles: integer ids 0..105 (see DESIGN.md "Tiles").
//
//   id < 104: color = floor(id / 26), num = id % 13 + 1, copy = floor((id % 26) / 13)
//   104, 105: the two false jokers (sahte okey)
//
// The okey (wild) is described by its face `{ color, num }`. Both normal copies of that face are wild;
// the false jokers stand for that face and are NOT wild.

export const COLORS = ['red', 'yellow', 'blue', 'black'];
export const TILE_COUNT = 106;
export const FALSE_JOKERS = [104, 105];

export const isFalseJoker = (id) => id === 104 || id === 105;

/** Color index 0..3, or null for a false joker. */
export const color = (id) => (id < 104 ? Math.floor(id / 26) : null);

/** Number 1..13, or null for a false joker. */
export const num = (id) => (id < 104 ? (id % 13) + 1 : null);

/** Copy 0 or 1 (false jokers: 0 and 1 too). */
export const copy = (id) => (id < 104 ? Math.floor((id % 26) / 13) : id - 104);

/** The id of a normal tile. */
export const tileId = (c, n, cp = 0) => c * 26 + cp * 13 + (n - 1);

/** The other copy of a normal tile (same face), or the other false joker. */
export const otherCopy = (id) => (id < 104 ? tileId(color(id), num(id), 1 - copy(id)) : 209 - id);

/** Is `id` a valid tile id? */
export const isTile = (id) => Number.isInteger(id) && id >= 0 && id < TILE_COUNT;

/** The okey's face for an indicator tile: same color, next number (13 -> 1). */
export function okeyFace(indicatorId) {
  return { color: color(indicatorId), num: (num(indicatorId) % 13) + 1 };
}

/** Is `id` one of the two wild okeys? */
export const isOkey = (id, okey) => id < 104 && color(id) === okey.color && num(id) === okey.num;

/**
 * How a tile plays: okey -> `{ color, num, wild: true }` (its printed face, but wild);
 * false joker -> the okey's face, not wild; normal tile -> its own face.
 */
export function faceOf(id, okey) {
  if (isFalseJoker(id)) return { color: okey.color, num: okey.num, wild: false };
  return { color: color(id), num: num(id), wild: isOkey(id, okey) };
}

/** Do two tiles play as the same (non-wild) face? */
export function sameFace(a, b, okey) {
  const fa = faceOf(a, okey);
  const fb = faceOf(b, okey);
  return !fa.wild && !fb.wild && fa.color === fb.color && fa.num === fb.num;
}

/** All 106 ids in order. */
export const allTiles = () => Array.from({ length: TILE_COUNT }, (_, i) => i);
