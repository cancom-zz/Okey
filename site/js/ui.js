// Shared UI pieces: escaping, toasts (one at a time), sheets (modals), celebration banners with gold sparks.
import { t } from './i18n.js';
import { sfx } from './sound.js';
import { reduced } from './anim.js';

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
export const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---- toasts: one at a time; a new message replaces the last ----
export function toast(html, cls = '', ms = 2600) {
  const box = $('#toasts'); if (!box) return;
  const el = document.createElement('div');
  el.className = 'toast ' + cls; el.innerHTML = html;
  box.replaceChildren(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 320); }, ms);
  return el;
}

// ---- sheets ----
let returnFocus = null, onCloseFn = null;
export const sheetOpen = () => !!$('#modal').innerHTML;
export function sheet(html, { cls = '', onClose = null, wide = false } = {}) {
  const m = $('#modal');
  if (!m.innerHTML) returnFocus = document.activeElement;
  if (onCloseFn) { const f = onCloseFn; onCloseFn = null; f(); }
  onCloseFn = onClose;
  m.innerHTML = `<div class="mask"><div class="sheet ${cls} ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="mtitle">
    <button class="x" id="mx" aria-label="${esc(t('close'))}">✕</button>${html.replace('<h2', '<h2 id="mtitle"')}</div></div>`;
  $('#mx').onclick = closeSheet;
  $('.mask', m).addEventListener('pointerdown', e => { if (e.target.classList.contains('mask')) closeSheet(); });
  $('#mx').focus({ preventScroll: true });
  return $('.sheet', m);
}
export function closeSheet() {
  const m = $('#modal'); if (!m.innerHTML) return;
  const s = $('.sheet', m);
  const done = () => {
    m.innerHTML = '';
    if (onCloseFn) { const f = onCloseFn; onCloseFn = null; f(); }
    if (returnFocus && returnFocus.isConnected) returnFocus.focus({ preventScroll: true });
    returnFocus = null;
  };
  if (s && !reduced()) { s.classList.add('closing'); m.firstElementChild.classList.add('closing'); setTimeout(done, 170); } else done();
}
document.addEventListener('keydown', e => { if (e.key === 'Escape' && sheetOpen()) closeSheet(); });

// ---- celebration: a gold banner, a chime and sparks. Banners share one queue. ----
const queue = []; let busy = false;
export function banner(title, sub = '', cls = 'gold', ms = 2400) {
  queue.push({ title, sub, cls, ms }); if (!busy) nextBanner();
}
function nextBanner() {
  const it = queue.shift(); if (!it) { busy = false; return; }
  busy = true;
  const b = document.createElement('div');
  b.className = 'banner ' + it.cls; b.setAttribute('role', 'status');
  b.innerHTML = `<b>${esc(it.title)}</b>${it.sub ? `<span>${esc(it.sub)}</span>` : ''}`;
  const felt = $('.felt');
  if (felt) { const r = felt.getBoundingClientRect(); b.style.left = (r.left + r.width / 2) + 'px'; b.style.top = (r.top + r.height * 0.42) + 'px'; }
  document.body.appendChild(b);
  setTimeout(() => { b.remove(); nextBanner(); }, queue.length ? 1500 : it.ms);
}
export function clearBanners() { queue.length = 0; $$('body>.banner').forEach(b => b.remove()); busy = false; }

export function celebrate(title, sub, { sound = 'win', sparks = 40 } = {}) {
  banner(title, sub, 'gold');
  sfx(sound);
  Sparks.burst(sparks);
}

// Gold sparks on a canvas over the table: a few dozen particles, ~30 fps, nothing runs while idle.
export const Sparks = {
  ps: [], raf: 0, cv: null, last: 0,
  burst(n = 40, x, y) {
    if (reduced()) return;
    const cv = this.canvas(); const w = cv.clientWidth, h = cv.clientHeight;
    const cx = x ?? w / 2, cy = y ?? h * 0.42;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, sp = 2 + Math.random() * 5;
      this.ps.push({ x: cx, y: cy, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp - 2.5, life: 0, max: 50 + Math.random() * 45,
        s: 1.5 + Math.random() * 2.5, hue: 38 + Math.random() * 16, rot: Math.random() * 6, conf: Math.random() < 0.45 });
    }
    if (!this.raf) this.raf = requestAnimationFrame(tm => this.step(tm));
  },
  canvas() {
    let cv = $('#sparks');
    if (!cv) { cv = document.createElement('canvas'); cv.id = 'sparks'; document.body.appendChild(cv); }
    const dpr = Math.min(2, devicePixelRatio || 1);
    if (cv.width !== Math.round(innerWidth * dpr)) { cv.width = Math.round(innerWidth * dpr); cv.height = Math.round(innerHeight * dpr); }
    this.cv = cv; return cv;
  },
  step(now) {
    this.raf = 0;
    if (now - this.last < 30) { this.raf = requestAnimationFrame(tm => this.step(tm)); return; }
    this.last = now;
    const cv = this.cv, x = cv.getContext('2d'), dpr = cv.width / innerWidth;
    x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, innerWidth, innerHeight);
    this.ps = this.ps.filter(p => {
      p.life++; p.x += p.vx; p.y += p.vy; p.vx *= 0.975; p.vy = p.vy * 0.975 + 0.16; p.rot += 0.2;
      const k = 1 - p.life / p.max; if (k <= 0) return false;
      x.globalAlpha = Math.min(1, k * 1.6);
      if (p.conf) {
        x.save(); x.translate(p.x, p.y); x.rotate(p.rot); x.fillStyle = `hsl(${p.hue},85%,${55 + 20 * Math.sin(p.rot)}%)`;
        x.fillRect(-p.s * 1.6, -p.s * 0.6, p.s * 3.2, p.s * 1.2); x.restore();
      } else {
        x.fillStyle = `hsl(${p.hue},100%,75%)`; x.beginPath(); x.arc(p.x, p.y, p.s * k + 0.4, 0, 7); x.fill();
      }
      return true;
    });
    x.globalAlpha = 1;
    if (this.ps.length) this.raf = requestAnimationFrame(tm => this.step(tm)); else x.clearRect(0, 0, innerWidth, innerHeight);
  },
};

// Copy text with a fallback for older browsers.
export async function copyText(s) {
  try { await navigator.clipboard.writeText(s); return true; } catch {
    const ta = document.createElement('textarea'); ta.value = s; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove(); return ok;
  }
}
