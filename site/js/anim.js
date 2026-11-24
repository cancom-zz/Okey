// Animation helpers on the Web Animations API. Everything respects prefers-reduced-motion and the speed setting.
import { S } from './store.js';
import { SPEEDS } from './config.js';
import { tileClass, tileInner } from './tiles.js';

const params = new URLSearchParams(location.search);
const animOff = params.get('anim') === '0';
if (animOff) document.documentElement.classList.add('noanim');   // tests: no CSS motion either
let mq = null;
try { mq = matchMedia('(prefers-reduced-motion: reduce)'); } catch { /* ignore */ }

export const reduced = () => animOff || !!(mq && mq.matches);
export const dur = ms => (reduced() ? 0 : Math.round(ms * (SPEEDS[S.settings.speed] || 1)));
export const wait = ms => { const d = dur(ms); return d > 0 ? new Promise(r => setTimeout(r, d)) : Promise.resolve(); };
export const nextFrame = () => new Promise(r => requestAnimationFrame(() => r()));

const layer = () => {
  let l = document.getElementById('fx');
  if (!l) { l = document.createElement('div'); l.id = 'fx'; document.body.appendChild(l); }
  return l;
};

export function rectOf(el) {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}
const center = r => ({ x: r.left + r.width / 2, y: r.top + r.height / 2 });

// A tile flying from one rect to another along an arc, optionally turning over on the way.
//   face: id shown at the end (null/-1 = a back). start: 'back' | 'face'. tilt: degrees of spin in flight.
export function flyTile({ id = null, okey = null, from, to, start, ms = 420, arc = 0.22, tilt = 0, size, keep = false, cls = '', delay = 0, easing }) {
  if (!from || !to) return Promise.resolve(null);
  const d = dur(ms);
  if (!d) return Promise.resolve(null);
  const w = size ? size.width : to.width, h = size ? size.height : to.height;
  const el = document.createElement('div');
  el.className = 'fly ' + cls;
  el.style.cssText = `left:${center(to).x - w / 2}px;top:${center(to).y - h / 2}px;width:${w}px;height:${h}px;--tw:${w}px`;
  const faceUp = id != null && id >= 0;
  const startBack = start === 'back' || (start == null && !faceUp);
  el.innerHTML = `<div class="flipper"><div class="${tileClass(faceUp ? id : null, okey)} front">${faceUp ? tileInner(id) : ''}</div><div class="tile back rear"></div></div>`;
  layer().appendChild(el);
  const a = center(from), b = center(to);
  const dx = a.x - b.x, dy = a.y - b.y, s0 = from.width / w;
  const dist = Math.hypot(dx, dy), lift = Math.min(160, dist * arc);
  const frames = [
    { transform: `translate(${dx}px,${dy}px) scale(${s0}) rotate(0deg)`, offset: 0 },
    { transform: `translate(${dx * 0.45}px,${dy * 0.45 - lift}px) scale(${(s0 + 1) / 2 * 1.12}) rotate(${tilt / 2}deg)`, offset: 0.5 },
    { transform: 'translate(0,0) scale(1) rotate(0deg)', offset: 1 },
  ];
  const anim = el.animate(frames, { duration: d, delay: dur(delay), easing: easing || 'cubic-bezier(.3,.7,.35,1)', fill: 'both' });
  const flipper = el.firstElementChild;
  const endBack = !faceUp;
  if (startBack !== endBack) {
    flipper.animate([{ transform: `rotateY(${startBack ? 180 : 0}deg)` }, { transform: `rotateY(${endBack ? 180 : 0}deg)` }],
      { duration: d * 0.7, delay: dur(delay) + d * 0.15, easing: 'ease-in-out', fill: 'both' });
  } else flipper.style.transform = `rotateY(${endBack ? 180 : 0}deg)`;
  return anim.finished.then(() => { if (!keep) el.remove(); return el; }, () => { el.remove(); return null; });
}

// A block of tile backs (a stack of 5 while dealing) flying from the centre to a seat.
export function flyStack({ from, to, n = 5, ms = 360, delay = 0, vertical = false }) {
  if (!from || !to) return Promise.resolve();
  const d = dur(ms); if (!d) return Promise.resolve();
  const el = document.createElement('div');
  el.className = 'fly stack5' + (vertical ? ' v' : '');
  const tw = Math.max(10, Math.min(from.width, 26));
  el.style.cssText = `--tw:${tw}px;left:${center(to).x}px;top:${center(to).y}px`;
  el.innerHTML = Array.from({ length: n }, (_, i) => `<i style="--i:${i}"></i>`).join('');
  layer().appendChild(el);
  const a = center(from), b = center(to);
  const anim = el.animate([
    { transform: `translate(-50%,-50%) translate(${a.x - b.x}px,${a.y - b.y}px) scale(1.1)`, opacity: 0.4 },
    { transform: `translate(-50%,-50%) translate(${(a.x - b.x) * 0.4}px,${(a.y - b.y) * 0.4 - 18}px) scale(1.12)`, opacity: 1, offset: 0.45 },
    { transform: 'translate(-50%,-50%) scale(.9)', opacity: 1 },
  ], { duration: d, delay: dur(delay), easing: 'cubic-bezier(.3,.7,.35,1)', fill: 'both' });
  return anim.finished.then(() => el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, fill: 'both' }).finished).then(() => el.remove(), () => el.remove());
}

// Turn an element over in 3D: first half shows what it is, then apply() swaps the face, second half lands.
export async function flipOver(el, apply, ms = 560) {
  const d = dur(ms);
  if (!d || !el) { apply && apply(); return; }
  el.style.transformStyle = 'preserve-3d';
  await el.animate([{ transform: 'perspective(500px) rotateY(0deg) translateZ(0)' }, { transform: 'perspective(500px) rotateY(90deg) translateZ(10px) scale(1.15)' }],
    { duration: d / 2, easing: 'ease-in', fill: 'forwards' }).finished.catch(() => {});
  apply && apply();
  await el.animate([{ transform: 'perspective(500px) rotateY(-90deg) translateZ(10px) scale(1.15)' }, { transform: 'perspective(500px) rotateY(0deg) translateZ(0)' }],
    { duration: d / 2, easing: 'cubic-bezier(.2,.9,.3,1.25)', fill: 'forwards' }).finished.catch(() => {});
  el.getAnimations().forEach(a => a.cancel());
}

// A little landing bounce for something that just arrived.
export function settle(el, strength = 1) {
  if (!el || reduced()) return;
  el.animate([
    { transform: `translateY(${-6 * strength}px) scale(${1 + 0.06 * strength})` },
    { transform: `translateY(${1.5 * strength}px) scale(${1 - 0.02 * strength})`, offset: 0.55 },
    { transform: 'none' },
  ], { duration: dur(260), easing: 'ease-out' });
}

export function pulse(el, cls = 'pulse', ms = 900) {
  if (!el) return;
  el.classList.remove(cls); void el.offsetWidth; el.classList.add(cls);
  setTimeout(() => el.classList.remove(cls), dur(ms) || 10);
}

export function shake(el) {
  if (!el || reduced()) return;
  el.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(-6px)' }, { transform: 'translateX(6px)' }, { transform: 'translateX(-3px)' }, { transform: 'none' }], { duration: 300 });
}

// ---- geometry-based flights (opponents, the pile, discards, the deal, the finish) ----
// A geometry is { cx, cy, w, h, rot }: the centre of an element, its UNROTATED size and its rotation in degrees.
// Every flight ends exactly on its target geometry and calls onLand in the same task that removes the flying
// element, so the real element takes its place without a frame of gap, jump or pop.
export function geomOf(el, w, h, rot = 0) {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { cx: r.left + r.width / 2, cy: r.top + r.height / 2, w: w ?? r.width, h: h ?? r.height, rot };
}
export const sleep = ms => (ms > 0 ? new Promise(r => setTimeout(r, ms)) : Promise.resolve());
const FLIP_AT = { early: [0.06, 0.46], mid: [0.25, 0.75], late: [0.52, 0.94] };

//   faceFrom / faceTo: true = face up (needs id). flipAt: 'early' | 'mid' | 'late'. lift: arc height factor.
export async function fly({ id = null, okey = null, from, to, faceFrom = false, faceTo = false, flipAt = 'mid', ms = 340, arc = 0.2, delay = 0, cls = '', onLaunch, onLand }) {
  const d = dur(ms);
  if (delay) await sleep(dur(delay));
  onLaunch && onLaunch();
  if (!d || !from || !to) { onLand && onLand(); return; }
  const el = document.createElement('div');
  el.className = 'fly ' + cls;
  el.style.cssText = `left:${to.cx - to.w / 2}px;top:${to.cy - to.h / 2}px;width:${to.w}px;height:${to.h}px;--tw:${to.w}px`;
  const shows = id != null && id >= 0 && (faceFrom || faceTo);
  el.innerHTML = `<div class="flipper"><div class="${shows ? tileClass(id, okey) : 'tile back'} front">${shows ? tileInner(id) : ''}</div><div class="tile back rear"></div></div>`;
  layer().appendChild(el);
  const dx = from.cx - to.cx, dy = from.cy - to.cy, s0 = from.w / to.w;
  const lift = Math.min(90, Math.hypot(dx, dy) * arc);
  // turn the short way round
  let r0 = from.rot || 0, r1 = to.rot || 0;
  while (r0 - r1 > 180) r0 -= 360;
  while (r1 - r0 > 180) r0 += 360;
  const main = el.animate([
    { transform: `translate(${dx}px,${dy}px) rotate(${r0}deg) scale(${s0})`, offset: 0 },
    { transform: `translate(${dx * 0.5}px,${dy * 0.5 - lift}px) rotate(${(r0 + r1) / 2}deg) scale(${((s0 + 1) / 2) * 1.07})`, offset: 0.5 },
    { transform: `translate(0px,0px) rotate(${r1}deg) scale(1)`, offset: 1 },
  ], { duration: d, easing: 'cubic-bezier(.33,0,.2,1)', fill: 'both' });
  const flipper = el.firstElementChild;
  const a = faceFrom && shows ? 0 : 180, b = faceTo && shows ? 0 : 180;
  if (a !== b) {
    const [f0, f1] = FLIP_AT[flipAt] || FLIP_AT.mid;
    flipper.animate([{ transform: `rotateY(${a}deg)`, offset: 0 }, { transform: `rotateY(${a}deg)`, offset: f0 }, { transform: `rotateY(${b}deg)`, offset: f1 }, { transform: `rotateY(${b}deg)`, offset: 1 }],
      { duration: d, easing: 'ease-in-out', fill: 'both' });
  } else flipper.style.transform = `rotateY(${a}deg)`;
  try { await main.finished; } catch { /* cancelled */ }
  onLand && onLand();
  el.remove();
}

// A landing: a tiny settle with a rotation wobble. Relative to the element's resting pose, which the page keeps in
// the individual `translate` / `rotate` properties so `transform` is free for animations (no jump at either end).
export function land(el, strength = 1) {
  if (!el || reduced()) return;
  el.animate([
    { transform: `translateY(${-2.5 * strength}px) rotate(${1.8 * strength}deg) scale(${1 + 0.035 * strength})` },
    { transform: `translateY(${0.6 * strength}px) rotate(${-0.8 * strength}deg) scale(.995)`, offset: 0.55 },
    { transform: 'none' },
  ], { duration: dur(230), easing: 'ease-out' });
}
