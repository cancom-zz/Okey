// Every user-visible string goes through t('key'). Turkish is primary and the default.
import tr from '../i18n/tr.js';
import en from '../i18n/en.js';
import { S, save } from './store.js';

const TABLES = { tr, en };
let lang = S.settings.lang || 'tr';
const listeners = new Set();

export const getLang = () => lang;

export function setLang(l) {
  if (!TABLES[l]) return;
  lang = l; S.settings.lang = l; save();
  document.documentElement.lang = l;
  listeners.forEach(f => f(l));
}
export const onLang = f => listeners.add(f);

// t('key', { name: 'Can' }) -> fills {name}. Missing keys fall back to Turkish, then to the key itself (visible in tests).
export function t(key, vars) {
  let s = TABLES[lang][key];
  if (s === undefined) s = tr[key];
  if (s === undefined) return key;
  if (typeof s === 'function') return s(vars || {});
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));
  return s;
}

// Apply translations to static markup: data-i18n (text), data-i18n-aria (aria-label), data-i18n-title.
export function applyStatic(root = document) {
  root.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  root.querySelectorAll('[data-i18n-aria]').forEach(el => { el.setAttribute('aria-label', t(el.dataset.i18nAria)); });
  root.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.dataset.i18nTitle); });
}

document.documentElement.lang = lang;
