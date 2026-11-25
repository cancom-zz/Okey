// Local, per-device state: identity, profile, settings, tip-ask bookkeeping and a stats cache.
// Saved data is untrusted: every field is type-checked on load and falls back to its default.
import { STORE_KEY, AVATARS, FELTS, SPEEDS, LEVELS, RACK_KEY, RACK_KEEP } from './config.js';
import { emptyStats, sanitizeStats, ACHIEVEMENT_IDS } from '../shared/achievements.js';

const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
  : ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)));

function defaults() {
  return {
    v: 1,
    id: uuid(),
    secret: uuid(),
    name: '',
    avatar: AVATARS[Math.floor(Math.random() * 8)],
    settings: { lang: '', sound: true, speed: 'normal', felt: 'green', soloLevel: 'kalfa', soloVariant: 'classic', hints: true, volume: 0.8, haptics: true, reverseOkey: true, okeyGuard: true },
    tip: { play: 0, at: 0, next: 0, went: 0, done: false },
    // Stats (owned by stats.js; rules in shared/achievements.js). practice: solo results on this device, per
    // variant; practiceAch: id -> ms first unlocked in practice; online: the last copy fetched from the server.
    stats: { practice: emptyStats(), practiceAch: {}, online: null },
    firstPlay: 0,
  };
}

const isStr = (x, max = 200) => typeof x === 'string' && x.length <= max;
const isNum = x => typeof x === 'number' && Number.isFinite(x);
const n0 = x => (isNum(x) && x >= 0 ? Math.floor(x) : 0);

function sanitize(raw) {
  const d = defaults();
  if (!raw || typeof raw !== 'object') return d;
  const s = d;
  if (isStr(raw.id, 64) && raw.id.length >= 8) s.id = raw.id;
  if (isStr(raw.secret, 64) && raw.secret.length >= 8) s.secret = raw.secret;
  if (isStr(raw.name, 40)) s.name = cleanName(raw.name);
  if (isStr(raw.avatar, 16)) s.avatar = raw.avatar;
  const st = raw.settings || {};
  if (['tr', 'en', ''].includes(st.lang)) s.settings.lang = st.lang;
  if (typeof st.sound === 'boolean') s.settings.sound = st.sound;
  if (st.speed in SPEEDS) s.settings.speed = st.speed;
  if (FELTS.includes(st.felt)) s.settings.felt = st.felt;
  if (LEVELS.includes(st.soloLevel)) s.settings.soloLevel = st.soloLevel;
  if (st.soloVariant === 'classic' || st.soloVariant === '101') s.settings.soloVariant = st.soloVariant;
  if (typeof st.volume === 'number' && st.volume >= 0 && st.volume <= 1) s.settings.volume = st.volume;
  if (typeof st.haptics === 'boolean') s.settings.haptics = st.haptics;
  if (typeof st.reverseOkey === 'boolean') s.settings.reverseOkey = st.reverseOkey;
  if (typeof st.okeyGuard === 'boolean') s.settings.okeyGuard = st.okeyGuard;
  if (typeof st.hints === 'boolean') s.settings.hints = st.hints;
  const tp = raw.tip || {};
  for (const k of ['play', 'at', 'next', 'went']) s.tip[k] = n0(tp[k]);
  s.tip.done = tp.done === true;
  const rs = raw.stats && typeof raw.stats === 'object' ? raw.stats : {};
  s.stats.practice = sanitizeStats(rs.practice);
  s.stats.practiceAch = cleanAch(rs.practiceAch);
  const on = rs.online;
  if (on && typeof on === 'object') s.stats.online = { stats: sanitizeStats(on.stats), achievements: cleanAch(on.achievements), at: n0(on.at) };
  s.firstPlay = n0(raw.firstPlay);
  return s;
}

/** Achievement unlock times: known ids only. */
export function cleanAch(raw) {
  const out = {};
  if (raw && typeof raw === 'object') for (const id of ACHIEVEMENT_IDS) if (isNum(raw[id]) && raw[id] > 0) out[id] = Math.floor(raw[id]);
  return out;
}

// Names: 1–20 visible characters, no control or invisible characters, collapsed spaces.
export function cleanName(x) {
  return String(x || '').normalize('NFC').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁯﻿]/g, '')
    .replace(/\s+/g, ' ').trim().slice(0, 20);
}

function read() {
  try { return sanitize(JSON.parse(localStorage.getItem(STORE_KEY) || 'null')); } catch { return defaults(); }
}

export const S = read();

export function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(S)); } catch { /* private mode: play on without saving */ }
}
save();

export const player = () => ({ id: S.id, secret: S.secret, name: S.name || 'Oyuncu', avatar: S.avatar });

// ---- rack layouts, keyed by room + round ----
export function loadRack(key) {
  try {
    const a = JSON.parse(localStorage.getItem(RACK_KEY + key) || 'null');
    return Array.isArray(a) ? a : null;
  } catch { return null; }
}
export function saveRack(key, slots) {
  try {
    localStorage.setItem(RACK_KEY + key, JSON.stringify(slots));
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith(RACK_KEY) && !k.endsWith('#t')) keys.push(k); }
    if (keys.length > RACK_KEEP) {
      const stamp = k => { try { return JSON.parse(localStorage.getItem(k + '#t') || '0'); } catch { return 0; } };
      keys.sort((a, b) => stamp(a) - stamp(b)).slice(0, keys.length - RACK_KEEP).forEach(k => { localStorage.removeItem(k); localStorage.removeItem(k + '#t'); });
    }
    localStorage.setItem(RACK_KEY + key + '#t', String(Date.now()));
  } catch { /* ignore */ }
}
