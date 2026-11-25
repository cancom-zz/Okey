// WebAudio-synthesised table sounds: no audio files. Bakelite tiles clacking on wood and felt, the shuffle,
// a soft chime for your turn. Every clack gets a little pitch and level variation so it never sounds canned.
import { S, save } from './store.js';

let ctx = null, master = null, noiseBuf = null;

function ac() {
  if (!ctx) {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!C) return null;
    ctx = new C();
    master = ctx.createGain(); master.gain.value = 0.9 * (S.settings.volume ?? 0.8);
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -14; comp.ratio.value = 4;
    master.connect(comp); comp.connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 1.5), ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}
// Browsers only start audio after a gesture: unlock on the first touch.
const unlock = () => { if (S.settings.sound) ac(); window.removeEventListener('pointerdown', unlock); };
window.addEventListener('pointerdown', unlock);

const rnd = (a, b) => a + Math.random() * (b - a);

function noise(t, dur, { f = 2400, q = 3, gain = 0.2, type = 'bandpass', decay = 5, fEnd } = {}) {
  const s = ctx.createBufferSource(); s.buffer = noiseBuf;
  const flt = ctx.createBiquadFilter(); flt.type = type; flt.frequency.setValueAtTime(f, t); flt.Q.value = q;
  if (fEnd) flt.frequency.exponentialRampToValueAtTime(fEnd, t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur * (decay > 3 ? 1 : 1.2));
  s.connect(flt); flt.connect(g); g.connect(master);
  s.start(t, Math.random() * 1.2, dur + 0.05);
}
function tone(t, f, dur, { gain = 0.08, type = 'sine', fEnd, attack = 0.004 } = {}) {
  const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(f, t);
  if (fEnd) o.frequency.exponentialRampToValueAtTime(fEnd, t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + attack); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g); g.connect(master); o.start(t); o.stop(t + dur + 0.02);
}

// A single bakelite clack: a sharp transient, the tile's hollow body ringing for a few ms, and a soft thump.
function clack(t, level = 1, pitch = 1) {
  const p = pitch * rnd(0.9, 1.12);
  noise(t, 0.028, { f: 3100 * p, q: 2.2, gain: 0.32 * level });
  tone(t, 1250 * p, 0.045, { gain: 0.07 * level, type: 'triangle', fEnd: 1050 * p });
  tone(t, 2650 * p, 0.03, { gain: 0.03 * level, type: 'sine' });
  noise(t + 0.002, 0.06, { f: 260, q: 0.9, gain: 0.12 * level, type: 'lowpass' });
}

// A soft, comic "wah-wah": two descending muted notes, the second one wobbling (you forgot the gösterge).
function wah(t) {
  const note = (t0, f0, f1, d, vib) => {
    const o = ctx.createOscillator(); o.type = 'sawtooth';
    o.frequency.setValueAtTime(f0, t0); o.frequency.exponentialRampToValueAtTime(f1, t0 + d);
    const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.Q.value = 6;
    lp.frequency.setValueAtTime(500, t0); lp.frequency.linearRampToValueAtTime(1300, t0 + 0.09); lp.frequency.linearRampToValueAtTime(520, t0 + d);
    const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(0.06, t0 + 0.04); g.gain.setValueAtTime(0.06, t0 + d * 0.7); g.gain.exponentialRampToValueAtTime(0.0001, t0 + d);
    if (vib) { const l = ctx.createOscillator(), lg = ctx.createGain(); l.frequency.value = 5.5; lg.gain.value = f1 * 0.03; l.connect(lg); lg.connect(o.frequency); l.start(t0 + 0.12); l.stop(t0 + d + 0.02); }
    o.connect(lp); lp.connect(g); g.connect(master); o.start(t0); o.stop(t0 + d + 0.02);
  };
  note(t, 330, 311, 0.34, false);
  note(t + 0.38, 294, 247, 0.85, true);
}
// The slam: a deep wooden thud (the tile hits the table), a hard clack, then the tiles on the table rattle.
function thud(t, level) {
  tone(t, 95, 0.42, { gain: 0.5 * level, fEnd: 38, attack: 0.002 });
  tone(t, 180, 0.16, { gain: 0.18 * level, type: 'triangle', fEnd: 70, attack: 0.002 });
  noise(t, 0.3, { f: 220, q: 0.7, gain: 0.45 * level, type: 'lowpass', fEnd: 90 });
  clack(t + 0.004, 1.1 * level, 0.72);
  for (let k = 0; k < 14; k++) clack(t + 0.05 + Math.pow(k / 14, 1.4) * 0.55, rnd(0.08, 0.3) * level * (1 - k / 18), rnd(0.9, 1.5));
}
// The crowd's "ooh": filtered noise through two vowel formants, swelling in and fading.
function ooh(t, level) {
  const s = ctx.createBufferSource(); s.buffer = noiseBuf;
  const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.32 * level, t + 0.45); g.gain.exponentialRampToValueAtTime(0.0001, t + 1.5);
  [[380, 8, 1], [820, 10, 0.5]].forEach(([f, q, k]) => {
    const b = ctx.createBiquadFilter(); b.type = 'bandpass'; b.Q.value = q;
    b.frequency.setValueAtTime(f * 0.8, t); b.frequency.linearRampToValueAtTime(f, t + 0.5); b.frequency.linearRampToValueAtTime(f * 0.9, t + 1.5);
    const kg = ctx.createGain(); kg.gain.value = k; s.connect(b); b.connect(kg); kg.connect(g);
  });
  g.connect(master); s.start(t, Math.random() * 0.2, 1.6);
}

export function sfx(kind, opt = {}) {
  if (!S.settings.sound) return;
  const c = ac(); if (!c) return;
  const t = c.currentTime + 0.005;
  try {
    switch (kind) {
      case 'clack': clack(t, opt.level || 1, opt.pitch || 1); break;
      case 'settle': clack(t, 0.9); clack(t + rnd(0.055, 0.075), 0.28, 1.08); break;   // lands, then a tiny rattle
      case 'tick': clack(t, 0.35, 1.25); break;                                      // sliding along the rack
      case 'rack': clack(t, 0.6 * (opt.level || 1), 0.92); tone(t, rnd(210, 240), 0.09, { gain: 0.05 * (opt.level || 1), type: 'triangle', fEnd: 160 }); break;   // into a wooden slot
      case 'felt': noise(t, 0.07, { f: 700, q: 0.7, gain: 0.16, type: 'lowpass' }); clack(t + 0.004, 0.42, 0.82); break;   // on the cloth, muffled
      case 'stack': clack(t, 0.85, 1.22); clack(t + rnd(0.03, 0.045), 0.3, 1.35); break;   // tile on tile, bright
      case 'chime': [1318, 1976, 2637].forEach((f, i) => tone(t + i * 0.012, f, 1.4 - i * 0.3, { gain: 0.035 / (i + 1), attack: 0.003 })); break;   // the okey is revealed
      case 'pick': noise(t, 0.09, { f: 1800, q: 1.4, gain: 0.06, fEnd: 3400 }); clack(t + 0.06, 0.4, 1.15); break;
      case 'draw': noise(t, 0.14, { f: 900, q: 0.8, gain: 0.08, fEnd: 2600 }); clack(t + 0.12, 0.55, 1.05); break;
      case 'flip': noise(t, 0.08, { f: 4200, q: 1, gain: 0.05, fEnd: 1800 }); clack(t + 0.07, 0.45, 1.2); break;
      case 'deal': for (let k = 0; k < 5; k++) clack(t + k * rnd(0.018, 0.03), 0.35 + Math.random() * 0.2, 1.05); break;
      case 'shuffle': {   // tiles rattling as the pile is mixed
        noise(t, 1.1, { f: 1500, q: 0.6, gain: 0.05, decay: 2 });
        for (let k = 0; k < 36; k++) clack(t + rnd(0, 1.05), rnd(0.12, 0.42), rnd(0.85, 1.3));
        break;
      }
      case 'turn': tone(t, 784, 0.22, { gain: 0.05 }); tone(t + 0.11, 1175, 0.32, { gain: 0.045 }); break;
      case 'tock': tone(t, 1600, 0.04, { gain: 0.035, type: 'triangle' }); break;       // timer running out
      case 'win': [523, 659, 784, 1047, 1319].forEach((f, i) => tone(t + i * 0.085, f, 0.45, { gain: 0.05 })); break;
      case 'okey': [659, 880, 1109, 1319, 1760].forEach((f, i) => tone(t + i * 0.07, f, 0.6, { gain: 0.05, type: 'triangle' })); break;
      case 'lose': tone(t, 440, 0.3, { gain: 0.04, fEnd: 330 }); tone(t + 0.16, 392, 0.4, { gain: 0.035, fEnd: 262 }); break;
      case 'pop': tone(t, 520, 0.09, { gain: 0.05, fEnd: 980 }); break;
      case 'error': tone(t, 180, 0.14, { gain: 0.05, type: 'square', fEnd: 140 }); break;
      case 'fanfare': [392, 523, 659, 784, 659, 784, 1047].forEach((f, i) => tone(t + i * 0.12, f, 0.5, { gain: 0.05, type: i % 2 ? 'sine' : 'triangle' })); break;
      case 'dice': {   // two dice tumbling on the felt: quick bright knocks that spread out as they slow
        let at = t; for (let k = 0; k < 9; k++) { clack(at, rnd(0.18, 0.4) * (1 - k * 0.06), rnd(1.5, 1.9)); at += 0.035 + k * k * 0.004; }
        break;
      }
      case 'slide': noise(t, 0.16, { f: 600, q: 0.6, gain: 0.07 * (opt.level || 1), type: 'lowpass', fEnd: 380 }); clack(t + 0.13, 0.4 * (opt.level || 1), 0.95); break;   // a stack pushed over the cloth
      case 'wah': wah(t); break;
      case 'thud': thud(t, opt.level || 1); break;
      case 'ooh': ooh(t, opt.level || 1); break;
      default: break;
    }
  } catch { /* audio is a nicety */ }
}

export function setVolume(v) {
  S.settings.volume = Math.max(0, Math.min(1, v)); save();
  if (master) master.gain.value = 0.9 * S.settings.volume;
}
// A tiny tap on drops (phones that support it), only with sound on and the setting on.
export function buzz(ms = 8) {
  try { if (S.settings.haptics && S.settings.sound && navigator.vibrate) navigator.vibrate(ms); } catch { /* not supported */ }
}

export function setSound(on) {
  S.settings.sound = !!on; save();
  if (on) { ac(); sfx('pop'); }
}
