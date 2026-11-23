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
