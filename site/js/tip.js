// The tip jar and when to ask (same rules as the-felt). No ads, no payments, no accounts: tips keep the lights on.
// Asks only between rounds; never in the first 10 minutes of play; after a good moment (last 5 minutes) or 30 more
// minutes of play; at least 2 days apart. Tapping Ko-fi snoozes; back from Ko-fi we ask once "did you tip?".
// "I tipped" stops every ask for good. Tips never touch anything in the game.
// Also: the local stats cache (practice results stay on this device and never count toward server stats).
import { S, save } from './store.js';
import { KOFI_URL, TIP_FIRST, TIP_EVERY, TIP_GAP, TIP_HOT } from './config.js';
import { t } from './i18n.js';
import { sheet, closeSheet, sheetOpen, toast, $ } from './ui.js';

let good = 0, touched = 0, resting = () => true;
export const setResting = f => { resting = f; };
export function tipNote(isGood) { if (isGood) good = Date.now(); }
const hot = () => Date.now() - good < TIP_HOT;

function ready() {
  const tp = S.tip;
  return !!KOFI_URL && !tp.done && Date.now() >= tp.next && tp.play >= TIP_FIRST && (hot() || tp.play - tp.at >= TIP_EVERY);
}
export function tipCheck() {
  if (!ready()) return;
  setTimeout(() => { if (ready() && resting() && !sheetOpen()) openTipAsk(); }, 3200);   // let the result land first
}
function asked() { const tp = S.tip; tp.next = Date.now() + TIP_GAP; tp.at = tp.play; good = 0; save(); }

// play time: the page is visible and was touched in the last 2 minutes
addEventListener('pointerdown', () => { touched = Date.now(); }, { passive: true });
setInterval(() => { if (document.visibilityState === 'visible' && Date.now() - touched < 120e3) { S.tip.play += 15e3; save(); } }, 15e3);
document.addEventListener('visibilitychange', () => {
  const tp = S.tip;
  if (document.visibilityState === 'visible' && tp.went && !tp.done && Date.now() - tp.went < 6 * 3600e3 && resting() && !sheetOpen()) openTipThanks();
});

const why = () => `<p><b>${t('tip.why1')}</b> ${t('tip.why2')}</p><p class="muted">${t('tip.why3')}</p>`;
const link = () => `<a class="btn gold tiplink" href="${KOFI_URL}" target="_blank" rel="noopener">☕ ${t('tip.kofi')}</a>`;
function wire() {
  document.querySelectorAll('.tiplink').forEach(a => a.addEventListener('click', () => { S.tip.went = Date.now(); asked(); closeSheet(); }));
  const d = $('#tipdone'); if (d) d.onclick = stop;
}
function stop() { S.tip.done = true; save(); closeSheet(); toast(t('tip.thanksStop'), 'win'); }

export function openTip() {
  sheet(`<h2>${t('tip.title')}</h2>${why()}<div class="row">${link()}</div>
    ${S.tip.done ? `<p class="tipnote">${t('tip.youTipped')}</p>` : `<p class="tipnote"><button id="tipdone">${t('tip.already')}</button></p>`}`);
  wire();
}
export function openTipAsk() {
  sheet(`<h2>${hot() ? t('tip.askHot') : t('tip.ask')}</h2>${why()}
    <div class="row"><button class="btn" id="tiplater">${t('tip.later')}</button>${link()}</div>
    <p class="tipnote"><button id="tipdone">${t('tip.already')}</button></p>`);
  asked(); $('#tiplater').onclick = closeSheet; wire();
}
function openTipThanks() {
  S.tip.went = 0; save();
  sheet(`<h2>${t('tip.backTitle')}</h2><p>${t('tip.backQ')}</p><p class="muted">${t('tip.backNote')}</p>
    <div class="row"><button class="btn" id="tipnot">${t('tip.backNo')}</button><button class="btn gold" id="tipyes">${t('tip.backYes')}</button></div>`);
  $('#tipnot').onclick = closeSheet; $('#tipyes').onclick = stop;
}
export const kofiLinkHTML = (label) => `<a class="kofi tiplink2" href="${KOFI_URL}" target="_blank" rel="noopener">${label}</a>`;
document.addEventListener('click', e => { if (e.target.closest('.tiplink2')) { S.tip.went = Date.now(); save(); } });

// ---- local stats cache ----
const seenRounds = new Set();
export function recordRound(view, solo) {
  if (!solo || view.you == null || !view.result) return;
  const k = `${view.round && view.round.number}.${view.result.tile}.${view.result.winner}`;
  if (seenRounds.has(k)) return; seenRounds.add(k);
  if (!S.firstPlay) S.firstPlay = Date.now();
  const p = S.stats.practice, r = view.result;
  p.rounds++;
  if (r.winner === view.you) {
    p.won++; p.streak++; p.bestStreak = Math.max(p.bestStreak, p.streak);
    const kind = r.kind === 'pairs' ? (r.okeyFinish ? 'pairsOkey' : 'pairs') : (r.okeyFinish ? 'okey' : 'sets');
    p.finishes[kind]++;
  } else if (r.winner != null) p.streak = 0;
  save();
}
export function recordMatch(view, won, solo) {
  if (!solo || view.you == null) return;
  const p = S.stats.practice; p.matches++; if (won) p.matchesWon++;
  save();
}
// Achievements are recorded by the server (phase 2) so they can't be faked; practice never unlocks them.
// The server's list is cached in S.stats.ach when it arrives.
