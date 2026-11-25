// First-time guide (like The Felt's renderGuide): three short steps per variant, pointing at the real thing on the
// table. Shown once per variant, skippable, and skipped for players who already have rounds played.
import { t } from './i18n.js';
import { S } from './store.js';
import { $, esc } from './ui.js';
import { sfx } from './sound.js';

const KEY = 'okey.guide.v1';
const STEPS = {
  classic: [
    { target: '#pile', alt: '.ds.d3', text: 'guide.c1' },
    { target: '.ds.d0 .dstack', text: 'guide.c2' },
    { target: '#pile', text: 'guide.c3' },
  ],
  101: [
    { target: '#o101:not([hidden])', alt: '#rack', text: 'guide.k1' },
    { target: '#melds:not([hidden])', alt: '.center', text: 'guide.k2' },
    { target: '.ds.d0 .dstack', text: 'guide.k3' },
  ],
};

function seen() { try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { return {}; } }
function mark(v) { try { const s = seen(); s[v] = true; localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode */ } }
const played = () => { const p = S.stats && S.stats.practice; return !!(p && p.rounds > 0); };

let current = null;
export const guideOpen = () => !!current;

// Start the guide for this variant if it has never been shown (call when it becomes your turn).
export function maybeGuide(root, variant) {
  if (current || document.querySelector('#modal .sheet')) return;
  const v = variant === '101' ? '101' : 'classic';
  if (seen()[v]) return;
  if (played()) { mark(v); return; }
  current = { root, v, step: 0 };
  show();
}
export function closeGuide(done = true) {
  if (!current) return;
  if (done) mark(current.v);
  const el = document.getElementById('guide'); if (el) el.remove();
  current = null;
}
// keep the bubble on its target when the table re-lays out
export function placeGuide() { if (current) show(); }

function show() {
  const { root, v, step } = current, s = STEPS[v][step];
  const target = root.querySelector(s.target) || (s.alt && root.querySelector(s.alt));
  let el = document.getElementById('guide');
  if (!el) { el = document.createElement('div'); el.id = 'guide'; el.className = 'guide'; el.setAttribute('role', 'note'); document.body.appendChild(el); }
  const last = step === STEPS[v].length - 1;
  el.innerHTML = `<b class="gstep">${step + 1} / ${STEPS[v].length}</b><p>${t(s.text)}</p>
    <div class="gact"><button class="gskip" id="gSkip">${esc(t('guide.skip'))}</button><button class="gnext" id="gNext">${esc(t(last ? 'guide.done' : 'guide.next'))}</button></div>`;
  document.getElementById('gSkip').onclick = () => closeGuide(true);
  document.getElementById('gNext').onclick = () => { sfx('tick'); if (last) closeGuide(true); else { current.step++; show(); } };
  // place it above the target (below when there is no room), arrow pointing at it
  const W = innerWidth, H = innerHeight, w = el.offsetWidth, h = el.offsetHeight;
  const r = target ? target.getBoundingClientRect() : { left: W / 2, right: W / 2, top: H / 2, bottom: H / 2, width: 0, height: 0 };
  const cx = r.left + r.width / 2, left = Math.max(8, Math.min(W - w - 8, cx - w / 2));
  const above = r.top - h - 14 >= 50;
  el.classList.toggle('below', !above);
  el.style.left = left + 'px';
  el.style.top = (above ? r.top - h - 14 : Math.min(H - h - 8, r.bottom + 14)) + 'px';
  el.style.setProperty('--ax', Math.max(14, Math.min(w - 14, cx - left)) + 'px');
  if (target) { target.classList.add('guided'); setTimeout(() => target.classList.remove('guided'), 1600); }
  void $;
}

// The player did something on their turn: the guide moves on by itself (doing the step counts as reading it).
export function advanceGuide() {
  if (!current) return;
  if (current.step >= STEPS[current.v].length - 1) { closeGuide(true); return; }
  current.step++;
  setTimeout(() => { if (current) show(); }, 350);
}
