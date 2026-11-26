// 101 Okey on the client: the opening counter (from the groups on your rack), the melds laid on the table,
// the round story and the score rows. Rules come from the shared engine (site/shared/okey101/rules.js), loaded
// lazily; nothing here decides legality, the host does. Lower scores are better in 101.
import { t } from './i18n.js';
import { esc } from './ui.js';
import { tileHTML, faceOf } from './tiles.js';

let R = null, loading = null;
export function load101() {
  if (!loading) loading = import('../shared/okey101/rules.js').then(m => { R = m; return m; }).catch(e => { console.error(e); return null; });
  return loading;
}
export const rules101 = () => R;

// The rack's groups (tiles side by side) read as an opening: sets (3+ tiles that make a run or a group) and
// pairs (2-tile groups, or longer groups that split into pairs). Sets and pairs never mix.
export function rackOpening(groups, hand, round, settings, you) {
  if (!R) return null;
  const okey = round.okey, ace = settings.aceHighValue || 1;
  const opened = round.opened ? round.opened[you] : false;
  const sets = [], pairs = [];
  for (const g of groups) {
    if (g.length >= 3) {
      const m = R.meldOf(g, okey, { aceHighValue: ace });
      if (m) { sets.push({ ids: g, value: m.value }); continue; }
    }
    if (g.length >= 2 && g.length % 2 === 0) {
      const chunks = [];
      for (let i = 0; i < g.length; i += 2) chunks.push(g.slice(i, i + 2));
      if (chunks.every(c => R.pairOf(c, okey))) chunks.forEach(c => pairs.push({ ids: c }));
    }
  }
  const value = sets.reduce((a, s) => a + s.value, 0);
  const req = round.required || { value: settings.openingValue || 101, pairs: settings.minPairs || 5 };
  const allowPairs = settings.pairsOpening !== false;
  // which kind to show: what you opened with, else whichever is further along
  let kind;
  if (opened) kind = opened;
  else if (!allowPairs || !pairs.length) kind = 'sets';
  else if (!sets.length) kind = 'pairs';
  else kind = pairs.length / req.pairs > value / req.value ? 'pairs' : 'sets';
  const chosen = kind === 'pairs' ? pairs : sets;
  const used = chosen.reduce((a, s) => a + s.ids.length, 0);
  const keepsOne = used < hand.length;
  const taken = round.taken != null && round.turn === you ? round.taken : null;
  const hasTaken = taken == null || chosen.some(s => s.ids.includes(taken));
  const enough = opened ? chosen.length > 0 : (kind === 'pairs' ? pairs.length >= req.pairs : value >= req.value);
  return {
    kind, opened, value, pairs: pairs.length, req, sets, pairList: pairs, taken,
    groups: chosen.map(s => s.ids), ok: enough && keepsOne && (opened || hasTaken), keepsOne, hasTaken,
  };
}

// "En iyi açış": the best opening (or, once opened, the best sets/pairs to lay) as rack groups.
export function bestLayout(hand, round, settings, you) {
  if (!R) return null;
  const okey = round.okey, ace = settings.aceHighValue || 1;
  const opened = round.opened ? round.opened[you] : false;
  const req = round.required || { value: 101, pairs: 5 };
  let groups, kind, value = 0, count = 0, enough;
  if (opened === 'pairs') { const p = R.bestPairs(hand, okey, { keep: 1 }); groups = p.groups; kind = 'pairs'; count = p.count; enough = count > 0; }
  else if (opened === 'sets') { const s = R.bestSets(hand, okey, { aceHighValue: ace, keep: 1 }); groups = s.groups; kind = 'sets'; value = s.value; enough = groups.length > 0; }
  else {
    const o = R.bestOpening(hand, okey, { allowPairs: settings.pairsOpening !== false, aceHighValue: ace, minValue: req.value, minPairs: req.pairs, keep: 1 });
    if (o.best) { groups = o.best.groups; kind = o.best.kind; value = o.best.value || 0; count = o.best.count || 0; enough = true; }
    else {
      // not enough yet: show the closer of the two so the player sees how far off they are
      const sv = o.sets.value / req.value, pv = o.pairs ? o.pairs.count / req.pairs : 0;
      if (o.pairs && pv > sv) { groups = o.pairs.groups; kind = 'pairs'; count = o.pairs.count; }
      else { groups = o.sets.groups; kind = 'sets'; value = o.sets.value; }
      enough = false;
    }
  }
  const used = new Set(groups.flat());
  return { groups, rest: hand.filter(id => !used.has(id)), kind, value, count, enough, req };
}

// Every meld on the table, grouped by owner in seat order. posOf(seat) -> 0 me, 1 right, 2 top, 3 left.
export function boardHTML(table, okey, seats, posOf, hide = new Set()) {
  const rows = [2, 3, 1, 0].map(p => {
    const items = [];
    table.forEach((m, i) => { if (posOf(m.owner) === p) items.push([m, i]); });
    if (!items.length) return '';
    const s = seats[(items[0][0]).owner] || {};
    return `<div class="mrow q${p}"><span class="own" title="${esc(s.name || '')}">${esc(s.avatar || '🙂')}</span>${items.map(([m, i]) =>
      `<div class="mg k-${m.kind}" data-i="${i}">${m.tiles.map(id => tileHTML(id, okey, hide.has(id) ? 'gone' : '', `data-id="${id}"`)).join('')}</div>`).join('')}</div>`;
  }).join('');
  return rows;
}

// ---- results ----
const pickBy = (a, seed) => a[Math.abs(seed | 0) % a.length];
export function story101(view) {
  const r = view.result; if (!r) return null;
  if (r.winner == null) return { cls: 'none', v: t('s101.pileEmpty'), line: t('s101.pileEmptyLine') };
  const you = r.winner === view.you;
  const name = (view.seats[r.winner] || {}).name || '';
  const how = r.elden ? 'elden' : r.okeyFinish ? 'okey' : r.kind === 'pairs' ? 'pairs' : 'plain';
  const v = t((you ? 's101.you.' : 's101.they.') + how, { name });
  const why = [];
  if (r.okeyFinish) why.push(t('s101.why.okey'));
  if (r.elden) why.push(t('s101.why.elden'));
  if (r.kind === 'pairs') why.push(t('s101.why.pairs'));
  const m = r.multiplier || 1;
  const line = m > 1 ? t('s101.lineMult', { m, why: why.join(' · '), n: 101 * m }) : t('s101.line', { n: 101 });
  const extra = m === 1 ? pickBy([t('s101.flair1'), t('s101.flair2')], r.tile || 0) : '';
  return { cls: (you ? 'win ' : 'lose ') + (m > 1 ? 'okey' : 'sets'), v, line, extra };
}

// One row per seat: opened how, penalties this round, the round's points and the total (lower is better).
export function rows101(view) {
  const r = view.result; if (!r) return '';
  const best = Math.min(...view.seats.map((s, i) => (r.scores ? r.scores[i] : s.score)));
  return `<div class="deltas d101">${view.seats.map((s, i) => {
    const d = r.deltas ? r.deltas[i] || 0 : 0, pen = r.penalties ? r.penalties[i] || 0 : 0, total = r.scores ? r.scores[i] : s.score;
    const op = r.opened ? r.opened[i] : false;
    const how = i === r.winner ? t('r101.finished') : op === 'pairs' ? t('r101.openedPairs') : op ? t('r101.opened') : t('r101.notOpened');
    return `<div class="dl ${i === r.winner ? 'w' : ''} ${i === view.you ? 'me' : ''} ${total === best ? 'lead' : ''}"><span class="av">${esc(s.avatar || '🙂')}</span>
      <span class="nm">${esc(s.name || '—')}</span>${i === view.you ? `<em class="you">${t('lobby.you')}</em>` : ''}<span class="how">${how}</span>
      <b class="${d < 0 ? 'pos' : d > 0 ? 'neg' : ''}" data-v="${d}" data-z="0">${d > 0 ? '+' + d : d < 0 ? '−' + Math.abs(d) : '0'}</b>
      ${pen ? `<span class="pen">${t('r101.penalty', { n: pen })}</span>` : ''}<small>${total}</small>${s.ready && s.kind === 'human' ? `<i class="rdy" title="${t('result.ready')}">✓</i>` : ''}</div>`;
  }).join('')}</div>`;
}

// what a tile counts left in hand, for the "elinde kalan" hint
export const handPoints = (ids, okey) => (R ? R.handValue(ids, okey) : ids.reduce((a, id) => a + (faceOf(id, okey).num || 0), 0));
