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
  const endBack = !faceUp;
  turnOver(el.firstElementChild, !startBack, !endBack, d, [0.15, 0.85], dur(delay));
  return anim.finished.then(() => { if (!keep) el.remove(); return el; }, () => { el.remove(); return null; });
}


// Turn an element over in 3D: first half shows what it is, then apply() swaps the face, second half lands.
export async function flipOver(el, apply, ms = 560) {
  const d = dur(ms);
  if (!d || !el) { apply && apply(); return; }
  // lift and squash to a third of its width (never edge-on), swap the face, widen and settle
  await el.animate([{ transform: 'translateY(0) scale(1,1)' }, { transform: 'translateY(-7px) scale(.3,1.08)' }],
    { duration: d * 0.45, easing: 'cubic-bezier(.5,0,.75,.4)', fill: 'forwards' }).finished.catch(() => {});
  apply && apply();
  await el.animate([{ transform: 'translateY(-7px) scale(.3,1.08)' }, { transform: 'translateY(0) scale(1,1)' }],
    { duration: d * 0.55, easing: 'cubic-bezier(.2,.9,.3,1.25)', fill: 'forwards' }).finished.catch(() => {});
  el.getAnimations().forEach(a => a.cancel());
}

// Turn a flying tile over inside [f0, f1] of its flight: the pair narrows to ~30% width, the faces swap at the
// narrowest moment, and it widens again. No 3D, so there is never an edge-on sliver.
function turnOver(flipper, faceFrom, faceTo, d, [f0, f1], delay = 0) {
  const front = flipper.querySelector('.front'), rear = flipper.querySelector('.rear');
  const show = up => { front.style.opacity = up ? '1' : '0'; rear.style.opacity = up ? '0' : '1'; };
  if (faceFrom === faceTo) { show(faceTo); return; }
  show(faceFrom);
  const fm = (f0 + f1) / 2, opt = { duration: d, delay, fill: 'both' };
  flipper.animate([{ transform: 'scaleX(1)', offset: 0 }, { transform: 'scaleX(1)', offset: f0 }, { transform: 'scaleX(.3)', offset: fm, easing: 'ease-out' },
    { transform: 'scaleX(1)', offset: f1 }, { transform: 'scaleX(1)', offset: 1 }], { ...opt, easing: 'ease-in' });
  const sw = (el, a, b) => el.animate([{ opacity: a, offset: 0 }, { opacity: a, offset: fm }, { opacity: b, offset: Math.min(1, fm + 0.001) }, { opacity: b, offset: 1 }], opt);
  sw(front, faceFrom ? 1 : 0, faceTo ? 1 : 0); sw(rear, faceFrom ? 0 : 1, faceTo ? 0 : 1);
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
  turnOver(el.firstElementChild, faceFrom && shows, faceTo && shows, d, FLIP_AT[flipAt] || FLIP_AT.mid);
  const t0 = performance.now();
  try { await main.finished; } catch { /* cancelled */ }
  if (globalThis.__okeyFlights) globalThis.__okeyFlights.push([t0, performance.now()]);   // test hook (perf.pw.mjs)
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
