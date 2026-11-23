// The front door: play against bots right now, or set up a table for friends (share a link) / join by code.
import { t } from './i18n.js';
import { S, save } from './store.js';
import { LEVELS, CODE_CHARS, KOFI_URL } from './config.js';
import { $, esc, toast } from './ui.js';
import { tileHTML } from './tiles.js';
import { sfx } from './sound.js';

const tid = (c, n, copy = 0) => c * 26 + copy * 13 + (n - 1);

export function renderHome(root, { solo, create, join }) {
  const lv = S.settings.soloLevel;
  root.innerHTML = `<section class="home">
    <div class="hero">
      <div class="fan" aria-hidden="true">
        ${tileHTML(tid(0, 7), null, 'f1')}${tileHTML(tid(1, 8), null, 'f2')}${tileHTML(104, null, 'f3')}${tileHTML(tid(2, 10), null, 'f4')}${tileHTML(tid(3, 11), null, 'f5')}
      </div>
      <h1 class="logo">${t('brand')}</h1>
      <p class="tagline">${t('home.tagline')}</p>
    </div>
    <div class="doors">
      <div class="door solo">
        <button class="bigbtn gold" id="hSolo"><span class="ic">🤖</span><span class="tx"><b>${t('home.solo')}</b><small>${t('home.soloSub')}</small></span><span class="chev">›</span></button>
        <div class="lvrow"><span>${t('home.level')}</span><div class="seg sm" id="hLv">${LEVELS.map(l => `<button data-v="${l}" class="${l === lv ? 'on' : ''}">${t('level.' + l)}</button>`).join('')}</div></div>
      </div>
      <div class="door friends">
        <button class="bigbtn" id="hCreate"><span class="ic">👥</span><span class="tx"><b>${t('home.friends')}</b><small>${t('home.friendsSub')}</small></span><span class="chev">›</span></button>
        <form class="joinrow" id="hJoin" autocomplete="off">
          <input id="hCode" inputmode="text" autocapitalize="characters" spellcheck="false" maxlength="6" placeholder="${esc(t('home.codePh'))}" aria-label="${esc(t('home.codeLabel'))}">
          <button class="btn sm" id="hJoinBtn" type="submit">${t('home.join')}</button>
        </form>
      </div>
    </div>
    <p class="hfoot">${t('home.foot')} · <a class="tiplink2" href="${KOFI_URL}" target="_blank" rel="noopener">${t('home.tipFoot')}</a></p>
  </section>`;
  $('#hSolo').onclick = () => { sfx('clack'); solo(S.settings.soloLevel); };
  $('#hLv').onclick = e => {
    const b = e.target.closest('button'); if (!b) return;
    S.settings.soloLevel = b.dataset.v; save();
    root.querySelectorAll('#hLv button').forEach(x => x.classList.toggle('on', x === b)); sfx('tick');
  };
  $('#hCreate').onclick = () => { sfx('clack'); create(); };
  const code = $('#hCode');
  code.oninput = () => { code.value = [...code.value.toUpperCase()].filter(ch => CODE_CHARS.includes(ch)).join('').slice(0, 6); code.classList.remove('bad'); };
  $('#hJoin').onsubmit = e => {
    e.preventDefault();
    const c = code.value.trim().toUpperCase();
    if (c.length !== 6 || [...c].some(ch => !CODE_CHARS.includes(ch))) { code.classList.add('bad'); toast(t('home.badCode'), 'err'); return; }
    join(c);
  };
}
