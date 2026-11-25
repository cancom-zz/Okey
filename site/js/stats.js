// Statistics, achievements and the device transfer, on the client.
//
//   openStats()            the Stats sheet: Klasik / 101, Pratik / Çevrimiçi, achievements with progress
//   recordPractice(sum)    a solo table's round/match summary (LocalTable onResult): practice stats on this
//                          device, same rules as the server (shared/achievements.js); toasts new unlocks
//   onlineResult(view)     an online round/match just ended: fetch the server's copy a moment later, toast
//                          what it unlocked
//   syncOnline()           POST /api/stats { id, secret } (never a GET by id) -> S.stats.online
//   openTransfer()         "Başka cihaza taşı": make a one-time code, or adopt an identity from one
import { t } from './i18n.js';
import { S, save, cleanAch } from './store.js';
import { $, $$, esc, sheet, closeSheet, toast, Sparks } from './ui.js';
import { sfx } from './sound.js';
import { AVATARS } from './config.js';
import { applySummary, progress, derived, sanitizeStats, ACHIEVEMENTS, LEVEL_IDS } from '../shared/achievements.js';

const SOLO_ID = 'solo-player';     // LocalTable's identity for the human seat
const offlineOnly = () => !!(globalThis.OKEY_PLAYTEST || location.protocol === 'file:' || new URLSearchParams(location.search).has('mock'));
let view = { variant: 'classic', scope: 'practice' };
let onlineState = 'idle';          // idle | loading | ok | error

// ---- styles (own file, loaded once) ----
function styles() {
  if (document.getElementById('statsCss')) return;
  const l = document.createElement('link');
  l.id = 'statsCss'; l.rel = 'stylesheet'; l.href = new URL('../css/stats.css', import.meta.url).href;
  document.head.appendChild(l);
}

// ---- unlock toasts: one at a time, after the table's own celebration ----
const pending = [];
let showing = false;
function announce(ids, practice) {
  for (const id of ids) pending.push({ id, practice });
  if (!showing) setTimeout(next, 2600);
  showing = true;
}
function next() {
  const it = pending.shift();
  if (!it) { showing = false; return; }
  styles();
  toast(`<span class="achtoast"><span class="medal" aria-hidden="true">🏆</span><span><b>${esc(t('ach.unlocked'))}</b><br>${esc(t('ach.' + it.id))}${it.practice ? ` <small>· ${esc(t('ach.practiceTag'))}</small>` : ''}</span></span>`, 'ach', 3200);
  sfx('okey');
  Sparks.burst(28, innerWidth / 2, 60);
  setTimeout(next, 3400);
}

// ---- practice ----
export function recordPractice(summary) {
  if (!summary || !Array.isArray(summary.seats)) return [];
  const me = summary.seats.find((s) => s.kind === 'human' && s.playerId === SOLO_ID) || summary.seats.find((s) => s.kind === 'human');
  if (!me) return [];
  const { stats, unlocked } = applySummary(S.stats.practice, summary, me.seat);
  S.stats.practice = stats;
  const now = Date.now();
  for (const p of progress(stats)) if (p.done && !S.stats.practiceAch[p.id]) S.stats.practiceAch[p.id] = now;
  if (!S.firstPlay) S.firstPlay = now;
  save();
  if (unlocked.length) announce(unlocked, true);
  return unlocked;
}

// ---- online ----
async function post(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  return { status: res.status, data };
}

export async function syncOnline({ notify = true } = {}) {
  if (offlineOnly()) return null;
  onlineState = 'loading';
  try {
    const { status, data } = await post('/api/stats', { id: S.id, secret: S.secret });
    if (status !== 200 || !data) throw new Error('http ' + status);
    const prev = S.stats.online;
    const next = { stats: sanitizeStats(data.stats), achievements: cleanAch(data.achievements), at: Date.now() };
    S.stats.online = next;
    save();
    onlineState = 'ok';
    if (notify && prev) {
      const fresh = Object.keys(next.achievements).filter((id) => !prev.achievements[id]);
      if (fresh.length) announce(fresh, false);
    }
    return next;
  } catch {
    onlineState = 'error';
    return null;
  }
}

let lastOnline = '';
let onlineT = 0;
/** Call with each online view; at a round or match end the server's stats are fetched (once). */
export function onlineResult(v) {
  if (!v || (v.phase !== 'roundEnd' && v.phase !== 'matchEnd') || v.you == null) return;
  const key = `${v.code}.${v.round && v.round.number}.${v.phase}`;
  if (key === lastOnline) return;
  lastOnline = key;
  clearTimeout(onlineT);
  // the Room records the result as the round ends; give it a moment
  onlineT = setTimeout(() => syncOnline({ notify: true }), 1500);
}

// ---- the sheet ----
const pct = (x) => (x === null ? '—' : Math.round(x * 100) + '%');
const num = (x, d = 0) => (x === null || x === undefined ? '—' : Number(x).toFixed(d));
const row = (k, v) => `<span>${esc(t(k))}</span><span>${v}</span>`;

function statsRows(stats, variant) {
  const s = stats[variant];
  const d = derived(stats, variant);
  const fastest = s.fastestFinish === null ? '—' : esc(t('stats.turns', { n: s.fastestFinish }));
  const common = [
    row('stats.rounds', s.rounds),
    row('stats.roundsWon', `${s.roundsWon} <small>${pct(d.roundWinRate)}</small>`),
    row('stats.matches', s.matches),
    row('stats.matchesWon', `${s.matchesWon} <small>${pct(d.matchWinRate)}</small>`),
  ];
  const vs = LEVEL_IDS.filter((l) => s.winsVsBot[l]).map((l) => `${esc(t('level.' + l))} ${s.winsVsBot[l]}`).join(' · ') || '—';
  if (variant === '101') {
    return [...common,
      row('stats.openings', `${s.openings} <small>${pct(d.openRate)}</small>`),
      row('stats.avgOpening', num(d.avgOpening)),
      row('stats.bestOpening', s.bestOpening || '—'),
      row('stats.pairsOpenings', s.pairsOpenings),
      row('stats.finishSets', s.finishes.sets),
      row('stats.finishPairs', s.finishes.pairs),
      row('stats.finishOkey', s.okeyFinishes),
      row('stats.elden', s.elden),
      row('stats.islek', `${s.islek} <small>${s.islekPoints}</small>`),
      row('stats.avgPenalty', num(d.avgPenalty)),
      row('stats.cleanRounds', s.cleanRounds),
      row('stats.fastest', fastest),
      row('stats.bestStreak', s.bestStreak),
      row('stats.winsVs', vs),
    ].join('');
  }
  return [...common,
    row('stats.finishNormal', s.finishes.normal),
    row('stats.finishOkey', s.finishes.okey),
    row('stats.finishPairs', s.finishes.pairs),
    row('stats.finishPairsOkey', s.finishes.pairsOkey),
    row('stats.indicators', s.indicators),
    row('stats.fastest', fastest),
    row('stats.bestStreak', s.bestStreak),
    row('stats.bestMatchStreak', s.bestMatchStreak),
    row('stats.pointsLost', s.pointsLost),
    row('stats.winsVs', vs),
  ].join('');
}

function achGrid(stats, unlocks, variant) {
  const shown = new Set(ACHIEVEMENTS.filter((a) => a.variant === null || a.variant === variant).map((a) => a.id));
  return `<div class="ach achp">${progress(stats).filter((p) => shown.has(p.id)).map((p) => {
    const on = p.done || !!unlocks[p.id];
    const w = Math.round((on ? 1 : p.value / p.goal) * 100);
    return `<div class="ac ${on ? 'on' : ''}" data-ach="${p.id}"><div class="t">${esc(t('ach.' + p.id))}</div><div class="d">${esc(t('achd.' + p.id))}</div>
      <div class="pbar" role="progressbar" aria-valuemin="0" aria-valuemax="${p.goal}" aria-valuenow="${on ? p.goal : p.value}"><i style="width:${w}%"></i></div>
      <div class="pn">${on ? '✓' : `${p.value} / ${p.goal}`}</div></div>`;
  }).join('')}</div>`;
}

function body() {
  const { variant, scope } = view;
  if (scope === 'online') {
    if (offlineOnly()) return `<p class="muted">${esc(t('stats.playtest'))}</p>`;
    const on = S.stats.online;
    if (!on) return `<p class="muted">${esc(t(onlineState === 'error' ? 'stats.offline' : 'stats.loading'))}</p>`;
    const err = onlineState === 'error' ? `<p class="muted small">${esc(t('stats.offline'))}</p>` : '';
    return `${err}<div class="kv">${statsRows(on.stats, variant)}</div><p class="muted small">${esc(t('stats.onlineNote'))}</p>
      <h3>${esc(t('stats.achievements'))}</h3>${achGrid(on.stats, on.achievements, variant)}`;
  }
  const st = S.stats.practice;
  return `<div class="kv">${statsRows(st, variant)}</div><p class="muted small">${esc(t('stats.practiceNote'))}</p>
    <h3>${esc(t('stats.achievements'))} <small class="muted">· ${esc(t('ach.practiceTag'))}</small></h3>${achGrid(st, S.stats.practiceAch, variant)}`;
}

const seg = (id, opts, cur) => `<div class="seg sm" id="${id}">${opts.map(([v, label]) => `<button data-v="${v}" class="${v === cur ? 'on' : ''}" aria-pressed="${v === cur}">${esc(label)}</button>`).join('')}</div>`;

export function openStats(opts = {}) {
  styles();
  if (opts && (opts.variant === 'classic' || opts.variant === '101')) view.variant = opts.variant;
  if (opts && (opts.scope === 'practice' || opts.scope === 'online')) view.scope = opts.scope;
  sheet(`<h2>${esc(t('stats.title'))}</h2>
    <div class="sttabs">${seg('stVar', [['classic', t('stats.tabClassic')], ['101', t('stats.tab101')]], view.variant)}${seg('stScope', [['practice', t('stats.practice')], ['online', t('stats.online')]], view.scope)}</div>
    <div id="stBody">${body()}</div>
    <div class="links"><button class="linkbtn" id="stMove">📱 ${esc(t('transfer.title'))} ›</button></div>`, { cls: 'tall stats' });
  const refresh = () => { const b = $('#stBody'); if (b) b.innerHTML = body(); };
  const wire = (id, key) => {
    $('#' + id).onclick = (e) => {
      const b = e.target.closest('button'); if (!b) return;
      view[key] = b.dataset.v;
      $$('#' + id + ' button').forEach((x) => { x.classList.toggle('on', x === b); x.setAttribute('aria-pressed', x === b); });
      refresh(); sfx('tick');
      if (key === 'scope' && b.dataset.v === 'online') syncOnline({ notify: false }).then(refresh);
    };
  };
  wire('stVar', 'variant');
  wire('stScope', 'scope');
  $('#stMove').onclick = openTransfer;
  if (view.scope === 'online') syncOnline({ notify: false }).then(refresh);
}

// ---- device transfer ----
const fmtCode = (c) => c.slice(0, 4) + '-' + c.slice(4);

export function openTransfer() {
  styles();
  sheet(`<h2>${esc(t('transfer.title'))}</h2>
    <p>${esc(t('transfer.intro'))}</p>
    ${offlineOnly() ? `<p class="muted">${esc(t('transfer.playtest'))}</p>` : `
    <div class="row"><button class="btn gold" id="trMake">${esc(t('transfer.create'))}</button></div>
    <div id="trOut" class="trout" hidden></div>
    <h3>${esc(t('transfer.enterTitle'))}</h3>
    <div class="trin"><input id="trCode" maxlength="9" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" placeholder="ABCD-EFGH" aria-label="${esc(t('transfer.enterTitle'))}">
    <button class="btn" id="trClaim">${esc(t('transfer.claim'))}</button></div>`}`, { cls: 'stats' });
  if (offlineOnly()) return;
  $('#trMake').onclick = makeCode;
  $('#trClaim').onclick = claimCode;
  $('#trCode').onkeydown = (e) => { if (e.key === 'Enter') claimCode(); };
}

let countdown = 0;
async function makeCode() {
  const out = $('#trOut');
  try {
    const { status, data } = await post('/api/transfer', {
      id: S.id, secret: S.secret, name: S.name, avatar: S.avatar,
      practice: { stats: S.stats.practice, ach: S.stats.practiceAch },
    });
    if (status === 429) return toast(esc(t('transfer.limited')), 'err', 3600);
    if (status !== 200 || !data || typeof data.code !== 'string') throw new Error('http ' + status);
    out.hidden = false;
    const tick = () => {
      const left = Math.max(0, data.expires - Date.now());
      const m = Math.ceil(left / 60e3);
      const el = $('#trOut');
      if (!el) { clearInterval(countdown); return; }
      el.innerHTML = `<span>${esc(t('transfer.yourCode'))}</span><b class="trcode" id="trShown">${esc(fmtCode(data.code))}</b><small>${esc(t('transfer.expires', { m }))}</small>`;
      if (!left) { clearInterval(countdown); el.classList.add('gone'); }
    };
    clearInterval(countdown);
    tick();
    countdown = setInterval(tick, 15e3);
    sfx('tick');
  } catch {
    toast(esc(t('transfer.offline')), 'err', 3600);
  }
}

async function claimCode() {
  const raw = ($('#trCode').value || '').toUpperCase().replace(/[\s-]/g, '');
  if (raw.length !== 8) { $('#trCode').classList.add('bad'); $('#trCode').focus(); return; }
  sheet(`<h2>${esc(t('transfer.confirmTitle'))}</h2><p>${esc(t('transfer.confirmBody'))}</p>
    <div class="row"><button class="btn" id="cNo">${esc(t('cancel'))}</button><button class="btn gold" id="cYes">${esc(t('transfer.confirmYes'))}</button></div>`);
  $('#cNo').onclick = openTransfer;
  $('#cYes').onclick = async () => {
    try {
      const { status, data } = await post('/api/transfer/claim', { code: raw });
      if (status === 429) return toast(esc(t('transfer.limited')), 'err', 3600);
      if (status === 404) return toast(esc(t('transfer.bad')), 'err', 3600);
      if (status !== 200 || !data) throw new Error('http ' + status);
      adopt(data);
      closeSheet();
      toast(esc(t('transfer.done')), 'win', 3600);
      sfx('win');
    } catch {
      toast(esc(t('transfer.offline')), 'err', 3600);
    }
  };
}

/** Take over an identity from a transfer code's payload. */
export function adopt(p) {
  const okId = (x) => typeof x === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(x);
  if (!p || !okId(p.id) || !okId(p.secret)) return false;
  S.id = p.id;
  S.secret = p.secret;
  if (typeof p.name === 'string' && p.name) S.name = p.name.slice(0, 20);
  if (AVATARS.includes(p.avatar)) S.avatar = p.avatar;
  S.stats.practice = sanitizeStats(p.practice && p.practice.stats);
  S.stats.practiceAch = cleanAch(p.practice && p.practice.ach);
  S.stats.online = null;
  save();
  return true;
}
