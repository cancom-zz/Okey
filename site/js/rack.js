// The ıstaka: two tiers of 13 slots, owned by the client (the server only knows the unordered hand).
// Tiles are absolutely positioned by slot, so moves glide by CSS transition. Drag with pointer events
// (touch + mouse): neighbours slide aside live; drop on the rack, on your discard spot or on the centre (finish).
import { COLS, TIERS, SLOTS } from './config.js';
import { tileClass, tileInner, arrange as arrangeIds, layoutGroups } from './tiles.js';
import { loadRack, saveRack } from './store.js';
import { sfx } from './sound.js';
import { dur, reduced } from './anim.js';

// Put `id` at slot `to`; occupied slots shift toward the nearest gap in that tier. Pure: returns a new array.
export function moveIn(slots, id, to) {
  const s = slots.slice();
  const from = s.indexOf(id);
  if (from >= 0) s[from] = null;
  if (s[to] == null) { s[to] = id; return s; }
  const base = Math.floor(to / COLS) * COLS;
  let r = -1, l = -1;
  for (let j = to + 1; j < base + COLS; j++) if (s[j] == null) { r = j; break; }
  for (let j = to - 1; j >= base; j--) if (s[j] == null) { l = j; break; }
  if (r >= 0 && (l < 0 || r - to <= to - l)) { for (let k = r; k > to; k--) s[k] = s[k - 1]; s[to] = id; return s; }
  if (l >= 0) { for (let k = l; k < to; k++) s[k] = s[k + 1]; s[to] = id; return s; }
  if (from >= 0) { s[from] = s[to]; s[to] = id; return s; }   // the tier is full: swap
  const e = s.indexOf(null); if (e >= 0) s[e] = id;
  return s;
}

// Lay groups out tier by tier with one gap between them (fewer gaps when it would not fit).
export function layoutFromGroups(groups) {
  for (const gap of [1, 0]) {
    const s = Array(SLOTS).fill(null);
    let tier = 0, col = 0, ok = true;
    for (const g of groups) {
      if (!g.length) continue;
      if (col + g.length > COLS) {
        if (tier + 1 < TIERS && g.length <= COLS) { tier++; col = 0; } else { ok = false; break; }
      }
      g.forEach((id, i) => { s[tier * COLS + col + i] = id; });
      col += g.length + gap;
    }
    if (ok) return s;
  }
  const s = Array(SLOTS).fill(null); groups.flat().forEach((id, i) => { s[i] = id; }); return s;
}

export class Rack {
  constructor(host, opts = {}) {
    this.host = host; this.opts = opts;
    this.slots = Array(SLOTS).fill(null);
    this.preview = null; this.okey = null; this.key = null;
    this.els = new Map(); this.selected = null; this.hidden = new Set();
    this.tw = 28; this.th = 42; this.gap = 2; this.tierGap = 8; this.padX = 0;
    host.innerHTML = '<div class="rack-tiers" aria-hidden="true"><i class="ledge l0"></i><i class="ledge l1"></i></div><div class="rack-tiles" role="list"></div>';
    this.box = host.querySelector('.rack-tiles');
    this.box.addEventListener('pointerdown', e => this.down(e));
    this.box.addEventListener('click', e => this.emptyTap(e));
    this.drag = null; this.lastTap = { id: null, t: 0 };
  }

  setSize(tw, gap) {
    this.tw = tw; this.th = Math.round(tw * 1.5); this.gap = gap; this.tierGap = Math.max(5, Math.round(tw * 0.32));
    const W = COLS * tw + (COLS - 1) * gap, H = TIERS * this.th + (TIERS - 1) * this.tierGap;
    this.host.style.setProperty('--tw', tw + 'px');
    this.host.style.setProperty('--th', this.th + 'px');
    this.host.style.setProperty('--rw', W + 'px');
    this.host.style.setProperty('--rh', H + 'px');
    this.host.style.setProperty('--tg', this.tierGap + 'px');
    this.render(true);
  }
  pos(i) {
    const tier = Math.floor(i / COLS), col = i % COLS;
    return { x: col * (this.tw + this.gap), y: tier * (this.th + this.tierGap) };
  }
  slotRect(i) {
    const b = this.box.getBoundingClientRect(), p = this.pos(i);
    return { left: b.left + p.x, top: b.top + p.y, width: this.tw, height: this.th };
  }
  slotOf(id) { return this.slots.indexOf(id); }
  tileRect(id) { const i = this.slotOf(id); return i >= 0 ? this.slotRect(i) : null; }
  tiles() { return this.slots.filter(x => x != null); }
  groups() { return layoutGroups(this.slots, COLS); }

  // client point -> slot index (or -1 when well outside the rack)
  slotAt(x, y, margin = 24) {
    const b = this.box.getBoundingClientRect();
    if (x < b.left - margin || x > b.right + margin || y < b.top - margin * 1.6 || y > b.bottom + margin) return -1;
    const col = Math.max(0, Math.min(COLS - 1, Math.floor((x - b.left + this.gap / 2) / (this.tw + this.gap))));
    const tier = y - b.top < this.th + this.tierGap / 2 ? 0 : 1;
    return tier * COLS + col;
  }

  setOkey(okey) { this.okey = okey; this.els.forEach((el, id) => { el.className = this.cls(id); }); }

  // Load the saved layout for this room + round, if it still matches the hand well enough.
  restore(key, hand) {
    this.key = key; this.selected = null;
    const saved = loadRack(key);
    if (saved && saved.length === SLOTS) {
      const set = new Set(hand), kept = saved.filter(x => x != null && set.has(x));
      if (hand.length && kept.length / hand.length >= 0.6) {
        this.slots = saved.map(x => (x != null && set.has(x) ? x : null));
        this.sync(hand); return true;
      }
    }
    this.slots = Array(SLOTS).fill(null);
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
      this.slots = moveIn(this.slots, id, p != null && p >= 0 ? p : this.newSlot());
    }
    if (this.selected != null && !set.has(this.selected)) this.selected = null;
    this.render(); this.save();
  }
  // Where a freshly drawn tile goes: after the last tile of the lower tier (leaving a gap), else the upper, else anywhere.
  newSlot() {
    for (const tier of [1, 0]) {
      let last = -1;
      for (let c = 0; c < COLS; c++) if (this.slots[tier * COLS + c] != null) last = c;
      const want = last < 0 ? 0 : last + 2;
      if (want < COLS) return tier * COLS + want;
      if (last + 1 < COLS) return tier * COLS + last + 1;
    }
    const e = this.slots.indexOf(null); return e < 0 ? 0 : e;
  }

  layout(slots) { this.slots = slots; this.render(); this.save(); }
  arrange(mode) {
    const ids = this.tiles(); if (!ids.length) return;
    const groups = arrangeIds(ids, this.okey, mode);
    this.selected = null;
    this.layout(layoutFromGroups(groups));
    sfx('deal');
  }

  cls(id) {
    return tileClass(id, this.okey) + ' rt' + (this.selected === id ? ' sel' : '') + (this.drag && this.drag.id === id && this.drag.moved ? ' drag' : '') + (this.hidden.has(id) ? ' gone' : '');
  }
  hide(id, on = true) { if (on) this.hidden.add(id); else this.hidden.delete(id); const el = this.els.get(id); if (el) el.className = this.cls(id); }

  render(instant = false) {
    const slots = this.preview || this.slots;
    const seen = new Set();
    slots.forEach((id, i) => {
      if (id == null) return;
      seen.add(id);
      let el = this.els.get(id);
      if (!el) {
        el = document.createElement('div');
        el.dataset.id = id; el.setAttribute('role', 'listitem');
        el.innerHTML = tileInner(id);
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
    d.el.style.transform = `translate(${e.clientX - b.left - d.ox}px,${e.clientY - b.top - d.oy - this.th * 0.12}px) scale(1.12) rotate(${Math.max(-6, Math.min(6, (e.clientX - d.x0) / 40))}deg)`;
    // targets outside the rack first (discard spot, centre), then the rack itself
    const cx = e.clientX, cy = e.clientY - this.th * 0.12;
    const target = this.opts.targetAt ? this.opts.targetAt(cx, cy, d.id) : null;
    if (target !== d.target) { d.target = target; this.opts.onHover && this.opts.onHover(target, d.id); }
    const slot = target ? -1 : this.slotAt(cx, cy);
    if (slot !== d.slot) {
      d.slot = slot;
      this.preview = slot >= 0 ? moveIn(this.slots, d.id, slot) : null;
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
      const r = d.el.getBoundingClientRect();
      const accepted = this.opts.onDrop && this.opts.onDrop(d.target, d.id, { left: r.left, top: r.top, width: r.width, height: r.height });
      if (accepted) { this.render(); return; }
    }
    if (!cancel && preview && d.slot >= 0) { this.slots = preview; this.save(); sfx('tick'); }
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
    this.slots = moveIn(this.slots, this.selected, slot); this.selected = null;
    this.save(); sfx('tick'); this.render();
    this.opts.onSelect && this.opts.onSelect(null);
  }
  clearSelection() { if (this.selected != null) { this.selected = null; this.render(); } }

  // The deal: tiles land into their slots one by one.
  async dealIn(order, from, okey) {
    const box = this.box;
    void box; void from; void okey;
    if (reduced()) { this.render(true); return; }
    const step = dur(55);
    const ids = order.filter(id => this.els.has(id));
    ids.forEach(id => { const el = this.els.get(id); el.style.opacity = '0'; });
    for (const id of ids) {
      const el = this.els.get(id); if (!el) continue;
      el.style.opacity = '';
      el.animate([{ transform: el.style.transform + ' translateY(-14px) rotateX(70deg)', opacity: 0 }, { transform: el.style.transform, opacity: 1 }],
        { duration: dur(220), easing: 'cubic-bezier(.2,.9,.3,1.2)' });
      if (ids.indexOf(id) % 3 === 0) sfx('tick');
      await new Promise(r => setTimeout(r, step));
    }
  }
}
