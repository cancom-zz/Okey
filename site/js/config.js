// Client configuration. Plain constants only: nothing here runs game code.

// Tips only. Never tied to anything in the game. Placeholder until the owner confirms the page.
export const KOFI_URL = 'https://ko-fi.com/thefelt';

export const STORE_KEY = 'okey.v1';
export const RACK_KEY = 'okey.rack.';       // + room code + '.' + round number
export const RACK_KEEP = 12;                // rack layouts kept in localStorage (oldest dropped)

// The ıstaka: two tiers of 13 slots. 15 tiles at most, so there is always room for gaps between groups.
export const COLS = 13;
export const TIERS = 2;
export const SLOTS = COLS * TIERS;

export const LEVELS = ['cirak', 'kalfa', 'usta', 'uzman'];

// Custom bot sliders (DESIGN.md "Bots"): [param, min, max, step, start value per level cirak/kalfa/usta/uzman].
// Ranges match the host's BOT_PARAM_RANGES; start values match LEVELS in site/shared/bots/index.js.
export const BOT_PARAMS = [
  ['memory', 0, 0.9, 0.05, [0.25, 0.5, 0.7, 0.85]],
  ['decay', 0.01, 0.3, 0.01, [0.12, 0.07, 0.04, 0.02]],
  ['lookahead', 1, 4, 1, [1, 2, 3, 4]],
  ['defense', 0, 1, 0.05, [0, 0.3, 0.6, 0.85]],
  ['takeDiscard', 0, 1, 0.05, [0.7, 0.6, 0.4, 0.3]],
  ['pairsBias', 0, 2, 0.05, [0.85, 0.95, 1, 1]],
  ['blunder', 0, 0.5, 0.01, [0.25, 0.12, 0.06, 0.02]],
  ['speed', 0.25, 3, 0.05, [1.35, 1.15, 1, 0.9]],
];

export const AVATARS = ['🦊', '🐻', '🐱', '🦁', '🐼', '🐯', '🐸', '🦉', '🐢', '🐧', '🐙', '🦄', '🐝', '🐺', '🦜', '🐨', '🌻', '☕', '🎩', '⚓'];
export const BOT_AVATAR = { cirak: '🐣', kalfa: '🦊', usta: '🦉', uzman: '🐺' };

// Preset emotes only (no free chat: safe by design). ids are what the server sees.
export const EMOTES = [
  { id: 'clap', e: '👏' },
  { id: 'smile', e: '😄' },
  { id: 'wow', e: '😮' },
  { id: 'fire', e: '🔥' },
  { id: 'think', e: '🤔' },
  { id: 'hadi', k: 'emote.hadi' },
  { id: 'eyvallah', k: 'emote.eyvallah' },
  { id: 'luck', k: 'emote.luck' },
  { id: 'gg', k: 'emote.gg' },
];

export const TURN_OPTIONS = [15, 30, 45, 60];
export const ROUND_OPTIONS = [0, 3, 5, 10];   // 0 = play until a score reaches 0
export const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export const FELTS = ['green', 'burgundy', 'blue'];
export const SPEEDS = { slow: 1.45, normal: 1, fast: 0.55 };

// Tip asks (same rules as the-felt): only between rounds, never in the first 10 minutes of play, after a good
// moment (last 5 minutes) or 30 more minutes of play, at least 2 days apart; back from Ko-fi we ask once.
export const TIP_FIRST = 10 * 60e3;
export const TIP_EVERY = 30 * 60e3;
export const TIP_GAP = 2 * 864e5;
export const TIP_HOT = 5 * 60e3;
