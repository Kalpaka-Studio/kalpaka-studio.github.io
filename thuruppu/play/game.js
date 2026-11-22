'use strict';
/* =========================================================================
   Thuruppu 56 — the screen: table, hand, menus, and playing the bots' turns on this phone.
   The rules, scoring and bots live in engine.js (loaded first); this file shows them and turns taps
   into engine actions. Seats are numbered 0..5 counter-clockwise; the human is seat 0.
   Your team = seats 0, 2, 4 · other team = 1, 3, 5. Which is Black and which Red comes from the Ace draw.
   ========================================================================= */

// Seat 0 is you; seats 2 and 4 are your partners; 1, 3, 5 are opponents. Names are editable and kept per device.
const DEFAULT_NAMES = ['You', 'Geetha', 'Anjana', 'Deepu', 'Bindu', 'Meenakshi'];
const NAMES_KEY = 'thuruppu56.names';
const NAME_MAX = 14;
const cleanName = (n, i) => (typeof n === 'string' && n.trim()) ? n.trim().slice(0, NAME_MAX) : DEFAULT_NAMES[i];
let NAMES = DEFAULT_NAMES.slice();
try {
  const s = JSON.parse(localStorage.getItem(NAMES_KEY) || 'null');
  if (Array.isArray(s) && s.length === 6) NAMES = s.map(cleanName);
} catch (e) { /* storage blocked: keep defaults */ }
const esc = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
// Teams are Black and Red, decided by the Ace draw. Seats 0/2/4 are always your team; `black` says
// whether your team (0) or the other (1) is Black. Kept per device until "Shuffle teams".
const TEAMS_KEY = 'thuruppu56.teams';
let TEAMS = { drawn: false, black: 0 };
try {
  const t = JSON.parse(localStorage.getItem(TEAMS_KEY) || 'null');
  if (t && (t.black === 0 || t.black === 1)) TEAMS = { drawn: !!t.drawn, black: t.black };
} catch (e) { /* keep default */ }
const TEAM_NAME = ['', ''], TEAM_SYM = ['', ''];
function applyTeams() {
  const b = TEAMS.black;
  TEAM_NAME[b] = 'Black team'; TEAM_NAME[1 - b] = 'Red team';
  TEAM_SYM[b] = '♠'; TEAM_SYM[1 - b] = '♥';
  try { document.documentElement.classList.toggle('black-is-1', b === 1); } catch (e) { /* no DOM */ }
}
applyTeams();
// The one version for the web link and the Android/iOS app (shown in the menu).
// android/app/build.gradle reads `name` and `build` from this line, so keep its shape.
// Bump `build` on every publish; bump `name` for each release (1.0.2 -> 1.0.3 for fixes, 1.1.0 for features).
const APP_VERSION = { name: '1.4.0', build: 15, date: '22 Nov 2026', note: 'Play with friends online; slow bot speed; Kitty & Joker by default' };
// How long each automatic step waits (ms). The online server uses the same multipliers (SPEED_X there).
const SPEEDS = {
  slow: { bot: 1500, trick: 2500, botCard: 1100, decided: 3400 },
  normal: { bot: 850, trick: 1500, botCard: 700, decided: 2400 },
  fast: { bot: 420, trick: 900, botCard: 700, decided: 2400 },
};
const SPEED_LABEL = { slow: 'Slow', normal: 'Normal', fast: 'Fast' };
const SAVE_KEY = 'thuruppu56.save.v1';
const SPEED_KEY = 'thuruppu56.speed';


// ---------- State ----------
let timer = null;
let speed = 'normal';
try { const s = localStorage.getItem(SPEED_KEY); if (SPEEDS[s]) speed = s; } catch (e) { /* storage blocked */ }
const SCORING_KEY = 'thuruppu56.scoring';
let scoring = 'kitty';                      // 'kitty' = Kitty & Joker (default), 'twelve' = first to 12
try { if (localStorage.getItem(SCORING_KEY) === 'twelve') scoring = 'twelve'; } catch (e) { /* storage blocked */ }
const delay = k => SPEEDS[speed][k];

// UI-only state
const UI = { overlay: 'intro', sel: null, bidPick: null, shake: null };


let drawTimer = null;
function startDraw() {
  clearTimeout(timer); clearInterval(drawTimer);
  const d = makeDraw();
  UI.draw = Object.assign(d, { step: 0, names: d.order.map(s => NAMES[s]) });
  openOverlay('draw');
  drawTimer = setInterval(() => {
    const d = UI.draw;
    if (!d || UI.overlay !== 'draw') { clearInterval(drawTimer); return; }
    d.step++;
    if (d.step >= d.seq.length) { d.step = d.seq.length; clearInterval(drawTimer); }
    renderOverlay();
  }, 320);
}
function finishDraw() {
  const d = UI.draw;
  if (!d) return;
  clearInterval(drawTimer);
  NAMES = d.names.slice();
  TEAMS = { drawn: true, black: d.black };
  try { localStorage.setItem(NAMES_KEY, JSON.stringify(NAMES)); localStorage.setItem(TEAMS_KEY, JSON.stringify(TEAMS)); } catch (e) { /* ignore */ }
  applyTeams();
  resetCareer();                 // new teams: the career score starts again
  UI.draw = null;
  overlayReturn = null;
  startMatch(d.firstDealer);
  const b = TEAMS.black;
  log(`Teams drawn by Aces: ${tsy(b)} ${tn(b)} vs ${tsy(1 - b)} ${tn(1 - b)}. ${pn(G.dealer)} drew the first Ace and ${pv(G.dealer, 'deals', 'deal')}.`);
  render();
}

// ---------- Running the engine on this phone ----------
// Seat 0 is played by you; the engine's nextStep() says when a bot moves or a trick is collected,
// and we wait a little before each so the table is easy to follow.
Engine.emit = (type, d) => {
  if (type === 'round') { UI.sel = null; UI.bidPick = null; UI.ntAsk = false; }
  else if (type === 'flash') { if (d.suit) flash(d.suit); else flashText(fmt(d.label), fmt(d.big)); }
  else if (type === 'decided') UI.overlay = 'decided';
  else if (type === 'roundEnd') { addCareer(d); UI.overlay = 'round'; }
};
const STEP_DELAY = {
  bot: () => delay('bot'), botTrump: () => delay('bot') + 300, botCard: () => delay('botCard'),
  trick: () => delay('trick'), decided: () => delay('decided'),
};
function schedule() {
  clearTimeout(timer);
  if (NET.on) return;                                  // online, the server moves the bots
  const st = G && nextStep();
  if (!st) return;
  const R = G.R;
  timer = setTimeout(() => { if (G.R !== R) return; st.run(); update(); }, STEP_DELAY[st.kind]());
}
/** After any move: redraw and line up whatever happens next. */
function update() { render(); schedule(); }
function startMatch(dealer) {
  clearTimeout(timer);
  UI.overlay = null;
  newMatch({ dealer, mode: scoring });
  update();
}

// ---------- Names and log lines, as seen from seat 0 ----------
const VIEWER = 0;
const vb = (p, third, you) => (p === VIEWER && NAMES[p] === 'You') ? you : third;
const who = p => `<span class="lname t${team(p)}">${esc(NAMES[p])}</span>`;
/** Fill in the engine's log tokens ({@3}, {~3|takes|take}, {&1|gets|get}, {#1}, {$1}). */
function fmt(s) {
  return String(s)
    .replace(/\{@(\d)\}/g, (_, p) => who(+p))
    .replace(/\{~(\d)\|([^|}]*)\|([^|}]*)\}/g, (_, p, third, you) => vb(+p, third, you))
    .replace(/\{&(\d)\|([^|}]*)\|([^|}]*)\}/g, (_, t, third, you) => +t === team(VIEWER) ? you : third)
    .replace(/\{#(\d)\}/g, (_, t) => TEAM_NAME[+t])
    .replace(/\{\$(\d)\}/g, (_, t) => TEAM_SYM[+t]);
}

/**
 * A team's kitty split by colour: [own colour, won from the other team]. Each team starts with 7 of its own
 * colour, and a team that pays always gives back the other team's colour first. So a team never holds both
 * fewer than 7 of its own and some of the other's: the split follows from the count alone.
 */
function kittyParts(t) { const n = G.kitty[t]; return [Math.min(7, n), Math.max(0, n - 7)]; }
function kittyText(t) {
  const [own, won] = kittyParts(t);
  return `<span class="t${t}c">${TEAM_SYM[t]} ${own}</span>${won ? ` + <span class="t${1 - t}c">${TEAM_SYM[1 - t]} ${won}</span>` : ''}`;
}

function setScoring(mode) {
  scoring = mode === 'kitty' ? 'kitty' : 'twelve';
  try { localStorage.setItem(SCORING_KEY, scoring); } catch (e) { /* ignore */ }
}
// ---------- Career score ----------
// Game points added up silently across every round and both scoring styles (in Kitty & Joker the same
// points still count, including kitty exchanges). Only a new set of teams (an Ace draw) starts it afresh.
// Index = team (0 = your team). Shown in the menu and the round summary, never on the table.
const CAREER_KEY = 'thuruppu56.career';
const freshCareer = () => ({ points: [0, 0], rounds: 0, matches: [0, 0], since: new Date().toISOString().slice(0, 10) });
let CAREER = freshCareer();
try {
  const c = JSON.parse(localStorage.getItem(CAREER_KEY) || 'null');
  if (c && Array.isArray(c.points) && c.points.length === 2) CAREER = Object.assign(freshCareer(), c);
} catch (e) { /* keep fresh */ }
function saveCareer() { try { localStorage.setItem(CAREER_KEY, JSON.stringify(CAREER)); } catch (e) { /* ignore */ } }
function resetCareer() { CAREER = freshCareer(); saveCareer(); }
function addCareer(r) {
  CAREER.points[r.to] += r.gain;
  CAREER.rounds++;
  if (matchOver()) CAREER.matches[G.score[0] >= TARGET ? 0 : 1]++;   // a First to 12 match won
  saveCareer();
}
function careerHTML() {
  const c = CAREER;
  return `<div class="career"><div class="career-h">Career score <span class="muted">· since ${c.since.split('-').reverse().join('/')}, these teams</span></div>
    <div class="career-row"><span class="t0c">${TEAM_SYM[0]} ${TEAM_NAME[0]} <b>${c.points[0]}</b></span><span class="t1c"><b>${c.points[1]}</b> ${TEAM_NAME[1]} ${TEAM_SYM[1]}</span></div>
    <div class="muted career-sub">${c.rounds} round${c.rounds === 1 ? '' : 's'} played${c.matches[0] + c.matches[1] ? ` · matches to 12 won ${TEAM_SYM[0]} ${c.matches[0]} · ${TEAM_SYM[1]} ${c.matches[1]}` : ''}</div></div>`;
}

// =========================================================================
//  Persistence (per-device convenience only)
// =========================================================================
function save() {
  if (NET.on) return;                                  // an online table lives on the server
  try { const s = serialize(); if (s) localStorage.setItem(SAVE_KEY, s); } catch (e) { /* ignore */ }
}
function loadSaved() {
  try { const s = localStorage.getItem(SAVE_KEY); return s ? deserialize(s) : null; } catch (e) { return null; }
}
function resume(g) {
  G = g;
  const R = G.R;
  UI.overlay = R.phase === 'roundEnd' ? 'round' : null;
  UI.sel = null;
  if (R.decided && R.phase === 'play') { R.busy = false; endRound(); }   // was showing the early finish
  update();                                                                // a pending trick or bot turn carries on
}

// =========================================================================
//  Rendering
// =========================================================================
const $ = s => document.querySelector(s);

function shellHTML() {
  return `<div class="app">
    <header class="top">
      <div class="brand"><span class="brand-num">56</span><span class="brand-word">thuruppu</span></div>
      <div class="match" id="match"></div>
      <button class="icon-btn" id="menuBtn" data-act="menu" aria-label="Menu">
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>
      </button>
    </header>
    <div class="strip" id="strip"></div>
    <section class="table-zone">
      <div class="table" id="table">
        <div class="rim"></div><div class="felt"></div>
        <div id="seats" class="seats"></div>
        <div id="flash" class="flash" aria-live="polite"></div>
      </div>
    </section>
    <section class="sheet" id="sheet" aria-live="polite"></section>
    <section class="hand" id="hand"></section>
  </div>
  <div id="overlay" class="overlay" hidden></div>`;
}

function cardHTML(c, cls = '') {
  const sym = SUIT_SYM[c.suit];
  const pts = POINTS[c.rank] ? `<span class="pts">${POINTS[c.rank]}</span>` : '';
  return `<div class="card ${isRed(c.suit) ? 'red' : ''} ${cls}" data-id="${c.id}" role="button" aria-label="${c.rank} of ${SUIT_NAME[c.suit]}">
    <span class="corner">${c.rank}<i>${sym}</i></span><span class="mid">${sym}</span>${pts}</div>`;
}

function render() {
  if (!G) { renderOverlay(); return; }
  renderTop(); renderTable(); renderSheet(); renderHand(); renderOverlay();
  save();
}

function renderTop() {
  const R = G.R;
  const pct = t => Math.min(100, G.score[t] / TARGET * 100);
  if (isKitty()) {
    // Own-colour cards first, then any won from the other team (in that team's colour).
    const stack = t => { const [own, won] = kittyParts(t);
      return `<i class="kit-stack">${`<i class="k${t}"></i>`.repeat(own)}${`<i class="k${1 - t}"></i>`.repeat(won)}</i>`; };
    // The team's Jokers right now: each one the team got and hasn't fully removed (the most any member holds),
    // not one per member.
    const held = t => Math.max(...[0, 1, 2, 3, 4, 5].filter(s => team(s) === t).map(s => G.joker[s]));
    const tally = t => held(t) ? `<span class="jk-tally" title="Team Jokers now">🃏${held(t) > 1 ? held(t) : ''}</span>` : '';
    $('#match').innerHTML = `
      <div class="ms kit t0"><span class="ms-label" title="${TEAM_NAME[0]} (your team)">${TEAM_SYM[0]}</span><b>${G.kitty[0]}</b>${tally(0)}${stack(0)}</div>
      <span class="ms-to">kitty</span>
      <div class="ms kit t1">${tally(1)}<b>${G.kitty[1]}</b><span class="ms-label" title="${TEAM_NAME[1]}">${TEAM_SYM[1]}</span>${stack(1)}</div>`;
  } else
  $('#match').innerHTML = `
    <div class="ms t0"><span class="ms-label" title="${TEAM_NAME[0]} (your team)">${TEAM_SYM[0]}</span><b>${G.score[0]}</b><i class="ms-bar"><i style="width:${pct(0)}%"></i></i></div>
    <span class="ms-to">to ${TARGET}</span>
    <div class="ms t1"><b>${G.score[1]}</b><span class="ms-label" title="${TEAM_NAME[1]}">${TEAM_SYM[1]}</span><i class="ms-bar"><i style="width:${pct(1)}%"></i></i></div>`;

  let trump = '<span class="muted">—</span>';
  if (R.thani) trump = '<b>None</b> <span class="muted">· Thani</span>';
  else if (R.trump.suit) {
    if (R.trump.revealed) trump = suitHTML(R.trump.suit);
    else trump = `<span class="lock">Hidden</span>` + (R.bidder === 0 ? ` <span class="muted">(${symHTML(R.trump.suit)})</span>` : '');
  }
  const bid = R.high ? `<b>${bidLabel(R.high)}</b>${R.cot ? ' <span class="cot">COT</span>' : ''} ${who(R.bidder)}` : '<span class="muted">—</span>';
  const trickNo = R.phase === 'play' ? Math.min(R.trickNo + 1, 8) : (R.phase === 'roundEnd' ? 8 : 0);
  $('#strip').innerHTML = `
    <div class="chip"><label>Bid</label><span>${bid}</span></div>
    <div class="chip"><label>Thuruppu</label><span>${trump}</span></div>
    <div class="chip"><label>Trick</label><span>${trickNo}/8 · <b>${trickPoints(R.plays)}</b>pt</span></div>
    <div class="chip"><label>Round</label><span><span class="t0c">${R.captured[0]}</span>–<span class="t1c">${R.captured[1]}</span></span></div>`;
}

function renderTable() {
  const R = G.R;
  let html = '';
  for (let p = 0; p < 6; p++) {
    const cls = ['seat', 'p' + p, 'team' + team(p)];
    const active = ((isBidding(R) || R.phase === 'play') && R.turn === p) || (R.phase === 'trump' && R.bidder === p);
    if (active) cls.push('turn');
    let tags = '';
    if (G.dealer === p) tags += '<span class="tag dealer" title="Dealer">D</span>';
    if (R.bidder === p && R.phase !== 'bidding') tags += `<span class="tag bidder" title="Bidder">★${bidLabel(R.high)}</span>`;
    if (R.phase !== 'roundEnd' && sitsOut(p)) { tags += '<span class="tag out" title="Sits out the Thani">out</span>'; cls.push('sitting'); }
    else if (R.phase === 'play' || R.phase === 'roundEnd') tags += `<span class="tag tricks" title="Tricks taken">${R.tricksWon[p]}</span>`;
    if (NET.on && p !== 0) {                                     // who is a bot, offline or away at an online table
      const s = netSeat(p);
      if (s && !s.human) tags += '<span class="tag bot" title="Played by a bot">bot</span>';
      else if (s && !s.connected) { tags += '<span class="tag off" title="Connection lost">offline</span>'; cls.push('dropped'); }
      else if (s && s.away) tags += '<span class="tag off" title="A bot is playing for them">away</span>';
    }
    let bubble = '';
    if (isBidding(R) && R.lastBid[p] != null)
      bubble = `<span class="bubble ${R.lastBid[p] === 'Pass' ? 'pass' : ''}">${R.lastBid[p] === 'Pass' ? 'Pass' : bidLabel(R.lastBid[p])}</span>`;
    const count = p === 0 ? '' : `<span class="cnt">${R.hands[p].length}</span>`;
    const jk = isKitty() && G.joker[p] > 0 ? `<span class="joker" title="Joker penalty">🃏${G.joker[p] > 1 ? '×' + G.joker[p] : ''}</span>` : '';
    html += `<div class="${cls.join(' ')}">
      <div class="av">${p === 0 ? `${jk}<span class="nm0">${esc(NAMES[0])}</span>` : `${esc(NAMES[p][0].toUpperCase())}${count}${jk}`}</div>
      ${p === 0 ? '' : `<div class="nm">${esc(NAMES[p])}</div>`}
      <div class="tags">${tags}</div>${bubble}</div>`;
  }
  const wi = R.plays.length === trickSize() ? winnerIndex(R.plays) : -1;
  R.plays.forEach((x, i) => {
    html += `<div class="tslot t${x.p} ${i === wi ? 'win' : ''}" style="z-index:${i + 2}">${cardHTML(x.card, x.trumpPlay ? 'trumped' : '')}</div>`;
  });
  // Once the thuruppu is known (revealed, or no trump announced), show it big on the table.
  if ((R.phase === 'play' || R.phase === 'roundEnd' || R.phase === 'bidding2') && (R.thani || (R.trump.suit && R.trump.revealed))) {
    const nt = R.thani || R.trump.suit === 'NT';
    html += `<div class="trump-badge ${!nt && isRed(R.trump.suit) ? 'red' : ''} ${nt ? 'nt' : ''}">
      ${R.thani ? '<span class="tb-label">Thani</span>' : nt ? '' : '<span class="tb-label">Thuruppu</span>'}
      <span class="tb-sym">${nt ? 'No<br>trump' : SUIT_SYM[R.trump.suit]}</span></div>`;
  }
  if (isBidding(R) || R.phase === 'trump') {
    html += `<div class="center-bid">${R.high
      ? `<div class="cb-num">${bidLabel(R.high)}</div><div class="cb-who">${who(R.bidder)}${R.phase === 'bidding2' ? '<span class="cb-round">40+ / Thani round</span>' : ''}</div>`
      : `<div class="cb-num dim">28</div><div class="cb-who muted">opening bid</div>`}</div>`;
  }
  $('#seats').innerHTML = html;
}

function renderSheet() { renderSheetBase(); netSheetExtras(); }
function renderSheetBase() {
  const R = G.R;
  const el = $('#sheet');
  const highTxt = R.high ? `Highest <b>${bidLabel(R.high)}</b> · ${who(R.bidder)}` : 'Opening bid is compulsory';

  if (isBidding(R)) {
    const r2 = R.phase === 'bidding2';
    if (R.turn !== 0) { el.innerHTML = waitHTML(`${who(R.turn)} is bidding${r2 ? ' (40+ round)' : ''}`, highTxt); return; }
    const opts = legalBids(0);
    if (!opts.length) {
      el.innerHTML = `<div class="sheet-head"><div class="sheet-title">${r2 ? 'Second round' : 'Your turn'}</div><div class="sheet-sub">The bid is already at 56.</div></div>
        <div class="row"><button class="btn primary wide" data-act="pass">Pass</button></div>`;
      return;
    }
    // Start from the lowest legal bid each time the situation changes (new high bid, new round of bidding).
    const key = `${G.roundNo}|${R.phase}|${R.high}|${R.bidder}`;
    if (UI.bidKey !== key || UI.bidPick == null || !opts.includes(UI.bidPick)) { UI.bidPick = opts[0]; UI.bidKey = key; }
    const i = opts.indexOf(UI.bidPick);
    const jumps = [40, 48, 56, THANI].filter(v => opts.includes(v) && v !== UI.bidPick);
    const r2Title = R.high >= 56 ? 'Call Thani?' : 'Raise to 40+, or call Thani?';
    const r2Sub = R.high >= 56
      ? `All 8 cards dealt. ${highTxt}. Only Thani goes higher: you must win all 8 tricks alone, no thuruppu.`
      : `All 8 cards dealt. ${highTxt}. A raise means you pick the thuruppu. Thani means winning all 8 tricks alone.`;
    const isThani = UI.bidPick === THANI;
    el.innerHTML = `<div class="sheet-head"><div class="sheet-title">${r2 ? r2Title : 'Your bid'}</div><div class="sheet-sub">${r2 ? r2Sub : highTxt}${R.bidder >= 0 && team(R.bidder) === 0 && !r2 ? '<br>Your team holds the bid: you can still raise to 40 or more.' : ''}</div></div>
      <div class="row">
        <div class="stepper">
          <button class="step" data-step="-1" ${i === 0 ? 'disabled' : ''} aria-label="Lower bid">−</button>
          <output class="bidval ${isThani ? 'thani' : ''}">${bidLabel(UI.bidPick)}</output>
          <button class="step" data-step="1" ${i === opts.length - 1 ? 'disabled' : ''} aria-label="Higher bid">+</button>
        </div>
        <button class="btn primary" data-act="bid">${isThani ? 'Call Thani' : `Bid ${UI.bidPick}`}</button>
        ${R.high ? '<button class="btn" data-act="pass">Pass</button>' : ''}
      </div>
      ${jumps.length ? `<div class="jumps">Jump to ${jumps.map(v => `<button class="jump" data-jump="${v}">${bidLabel(v)}</button>`).join('')}</div>` : ''}`;
    return;
  }

  if (R.phase === 'trump') {
    if (R.bidder !== 0) { el.innerHTML = waitHTML(`Highest bidder: ${who(R.bidder)} · ${bidLabel(R.high)}`, 'Choosing the thuruppu…'); return; }
    if (UI.ntAsk) {   // No trump must be a deliberate choice
      el.innerHTML = `<div class="sheet-head"><div class="sheet-title">Play with no trump?</div>
        <div class="sheet-sub">No suit will be trump this round, and everyone is told straight away.</div></div>
        <div class="row"><button class="btn" data-act="ntno">Pick a card instead</button>
        <button class="btn primary" data-act="ntyes">Yes, no trump</button></div>`;
      return;
    }
    const sel = R.hands[0].find(c => c.id === UI.sel);
    el.innerHTML = `<div class="sheet-head"><div class="sheet-title">You won at ${R.high}. Pick your thuruppu.</div>
      <div class="sheet-sub">Tap a card. It goes face-down and its suit becomes trump.</div></div>
      <div class="row">
        <button class="btn primary" data-act="settrump" ${sel ? '' : 'disabled'}>${sel ? `Set ${symHTML(sel.suit)} as thuruppu` : 'Select a card'}</button>
      </div>
      <div class="jumps"><button class="linkbtn" data-act="nt">or play with no trump…</button></div>`;
    return;
  }

  if (R.phase === 'play' || R.phase === 'roundEnd') {
    if (R.busy && R.decided) { el.innerHTML = waitHTML('Round decided', 'Showing the remaining cards…', true); return; }
    if (R.busy && R.plays.length) {
      const w = R.plays[winnerIndex(R.plays)].p;
      el.innerHTML = waitHTML(`${who(w)} ${vb(w, 'takes', 'take')} the trick`, `+${trickPoints(R.plays)} for ${TEAM_NAME[team(w)]}`, true);
      return;
    }
    if (R.phase === 'roundEnd' || R.turn !== 0) {
      const sub = R.phase !== 'roundEnd' && sitsOut(0)
        ? `You sit out this Thani. ${who(R.bidder)} must win all 8 tricks.`
        : R.phase !== 'roundEnd' && cotHint(0)
        ? `Your team has made ${R.high} and ${TEAM_NAME[1]} has 0 points: you can <b>call COT</b> on your turn.`
        : lastTrickTxt();
      el.innerHTML = waitHTML(R.phase === 'roundEnd' ? 'Round over' : `Waiting for ${who(R.turn)}`, sub);
      return;
    }
    const L = legal(0);
    const led = R.plays.length ? R.plays[0].card.suit : null;
    let title, sub;
    if (R.thani && R.bidder === 0 && !led) { title = `Thani: trick ${R.trickNo + 1} of 8`; sub = 'Lead your unbeatable cards first: Jacks before the 9s.'; }
    else if (R.thani && R.bidder !== 0 && led) { title = `Follow ${symHTML(led)}`; sub = `Beat ${esc(NAMES[R.bidder])}'s card to break the Thani.`; }
    else if (R.mustPlayTrump && R.bidder === 0 && R.trump.revealedBy === 0) { title = 'Thuruppu revealed'; sub = 'Cut with your face-down card.'; }
    else if (R.mustPlayTrump) { title = 'Thuruppu revealed'; sub = `Play a ${symHTML(R.trump.suit)} if you have one.`; }
    else if (!led && R.bidder === 0 && !R.trump.revealed && R.trump.suit !== 'NT') { title = 'Your lead'; sub = 'Thuruppu cards stay in hand until it is revealed.'; }
    else if (!led) { title = 'Your lead'; sub = 'Any card. Tap to pick, tap again to play.'; }
    else if (L.canReveal && !L.cards.length) { title = `No ${symHTML(led)} in hand`; sub = 'Only thuruppu cards left. Reveal the thuruppu to play one.'; }
    else if (L.canReveal) { title = `No ${symHTML(led)} in hand`; sub = R.bidder === 0 ? 'Discard a non-thuruppu card, or reveal and cut with your face-down card.' : 'Discard a card, or reveal the thuruppu and cut.'; }    else if (L.isVoid) { title = `No ${symHTML(led)} in hand`; sub = 'Play any card.'; }
    else { title = `Follow ${symHTML(led)}`; sub = 'Tap to pick, tap again to play.'; }
    const sel = L.cards.find(c => c.id === UI.sel);
    const cotKey = `${G.roundNo}|${R.trickNo}|${R.plays.length}`;
    if (UI.cotArm && UI.cotArm !== cotKey) UI.cotArm = null;
    const cotBtn = canCallCot(0)
      ? `<button class="btn cotbtn ${UI.cotArm ? 'armed' : ''}" data-act="cot">${UI.cotArm ? 'Confirm COT: all 56' : 'Call COT'}</button>` : '';
    const cotNote = UI.cotArm ? '<br><b>COT:</b> your team must take every point. Made +2, failed +3 to them.'
      : cotHint(0) ? `<br>Bid made and ${TEAM_NAME[1]} has 0 points: <b>call COT</b> to claim all 56?` : '';
    el.innerHTML = `<div class="sheet-head"><div class="sheet-title go">${title}</div><div class="sheet-sub">${sub}${cotNote}</div></div>
      <div class="row">
        <button class="btn primary" data-act="play" ${sel ? '' : 'disabled'}>${sel ? `Play ${cardHTMLMini(sel)}` : 'Pick a card'}</button>
        ${L.canReveal ? '<button class="btn danger" data-act="reveal">Reveal thuruppu</button>' : ''}
        ${cotBtn}
      </div>`;
  }
}

const cardHTMLMini = c => `<span class="mini ${isRed(c.suit) ? 'red' : ''}">${c.rank}${SUIT_SYM[c.suit]}</span>`;
function lastTrickTxt() {
  const lt = G.R.lastTrick;
  return lt ? `Last trick: ${who(lt.winner)} +${lt.pts}` : '';
}
function waitHTML(title, sub, hot) {
  return `<div class="sheet-head wait"><div class="sheet-title">${title}${hot ? '' : '<span class="dots"><i></i><i></i><i></i></span>'}</div>
    <div class="sheet-sub">${sub || '&nbsp;'}</div></div>`;
}

function renderHand() {
  const R = G.R;
  const hand = R.hands[0];
  let legalIds = null;
  if (R.phase === 'play' && R.turn === 0 && !R.busy) legalIds = new Set(legal(0).cards.map(c => c.id));
  const picking = R.phase === 'trump' && R.bidder === 0;
  if (UI.sel != null && !hand.some(c => c.id === UI.sel)) UI.sel = null;
  const el = $('#hand');
  el.style.setProperty('--n', Math.max(hand.length, 4));
  el.innerHTML = hand.map(c => {
    const cls = [];
    if (picking) cls.push('playable');
    else if (legalIds) cls.push(legalIds.has(c.id) ? 'playable' : 'illegal');
    if (c.id === R.trump.indicator && !R.trump.revealed) cls.push('indicator');
    if (c.id === UI.sel) cls.push('sel');
    if (c.id === UI.shake) cls.push('shake');
    return cardHTML(c, cls.join(' '));
  }).join('');
  UI.shake = null;
}

// ---------- Overlays ----------
function renderOverlay() {
  const o = $('#overlay');
  const kind = UI.overlay;
  if (!kind) { o.hidden = true; o.innerHTML = ''; return; }
  o.hidden = false;
  o.className = 'overlay ' + kind;
  if (kind === 'intro') o.innerHTML = introHTML();
  else if (kind === 'menu') o.innerHTML = NET.on ? onlineMenuHTML() : menuHTML();
  else if (kind === 'friends') o.innerHTML = friendsHTML();
  else if (kind === 'lobby') o.innerHTML = lobbyHTML();
  else if (kind === 'confirmLeave') o.innerHTML = `<div class="box"><h2>Leave the table?</h2>
      <p>A bot takes your seat. You can join again with the code while the game is on.</p>
      <div class="row end"><button class="btn" data-act="back">Stay</button><button class="btn primary" data-act="leaveTable">Leave</button></div></div>`;
  else if (kind === 'rules') o.innerHTML = rulesHTML();
  else if (kind === 'log') o.innerHTML = logHTML();
  else if (kind === 'names') o.innerHTML = namesHTML();
  else if (kind === 'decided') o.innerHTML = decidedHTML();
  else if (kind === 'draw') o.innerHTML = drawHTML();
  else if (kind === 'confirmScoring') o.innerHTML = `<div class="box"><h2>Switch to ${UI.pendingScoring === 'kitty' ? 'Kitty &amp; Joker' : 'First to 12'}?</h2>
      <p>The two scores can't be carried over, so a new match starts and the current score is lost. The career score carries on.</p>
      <div class="row end"><button class="btn" data-act="back">Keep playing</button><button class="btn primary" data-act="scoringYes">Switch and start</button></div></div>`;
  else if (kind === 'confirmShuffle') o.innerHTML = `<div class="box"><h2>Shuffle the teams?</h2>
      <p>A new Ace draw decides who plays with whom, and a new match starts. The current score and the career score start again.</p>
      <div class="row end"><button class="btn" data-act="back">Keep playing</button><button class="btn primary" data-act="drawgo">Draw teams</button></div></div>`;
  else if (kind === 'confirmNew') o.innerHTML = `<div class="box"><h2>Start a new match?</h2>
      <p>The current match and its score will be lost.</p>
      <div class="row end"><button class="btn" data-act="back">Keep playing</button><button class="btn primary" data-act="new">New match</button></div></div>`;
  else if (kind === 'round') o.innerHTML = roundHTML();
}

function introHTML() {
  const saved = G && !matchOver() ? G : null;
  return `<div class="box intro">
    <div class="intro-mark"><span>56</span></div>
    <h1>Thuruppu 56</h1>
    <p class="lead">${TEAMS.drawn
      ? `Six players, two teams of three. You play in the <span class="t0c">${TEAM_SYM[0]} ${TEAM_NAME[0]}</span> with ${esc(NAMES[2])} and ${esc(NAMES[4])}, against ${esc(NAMES[1])}, ${esc(NAMES[3])} and ${esc(NAMES[5])}.`
      : 'Six players, two teams of three. The teams are drawn with Aces when you start: the first three to get an Ace form the Black team.'}</p>
    <ul class="facts">
      <li><b>J 9 A 10 K Q</b><span>high to low</span></li>
      <li><b>3 · 2 · 1 · 1</b><span>points for J, 9, A, 10</span></li>
      <li><b>Thuruppu</b><span>the bid winner's hidden trump</span></li>
      ${scoring === 'kitty'
        ? '<li><b>7 · 7</b><span>kitty cards; can&rsquo;t pay and your team gets a Joker</span></li>'
        : `<li><b>${TARGET}</b><span>game points wins the match</span></li>`}
    </ul>
    <div class="col">
      ${saved ? `<button class="btn primary wide" data-act="resume">Continue · round ${saved.roundNo}, ${saved.mode === 'kitty' ? `kitty ${saved.kitty[0]}–${saved.kitty[1]}` : `${saved.score[0]}–${saved.score[1]}`}</button>
                 <button class="btn wide" data-act="new">New match</button>`
              : '<button class="btn primary wide" data-act="new">Start match</button>'}
      <button class="btn wide friends-btn" data-act="friends">Play with friends</button>
      <button class="btn ghost wide" data-act="names">Player names</button>
      ${TEAMS.drawn ? '<button class="btn ghost wide" data-act="shuffleTeams">Shuffle teams</button>' : ''}
      ${scoringSeg()}
      <button class="btn ghost wide" data-act="rules">How to play</button>
    </div>${versionHTML()}</div>`;
}

function drawHTML() {
  const d = UI.draw;
  const shown = d.seq.slice(0, d.step);
  const done = d.step >= d.seq.length;
  const seats = [1, 2, 3, 4, 5, 0].map(i => (d.drawDealer + i) % 6);       // dealing order
  const rows = seats.map(s => {
    const got = shown.filter(x => x.seat === s);
    const ace = got.some(x => x.card.rank === 'A');
    return `<div class="draw-row ${ace ? 'has-ace' : ''}">
      <span class="draw-name">${esc(NAMES[s])}</span>
      <span class="draw-cards">${got.map(x => `<span class="mini ${isRed(x.card.suit) ? 'red' : ''} ${x.card.rank === 'A' ? 'ace' : ''}">${x.card.rank}${SUIT_SYM[x.card.suit]}</span>`).join('')}</span>
      ${ace ? '<span class="draw-tag black">♠ Black</span>' : done ? '<span class="draw-tag red">♥ Red</span>' : ''}</div>`;
  }).join('');
  const blackNames = d.aces.map(s => esc(NAMES[s])).join(', ');
  const redNames = [0, 1, 2, 3, 4, 5].filter(s => !d.aces.includes(s)).map(s => esc(NAMES[s])).join(', ');
  return `<div class="box draw">
    <h2>Drawing teams</h2>
    <p class="muted">${esc(NAMES[d.drawDealer])} deals face-up. The first three to get an Ace form the Black team.</p>
    <div class="draw-list">${rows}</div>
    ${done ? `<div class="draw-result">
        <div><b class="tk">♠ Black team</b> ${blackNames}</div>
        <div><b class="tr">♥ Red team</b> ${redNames}</div>
        <div class="muted">${esc(NAMES[d.aces[0]])} got the first Ace and deals first.</div></div>` : ''}
    <div class="row end">
      ${done ? '<button class="btn" data-act="drawgo">Draw again</button><button class="btn primary" data-act="drawstart">Start match</button>'
             : '<button class="btn" data-act="drawskip">Skip</button>'}
    </div></div>`;
}

function decidedHTML() {
  const R = G.R, bt = team(R.bidder), d = R.decided || {};
  const rows = [0, 1, 2, 3, 4, 5].filter(p => R.hands[p].length).map(p => `
    <div class="dec-row t${team(p)}"><span class="dec-name">${esc(NAMES[p])}</span>
      <span class="dec-cards">${R.hands[p].map(cardHTMLMini).join('')}</span></div>`).join('');
  return `<div class="box decided">
    <div class="verdict ${d.kind === 'made' ? (bt === 0 ? 'good' : 'bad') : (bt === 0 ? 'bad' : 'good')}">Round decided</div>
    <p>${d.kind === 'set'
      ? `${TEAM_NAME[bt]} can no longer reach ${bidLabel(R.high)}.`
      : `${TEAM_NAME[bt]} has made ${bidLabel(R.high)}.`} Remaining cards:</p>
    <div class="dec-list">${rows}</div></div>`;
}

function namesHTML() {
  const role = i => i === 0 ? 'You' : team(i) === 0 ? 'Partner' : 'Opponent';
  return `<div class="box names"><h2>Player names</h2>
    <p class="muted">Listed in seating order, counter-clockwise from you. Saved on this phone or browser.</p>
    <form id="namesForm" class="names-list" autocomplete="off">
      ${NAMES.map((n, i) => `<label class="nrow t${team(i)}" for="name${i}">
        <span class="ndot"></span>
        <span class="nrole">${role(i)}<em>${TEAM_NAME[team(i)]}</em></span>
        <input id="name${i}" maxlength="${NAME_MAX}" value="${i === 0 && n === 'You' ? '' : esc(n)}" placeholder="${i === 0 ? 'Your name' : esc(DEFAULT_NAMES[i])}">
      </label>`).join('')}
      <button type="submit" hidden></button>
    </form>
    <div class="row end"><button class="btn ghost" data-act="namesReset">Defaults</button><button class="btn" data-act="back">Cancel</button><button class="btn primary" data-act="namesSave">Save</button></div></div>`;
}

function saveNames() {
  NAMES = NAMES.map((_, i) => cleanName((document.getElementById('name' + i) || {}).value, i));
  try { localStorage.setItem(NAMES_KEY, JSON.stringify(NAMES)); } catch (e) { /* ignore */ }
  onAction('back');
  if (G) { renderTop(); renderTable(); renderSheet(); renderHand(); }
  renderOverlay();
}

function scoringSeg() {
  return `<div class="seg" role="group" aria-label="Scoring">
    <span>Scoring</span>
    <button class="segbtn ${scoring === 'twelve' ? 'on' : ''}" data-scoring="twelve">First to 12</button>
    <button class="segbtn ${scoring === 'kitty' ? 'on' : ''}" data-scoring="kitty">Kitty &amp; Joker</button>
  </div>`;
}

/** Bot speed buttons. `attr` is the data attribute the buttons carry, or null to show them disabled (online guests). */
function speedSeg(cur, attr) {
  return `<div class="seg" role="group" aria-label="Bot speed"><span>Bot speed</span>
    ${Object.keys(SPEEDS).map(v => `<button class="segbtn ${cur === v ? 'on' : ''}" ${attr ? `${attr}="${v}"` : 'disabled'}>${SPEED_LABEL[v]}</button>`).join('')}</div>`;
}

function versionHTML() {
  return `<div class="ver"><b>Version ${APP_VERSION.name}</b> (build ${APP_VERSION.build}) · ${APP_VERSION.date}<br>${APP_VERSION.note}</div>`;
}

function menuHTML() {
  return `<div class="box menu"><h2>Menu</h2>
    <div class="col">
      <button class="btn wide" data-act="log">Game log</button>
      <button class="btn wide" data-act="names">Player names</button>
      <button class="btn wide" data-act="shuffleTeams">Shuffle teams</button>
      <button class="btn wide" data-act="rules">How to play</button>
      ${speedSeg(speed, 'data-speed')}
      ${scoringSeg()}
      <button class="btn wide" data-act="askNew">New match</button>
      <button class="btn primary wide" data-act="back">Back to table</button>
    </div>${careerHTML()}${versionHTML()}</div>`;
}

function logHTML() {
  return `<div class="box log"><h2>Game log</h2><ul>${G.log.map(l => `<li>${fmt(l)}</li>`).join('')}</ul>
    <div class="row end"><button class="btn primary" data-act="back">Back to table</button></div></div>`;
}

function roundHTML() {
  const R = G.R, r = R.result;
  const over = matchOver();
  const winTeam = G.score[0] >= TARGET ? 0 : 1;
  const good = r.to === 0;
  return `<div class="box round">
    <div class="verdict ${good ? 'good' : 'bad'}">${r.thani
      ? (r.made ? `${esc(NAMES[R.bidder])} won the Thani!` : `${esc(NAMES[R.bidder])}'s Thani was broken`)
      : r.cot ? (r.made ? `${TEAM_NAME[r.bt]} made the COT!` : `${TEAM_NAME[r.bt]}'s COT failed`)
      : r.made ? `${TEAM_NAME[r.bt]} made it` : `${TEAM_NAME[r.bt]} went set`}</div>
    <div class="tally">
      <div class="tal t0"><span>${TEAM_SYM[0]} ${TEAM_NAME[0]}</span><b>${R.captured[0]}</b></div>
      <div class="tal-mid">of 56</div>
      <div class="tal t1"><span>${TEAM_SYM[1]} ${TEAM_NAME[1]}</span><b>${R.captured[1]}</b></div>
    </div>
    <dl class="sum">
      <div><dt>Bid</dt><dd><b>${bidLabel(r.bid)}</b> by ${who(R.bidder)}</dd></div>
      ${r.cot ? `<div><dt>COT</dt><dd>called by ${who(r.cot.by)} in trick ${r.cot.trick}</dd></div>` : ''}
      ${r.thani
        ? `<div><dt>Tricks won</dt><dd><b>${R.tricksWon[R.bidder]}</b> of 8 by ${who(R.bidder)}</dd></div>`
        : `<div><dt>Thuruppu</dt><dd>${suitHTML(R.trump.suit)}${R.trump.revealed ? '' : ' <span class="muted">(never revealed)</span>'}</dd></div>`}
      ${r.kitty ? `
      <div><dt>Kitty</dt><dd>${TEAM_NAME[r.kitty.from]} ${r.kitty.from === 0 ? 'pay' : 'pays'} <b>${r.kitty.paid}</b> card${r.kitty.paid === 1 ? '' : 's'}</dd></div>
      ${r.jokerOff && r.jokerOff.length ? `<div><dt>Joker removed</dt><dd>🃏 ${r.jokerOff.map(who).join(', ')}</dd></div>` : ''}
      ${r.jokerTo != null ? `<div><dt>Joker!</dt><dd class="bad">🃏 ${TEAM_NAME[r.jokerTo]} couldn't pay; kitty reset to 7 · 7</dd></div>` : ''}
      <div><dt>Kitty now</dt><dd>${TEAM_NAME[0]}: ${kittyText(0)}<br>${TEAM_NAME[1]}: ${kittyText(1)}</dd></div>
      <div><dt>Jokers now</dt><dd>${G.joker.some(j => j > 0)
        ? [0, 1, 2, 3, 4, 5].filter(s => G.joker[s] > 0).map(s => `<span class="t${team(s)}c">${esc(NAMES[s])}</span>${G.joker[s] > 1 ? ' ×' + G.joker[s] : ''}`).join(', ')
        : '<span class="muted">none</span>'}</dd></div>`
      : `
      <div><dt>Game points</dt><dd><b>+${r.gain}</b> to ${TEAM_NAME[r.to]}</dd></div>
      <div><dt>Match</dt><dd><span class="t0c">${TEAM_SYM[0]} ${G.score[0]}</span> · <span class="t1c">${TEAM_SYM[1]} ${G.score[1]}</span> <span class="muted">to ${TARGET}</span></dd></div>`}
    </dl>
    ${NET.on ? '' : careerHTML()}
    ${over ? `<div class="champ ${winTeam === 0 ? 'good' : 'bad'}">${winTeam === 0 ? 'Your team wins the match!' : `${TEAM_NAME[winTeam]} wins the match.`}</div>` : ''}
    ${NET.on ? roundWaitHTML() : ''}
    <div class="row end"><button class="btn ghost" data-act="log">Log</button><button class="btn primary" data-act="next" ${NET.on && NET.msg && NET.msg.seats[NET.msg.you].ready ? 'disabled' : ''}>${over ? 'New match' : 'Next round'}</button></div></div>`;
}

function rulesHTML() {
  return `<div class="box rules"><h2>How to play</h2>
  <h3>Teams and deck</h3>
  <p>Six players sit alternately in two teams: <span class="t0c">${TEAM_SYM[0]} ${TEAM_NAME[0]}</span> (${[0, 2, 4].map(i => esc(NAMES[i])).join(', ')}) and <span class="t1c">${TEAM_SYM[1]} ${TEAM_NAME[1]}</span> (${[1, 3, 5].map(i => esc(NAMES[i])).join(', ')}). Play goes counter-clockwise. The deck is 48 cards: two copies of J 9 A 10 K Q in each suit.</p>
  <p>Rank is <b>J, 9, A, 10, K, Q</b>. Points: J 3, 9 2, A 1, 10 1, which makes 56 in all. If two identical cards tie for best, the one played first wins.</p>
  <p>Teams are drawn with Aces: cards are dealt face-up one at a time, and the first three players to get an Ace (any suit) form the Black team; the rest are the Red team. Whoever got the first Ace deals first. The teams stay until you choose <b>Shuffle teams</b>.</p>
  <h3>Bidding</h3>
  <p>Everyone gets 4 cards. The player right of the dealer, on the other team, must open with at least 28 and cannot pass. Bidding then goes round: raise or pass. Bids run 28 to 39 in steps of 1, then 40, 42, 44, 46, then 48, 52, 56. While your own team holds the highest bid you can't make a small raise, but you can raise it to 40 or more. A player who passed may bid again later. The auction ends after five passes in a row.</p>
  <p>After the thuruppu is set and all 8 cards are dealt, there is a second round starting right of the dealer. Anyone may raise to 40 or more (and above the current bid), including the bidding team. If someone raises, the new highest bidder picks the thuruppu afresh. If all six pass, play starts with the original bid.</p>
  <h3>Thani</h3>
  <p>In the second round anyone may call <b>Thani</b>, which ranks above every bid, even 56. The Thani caller must win all 8 tricks alone: there is no thuruppu, their partners sit out, and they lead every trick. Losing a single trick ends the round. For example, J J 9 9 of spades with J J 9 9 of hearts is a sure Thani: lead the Jacks, then the 9s. Thani scores like 56: 4 points if won, 5 to the other team if lost.</p>
  <h3>COT</h3>
  <p>When the bid is under 40, any player on the bidding team may call <b>COT</b> on their turn during tricks 1 to 6, as long as the other team hasn't taken any points yet. It claims that the bidding team will take all 56 points. If they do, they score 2 instead of 1. If the other team takes any points, the COT fails at once and the other team scores 3, even if the original bid was already made.</p>
  <h3>Thuruppu</h3>
  <p>The winning bidder places one card face-down. Its suit is the secret trump. They may instead choose no trump, which is announced to everyone at once, so nobody can ask for a thuruppu that round. That card stays locked until the trump is revealed, unless it is their last card. Everyone then gets 4 more cards.</p>
  <p>The bidder cannot play a thuruppu card without revealing it: no leading or discarding one while it is hidden. They may still follow suit when someone else leads that suit. If only thuruppu cards are left, playing one reveals it.</p>
  <h3>Play</h3>
  <p>Eight tricks. Follow the led suit if you can. If you can't, discard, or tap <b>Reveal thuruppu</b>: the trump is shown to everyone and you must play a trump if you hold one. If the bidder reveals it, they cut with the face-down card itself. Trumps count only once revealed. The highest trump wins the trick, otherwise the highest card of the led suit.</p>
  <p>Once the result is certain, the round ends early and everyone's remaining cards are shown: when the bidding team can no longer reach its bid, or when it has made the bid and a COT is no longer possible.</p>
  <h3>Scoring</h3>
  <p>If the bidding team takes at least its bid it scores 1 (28–39), 2 (40–47), 3 (48–55) or 4 (56). If it falls short, the other team scores 2 (28–39), 3 (40–47), 4 (48–55) or 5 (56). Thani scores the same as 56. A COT scores 2 if made and 3 to the other team if not.</p>
  <p><b>First to 12</b> (Scoring setting): game points add up and the first team to ${TARGET} wins the match.</p>
  <p><b>Kitty &amp; Joker</b>: each team starts with a kitty of 7 cards. After each round the losing team pays the winners as many kitty cards as the game points. A team can play on with an empty kitty (14 · 0) and win cards back. Only when a team loses a round and <b>can't pay in full</b> (it owes more cards than it has) does it get a <b>Joker</b> on every member (Jokers add up), and the kitty is shared out 7 and 7 again. The Joker count in the top bar is the team's Jokers right now; each player's own Jokers show on their seat. Kitty cards are in team colours: a team that pays gives back the other team's cards first, so a kitty of 10 shows as 7 of its own colour plus 3 won. To remove Jokers, the team must win the bidding and make the bid (any bid, Thani or a made COT): in the very first round after its latest Joker, every member removes one; after that, only the player who made the winning bid removes one of their own.</p>
  <p><b>Career score</b> (in the menu and the round summary): every round's game points keep adding up in the background, whichever scoring you play. A new Ace draw starts it again.</p>
  <h3 id="friendsHelp">Playing with friends</h3>
  <p>Up to 6 people can play at one table, each on their own phone or computer. Empty seats are played by bots, so 2 to 6 people works. You need an internet connection; playing against the bots works offline as before.</p>
  <p><b>1. Create a table.</b> Tap <b>Play with friends</b>, type your name (everyone at the table sees it), and tap <b>Create a table</b>. You get a 4-letter table code, such as <b>KX7P</b>. You are the <b>host</b>.</p>
  <p><b>2. Invite.</b> Tap <b>Share…</b> to send the invite on WhatsApp or any other app. It contains a link and the code. Or tap <b>Copy code</b> and tell people the code.</p>
  <p><b>3. Join.</b> Friends tap the link to play in their browser (iPhone too), or open the app, tap <b>Play with friends</b>, type their name and the code, and tap <b>Join</b>. Everyone who joins appears in a seat. Seats left empty are bots.</p>
  <p><b>4. Start.</b> Only the host chooses the <b>scoring</b>, the <b>teams</b> (drawn with Aces, or as seated: seats 1, 3, 5 against 2, 4, 6; tap an empty seat to move) and the <b>bot speed</b>, then taps <b>Start</b>. The host can change the bot speed during the game from the menu. Others can still join a game in progress by taking a bot's seat.</p>
  <p><b>Your turn.</b> You have <b>45 seconds</b> for each turn; after that a bot plays that one turn for you. Miss two turns in a row and a bot takes over your seat until you tap <b>I'm back</b>. After each round, the next one starts when everyone taps <b>Next round</b>, or after 25 seconds.</p>
  <p><b>If you drop out.</b> If your phone loses signal or you close the app, the game carries on: your turns wait only 12 seconds, then a bot plays them. Open the game again and tap <b>Play with friends → Rejoin table</b> (or open the link again) to take your seat back with your own cards. If everyone leaves, the table pauses after 45 seconds and carries on when someone returns.</p>
  <p><b>Leaving.</b> Use <b>Leave table</b> in the menu. If the host leaves, another player becomes host. A table closes by itself after a day without play.</p>
  <div class="row end"><button class="btn primary" data-act="back">Got it</button></div></div>`;
}

let flashTimer = null;
function flash(suit) {
  flashText('Thuruppu', suit === 'NT' ? 'No trump' : SUIT_SYM[suit], isRed(suit));
}
function flashText(label, big, red) {
  const f = $('#flash');
  if (!f) return;
  f.innerHTML = `<div class="fl-label">${label}</div><div class="fl-big ${red ? 'red' : ''}">${big}</div>`;
  f.classList.add('show');
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => f.classList.remove('show'), 1700);
}

// ---------- Input ----------
let overlayReturn = null;   // where "back" goes from rules/log
function openOverlay(kind) {
  overlayReturn = UI.overlay;
  UI.overlay = kind;
  renderOverlay();
}

function onAction(act) {
  const R = G && G.R;
  switch (act) {
    case 'new': if (!TEAMS.drawn) startDraw(); else startMatch(); return;
    case 'shuffleTeams':
      if (G && !matchOver() && UI.overlay !== 'intro') { UI.overlay = 'confirmShuffle'; renderOverlay(); }
      else startDraw();
      return;
    case 'drawgo': startDraw(); return;
    case 'scoringYes':
      setScoring(UI.pendingScoring || scoring); UI.pendingScoring = null; overlayReturn = null;
      if (TEAMS.drawn) startMatch(); else startDraw();
      return;
    case 'drawskip': if (UI.draw) { UI.draw.step = UI.draw.seq.length; clearInterval(drawTimer); renderOverlay(); } return;
    case 'drawstart': finishDraw(); return;
    case 'resume': { const s = loadSaved(); if (s) resume(s); else startMatch(); return; }
    case 'menu': openOverlay('menu'); return;
    case 'rules': case 'log': case 'names': openOverlay(act); return;
    case 'friendsHelp': {     // How to play, opened at the "Playing with friends" part
      openOverlay('rules');
      const h = document.getElementById('friendsHelp');
      if (h) h.scrollIntoView({ block: 'start' });
      return;
    }
    case 'namesReset':
      DEFAULT_NAMES.forEach((n, i) => { const el = document.getElementById('name' + i); if (el) el.value = i === 0 ? '' : n; });
      return;
    case 'namesSave': saveNames(); return;
    case 'askNew': UI.overlay = 'confirmNew'; renderOverlay(); return;
    case 'back': {
      if (UI.overlay === 'draw') { clearInterval(drawTimer); UI.draw = null; }
      const prev = overlayReturn;
      overlayReturn = null;
      UI.overlay = ['intro', 'round', 'friends', 'lobby'].includes(prev) ? prev : null;
      if (prev === 'friends') overlayReturn = 'intro';          // the friends screen's own Back still goes home
      if (!G && !UI.overlay) UI.overlay = 'intro';
      renderOverlay();
      return;
    }
    case 'next':
      if (NET.on) { netSend({ t: 'next' }); return; }
      UI.overlay = null; nextRound(); update(); return;
    case 'friends': UI.netErr = null; UI.netBusy = false; openOverlay('friends'); return;
    case 'createTable': createTable(); return;
    case 'joinTable': joinTable(); return;
    case 'rejoin': { const s = savedTable(); if (s && s.code && readOnlineName()) openTable(s.code); return; }
    case 'share': shareTable(); return;
    case 'copycode': copyCode(); return;
    case 'startTable': netSend({ t: 'start' }); return;
    case 'leaveTable': leaveTable(); return;
    case 'askLeave': UI.overlay = 'confirmLeave'; renderOverlay(); return;
    case 'imback': netSend({ t: 'back' }); return;
  }
  if (!R) return;
  switch (act) {
    case 'bid': move('bid', UI.bidPick); return;
    case 'pass': move('bid', null); return;
    case 'nt': UI.ntAsk = true; UI.sel = null; renderSheet(); renderHand(); return;
    case 'ntno': UI.ntAsk = false; renderSheet(); return;
    case 'ntyes': UI.ntAsk = false; move('trump', 'NT'); return;
    case 'settrump': if (UI.sel != null) move('trump', UI.sel); return;
    case 'play': if (UI.sel != null) move('play', UI.sel); return;
    case 'reveal': UI.sel = null; move('reveal'); return;
    case 'cot': {
      const key = `${G.roundNo}|${R.trickNo}|${R.plays.length}`;
      if (UI.cotArm === key) { UI.cotArm = null; move('cot'); }
      else { UI.cotArm = key; renderSheet(); }
      return;
    }
  }
}

function onCardTap(id) {
  const R = G.R;
  if (R.phase === 'trump' && R.bidder === 0) {
    UI.ntAsk = false;                                // tapping a card means "pick a card instead"
    if (UI.sel === id) { move('trump', id); return; }
    UI.sel = id; renderSheet(); renderHand(); return;
  }
  if (R.phase !== 'play' || R.turn !== 0 || R.busy) return;
  const ok = legal(0).cards.some(c => c.id === id);
  if (!ok) { UI.shake = id; renderHand(); return; }
  if (UI.sel === id) { move('play', id); return; }
  UI.sel = id; renderSheet(); renderHand();
}

document.addEventListener('click', e => {
  const t = e.target.closest('button, .card');
  if (!t) {
    if (e.target.id === 'overlay' && UI.overlay && !['intro', 'round', 'decided', 'lobby'].includes(UI.overlay)) onAction('back');
    return;
  }
  if (t.dataset.act) { onAction(t.dataset.act); return; }
  if (t.dataset.netscoring) { netSend({ t: 'settings', scoring: t.dataset.netscoring }); return; }
  if (t.dataset.netteams) { netSend({ t: 'settings', teams: t.dataset.netteams }); return; }
  if (t.dataset.netspeed) { netSend({ t: 'settings', speed: t.dataset.netspeed }); return; }
  if (t.dataset.seat != null && NET.on) { netSend({ t: 'seat', seat: +t.dataset.seat }); return; }
  if (t.dataset.speed) {
    speed = t.dataset.speed;
    try { localStorage.setItem(SPEED_KEY, speed); } catch (err) { /* ignore */ }
    renderOverlay();
    return;
  }
  if (t.dataset.scoring) {
    const want = t.dataset.scoring;
    if (want === scoring) return;
    // Switching mid-game starts a new match (the two scores can't be converted), so ask first.
    if (G && G.R && G.R.phase !== 'roundEnd' && UI.overlay !== 'intro') { UI.pendingScoring = want; UI.overlay = 'confirmScoring'; renderOverlay(); return; }
    setScoring(want);
    if (G && UI.overlay !== 'intro') { if (TEAMS.drawn) startMatch(); else startDraw(); }
    else renderOverlay();
    return;
  }
  if (!G) return;
  if (t.dataset.step) {
    const opts = legalBids(0);
    const i = Math.max(0, Math.min(opts.length - 1, opts.indexOf(UI.bidPick) + +t.dataset.step));
    UI.bidPick = opts[i]; renderSheet();
    return;
  }
  if (t.dataset.jump) { UI.bidPick = +t.dataset.jump; renderSheet(); return; }
  if (t.classList.contains('card') && t.closest('#hand')) onCardTap(+t.dataset.id);
});

document.addEventListener('submit', e => {
  if (e.target.id === 'namesForm') { e.preventDefault(); saveNames(); }
});

document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && UI.overlay && !['intro', 'round', 'decided', 'lobby'].includes(UI.overlay)) onAction('back');
});

// =========================================================================
//  Online play: friends at one table through the game server (server/src/index.js)
//  The server sends each player their own view, turned so they sit at seat 0, so the
//  table above draws it unchanged; our moves go to the server instead of the engine.
// =========================================================================
// The live server for the app and the public page; the test page (…/thuruppu/test/) uses the test server.
const SERVER_DEFAULT = /\/thuruppu\/test\//.test(location.pathname)
  ? 'https://thuruppu-test.kalpakastudiohq.workers.dev'
  : 'https://thuruppu.kalpakastudiohq.workers.dev';
const SHARE_PAGE = 'https://kalpaka-studio.github.io/thuruppu/play/';
const ONLINE_KEY = 'thuruppu56.online';      // { code } of the table we're at, to rejoin after a reload
const PID_KEY = 'thuruppu56.pid';            // a random id for this phone: how the table knows us again
const ONAME_KEY = 'thuruppu56.onlineName';
const NET = { on: false, ws: null, code: null, msg: null, status: 'off', retry: 0, retryTimer: null, ping: null, deadline: null, nextAt: null, round: 0, leaving: false };
const lsGet = k => { try { return localStorage.getItem(k); } catch (e) { return null; } };
const lsSet = (k, v) => { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (e) { /* ignore */ } };
function serverURL() {
  const q = new URLSearchParams(location.search).get('server');     // ?server=http://127.0.0.1:8787 for testing
  if (q) lsSet('thuruppu56.server', q);
  return lsGet('thuruppu56.server') || SERVER_DEFAULT;
}
function myPid() {
  let id = lsGet(PID_KEY);
  if (!id) { id = 'p' + Array.from(crypto.getRandomValues(new Uint8Array(12)), b => (b % 36).toString(36)).join(''); lsSet(PID_KEY, id); }
  return id;
}
const onlineName = () => lsGet(ONAME_KEY) || (!NET.on && NAMES[0] !== 'You' ? NAMES[0] : '');
const savedTable = () => { try { return JSON.parse(lsGet(ONLINE_KEY) || 'null'); } catch (e) { return null; } };
const netSeat = p => NET.msg && NET.msg.seats[(p + NET.msg.you) % 6];
function netSend(m) { try { if (NET.ws && NET.ws.readyState === 1) NET.ws.send(JSON.stringify(m)); } catch (e) { /* reconnects */ } }

/** A move by you: to the server when online, straight to the engine when playing the bots. */
function move(a, v) {
  if (NET.on) { netSend({ t: 'act', a, v }); if (a === 'play') UI.sel = null; return; }
  if (a === 'bid') doBid(0, v);
  else if (a === 'trump') setTrump(0, v);
  else if (a === 'play') { playCard(0, v); UI.sel = null; }
  else if (a === 'reveal') reveal(0);
  else if (a === 'cot') callCot(0);
  update();
}

async function createTable() {
  const name = readOnlineName();
  if (!name) return;
  UI.netErr = null; UI.netBusy = true; renderOverlay();
  try {
    const res = await fetch(serverURL() + '/rooms', { method: 'POST' });
    if (!res.ok) throw new Error('server ' + res.status);
    const { code } = await res.json();
    openTable(code);
  } catch (e) {
    UI.netBusy = false; UI.netErr = "Couldn't reach the game server. Check your internet and try again."; renderOverlay();
  }
}
function joinTable() {
  const name = readOnlineName();
  const code = ((document.getElementById('onCode') || {}).value || '').trim().toUpperCase();
  if (!name) return;
  if (!/^[A-Z0-9]{4}$/.test(code)) { UI.netErr = 'Enter the 4-letter table code, like KX7P.'; UI.joinCode = code; renderOverlay(); return; }
  openTable(code);
}
function readOnlineName() {
  const el = document.getElementById('onName');
  const name = ((el && el.value) || '').trim().slice(0, NAME_MAX);
  if (!name) { UI.netErr = 'Enter your name first.'; renderOverlay(); return null; }
  if (/^(you|me|player)$/i.test(name)) { UI.netErr = 'Please enter your own name, so the others know who you are.'; renderOverlay(); return null; }
  lsSet(ONAME_KEY, name);
  return name;
}

function openTable(code) {
  clearTimeout(timer);
  if (G && !NET.on) save();                   // keep the game against the bots for later
  Object.assign(NET, { on: true, code, msg: null, retry: 0, leaving: false, round: 0 });
  lsSet(ONLINE_KEY, JSON.stringify({ code }));
  UI.netErr = null; UI.netBusy = true;
  connect();
}
function connect() {
  clearTimeout(NET.retryTimer);
  NET.status = 'connecting';
  let ws;
  try { ws = new WebSocket(serverURL().replace(/^http/, 'ws') + '/rooms/' + NET.code + '/ws'); }
  catch (e) { return retryLater(); }
  NET.ws = ws;
  ws.onopen = () => {
    NET.status = 'open'; NET.retry = 0;
    netSend({ t: 'hello', pid: myPid(), name: onlineName() });
    clearInterval(NET.ping);
    NET.ping = setInterval(() => netSend({ t: 'ping' }), 25000);
    if (G) renderSheet();
  };
  ws.onmessage = e => { let m; try { m = JSON.parse(e.data); } catch (err) { return; } onNetMessage(m); };
  ws.onclose = e => {
    if (NET.ws !== ws) return;
    clearInterval(NET.ping);
    if (!NET.on || NET.leaving) return;
    if (e.code === 4004 || e.code === 4009 || e.code === 4001 || e.code === 4000) return;   // handled by the error message
    retryLater();
  };
}
function retryLater() {
  if (!NET.on) return;
  NET.status = 'retrying';
  NET.retry = Math.min(NET.retry + 1, 5);
  NET.retryTimer = setTimeout(connect, [0, 1000, 2000, 4000, 6000, 8000][NET.retry]);
  if (G && NET.msg && NET.msg.phase === 'playing') renderSheet(); else renderOverlay();
}
function leaveTable(tellServer = true) {
  if (tellServer) netSend({ t: 'leave' });
  NET.leaving = true; NET.on = false; NET.status = 'off';
  clearTimeout(NET.retryTimer); clearInterval(NET.ping);
  try { NET.ws && NET.ws.close(1000); } catch (e) { /* ignore */ }
  NET.ws = null; NET.msg = null; NET.code = null;
  lsSet(ONLINE_KEY, null);
  restoreLocal();
  UI.overlay = 'intro'; overlayReturn = null;
  if (G) { renderTop(); renderTable(); renderSheet(); renderHand(); }
  renderOverlay();
}
/** Back from a table: our own names, teams and the game against the bots. */
function restoreLocal() {
  try { const s = JSON.parse(localStorage.getItem(NAMES_KEY) || 'null'); NAMES = Array.isArray(s) && s.length === 6 ? s.map(cleanName) : DEFAULT_NAMES.slice(); } catch (e) { NAMES = DEFAULT_NAMES.slice(); }
  try { const t = JSON.parse(localStorage.getItem(TEAMS_KEY) || 'null'); TEAMS = t && (t.black === 0 || t.black === 1) ? { drawn: !!t.drawn, black: t.black } : { drawn: false, black: 0 }; } catch (e) { TEAMS = { drawn: false, black: 0 }; }
  applyTeams();
  const s = loadSaved();
  G = s && (s.mode === 'kitty' || !(s.score[0] >= TARGET || s.score[1] >= TARGET)) ? s : null;
}

function onNetMessage(m) {
  if (m.t === 'pong') return;
  if (m.t === 'flash') { if (m.suit) flash(m.suit); else flashText(fmt(m.label || ''), fmt(m.big || '')); return; }
  if (m.t === 'error') {
    if (['noroom', 'full', 'replaced', 'badhello'].includes(m.code)) {
      leaveTable(false);
      UI.netErr = m.message; UI.netBusy = false; UI.joinCode = ''; UI.overlay = 'friends'; overlayReturn = 'intro';
      renderOverlay();
    }
    return;
  }
  if (m.t !== 'room') return;
  NET.msg = m; UI.netBusy = false;
  NET.deadline = m.turnLeft != null ? Date.now() + m.turnLeft : null;
  NET.nextAt = m.nextLeft != null ? Date.now() + m.nextLeft : null;
  if (m.phase === 'lobby') {
    if (!['lobby', 'rules', 'confirmLeave'].includes(UI.overlay)) { UI.overlay = 'lobby'; overlayReturn = null; }
    renderOverlay();
    return;
  }
  // Playing: show the table from our seat.
  NAMES = [0, 1, 2, 3, 4, 5].map(i => m.seats[(i + m.you) % 6].name);   // real names for everyone, you included
  TEAMS = { drawn: true, black: m.black };
  applyTeams();
  const g = m.game;
  g.R.played = new Set();
  G = g;
  if (g.roundNo !== NET.round) { NET.round = g.roundNo; UI.sel = null; UI.bidPick = null; UI.ntAsk = false; UI.cotArm = null; }
  const R = g.R;
  const passing = ['lobby', 'friends', 'intro', 'decided', 'round', null];
  if (R.phase === 'roundEnd') { if (passing.includes(UI.overlay)) UI.overlay = 'round'; }
  else if (R.busy && R.decided) { if (passing.includes(UI.overlay)) UI.overlay = 'decided'; }
  else if (passing.includes(UI.overlay)) UI.overlay = null;
  render();
}

function shareTable() {
  const code = NET.code;
  // Share the page we're on (so the test page shares the test page); the app shares the public page.
  const page = /^https?:$/.test(location.protocol) && location.hostname.endsWith('github.io') ? location.origin + location.pathname : SHARE_PAGE;
  const link = `${page}?room=${code}`;
  const text = `Join my Thuruppu 56 table! Tap ${link} or open the app and enter code ${code}.`;
  if (navigator.share) { navigator.share({ title: 'Thuruppu 56', text }).catch(() => { /* cancelled */ }); return; }
  window.open('https://wa.me/?text=' + encodeURIComponent(text), '_blank');
}
function copyCode() {
  try { navigator.clipboard.writeText(NET.code); UI.copied = true; renderOverlay(); setTimeout(() => { UI.copied = false; if (UI.overlay === 'lobby') renderOverlay(); }, 1500); } catch (e) { /* no clipboard */ }
}

function friendsHTML() {
  const saved = savedTable();
  return `<div class="box friends"><h2>Play with friends</h2>
    <p class="muted">Up to 6 people at one table, on any phone or computer. Empty seats are played by bots.</p>
    <label class="field">Your name<input id="onName" maxlength="${NAME_MAX}" autocomplete="nickname" value="${esc(onlineName())}" placeholder="Name shown to the table"></label>
    <button class="btn primary wide" data-act="createTable" ${UI.netBusy ? 'disabled' : ''}>Create a table</button>
    <div class="or"><span>or join a friend's table</span></div>
    <div class="row join">
      <input id="onCode" class="code-in" maxlength="4" autocapitalize="characters" autocomplete="off" placeholder="CODE" value="${esc(UI.joinCode || '')}">
      <button class="btn" data-act="joinTable" ${UI.netBusy ? 'disabled' : ''}>Join</button>
    </div>
    ${saved && saved.code ? `<button class="btn ghost wide" data-act="rejoin">Rejoin table ${esc(saved.code)}</button>` : ''}
    ${UI.netBusy ? '<p class="muted center">Connecting…</p>' : ''}
    ${UI.netErr ? `<p class="err">${esc(UI.netErr)}</p>` : ''}
    <div class="row end"><button class="btn ghost" data-act="friendsHelp">How it works</button><button class="btn ghost" data-act="back">Back</button></div></div>`;
}

function lobbyHTML() {
  const m = NET.msg;
  if (!m) return `<div class="box lobby"><h2>Table ${esc(NET.code || '')}</h2><p class="muted center">${NET.status === 'retrying' ? 'Reconnecting…' : 'Connecting…'}</p>
    <div class="row end"><button class="btn ghost" data-act="leaveTable">Leave</button></div></div>`;
  const humans = m.seats.filter(s => s.human).length;
  const host = m.seats.find(s => s.host);
  const draw = m.settings.teams === 'draw';
  const seatRow = (s, i) => {
    const you = i === m.you;
    const tags = [you ? 'you' : '', s.host ? 'host' : '', s.human && !s.connected ? 'offline' : ''].filter(Boolean).map(t => `<em class="lt ${t}">${t}</em>`).join('');
    return `<button class="lseat ${s.human ? 'human' : 'bot'} ${you ? 'me' : ''} ${draw ? '' : 't' + (i % 2)}" data-seat="${i}" ${s.human ? 'disabled' : ''}>
      <span class="ls-n">${i + 1}</span><span class="ls-name">${s.human ? esc(s.name) : `<span class="muted">Bot · ${esc(s.name)}</span>`}</span>${tags}</button>`;
  };
  const seg = (label, key, opts, cur) => `<div class="seg" role="group" aria-label="${label}"><span>${label}</span>
    ${opts.map(([v, t]) => `<button class="segbtn ${cur === v ? 'on' : ''}" ${m.isHost ? `data-net${key}="${v}"` : 'disabled'}>${t}</button>`).join('')}</div>`;
  return `<div class="box lobby">
    <div class="lobby-head"><div><div class="muted small">Table code</div><div class="tcode">${esc(m.code)}</div></div>
      <div class="col"><button class="btn primary" data-act="share">Share…</button><button class="btn ghost small" data-act="copycode">${UI.copied ? 'Copied!' : 'Copy code'}</button></div></div>
    <p class="muted small">Friends open the link, or tap <b>Play with friends</b> in the app and enter the code.${NET.status !== 'open' ? ' <b>Reconnecting…</b>' : ''}</p>
    <div class="lobby-seats">${m.seats.map(seatRow).join('')}</div>
    <p class="muted small">${draw ? 'Teams are drawn with Aces when the game starts.' : 'Teams as seated: seats 1, 3, 5 against 2, 4, 6. Tap an empty seat to move.'}</p>
    ${seg('Scoring', 'scoring', [['twelve', 'First to 12'], ['kitty', 'Kitty &amp; Joker']], m.settings.scoring)}
    ${seg('Teams', 'teams', [['draw', 'Ace draw'], ['seats', 'As seated']], m.settings.teams)}
    ${speedSeg(m.settings.speed || 'normal', m.isHost ? 'data-netspeed' : null)}
    ${m.isHost
      ? `<button class="btn primary wide" data-act="startTable">Start: ${humans} ${humans === 1 ? 'player' : 'players'}${humans < 6 ? ` + ${6 - humans} ${6 - humans === 1 ? 'bot' : 'bots'}` : ''}</button>`
      : `<p class="center">Waiting for ${host ? esc(host.name) : 'the host'} to start…</p>`}
    <div class="row end"><button class="btn ghost" data-act="rules">How to play</button><button class="btn ghost" data-act="leaveTable">Leave table</button></div></div>`;
}

/** Online extras on the sheet: reconnecting, "a bot is playing for you", and the turn clock. */
function netSheetExtras() {
  if (!NET.on || !NET.msg || NET.msg.phase !== 'playing') return;
  const el = $('#sheet');
  if (NET.msg.away) {
    el.innerHTML = `<div class="sheet-head"><div class="sheet-title">A bot is playing for you</div>
      <div class="sheet-sub">You missed two turns, so a bot took your seat for now.</div></div>
      <div class="row"><button class="btn primary wide" data-act="imback">I'm back</button></div>`;
    return;
  }
  const head = el.querySelector('.sheet-head');
  if (NET.status !== 'open' && head) head.insertAdjacentHTML('afterbegin', '<div class="netwarn">Reconnecting…</div>');
  if (NET.deadline && head) head.insertAdjacentHTML('beforeend', '<div class="tmr" id="tmr"></div>');
  tickTimer();
}
function tickTimer() {
  const t = document.getElementById('tmr');
  if (t && NET.deadline) {
    const s = Math.max(0, Math.ceil((NET.deadline - Date.now()) / 1000));
    const mine = G && G.R && ((G.R.phase === 'trump' && G.R.bidder === 0) || (G.R.turn === 0 && G.R.phase !== 'trump'));
    t.textContent = mine ? `${s}s left, then a bot plays this turn for you` : `${s}s`;
    t.classList.toggle('low', s <= 10);
  }
  const n = document.getElementById('nextIn');
  if (n && NET.nextAt) n.textContent = `Next round in ${Math.max(0, Math.ceil((NET.nextAt - Date.now()) / 1000))}s`;
}
setInterval(tickTimer, 1000);

function onlineMenuHTML() {
  return `<div class="box menu"><h2>Table ${esc(NET.code || '')}</h2>
    <div class="col">
      <button class="btn wide" data-act="share">Invite more friends</button>
      <button class="btn wide" data-act="log">Game log</button>
      <button class="btn wide" data-act="rules">How to play</button>
      <button class="btn wide" data-act="askLeave">Leave table</button>
      ${NET.msg ? speedSeg(NET.msg.settings.speed || 'normal', NET.msg.isHost ? 'data-netspeed' : null) : ''}
      ${NET.msg && !NET.msg.isHost ? '<p class="muted small center">Only the host can change the bot speed.</p>' : ''}
      <button class="btn primary wide" data-act="back">Back to table</button>
    </div>${versionHTML()}</div>`;
}

// ---------- Boot ----------
function start(data) {
  document.getElementById('root').innerHTML = shellHTML();
  let saved = null;
  try { saved = data && data.save ? deserialize(data.save) : null; } catch (e) { saved = null; }
  if (saved) { resume(saved); return; }          // hot update: carry straight on
  saved = loadSaved();
  if (saved && (saved.mode === 'kitty' || !(saved.score[0] >= TARGET || saved.score[1] >= TARGET))) G = saved;
  UI.overlay = 'intro';
  // A shared link (…/play/?room=KX7P) opens straight onto the join screen.
  serverURL();                                   // remember a ?server= test address before the address is tidied
  const room = new URLSearchParams(location.search).get('room');
  if (room && /^[A-Za-z0-9]{4}$/.test(room)) {
    UI.joinCode = room.toUpperCase(); UI.overlay = 'friends'; overlayReturn = 'intro';
    try { history.replaceState(null, '', location.pathname); } catch (e) { /* ignore */ }
  }
  if (G) { renderTop(); renderTable(); renderSheet(); renderHand(); }
  renderOverlay();
}

/** The round summary at an online table: who we're still waiting for, and the auto-start clock. */
function roundWaitHTML() {
  const m = NET.msg;
  if (!m) return '';
  const waiting = m.seats.filter(s => s.human && s.connected && !s.away && !s.ready).map(s => esc(s.name));
  return `<p class="muted small center">${m.seats[m.you].ready ? (waiting.length ? `Waiting for ${waiting.join(', ')}…` : 'Starting…') : 'Tap Next round when you are ready.'}
    <br><span id="nextIn"></span></p>`;
}

// ---------- Native app (Android / iOS via Capacitor). Does nothing in a browser. ----------
(function nativeSetup() {
  const cap = window.Capacitor;
  if (!cap || !cap.isNativePlatform || !cap.isNativePlatform()) return;
  const plugin = name => (cap.Plugins && cap.Plugins[name]) || (cap.registerPlugin && cap.registerPlugin(name));
  const App = plugin('App'), StatusBar = plugin('StatusBar');
  try { StatusBar.setStyle({ style: 'DARK' }); StatusBar.setBackgroundColor({ color: '#0a1310' }); } catch (e) { /* iOS has no bar colour */ }
  try {
    // Phone back button: close a panel first; at the table open the menu rather than quitting mid-game.
    App.addListener('backButton', () => {
      if (UI.overlay === 'decided') return;          // the early-finish reveal moves on by itself
      if (UI.overlay && !['intro', 'round', 'decided', 'lobby'].includes(UI.overlay)) onAction('back');
      else if (G && UI.overlay !== 'intro') onAction('menu');
      else App.exitApp();
    });
    App.addListener('pause', () => save());          // keep the game when the app goes to the background
  } catch (e) { /* plugin missing */ }
})();

try { window.claude?.hot?.snapshot?.(() => ({ save: serialize() })); } catch (e) { /* not in a viewer */ }
if (window.claude?.hot?.ready) window.claude.hot.ready(start);
else start(window.claude?.hot?.data ?? {});
