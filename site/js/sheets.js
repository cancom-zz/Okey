// Sheets: settings, rules, stats + achievements, about, profile (name + avatar), bot picker.
import { t, getLang, setLang } from './i18n.js';
import { S, save, cleanName } from './store.js';
import { AVATARS, FELTS, SPEEDS, LEVELS, BOT_PARAMS, KOFI_URL, BOT_AVATAR } from './config.js';
import { sheet, closeSheet, esc, $, $$, toast } from './ui.js';
import { setSound, setVolume, sfx } from './sound.js';
import { openTip } from './tip.js';

const seg = (id, opts, cur) => `<div class="seg" id="${id}">${opts.map(([v, label]) => `<button data-v="${v}" class="${String(v) === String(cur) ? 'on' : ''}">${label}</button>`).join('')}</div>`;
function wireSeg(id, f) {
  const el = $('#' + id); if (!el) return;
  el.onclick = e => { const b = e.target.closest('button'); if (!b) return; $$('button', el).forEach(x => x.classList.toggle('on', x === b)); f(b.dataset.v); };
}

export function applyFelt() { document.body.dataset.felt = S.settings.felt; }

export function openSettings(onChange) {
  sheet(`<h2>${t('settings.title')}</h2>
    <div class="opt"><span>${t('settings.lang')}</span>${seg('sLang', [['tr', 'Türkçe'], ['en', 'English']], getLang())}</div>
    <div class="opt"><span>${t('settings.sound')}</span>${seg('sSound', [['1', t('on')], ['0', t('off')]], S.settings.sound ? '1' : '0')}</div>
    <div class="opt"><span>${t('settings.volume')}</span><input type="range" class="vol" id="sVol" min="0" max="100" step="5" value="${Math.round((S.settings.volume ?? 0.8) * 100)}" aria-label="${esc(t('settings.volume'))}"></div>
    <div class="opt"><span>${t('settings.haptics')}</span>${seg('sHap', [['1', t('on')], ['0', t('off')]], S.settings.haptics !== false ? '1' : '0')}</div>
    <div class="opt"><span>${t('settings.speed')}</span>${seg('sSpeed', Object.keys(SPEEDS).map(k => [k, t('speed.' + k)]), S.settings.speed)}</div>
    <div class="opt"><span>${t('settings.felt')}</span><div class="swatches" id="sFelt">${FELTS.map(f => `<button data-v="${f}" class="sw f-${f} ${S.settings.felt === f ? 'on' : ''}" aria-label="${esc(t('felt.' + f))}" title="${esc(t('felt.' + f))}"></button>`).join('')}</div></div>
    <div class="opt"><span>${t('settings.profile')}</span><button class="mini" id="sProfile">${esc(S.avatar)} ${esc(S.name || t('profile.noName'))} ›</button></div>
    <div class="links"><button class="linkbtn" id="sRules">${t('rules.title')}</button><button class="linkbtn" id="sAbout">${t('about.title')}</button><button class="linkbtn" id="sTip">☕ ${t('tip.title')}</button></div>`);
  wireSeg('sLang', v => { setLang(v); openSettings(onChange); onChange && onChange('lang'); });
  wireSeg('sSound', v => { setSound(v === '1'); onChange && onChange('sound'); });
  wireSeg('sSpeed', v => { S.settings.speed = v; save(); });
  wireSeg('sHap', v => { S.settings.haptics = v === '1'; save(); if (v === '1' && navigator.vibrate) navigator.vibrate(12); });
  const vol = $('#sVol'); vol.oninput = () => setVolume(+vol.value / 100); vol.onchange = () => sfx('stack');
  $('#sFelt').onclick = e => { const b = e.target.closest('button'); if (!b) return; S.settings.felt = b.dataset.v; save(); applyFelt(); $$('#sFelt button').forEach(x => x.classList.toggle('on', x === b)); sfx('tick'); };
  $('#sProfile').onclick = () => openProfile(false, () => { onChange && onChange('profile'); });
  $('#sRules').onclick = () => openRules(); $('#sAbout').onclick = openAbout; $('#sTip').onclick = openTip;
}

export function openProfile(first, done) {
  let av = S.avatar;
  sheet(`<h2>${first ? t('profile.welcome') : t('profile.title')}</h2>
    ${first ? `<p>${t('profile.intro')}</p>` : ''}
    <label class="field"><span>${t('profile.name')}</span><input id="pName" maxlength="20" autocomplete="nickname" enterkeyhint="done" value="${esc(S.name)}" placeholder="${esc(t('profile.namePh'))}"></label>
    <div class="avgrid" id="pAv" role="radiogroup" aria-label="${esc(t('profile.avatar'))}">${AVATARS.map(a => `<button role="radio" aria-checked="${a === av}" class="${a === av ? 'on' : ''}" data-a="${a}">${a}</button>`).join('')}</div>
    ${first ? `<p class="tipintro"><b>${t('about.noAds')}</b> ${t('about.runsOnTips')} <a class="tiplink2" href="${KOFI_URL}" target="_blank" rel="noopener">${t('tip.kofi')} ☕</a></p>` : ''}
    <div class="row"><button class="btn gold" id="pSave">${first ? t('profile.start') : t('save')}</button></div>`, { onClose: () => { if (first && !S.name) { S.name = defaultName(); save(); done && done(); } } });
  $('#pAv').onclick = e => { const b = e.target.closest('button'); if (!b) return; av = b.dataset.a; $$('#pAv button').forEach(x => { x.classList.toggle('on', x === b); x.setAttribute('aria-checked', x === b); }); sfx('tick'); };
  const go = () => {
    const n = cleanName($('#pName').value);
    if (!n) { $('#pName').focus(); $('#pName').classList.add('bad'); return; }
    S.name = n; S.avatar = av; save(); closeSheet(); done && done();
  };
  $('#pSave').onclick = go;
  $('#pName').onkeydown = e => { if (e.key === 'Enter') go(); };
  if (!first) setTimeout(() => $('#pName') && $('#pName').focus({ preventScroll: true }), 50);
}
const defaultName = () => t('profile.default') + ' ' + Math.floor(100 + Math.random() * 900);

export function openRules(variant = 'classic') {
  sheet(`<h2>${t('rules.title')}</h2><div class="seg sm rtabs" id="rTabs"><button data-v="classic" class="${variant !== '101' ? 'on' : ''}">${t('rules.tabClassic')}</button><button data-v="101" class="${variant === '101' ? 'on' : ''}">${t('rules.tab101')}</button></div>
    <div class="rules" id="rBody">${t(variant === '101' ? 'rules101.html' : 'rules.html')}</div>${matchMedia('(pointer:fine)').matches ? `<p class="muted small keys">${t('rules.keys')}</p>` : ''}`, { cls: 'tall' });
  wireSeg('rTabs', v => { $('#rBody').innerHTML = t(v === '101' ? 'rules101.html' : 'rules.html'); $('#rBody').scrollTop = 0; });
}

// The Stats sheet (tabs, achievements with progress, device transfer) lives in stats.js.
export function openStats(opts) { import('./stats.js').then((m) => m.openStats(opts)); }

export function openAbout() {
  sheet(`<h2>${t('about.title')}</h2>
    <p class="tipintro"><b>${t('about.noAds')}</b> ${t('about.runsOnTips')}</p>
    <p>${t('about.p1')}</p><p>${t('about.p2')}</p><p class="muted">${t('about.p3')}</p>
    <div class="row"><button class="btn" id="aTip">☕ ${t('tip.title')}</button></div>`);
  $('#aTip').onclick = openTip;
}

// Bot picker (host, lobby): a level, or custom sliders starting from that level.
export function openBotPicker(seatName, add) {
  let level = 'kalfa', custom = false;
  const params = () => Object.fromEntries(BOT_PARAMS.map(([k]) => [k, +$('#bp-' + k).value]));
  const sliders = () => BOT_PARAMS.map(([k, min, max, step, def]) => {
    const v = def[LEVELS.indexOf(level)];
    return `<label class="slider"><span>${t('bot.p.' + k)}<output id="bo-${k}">${fmtP(k, v)}</output></span><input type="range" id="bp-${k}" min="${min}" max="${max}" step="${step}" value="${v}"></label>`;
  }).join('');
  sheet(`<h2>${t('bot.title', { seat: esc(seatName) })}</h2>
    <div class="levels" id="bLv">${LEVELS.map(l => `<button data-l="${l}" class="${l === level ? 'on' : ''}"><span class="av">${BOT_AVATAR[l]}</span><b>${t('level.' + l)}</b><small>${t('leveld.' + l)}</small></button>`).join('')}</div>
    <button class="linkbtn" id="bCustom">${t('bot.custom')} ›</button>
    <div class="sliders" id="bSl" hidden>${sliders()}</div>
    <div class="row"><button class="btn gold" id="bAdd">${t('bot.add')}</button></div>`);
  const refresh = () => { $('#bSl').innerHTML = sliders(); wireSl(); };
  const wireSl = () => BOT_PARAMS.forEach(([k]) => { const i = $('#bp-' + k); i.oninput = () => { $('#bo-' + k).textContent = fmtP(k, +i.value); }; });
  wireSl();
  $('#bLv').onclick = e => { const b = e.target.closest('button'); if (!b) return; level = b.dataset.l; $$('#bLv button').forEach(x => x.classList.toggle('on', x === b)); refresh(); sfx('tick'); };
  $('#bCustom').onclick = () => { custom = !custom; $('#bSl').hidden = !custom; };
  $('#bAdd').onclick = () => { add(level, custom ? params() : null); closeSheet(); };
}
const fmtP = (k, v) => (k === 'lookahead' ? String(v) : k === 'speed' || k === 'pairsBias' ? v.toFixed(2) + '×' : Math.round(v * 100) + '%');

export function confirmSheet(title, body, yes, onYes) {
  sheet(`<h2>${title}</h2><p>${body}</p><div class="row"><button class="btn" id="cNo">${t('cancel')}</button><button class="btn gold" id="cYes">${yes}</button></div>`);
  $('#cNo').onclick = closeSheet; $('#cYes').onclick = () => { closeSheet(); onYes(); };
}
void toast;
