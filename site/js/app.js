// Entry: routes (#/ home, #/solo practice, #/m/CODE a table), the top bar, and the room controller that feeds
// views to the lobby or the table, one message at a time so animations never overlap.
import { t, onLang, applyStatic } from './i18n.js';
import { S, save, player } from './store.js';
import { $, toast, sheetOpen, closeSheet, clearBanners } from './ui.js';
import { sfx, setSound } from './sound.js';
import { renderHome } from './home.js';
import { LobbyScreen } from './lobby.js';
import { TableScreen } from './table.js';
import { createRoom, soloTransport, roomTransport } from './net.js';
import { openSettings, openRules, openStats, openProfile, applyFelt, confirmSheet } from './sheets.js';
import { openTip, setResting } from './tip.js';
import { getLang } from './i18n.js';

const screen = () => $('#screen');
let room = null;

class Room {
  constructor({ code, solo, level, resume = false }) {
    this.code = code; this.solo = solo; this.level = level; this.resume = resume;
    this.view = null; this.q = []; this.running = false; this.ui = null; this.uiKind = null; this.setupV = -1;
    this.tr = null; this.closed = false;
  }
  async open() {
    try {
      this.tr = this.solo
        ? await soloTransport({ player: player(), lang: getLang(), levels: [this.level, this.level, this.level], settings: { turnSeconds: 0 }, resume: this.resume })
        : await roomTransport(this.code);
    } catch (e) { console.error(e); toast(t(e && e.code === 'noRoom' ? 'err.noRoom' : 'err.connect'), 'err', 4000); go('#/'); return; }
    if (this.closed) { this.tr.close(); return; }
    this.tr.onmessage = m => this.receive(m);
    this.tr.onstatus = s => this.status(s);
    const hello = () => this.tr.send({ t: 'hello', player: player(), lang: getLang() });
    if (this.tr.selfHello) this.tr.connect();
    else if ('onopen' in this.tr) { this.tr.onopen = hello; this.tr.connect(); } else { this.tr.connect(); hello(); }
    this.showWaiting();
  }
  showWaiting() {
    if (this.ui) return;
    screen().innerHTML = `<div class="waiting"><div class="spinner" aria-hidden="true"><i></i><i></i><i></i></div><p>${this.solo ? t('wait.solo') : t('wait.connecting')}</p></div>`;
  }
  status(s) {
    const el = $('#netstat');
    if (s === 'reconnecting') { el.hidden = false; el.textContent = t('net.reconnecting'); }
    else if (s === 'open') { el.hidden = true; }
    else if (s === 'gone' || s === 'full' || s === 'replaced') { toast(t({ gone: 'err.noRoom', full: 'err.full', replaced: 'err.replaced' }[s]), 'err', 4500); go('#/'); }
  }
  send(m) { if (this.tr && !this.closed) this.tr.send(m); }
  receive(m) { if (this.closed) return; this.q.push(m); if (!this.running) this.pump(); }
  async pump() {
    this.running = true;
    while (this.q.length && !this.closed) {
      const m = this.q.shift();
      // a lobby view with a newer view queued behind it has nothing to show (practice sets up in a burst)
      if (m.t === 'view' && m.view && m.view.phase === 'lobby' && this.q.some(x => x.t === 'view')) continue;
      try { await this.handle(m); } catch (e) { console.error(e); }
    }
    this.running = false;
  }
  async handle(m) {
    if (m.t === 'view' && m.view) {
      const v = m.view; this.view = v;
      if (v.code && !this.solo && v.code !== this.code) this.code = v.code;
      if (v.phase === 'lobby') {
        if (this.solo) { if (!this.tr.selfHello) this.soloSetup(v); this.showWaiting(); return; }
        if (this.uiKind !== 'lobby') { this.swap('lobby'); }
        this.ui.update(v);
        topbar();
        return;
      }
      if (this.uiKind !== 'table') this.swap('table');
      topbar();
      await this.ui.update(v, m.events || []);
    } else if (m.t === 'emote') { this.ui && this.ui.emote(m.seat, m.id); }
    else if (m.t === 'error') {
      if (this.solo && this.view && this.view.phase === 'lobby') return;   // setup races are harmless
      if (this.ui && this.ui.error) this.ui.error(m.code); else toast(t('err.' + m.code), 'err');
    }
  }
  swap(kind) {
    if (this.ui) this.ui.destroy();
    const ctx = { send: msg => this.send(msg), code: this.code, solo: this.solo, leave: () => leave(true) };
    this.ui = kind === 'lobby' ? new LobbyScreen(screen(), ctx) : new TableScreen(screen(), ctx);
    this.uiKind = kind;
  }
  // Practice: sit down, fill the other seats with bots, start. (No-op if local.js already did it.)
  soloSetup(v) {
    if (this.setupV === v.v) return; this.setupV = v.v;
    if (v.you == null) { const seat = v.seats.findIndex(s => s.kind === 'empty'); if (seat >= 0) this.send({ t: 'sit', seat }); return; }
    if (v.host !== v.you) return;
    this.asked = this.asked || new Set();
    const empty = v.seats.map((s, i) => (s.kind === 'empty' ? i : -1)).filter(i => i >= 0);
    if (empty.length) { empty.filter(i => !this.asked.has(i)).forEach(seat => { this.asked.add(seat); this.send({ t: 'addBot', seat, level: this.level }); }); return; }
    if (!this.started) { this.started = true; this.send({ t: 'start' }); }
  }
  close() {
    this.closed = true;
    if (this.ui) this.ui.destroy(); this.ui = null;
    if (this.tr) this.tr.close();
    $('#netstat').hidden = true;
  }
  resting() { const v = this.view; return !v || v.phase !== 'playing'; }
}

// ---- routes ----
function go(hash) { if (location.hash !== hash) location.hash = hash; else route(); }
function leave(ask) {
  const v = room && room.view;
  if (ask && v && v.phase === 'playing') {
    confirmSheet(t('leave.title'), room.solo ? t('leave.soloBody') : t('leave.body'), t('leave.yes'), () => go('#/'));
    return;
  }
  go('#/');
}

async function route() {
  const h = location.hash || '#/';
  if (sheetOpen()) closeSheet();
  clearBanners();
  if (room) { room.close(); room = null; }
  const m = h.match(/^#\/m\/([A-Za-z0-9]{6})$/);
  document.body.dataset.screen = h === '#/solo' ? 'table' : m ? 'table' : 'home';
  if (!S.name) { await new Promise(res => openProfile(true, res)); }
  if (h === '#/solo') {
    room = new Room({ solo: true, level: S.settings.soloLevel, code: 'SOLO' });
    topbar(); room.open();
  } else if (m) {
    room = new Room({ code: m[1].toUpperCase(), solo: false });
    topbar(); room.open();
  } else {
    renderHome(screen(), {
      solo: () => go('#/solo'),
      create: async () => {
        try { const { code } = await createRoom({}); go('#/m/' + code); } catch (e) { console.error(e); toast(t('err.create'), 'err', 3600); }
      },
      join: code => go('#/m/' + code),
    });
    topbar();
  }
}

function topbar() {
  const inRoom = !!room;
  $('#tBack').hidden = !inRoom;
  $('#tCode').hidden = !inRoom || room.solo;
  if (inRoom && !room.solo) $('#tCode').textContent = room.code;
  $('#tTip').hidden = inRoom;
  $('#tSound').textContent = S.settings.sound ? '🔊' : '🔇';
  $('#tSound').setAttribute('aria-label', t(S.settings.sound ? 'top.mute' : 'top.unmute'));
  $('#brand').textContent = t('brand');
}

function boot() {
  applyFelt();
  applyStatic();
  $('#tBack').onclick = () => leave(true);
  $('#brand').onclick = () => { if (!room) return; leave(true); };
  $('#tSound').onclick = () => { setSound(!S.settings.sound); topbar(); };
  $('#tRules').onclick = openRules;
  $('#tStats').onclick = openStats;
  $('#tSet').onclick = () => openSettings(what => { if (what === 'lang' || what === 'profile') { /* re-render below */ } });
  $('#tTip').onclick = openTip;
  onLang(() => { applyStatic(); if (!room) route(); else { topbar(); if (room.ui && room.view) { const v = room.view; room.swap(room.uiKind); if (room.uiKind === 'lobby') room.ui.update(v); else room.ui.update(v, []); } } });
  setResting(() => !room || room.resting());
  addEventListener('hashchange', route);
  route();
  // installable: a service worker is optional; none yet (the worker serves fresh files)
  void save; void sfx;
}
boot();
