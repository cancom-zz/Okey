// A stand-in table host for developing the client before site/shared/host.js + site/js/local.js exist.
// Same transport shape ({ connect, send, onmessage, close }) and the same messages/views/events as DESIGN.md.
// Bots here are dumb on purpose. Delete this file once local.js is wired everywhere (net.js falls back to it).
//
// URL options (dev/tests): ?mock=1  &fast=1  &scenario=reveal|pairs|mywin|match|lobby|pileEmpty|full
import { isOkey, faceOf, validSetLite, okeyFace, color, num, isFalseJoker } from './tiles.js';

const tid = (c, n, copy = 0) => c * 26 + copy * 13 + (n - 1);
const NAMES = ['Ayşe', 'Mehmet', 'Zeynep', 'Mustafa', 'Elif', 'Hasan', 'Fatma', 'Ali'];
const BOT_NAMES = { cirak: ['Çırak Cem', 'Çırak Ece'], kalfa: ['Kalfa Kaan', 'Kalfa Selin'], usta: ['Usta Rıza', 'Usta Nermin'], uzman: ['Uzman Tahsin', 'Uzman Leyla'] };
const BOT_AV = { cirak: '🐣', kalfa: '🦊', usta: '🦉', uzman: '🐺' };

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const buf = new Uint32Array(1); crypto.getRandomValues(buf);
    const j = buf[0] % (i + 1); [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function createMockTable({ code = 'PRAKTK', scenario = '', fast = false, settings = {} } = {}) {
  const k = fast ? 0.25 : 1;
  const st = {
    v: 0, code, phase: 'lobby', host: null, you: null,
    settings: { turnSeconds: 30, rounds: 0, startPoints: scenario === 'match' ? 2 : 20, scoring: { normal: 2, okey: 4, pairs: 4, pairsOkey: 8, indicator: 1 }, ...settings },
    seats: Array.from({ length: 4 }, () => ({ kind: 'empty', name: '', avatar: '', connected: false, away: false, bot: null, score: 0 })),
    r: null, result: null, roundNo: 0, dealer: -1,
  };
  let timers = [], closed = false, pending = [];
  const tr = { onmessage: null, connect, send, close, mock: true };

  const later = (ms, f) => { const h = setTimeout(() => { timers = timers.filter(x => x !== h); if (!closed) f(); }, ms * k); timers.push(h); };

  function view() {
    const r = st.r;
    return {
      v: st.v, code: st.code, phase: st.phase, settings: st.settings, host: st.host, you: st.you,
      seats: st.seats.map((s, i) => ({
        kind: s.kind, name: s.name, avatar: s.avatar, connected: s.kind === 'bot' || s.connected, away: s.away, bot: s.bot,
        score: s.score, handCount: r ? r.hands[i].length : 0,
        discard: r ? { top: r.discards[i].length ? r.discards[i][r.discards[i].length - 1] : null, count: r.discards[i].length } : { top: null, count: 0 },
        showedIndicator: r ? r.shown[i] : false,
      })),
      round: r ? { number: st.roundNo, dealer: st.dealer, turn: r.turn, stage: r.stage, indicator: r.indicator, okey: r.okey, pileCount: r.pile.length, turnEndsAt: r.turnEndsAt, firstTurn: r.firstTurn.slice() } : null,
      hand: r && st.you != null ? r.hands[st.you].slice() : null,
      result: st.result, now: Date.now(),
    };
  }
  function emit(events = []) {
    st.v++;
    const msg = { t: 'view', view: view(), events: events.filter(e => e.to == null || e.to === st.you) };
    pending.push(msg);
    queueMicrotask(flush);
  }
  function flush() { const p = pending; pending = []; p.forEach(m => tr.onmessage && tr.onmessage(JSON.parse(JSON.stringify(m)))); }
  const err = code => queueMicrotask(() => tr.onmessage && tr.onmessage({ t: 'error', code }));

  function connect() { /* nothing to open */ }
  function close() { closed = true; timers.forEach(clearTimeout); timers = []; }

  function send(msg) {
    if (closed || !msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'hello': {
        st.me = msg.player;
        const seat = st.seats.findIndex(s => s.kind === 'human' && s.id === msg.player.id);
        if (seat >= 0) { st.you = seat; st.seats[seat].connected = true; }
        emit();
        if (scenario === 'lobby' && st.you == null) {
          // friends wander in
          later(1200, () => sitFake(2)); later(2600, () => sitFake(3));
        }
        if (scenario === 'full') { st.you = 0; sitMe(0); [1, 2, 3].forEach(s => addBot(s, ['kalfa', 'usta', 'uzman'][s - 1])); startMatch(); }
        break;
      }
      case 'sit': if (st.phase === 'lobby' && st.seats[msg.seat] && st.seats[msg.seat].kind === 'empty') { if (st.you != null) st.seats[st.you] = emptySeat(); sitMe(msg.seat); emit(); } break;
      case 'stand': if (st.phase === 'lobby' && st.you != null) { st.seats[st.you] = emptySeat(); if (st.host === st.you) st.host = null; st.you = null; emit(); } break;
      case 'addBot': if (st.phase === 'lobby' && st.host === st.you && st.seats[msg.seat] && st.seats[msg.seat].kind === 'empty') { addBot(msg.seat, msg.level || 'kalfa'); emit(); } else err('badAction'); break;
      case 'removeBot': if (st.phase === 'lobby' && st.host === st.you && st.seats[msg.seat].kind === 'bot') { st.seats[msg.seat] = emptySeat(); emit(); } break;
      case 'settings': if (st.host === st.you && st.phase === 'lobby') { Object.assign(st.settings, msg.settings || {}); emit(); } break;
      case 'start': if (st.host === st.you && st.seats.every(s => s.kind !== 'empty')) startMatch(); else err('badAction'); break;
      case 'act': act(st.you, msg.action); break;
      case 'emote': emoteOut(st.you, msg.id); break;
      case 'next': if (st.phase === 'roundEnd') startRound(); else if (st.phase === 'matchEnd') { st.seats.forEach(s => { s.score = st.settings.startPoints; }); st.roundNo = 0; startRound(); } break;
      case 'ping': queueMicrotask(() => tr.onmessage && tr.onmessage({ t: 'pong', now: Date.now() })); break;
      default: err('badAction');
    }
  }
  const emptySeat = () => ({ kind: 'empty', name: '', avatar: '', connected: false, away: false, bot: null, score: 0 });
  function sitMe(seat) {
    const p = st.me || { id: 'x', name: 'Sen', avatar: '🦊' };
    st.seats[seat] = { kind: 'human', id: p.id, name: p.name, avatar: p.avatar, connected: true, away: false, bot: null, score: st.settings.startPoints };
    st.you = seat; if (st.host == null) st.host = seat;
  }
  function sitFake(pref) {
    let seat = st.seats.findIndex((s, i) => i >= pref && s.kind === 'empty'); if (seat < 0) seat = st.seats.findIndex(s => s.kind === 'empty'); if (seat < 0) return;
    st.seats[seat] = { kind: 'human', id: 'f' + seat, name: NAMES[(seat * 3) % NAMES.length], avatar: ['🐼', '🦁', '🐸', '🐯'][seat], connected: true, away: false, bot: null, score: st.settings.startPoints };
    emit();
  }
  function addBot(seat, level) {
    const names = BOT_NAMES[level] || BOT_NAMES.kalfa;
    st.seats[seat] = { kind: 'bot', name: names[seat % 2], avatar: BOT_AV[level] || '🦊', connected: true, away: false, bot: { level }, score: st.settings.startPoints };
  }
  function emoteOut(seat, id) { if (seat == null) return; queueMicrotask(() => tr.onmessage && tr.onmessage({ t: 'emote', seat, id })); }

  function startMatch() {
    st.seats.forEach(s => { s.score = st.settings.startPoints; });
    st.roundNo = 0; st.dealer = -1; startRound();
  }

  function startRound() {
    st.roundNo++;
    st.dealer = st.dealer < 0 ? (scenario === 'mywin' || scenario === 'full' ? (st.you ?? 0) : (scenario ? 1 : Math.floor(Math.random() * 4))) : (st.dealer + 1) % 4;
    let bag = shuffle([...Array(106).keys()]);
    const hands = [[], [], [], []];
    let rigged = null;
    if ((scenario === 'reveal' || scenario === 'match' || scenario === 'pairs' || scenario === 'mywin') && st.roundNo === 1) {
      const who = scenario === 'mywin' ? st.you : st.dealer;
      rigged = scenario === 'pairs'
        ? [tid(0, 3), tid(0, 3, 1), tid(1, 9), tid(1, 9, 1), tid(2, 12), tid(2, 12, 1), tid(3, 1), tid(3, 1, 1), tid(0, 10), tid(0, 10, 1), tid(2, 5), tid(2, 5, 1), 104, tid(3, 8), tid(1, 2)]
        : [tid(0, 1), tid(0, 2), tid(0, 3), tid(0, 4), tid(1, 7), tid(2, 7), tid(3, 7), tid(3, 9), tid(3, 10), tid(3, 11), tid(3, 12), tid(2, 11), tid(2, 12), tid(2, 13), tid(1, 5)];
      hands[who] = rigged.slice();
      bag = bag.filter(x => !rigged.includes(x));
    }
    for (let s = 0; s < 4; s++) { const want = s === st.dealer ? 15 : 14; while (hands[s].length < want) hands[s].push(bag.pop()); }
    // indicator: never a false joker, never makes the rigged hand's tiles okeys
    let ii = bag.findIndex(x => !isFalseJoker(x) && !(rigged && rigged.some(y => isOkey(y, okeyFace(x)))));
    const indicator = bag.splice(ii, 1)[0];
    if (scenario === 'reveal' && rigged && st.roundNo === 1) {
      // make the last rigged tile... an okey when discarded? keep it simple: a normal finish.
    }
    st.r = {
      hands, pile: bag, indicator, okey: okeyFace(indicator), discards: [[], [], [], []], shown: [false, false, false, false],
      turn: st.dealer, stage: 'discard', firstTurn: [true, true, true, true], turnEndsAt: 0, turns: 0,
    };
    if (scenario === 'pileEmpty' && st.roundNo === 1) st.r.pile = st.r.pile.slice(0, 3);
    st.result = null; st.phase = 'playing';
    st.seats.forEach(s => { s.away = false; });
    setTurnClock();
    emit([
      { type: 'roundStart', round: st.roundNo, dealer: st.dealer, indicator, pileCount: st.r.pile.length },
      ...(st.you != null ? [{ type: 'dealt', to: st.you, hand: hands[st.you].slice() }] : []),
    ]);
    scheduleBot(3200);
  }

  function setTurnClock() {
    const r = st.r, s = st.seats[r.turn];
    r.turnEndsAt = s.kind === 'human' && st.settings.turnSeconds ? Date.now() + st.settings.turnSeconds * 1000 : 0;
    if (r.turnEndsAt) {
      const v = st.v, turn = r.turn;
      setTimeout(() => { if (!closed && st.r === r && r.turn === turn && st.phase === 'playing' && r.turnEndsAt && Date.now() >= r.turnEndsAt - 50) timeout(turn); }, st.settings.turnSeconds * 1000 + 30);
      void v;
    }
  }
  function timeout(seat) {
    const r = st.r; st.seats[seat].away = true;
    if (r.stage === 'draw') act(seat, { type: 'draw', from: 'pile' }, true);
    if (st.phase === 'playing' && r.turn === seat) act(seat, { type: 'discard', tile: r.hands[seat][r.hands[seat].length - 1] }, true);
  }

  function act(seat, a, auto = false) {
    const r = st.r;
    if (st.phase !== 'playing' || !r) return err('roundOver');
    if (seat == null || !a) return err('badAction');
    if (!auto && st.seats[seat].away) st.seats[seat].away = false;
    if (a.type === 'showIndicator') {
      if (!r.firstTurn[seat] || r.shown[seat] || !r.hands[seat].some(x => x !== r.indicator && x < 104 && color(x) === color(r.indicator) && num(x) === num(r.indicator))) return err('cannotShow');
      r.shown[seat] = true;
      const tile = r.hands[seat].find(x => x !== r.indicator && x < 104 && color(x) === color(r.indicator) && num(x) === num(r.indicator));
      const deltas = [0, 1, 2, 3].map(i => (i === seat ? 0 : -st.settings.scoring.indicator));
      st.seats.forEach((s, i) => { s.score += deltas[i]; });
      return emit([{ type: 'showIndicator', seat, tile }, { type: 'score', deltas, scores: st.seats.map(s => s.score) }]);
    }
    if (r.turn !== seat) return err('notYourTurn');
    if (a.type === 'draw') {
      if (r.stage !== 'draw') return err('mustDiscard');
      let tile, ev;
      if (a.from === 'discard') {
        const prev = (seat + 3) % 4; if (!r.discards[prev].length) return err('emptyDiscard');
        tile = r.discards[prev].pop(); ev = [{ type: 'draw', seat, from: 'discard', tile }];
      } else {
        tile = r.pile.pop(); ev = [{ type: 'draw', seat, from: 'pile' }];
        if (seat === st.you) ev = [{ type: 'draw', seat, from: 'pile', tile, to: seat }];
        else ev.push({ type: 'draw', seat, from: 'pile', tile, to: seat });
      }
      r.hands[seat].push(tile); r.stage = 'discard';
      emit(ev);
      if (st.seats[seat].kind === 'bot') scheduleBot();
      return;
    }
    if (a.type === 'discard' || a.type === 'finish') {
      if (r.stage !== 'discard') return err('mustDraw');
      const i = r.hands[seat].indexOf(a.tile); if (i < 0) return err('noTile');
      if (a.type === 'finish') {
        const rest = r.hands[seat].filter(x => x !== a.tile);
        let groups = Array.isArray(a.groups) ? a.groups : null, kind = null;
        if (groups && groups.flat().length === 14 && groups.every(g => validSetLite(g, r.okey))) kind = 'sets';
        else if (groups && groups.length === 7 && groups.every(g => g.length === 2 && (isOkey(g[0], r.okey) || isOkey(g[1], r.okey) || (faceOf(g[0], r.okey).num === faceOf(g[1], r.okey).num && faceOf(g[0], r.okey).color === faceOf(g[1], r.okey).color)))) kind = 'pairs';
        else if (!groups) { groups = autoGroups(rest, r.okey); kind = groups ? groups.kind : null; groups = groups && groups.groups; }
        if (!kind) return err('cannotFinish');
        r.hands[seat] = rest;
        const okeyFinish = isOkey(a.tile, r.okey);
        const sc = st.settings.scoring, lose = kind === 'pairs' ? (okeyFinish ? sc.pairsOkey : sc.pairs) : (okeyFinish ? sc.okey : sc.normal);
        const deltas = [0, 1, 2, 3].map(x => (x === seat ? 0 : -lose));
        st.seats.forEach((s, x) => { s.score += deltas[x]; });
        const hands = r.hands.map(h => h.slice());
        st.result = { winner: seat, kind, okeyFinish, tile: a.tile, groups, hands, deltas, scores: st.seats.map(s => s.score) };
        const over = st.seats.some(s => s.score <= 0) || (st.settings.rounds && st.roundNo >= st.settings.rounds);
        st.phase = over ? 'matchEnd' : 'roundEnd';
        const best = Math.max(...st.seats.map(s => s.score));
        const evs = [{ type: 'finish', seat, tile: a.tile, kind, okeyFinish, groups, hands }, { type: 'score', deltas, scores: st.seats.map(s => s.score) }];
        if (over) evs.push({ type: 'matchEnd', scores: st.seats.map(s => s.score), winners: st.seats.map((s, x) => (s.score === best ? x : -1)).filter(x => x >= 0) });
        r.turnEndsAt = 0;
        emit(evs);
        if (!over && st.seats.every((s, x) => s.kind === 'bot' || x === st.you)) { /* waits for the human's 'next' */ }
        return;
      }
      r.hands[seat].splice(i, 1); r.discards[seat].push(a.tile);
      r.firstTurn[seat] = false; r.turns++;
      const evs = [{ type: 'discard', seat, tile: a.tile }];
      r.turn = (seat + 1) % 4; r.stage = 'draw';
      if (!r.pile.length) {
        st.phase = 'roundEnd'; r.turnEndsAt = 0;
        st.result = { winner: null, kind: null, okeyFinish: false, tile: null, groups: null, hands: r.hands.map(h => h.slice()), deltas: [0, 0, 0, 0], scores: st.seats.map(s => s.score) };
        evs.push({ type: 'pileEmpty' });
        return emit(evs);
      }
      setTurnClock();
      emit(evs);
      scheduleBot();
      return;
    }
    err('badAction');
  }

  function autoGroups(rest) { void rest; return null; }

  function scheduleBot(extra = 0) {
    const r = st.r; if (!r || st.phase !== 'playing') return;
    const seat = r.turn; if (st.seats[seat].kind !== 'bot') return;
    const stage = r.stage;
    later(extra + (stage === 'draw' ? 650 + Math.random() * 700 : 700 + Math.random() * 900), () => {
      if (st.r !== r || r.turn !== seat || r.stage !== stage || st.phase !== 'playing') return;
      const hand = r.hands[seat];
      if (stage === 'draw') {
        const prev = (seat + 3) % 4, top = r.discards[prev][r.discards[prev].length - 1];
        const wants = top != null && hand.some(x => x !== top && !isFalseJoker(x) && !isFalseJoker(top) && color(x) === color(top) && Math.abs(num(x) - num(top)) === 1);
        act(seat, { type: 'draw', from: wants && Math.random() < 0.6 ? 'discard' : 'pile' });
      } else {
        // rigged scenarios: the dealer finishes straight away
        if ((scenario === 'reveal' || scenario === 'match' || scenario === 'pairs') && st.roundNo === 1 && seat === st.dealer) {
          const tile = scenario === 'pairs' ? tid(1, 2) : tid(1, 5);
          const groups = scenario === 'pairs'
            ? [[tid(0, 3), tid(0, 3, 1)], [tid(1, 9), tid(1, 9, 1)], [tid(2, 12), tid(2, 12, 1)], [tid(3, 1), tid(3, 1, 1)], [tid(0, 10), tid(0, 10, 1)], [tid(2, 5), tid(2, 5, 1)], [104, tid(3, 8)]]
            : [[tid(0, 1), tid(0, 2), tid(0, 3), tid(0, 4)], [tid(1, 7), tid(2, 7), tid(3, 7)], [tid(3, 9), tid(3, 10), tid(3, 11), tid(3, 12)], [tid(2, 11), tid(2, 12), tid(2, 13)]];
          if (scenario === 'pairs') { // make the false joker pair valid: it stands for the okey face
            const fj = faceOf(104, r.okey); const mate = hand.find(x => x < 104 && color(x) === fj.color && num(x) === fj.num);
            if (!mate) { groups[6] = [tid(3, 8), tid(3, 8, 1)]; const at = hand.indexOf(104); const other = r.hands.findIndex((h, i) => i !== seat && h.includes(tid(3, 8, 1))); if (other >= 0) { r.hands[other][r.hands[other].indexOf(tid(3, 8, 1))] = 104; } else r.pile[r.pile.indexOf(tid(3, 8, 1))] = 104; hand[at] = tid(3, 8, 1); }
          }
          return act(seat, { type: 'finish', tile, groups });
        }
        const score = x => {
          if (isOkey(x, r.okey)) return -99;
          if (isFalseJoker(x)) return -5;
          let s = 0;
          for (const y of hand) if (y !== x && !isFalseJoker(y)) {
            if (color(y) === color(x) && Math.abs(num(y) - num(x)) <= 2) s += 3 - Math.abs(num(y) - num(x));
            if (num(y) === num(x) && color(y) !== color(x)) s += 2;
          }
          return -s + Math.random() * 0.8;
        };
        const tile = hand.slice().sort((a, b) => score(b) - score(a))[0];
        act(seat, { type: 'discard', tile });
      }
    });
  }

  return tr;
}
