// The table: felt, your ıstaka at the bottom, opponents left/top/right, the pile and the indicator in the middle,
// each seat's discard stack at its right (the four corners). Renders views, plays events as animations.
import { t } from './i18n.js';
import { EMOTES, BOT_AVATAR } from './config.js';
import { $, $$, esc, toast, sheet, closeSheet, celebrate, banner, clearBanners } from './ui.js';
import { sfx } from './sound.js';
import { Rack, layoutFromGroups } from './rack.js';
import { tileHTML, tileClass, tileInner, faceHTML, okeyFace, color, num, finishCheck, arrange, loadEngine, getEngine } from './tiles.js';
import { flyTile, flyStack, flipOver, settle, wait, dur, rectOf, reduced, shake, pulse } from './anim.js';
import { storyOf, deltasHTML, handGroupsHTML, podiumHTML } from './result.js';
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
    this.onResize = () => this.layout();
    addEventListener('resize', this.onResize);
  }
  destroy() { clearInterval(this.timer); removeEventListener('resize', this.onResize); this.root.innerHTML = ''; clearBanners(); }

  // relative position: 0 me (bottom), 1 right, 2 top, 3 left
  pos(seat) { const you = this.view && this.view.you != null ? this.view.you : 0; return (seat - you + 4) % 4; }
  seatAt(p) { const you = this.view && this.view.you != null ? this.view.you : 0; return (you + p) % 4; }

  mount() {
    const seat = p => `<div class="seat p${p}" data-p="${p}">
        <div class="plate"><div class="av"><svg class="ring" viewBox="0 0 44 44" aria-hidden="true"><circle class="rbg" cx="22" cy="22" r="20"/><circle class="rfg" cx="22" cy="22" r="20" stroke-dasharray="${RING}" stroke-dashoffset="0"/></svg><span class="emo"></span><b class="secs"></b></div>
        <div class="meta"><div class="nm"></div><div class="sub"><span class="sc"></span><span class="tag"></span></div></div></div>
        <div class="mrack" aria-hidden="true"></div><div class="bub" aria-live="polite"></div></div>`;
    const ds = p => `<div class="ds d${p}" data-p="${p}"><div class="dstack"></div><span class="dn"></span>${p === 0 ? `<span class="dlbl">${t('table.discardHere')}</span>` : p === 3 ? `<span class="dlbl">${t('table.takeHere')}</span>` : ''}</div>`;
    this.root.innerHTML = `<section class="tbl" id="tbl">
      <div class="felt" id="felt">
        <div class="placard" aria-hidden="true"></div>
        ${seat(2)}${seat(3)}${seat(1)}
        ${ds(2)}${ds(1)}${ds(3)}${ds(0)}
        <div class="center">
          <div class="cring" aria-hidden="true"></div>
          <button class="pile" id="pile" aria-label="${esc(t('table.pile'))}"><span class="pstack"></span><span class="pcount"></span></button>
          <div class="ind" id="ind"><div class="indt"></div><small>${t('table.indicator')}</small></div>
          <div class="okeyis" id="okeyis" hidden><small>${t('table.okey')}</small><div class="okt"></div></div>
          <div class="fz" id="fz" aria-hidden="true"><span></span></div>
        </div>
        <div class="status" id="status" role="status" aria-live="polite"></div>
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
      onDragStart: () => this.hideEmotes(),
    });
    $('#bRuns', r).onclick = () => { this.rack.arrange('runs'); };
    $('#bPairs', r).onclick = () => { this.rack.arrange('pairs'); };
    $('#bShow', r).onclick = () => this.act({ type: 'showIndicator' });
    $('#bEmote', r).onclick = e => { e.stopPropagation(); const p = $('#emotes', r); p.hidden = !p.hidden; };
    $('#emotes', r).onclick = e => { const b = e.target.closest('button'); if (b) this.sendEmote(b.dataset.e); };
    r.addEventListener('pointerdown', e => { if (!e.target.closest('#emotes,#bEmote')) this.hideEmotes(); });
    // drawing: tap or drag the pile / the left discard
    this.wireDrawSource($('#pile', r), 'pile');
    this.wireDrawSource($('.ds.d3', r), 'discard');
    // tap targets for a selected tile
    $('.ds.d0', r).addEventListener('click', () => { const id = this.rack.selected; if (id != null && this.can('discard')) this.discardFrom(id, this.rack.tileRect(id)); });
    $('#fz', r).addEventListener('click', () => { const id = this.rack.selected; if (id != null && this.can('discard')) this.tryFinish(id, this.rack.tileRect(id)); });
    this.layout();
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
    if (!land) {
      const byW = (W - 8 - 14 - 12) / 13;
      const byH = (H * 0.31 - 16) / 3.3;
      tw = Math.floor(Math.min(byW, byH, 52));
    } else {
      const byW = (W * (wide ? 0.5 : 0.56)) / 13;
      const byH = (H * (wide ? 0.27 : 0.33) - 14) / 3.3;
      tw = Math.floor(Math.min(byW, byH, 60));
    }
    tw = Math.max(20, tw);
    const gap = tw >= 34 ? 2 : 1;
    this.rack.setSize(tw, gap);
    const dw = Math.round(Math.max(24, Math.min(land ? tw * 0.98 : tw * 1.18, wide ? 50 : 38, H / 13)));
    this.felt.style.setProperty('--dw', dw + 'px');
    this.felt.style.setProperty('--tw', tw + 'px');
    this.felt.style.setProperty('--bw', Math.round(Math.max(7, dw * (wide ? 0.42 : 0.36))) + 'px');
  }

  // ---- incoming ----
  async update(view, events = []) {
    const prev = this.view;
    this.offset = (view.now || Date.now()) - Date.now();
    const evs = dedupe(events, view.you);
    const animate = (prev ? true : evs.length && evs[0].type === 'roundStart') && evs.length && evs.length <= 8 && !reduced() && document.visibilityState === 'visible';
    this.view = view;
    if (!prev || !animate) {
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
    }
    if ((v.phase === 'roundEnd' || v.phase === 'matchEnd') && v.result && this.resultShown !== resultKey(v)) this.showResult(false);
    if (v.phase === 'playing' && !$('#result', this.root).hidden) this.hideResult();
  }

  newRound(view) {
    const r = view.round; if (!r) return;
    this.roundKey = `${view.code}.${r.number}`;
    if (view.hand) {
      const restored = this.rack.restore(this.roundKey, view.hand);
      if (!restored) this.rack.layout(layoutFromGroups(arrange(view.hand, r.okey, 'runs')));
    }
    this.rack.setOkey(r.okey);
    this.resultShown = null; this.hideResult();
  }

  quietEvent(e) {
    if (e.type === 'showIndicator') this.showIndicatorFx(e, false);
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
      $('.tag', el).textContent = s.kind === 'bot' ? t('level.' + ((s.bot || {}).level || 'kalfa')) : s.away ? t('table.away') : (s.kind === 'human' && !s.connected) ? t('table.offline') : '';
      if (p) this.setMiniRack(p, d.count[seat]);
      this.setDiscard(p, d.disc[seat]);
    }
    this.setPile(d.pile);
    this.setIndicator(r ? r.indicator : null);
    this.renderPlacard();
    this.status();
    this.buttons();
    if (v.hand) {
      const hand = this.pendingDiscard != null ? v.hand.filter(x => x !== this.pendingDiscard) : v.hand;
      const prefer = new Map(); if (this.drawSlot >= 0) hand.forEach(id => { if (!this.rack.slots.includes(id)) prefer.set(id, this.drawSlot); });
      this.rack.sync(hand, prefer); this.drawSlot = -1;
    } else this.rack.sync([]);
    $('#rack', root).hidden = v.you == null;
    this.tick();
  }

  renderPlacard() {
    const v = this.view, r = v.round, pl = $('.placard', this.root);
    pl.innerHTML = `<div class="pl1"><b>${this.ctx.solo ? t('placard.practice') : t('placard.table', { code: esc(v.code) })}</b><span class="led">${r ? t('placard.round', { n: r.number }) : ''}</span></div>
      <div class="pl2"><span>${v.settings && v.settings.turnSeconds ? t('placard.turn', { s: v.settings.turnSeconds }) : t('placard.noClock')}</span><span class="led g">${v.settings && v.settings.rounds ? t('placard.rounds', { n: v.settings.rounds }) : t('placard.toZero')}</span></div>`;
  }

  setMiniRack(p, n) {
    const el = $(`.seat.p${p} .mrack`, this.root);
    if (el.childElementCount !== n) el.innerHTML = '<i></i>'.repeat(Math.max(0, n));
  }
  setDiscard(p, st) {
    const el = $(`.ds.d${p}`, this.root), box = $('.dstack', el);
    const top = st ? st.top : null, n = st ? st.count : 0;
    box.style.setProperty('--n', Math.min(n, 8));
    const okey = this.view.round && this.view.round.okey;
    const html = top != null ? `<div class="${tileClass(top, okey)} dtop" data-id="${top}">${tileInner(top)}</div>` : '';
    if (box.dataset.top !== String(top)) { box.innerHTML = html; box.dataset.top = String(top); }
    el.classList.toggle('empty', !n);
    $('.dn', el).textContent = n > 1 ? n : '';
  }
  setPile(n) {
    const el = $('#pile', this.root);
    $('.pcount', el).textContent = n;
    el.style.setProperty('--h', Math.max(0, Math.min(8, Math.ceil(n / 10))));
    el.classList.toggle('low', n > 0 && n <= 8);
    el.classList.toggle('none', !n);
  }
  setIndicator(id, faceDown = false) {
    const el = $('.indt', this.root), ok = $('#okeyis', this.root);
    ok.hidden = id == null || faceDown;
    if (id != null && !faceDown) { const f = okeyFace(id); const k = f.color + '.' + f.num; if (ok.dataset.k !== k) { ok.dataset.k = k; $('.okt', ok).innerHTML = faceHTML(f, 'okey'); } }
    if (id == null) { el.innerHTML = ''; el.dataset.id = ''; return; }
    if (el.dataset.id === String(id) + (faceDown ? 'b' : '')) return;
    el.dataset.id = String(id) + (faceDown ? 'b' : '');
    el.innerHTML = faceDown ? '<div class="tile back"></div>' : `<div class="${tileClass(id, null)}">${tileInner(id)}</div>`;
  }

  status() {
    const v = this.view, r = v.round, el = $('#status', this.root);
    let txt = '', cls = '';
    if (v.phase === 'playing' && r) {
      if (r.turn === v.you) {
        cls = 'me';
        txt = r.stage === 'draw' ? t('status.youDraw') : (r.firstTurn && r.firstTurn[v.you] && r.number && r.dealer === v.you && this.disp && this.disp.count[v.you] === 15 ? t('status.youStart') : t('status.youDiscard'));
      } else {
        const s = v.seats[r.turn] || {};
        txt = t('status.theyPlay', { name: esc(s.name || '') });
      }
    } else if (v.phase === 'roundEnd') txt = t('status.roundEnd');
    else if (v.phase === 'matchEnd') txt = t('status.matchEnd');
    el.innerHTML = txt; el.className = 'status ' + cls;
    const myTurn = v.phase === 'playing' && r && r.turn === v.you;
    this.felt.classList.toggle('can-draw', !!(myTurn && r.stage === 'draw'));
    this.felt.classList.toggle('can-discard', !!(myTurn && r.stage === 'discard'));
  }
  buttons() {
    const v = this.view, r = v.round, b = $('#bShow', this.root);
    const canShow = v.phase === 'playing' && r && v.you != null && r.firstTurn && r.firstTurn[v.you] && v.seats[v.you] && !v.seats[v.you].showedIndicator
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
      if (hurry && seat === v.you && s !== this.lastTock && s > 0) { this.lastTock = s; sfx('tock'); }
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
    this.ctx.send({ t: 'act', action, v: this.view.v });
  }
  error(code) {
    this.busy = false;
    if (this.pendingDiscard != null) { const id = this.pendingDiscard; this.pendingDiscard = null; this.rack.hide(id, false); }
    if (this.pendingDraw) { this.pendingDraw = null; }
    this.disp = dispFrom(this.view); this.render();
    sfx('error');
    toast(esc(t('err.' + code) !== 'err.' + code ? t('err.' + code) : t('err.generic')), 'err');
  }

  targetAt(x, y) {
    if (!this.can('discard')) return null;
    const inside = (el, pad = 10) => { if (!el) return false; const b = el.getBoundingClientRect(); return x >= b.left - pad && x <= b.right + pad && y >= b.top - pad && y <= b.bottom + pad; };
    if (inside($('.ds.d0', this.root), 14)) return 'discard';
    if (inside($('.center', this.root), 4)) return 'finish';
    return null;
  }
  hover(target, id) {
    const fz = $('#fz', this.root), d0 = $('.ds.d0', this.root);
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
    return false;
  }
  quickDiscard(id) { if (this.can('discard')) this.discardFrom(id, this.rack.tileRect(id)); }
  selectChanged(id) { this.felt.classList.toggle('picked', id != null); }

  discardFrom(id, fromRect) {
    if (!this.can('discard')) return false;
    this.pendingDiscard = id;
    this.rack.hide(id, true);
    const to = rectOf($('.ds.d0 .dstack', this.root));
    const okey = this.view.round.okey;
    this.act({ type: 'discard', tile: id });
    flyTile({ id, okey, from: fromRect, to, start: 'face', ms: 300, arc: 0.12, tilt: 8 }).then(() => {
      if (this.pendingDiscard === id) {
        const me = this.view.you;
        this.setDiscard(0, { top: id, count: (this.disp.disc[me].count || 0) + 1 });
        sfx('settle'); settle($('.ds.d0 .dtop', this.root));
      }
    });
    return true;
  }
  tryFinish(id, fromRect) {
    if (!this.can('discard')) return false;
    const res = this.finishFor(id);
    const engineSure = !!(getEngine() && getEngine().findFinish);
    if (!res && engineSure) { shake($('.center', this.root)); sfx('error'); toast(t('finish.cannot'), 'err'); return false; }
    const groups = res ? res.groups : this.rack.groups().map(g => g.filter(x => x !== id)).filter(g => g.length);
    this.pendingDiscard = id; this.rack.hide(id, true);
    const okey = this.view.round.okey;
    flyTile({ id, okey, from: fromRect, to: rectOf($('#pile', this.root)), start: 'face', ms: 360, cls: 'golden' });
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
      if (slot !== drag.slot) { drag.slot = slot; this.rack.preview = slot >= 0 && this.rack.slots[slot] != null ? shiftPreview(this.rack.slots, slot) : null; this.rack.render(); }
    });
    const end = (e, cancel) => {
      if (!drag || e.pointerId !== drag.pid) return;
      const d = drag; drag = null;
      try { el.releasePointerCapture(d.pid); } catch { /* ignore */ }
      if (d.ghost) {
        const gr = d.ghost.getBoundingClientRect(); d.ghost.remove();
        $('.ds.d3 .dtop', this.root) && $('.ds.d3 .dtop', this.root).classList.remove('lifted');
        if (this.rack.preview) { this.rack.slots = this.rack.preview; this.rack.preview = null; this.rack.render(); }
        if (cancel || d.slot < 0) { this.rack.render(); return; }
        this.drawSlot = d.slot; this.pendingDraw = { from, rect: { left: gr.left, top: gr.top, width: gr.width, height: gr.height } };
      } else if (cancel) return;
      this.draw(from);
    };
    el.addEventListener('pointerup', e => end(e, false));
    el.addEventListener('pointercancel', e => end(e, true));
  }
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
        const fromRect = ev.from === 'pile' ? rectOf($('#pile .pstack', this.root)) : rectOf($(`.ds.d${this.pos(prevSeat)} .dstack`, this.root));
        if (ev.from === 'discard') {
          const st = d.disc[prevSeat]; st.count = Math.max(0, st.count - 1);
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
          await flyTile({ id: tile, okey, from: (pd && pd.rect) || fromRect, to: this.rack.tileRect(tile), start: ev.from === 'pile' && !(pd && pd.rect) ? 'back' : 'face', ms: pd && pd.rect ? 160 : 420, arc: 0.18 });
          this.rack.hide(tile, false); sfx('tick'); settle(this.rack.els.get(tile), 0.6);
          d.count[me]++;
        } else {
          const to = rectOf($(`.seat.p${p} .mrack`, this.root));
          sfx('draw', {});
          await flyTile({ id: ev.from === 'discard' ? ev.tile : null, okey, from: fromRect, to: shrink(to, fromRect), start: ev.from === 'pile' ? 'back' : 'face', ms: 400, arc: 0.15 });
          d.count[ev.seat]++; this.setMiniRack(p, d.count[ev.seat]);
        }
        return;
      }
      case 'discard': {
        const p = this.pos(ev.seat), d = this.disp;
        const st = d.disc[ev.seat];
        if (ev.seat === me && this.pendingDiscard === ev.tile) {
          this.pendingDiscard = null;
          d.count[me]--; st.top = ev.tile; st.count++;
          await wait(120);
          return;
        }
        const to = rectOf($(`.ds.d${p} .dstack`, this.root));
        let from;
        if (ev.seat === me) { from = this.rack.tileRect(ev.tile); this.rack.hide(ev.tile, true); }
        else { const mr = rectOf($(`.seat.p${p} .mrack`, this.root)); from = shrink(mr, to); }
        await flyTile({ id: ev.tile, okey, from, to, start: ev.seat === me ? 'face' : 'back', ms: 440, arc: 0.25, tilt: p === 1 ? -14 : 14 });
        d.count[ev.seat] = Math.max(0, d.count[ev.seat] - 1); st.top = ev.tile; st.count++;
        if (p) this.setMiniRack(p, d.count[ev.seat]);
        this.setDiscard(p, st); sfx('settle'); settle($(`.ds.d${p} .dtop`, this.root));
        return;
      }
      case 'showIndicator': return this.showIndicatorFx(ev, true);
      case 'finish': return this.finishFx(ev, next);
      case 'pileEmpty': toast(t('toast.pileEmpty'), '', 2600); await wait(500); return;
      case 'score': return this.scoreFx(ev, next);
      case 'matchEnd': return;
      default: return;
    }
  }

  // The deal: a quick shuffle, stacks of five fly to every rack, your tiles land slot by slot, the indicator turns.
  async deal(ev, next) {
    this.dealing = true;
    this.view = next;
    this.newRound(next);
    const d = { count: [0, 0, 0, 0], disc: [0, 1, 2, 3].map(() => ({ top: null, count: 0 })), pile: 106 };
    this.disp = d;
    const hand = next.hand || [];
    hand.forEach(id => this.rack.hide(id, true));
    this.render();
    this.setIndicator(null);
    this.setPile(106);
    hand.forEach(id => this.rack.hide(id, true));
    const pile = $('#pile', this.root);
    sfx('shuffle');
    pile.classList.add('shuffling');
    await wait(650);
    pile.classList.remove('shuffling');
    const from = rectOf($('#pile .pstack', this.root));
    const order = this.rack.slots.filter(x => x != null);
    let shown = 0;
    const flights = [];
    let k = 0;
    for (let pass = 0; pass < 3; pass++) {
      for (let i = 0; i < 4; i++) {
        const seat = (ev.dealer + i) % 4, p = this.pos(seat);
        const n = pass < 2 ? 5 : (seat === ev.dealer ? 5 : 4);
        const to = p === 0 ? rectOf($('#rack', this.root)) : rectOf($(`.seat.p${p} .mrack`, this.root));
        const delay = k * 95; k++;
        flights.push(flyStack({ from, to, n, ms: 330, delay, vertical: p === 1 || p === 3 }).then(() => {
          d.count[seat] += n; d.pile -= n; this.setPile(d.pile); sfx('deal');
          if (p) this.setMiniRack(p, d.count[seat]);
          else if (next.you != null) {
            const batch = order.slice(shown, shown + n); shown += n;
            batch.forEach((id, j) => setTimeout(() => { this.rack.hide(id, false); const el = this.rack.els.get(id); if (el && !reduced()) el.animate([{ transform: el.style.transform + ' translateY(-10px) scale(1.15)', opacity: 0 }, { transform: el.style.transform, opacity: 1 }], { duration: dur(200), easing: 'cubic-bezier(.2,.9,.3,1.3)' }); }, dur(j * 40)));
          }
        }));
      }
    }
    await Promise.all(flights);
    await wait(260);
    order.forEach(id => this.rack.hide(id, false));
    // the indicator comes off the pile and turns over
    const ind = $('.indt', this.root);
    this.setIndicator(ev.indicator, true);
    await flyTile({ id: null, from: rectOf($('#pile .pstack', this.root)), to: rectOf(ind), ms: 360, arc: 0.3 });
    d.pile = ev.pileCount; this.setPile(d.pile);
    sfx('flip');
    await flipOver(ind, () => this.setIndicator(ev.indicator), 620);
    pulse($('.ind', this.root), 'glow', 1400);
    this.dealing = false;
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
    for (let p = 0; p < 4; p++) {
      const seat = this.seatAt(p), dlt = ev.deltas[seat]; if (!dlt) continue;
      const el = $(`.seat.p${p} .plate`, this.root);
      const f = document.createElement('b'); f.className = 'delta ' + (dlt < 0 ? 'neg' : 'pos'); f.textContent = (dlt > 0 ? '+' : '−') + Math.abs(dlt);
      el.appendChild(f); setTimeout(() => f.remove(), dur(1800) || 50);
      $('.sc', el).textContent = ev.scores[seat];
    }
    await wait(300);
  }

  // Someone finished: the finishing tile goes to the middle with a gold glow, then their rack tilts up and shows the hand.
  async finishFx(ev, next) {
    const p = this.pos(ev.seat), okey = (next.round || {}).okey, me = next.you;
    const center = rectOf($('#pile', this.root));
    let from;
    if (ev.seat === me && this.pendingDiscard === ev.tile) { from = null; this.pendingDiscard = null; }
    else if (ev.seat === me) { from = this.rack.tileRect(ev.tile); this.rack.hide(ev.tile, true); }
    else from = shrink(rectOf($(`.seat.p${p} .mrack`, this.root)), center);
    if (from) await flyTile({ id: ev.tile, okey, from, to: center, start: ev.seat === me ? 'face' : 'back', ms: 520, arc: 0.3, cls: 'golden' });
    sfx(ev.okeyFinish ? 'okey' : 'settle');
    this.view = next;
    await this.showResult(true, ev);
  }

  // ---- the result: the winner's rack tilts up, tiles turn over group by group, then the story ----
  async showResult(animate, ev) {
    const v = this.view; if (!v.result) return;
    const key = resultKey(v);
    if (this.resultShown === key) return;
    this.resultShown = key;
    const r = v.result, el = $('#result', this.root), story = storyOf(v);
    const win = r.winner != null ? v.seats[r.winner] : null;
    const okey = v.round && v.round.okey;
    const isMatch = v.phase === 'matchEnd';
    el.innerHTML = `<div class="rv-card ${story.cls}">
      ${win ? `<div class="rv-who"><span class="av">${esc(win.avatar || '🙂')}</span><b>${esc(win.name || '')}</b></div>
      <div class="rv-rack"><div class="rv-groups">${handGroupsHTML(v)}</div>
        <div class="rv-fin"><small>${t('result.finishTile')}</small>${tileHTML(r.tile, okey, 'rv fin')}</div></div>` : ''}
      <div class="rhead"><div class="rverd">${esc(story.v)}</div><div class="rline">${esc(story.line)}${story.extra ? ' ' + esc(story.extra) : ''}</div></div>
      ${deltasHTML(v)}
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
      const tiles = $$('.rv-groups .tile', el), fin = $('.rv-fin', el), rest = $$('.rhead,.deltas,.rv-acts', el);
      tiles.forEach(x => { x.style.opacity = '0'; });
      if (fin) fin.style.opacity = '0';
      rest.forEach(x => { x.style.opacity = '0'; });
      const rackEl = $('.rv-rack', el);
      if (rackEl && win) {
        const sp = rectOf($(`.seat.p${this.pos(r.winner)} .plate`, this.root)) || rectOf(rackEl), rr = rectOf(rackEl);
        await rackEl.animate([
          { transform: `translate(${sp.left + sp.width / 2 - (rr.left + rr.width / 2)}px,${sp.top + sp.height / 2 - (rr.top + rr.height / 2)}px) perspective(700px) rotateX(78deg) scale(.35)`, opacity: 0.2 },
          { transform: 'perspective(700px) rotateX(55deg) scale(.9)', opacity: 1, offset: 0.55 },
          { transform: 'perspective(700px) rotateX(0deg) scale(1)', opacity: 1 },
        ], { duration: dur(760), easing: 'cubic-bezier(.25,.8,.3,1.05)' }).finished.catch(() => {});
      }
      const groups = $$('.rv-groups .rg', el);
      for (const g of groups) {
        for (const x of $$('.tile', g)) {
          x.style.opacity = '';
          x.animate([{ transform: 'rotateY(90deg) translateY(-6px)', opacity: 0.3 }, { transform: 'none', opacity: 1 }], { duration: dur(200), easing: 'ease-out' });
          sfx('clack', { level: 0.5, pitch: 1.1 });
          await wait(58);
        }
        g.animate([{ boxShadow: '0 0 0 0 rgba(241,212,138,0)' }, { boxShadow: '0 0 14px 2px rgba(241,212,138,.55)' }, { boxShadow: '0 0 0 0 rgba(241,212,138,0)' }], { duration: dur(600) });
        await wait(110);
      }
      if (fin) { fin.style.opacity = ''; fin.animate([{ transform: 'scale(1.6)', opacity: 0 }, { transform: 'scale(1)', opacity: 1 }], { duration: dur(380), easing: 'cubic-bezier(.2,.9,.3,1.3)' }); sfx('clack'); }
      await wait(260);
      rest.forEach((x, i) => { x.style.opacity = ''; x.animate([{ transform: 'translateY(10px)', opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: dur(320), delay: dur(i * 120), fill: 'backwards' }); });
    }
    void card;
    if (r.winner != null) {
      if (won) {
        tipNote(true);
        const big = r.okeyFinish || r.kind === 'pairs';
        if (!isMatch) celebrate(big ? story.v : t('cele.win'), big ? t('cele.bigSub') : t('cele.winSub'), { sound: r.okeyFinish ? 'okey' : 'win', sparks: big ? 60 : 30 });
      } else sfx('lose');
    }
    if (isMatch) {
      await wait(900);
      const winners = (ev && ev.winners) || v.seats.map((s, i) => i).filter(i => v.seats[i].score === Math.max(...v.seats.map(s => s.score)));
      const iWon = winners.includes(v.you);
      recordMatch(v, iWon, this.ctx.solo);
      if (iWon) { celebrate(t('cele.champion'), t('cele.championSub'), { sound: 'fanfare', sparks: 90 }); tipNote(true); }
      else banner(t('cele.matchOver'), t('cele.matchWinner', { name: winners.map(i => v.seats[i].name).join(' & ') }), 'gold');
      this.showPodium();
    }
    tipCheck();
  }
  hideResult() {
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
    sheet(`<h2>${t('podium.title')}</h2>${podiumHTML(v)}
      <div class="row"><button class="btn" id="pdHome">${t('result.leave')}</button><button class="btn gold" id="pdAgain">${t('result.rematch')}</button></div>`, { cls: 'podsheet' });
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
function shrink(r, like) {
  if (!r) return like;
  const w = like ? like.width * 0.7 : 16, h = like ? like.height * 0.7 : 24;
  return { left: r.left + r.width / 2 - w / 2, top: r.top + r.height / 2 - h / 2, width: w, height: h };
}
function shiftPreview(slots, at) {
  const s = slots.slice(), base = Math.floor(at / 13) * 13;
  for (let j = at + 1; j < base + 13; j++) if (s[j] == null) { for (let k = j; k > at; k--) s[k] = s[k - 1]; s[at] = null; return s; }
  return slots;
}
