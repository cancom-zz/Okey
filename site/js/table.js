// The table: felt, your ıstaka at the bottom, opponents left/top/right, the pile and the indicator in the middle,
// each seat's discard stack at its right (the four corners). Renders views, plays events as animations.
import { t } from './i18n.js';
import { S } from './store.js';
import { EMOTES, BOT_AVATAR } from './config.js';
import { $, $$, esc, toast, sheet, closeSheet, celebrate, banner, clearBanners, Sparks } from './ui.js';
import { sfx, buzz } from './sound.js';
import { Rack, layoutFromGroups } from './rack.js';
import { tileHTML, tileClass, tileInner, tileLabel, faceHTML, okeyFace, color, num, finishCheck, arrange, loadEngine, getEngine, isOkey } from './tiles.js';
import { load101, rules101, rackOpening, bestLayout, boardHTML, story101, rows101 } from './v101.js';
import { flyTile, flipOver, settle, wait, dur, reduced, shake, pulse, fly, geomOf, land, setSkip, skipped, sleep, nextFrame } from './anim.js';
import { storyOf, deltasHTML, handGroupsHTML, podiumHTML } from './result.js';
import { confirmSheet } from './sheets.js';
import { maybeGuide, placeGuide, closeGuide, advanceGuide } from './guide.js';
import { recordRound, recordMatch, tipCheck, tipNote } from './tip.js';

const RING = 2 * Math.PI * 20;

export class TableScreen {
  constructor(root, ctx) {
    this.root = root; this.ctx = ctx;           // ctx: { send(msg), code, solo, leave() }
    this.view = null; this.disp = null; this.offset = 0;
    this.busy = false; this.pendingDiscard = null; this.pendingDraw = null; this.drawSlot = -1;
    this.roundKey = null; this.dealing = false; this.resultShown = null; this.lastEmote = 0;
    this.mount();
    loadEngine();
    this.timer = setInterval(() => this.tick(), 250);
    this.onResize = () => { this.layout(); placeGuide(); };
    this.onKey = e => this.key(e);
    addEventListener('keydown', this.onKey);
    addEventListener('resize', this.onResize);
  }
  destroy() { clearInterval(this.timer); removeEventListener('resize', this.onResize); removeEventListener('keydown', this.onKey); closeGuide(false); this.root.innerHTML = ''; clearBanners(); }

  // relative position: 0 me (bottom), 1 right, 2 top, 3 left
  pos(seat) { const you = this.view && this.view.you != null ? this.view.you : 0; return (seat - you + 4) % 4; }
  seatAt(p) { const you = this.view && this.view.you != null ? this.view.you : 0; return (you + p) % 4; }

  mount() {
    const seat = p => `<div class="seat opp p${p}" data-p="${p}">
        <div class="plate"><div class="av"><svg class="ring" viewBox="0 0 44 44" aria-hidden="true"><circle class="rbg" cx="22" cy="22" r="20"/><circle class="rfg" cx="22" cy="22" r="20" stroke-dasharray="${RING}" stroke-dashoffset="0"/></svg><span class="emo"></span><b class="secs"></b></div>
        <div class="meta"><div class="nm"></div><div class="sub"><span class="sc"></span><span class="tag"></span></div></div></div>
        <div class="orack" aria-hidden="true"><div class="otiles"></div><span class="ocount"></span></div><div class="bub" aria-live="polite"></div></div>`;
    const ds = p => `<div class="ds d${p}" data-p="${p}"><div class="dstack"></div><span class="dn"></span>${p === 0 ? `<span class="dlbl">${t('table.discardHere')}</span>` : p === 3 ? `<span class="dlbl">${t('table.takeHere')}</span>` : ''}</div>`;
    this.root.innerHTML = `<section class="tbl" id="tbl">
      <div class="felt" id="felt">
        <div class="placard" aria-hidden="true"></div><div class="cloth" aria-hidden="true"></div><div class="tea" aria-hidden="true"></div>
        ${seat(2)}${seat(3)}${seat(1)}
        ${ds(2)}${ds(1)}${ds(3)}${ds(0)}
        <div class="center">
          <div class="cring" aria-hidden="true"></div>
          <button class="pile" id="pile" aria-label="${esc(t('table.pile'))}"><span class="pblock"><span class="pplate"></span></span></button>
          <div class="ind" id="ind"><div class="indt"></div><small>${t('table.indicator')}</small></div>
          <div class="okeyis" id="okeyis" hidden><span class="arrow" aria-hidden="true">›</span><div class="okt"></div></div>
          <div class="fz" id="fz" aria-hidden="true"><span></span></div>
          <div class="melds" id="melds" hidden></div>
        </div>
        <div class="status" id="status" role="status" aria-live="polite"><span class="stx"></span></div>
        <div class="o101" id="o101" hidden></div>
        <div class="mine seat p0" data-p="0">
          <div class="plate"><div class="av"><svg class="ring" viewBox="0 0 44 44" aria-hidden="true"><circle class="rbg" cx="22" cy="22" r="20"/><circle class="rfg" cx="22" cy="22" r="20" stroke-dasharray="${RING}" stroke-dashoffset="0"/></svg><span class="emo"></span><b class="secs"></b></div>
          <div class="meta"><div class="nm"></div><div class="sub"><span class="sc"></span><span class="tag"></span></div></div></div><div class="bub"></div>
        </div>
        <div class="rack" id="rack"></div>
        <div class="bar" id="bar">
          <button class="chip" id="bRuns">${t('table.sortRuns')}</button>
          <button class="chip" id="bPairs">${t('table.sortPairs')}</button>
          <button class="chip gold" id="bShow" hidden>${t('table.showIndicator')}</button>
          <button class="chip round" id="bEmote" aria-label="${esc(t('table.emotes'))}">😊</button>
        </div>
        <div class="emotes" id="emotes" hidden>${EMOTES.map(e => `<button data-e="${e.id}">${e.e || esc(t(e.k))}</button>`).join('')}</div>
        <div class="result" id="result" hidden></div>
      </div>
    </section>`;
    const r = this.root;
    this.felt = $('#felt', r);
    this.rack = new Rack($('#rack', r), {
      locked: () => this.dealing,
      targetAt: (x, y, id) => this.targetAt(x, y, id),
      onHover: (tg, id) => this.hover(tg, id),
      onDrop: (tg, id, rect) => this.drop(tg, id, rect),
      onDoubleTap: id => this.quickDiscard(id),
      onSelect: id => this.selectChanged(id),
      onDragStart: id => { this.hideEmotes(); this.dragStart101(id); },
    });
    this.rack.onRender = () => this.strip101();
    $('#o101', r).onclick = e => { const b = e.target.closest('button[data-a]'); if (b && !b.disabled) this.click101(b.dataset.a); };
    $('#bRuns', r).onclick = () => { this.rack.arrange('runs'); };
    $('#bPairs', r).onclick = () => { this.rack.arrange('pairs'); };
    $('#bShow', r).onclick = () => this.act({ type: 'showIndicator' });
    $('#bEmote', r).onclick = e => { e.stopPropagation(); const p = $('#emotes', r); p.hidden = !p.hidden; };
    $('#emotes', r).onclick = e => { const b = e.target.closest('button'); if (b) this.sendEmote(b.dataset.e); };
    r.addEventListener('pointerdown', e => { if (!e.target.closest('#emotes,#bEmote')) this.hideEmotes(); });
    // a tap during the deal (or a slam) skips the rest of it
    r.addEventListener('pointerdown', () => { if ((this.dealing || this.slamming) && !skipped()) setSkip(true); }, true);
    // drawing: tap or drag the pile / the left discard
    this.wireDrawSource($('#pile', r), 'pile');
    this.wireDrawSource($('.ds.d3', r), 'discard');
    // tap targets for a selected tile
    $('.ds.d0', r).addEventListener('click', () => { const id = this.rack.selected; if (id != null && this.can('discard')) this.discardFrom(id, this.rack.tileGeom(id)); });
    $('#fz', r).addEventListener('click', () => { const id = this.rack.selected; if (id != null && this.can('discard')) this.tryFinish(id, this.rack.tileRect(id)); });
    this.layout();
  }
  // Keyboard play (laptops): arrows pick a rack tile, Enter/Space discards it, D draws from the pile, L takes the
  // left discard, Esc lets go.
  key(e) {
    if (e.metaKey || e.ctrlKey || e.altKey || document.querySelector('#modal .sheet')) return;
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    const k = e.key;
    if (k === 'ArrowLeft' || k === 'ArrowRight') { this.rack.step(k === 'ArrowLeft' ? -1 : 1, 0); e.preventDefault(); }
    else if (k === 'ArrowUp' || k === 'ArrowDown') { this.rack.step(0, k === 'ArrowUp' ? -1 : 1); e.preventDefault(); }
    else if ((k === 'Enter' || k === ' ') && this.rack.selected != null && !(e.target && e.target.tagName === 'BUTTON')) {
      if (this.can('discard')) { this.quickDiscard(this.rack.selected); e.preventDefault(); }
    } else if (k === 'd' || k === 'D') { if (this.can('draw')) this.draw('pile'); }
    else if (k === 'l' || k === 'L') { if (this.can('draw')) this.draw('discard'); }
    else if (k === 'Escape') this.rack.clearSelection();
  }
  hideEmotes() { const p = $('#emotes', this.root); if (p) p.hidden = true; }

  // ---- sizing: tiles as big as the screen allows ----
  layout() {
    const scr = this.root.getBoundingClientRect();
    const W = scr.width, H = scr.height;
    if (!W || !H) return;
    const land = W > H * 1.12;
    const wide = land && W >= 900 && H >= 560;
    this.felt.classList.toggle('land', land);
    this.felt.classList.toggle('wide', wide);
    let tw;
    // the rack's shape: 101 on a portrait phone gets three tiers of 11 so its 22 tiles stay ≥ 28 px
    const tall101 = this.is101 && !land;
    this.felt.classList.toggle('tall101', tall101);
    this.rack.setCols(this.is101 ? (tall101 ? 11 : 15) : 13, tall101 ? 3 : 2);
    const cols = this.rack.cols, tiers = this.rack.tiers;
    if (!land) {
      const byW = (W - 8 - 14 - 12) / cols;
      const byH = tiers === 3 ? (H * 0.37) / 5.75 : (H * 0.31 - 16) / 3.3;
      tw = Math.floor(Math.min(byW, byH, 52));
    } else {
      const byW = (W * (wide ? 0.54 : 0.56)) / cols;
      const byH = (H * (wide ? 0.27 : 0.33) - 14) / 3.3;
      tw = Math.floor(Math.min(byW, byH, 60));
    }
    tw = Math.max(20, tw);
    const gap = tw >= 34 ? 2 : 1;
    this.rack.setSize(tw, gap);
    // centre and discard tiles: as big as the felt between the opponents and the rack allows
    let dw = land ? Math.min(tw * (wide ? 1.12 : 1.0), wide ? 62 : 42, H / 9) : Math.min((H - 300) / 5.2, 54, (W - 200) / 2.6);
    if (this.is101) dw = Math.min(dw, land ? 34 : 28);   // the middle also holds the melds
    dw = Math.round(Math.max(24, dw));
    this.mwMax = Math.round(Math.max(12, Math.min(wide ? 30 : 22, tw * 0.8)));
    this.felt.style.setProperty('--dw', dw + 'px');
    // the draw pile: stacks of five, in a small block (3 or 5 across; 101's four stacks 2 or 4 across)
    this.pc = tall101 ? 2 : this.is101 ? 4 : land ? 5 : 3;
    this.ps = Math.round(dw * (tall101 ? 0.68 : this.is101 ? 0.74 : land ? 0.5 : 0.47));
    this.felt.style.setProperty('--tw', tw + 'px');
    // opponents' racks are fixed-length ıstakas (15 slots, 22 in 101) of standing tile backs
    const cap = this.is101 ? 22 : 15;
    // landscape: the side racks must fit their column (beside my rack), the top one beside its plate
    const rackW = cols * tw + (cols - 1) * gap + tw * 0.64 + 10, sideW = (W - rackW - (wide ? 110 : 40)) / 2;
    const bw = Math.floor(land ? Math.min((sideW - 14) / cap - 1, (rackW - 150) / cap - 1, H * 0.075, wide ? 19 : 13) : Math.min((W - 196) / cap, (H * 0.38) / cap, 13));
    this.bw = Math.max(6, bw); this.dw = dw;
    this.felt.style.setProperty('--bw', this.bw + 'px');
    this.felt.style.setProperty('--cap', cap);
    // then make sure: smaller tile backs until no opponent touches the pile, a discard stack, the melds or my rack
    for (let i = 0; i < 8 && this.bw > 5 && this.seatsCollide(); i++) { this.bw--; this.felt.style.setProperty('--bw', this.bw + 'px'); }
  }

  // ---- incoming ----
  setVariant(view) {
    const is = !!(view.settings && view.settings.variant === '101');
    if (is === this.is101) return;
    this.is101 = is;
    this.felt.classList.toggle('v101', is);
    this.layout();
    if (is) load101().then(() => { if (this.view) { this.renderMelds(); this.strip101(); } });
    for (let p = 1; p < 4; p++) { const b = this.oppBox(p); if (b) b.innerHTML = ''; }
  }
  async update(view, events = []) {
    this.setVariant(view);
    const prev = this.view;
    this.offset = (view.now || Date.now()) - Date.now();
    const evs = dedupe(events, view.you);
    const animate = (prev ? true : evs.length && evs[0].type === 'roundStart') && evs.length && evs.length <= 8 && !reduced() && document.visibilityState === 'visible';
    this.view = view;
    if (!animate) {
      if (evs.some(e => e.type === 'roundStart') || !this.disp) this.newRound(view);
      this.disp = dispFrom(view);
      this.render();
      for (const e of evs) this.quietEvent(e);
      this.afterRender(prev);
      return;
    }
    this.view = prev;          // play the events against what is on screen
    for (const ev of evs) { try { await this.play(ev, view); } catch (e) { console.error(e); } }
    this.view = view;
    this.disp = dispFrom(view);
    this.render();
    this.afterRender(prev);
  }
  afterRender(prev) {
    const v = this.view, r = v.round;
    this.busy = false;
    if (v.phase === 'playing' && r && r.turn === v.you && (!prev || !prev.round || prev.round.turn !== v.you || prev.round.number !== r.number) && v.you != null) {
      sfx('turn'); pulse($('#rack', this.root), 'myturn', 1200);
      if (!this.dealing) setTimeout(() => {   // only while it is still my turn (not over a finish, a slam or the result)
        const w = this.view, rr = w && w.round;
        if (!this.dealing && !this.slamming && w && w.phase === 'playing' && rr && rr.turn === w.you) maybeGuide(this.root, this.is101 ? '101' : 'classic');
      }, dur(500) || 30);
    }
    if ((v.phase === 'roundEnd' || v.phase === 'matchEnd') && v.result && this.resultShown !== resultKey(v)) this.showResult(false);
    if (v.phase === 'playing' && !$('#result', this.root).hidden) this.hideResult();
  }

  newRound(view) {
    const r = view.round; if (!r) return;
    this.roundKey = `${view.code}.${r.number}`;
    if (view.hand) {
      const restored = this.rack.restore(this.roundKey, view.hand);
      if (!restored) this.rack.layout(layoutFromGroups(arrange(view.hand, r.okey, 'runs'), this.rack.cols, this.rack.tiers));
    }
    this.rack.setOkey(r.okey);
    this.stacks = [[], [], [], []];
    this.resultShown = null; this.hideResult();
  }

  quietEvent(e) {
    if (e.type === 'showIndicator') this.showIndicatorFx(e, false);
    if (e.type === 'penalty') toast(t(e.reason === 'okeyDiscard' ? 't101.penOkey' : 't101.penIslek', { name: esc((this.view.seats[e.seat] || {}).name || ''), n: e.points }), 'err', 2600);
  }

  // ---- full render from this.view + this.disp ----
  render() {
    const v = this.view, d = this.disp; if (!v) return;
    const r = v.round;
    const root = this.root;
    root.querySelector('.tbl').dataset.phase = v.phase;
    for (let p = 0; p < 4; p++) {
      const seat = this.seatAt(p), s = v.seats[seat] || {};
      const el = $(`.seat.p${p}`, root);
      el.classList.toggle('turn', !!(r && v.phase === 'playing' && r.turn === seat));
      el.classList.toggle('away', !!s.away);
      el.classList.toggle('off', s.kind === 'human' && !s.connected);
      el.classList.toggle('dealer', !!(r && r.dealer === seat));
      $('.emo', el).textContent = s.avatar || (s.kind === 'bot' ? BOT_AVATAR[(s.bot || {}).level] || '🤖' : '🙂');
      $('.nm', el).textContent = s.kind === 'empty' ? t('lobby.empty') : (s.name || '—');
      $('.sc', el).textContent = s.score != null ? s.score : '';
      $('.sc', el).classList.toggle('pen', !!this.is101);
      const op = this.is101 && r && r.opened ? r.opened[seat] : false, opn = op && r.openings ? r.openings[seat] : null;
      $('.tag', el).textContent = op ? (op === 'pairs' ? t('tag.openedPairs', { n: opn ? opn.pairs : '' }) : t('tag.opened', { v: opn ? opn.value : '' }))
        : s.kind === 'bot' ? t('level.' + ((s.bot || {}).level || 'kalfa')) : s.away ? t('table.away') : (s.kind === 'human' && !s.connected) ? t('table.offline') : '';
      el.classList.toggle('opened', !!op);
      if (p) this.setMiniRack(p, d.count[seat]);
      this.setDiscard(p, d.disc[seat]);
    }
    this.setPile(d.pile);
    this.setIndicator(r ? r.indicator : null);
    this.renderMelds();
    this.renderPlacard();
    this.status();
    this.buttons();
    if (v.hand) {
      const hand = this.pendingDiscard != null ? v.hand.filter(x => x !== this.pendingDiscard) : v.hand;
      const prefer = new Map(); if (this.drawSlot >= 0) hand.forEach(id => { if (!this.rack.slots.includes(id)) prefer.set(id, this.drawSlot); });
      this.rack.sync(hand, prefer); this.drawSlot = -1;
      this.rack.flags.clear();
      if (this.is101 && r && r.taken != null && hand.includes(r.taken)) this.rack.flags.set(r.taken, 'taken');
      this.rack.render();
    } else this.rack.sync([]);
    $('#rack', root).hidden = v.you == null;
    this.tick();
  }

  // Melds laid face up on the table (101 Okey: view.round.table), grouped by owner. Hidden for classic.
  renderMelds(table, hide) {
    const el = $('#melds', this.root), r = this.view.round;
    const tb = table || (this.is101 && r && Array.isArray(r.table) ? r.table : null);
    el.hidden = !this.is101 || !r;
    if (el.hidden) { el.innerHTML = ''; el.dataset.k = ''; return; }
    // rebuild only when the melds (or the hidden tiles) changed: this runs on every render
    const key = JSON.stringify([tb ? tb.map(m => m.tiles) : 0, hide ? [...hide] : 0, this.view.you, t('t101.emptyTable')]);
    if (el.dataset.k === key) return;
    el.dataset.k = key;
    el.innerHTML = tb && tb.length ? boardHTML(tb, r.okey, this.view.seats, s => this.pos(s), hide) : `<div class="mempty">${t('t101.emptyTable')}</div>`;
    this.fitBoard();
  }
  // shrink the meld tiles until every meld fits the board: estimate from one measurement, then at most two checks
  fitBoard() {
    const el = $('#melds', this.root); if (el.hidden) return;
    let mw = this.mwMax || 20;
    el.style.setProperty('--mw', mw + 'px');
    for (let i = 0; i < 3 && mw > 11; i++) {
      const sh = el.scrollHeight, ch = el.clientHeight;
      if (sh <= ch + 1) break;
      mw = Math.max(11, Math.floor(mw * Math.min(0.94, Math.sqrt(ch / sh))));
      el.style.setProperty('--mw', mw + 'px');
    }
  }
  meldEl(i) { return $(`#melds .mg[data-i="${i}"]`, this.root); }
  mwNow() { return parseFloat(getComputedStyle($('#melds', this.root)).getPropertyValue('--mw')) || 18; }

  // ---- 101: the opening strip under the table (counter, best opening, open / lay, put back the taken tile) ----
  strip101() {
    const el = $('#o101', this.root); if (!el) return;
    const v = this.view, r = v && v.round;
    if (!this.is101 || !r || v.phase !== 'playing' || v.you == null || !v.hand || !rules101() || this.dealing) { el.hidden = true; this.rack.marks.length && this.rack.setMarks([]); return; }
    const hand = this.rack.tiles();
    const op = rackOpening(this.rack.groups(), hand, r, v.settings, v.you);
    if (!op) { el.hidden = true; return; }
    this.op101 = op;
    const list = op.kind === 'pairs' ? op.pairList : op.sets;
    this.rack.marks = list.map(g => ({ from: this.rack.slotOf(g.ids[0]), to: this.rack.slotOf(g.ids[g.ids.length - 1]), cls: op.kind === 'pairs' ? 'pair' : 'set', label: op.kind === 'pairs' ? null : g.value }))
      .filter(m => m.from >= 0 && m.to >= m.from && Math.floor(m.from / this.rack.cols) === Math.floor(m.to / this.rack.cols));
    this.rack.renderMarks();
    const act = this.can('discard');
    const taken = r.taken != null && r.turn === v.you && v.hand.includes(r.taken);
    let html = '';
    if (taken) html += `<button class="chip warn" data-a="undo">↩ ${t('o101.undo')}</button>`;
    if (!op.opened) {
      const cnt = op.kind === 'pairs' ? t('o101.pairs', { n: op.pairs, need: op.req.pairs }) : t('o101.value', { n: op.value, need: op.req.value });
      html += `<span class="cnt ${op.ok ? 'ok' : ''}">${cnt}</span><button class="chip" data-a="best" title="${esc(t('o101.best'))}">${t('o101.bestShort')}</button><button class="chip gold" data-a="open" ${op.ok && act ? '' : 'disabled'}>${t('o101.open')}</button>`;
    } else if (op.groups.length) {
      html += `<span class="cnt ok">${t('o101.more', { n: op.groups.length })}</span><button class="chip gold" data-a="lay" ${op.ok && act ? '' : 'disabled'}>${t('o101.lay')}</button>`;
    } else if (!taken) { el.hidden = true; return; }
    el.innerHTML = html; el.hidden = false;
  }
  click101(a) {
    const v = this.view, r = v.round;
    if (a === 'undo') { this.act({ type: 'undoTake' }); return; }
    if (a === 'best') {
      const bl = bestLayout(this.rack.tiles(), r, v.settings, v.you); if (!bl) return;
      const loose = arrange(bl.rest, r.okey, 'runs');
      this.rack.layout(layoutFromGroups([...bl.groups, ...loose], this.rack.cols, this.rack.tiers)); sfx('deal');
      if (!bl.enough) toast(bl.kind === 'pairs' ? t('o101.notYetPairs', { n: bl.count, need: bl.req.pairs }) : t('o101.notYet', { n: bl.value, need: bl.req.value }), '', 2600);
      return;
    }
    if ((a === 'open' || a === 'lay') && this.op101 && this.op101.ok && this.can('discard')) {
      const groups = this.op101.groups;
      this.pendingLay = new Set(groups.flat());
      this.act({ type: 'layDown', groups });
    }
  }
  // dragging a tile: light up the melds it can join (or take an okey back from)
  dragStart101(id) {
    if (!this.is101 || !rules101() || !this.can('discard')) return;
    const v = this.view, r = v.round; if (!r.opened || !r.opened[v.you]) return;
    const R = rules101(), ok = new Set();
    R.layoffs([id], r.table, r.okey).forEach(x => ok.add(x.meld));
    R.swaps([id], r.table, r.okey).forEach(x => ok.add(x.meld));
    ok.forEach(i => { const m = this.meldEl(i); if (m) m.classList.add('can'); });
  }
  // what dropping `id` on meld i at x means: add at a side, or swap an okey out (pointer on that okey)
  meldMove(id, i, x, y) {
    const R = rules101(), r = this.view.round, m = r.table[i], el = this.meldEl(i);
    if (!R || !m || !el) return null;
    const sw = R.swapTile(m, id, r.okey);
    const over = document.elementsFromPoint(x, y).find(e => e.closest && e.closest('.mg') === el && e.dataset && e.dataset.id);
    if (sw && over && +over.dataset.id === sw.okey) return { type: 'swapOkey', tile: id, meld: i, okey: sw.okey };
    if (m.kind === 'run') {
      const b = el.getBoundingClientRect(), pref = x < b.left + b.width / 2 ? 'start' : 'end', other = pref === 'start' ? 'end' : 'start';
      const side = R.addTile(m, id, r.okey, pref) ? pref : R.addTile(m, id, r.okey, other) ? other : null;
      if (side) return { type: 'addToSet', tile: id, meld: i, side };
    } else if (m.kind === 'group' && R.addTile(m, id, r.okey)) return { type: 'addToSet', tile: id, meld: i };
    if (sw) return { type: 'swapOkey', tile: id, meld: i, okey: sw.okey };
    return null;
  }
  renderPlacard() {
    const v = this.view, r = v.round, pl = $('.placard', this.root);
    pl.innerHTML = `<div class="pl1"><b>${this.ctx.solo ? t('placard.practice') : t('placard.table', { code: esc(v.code) })}</b><span class="led">${r ? t('placard.round', { n: r.number }) : ''}</span></div>
      <div class="pl2"><span>${v.settings && v.settings.turnSeconds ? t('placard.turn', { s: v.settings.turnSeconds }) : t('placard.noClock')}</span><span class="led g">${this.is101 ? t('placard.v101Rounds', { n: v.settings.rounds }) : v.settings && v.settings.rounds ? t('placard.rounds', { n: v.settings.rounds }) : t('placard.toZero')}</span></div>`;
  }

  seatsCollide() {
    const hit = (a, b) => b.width && a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
    const things = $$('#pile, .indt, .okeyis:not([hidden]), .ds .dstack, #melds:not([hidden]), #rack', this.root).map(e => e.getBoundingClientRect());
    return $$('.seat.opp', this.root).some(e => { const r = e.getBoundingClientRect(); return things.some(x => hit(r, x)); });
  }
  // ---- opponents: fixed-length racks filled from the start, so adding or removing a tile never moves the others ----
  oppBox(p) { return $(`.seat.p${p} .otiles`, this.root); }
  sideVertical(p) { return (p === 1 || p === 3) && !this.felt.classList.contains('land'); }
  setMiniRack(p, n) {
    const box = this.oppBox(p); if (!box) return [];
    n = Math.max(0, n | 0);
    while (box.childElementCount > n) box.lastElementChild.remove();
    const added = [];
    while (box.childElementCount < n) { const s = document.createElement('i'); s.className = 'os'; s.innerHTML = '<b class="tile back"></b>'; box.appendChild(s); added.push(s); }
    this.oppCount(p);
    return added;
  }
  oppCount(p) { const box = this.oppBox(p); if (box) box.parentNode.querySelector('.ocount').textContent = box.querySelectorAll('.os:not(.hid)').length || ''; }
  oppSlots(p) { return [...this.oppBox(p).children]; }
  oppGeom(p, slot) { const bw = this.bw || 12; return geomOf(slot, bw, bw * 1.5, this.sideVertical(p) ? (p === 1 ? 90 : -90) : 0); }
  // a new hidden slot at the end of the rack (a tile on its way); reveal it when the tile lands
  oppAdd(p) { const box = this.oppBox(p), s = document.createElement('i'); s.className = 'os hid'; s.innerHTML = '<b class="tile back"></b>'; box.appendChild(s); return s; }
  oppReveal(p, slot) { slot.classList.remove('hid'); this.oppCount(p); }
  // the last tile leaves the rack: its geometry, then it is gone
  oppTake(p) { const box = this.oppBox(p), s = box.lastElementChild || this.oppAdd(p); const g = this.oppGeom(p, s); s.remove(); this.oppCount(p); return g; }

  // Discard stacks: up to three tiles of depth under the top one, each with its own small, stable rotation.
  stackOf(p, top) {
    const seat = this.seatAt(p), ids = (this.stacks ||= [[], [], [], []])[seat];
    if (top != null && ids[ids.length - 1] !== top) { ids.length = 0; ids.push(top); }
    if (top == null) ids.length = 0;
    return ids;
  }
  stackPush(seat, id) { const ids = (this.stacks ||= [[], [], [], []])[seat]; ids.push(id); if (ids.length > 4) ids.shift(); }
  stackPop(seat) { const ids = (this.stacks ||= [[], [], [], []])[seat]; ids.pop(); }
  setDiscard(p, st, hideTop = false) {
    const el = $(`.ds.d${p}`, this.root), box = $('.dstack', el);
    const top = st ? st.top : null, n = st ? st.count : 0, layers = Math.min(Math.max(n - 1, 0), 3);
    const ids = this.stackOf(p, n ? top : null);
    const key = `${top}|${layers}|${n > 0}|${ids.join(',')}`;
    if (box.dataset.k !== key) {
      const okey = this.view.round && this.view.round.okey;
      let html = '';
      for (let i = 0; i < layers; i++) {
        const id = ids[ids.length - 1 - (layers - i)];
        html += id != null ? `<div class="${tileClass(id, okey)} dl face" style="--i:${i};--r:${tileRot(id)}deg">${tileInner(id)}</div>` : `<i class="dl" style="--i:${i};--r:${layerRot(p, i)}deg"></i>`;
      }
      if (n) html += top != null
        ? `<div class="${tileClass(top, okey)} dtop" data-id="${top}" role="img" aria-label="${tileLabel(top, okey)}" style="--i:${layers};--r:${tileRot(top)}deg">${tileInner(top)}</div>`
        : `<div class="tile back dtop" style="--i:${layers};--r:0deg"></div>`;
      box.innerHTML = html; box.dataset.k = key;
    }
    const tp = box.querySelector('.dtop'); if (tp) tp.style.visibility = hideTop ? 'hidden' : '';
    el.classList.toggle('empty', !n);
    $('.dn', el).textContent = n > 1 ? n : '';
  }
  discTop(p) { return $(`.ds.d${p} .dtop`, this.root); }
  discGeom(p) { const el = this.discTop(p); if (!el) return geomOf($(`.ds.d${p} .dstack`, this.root), this.dw, this.dw * 1.5, 0); return geomOf(el, this.dw, this.dw * 1.5, el.dataset.id != null ? tileRot(+el.dataset.id) : 0); }

  // The closed pile: what is left after the deal, stacks of five pushed together (you draw from the last one),
  // with an engraved count plate.
  setPile(n) {
    const el = $('#pile', this.root), blk = $('.pblock', el);
    n = Math.max(0, n | 0);
    $('.pplate', el).textContent = n;
    el.classList.toggle('low', n > 0 && n <= 8);
    el.classList.toggle('none', !n);
    const pc = this.pc || 3, ps = this.ps || 22, full = Math.ceil((this.is101 ? 20 : 48) / 5);
    el.style.setProperty('--ps', ps + 'px'); blk.style.setProperty('--pc', pc); blk.style.setProperty('--pr', Math.ceil(full / pc));
    const stacks = Math.ceil(n / 5), last = n - (stacks - 1) * 5;
    let have = $$('.pst', blk);
    for (let i = have.length; i < stacks; i++) { const s = document.createElement('span'); s.className = 'pst'; s.innerHTML = '<span class="tile back"></span>'; blk.appendChild(s); }
    for (let i = stacks; i < have.length; i++) have[i].remove();
    have = $$('.pst', blk);
    have.forEach((s, i) => { s.style.cssText = `--x:${i % pc};--y:${Math.floor(i / pc)};--n:${i === stacks - 1 ? last : 5}`; });
  }
  pileGeom() {
    const ps = this.ps || 22, top = $$('#pile .pst .tile', this.root).pop();
    return top ? geomOf(top, ps, ps * 1.5, 0) : geomOf($('#pile .pblock', this.root), ps, ps * 1.5, 0);
  }

  // The indicator lies face up beside the pile; the okey (one up, same colour) wears a gold ribbon.
  setIndicator(id, faceDown = false, hidden = false) {
    const el = $('.indt', this.root), ok = $('#okeyis', this.root);
    ok.hidden = id == null || faceDown;
    if (id != null && !faceDown) { const f = okeyFace(id); const k = f.color + '.' + f.num; if (ok.dataset.k !== k) { ok.dataset.k = k; $('.okt', ok).innerHTML = faceHTML(f, 'okey') + `<span class="ribbon">${t('table.okeyRibbon')}</span>`; } }
    if (id == null) { el.innerHTML = ''; el.dataset.id = ''; return; }
    const key = String(id) + (faceDown ? 'b' : '') + (hidden ? 'h' : '');
    if (el.dataset.id === key) return;
    el.dataset.id = key;
    el.innerHTML = faceDown ? `<div class="tile back"${hidden ? ' style="visibility:hidden"' : ''}></div>` : `<div class="${tileClass(id, null)}">${tileInner(id)}</div>`;
  }
  indGeom() { return geomOf($('.indt .tile', this.root), this.dw, this.dw * 1.5, -2.5); }

  status() {
    const v = this.view, r = v.round, el = $('#status', this.root);
    let txt = '', cls = '';
    if (v.phase === 'playing' && r) {
      if (r.turn === v.you) {
        cls = 'me';
        txt = r.stage === 'draw' ? t('status.youDraw') : this.is101 ? t('status.youDiscard101') : (r.firstTurn && r.firstTurn[v.you] && r.number && r.dealer === v.you && this.disp && this.disp.count[v.you] === 15 ? t('status.youStart') : t('status.youDiscard'));
      } else {
        const s = v.seats[r.turn] || {};
        txt = t('status.theyPlay', { name: esc(s.name || '') });
      }
    } else if (v.phase === 'roundEnd') txt = t('status.roundEnd');
    else if (v.phase === 'matchEnd') txt = t('status.matchEnd');
    $('.stx', el).innerHTML = txt; el.className = 'status ' + cls;
    const myTurn = v.phase === 'playing' && r && r.turn === v.you && !this.dealing;   // no 'your move' cues while the deal is still on
    this.felt.classList.toggle('can-draw', !!(myTurn && r.stage === 'draw'));
    this.felt.classList.toggle('can-discard', !!(myTurn && r.stage === 'discard'));
  }
  buttons() {
    const v = this.view, r = v.round, b = $('#bShow', this.root);
    const canShow = !this.is101 && v.phase === 'playing' && r && v.you != null && r.firstTurn && r.firstTurn[v.you] && v.seats[v.you] && !v.seats[v.you].showedIndicator
      && v.hand && v.hand.some(x => x !== r.indicator && x < 104 && color(x) === color(r.indicator) && num(x) === num(r.indicator));
    b.hidden = !canShow;
  }

  // the turn clock: a ring around the avatar of whoever is playing
  tick() {
    const v = this.view; if (!v) return;
    const r = v.round;
    $$('.seat', this.root).forEach(el => {
      const seat = this.seatAt(+el.dataset.p), fg = $('.rfg', el), secs = $('.secs', el);
      if (!(r && v.phase === 'playing' && r.turn === seat && r.turnEndsAt)) { fg.style.strokeDashoffset = '0'; secs.textContent = ''; el.classList.remove('hurry'); return; }
      const total = (v.settings.turnSeconds || 30) * 1000;
      const left = Math.max(0, r.turnEndsAt - (Date.now() + this.offset));
      fg.style.strokeDashoffset = String(RING * (1 - left / total));
      const s = Math.ceil(left / 1000);
      secs.textContent = left < 10000 ? s : '';
      const hurry = left < 6000;
      el.classList.toggle('hurry', hurry);
      if (seat === v.you && left <= 5000 && s !== this.lastTock && s > 0) { this.lastTock = s; sfx('tock'); }
    });
  }

  // ---- what the player can do ----
  can(what) {
    const v = this.view, r = v && v.round;
    if (!r || v.phase !== 'playing' || r.turn !== v.you || this.busy || this.dealing) return false;
    return what === 'draw' ? r.stage === 'draw' : r.stage === 'discard';
  }
  act(action) {
    this.busy = true;
    advanceGuide();
    this.ctx.send({ t: 'act', action, v: this.view.v });
  }
  error(code) {
    this.busy = false;
    if (this.pendingDiscard != null) { const id = this.pendingDiscard; this.pendingDiscard = null; this.rack.hide(id, false); }
    if (this.pendingDraw) { if (this.pendingDraw.ghost) this.pendingDraw.ghost.remove(); this.pendingDraw = null; this.unlift(); }
    if (this.pendingLay) { this.pendingLay.forEach(id => this.rack.hide(id, false)); this.pendingLay = null; }
    this.disp = dispFrom(this.view); this.render();
    sfx('error');
    toast(esc(t('err.' + code) !== 'err.' + code ? t('err.' + code) : t('err.generic')), 'err');
  }

  targetAt(x, y) {
    if (!this.can('discard')) return null;
    this.pt = { x, y };
    const inside = (el, pad = 10) => { if (!el) return false; const b = el.getBoundingClientRect(); return x >= b.left - pad && x <= b.right + pad && y >= b.top - pad && y <= b.bottom + pad; };
    if (inside($('.ds.d0', this.root), 14)) return 'discard';
    if (this.is101) {
      const mg = $$('#melds .mg', this.root).find(m => inside(m, 5));
      return mg ? 'meld:' + mg.dataset.i : null;
    }
    if (inside($('.center', this.root), 4)) return 'finish';
    return null;
  }
  hover(target, id) {
    const fz = $('#fz', this.root), d0 = $('.ds.d0', this.root);
    $$('#melds .mg.hot', this.root).forEach(m => m.classList.remove('hot', 'ok', 'no'));
    if (target == null) $$('#melds .mg.can', this.root).forEach(m => m.classList.remove('can'));
    if (target && target.startsWith('meld:')) {
      const i = +target.slice(5), m = this.meldEl(i), mv = this.pt && this.meldMove(id, i, this.pt.x, this.pt.y);
      if (m) m.classList.add('hot', mv ? 'ok' : 'no');
    }
    d0.classList.toggle('hot', target === 'discard');
    fz.classList.remove('ok', 'no');
    this.felt.classList.toggle('finishing', target === 'finish');
    if (target === 'finish') {
      const res = this.finishFor(id);
      fz.classList.add(res ? 'ok' : 'no');
      $('span', fz).textContent = res ? (res.kind === 'pairs' ? t('finish.okPairs') : t('finish.ok')) : t('finish.no');
    }
  }
  finishFor(id) {
    const v = this.view, r = v.round; if (!v.hand) return null;
    const rest = v.hand.filter(x => x !== id);
    const layout = this.rack.groups().map(g => g.filter(x => x !== id)).filter(g => g.length);
    return finishCheck(rest, r.okey, layout);
  }
  drop(target, id, rect) {
    this.hover(null, id);
    if (target === 'discard') return this.discardFrom(id, rect);
    if (target === 'finish') return this.tryFinish(id, rect);
    if (target && target.startsWith('meld:')) return this.toMeld(id, +target.slice(5), rect);
    return false;
  }
  toMeld(id, i, rect) {
    const v = this.view, r = v.round;
    if (!r.opened || !r.opened[v.you]) { sfx('error'); toast(t('err.notOpened'), 'err'); return false; }
    const mv = this.pt && this.meldMove(id, i, this.pt.x, this.pt.y);
    if (!mv) { sfx('error'); shake(this.meldEl(i)); toast(t('err.cannotAdd'), 'err'); return false; }
    this.pendingLay = new Set([id]); this.rack.hide(id, true);
    const m = this.meldEl(i), b = m.getBoundingClientRect(), tr = m.querySelector('.tile').getBoundingClientRect();
    const to = { left: mv.side === 'start' ? b.left - tr.width : b.right, top: tr.top, width: tr.width, height: tr.height };
    flyTile({ id, okey: r.okey, from: rect, to, start: 'face', ms: 260, arc: 0.1 });
    this.act(mv);
    return true;
  }
  quickDiscard(id) { if (this.can('discard')) this.discardFrom(id, this.rack.tileGeom(id)); }
  // 101: the tile flies from where it is to its place on the board (rendered with the new melds, tiles hidden)
  async flyToBoard(ev, next, ids, seat) {
    const r = next.round, me = next.you, p = this.pos(seat);
    const hide = new Set(ids);
    this.view = { ...this.view, round: { ...this.view.round, table: r.table } };
    this.renderMelds(r.table, hide);
    const plan = ids.map(id => {
      const dst = $(`#melds .tile[data-id="${id}"]`, this.root);
      const from = seat === me ? rectGeo(this.rack.tileRect(id)) : this.oppTake(p);
      if (seat === me) this.rack.hide(id, true);
      return { id, dst, from, to: geomOf(dst) };
    });
    await Promise.all(plan.map(({ id, dst, from, to }, k) => fly({ id, okey: r.okey, from, to, faceFrom: seat === me, faceTo: true, flipAt: 'early', ms: 360, arc: 0.18, delay: k * 45,
      onLand: () => { if (dst) dst.classList.remove('gone'); if (k % 2 === 0) sfx('clack', { level: 0.5 }); } })));
    this.disp.count[seat] = Math.max(0, this.disp.count[seat] - ids.length);
  }
  selectChanged(id) { this.felt.classList.toggle('picked', id != null); }

  discardFrom(id, fromRect, sure = false) {
    if (!this.can('discard')) return false;
    if (!sure && S.settings.okeyGuard !== false && S.settings.reverseOkey !== false && isOkey(id, this.view.round.okey)
      && !(this.is101 && this.view.hand.length <= 1)
      && !(this.is101 && rules101() && rules101().isIslek(id, this.view.round.table, this.view.round.okey, { swap: this.view.settings.okeySwap !== false }))) {
      sfx('error');
      confirmSheet(t('guard.title'), t('guard.body'), t('guard.yes'), () => this.discardFrom(id, this.rack.tileGeom(id), true));
      return false;
    }
    if (this.is101 && !sure) {
      const v = this.view, r = v.round, R = rules101();
      if (r.taken != null && v.hand.includes(r.taken)) { sfx('error'); toast(t('err.mustUseTaken'), 'err'); return false; }
      const sc = v.settings.scoring || {};
      if (R && v.hand.length > 1) {
        const islek = R.isIslek(id, r.table, r.okey, { swap: v.settings.okeySwap !== false });
        const okeyPen = !islek && sc.okeyDiscard > 0 && isOkey(id, r.okey);
        if (islek || okeyPen) {
          const n = islek ? sc.islek || 101 : sc.okeyDiscard;
          sfx('error');
          confirmSheet(t(islek ? 'islek.title' : 'islek.okeyTitle'), t(islek ? 'islek.body' : 'islek.okeyBody', { n }), t('islek.yes', { n }), () => this.discardFrom(id, this.rack.tileRect(id), true));
          return false;
        }
      }
    }
    this.pendingDiscard = id;
    this.rack.hide(id, true);
    const okey = this.view.round.okey, me = this.view.you;
    this.stackPush(me, id);
    this.setDiscard(0, { top: id, count: (this.disp.disc[me].count || 0) + 1 }, true);
    const top = this.discTop(0), to = this.discGeom(0);
    this.act({ type: 'discard', tile: id });
    fly({ id, okey, from: toGeo(fromRect), to, faceFrom: true, faceTo: true, ms: 300, arc: 0.06, swell: 1,
      onLand: () => { if (this.pendingDiscard === id || this.discTop(0) === top) { top.style.visibility = ''; sfx(this.disp.disc[me].count > 1 ? 'stack' : 'felt'); buzz(); } } });
    return true;
  }
  tryFinish(id, fromRect) {
    if (!this.can('discard')) return false;
    const res = this.finishFor(id);
    const engineSure = !!(getEngine() && getEngine().findFinish);
    if (!res && engineSure) { shake($('.center', this.root)); sfx('error'); toast(t('finish.cannot'), 'err'); return false; }
    const groups = res ? res.groups : this.rack.groups().map(g => g.filter(x => x !== id)).filter(g => g.length);
    this.pendingDiscard = id; this.rack.hide(id, true);
    this.finFrom = toGeo(fromRect) || this.rack.tileGeom(id);   // a slam rises from where the tile was let go
    this.act({ type: 'finish', tile: id, groups });
    return true;
  }

  wireDrawSource(el, from) {
    let drag = null;
    el.addEventListener('pointerdown', e => {
      if (!this.can('draw')) return;
      if (from === 'discard' && !(this.disp && this.disp.disc[(this.view.you + 3) % 4].count)) return;
      drag = { x0: e.clientX, y0: e.clientY, pid: e.pointerId, ghost: null, slot: -1 };
      el.setPointerCapture(e.pointerId); e.preventDefault();
    });
    el.addEventListener('pointermove', e => {
      if (!drag || e.pointerId !== drag.pid) return;
      if (!drag.ghost) {
        if (Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 8) return;
        const top = from === 'pile' ? null : this.disp.disc[(this.view.you + 3) % 4].top;
        const g = document.createElement('div');
        g.className = 'dragghost ' + tileClass(top, this.view.round.okey); g.innerHTML = tileInner(top);
        g.style.setProperty('--tw', this.rack.tw + 'px'); document.body.appendChild(g); drag.ghost = g;
        if (from === 'discard') $('.ds.d3 .dtop', this.root) && $('.ds.d3 .dtop', this.root).classList.add('lifted');
        sfx('pick');
      }
      drag.ghost.style.transform = `translate(${e.clientX - this.rack.tw / 2}px,${e.clientY - this.rack.th * 0.8}px) rotate(-3deg) scale(1.1)`;
      const slot = this.rack.slotAt(e.clientX, e.clientY - this.rack.th * 0.3);
      if (slot !== drag.slot) { drag.slot = slot; this.rack.preview = slot >= 0 && this.rack.slots[slot] != null ? shiftPreview(this.rack.slots, slot, this.rack.cols) : null; this.rack.render(); }
    });
    const end = (e, cancel) => {
      if (!drag || e.pointerId !== drag.pid) return;
      const d = drag; drag = null;
      try { el.releasePointerCapture(d.pid); } catch { /* ignore */ }
      if (d.ghost) {
        const gr = d.ghost.getBoundingClientRect();
        if (this.rack.preview) { this.rack.slots = this.rack.preview; this.rack.preview = null; this.rack.render(); }
        if (cancel || d.slot < 0) { d.ghost.remove(); this.unlift(); this.rack.render(); return; }
        const geo = { cx: gr.left + gr.width / 2, cy: gr.top + gr.height / 2, w: this.rack.tw * 1.1, h: this.rack.th * 1.1, rot: -3 };
        this.drawSlot = d.slot; this.pendingDraw = { from, ghost: d.ghost, geo };
      } else if (cancel) return;
      this.draw(from);
    };
    el.addEventListener('pointerup', e => end(e, false));
    el.addEventListener('pointercancel', e => end(e, true));
  }
  unlift() { const tp = $('.ds.d3 .dtop', this.root); if (tp) tp.classList.remove('lifted'); }
  draw(from) {
    if (!this.can('draw')) return;
    if (from === 'discard' && !this.disp.disc[(this.view.you + 3) % 4].count) return;
    if (!this.pendingDraw) this.pendingDraw = { from };
    if (from === 'pile') pulse($('#pile', this.root), 'lift', 400);
    this.act({ type: 'draw', from });
  }

  // ---- events as animations (this.view is still the previous view) ----
  async play(ev, next) {
    const okey = (next.round || {}).okey;
    const me = next.you;
    switch (ev.type) {
      case 'roundStart': return this.deal(ev, next);
      case 'dealt': return;
      case 'draw': {
        const p = this.pos(ev.seat), d = this.disp;
        const prevSeat = (ev.seat + 3) % 4;
        const fromGeo = ev.from === 'pile' ? this.pileGeom() : this.discGeom(this.pos(prevSeat));
        const fromRect = geoRect(fromGeo);
        if (ev.from === 'discard') {
          const st = d.disc[prevSeat]; st.count = Math.max(0, st.count - 1);
          this.stackPop(prevSeat);
          const known = this.stacks[prevSeat]; if (st.count && known.length && next.seats[prevSeat].discard.count === st.count) known[known.length - 1] = next.seats[prevSeat].discard.top;
          st.top = st.count && next.seats[prevSeat].discard.count === st.count ? next.seats[prevSeat].discard.top : null;
          this.setDiscard(this.pos(prevSeat), st);
        } else { d.pile = Math.max(0, d.pile - 1); this.setPile(d.pile); }
        if (ev.seat === me) {
          const tile = ev.tile != null ? ev.tile : (next.hand || []).find(x => !this.rack.slots.includes(x));
          const pd = this.pendingDraw; this.pendingDraw = null;
          if (tile == null) return;
          const slot = this.drawSlot >= 0 ? this.drawSlot : this.rack.newSlot(); this.drawSlot = -1;
          this.rack.hide(tile, true);
          this.rack.sync([...this.rack.tiles(), tile], new Map([[tile, slot]]));
          sfx('draw');
          const ghost = pd && pd.ghost;
          await fly({ id: tile, okey, from: ghost ? pd.geo : fromGeo, to: rectGeo(this.rack.slotRect(this.rack.slotOf(tile))), faceFrom: ev.from !== 'pile', faceTo: true, flipAt: 'late',
            ms: ghost ? 220 : 380, arc: ghost ? 0.03 : 0.08, swell: ghost ? 1 : 1.03, onLaunch: () => { if (ghost) ghost.remove(); },
            onLand: () => { this.rack.hide(tile, false); sfx('rack'); buzz(); } });
          d.count[me]++;
        } else {
          // a tile back slides from the pile to their rack; a discard they take slides face up and turns in
          const slot = this.oppAdd(p), to = this.oppGeom(p, slot), face = ev.from === 'discard';
          sfx('draw');
          await fly({ id: face ? ev.tile : null, okey, from: fromGeo, to, faceFrom: face, faceTo: false, flipAt: 'late', ms: 360, arc: 0.14, onLand: () => { this.oppReveal(p, slot); sfx('rack', { level: 0.45 }); } });
          d.count[ev.seat]++;
        }
        return;
      }
      case 'discard': {
        const p = this.pos(ev.seat), d = this.disp;
        const st = d.disc[ev.seat];
        const forgot = ev.seat === me ? this.forgotCopy(this.view) : null;
        if (ev.seat === me && this.pendingDiscard === ev.tile) {
          this.pendingDiscard = null;
          d.count[me]--; st.top = ev.tile; st.count++;
          await wait(120);
          if (forgot != null) this.sadMoment(forgot, ev.tile);
          return;
        }
        // the tile lifts off their rack, turns face up early and arcs onto their stack
        let from;
        if (ev.seat === me) { from = rectGeo(this.rack.tileRect(ev.tile)); this.rack.hide(ev.tile, true); }
        else from = this.oppTake(p);
        d.count[ev.seat] = Math.max(0, d.count[ev.seat] - 1); st.top = ev.tile; st.count++;
        this.stackPush(ev.seat, ev.tile);
        this.setDiscard(p, st, true);
        const top = this.discTop(p), to = this.discGeom(p);
        await fly({ id: ev.tile, okey, from, to, faceFrom: ev.seat === me, faceTo: true, flipAt: 'early', ms: 400, arc: ev.seat === me ? 0.06 : 0.26,
          onLand: () => { top.style.visibility = ''; if (ev.seat !== me) land(top); sfx(st.count > 1 ? 'stack' : 'felt'); } });
        if (forgot != null) this.sadMoment(forgot, ev.tile);
        return;
      }
      case 'showIndicator': return this.showIndicatorFx(ev, true);
      case 'take': return this.takeFx(ev, next, false);
      case 'undoTake': return this.takeFx(ev, next, true);
      case 'layDown': {
        await this.flyToBoard(ev, next, ev.melds.flatMap(m => m.tiles), ev.seat);
        if (ev.seat === me) this.pendingLay = null;
        if (ev.opening) {
          const s = next.seats[ev.seat] || {}, o = ev.opening;
          const msg = o.kind === 'pairs' ? t(ev.seat === me ? 't101.youOpenedPairs' : 't101.openedPairs', { name: esc(s.name || ''), n: o.pairs })
            : t(ev.seat === me ? 't101.youOpened' : 't101.opened', { name: esc(s.name || ''), n: o.value });
          toast(msg, ev.seat === me ? 'win' : '', 2400); sfx(ev.seat === me ? 'win' : 'pop');
        }
        return;
      }
      case 'addToSet': { await this.flyToBoard(ev, next, [ev.tile], ev.seat); if (ev.seat === me) this.pendingLay = null; return; }
      case 'swapOkey': {
        await this.flyToBoard(ev, next, [ev.tile], ev.seat);
        if (ev.seat === me) this.pendingLay = null;
        sfx('okey');
        const p = this.pos(ev.seat), src = geomOf(this.meldEl(ev.meld) || $('#melds', this.root));
        if (src) { src.w = this.mwNow(); src.h = src.w * 1.5; }
        if (ev.seat === me) {
          this.rack.hide(ev.okey, true); this.rack.sync([...this.rack.tiles(), ev.okey]);
          await fly({ id: ev.okey, okey, from: src, to: rectGeo(this.rack.tileRect(ev.okey)), faceFrom: true, faceTo: true, ms: 420, arc: 0.25, cls: 'golden' });
          this.rack.hide(ev.okey, false);
        } else { const slot = this.oppAdd(p); await fly({ id: ev.okey, okey, from: src, to: this.oppGeom(p, slot), faceFrom: true, faceTo: false, flipAt: 'late', ms: 420, arc: 0.25, cls: 'golden', onLand: () => this.oppReveal(p, slot) }); }
        this.disp.count[ev.seat]++;
        return;
      }
      case 'penalty': {
        const p = this.pos(ev.seat), s = next.seats[ev.seat] || {}, pl = $(`.seat.p${p} .plate`, this.root);
        void s;
        const f = document.createElement('b'); f.className = 'delta neg'; f.textContent = '+' + ev.points;
        pl.appendChild(f); setTimeout(() => f.remove(), dur(1800) || 50);
        toast(t(ev.reason === 'okeyDiscard' ? 't101.penOkey' : 't101.penIslek', { name: esc(s.name || ''), n: ev.points }), 'err', 2600);
        sfx('error'); await wait(300);
        return;
      }
      case 'finish': return this.finishFx(ev, next);
      case 'pileEmpty': toast(t('toast.pileEmpty'), '', 2600); await wait(500); return;
      case 'score': return this.scoreFx(ev, next);
      case 'matchEnd': return;
      default: return;
    }
  }

  // 101: picking up the left discard (it must go to the table this turn), or putting it back.
  async takeFx(ev, next, undo) {
    const okey = (next.round || {}).okey, me = next.you, p = this.pos(ev.seat), d = this.disp;
    const prevSeat = (ev.seat + 3) % 4, pp = this.pos(prevSeat), st = d.disc[prevSeat];
    if (!undo) {
      const from = this.discGeom(pp);
      st.count = Math.max(0, st.count - 1);
      this.stackPop(prevSeat);
      st.top = st.count && next.seats[prevSeat].discard.count === st.count ? next.seats[prevSeat].discard.top : null;
      this.setDiscard(pp, st);
      if (ev.seat === me) {
        const pd = this.pendingDraw; this.pendingDraw = null;
        const slot = this.drawSlot >= 0 ? this.drawSlot : this.rack.newSlot(); this.drawSlot = -1;
        this.rack.hide(ev.tile, true); this.rack.sync([...this.rack.tiles(), ev.tile], new Map([[ev.tile, slot]]));
        this.rack.flag(ev.tile, 'taken');
        sfx('draw');
        const ghost = pd && pd.ghost;
        await fly({ id: ev.tile, okey, from: ghost ? pd.geo : from, to: rectGeo(this.rack.slotRect(this.rack.slotOf(ev.tile))), faceFrom: true, faceTo: true, ms: ghost ? 220 : 380, arc: ghost ? 0.03 : 0.08, swell: ghost ? 1 : 1.03,
          onLaunch: () => { if (ghost) ghost.remove(); }, onLand: () => { this.rack.hide(ev.tile, false); sfx('rack'); buzz(); } });
      } else {
        const slot = this.oppAdd(p);
        await fly({ id: ev.tile, okey, from, to: this.oppGeom(p, slot), faceFrom: true, faceTo: false, flipAt: 'late', ms: 380, arc: 0.15, onLand: () => this.oppReveal(p, slot) });
        toast(t('t101.took', { name: esc((next.seats[ev.seat] || {}).name || '') }), '', 1800);
      }
      d.count[ev.seat]++;
    } else {
      const from = ev.seat === me ? rectGeo(this.rack.tileRect(ev.tile)) : this.oppTake(p);
      if (ev.seat === me) this.rack.hide(ev.tile, true);
      st.count++; st.top = ev.tile; this.stackPush(prevSeat, ev.tile); this.setDiscard(pp, st, true);
      const top = this.discTop(pp);
      await fly({ id: ev.tile, okey, from, to: this.discGeom(pp), faceFrom: ev.seat === me, faceTo: true, flipAt: 'early', ms: 360, arc: 0.2, onLaunch: null, onLand: () => { top.style.visibility = ''; land(top); sfx(st.count > 1 ? 'stack' : 'felt'); } });
      d.count[ev.seat] = Math.max(0, d.count[ev.seat] - 1);
    }
  }

  // The deal, as at a kahvehane table: the tiles are swirled face down and built into stacks of five (21 × 5 + 1);
  // two dice pick a stack and its top tile turns up as the gösterge; whole stacks go out in turn order (the starter
  // gets one more tile); what is left stays in the middle as the draw pile. Your tiles land face down, turn up and
  // slide into order; an okey turns upside down last. A tap skips it; reduced motion skips it.
  async deal(ev, next) {
    this.dealing = true;
    closeGuide(false);
    this.view = next;
    this.newRound(next);
    const me = next.you, okey = next.round.okey, hand = (next.hand || []).slice();
    const want = next.seats.map((s, i) => (i === me && next.hand ? next.hand.length : s.handCount || 0));
    this.disp = { count: want.slice(), disc: [0, 1, 2, 3].map(() => ({ top: null, count: 0 })), pile: ev.pileCount };
    const sorted = this.rack.slots.slice();
    // my tiles come in the order they were dealt, left to right
    const seq = Array(this.rack.slots.length).fill(null); hand.forEach((id, i) => { seq[i] = id; });
    hand.forEach(id => this.rack.hidden.add(id));
    this.rack.layout(seq);
    const pileEl = $('#pile', this.root); pileEl.classList.add('dealing');
    this.render();
    for (let p = 1; p < 4; p++) { this.oppSlots(p).forEach(x => x.classList.add('hid')); this.oppCount(p); }
    this.setIndicator(null);
    const board = document.createElement('div'); board.className = 'dealboard'; document.body.appendChild(board);
    const done = () => {
      board.remove();
      for (let p = 1; p < 4; p++) { this.oppSlots(p).forEach(x => x.classList.remove('hid')); this.oppCount(p); }
      this.rack.dealIn(hand.filter(id => this.rack.hidden.has(id)));
      this.rack.faceDown(hand, false);
      this.rack.els.forEach(el => { el.style.transition = ''; });
      if (this.rack.slots.join() !== sorted.join()) this.rack.layout(sorted);
      this.rack.turnOkeys(hand.filter(id => isOkey(id, okey)));
      pileEl.classList.remove('dealing');
      this.setPile(ev.pileCount);
      this.setIndicator(ev.indicator);
      this.dealing = false;
      setSkip(false);
    };
    if (reduced()) { done(); return; }
    // the first paint of the new round (and, on a fresh page, the boot) settles before anything moves
    await nextFrame(); await new Promise(r => (globalThis.requestIdleCallback ? requestIdleCallback(() => r(), { timeout: 280 }) : setTimeout(r, 60)));
    const t0 = performance.now();
    try { await this.dealShow(ev, next, { me, okey, hand, want, sorted, board, pileEl }); } catch (e) { console.error(e); }
    if (globalThis.__okeyFlights) globalThis.__okeyFlights.push([t0, performance.now()]);   // test hook (perf.pw.mjs): the deal counts as motion
    done();
    pulse($('.ind', this.root), 'glow', 1400);
  }

  async dealShow(ev, next, { me, okey, hand, want, sorted, board }) {
    // the stacks' spot: the middle of the felt (the pile and the indicator are not there yet)
    const cr = $('.center', this.root).getBoundingClientRect();
    const W = Math.max(cr.width, 170), H = Math.max(cr.height, 120), cx = cr.left + cr.width / 2, cy = cr.top + cr.height / 2;
    const N = 22, counts = Array(N).fill(5); counts[N - 1] = 1;   // 106 = 21 × 5 + 1
    let fit = null;
    for (let R = 2; R <= 6; R++) { const C = Math.ceil(N / R), ps = Math.min(this.dw * 0.66, (W * 0.94) / (C * 1.08), (H * 0.86) / (R * 1.95)); if (!fit || ps > fit.ps) fit = { R, C, ps }; }
    const ps = Math.max(12, Math.floor(fit.ps)), xs = ps * 1.08, ys = ps * 1.95, C = fit.C, R = fit.R;
    board.style.setProperty('--ps', ps + 'px');
    const off = n => (5 - n) * 1.35;                     // the top tile sits lower on a shorter stack
    const spot = i => { const r = Math.floor(i / C), inRow = Math.min(C, N - r * C), c = i % C;
      return { left: cx - (inRow * xs - (xs - ps)) / 2 + c * xs, top: cy - (R * ys) / 2 + r * ys + ps * 0.1 }; };
    const topG = (el) => { const n = +el.style.getPropertyValue('--n'), L = parseFloat(el.style.left), T = parseFloat(el.style.top); return { cx: L + ps / 2, cy: T + off(n) + ps * 0.75, w: ps, h: ps * 1.5, rot: 0 }; };
    const mkStack = (left, top, n) => { const el = document.createElement('div'); el.className = 'dstk'; el.style.cssText = `left:${left}px;top:${top}px;--n:${n}`; el.innerHTML = '<span class="tile back"></span>'; board.appendChild(el); return el; };
    // move a stack so its top tile lands on a target pose (scaled to the target's size, turned to its rotation)
    const glide = (el, to, ms, delay = 0, arc = 0.14) => {
      const g = topG(el), oy = g.cy - parseFloat(el.style.top);
      el.style.transformOrigin = `${ps / 2}px ${oy}px`;
      const dx = to.cx - g.cx, dy = to.cy - g.cy, sc = to.w / ps, r = to.rot || 0, lift = Math.min(60, Math.hypot(dx, dy) * arc);
      return el.animate([{ transform: 'none' }, { transform: `translate(${dx / 2}px,${dy / 2 - lift}px) rotate(${r / 2}deg) scale(${((1 + sc) / 2) * 1.04})` },
        { transform: `translate(${dx}px,${dy}px) rotate(${r}deg) scale(${sc})` }], { duration: dur(ms), delay: dur(delay), easing: 'cubic-bezier(.33,0,.2,1)', fill: 'forwards' }).finished.catch(() => {});
    };

    // 1. the swirl: tile backs circle on the cloth, then each settles where a stack will stand
    setTimeout(() => sfx('shuffle'), 30);   // its own task, not in the frame that builds the board
    const stacks = counts.map((n, i) => { const p = spot(i), el = mkStack(p.left, p.top, n); el.style.visibility = 'hidden'; return el; });
    const frag = document.createDocumentFragment();
    const swirl = stacks.map((st, i) => {
      const g = topG(st), el = document.createElement('div');
      el.className = 'tile back loose'; el.style.cssText = `--tw:${ps}px;left:${g.cx - ps / 2}px;top:${g.cy - ps * 0.75}px`;
      frag.appendChild(el);
      const a0 = Math.random() * Math.PI * 2, rx = W * (0.22 + Math.random() * 0.2), ry = H * (0.16 + Math.random() * 0.16), r0 = Math.random() * 360;
      const at = k => { const a = a0 + k * 1.35; return `translate(${cx + Math.cos(a) * rx * (1 - k * 0.12) - g.cx}px,${cy + Math.sin(a) * ry * (1 - k * 0.12) - g.cy}px) rotate(${r0 + k * 95}deg)`; };
      return [el, [{ transform: at(0), opacity: 0, offset: 0 }, { transform: at(0.4), opacity: 1, offset: 0.12 }, { transform: at(1), offset: 0.42 }, { transform: at(1.7), offset: 0.68, easing: 'cubic-bezier(.3,.6,.3,1)' },
        { transform: `translate(0,0) rotate(${(i % 3) - 1}deg)`, offset: 1 }], { duration: dur(720), delay: dur(i * 6), easing: 'linear', fill: 'both' }];
    });
    board.appendChild(frag);
    await Promise.all(swirl.map(([el, kf, o]) => el.animate(kf, o).finished.catch(() => {})));
    stacks.forEach(st => { st.style.visibility = ''; });
    board.querySelectorAll('.loose').forEach(x => x.remove());
    sfx('stack');

    // 2. the dice: thrown from the dealer's side, they tumble and settle; their total counts to a stack
    const dealerEl = $(this.pos(ev.dealer) === 0 ? '.mine .plate' : `.seat.p${this.pos(ev.dealer)} .plate`, this.root);
    const dr = dealerEl ? dealerEl.getBoundingClientRect() : cr;
    const dd = Math.round(Math.max(14, Math.min(26, ps * 0.8))), PIPS = [[4], [0, 8], [0, 4, 8], [0, 2, 6, 8], [0, 2, 4, 6, 8], [0, 2, 3, 5, 6, 8]];
    const v = [1 + Math.floor(Math.random() * 6), 1 + Math.floor(Math.random() * 6)];
    const face = (el, n) => el.querySelectorAll('i').forEach((p, k) => p.classList.toggle('on', PIPS[n - 1].includes(k)));
    const dice = v.map((n, k) => {
      const el = document.createElement('div'); el.className = 'die' + (k ? ' red' : ''); el.style.setProperty('--dd', dd + 'px');
      el.innerHTML = '<i></i>'.repeat(9); face(el, 1 + ((n + 2) % 6));
      const ex = cx + (k ? 0.9 : -0.9) * dd, ey = cy + (k ? -0.35 : 0.35) * dd;
      el.style.left = ex - dd / 2 + 'px'; el.style.top = ey - dd / 2 + 'px'; board.appendChild(el);
      const sx = dr.left + dr.width / 2 - ex + (k ? 10 : -10), sy = dr.top + dr.height / 2 - ey, spin = (k ? 1 : -1) * (540 + Math.random() * 200);
      const a = el.animate([{ transform: `translate(${sx}px,${sy}px) rotate(0deg) scale(1.25)`, opacity: 0 }, { transform: `translate(${sx * 0.5}px,${sy * 0.5}px) rotate(${spin * 0.55}deg) scale(1.3)`, opacity: 1, offset: 0.3 },
        { transform: `translate(${sx * 0.12}px,${sy * 0.12}px) rotate(${spin * 0.86}deg) scale(1.06)`, offset: 0.62 }, { transform: `translate(${sx * 0.03}px,${sy * 0.03}px) rotate(${spin * 0.96}deg) scale(1.1)`, offset: 0.8 },
        { transform: `translate(0,0) rotate(${spin}deg) scale(1)` }], { duration: dur(560), delay: dur(k * 50), easing: 'cubic-bezier(.25,.6,.35,1)', fill: 'both' });
      const roll = setInterval(() => face(el, 1 + Math.floor(Math.random() * 6)), 70);
      return a.finished.catch(() => {}).then(() => { clearInterval(roll); face(el, n); });
    });
    setTimeout(() => sfx('dice'), dur(170));
    await Promise.all(dice);
    const pick = (v[0] + v[1] - 1) % N, pst = stacks[pick];
    pst.classList.add('pick');
    await wait(260);
    board.querySelectorAll('.die').forEach(x => x.animate([{ opacity: 1 }, { opacity: 0 }], { duration: dur(220), fill: 'forwards' }));

    // 3. the picked stack's top tile turns up as the gösterge and goes beside the pile spot; the okey is marked
    this.setIndicator(ev.indicator, true, true);
    const indTile = $('.indt .tile', this.root), from = topG(pst);
    counts[pick]--; pst.style.setProperty('--n', counts[pick]);
    sfx('flip');
    await fly({ id: ev.indicator, okey: null, from, to: this.indGeom(), faceFrom: false, faceTo: true, flipAt: 'mid', ms: 440, arc: 0.3, onLand: () => { if (indTile) indTile.style.visibility = ''; this.setIndicator(ev.indicator); } });
    pst.classList.remove('pick');
    board.querySelectorAll('.die').forEach(x => x.remove());
    const ok = $('#okeyis', this.root);
    if (ok && dur(320)) {
      ok.animate([{ opacity: 0, transform: 'translateX(-8px) scale(.85)' }, { opacity: 1, transform: 'none' }], { duration: dur(320), easing: 'cubic-bezier(.2,.9,.3,1.2)' });
      const rb = $('.ribbon', ok); if (rb) rb.animate([{ clipPath: 'inset(0 100% 0 0)' }, { clipPath: 'inset(0 0 0 0)' }], { duration: dur(360), delay: dur(160), fill: 'backwards', easing: 'ease-out' });
      sfx('chime');
    }

    // 4. whole stacks go out, seat by seat in turn order from the dealer's right; the dealer's last packet is one more
    let cur = (pick + 1) % N;
    const take = n => { const out = []; for (let guard = 0; n > 0 && guard < N * 2; guard++) { if (!counts[cur]) { cur = (cur + 1) % N; continue; } const k = Math.min(n, counts[cur]); out.push([cur, k]); counts[cur] -= k; n -= k; if (!counts[cur]) cur = (cur + 1) % N; } return out; };
    const order = [1, 2, 3, 0].map(k => (ev.dealer + k) % 4);
    const packets = order.map(seat => { const out = []; for (let n = want[seat]; n > 0; n -= 5) out.push(Math.min(5, n)); return out; });
    const given = [0, 0, 0, 0], flights = [], gap = this.is101 ? 52 : 76;
    let k = 0;
    const rounds = Math.max(...packets.map(x => x.length));
    // every target is measured first (reads), then the stacks move (writes): no layout thrash mid-deal
    const plan = [];
    for (let rd = 0; rd < rounds; rd++) {
      order.forEach((seat, oi) => {
        const n = packets[oi][rd]; if (!n) return;
        const p = this.pos(seat), first = given[seat]; given[seat] += n;
        const ids = seat === me ? hand.slice(first, first + n) : null;
        const oslots = seat !== me && p ? this.oppSlots(p).slice(first, first + n) : null;
        let to;
        if (ids) to = rectGeo(this.rack.slotRect(this.rack.slotOf(ids[Math.floor((ids.length - 1) / 2)])));
        else if (oslots && oslots.length) to = this.oppGeom(p, oslots[Math.floor((oslots.length - 1) / 2)]);
        plan.push({ n, p, ids, oslots, to });
      });
    }
    plan.forEach(({ n, p, ids, oslots, to }) => {
      const chunks = take(n), delay = k++ * gap;
      chunks.forEach(([i, m], ci) => {
        const src = stacks[i], have = +src.style.getPropertyValue('--n');
        let el = src;
        if (m < have) { el = mkStack(parseFloat(src.style.left), parseFloat(src.style.top) + (m - have) * 1.35, m); src.style.setProperty('--n', have - m); }
        else src.dataset.gone = '1';
        if (!to) { el.remove(); return; }
        const last = ci === chunks.length - 1;
        flights.push(sleep(dur(delay)).then(() => sfx('slide', { level: 0.6 })).then(() => glide(el, to, 330, 0, 0.12)).then(() => {
          el.remove();
          if (!last) return;
          if (ids) { this.rack.dealIn(ids, this.rack.slotOf(ids[Math.floor((ids.length - 1) / 2)])); sfx('rack', { level: 0.7 }); }
          else { oslots.forEach(x => this.oppReveal(p, x)); sfx('clack', { level: 0.35, pitch: 1.1 }); }
        }));
      });
    });
    await Promise.all(flights);

    // 5. what is left stays in the middle: the stacks slide together into the draw pile
    this.setPile(ev.pileCount);
    const targets = $$('#pile .pst .tile', this.root).map(x => geomOf(x, this.ps, this.ps * 1.5, 0));
    const left = stacks.filter(x => x.isConnected && !x.dataset.gone && +x.style.getPropertyValue('--n') > 0);
    const toPile = left.map((st, j) => { const tg = targets[Math.min(j, targets.length - 1)]; return tg ? glide(st, tg, 380, j * 30, 0.05) : Promise.resolve(); });
    if (left.length) sfx('slide');
    // 6. meanwhile my tiles turn face up, one after another, then slide into order
    const flips = hand.map((id, i) => wait(i * (this.is101 ? 14 : 17)).then(() => this.rack.turnUp(id, dur(200)).then(() => { if (i % 4 === 0) sfx('tick'); })));
    await Promise.all([...toPile, ...flips]);
    $('#pile', this.root).classList.remove('dealing');
    board.querySelectorAll('.dstk').forEach(x => x.remove());
    await wait(120);
    const st = this.is101 ? 10 : 13;
    sorted.forEach((id, i) => { if (id == null) return; const el = this.rack.els.get(id); if (el) el.style.transition = `transform ${dur(380)}ms cubic-bezier(.3,.75,.3,1) ${dur(i * st)}ms`; });
    this.rack.layout(sorted);
    sfx('tick');
    await wait(400 + sorted.reduce((m, id, i) => (id == null ? m : i), 0) * st);
    this.rack.els.forEach(el => { el.style.transition = ''; });
    // the okeys turn upside down last
    const okeys = hand.filter(id => isOkey(id, okey));
    if (okeys.length) { this.rack.turnOkeys(okeys); sfx('flip'); await wait(340); }
  }

  // The gösterge you forgot: classic only, my own first turn, I held the other copy and never showed it.
  // Only ever about my own hand (a bot's forgetting would leak its tiles), once a round.
  forgotCopy(v) {
    const r = v && v.round, me = v && v.you;
    if (this.is101 || !r || me == null || !v.hand || !r.firstTurn || !r.firstTurn[me] || (v.seats[me] || {}).showedIndicator || this.sadRound === this.roundKey) return null;
    const c = v.hand.find(x => x !== r.indicator && x < 104 && color(x) === color(r.indicator) && num(x) === num(r.indicator));
    return c == null ? null : c;
  }
  // a small sad moment: the copy goes grey-blue and droops, a "wah-wah", a gentle toast
  sadMoment(id, discarded) {
    this.sadRound = this.roundKey;
    if (id === discarded) { const el = this.discTop(0); if (el) { el.classList.add('sad'); setTimeout(() => el.classList.remove('sad'), 2700); } }
    else { this.rack.sad = id; this.rack.render(); setTimeout(() => { if (this.rack.sad === id) { this.rack.sad = null; this.rack.render(); } }, 2700); }
    sfx('wah');
    toast(esc(t('sad.forgot')), 'sad', 3200);
  }

  showIndicatorFx(ev, animate) {
    const p = this.pos(ev.seat), el = $(`.seat.p${p}`, this.root);
    const s = this.view.seats[ev.seat] || {};
    toast(t('toast.showed', { name: esc(s.name || '') }), '', 2600);
    if (!animate) return;
    const b = $('.bub', el);
    b.innerHTML = `<span class="showtile">${tileHTML(ev.tile, null)}</span>`; b.className = 'bub on show';
    sfx('flip');
    return wait(1300).then(() => { b.className = 'bub'; b.innerHTML = ''; });
  }

  async scoreFx(ev) {
    const story = !$('#result', this.root).hidden;
    for (let p = 0; p < 4; p++) {
      const seat = this.seatAt(p), dlt = ev.deltas[seat]; if (!dlt) continue;
      const el = $(`.seat.p${p} .plate`, this.root);
      if (story) { $('.sc', el).textContent = ev.scores[seat]; continue; }
      const bad = this.is101 ? dlt > 0 : dlt < 0;
      const f = document.createElement('b'); f.className = 'delta ' + (bad ? 'neg' : 'pos'); f.textContent = (dlt > 0 ? '+' : '−') + Math.abs(dlt);
      el.appendChild(f); setTimeout(() => f.remove(), dur(1800) || 50);
      $('.sc', el).textContent = ev.scores[seat];
    }
    await wait(300);
  }

  // Someone finished: the finishing tile goes to the middle with a gold glow, then their rack tilts up and shows the hand.
  async finishFx(ev, next) {
    closeGuide(false);
    this.forgotFin = ev.seat === next.you && this.forgotCopy(this.view) != null;
    // tier 2: an okey finish or a pairs finish slams; tier 3: pairs and an okey together slams twice
    const tier = ev.kind === 'pairs' && ev.okeyFinish ? 3 : ev.okeyFinish || ev.kind === 'pairs' ? 2 : 1;
    this.slamTier = tier > 1 ? tier : 0;
    if (tier > 1) { const t0 = performance.now(); try { await this.slam(ev, next, tier); } catch (e) { console.error(e); } if (globalThis.__okeyFlights) globalThis.__okeyFlights.push([t0, performance.now()]); }
    else sfx('settle');
    this.view = next;
    await this.showResult(true, ev);
  }

  // The SLAM. The finishing tile rises over the middle, holds a beat and smashes down: the table shakes, a shockwave
  // rings out, felt dust flies, every tile jumps, the pile rattles, a deep wooden thud; then the headline and a stamped
  // multiplier. Full force for me, ~70% for someone else (their tile flies over from their rack first). Speed trims
  // the hold, never the impact; reduced motion gets a static banner and the sound; a tap skips to the story.
  async slam(ev, next, tier) {
    const mine = ev.seat === next.you, k = mine ? 1 : 0.7, okey = next.round && next.round.okey;
    const mult = this.is101 ? (ev.multiplier || (tier === 3 ? 4 : 2)) : tier === 3 ? 4 : 2;
    const head = t(tier === 3 ? 'slam.both' : ev.okeyFinish ? 'slam.okey' : 'slam.pairs');
    const cr = $('.center', this.root).getBoundingClientRect(), C = { x: cr.left + cr.width / 2, y: cr.top + cr.height / 2 };
    const fr = this.felt.getBoundingClientRect();
    const layer = document.createElement('div'); layer.className = 'slam' + (tier === 3 ? ' t3' : ''); document.body.appendChild(layer);
    this.slamLayer = layer; this.slamming = true;
    const raw = ms => (skipped() ? 0 : ms);                       // the impact keeps its pace at any speed
    const buzzP = p => { try { if (S.settings.haptics && navigator.vibrate) navigator.vibrate(p); } catch { /* not supported */ } };
    const headline = () => {
      const h = document.createElement('div'); h.className = 'slamhead';
      h.style.left = C.x + 'px'; h.style.top = Math.max(fr.top + 40, C.y - Math.min(110, cr.height * 0.42)) + 'px';
      h.innerHTML = `<b>${esc(head)}</b><span class="stamp">×${mult}</span>`;
      layer.appendChild(h); return h;
    };
    try {
      if (reduced()) {
        headline(); sfx('thud', { level: k }); if (tier === 3) sfx('ooh'); if (mine) buzzP([30, 40, 60]);
        if (!document.documentElement.classList.contains('noanim')) await sleep(raw(1400));
        return;
      }
      const S0 = Math.round(Math.min(84, Math.max(46, this.dw * 1.7)) * (mine ? 1 : 0.9)), SH = S0 * 1.5;
      const src = mine ? (this.finFrom || this.rack.tileGeom(ev.tile)) : this.oppTake(this.pos(ev.seat));
      if (mine) this.rack.hide(ev.tile, true);
      this.finFrom = null;
      const tile = document.createElement('div');
      tile.className = 'slamtile ' + tileClass(ev.tile, okey);
      tile.innerHTML = tileInner(ev.tile);
      tile.style.cssText = `--tw:${S0}px;left:${C.x - S0 / 2}px;top:${C.y - SH / 2}px`;
      layer.appendChild(tile);
      const from = src ? `translate(${src.cx - C.x}px,${src.cy - C.y}px) rotate(${src.rot || 0}deg) scale(${(src.w || S0) / S0})` : 'translate(0,40px) scale(.6)';
      const H = Math.min(120, cr.height * 0.45 + 30) * (0.75 + 0.25 * k);
      const up = (h, s, r) => `translate(0px,${-h}px) rotate(${r}deg) scale(${s})`;
      // rise (and, for someone else, the flight over from their rack)
      await tile.animate([{ transform: from, opacity: 0.4 }, { transform: up(H, 1.12, -5), opacity: 1 }], { duration: dur(mine ? 420 : 560), easing: 'cubic-bezier(.2,.8,.3,1)', fill: 'forwards' }).finished.catch(() => {});
      const smash = async (h, s, hold, ms, level, last) => {
        // the beat: it winds up, trembling
        await tile.animate([{ transform: up(h, 1.12, -5) }, { transform: up(h + 6, s, -7), offset: 0.5 }, { transform: up(h + 10, s * 1.02, -6) }],
          { duration: dur(hold), easing: 'ease-in-out', fill: 'forwards' }).finished.catch(() => {});
        await tile.animate([{ transform: up(h + 10, s * 1.02, -6) }, { transform: 'translate(0px,0px) rotate(0deg) scale(1)' }],
          { duration: raw(ms), easing: 'cubic-bezier(.6,0,1,.6)', fill: 'forwards' }).finished.catch(() => {});
        this.impact(C, level * k, last && tier === 3, raw);
        if (mine) buzzP(last ? [30, 40, 60] : [24]); else if (last) buzzP([16]);
      };
      if (tier === 3) {
        await smash(H * 0.7, 1.14, 260, 160, 0.65, false);
        await tile.animate([{ transform: 'translate(0px,0px) rotate(0deg) scale(1)' }, { transform: up(H * 1.15, 1.12, -5) }], { duration: raw(330), easing: 'cubic-bezier(.2,.8,.3,1)', fill: 'forwards' }).finished.catch(() => {});
        await smash(H * 1.15, 1.2, 240, 120, 1.25, true);
      } else await smash(H, 1.18, 320, 140, 1, true);
      // the headline lands with the hit, then the multiplier is stamped on
      const h = headline();
      h.querySelector('b').animate([{ transform: 'scale(2.2)', opacity: 0 }, { transform: 'scale(.94)', opacity: 1, offset: 0.7 }, { transform: 'scale(1)', opacity: 1 }], { duration: raw(380), easing: 'cubic-bezier(.3,0,.3,1)', fill: 'both' });
      const stamp = h.querySelector('.stamp');
      stamp.animate([{ transform: 'rotate(-14deg) scale(2.6)', opacity: 0 }, { transform: 'rotate(-14deg) scale(.92)', opacity: 1, offset: 0.75 }, { transform: 'rotate(-14deg) scale(1)', opacity: 1 }],
        { duration: raw(240), delay: raw(tier === 3 ? 420 : 340), easing: 'cubic-bezier(.5,0,.8,.6)', fill: 'both' });
      sleep(raw(tier === 3 ? 600 : 520)).then(() => { if (!skipped()) { sfx('thud', { level: 0.35 }); this.felt.animate([{ translate: '0 0' }, { translate: '0 2px' }, { translate: '0 0' }], { duration: 120 }); } });
      await sleep(dur(tier === 3 ? 1500 : 1050) + raw(300));
      // clear the stage; the tile stays for the reveal to pick up
      h.animate([{ opacity: 1 }, { opacity: 0, transform: 'translateY(-10px)' }], { duration: dur(220), fill: 'forwards' });
      this.slamAt = { cx: C.x, cy: C.y, w: S0, h: SH, rot: 0 };
      await sleep(dur(200));
    } finally {
      this.slamming = false; setSkip(false);
    }
  }
  // the hit: shake, shockwave, felt dust, every tile on the table jumps, the pile rattles, the thud
  impact(C, level, big, raw) {
    const layer = this.slamLayer; if (!layer) return;
    sfx('thud', { level: Math.min(1.2, level) });
    if (big) sfx('ooh');
    const A = 7 * level, n = big ? 9 : 7, steps = [];
    for (let i = 0; i <= n; i++) { const a = A * (1 - i / n) ** 1.6, s = i % 2 ? 1 : -1; steps.push({ translate: i === n ? '0 0' : `${s * a * 0.6}px ${a * (i % 3 === 0 ? 1 : -0.7)}px` }); }
    $('.tbl', this.root).animate(steps, { duration: raw(big ? 440 : 260), easing: 'linear' });
    for (let w = 0; w < (big ? 2 : 1); w++) {
      const ring = document.createElement('div'); ring.className = 'shock'; ring.style.left = C.x + 'px'; ring.style.top = C.y + 'px';
      ring.style.setProperty('--r', Math.round(150 * Math.min(1.3, level) + w * 60) + 'px'); layer.appendChild(ring);
      ring.animate([{ transform: 'translate(-50%,-50%) scale(.1)', opacity: 0.95 }, { transform: 'translate(-50%,-50%) scale(1)', opacity: 0 }], { duration: raw(560 + w * 140), delay: raw(w * 110), easing: 'cubic-bezier(.1,.7,.3,1)', fill: 'both' })
        .finished.then(() => ring.remove(), () => ring.remove());
    }
    const dust = Math.round(14 + 10 * level);
    for (let i = 0; i < dust; i++) {
      const d = document.createElement('i'); d.className = 'dust' + (i % 3 ? '' : ' cream'); d.style.left = C.x + 'px'; d.style.top = C.y + 'px';
      layer.appendChild(d);
      const a = Math.random() * Math.PI * 2, r = (40 + Math.random() * 90) * Math.min(1.3, level), dx = Math.cos(a) * r, dy = Math.sin(a) * r * 0.6;
      d.animate([{ transform: 'translate(-50%,-50%) scale(1)', opacity: 0.9 }, { transform: `translate(calc(-50% + ${dx * 0.7}px),calc(-50% + ${dy * 0.7 - 18}px)) scale(.9)`, opacity: 0.8, offset: 0.5 },
        { transform: `translate(calc(-50% + ${dx}px),calc(-50% + ${dy + 6}px)) scale(.4)`, opacity: 0 }], { duration: raw(520 + Math.random() * 260), easing: 'cubic-bezier(.2,.7,.4,1)', fill: 'both' })
        .finished.then(() => d.remove(), () => d.remove());
    }
    // everything on the table hops (racks tile by tile; the pile's stacks rattle)
    const hop = (el, h, delay) => el.animate([{ translate: '0 0' }, { translate: `0 ${-h}px`, offset: 0.35 }, { translate: '0 1px', offset: 0.75 }, { translate: '0 0' }], { duration: raw(260), delay: raw(delay), easing: 'ease-out', composite: 'add' });
    $$('.rack .rt', this.root).forEach(el => hop(el, (2 + Math.random() * 3) * level, Math.random() * 50));
    $$('.orack, .ds .dstack, .indt, .okt', this.root).forEach(el => hop(el, 2.5 * level, Math.random() * 40));
    $$('#pile .pst', this.root).forEach(el => el.animate([{ rotate: '0deg' }, { rotate: `${(Math.random() - 0.5) * 8 * level}deg`, translate: `0 ${-2 * level}px` }, { rotate: `${(Math.random() - 0.5) * 4}deg` }, { rotate: '0deg' }], { duration: raw(320), delay: raw(Math.random() * 60) }));
    if (big) {
      const fl = document.createElement('div'); fl.className = 'slamflash'; layer.appendChild(fl);
      fl.animate([{ opacity: 0 }, { opacity: 1, offset: 0.15 }, { opacity: 0 }], { duration: raw(900), fill: 'both' }).finished.then(() => fl.remove(), () => fl.remove());
      Sparks.burst(70, C.x, C.y);
    } else if (level >= 0.9) Sparks.burst(22, C.x, C.y);
  }
  endSlam() { if (this.slamLayer) { this.slamLayer.remove(); this.slamLayer = null; } this.slamAt = null; }

  // ---- the result: the winner's rack tilts up, tiles turn over group by group, then the story ----
  async showResult(animate, ev) {
    const v = this.view; if (!v.result) return;
    const key = resultKey(v);
    if (this.resultShown === key) return;
    this.resultShown = key;
    closeGuide(false);
    const r = v.result, el = $('#result', this.root), story = this.is101 ? story101(v) : storyOf(v);
    const win = r.winner != null ? v.seats[r.winner] : null;
    const okey = v.round && v.round.okey;
    const isMatch = v.phase === 'matchEnd';
    el.innerHTML = `<div class="rv-card ${story.cls}">
      ${win ? `<div class="rv-who"><span class="av">${esc(win.avatar || '🙂')}</span><b>${esc(win.name || '')}</b></div>
      <div class="rv-rack"><div class="rv-groups">${handGroupsHTML(v)}</div>
        <div class="rv-fin"><small>${t('result.finishTile')}</small>${tileHTML(r.tile, okey, 'rv fin')}</div></div>` : ''}
      <div class="rhead"><div class="rverd">${esc(story.v)}</div><div class="rline">${esc(story.line)}${story.extra ? ' ' + esc(story.extra) : ''}</div>${this.forgotFin && r.winner === v.you ? `<div class="rsad">${esc(t('sad.note'))}</div>` : ''}</div>
      ${this.is101 ? rows101(v) : deltasHTML(v)}
      <div class="rv-acts">
        ${isMatch ? `<button class="btn" id="rvHome">${t('result.leave')}</button><button class="btn gold" id="rvNext">${t('result.rematch')}</button>`
          : `<button class="btn ghost" id="rvHands">${t('result.allHands')}</button><button class="btn gold" id="rvNext">${t('result.next')}</button>`}
      </div></div>`;
    el.hidden = false;
    this.felt.classList.add('resulting');
    const nextBtn = $('#rvNext', el);
    nextBtn.onclick = () => { nextBtn.disabled = true; nextBtn.textContent = t('result.waiting'); this.ctx.send({ t: 'next' }); };
    const home = $('#rvHome', el); if (home) home.onclick = () => this.ctx.leave();
    const hands = $('#rvHands', el); if (hands) hands.onclick = () => this.showAllHands();
    recordRound(v, this.ctx.solo);
    const card = $('.rv-card', el);
    const won = r.winner === v.you;
    if (animate && !reduced()) {
      // the winner's tiles leave their rack and fly into the card, set by set; the finishing tile comes last, in gold
      const tiles = $$('.rv-groups .tile', el), finEl = $('.rv-fin .tile', el), fin = $('.rv-fin', el), rest = $$('.rhead,.deltas,.rv-acts', el);
      [...tiles, finEl].forEach(x => { if (x) x.style.visibility = 'hidden'; });
      if (fin) fin.style.opacity = '0';
      rest.forEach(x => { x.style.opacity = '0'; });
      const rackEl = $('.rv-rack', el);
      if (rackEl) await rackEl.animate([{ opacity: 0, transform: 'translateY(8px) scale(.97)' }, { opacity: 1, transform: 'none' }], { duration: dur(260), easing: 'ease-out' }).finished.catch(() => {});
      const wp = r.winner != null ? this.pos(r.winner) : null, mine = r.winner === v.you;
      const okey = v.round && v.round.okey;
      const src = id => {
        if (mine) { const rr = this.rack.tileRect(id); if (rr) { this.rack.hide(id, true); return rectGeo(rr); } return this.discGeom(0); }
        return wp ? this.oppTake(wp) : this.pileGeom();
      };
      const flights = [];
      let k = 0;
      $$('.rv-groups .rg', el).forEach((g, gi) => {
        $$('.tile', g).forEach(x => {
          const id = +x.dataset.id, from = src(id), to = geomOf(x);
          flights.push(fly({ id, okey, from, to, faceFrom: mine, faceTo: true, flipAt: 'early', ms: 380, arc: 0.2, delay: k * 42 + gi * 70,
            onLand: () => { x.style.visibility = ''; if (k % 2) sfx('clack', { level: 0.45, pitch: 1.1 }); } }));
          k++;
        });
      });
      if (finEl) {
        if (fin) fin.style.opacity = '';
        const slamAt = this.slamAt, from = slamAt || src(r.tile);
        flights.push(fly({ id: r.tile, okey, from, to: geomOf(finEl), faceFrom: mine || !!slamAt, faceTo: true, onLaunch: () => this.endSlam(), flipAt: 'early', ms: 440, arc: 0.3, cls: 'golden', delay: k * 42 + 160,
          onLand: () => { finEl.style.visibility = ''; land(finEl, 1.4); sfx('clack'); } }));
      }
      await Promise.all(flights);
      this.pendingDiscard = null;
      await wait(200);
      rest.forEach((x, i) => { x.style.opacity = ''; x.animate([{ transform: 'translateY(10px)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: dur(320), delay: dur(i * 120), fill: 'backwards' }); });
    }
    void card;
    this.endSlam();
    if (r.winner != null) {
      const big = r.okeyFinish || r.kind === 'pairs' || r.elden || (r.multiplier || 1) > 1;
      if (this.slamTier) { if (won) tipNote(true); }   // the slam was the celebration
      else if (won) {
        tipNote(true);
        if (!isMatch) celebrate(big ? story.v : t('cele.win'), big ? t('cele.bigSub') : t('cele.winSub'), { sound: r.okeyFinish ? 'okey' : 'win', sparks: big ? 60 : 30 });
      } else if (big && !isMatch) {
        // someone else's okey / pairs / elden finish still deserves a small flourish
        banner(story.v, t(r.elden ? 'cele.elden' : r.okeyFinish ? 'cele.okeyFinish' : 'cele.pairsFinish'), 'gold small', 1900);
        Sparks.burst(16); sfx('chime');
      } else sfx('lose');
    }
    if (isMatch) {
      await wait(900);
      const pick = this.is101 ? Math.min : Math.max, top = pick(...v.seats.map(s => s.score));
      const winners = (ev && ev.winners) || v.winners || v.seats.map((s, i) => i).filter(i => v.seats[i].score === top);
      const iWon = winners.includes(v.you);
      recordMatch(v, iWon, this.ctx.solo);
      if (iWon) { celebrate(t('cele.champion'), t('cele.championSub'), { sound: 'fanfare', sparks: 90 }); tipNote(true); }
      else celebrate(t('cele.theyChampion', { name: winners.map(i => v.seats[i].name).join(' & ') }), t('cele.matchOver'), { sound: 'win', sparks: 40 });
      await wait(2300);   // the banner first, then the standings (never one over the other)
      clearBanners();
      this.showPodium();
    }
    tipCheck();
  }
  hideResult() {
    this.endSlam(); this.slamTier = 0;
    const el = $('#result', this.root); el.hidden = true; el.innerHTML = '';
    this.felt.classList.remove('resulting');
  }
  showAllHands() {
    const v = this.view, r = v.result; if (!r || !r.hands) return;
    const okey = v.round && v.round.okey;
    sheet(`<h2>${t('result.allHands')}</h2>${v.seats.map((s, i) => `<h3>${esc(s.avatar || '')} ${esc(s.name)}${i === r.winner ? ' · ' + t('result.winner') : ''}</h3>
      <div class="handrow">${(i === r.winner && r.groups ? r.groups.flat() : (r.hands[i] || [])).map(id => tileHTML(id, okey, 'sm')).join('')}</div>`).join('')}`, { cls: 'hands' });
  }
  showPodium() {
    const v = this.view;
    sheet(`<h2>${t('podium.title')}</h2>${podiumHTML(v, this.is101)}${this.is101 ? `<p class="muted small center">${t('podium.lowWins')}</p>` : ''}
      <div class="row"><button class="btn" id="pdHome">${t('result.leave')}</button><button class="btn gold" id="pdAgain">${t('result.rematch')}</button></div>`, { cls: 'podsheet' });
    // confetti over the podium, the winner's step shines
    const st = $('.podium .pd.p0 .step');
    if (st && !reduced()) {
      const b = st.getBoundingClientRect(); Sparks.burst(48, b.left + b.width / 2, b.top);
      st.animate([{ filter: 'brightness(1)' }, { filter: 'brightness(1.35)' }, { filter: 'brightness(1)' }], { duration: dur(1400), iterations: 2 });
      $$('.podium .pd').forEach((pd, i) => pd.animate([{ transform: 'translateY(24px)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: dur(420), delay: dur([200, 0, 380][i] || 0), fill: 'backwards', easing: 'cubic-bezier(.2,.9,.3,1.2)' }));
    }
    $('#pdHome').onclick = () => { closeSheet(); this.ctx.leave(); };
    $('#pdAgain').onclick = () => { closeSheet(); const b = $('#rvNext', this.root); if (b && !b.disabled) b.click(); };
  }

  // ---- emotes ----
  sendEmote(id) {
    this.hideEmotes();
    const now = Date.now(); if (now - this.lastEmote < 1500) return;
    this.lastEmote = now;
    this.ctx.send({ t: 'emote', id });
  }
  emote(seat, id) {
    const e = EMOTES.find(x => x.id === id); if (!e) return;
    const p = this.pos(seat), b = $(`.seat.p${p} .bub`, this.root); if (!b) return;
    b.innerHTML = e.e ? `<span class="em">${e.e}</span>` : `<span class="tx">${esc(t(e.k))}</span>`;
    b.className = 'bub on'; sfx('pop');
    clearTimeout(b._t); b._t = setTimeout(() => { b.className = 'bub'; }, 2200);
  }
}

// ---- helpers ----
function dispFrom(v) {
  return {
    count: v.seats.map(s => s.handCount || 0),
    disc: v.seats.map(s => ({ top: s.discard ? s.discard.top : null, count: s.discard ? s.discard.count : 0 })),
    pile: v.round ? v.round.pileCount : 0,
  };
}
// The drawer may get a public copy (no tile) and a private copy (with the tile) of the same draw: keep one.
function dedupe(events, you) {
  const out = [];
  for (const e of events || []) {
    const last = out[out.length - 1];
    if (e.type === 'draw' && last && last.type === 'draw' && last.seat === e.seat && last.from === e.from) {
      if (e.tile != null && e.seat === you) out[out.length - 1] = e;
      continue;
    }
    out.push(e);
  }
  return out;
}
const resultKey = v => `${v.code}.${v.round ? v.round.number : 0}.${v.phase}`;
function shiftPreview(slots, at, cols) {
  const s = slots.slice(), base = Math.floor(at / cols) * cols;
  for (let j = at + 1; j < base + cols; j++) if (s[j] == null) { for (let k = j; k > at; k--) s[k] = s[k - 1]; s[at] = null; return s; }
  return slots;
}
// geometry <-> rect, and the small stable rotations of tiles lying on the felt
function toGeo(x) { return !x ? null : x.geo ? x.geo : x.cx != null ? x : rectGeo(x); }
function rectGeo(r, rot = 0) { return r ? { cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: r.width, h: r.height, rot } : null; }
function geoRect(g) { return g ? { left: g.cx - g.w / 2, top: g.cy - g.h / 2, width: g.w, height: g.h } : null; }
function tileRot(id) { return (((id * 37 + 11) % 13) - 6) * 0.55; }              // -3.3° … 3.3°, the same for a tile every time
function layerRot(p, i) { return ((((p * 7 + i * 5) % 9) - 4) * 0.8); }
