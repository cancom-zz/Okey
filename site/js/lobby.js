// The lobby: four seats around a felt table. The host adds bots, sets the clock, starts. Seats fill live.
import { t } from './i18n.js';
import { TURN_OPTIONS, ROUND_OPTIONS, ROUND_OPTIONS_101, BOT_AVATAR, VARIANTS, RULES_101 } from './config.js';
import { $, $$, esc, toast, copyText, sheet } from './ui.js';
import { openBotPicker } from './sheets.js';
import { sfx } from './sound.js';
import { settle } from './anim.js';

export class LobbyScreen {
  constructor(root, ctx) {
    this.root = root; this.ctx = ctx; this.view = null; this.prevKinds = null;
    root.innerHTML = `<section class="lobby">
      <div class="lplacard">
        <div class="lp1"><span>${t('lobby.table')}</span><b id="lCode"></b></div>
        <div class="share">
          <span class="link" id="lLink"></span>
          <button class="btn sm" id="lCopy">${t('lobby.copy')}</button>
          <button class="btn sm gold" id="lShare" ${navigator.share ? '' : 'hidden'}>${t('lobby.share')}</button>
        </div>
      </div>
      <div class="ltable"><div class="lfelt"><div class="lmark">${t('brand')}</div>
        ${[2, 3, 1, 0].map(p => `<div class="lseat q${p}" data-p="${p}"></div>`).join('')}
      </div></div>
      <div class="lctl" id="lCtl"></div>
    </section>`;
    $('#lCopy', root).onclick = async () => { if (await copyText(this.link())) { toast(t('lobby.copied'), 'win', 1600); sfx('tick'); } };
    $('#lShare', root).onclick = () => navigator.share({ title: t('brand'), text: t('lobby.shareText'), url: this.link() }).catch(() => {});
    root.addEventListener('click', e => this.click(e));
  }
  link() { return `${location.origin}${location.pathname}#/m/${this.view ? this.view.code : ''}`; }
  destroy() { this.root.innerHTML = ''; }
  pos(seat) { const you = this.view.you != null ? this.view.you : 0; return (seat - you + 4) % 4; }

  update(view) {
    const prev = this.view; this.view = view;
    $('#lCode', this.root).textContent = view.code;
    $('#lLink', this.root).textContent = this.link().replace(/^https?:\/\//, '');
    const isHost = view.host != null && view.host === view.you;
    view.seats.forEach((s, seat) => {
      const p = this.pos(seat), el = $(`.lseat.q${p}`, this.root);
      const you = seat === view.you;
      let html;
      if (s.kind === 'empty') {
        // the empty seat itself is the button: add a bot (host) or sit down (spectator)
        const a = isHost ? 'bot' : view.you == null ? 'sit' : null;
        html = a ? `<button class="spot empty act" data-a="${a}" data-s="${seat}"><span class="av">＋</span><span class="nm">${t(a === 'bot' ? 'lobby.addBot' : 'lobby.sit')}</span></button>`
          : `<div class="spot empty"><span class="av">＋</span><span class="nm">${t('lobby.empty')}</span></div>`;
      } else {
        const lvl = s.bot ? s.bot.level : null;
        html = `<div class="spot ${you ? 'me' : ''} ${s.kind === 'human' && !s.connected ? 'off' : ''}"><span class="av">${esc(s.avatar || (lvl ? BOT_AVATAR[lvl] : '🙂'))}</span>
          <span class="nm">${esc(s.name || '')}${seat === view.host ? ' <i class="crown" title="' + esc(t('lobby.host')) + '">👑</i>' : ''}</span>
          <span class="tg">${lvl ? t('level.' + lvl) : you ? t('lobby.you') : s.connected ? t('lobby.ready') : t('table.offline')}</span></div>
          ${isHost && s.kind === 'bot' ? `<button class="mini" data-a="rm" data-s="${seat}" aria-label="${esc(t('lobby.removeBot'))}">✕ ${t('lobby.remove')}</button>` : ''}`;
      }
      if (el.innerHTML !== html) {
        el.innerHTML = html;
        if (prev && prev.seats[seat].kind !== s.kind) { settle($('.spot', el), 1.4); if (s.kind !== 'empty') sfx('clack'); }
      }
    });
    const full = view.seats.every(s => s.kind !== 'empty');
    const st = view.settings || {};
    const is101 = st.variant === '101';
    const ctl = $('#lCtl', this.root);
    if (isHost) {
      ctl.innerHTML = `<div class="opt"><span>${t('lobby.turnTime')}</span><div class="seg sm" id="lTurn">${TURN_OPTIONS.map(s => `<button data-v="${s}" class="${st.turnSeconds === s ? 'on' : ''}">${s}${t('unit.sec')}</button>`).join('')}</div></div>
        <div class="opt"><span>${t('lobby.variant')}</span>${is101 ? `<button class="mini" id="lRulesBtn">${t('lobby.rules101')} ›</button>` : ''}<div class="seg sm" id="lVar">${VARIANTS.map(x => `<button data-v="${x}" class="${(st.variant || 'classic') === x ? 'on' : ''}">${t('variant.' + x)}</button>`).join('')}</div></div>
        <div class="opt"><span>${t('lobby.length')}</span><div class="seg sm" id="lRounds">${(is101 ? ROUND_OPTIONS_101 : ROUND_OPTIONS).map(r => `<button data-v="${r}" class="${(st.rounds || 0) === r ? 'on' : ''}">${r ? (is101 ? String(r) : t('lobby.rounds', { n: r })) : t('lobby.toZero')}</button>`).join('')}</div></div>

        <div class="row"><button class="btn" id="lLeave">${t('lobby.leave')}</button><button class="btn gold" id="lStart" ${full ? '' : 'disabled'}>${full ? t('lobby.start') : t('lobby.needFour', { n: view.seats.filter(s => s.kind === 'empty').length })}</button></div>`;
      $('#lTurn', ctl).onclick = e => { const b = e.target.closest('button'); if (b) this.ctx.send({ t: 'settings', settings: { turnSeconds: +b.dataset.v } }); };
      $('#lVar', ctl).onclick = e => { const b = e.target.closest('button'); if (b) this.ctx.send({ t: 'settings', settings: { variant: b.dataset.v } }); };
      const rb = $('#lRulesBtn', ctl); if (rb) rb.onclick = () => this.openRules();
      $('#lRounds', ctl).onclick = e => { const b = e.target.closest('button'); if (b) this.ctx.send({ t: 'settings', settings: { rounds: +b.dataset.v } }); };
      $('#lStart', ctl).onclick = () => { sfx('clack'); this.ctx.send({ t: 'start' }); };
    } else {
      ctl.innerHTML = `<p class="wait">${view.you == null ? t('lobby.pickSeat') : t('lobby.waitHost')}</p>
        <div class="row"><button class="btn" id="lLeave">${t('lobby.leave')}</button></div>`;
    }
    $('#lLeave', ctl).onclick = () => this.ctx.leave();
  }
  // 101 house rules: toggles in a sheet (the host's settings flags); each tap is sent at once
  openRules() {
    const st = { ...(this.view.settings || {}) };
    const el = sheet(`<h2>${t('lobby.rules101')}</h2><div class="toggles" id="lRules">${RULES_101.map(k => `<button data-k="${k}" class="hrule ${st[k] ? 'on' : ''}" aria-pressed="${!!st[k]}"><b>${t('rule.' + k)}</b><small>${t('ruled.' + k)}</small></button>`).join('')}</div>`);
    $('#lRules', el).onclick = e => {
      const b = e.target.closest('button'); if (!b) return;
      const k = b.dataset.k; st[k] = !st[k];
      b.classList.toggle('on', st[k]); b.setAttribute('aria-pressed', st[k]); sfx('tick');
      this.ctx.send({ t: 'settings', settings: { [k]: st[k] } });
    };
  }
  click(e) {
    const b = e.target.closest('button[data-a]'); if (!b) return;
    const seat = +b.dataset.s;
    if (b.dataset.a === 'sit') this.ctx.send({ t: 'sit', seat });
    if (b.dataset.a === 'rm') this.ctx.send({ t: 'removeBot', seat });
    if (b.dataset.a === 'bot') openBotPicker(t('lobby.seatN', { n: seat + 1 }), (level, params) => this.ctx.send({ t: 'addBot', seat, level, ...(params ? { params } : {}) }));
  }
  emote() { /* lobby: nothing to float over */ }
}
void $$;
