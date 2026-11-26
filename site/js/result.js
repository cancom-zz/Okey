// Round stories and the match podium: what happened, in one big word and one line, with every seat's points.
import { t } from './i18n.js';
import { esc } from './ui.js';
import { tileHTML } from './tiles.js';

const pickBy = (a, seed) => a[Math.abs(seed | 0) % a.length];

export function storyOf(view) {
  const r = view.result; if (!r) return null;
  const me = view.you;
  if (r.winner == null) return { cls: 'none', v: t('story.pileEmpty'), line: t('story.pileEmptyLine') };
  const name = (view.seats[r.winner] || {}).name || '';
  const lost = Math.max(0, ...r.deltas.map(d => -d));
  const you = r.winner === me;
  const kind = r.kind === 'pairs' ? (r.okeyFinish ? 'pairsOkey' : 'pairs') : (r.okeyFinish ? 'okey' : 'sets');
  const seed = (r.tile || 0) + (r.groups ? r.groups.length * 7 : 0);
  const v = you ? t('story.you.' + kind) : t('story.they.' + kind, { name });
  const line = t('story.line.' + kind, { n: lost });
  const extra = kind === 'sets' ? pickBy([t('story.flair1'), t('story.flair2'), t('story.flair3')], seed) : '';
  return { cls: you ? 'win ' + kind : 'lose ' + kind, v, line, extra, kind };
}

export function deltasHTML(view) {
  const r = view.result; if (!r) return '';
  return `<div class="deltas">${view.seats.map((s, i) => {
    const d = r.deltas[i] || 0;
    return `<div class="dl ${i === r.winner ? 'w' : ''} ${i === view.you ? 'me' : ''}"><span class="av">${esc(s.avatar || '🙂')}</span>
      <span class="nm">${esc(s.name || '—')}</span>${i === view.you ? `<em class="you">${t('lobby.you')}</em>` : ''}<b class="${d < 0 ? 'neg' : d > 0 ? 'pos' : ''}" data-v="${d}" data-z="±0">${d ? (d > 0 ? '+' : '−') + Math.abs(d) : '±0'}</b><small>${r.scores ? r.scores[i] : s.score}</small>${s.ready && s.kind === 'human' ? `<i class="rdy" title="${t('result.ready')}">✓</i>` : ''}</div>`;
  }).join('')}</div>`;
}

// The winner's hand, grouped into sets, plus the finishing tile.
export function handGroupsHTML(view) {
  const r = view.result; if (!r || !r.groups) return '';
  const okey = view.round && view.round.okey;
  return r.groups.map(g => `<div class="rg">${g.map(id => tileHTML(id, okey, 'rv', `data-id="${id}"`)).join('')}</div>`).join('');
}

export function podiumHTML(view, lowWins = false) {
  const order = view.seats.map((s, i) => ({ s, i, score: s.score })).sort((a, b) => (lowWins ? a.score - b.score : b.score - a.score));
  let place = 0, prev = null;
  order.forEach((o, k) => { if (o.score !== prev) place = k; o.place = place; prev = o.score; });
  const medal = ['🥇', '🥈', '🥉', ''];
  // four steps: 2nd, 1st, 3rd, then a low plinth for 4th (never a footnote); your own step says so
  const podium = [order[1], order[0], order[2], order[3]].filter(Boolean);
  return `<div class="podium">${podium.map((o, k) => `<div class="pd p${k === 3 ? 3 : o.place}${o.i === view.you ? ' me' : ''}">
      <span class="av">${esc(o.s.avatar || '🙂')}</span><span class="nm">${esc(o.s.name)}</span>${o.i === view.you ? `<em class="you">${t('lobby.you')}</em>` : ''}
      <div class="step"><b>${medal[o.place] || (o.place + 1) + '.'}</b><small>${o.score}</small></div></div>`).join('')}</div>`;
}
