// The ıstaka: two tiers of 13 slots, owned by the client (the server only knows the unordered hand).
// Tiles are absolutely positioned by slot, so moves glide by CSS transition. Drag with pointer events
// (touch + mouse): neighbours slide aside live; drop on the rack, on your discard spot or on the centre (finish).
import { COLS, TIERS } from './config.js';
import { tileClass, tileInner, tileLabel, isOkey, arrange as arrangeIds, layoutGroups } from './tiles.js';
import { S } from './store.js';
import { loadRack, saveRack } from './store.js';
import { sfx, buzz } from './sound.js';
import { dur, reduced } from './anim.js';

// Put `id` at slot `to`; occupied slots shift toward the nearest gap in that tier. Pure: returns a new array.
export function moveIn(slots, id, to, cols = COLS) {
  const s = slots.slice();
  const from = s.indexOf(id);
  if (from >= 0) s[from] = null;
  if (s[to] == null) { s[to] = id; return s; }
  const base = Math.floor(to / cols) * cols;
  let r = -1, l = -1;
  for (let j = to + 1; j < base + cols; j++) if (s[j] == null) { r = j; break; }
  for (let j = to - 1; j >= base; j--) if (s[j] == null) { l = j; break; }
  if (r >= 0 && (l < 0 || r - to <= to - l)) { for (let k = r; k > to; k--) s[k] = s[k - 1]; s[to] = id; return s; }
  if (l >= 0) { for (let k = l; k < to; k++) s[k] = s[k + 1]; s[to] = id; return s; }
  if (from >= 0) { s[from] = s[to]; s[to] = id; return s; }   // the tier is full: swap
  const e = s.indexOf(null); if (e >= 0) s[e] = id;
  return s;
}

// Lay groups out tier by tier with one gap between them (fewer gaps when it would not fit).
export function layoutFromGroups(groups, cols = COLS, tiers = TIERS) {
  const SLOTS = cols * tiers;
  // sets keep a gap between them; loose leftovers too when there is room, else they close up
  for (const [setGap, looseGap] of [[1, 1], [1, 0], [0, 0]]) {
    const s = Array(SLOTS).fill(null);
    let tier = 0, col = 0, ok = true;
    for (const g of groups) {
      if (!g.length) continue;
      if (col + g.length > cols) {
        if (tier + 1 < tiers && g.length <= cols) { tier++; col = 0; } else { ok = false; break; }
      }
      g.forEach((id, i) => { s[tier * cols + col + i] = id; });
      col += g.length + (g.loose ? looseGap : setGap);
    }
    if (ok) return s;
  }
  const s = Array(SLOTS).fill(null); groups.flat().forEach((id, i) => { s[i] = id; }); return s;
}

export class Rack {
  constructor(host, opts = {}) {
    this.host = host; this.opts = opts;
    this.cols = COLS; this.tiers = TIERS;
    this.slots = Array(COLS * TIERS).fill(null);
    this.marks = []; this.flags = new Map(); this.upright = new Set(); this.facedown = new Set();
    this.preview = null; this.okey = null; this.key = null;
    this.els = new Map(); this.selected = null; this.hidden = new Set();
    this.tw = 28; this.th = 42; this.gap = 2; this.tierGap = 8; this.padX = 0;
    host.innerHTML = '<div class="rack-tiers" aria-hidden="true"></div><div class="rack-tiles" role="list"></div>';
    this.box = host.querySelector('.rack-tiles');
    this.box.addEventListener('pointerdown', e => this.down(e));
    this.box.addEventListener('click', e => this.emptyTap(e));
    this.drag = null; this.lastTap = { id: null, t: 0 };
  }

  // The rack's shape: 2 × 13 for classic Okey; 101's 22-tile hands get 2 × 15, or 3 × 11 on portrait phones so the
  // tiles stay big enough to read and drag. Tiles keep their groups when the shape changes.
  setCols(cols, tiers = this.tiers) {
    if (cols === this.cols && tiers === this.tiers) return;
    const groups = this.groups();
    this.cols = cols; this.tiers = tiers;
    this.slots = layoutFromGroups(groups, cols, tiers);
    this.setSize(this.tw, this.gap);
  }
  // the wooden tiers: a shaded bed and a lip under each row of tiles
  drawTiers() {
    const el = this.host.querySelector('.rack-tiers'), key = this.tiers;
    if (el.dataset.n === String(key)) return;
    el.dataset.n = key;
    let html = '';
    for (let i = 0; i < this.tiers; i++) {
      html += `<i class="tbg" style="top:calc(var(--tw) * .24 + ${i} * (var(--th) + var(--tg)))"></i>`
        + `<i class="ledge" style="top:calc(var(--tw) * .24 + ${i + 1} * var(--th) + ${i} * var(--tg) - var(--tw) * .1)"></i>`;
    }
    el.innerHTML = html;
  }
  setSize(tw, gap) {
    this.tw = tw; this.th = Math.round(tw * 1.5); this.gap = gap; this.tierGap = Math.max(5, Math.round(tw * 0.32));
    const W = this.cols * tw + (this.cols - 1) * gap, H = this.tiers * this.th + (this.tiers - 1) * this.tierGap;
    this.drawTiers();
    this.host.style.setProperty('--tw', tw + 'px');
    this.host.style.setProperty('--th', this.th + 'px');
    this.host.style.setProperty('--rw', W + 'px');
    this.host.style.setProperty('--rh', H + 'px');
    this.host.style.setProperty('--tg', this.tierGap + 'px');
    this.render(true);
  }
  pos(i) {
    const tier = Math.floor(i / this.cols), col = i % this.cols;
    return { x: col * (this.tw + this.gap), y: tier * (this.th + this.tierGap) };
  }
  slotRect(i) {
    const b = this.box.getBoundingClientRect(), p = this.pos(i);
    return { left: b.left + p.x, top: b.top + p.y, width: this.tw, height: this.th };
  }
  slotOf(id) { return this.slots.indexOf(id); }
  tileRect(id) { const i = this.slotOf(id); return i >= 0 ? this.slotRect(i) : null; }
  tiles() { return this.slots.filter(x => x != null); }
  groups() { return layoutGroups(this.slots, this.cols); }

  // client point -> slot index (or -1 when well outside the rack)
  slotAt(x, y, margin = 24) {
    const b = this.box.getBoundingClientRect();
    if (x < b.left - margin || x > b.right + margin || y < b.top - margin * 1.6 || y > b.bottom + margin) return -1;
    const col = Math.max(0, Math.min(this.cols - 1, Math.floor((x - b.left + this.gap / 2) / (this.tw + this.gap))));
    const tier = Math.max(0, Math.min(this.tiers - 1, Math.floor((y - b.top + this.tierGap / 2) / (this.th + this.tierGap))));
    return tier * this.cols + col;
  }

  setOkey(okey) { this.okey = okey; this.els.forEach((el, id) => { el.className = this.cls(id); el.setAttribute('aria-label', tileLabel(id, okey)); }); }
  // keyboard: move the selection through the rack (dx along a tier, dy between tiers)
  step(dx, dy) {
    const order = this.slots.map((id, i) => [id, i]).filter(([id]) => id != null);
    if (!order.length) return null;
    const cur = this.selected != null ? this.slotOf(this.selected) : -1;
    if (cur < 0) { this.selected = order[0][0]; }
    else if (dx) { const k = order.findIndex(([, i]) => i === cur); this.selected = order[(k + dx + order.length) % order.length][0]; }
    else {
      const col = cur % this.cols, tier = Math.max(0, Math.min(this.tiers - 1, Math.floor(cur / this.cols) + dy));
      const row = order.filter(([, i]) => Math.floor(i / this.cols) === tier);
      if (row.length) this.selected = row.reduce((a, b) => (Math.abs(b[1] % this.cols - col) < Math.abs(a[1] % this.cols - col) ? b : a))[0];
    }
    sfx('tick'); this.render(); this.opts.onSelect && this.opts.onSelect(this.selected);
    return this.selected;
  }

  // Load the saved layout for this room + round, if it still matches the hand well enough.
  restore(key, hand) {
    this.key = key; this.selected = null;
    const saved = loadRack(key);
    if (saved && saved.length === this.cols * this.tiers) {
      const set = new Set(hand), kept = saved.filter(x => x != null && set.has(x));
      if (hand.length && kept.length / hand.length >= 0.6) {
        this.slots = saved.map(x => (x != null && set.has(x) ? x : null));
        this.sync(hand); return true;
      }
    }
    this.slots = Array(this.cols * this.tiers).fill(null);
    return false;
  }
  save() { if (this.key) saveRack(this.key, this.slots); }

  // Reconcile with the server's hand: drop tiles we no longer hold, add new ones (preferred slot or the end).
  sync(hand, prefer = new Map()) {
    const set = new Set(hand);
    this.slots = this.slots.map(x => (x != null && set.has(x) ? x : null));
    for (const id of hand) {
      if (this.slots.includes(id)) continue;
      const p = prefer.get(id);
      this.slots = moveIn(this.slots, id, p != null && p >= 0 ? p : this.newSlot(), this.cols);
    }
    if (this.selected != null && !set.has(this.selected)) this.selected = null;
    this.render(); this.save();
  }
  // Where a freshly drawn tile goes: after the last tile of the lower tier (leaving a gap), else the upper, else anywhere.
  newSlot() {
    for (let tier = this.tiers - 1; tier >= 0; tier--) {
      let last = -1;
      for (let c = 0; c < this.cols; c++) if (this.slots[tier * this.cols + c] != null) last = c;
      const want = last < 0 ? 0 : last + 2;
      if (want < this.cols) return tier * this.cols + want;
      if (last + 1 < this.cols) return tier * this.cols + last + 1;
    }
    const e = this.slots.indexOf(null); return e < 0 ? 0 : e;
  }

  layout(slots) { this.slots = slots; this.render(); this.save(); }
  arrange(mode) {
    const ids = this.tiles(); if (!ids.length) return;
    const groups = arrangeIds(ids, this.okey, mode);
    this.selected = null;
    this.layout(layoutFromGroups(groups, this.cols, this.tiers));
    sfx('deal');
  }

  cls(id) {
    const rev = S.settings.reverseOkey !== false && isOkey(id, this.okey) && !this.upright.has(id);
    return tileClass(id, this.okey) + ' rt' + (rev ? ' rev' : '') + (this.facedown.has(id) ? ' fd' : '') + (this.selected === id ? ' sel' : '') + (this.drag && this.drag.id === id && this.drag.moved ? ' drag' : '') + (this.hidden.has(id) ? ' gone' : '') + (this.flags.has(id) ? ' ' + this.flags.get(id) : '');
  }
  // a class on one tile (e.g. 'taken': the discard you picked up in 101 and must play)
  flag(id, cls) { this.flags.clear(); if (id != null) this.flags.set(id, cls); this.render(); }
  // underlines under groups of slots: [{ from, to, cls }] (same tier), drawn on the ledge
  setMarks(marks) { this.marks = marks || []; this.renderMarks(); }
  renderMarks() {
    const box = this.box, want = this.preview ? [] : this.marks;
    let els = [...box.querySelectorAll('.gmark')];
    while (els.length > want.length) els.pop().remove();
    while (els.length < want.length) { const m = document.createElement('i'); m.className = 'gmark'; box.prepend(m); els.push(m); }
    want.forEach((m, k) => {
      const a = this.pos(m.from), w = (m.to - m.from + 1) * (this.tw + this.gap) - this.gap;
      const el = els[k]; el.className = 'gmark ' + (m.cls || '');
      el.style.cssText = `transform:translate(${a.x}px,${a.y + this.th + 1}px);width:${w}px`;
      if (m.label != null) el.dataset.l = m.label; else delete el.dataset.l;
    });
  }
  hide(id, on = true) {
    if (on) this.hidden.add(id); else this.hidden.delete(id);
    const el = this.els.get(id); if (!el) return;
    if (!on) {
      const turn = S.settings.reverseOkey !== false && isOkey(id, this.okey);
      if (turn) this.upright.add(id);
      el.style.transition = 'none'; el.className = this.cls(id); void el.offsetWidth; el.style.transition = '';
      if (turn) setTimeout(() => this.turnOkeys([id]), 140);
      return;
    }
    el.className = this.cls(id);
  }
  // turn these okeys upside down now (a quick 180° of the face); call after they land or after the deal's sort
  turnOkeys(ids) {
    for (const id of ids) { this.upright.delete(id); const el = this.els.get(id); if (el) el.className = this.cls(id); }
  }
  holdUpright(ids) { ids.forEach(id => this.upright.add(id)); }
  // the deal: these tiles arrive face down (an okey stays upright until the sort is done), spreading out from one slot
  dealIn(ids, fromSlot) {
    const m = fromSlot != null ? this.pos(fromSlot) : null;
    for (const id of ids) {
      this.hidden.delete(id); this.facedown.add(id);
      if (isOkey(id, this.okey)) this.upright.add(id);
      const el = this.els.get(id); if (!el) continue;
      const p = this.pos(this.slotOf(id));
      el.style.transition = 'none';
      if (m) el.style.transform = `translate(${m.x}px,${m.y}px)`;
      el.className = this.cls(id); void el.offsetWidth; el.style.transition = '';
      el.style.transform = `translate(${p.x}px,${p.y}px)`;
    }
  }
  // face down (the deal: tiles arrive on the rack back up, then turn over)
  faceDown(ids, on = true) { ids.forEach(id => { if (on) this.facedown.add(id); else this.facedown.delete(id); const el = this.els.get(id); if (el) el.className = this.cls(id); }); }
  // turn one tile face up in place: it narrows, the face appears at the narrowest moment, it widens (no edge-on frame)
  async turnUp(id, ms) {
    const el = this.els.get(id); if (!el) return;
    if (!ms) { this.faceDown([id], false); return; }
    await el.animate([{ scale: '1 1' }, { scale: '.25 1.04' }], { duration: ms / 2, easing: 'ease-in' }).finished.catch(() => {});
    this.faceDown([id], false);
    await el.animate([{ scale: '.25 1.04' }, { scale: '1 1' }], { duration: ms / 2, easing: 'ease-out' }).finished.catch(() => {});
  }
  // where a tile is drawn right now (its exact pose, mid-transition included): the start of a seamless flight
  tileGeom(id) {
    const el = this.els.get(id); if (!el) return null;
    const r = el.getBoundingClientRect();
    return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: this.tw, h: this.th, rot: 0 };
  }

  render(instant = false) {
    const slots = this.preview || this.slots;
    const seen = new Set();
    slots.forEach((id, i) => {
      if (id == null) return;
      seen.add(id);
      let el = this.els.get(id);
      if (!el) {
        el = document.createElement('div');
        el.dataset.id = id; el.setAttribute('role', 'listitem'); el.setAttribute('aria-label', tileLabel(id, this.okey));
        el.innerHTML = `<span class="fc">${tileInner(id)}</span>`;
        this.box.appendChild(el); this.els.set(id, el);
        el.style.transition = 'none';
      } else if (instant) el.style.transition = 'none';
      el.className = this.cls(id);
      if (this.drag && this.drag.id === id && this.drag.moved) return;   // follows the pointer
      const p = this.pos(i);
      el.style.transform = `translate(${p.x}px,${p.y - (this.selected === id ? this.th * 0.16 : 0)}px)`;
      if (el.style.transition === 'none') { void el.offsetWidth; el.style.transition = ''; }
    });
    for (const [id, el] of this.els) if (!seen.has(id)) { el.remove(); this.els.delete(id); }
    this.renderMarks();
    if (this.onRender) this.onRender();
  }

  // ---- pointer handling ----
  down(e) {
    const el = e.target.closest('.rt'); if (!el || e.button > 0) return;
    const id = +el.dataset.id;
    if (this.opts.locked && this.opts.locked()) return;
    const b = el.getBoundingClientRect();
    this.drag = { id, el, pid: e.pointerId, x0: e.clientX, y0: e.clientY, ox: e.clientX - b.left, oy: e.clientY - b.top, moved: false, target: null, slot: -1 };
    el.setPointerCapture(e.pointerId);
    el.onpointermove = ev => this.move(ev);
    el.onpointerup = ev => this.up(ev, false);
    el.onpointercancel = ev => this.up(ev, true);
    e.preventDefault();
  }
  move(e) {
    const d = this.drag; if (!d || e.pointerId !== d.pid) return;
    if (!d.moved) {
      if (Math.hypot(e.clientX - d.x0, e.clientY - d.y0) < 6) return;
      d.moved = true; this.selected = null;
      d.el.className = this.cls(d.id); d.el.style.transition = 'none';
      sfx('pick');
      this.opts.onDragStart && this.opts.onDragStart(d.id);
    }
    const b = this.box.getBoundingClientRect();
    d.rot = Math.max(-6, Math.min(6, (e.clientX - d.x0) / 40));
    d.el.style.transform = `translate(${e.clientX - b.left - d.ox}px,${e.clientY - b.top - d.oy - this.th * 0.12}px) scale(1.12) rotate(${d.rot}deg)`;
    // targets outside the rack first (discard spot, centre), then the rack itself
    const cx = e.clientX, cy = e.clientY - this.th * 0.12;
    const target = this.opts.targetAt ? this.opts.targetAt(cx, cy, d.id) : null;
    if (target !== d.target) { d.target = target; this.opts.onHover && this.opts.onHover(target, d.id); }
    const slot = target ? -1 : this.slotAt(cx, cy);
    if (slot !== d.slot) {
      d.slot = slot;
      this.preview = slot >= 0 ? moveIn(this.slots, d.id, slot, this.cols) : null;
      if (slot >= 0 && this.preview[slot] === d.id && this.slots[slot] !== d.id) sfx('tick');
      this.render();
    }
  }
  up(e, cancel) {
    const d = this.drag; if (!d || e.pointerId !== d.pid) return;
    d.el.onpointermove = d.el.onpointerup = d.el.onpointercancel = null;
    try { d.el.releasePointerCapture(d.pid); } catch { /* ignore */ }
    this.drag = null; const preview = this.preview; this.preview = null;
    if (!d.moved) { this.tap(d.id); return; }
    this.opts.onHover && this.opts.onHover(null, d.id);
    d.el.style.transition = '';
    if (!cancel && d.target) {
      // the exact pose under the finger (centre, scaled size, tilt): the drop continues from here
      const r = d.el.getBoundingClientRect();
      const geo = { cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: this.tw * 1.12, h: this.th * 1.12, rot: d.rot || 0 };
      const accepted = this.opts.onDrop && this.opts.onDrop(d.target, d.id, { left: r.left, top: r.top, width: r.width, height: r.height, geo });
      if (accepted) { this.render(); return; }
    }
    if (!cancel && preview && d.slot >= 0) { this.slots = preview; this.save(); sfx('rack', { level: 0.7 }); buzz(); }
    this.render();
  }
  tap(id) {
    const now = performance.now();
    if (this.lastTap.id === id && now - this.lastTap.t < 340) {
      this.lastTap = { id: null, t: 0 };
      this.selected = null; this.render();
      this.opts.onDoubleTap && this.opts.onDoubleTap(id);
      return;
    }
    this.lastTap = { id, t: now };
    this.selected = this.selected === id ? null : id;
    sfx('tick');
    this.render();
    this.opts.onSelect && this.opts.onSelect(this.selected);
  }
  // Tapping an empty slot with a tile selected moves it there.
  emptyTap(e) {
    if (e.target.closest('.rt') || this.selected == null) return;
    const slot = this.slotAt(e.clientX, e.clientY, 0);
    if (slot < 0 || this.slots[slot] != null) return;
    this.slots = moveIn(this.slots, this.selected, slot, this.cols); this.selected = null;
    this.save(); sfx('tick'); this.render();
    this.opts.onSelect && this.opts.onSelect(null);
  }
  clearSelection() { if (this.selected != null) { this.selected = null; this.render(); } }
}
