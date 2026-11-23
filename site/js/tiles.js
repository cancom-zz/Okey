// Tiles on the client: decoding (DESIGN.md "Tiles"), markup, and a light rules fallback used only until the
// shared engine (site/shared/okey/) is available. The engine is loaded lazily; when present it is the source of truth.

export const isFalseJoker = id => id >= 104;
export const color = id => (id < 104 ? Math.floor(id / 26) : -1);
export const num = id => (id < 104 ? (id % 13) + 1 : 0);
export const COLOR_NAMES = ['red', 'yellow', 'blue', 'black'];
export const okeyFace = indicator => ({ color: color(indicator), num: (num(indicator) % 13) + 1 });
export const isOkey = (id, okey) => !!okey && id < 104 && color(id) === okey.color && num(id) === okey.num;
export function faceOf(id, okey) {
  if (isOkey(id, okey)) return { color: okey.color, num: okey.num, wild: true };
  if (isFalseJoker(id)) return okey ? { color: okey.color, num: okey.num, wild: false } : { color: -1, num: 0, wild: false };
  return { color: color(id), num: num(id), wild: false };
}
export const sameFace = (a, b) => (a < 104 && b < 104 ? color(a) === color(b) && num(a) === num(b) : a >= 104 && b >= 104);

// ---- markup ----
const STAR = '<svg viewBox="0 0 40 40" aria-hidden="true"><defs><radialGradient id="fjg" cx="40%" cy="35%" r="70%"><stop offset="0" stop-color="#3f8f5c"/><stop offset="1" stop-color="#0f3d22"/></radialGradient></defs>'
  + '<circle cx="20" cy="20" r="17" fill="none" stroke="url(#fjg)" stroke-width="2.4"/>'
  + '<path fill="url(#fjg)" d="M20 6.5l3.6 8.6 9.3.8-7.1 6.1 2.2 9.1L20 26.3l-8 4.8 2.2-9.1-7.1-6.1 9.3-.8z"/></svg>';

// A tile's inner markup. The outer element carries classes: tile, c0..c3 | fj, okey (for the viewer's okeys).
export function tileInner(id) {
  if (id == null || id < 0) return '';
  if (isFalseJoker(id)) return `<span class="emb">${STAR}</span>`;
  return `<b>${num(id)}</b><i></i>`;
}
export function tileClass(id, okey) {
  if (id == null || id < 0) return 'tile back';
  return 'tile ' + (isFalseJoker(id) ? 'fj' : 'c' + color(id)) + (isOkey(id, okey) ? ' okey' : '');
}
export function tileHTML(id, okey, extra = '', attrs = '') {
  return `<div class="${tileClass(id, okey)} ${extra}" ${attrs}>${tileInner(id)}</div>`;
}
// A tile that shows a face (not an id), e.g. "okey = blue 7"
export function faceHTML(face, extra = '') {
  if (!face) return '';
  return `<div class="tile c${face.color} ${extra}"><b>${face.num}</b><i></i></div>`;
}

// ---- engine (lazy) ----
let engine = null, enginePromise = null;
export function loadEngine() {
  if (!enginePromise) {
    enginePromise = import('../shared/okey/index.js').then(m => { engine = m; return m; }).catch(() => null);
  }
  return enginePromise;
}
export const getEngine = () => engine;

// ---- light rules (fallback) ----
export function validSetLite(ids, okey) {
  if (engine && engine.validSet) { try { return engine.validSet(ids, okey); } catch { /* fall through */ } }
  const n = ids.length;
  if (n < 3 || n > 13) return null;
  const faces = ids.map(id => faceOf(id, okey));
  const fixed = faces.filter(f => !f.wild);
  if (n <= 4) {
    const nums = new Set(fixed.map(f => f.num)), cols = new Set(fixed.map(f => f.color));
    if (nums.size <= 1 && cols.size === fixed.length) return 'group';
  }
  if (new Set(fixed.map(f => f.color)).size <= 1) {
    const ns = fixed.map(f => f.num);
    if (new Set(ns).size === ns.length) {
      for (let s = 1; s + n - 1 <= 14; s++) {
        const e = s + n - 1;
        if (ns.every(x => (x >= s && x <= e) || (x === 1 && e === 14))) return 'run';
      }
    }
  }
  return null;
}

// Groups as laid out on the rack: contiguous tiles in one tier.
export function layoutGroups(slots, cols) {
  const groups = [];
  for (let tier = 0; tier * cols < slots.length; tier++) {
    let cur = [];
    for (let c = 0; c < cols; c++) {
      const id = slots[tier * cols + c];
      if (id == null) { if (cur.length) groups.push(cur); cur = []; } else cur.push(id);
    }
    if (cur.length) groups.push(cur);
  }
  return groups;
}

// Does this hand (14 tiles, after the finishing discard) finish? Returns { kind, groups } or null.
// Uses the engine's exhaustive search when available; otherwise checks the player's own layout.
export function finishCheck(ids14, okey, layout) {
  if (ids14.length !== 14) return null;
  if (engine && engine.findFinish) { try { return engine.findFinish(ids14, okey); } catch { /* fall through */ } }
  if (!layout) return null;
  if (layout.every(g => validSetLite(g, okey)) && layout.reduce((a, g) => a + g.length, 0) === 14) return { kind: 'sets', groups: layout };
  // pairs: 7 groups of 2 identical faces (an okey pairs with anything)
  const pairs = [];
  for (const g of layout) for (let i = 0; i < g.length; i += 2) pairs.push(g.slice(i, i + 2));
  if (pairs.length === 7 && pairs.every(p => p.length === 2 && (isOkey(p[0], okey) || isOkey(p[1], okey) || sameFace2(p[0], p[1], okey)))) return { kind: 'pairs', groups: pairs };
  return null;
}
function sameFace2(a, b, okey) { const fa = faceOf(a, okey), fb = faceOf(b, okey); return fa.color === fb.color && fa.num === fb.num; }

// Sort helper for the "Seri diz" / "Çift diz" buttons. Engine arrange() when present, else a simple sort.
export function arrange(ids, okey, mode) {
  if (engine && engine.arrange) { try { return engine.arrange(ids, okey, mode); } catch { /* fall through */ } }
  const key = id => { const f = faceOf(id, okey); return f.wild ? 999 : f.color * 20 + f.num; };
  const sorted = ids.slice().sort((a, b) => key(a) - key(b));
  if (mode === 'pairs') {
    const used = new Set(), out = [], rest = [];
    for (let i = 0; i < sorted.length; i++) {
      if (used.has(i)) continue;
      const j = sorted.findIndex((x, k) => k > i && !used.has(k) && sameFace2(x, sorted[i], okey));
      if (j > 0) { used.add(i); used.add(j); out.push([sorted[i], sorted[j]]); } else { rest.push(sorted[i]); used.add(i); }
    }
    return rest.length ? [...out, rest] : out;
  }
  if (mode === 'groups') {
    const byNum = new Map();
    for (const id of sorted) { const f = faceOf(id, okey); const k = f.wild ? 99 : f.num; if (!byNum.has(k)) byNum.set(k, []); byNum.get(k).push(id); }
    return [...byNum.entries()].sort((a, b) => a[0] - b[0]).map(e => e[1]);
  }
  // runs: split each colour where the numbers stop being consecutive
  const out = []; let cur = [];
  for (const id of sorted) {
    const f = faceOf(id, okey), p = cur.length ? faceOf(cur[cur.length - 1], okey) : null;
    if (p && !f.wild && (p.color !== f.color || f.num !== p.num + 1)) { out.push(cur); cur = []; }
    cur.push(id);
  }
  if (cur.length) out.push(cur);
  return out;
}
