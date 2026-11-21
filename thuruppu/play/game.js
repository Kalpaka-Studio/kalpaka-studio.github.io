'use strict';
/* =========================================================================
   Thuruppu 56 — six-player trick-taking card game (hidden-trump variant)
   Seats are numbered 0..5 counter-clockwise; the human is seat 0.
   Your team = seats 0, 2, 4 · other team = 1, 3, 5. Which is Black and which Red comes from the Ace draw.
   ========================================================================= */

// ---------- Constants ----------
const SUITS = ['S', 'H', 'C', 'D'];
const SUIT_SYM = { S: '♠', H: '♥', D: '♦', C: '♣', NT: 'NT' };
const SUIT_NAME = { S: 'Spades', H: 'Hearts', D: 'Diamonds', C: 'Clubs', NT: 'No Trump' };
const RANKS = ['J', '9', 'A', '10', 'K', 'Q'];            // high → low
const POWER = { J: 6, '9': 5, A: 4, '10': 3, K: 2, Q: 1 };
const POINTS = { J: 3, '9': 2, A: 1, '10': 1, K: 0, Q: 0 };
const BID_VALUES = [28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 42, 44, 46, 48, 52, 56];
const THANI = 57;   // the special "win every trick alone" call, ranked above 56
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
const TARGET = 12;
// The one version for the web link and the Android/iOS app (shown in the menu).
// android/app/build.gradle reads `name` and `build` from this line, so keep its shape.
// Bump `build` on every publish; bump `name` for each release (1.0.2 -> 1.0.3 for fixes, 1.1.0 for features).
const APP_VERSION = { name: '1.3.1', build: 8, date: '21 Nov 2026', note: 'Career score; your Joker shows in your name' };
const SPEEDS = { normal: { bot: 850, trick: 1500 }, fast: { bot: 420, trick: 900 } };
const SAVE_KEY = 'thuruppu56.save.v1';
const SPEED_KEY = 'thuruppu56.speed';

const team = p => p % 2;
const nextSeat = p => (p + 1) % 6;
const isRed = s => s === 'H' || s === 'D';

// The 48-card deck: two identical 24-card sets.
const CARDS = [];
for (let copy = 0; copy < 2; copy++)
  for (const s of SUITS)
    for (const r of RANKS) CARDS.push({ id: CARDS.length, suit: s, rank: r });

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function sortHand(h) {
  h.sort((a, b) => SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit) || POWER[b.rank] - POWER[a.rank]);
}

// ---------- State ----------
let G = null;            // match state (serialisable)
let timer = null;
let speed = 'normal';
try { if (localStorage.getItem(SPEED_KEY) === 'fast') speed = 'fast'; } catch (e) { /* storage blocked */ }
const SCORING_KEY = 'thuruppu56.scoring';
let scoring = 'twelve';                     // 'twelve' = first to 12, 'kitty' = Kitty & Joker
try { if (localStorage.getItem(SCORING_KEY) === 'kitty') scoring = 'kitty'; } catch (e) { /* storage blocked */ }
const delay = k => SPEEDS[speed][k];

// UI-only state
const UI = { overlay: 'intro', sel: null, bidPick: null, shake: null };

function newMatch(dealer) {
  clearTimeout(timer);
  const d = Number.isInteger(dealer) ? dealer : Math.floor(Math.random() * 6);
  G = { score: [0, 0], dealer: d, roundNo: 0, log: [], R: null, mode: scoring };
  if (scoring === 'kitty') {
    G.kitty = [7, 7];                       // index = team (0 = your team)
    G.joker = Array(6).fill(0);             // Jokers held by each seat
    G.jokerFresh = [false, false];          // team got its latest Joker last round
  }
  UI.overlay = null;
  startRound();
}

// ---------- The Ace draw: who plays with whom ----------
// Cards are dealt face-up one at a time round the table. Anyone who gets an Ace (any suit) joins the
// Black team and is skipped from then on; once three players hold Aces, the other three are Red.
// You stay at the bottom; your two team-mates take the alternate seats. The first Ace receiver deals first.
function makeDraw() {
  const drawDealer = Math.floor(Math.random() * 6);
  const deck = shuffle(CARDS.slice());
  const seq = [], aces = [];
  let seat = drawDealer;
  while (aces.length < 3) {
    seat = nextSeat(seat);
    if (aces.includes(seat)) continue;
    const card = deck.pop();
    seq.push({ seat, card });
    if (card.rank === 'A') aces.push(seat);
  }
  const youBlack = aces.includes(0);
  const mates = (youBlack ? aces : [0, 1, 2, 3, 4, 5].filter(s => !aces.includes(s))).filter(s => s !== 0).sort((a, b) => a - b);
  const others = [0, 1, 2, 3, 4, 5].filter(s => s !== 0 && !mates.includes(s));
  const order = [0, others[0], mates[0], others[1], mates[1], others[2]];   // old seat → new seat index
  return {
    drawDealer, seq, aces, step: 0,
    names: order.map(s => NAMES[s]),
    black: youBlack ? 0 : 1,
    firstDealer: order.indexOf(aces[0]),
  };
}

let drawTimer = null;
function startDraw() {
  clearTimeout(timer); clearInterval(drawTimer);
  UI.draw = makeDraw();
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
  newMatch(d.firstDealer);
  log(`Teams drawn by Aces: ${TEAM_SYM[TEAMS.black]} ${TEAM_NAME[TEAMS.black]} vs ${TEAM_SYM[1 - TEAMS.black]} ${TEAM_NAME[1 - TEAMS.black]}. ${who(G.dealer)} drew the first Ace and ${vb(G.dealer, 'deals', 'deal')}.`);
  render();
}

function startRound() {
  G.roundNo++;
  const R = {
    deck: null, pile: [],
    hands: [[], [], [], [], [], []],
    phase: 'bidding',
    high: 0, bidder: -1, passes: 0,
    lastBid: Array(6).fill(null),
    turn: nextSeat(G.dealer),
    trump: { suit: null, revealed: false, indicator: null, revealedBy: -1 },
    plays: [], leader: nextSeat(G.dealer), trickNo: 0,
    captured: [0, 0], tricksWon: Array(6).fill(0),
    mustPlayTrump: false, played: new Set(), busy: false, result: null, lastTrick: null,
    voids: [[], [], [], [], [], []],   // suits each player has shown they are out of
    notTrump: [],   // suits the whole table can rule out as thuruppu (seen the bidder lead or discard them)
  };
  G.R = R;
  const prepared = prepareDeck();
  R.deck = prepared.deck; R.shuffle = prepared.kind;
  UI.sel = null; UI.bidPick = null; UI.ntAsk = false;
  dealCards(4);
  const how = R.shuffle === 'full' ? vb(G.dealer, 'shuffles well', 'shuffle well')
    : R.shuffle === 'medium' ? vb(G.dealer, 'shuffles', 'shuffle') : vb(G.dealer, 'shuffles lightly', 'shuffle lightly');
  log(`<b>Round ${G.roundNo}</b> · ${who(G.dealer)} ${how} and ${vb(G.dealer, 'deals', 'deal')}.`);
  render();
  schedule();
}

// ---------- Shuffling & dealing, the way a real table does it ----------
// Played cards are gathered trick by trick, so each trick's suit stays clumped together.
// The dealer usually gives the pack only a light shuffle (a riffle or two and a cut), so some
// clumps survive and some players get long, strong suits. Now and then it is shuffled thoroughly.
/** A casual hand riffle: the two halves fall together a few cards at a time, not perfectly alternating. */
function riffle(deck) {
  let cut = 0;
  for (let i = 0; i < deck.length; i++) if (Math.random() < 0.5) cut++;   // split near the middle
  const a = deck.slice(0, cut), b = deck.slice(cut), out = [];
  while (a.length || b.length) {
    const src = Math.random() * (a.length + b.length) < a.length ? a : b;
    const r = Math.random(), k = r < 0.4 ? 1 : r < 0.75 ? 2 : 3;          // clumps of 1–3 cards
    out.push(...src.splice(0, k));
  }
  return out;
}
/** An overhand shuffle: small blocks pulled off the top, so blocks stay together but change order. */
function overhand(deck) {
  const src = deck.slice(), out = [];
  while (src.length) out.unshift(...src.splice(0, 3 + Math.floor(Math.random() * 6)));
  return out;
}
function cutDeck(deck) {
  const k = 8 + Math.floor(Math.random() * (deck.length - 16));
  return deck.slice(k).concat(deck.slice(0, k));
}
function prepareDeck() {
  const pile = G.pile && G.pile.length === 48 ? G.pile.map(id => CARDS[id]) : null;
  if (!pile) return { deck: shuffle(CARDS.slice()), kind: 'full' };    // new pack: first deal of a match
  const r = Math.random();                                             // mostly light, in no fixed pattern
  let d = pile, kind;
  if (r < 0.30) { d = overhand(d); kind = 'light'; }
  else if (r < 0.60) { d = riffle(d); kind = 'light'; }
  else if (r < 0.85) { d = riffle(overhand(riffle(d))); kind = 'medium'; }
  else return { deck: shuffle(pile), kind: 'full' };
  return { deck: cutDeck(d), kind };
}

/** Deal n cards to each player as one packet, starting right of the dealer. */
function dealCards(n) {
  const R = G.R;
  for (let i = 0; i < 6; i++) {
    const p = (G.dealer + 1 + i) % 6;
    for (let k = 0; k < n; k++) R.hands[p].push(R.deck.pop());
  }
  R.hands.forEach(sortHand);
}

function log(msg) {
  G.log.unshift(msg);
  if (G.log.length > 120) G.log.pop();
}
const vb = (p, third, you) => (p === 0 && NAMES[0] === 'You') ? you : third;
const who = p => `<span class="lname t${team(p)}">${esc(NAMES[p])}</span>`;
const symHTML = s => s === 'NT' ? 'NT' : `<span class="sym ${isRed(s) ? 'red' : ''}">${SUIT_SYM[s]}</span>`;
const suitHTML = s => s === 'NT' ? '<b>No Trump</b>' : `${symHTML(s)} ${SUIT_NAME[s]}`;
const cardName = c => `${c.rank}${SUIT_SYM[c.suit]}`;

// ---------- Scheduling bot turns ----------
function schedule() {
  clearTimeout(timer);
  const R = G && G.R;
  if (!R || R.busy) return;
  if (isBidding(R) && R.turn !== 0)
    timer = setTimeout(() => { if (G.R === R) doBid(R.turn, aiBid(R.turn)); }, delay('bot'));
  else if (R.phase === 'trump' && R.bidder !== 0)
    timer = setTimeout(() => { if (G.R === R) setTrump(R.bidder, aiTrump(R.bidder)); }, delay('bot') + 300);
  else if (R.phase === 'play' && R.turn !== 0)
    timer = setTimeout(() => { if (G.R === R) botPlay(R.turn); }, delay('bot'));
}

// ---------- Bidding ----------
/** Bids seat p may make. Nobody may raise over their own team's standing bid. */
function legalBids(p) {
  const R = G.R;
  let min = R.phase === 'bidding2' ? 40 : 28;     // second round (8 cards) is for 40 and above
  if (R.bidder >= 0 && team(R.bidder) === team(p)) min = 40;  // own team may only push it to 40+
  const bids = BID_VALUES.filter(v => v > R.high && v >= min);
  if (R.phase === 'bidding2' && R.high < THANI) bids.push(THANI);  // Thani: second round only, above anything
  return bids;
}
const isBidding = R => R.phase === 'bidding' || R.phase === 'bidding2';
const bidLabel = v => v === THANI ? 'Thani' : String(v);

function doBid(p, v) {
  const R = G.R;
  if (!isBidding(R) || R.turn !== p) return;
  if (v != null) {
    if (!legalBids(p).includes(v)) return;
    R.high = v; R.bidder = p; R.passes = 0; R.lastBid[p] = v;
    if (R.phase === 'bidding2') R.raised2 = true;
    log(v === THANI ? `${who(p)} ${vb(p, 'calls', 'call')} <b>Thani</b>!` : `${who(p)} ${vb(p, 'bids', 'bid')} <b>${v}</b>.`);
  } else {
    if (R.high === 0) return;           // the player next to the dealer must open — no pass
    R.passes++; R.lastBid[p] = 'Pass';
    log(`${who(p)} ${vb(p, 'passes', 'pass')}.`);
  }

  if (R.phase === 'bidding') {
    if (R.high > 0 && (R.passes >= 5 || R.high === 56)) {
      R.phase = 'trump'; R.turn = R.bidder;
      log(`${who(R.bidder)} ${vb(R.bidder, 'wins', 'win')} the auction at <b>${R.high}</b>.`);
      render(); schedule();
      return;
    }
  } else if (R.high === THANI || R.passes >= (R.raised2 ? 5 : 6)) {
    endSecondRound();
    return;
  }
  R.turn = nextSeat(p);
  render(); schedule();
}

/** After all 8 cards are dealt, everyone gets one more chance to raise to 40 or above. */
function startSecondRound() {
  const R = G.R;
  R.phase = 'bidding2'; R.turn = nextSeat(G.dealer); R.passes = 0; R.raised2 = false;
  R.lastBid = Array(6).fill(null);
  log(R.high >= 56
    ? 'Second round: call <b>Thani</b> or pass.'
    : `Second round: raise to <b>${Math.max(40, legalBids(1 - team(R.bidder))[0] || 40)}</b> or more, call Thani, or pass.`);
}

function endSecondRound() {
  const R = G.R;
  R.round2Done = true;
  if (R.high === THANI) {
    // Thani: no thuruppu at all, the bidder's partners sit out, and the bidder leads every trick.
    R.thani = true;
    R.trump = { suit: 'NT', revealed: true, indicator: null, revealedBy: -1 };
    R.notTrump = [];
    R.leader = R.bidder; R.phase = 'play'; R.turn = R.bidder;
    log(`<b>Thani!</b> ${who(R.bidder)} must win all 8 tricks alone. No thuruppu; partners sit out.`);
  } else if (R.raised2) {
    // The new highest bidder chooses the thuruppu afresh; the old face-down card simply goes back into play.
    R.trump = { suit: null, revealed: false, indicator: null, revealedBy: -1 };
    R.notTrump = [];
    R.phase = 'trump'; R.turn = R.bidder;
    log(`${who(R.bidder)} ${vb(R.bidder, 'wins', 'win')} the bid at <b>${R.high}</b> and ${vb(R.bidder, 'picks', 'pick')} a new thuruppu.`);
  } else {
    R.phase = 'play'; R.turn = R.leader;
    log(`No raise. ${who(R.leader)} ${vb(R.leader, 'leads', 'lead')}.`);
  }
  render(); schedule();
}

// ---------- Trump selection ----------
function setTrump(p, choice) {
  const R = G.R;
  if (R.phase !== 'trump' || p !== R.bidder) return;
  if (choice === 'NT') {
    // No trump is announced to everyone at once; with nothing hidden, nobody can ask for a thuruppu.
    R.trump = { suit: 'NT', revealed: true, indicator: null, revealedBy: p };
    log(`${who(p)} ${vb(p, 'chooses', 'choose')} <b>no trump</b> for this round.`);
    flashText('This round', 'No trump');
  } else {
    const c = R.hands[p].find(c => c.id === choice);
    if (!c) return;
    R.trump.suit = c.suit; R.trump.indicator = c.id;
    log(`${who(p)} secretly ${vb(p, 'sets', 'set')} the thuruppu.`);
  }
  if (R.round2Done) {
    R.phase = 'play'; R.turn = R.leader;
    log(`${who(R.leader)} ${vb(R.leader, 'leads', 'lead')}.`);
  } else {
    dealCards(4);
    log('Four more cards each.');
    startSecondRound();                  // always: even over 56, someone may call Thani
  }
  render(); schedule();
}

// ---------- Play rules ----------
function isLocked(p, c) {
  const R = G.R;
  return !R.trump.revealed && p === R.bidder && c.id === R.trump.indicator && R.hands[p].length > 1;
}

/** Legal cards for seat p right now, and whether p may ask to reveal trump. */
function legal(p) {
  const R = G.R;
  const hand = R.hands[p];
  const eff = hand.filter(c => !isLocked(p, c));
  const ts = R.trump.suit;
  const hiddenBidder = !R.trump.revealed && p === R.bidder && ts && ts !== 'NT';
  if (R.plays.length === 0) {
    // The bidder may not lead a thuruppu while it is hidden (unless nothing else is left; leading it then reveals it).
    if (hiddenBidder) {
      const non = eff.filter(c => c.suit !== ts);
      if (non.length) return { cards: non, canReveal: false, isVoid: false };
    }
    return { cards: eff, canReveal: false, isVoid: false };
  }

  const led = R.plays[0].card.suit;
  const follow = eff.filter(c => c.suit === led);
  if (follow.length) return { cards: follow, canReveal: false, isVoid: false };

  if (R.trump.revealed) {
    if (R.mustPlayTrump) {
      // A bidder who lifts their own face-down card cuts with that very card.
      const lifted = R.trump.revealedBy === p && p === R.bidder && hand.find(c => c.id === R.trump.indicator);
      if (lifted) return { cards: [lifted], canReveal: false, isVoid: true };
      const tr = ts !== 'NT' ? hand.filter(c => c.suit === ts) : [];
      return { cards: tr.length ? tr : hand, canReveal: false, isVoid: true };
    }
    return { cards: hand, canReveal: false, isVoid: true };
  }
  // Trump still hidden: void player may slough, or ask for trump to be revealed.
  // The bidder may not play a thuruppu without revealing it; with only thuruppu left they must reveal.
  const cards = hiddenBidder ? eff.filter(c => c.suit !== ts) : eff;
  return { cards, canReveal: true, isVoid: true };
}

function reveal(p) {
  const R = G.R;
  if (R.phase !== 'play' || R.turn !== p || R.busy) return false;
  if (!legal(p).canReveal) return false;
  R.trump.revealed = true; R.trump.revealedBy = p;
  R.mustPlayTrump = R.trump.suit !== 'NT';
  log(`${who(p)} ${vb(p, 'calls', 'call')} for thuruppu: ${suitHTML(R.trump.suit)}!`);
  flash(R.trump.suit);
  render();
  return true;
}

function beats(a, b) {
  // b is the current best play (led suit or an active trump)
  if (a.card.suit === b.card.suit) return POWER[a.card.rank] > POWER[b.card.rank]; // tie → earlier card keeps it
  return a.trumpPlay;
}
function winnerIndex(plays) {
  let best = 0;
  for (let i = 1; i < plays.length; i++) if (beats(plays[i], plays[best])) best = i;
  return best;
}
const trickPoints = plays => plays.reduce((s, x) => s + POINTS[x.card.rank], 0);

function playCard(p, id) {
  const R = G.R;
  if (R.phase !== 'play' || R.turn !== p || R.busy) return;
  const c = legal(p).cards.find(c => c.id === id);
  if (!c) return;
  if (!R.trump.revealed && p === R.bidder && id === R.trump.indicator) {
    R.trump.revealed = true; R.trump.revealedBy = p;
    log(`${who(p)} ${vb(p, 'plays', 'play')} the face-down card. Thuruppu is ${suitHTML(R.trump.suit)}!`);
    flash(R.trump.suit);
  } else if (!R.trump.revealed && p === R.bidder && R.plays.length === 0 && c.suit === R.trump.suit) {
    // Forced to lead a thuruppu (nothing else left): leading it reveals it.
    R.trump.revealed = true; R.trump.revealedBy = p;
    log(`${who(p)} ${vb(p, 'leads', 'lead')} a thuruppu. It is ${suitHTML(R.trump.suit)}!`);
    flash(R.trump.suit);
  }
  // Public deductions: failing to follow shows a void; a revealer who can't play thuruppu has none.
  if (!R.voids) R.voids = [[], [], [], [], [], []];
  const noteVoid = s => { if (!R.voids[p].includes(s)) R.voids[p].push(s); };
  const heldBack = p === R.bidder && !R.trump.revealed && R.hands[p].some(x => x.id === R.trump.indicator && x.suit === R.plays[0]?.card.suit);
  if (R.plays.length && c.suit !== R.plays[0].card.suit && !heldBack) noteVoid(R.plays[0].card.suit);
  if (R.mustPlayTrump && c.suit !== R.trump.suit) noteVoid(R.trump.suit);
  if (!R.trump.revealed && p === R.bidder && (R.plays.length === 0 || c.suit !== R.plays[0].card.suit)) {
    R.notTrump = R.notTrump || [];
    if (!R.notTrump.includes(c.suit)) R.notTrump.push(c.suit);
  }
  const trumpPlay = R.trump.revealed && R.trump.suit !== 'NT' && c.suit === R.trump.suit;
  R.hands[p] = R.hands[p].filter(x => x.id !== id);
  R.plays.push({ p, card: c, trumpPlay });
  R.played.add(id);
  R.mustPlayTrump = false;
  if (p === 0) UI.sel = null;

  if (R.plays.length === trickSize()) {
    R.busy = true; R.turn = -1;
    render();
    timer = setTimeout(() => finishTrick(R), delay('trick'));
  } else {
    R.turn = nextPlayer(p);
    render(); schedule();
  }
}

// ---------- COT: the bidding team claims every one of the 56 points ----------
// Only on a bid under 40, by any member of the bidding team on their turn, before the 7th trick,
// and only while the other side has taken nothing. Made: +2 instead of +1. Failed: +3 to the others.
function canCallCot(p) {
  const R = G.R;
  return R.phase === 'play' && !R.busy && R.turn === p && !R.cot && !R.thani && R.high < 40
    && team(p) === team(R.bidder) && R.trickNo < 6 && R.captured[1 - team(R.bidder)] === 0;
}
/** p's team has made its bid, the other side is on 0 and COT can still be called: worth a nudge. */
function cotHint(p) {
  const R = G.R, t = team(p);
  return R.phase === 'play' && !R.cot && !R.thani && R.high < 40 && team(R.bidder) === t
    && R.trickNo < 6 && R.captured[1 - t] === 0 && R.captured[t] >= R.high;
}
function callCot(p) {
  const R = G.R;
  if (!canCallCot(p)) return false;
  R.cot = { by: p, trick: R.trickNo + 1 };
  log(`${who(p)} ${vb(p, 'calls', 'call')} <b>COT</b>: ${TEAM_NAME[team(p)]} will take all 56 points!`);
  flashText('Called', 'COT');
  render();
  return true;
}

// In a Thani round the bidder's partners sit out: tricks are the bidder plus the three opponents.
const sitsOut = q => !!(G.R.thani && q !== G.R.bidder && team(q) === team(G.R.bidder));
const trickSize = () => G.R.thani ? 4 : 6;
function nextPlayer(p) {
  let q = nextSeat(p);
  while (sitsOut(q)) q = nextSeat(q);
  return q;
}

function finishTrick(R) {
  if (G.R !== R || !R.busy) return;
  const w = R.plays[winnerIndex(R.plays)].p;
  const pts = trickPoints(R.plays);
  R.captured[team(w)] += pts;
  R.tricksWon[w]++;
  log(`${who(w)} ${vb(w, 'takes', 'take')} trick ${R.trickNo + 1} <span class="muted">(+${pts} ${TEAM_NAME[team(w)]})</span>.`);
  R.lastTrick = { plays: R.plays, winner: w, pts };
  (R.pile = R.pile || []).push(...R.plays.map(x => x.card.id));   // gathered in play order for the next deal
  R.plays = []; R.trickNo++; R.busy = false;
  if (R.thani && w !== R.bidder) {             // one lost trick and Thani is over
    log(`${who(w)} ${vb(w, 'breaks', 'break')} the Thani!`);
    endRound(); return;
  }
  if (R.cot && R.captured[1 - team(R.bidder)] > 0) {   // the other side scored: COT is broken
    log(`${who(w)} ${vb(w, 'breaks', 'break')} the COT!`);
    endRound(); return;
  }
  if (R.trickNo === 8) { endRound(); return; }
  const decided = decidedResult(R);
  if (decided) { finishEarly(R, decided); return; }
  R.leader = w; R.turn = w;
  render(); schedule();
}

/**
 * Is the round's result already certain? 'set' when the bidding team can no longer reach its bid;
 * 'made' when it has, unless a COT is still possible (bid under 40, other side on 0, before trick 7).
 */
function decidedResult(R) {
  if (R.thani) return null;                         // Thani ends on its own (any lost trick, or all 8 won)
  const bt = team(R.bidder), got = R.captured[bt], opp = R.captured[1 - bt];
  const left = 56 - got - opp;
  if (R.cot) return opp === 0 && left === 0 ? 'made' : null;
  if (got + left < R.high) return 'set';
  if (got >= R.high && !(R.high < 40 && opp === 0 && R.trickNo < 6)) return 'made';
  return null;
}

/** Show everyone's remaining cards face-up for a moment, then go to the round summary. */
function finishEarly(R, kind) {
  const bt = team(R.bidder);
  R.decided = { kind, afterTrick: R.trickNo };
  log(kind === 'set'
    ? `${TEAM_NAME[bt]} can no longer make ${R.high}. Round decided after trick ${R.trickNo}.`
    : `${TEAM_NAME[bt]} has made ${R.high}. Round decided after trick ${R.trickNo}.`);
  R.busy = true; R.turn = -1;
  UI.overlay = 'decided';
  render();
  timer = setTimeout(() => { if (G.R === R) { R.busy = false; endRound(); } }, 2400);
}

function endRound() {
  const R = G.R;
  const bt = team(R.bidder), got = R.captured[bt], bid = R.high;
  const made = R.thani ? R.tricksWon[R.bidder] === 8 : R.cot ? got === 56 : got >= bid;
  let gain, to;
  if (R.cot) { gain = made ? 2 : 3; to = made ? bt : 1 - bt; }                         // COT: all 56 or bust
  else if (made) { gain = bid >= 56 ? 4 : bid >= 48 ? 3 : bid >= 40 ? 2 : 1; to = bt; }   // Thani scores like 56
  else { gain = bid >= 56 ? 5 : bid >= 48 ? 4 : bid >= 40 ? 3 : 2; to = 1 - bt; }
  G.score[to] += gain;
  R.phase = 'roundEnd';
  R.result = { made, gain, to, got, bid, bt, thani: !!R.thani, cot: R.cot || null };
  // Gather the rest (sitting-out partners, or an early Thani finish) so the next pack is complete.
  for (let q = 0; q < 6; q++) R.pile.push(...R.hands[q].map(c => c.id));
  G.pile = R.pile.length === 48 ? R.pile.slice() : null;   // the next dealer shuffles this pile
  log(R.thani
    ? (made ? `${who(R.bidder)} ${vb(R.bidder, 'wins', 'win')} the Thani: <b>+${gain}</b> ${TEAM_NAME[bt]}.`
            : `Thani lost: ${TEAM_NAME[to]} <b>+${gain}</b>.`)
    : R.cot
    ? (made ? `COT made, all 56 points: ${TEAM_NAME[bt]} <b>+${gain}</b>.` : `COT failed: ${TEAM_NAME[to]} <b>+${gain}</b>.`)
    : made
    ? `${TEAM_NAME[bt]} made ${bid} with ${got}: <b>+${gain}</b>.`
    : `${TEAM_NAME[bt]} went set (${got}/${bid}): ${TEAM_NAME[to]} <b>+${gain}</b>.`);
  if (isKitty()) settleKitty(R);
  addCareer(R.result);
  UI.overlay = 'round';
  render();
}

// ---------- Kitty & Joker scoring ----------
// Each team starts with 7 kitty cards; the round's loser pays the winners as many cards as the game points.
// A team that runs out gets a Joker on every member (they stack) and the kitty is shared 7 and 7 again.
// Jokers come off by winning the bidding and making it: in the very first round after the latest Joker
// every member drops one; later, only the player who made the winning bid drops one of their own.
const isKitty = () => !!(G && G.mode === 'kitty');
function setScoring(mode) {
  scoring = mode === 'kitty' ? 'kitty' : 'twelve';
  try { localStorage.setItem(SCORING_KEY, scoring); } catch (e) { /* ignore */ }
}
function settleKitty(R) {
  const r = R.result, loser = 1 - r.to, bt = r.bt;
  const paid = Math.min(r.gain, G.kitty[loser]);
  G.kitty[loser] -= paid; G.kitty[r.to] += paid;
  r.kitty = { paid, from: loser, after: G.kitty.slice() };
  log(`${TEAM_NAME[loser]} ${paid === 1 ? 'pays 1 kitty card' : `pays ${paid} kitty cards`} <span class="muted">(${TEAM_SYM[0]} ${G.kitty[0]} · ${TEAM_SYM[1]} ${G.kitty[1]})</span>.`);

  // 1. Removing Jokers: the bidding team won the bidding and made it.
  const seatsOf = t => [0, 1, 2, 3, 4, 5].filter(s => team(s) === t);
  r.jokerOff = [];
  if (r.made && seatsOf(bt).some(s => G.joker[s] > 0)) {
    const off = G.jokerFresh[bt] ? seatsOf(bt).filter(s => G.joker[s] > 0) : (G.joker[R.bidder] > 0 ? [R.bidder] : []);
    off.forEach(s => G.joker[s]--);
    r.jokerOff = off;
    if (off.length > 1) log(`🃏 ${TEAM_NAME[bt]} made it straight away: everyone removes a Joker.`);
    else if (off.length === 1) log(`🃏 ${who(off[0])} ${vb(off[0], 'removes', 'remove')} a Joker.`);
    else log(`🃏 ${who(R.bidder)} ${vb(R.bidder, 'has', 'have')} no Joker to remove.`);
  }
  G.jokerFresh = [false, false];                     // the "first round after" chance is used up either way

  // 2. Running out: Joker for the whole team, kitty shared out again.
  r.jokerTo = null;
  if (G.kitty[loser] === 0) {
    seatsOf(loser).forEach(s => G.joker[s]++);
    G.jokerFresh[loser] = true;
    G.kitty = [7, 7];
    r.jokerTo = loser;
    log(`🃏 <b>${TEAM_NAME[loser]} ran out of kitty cards and ${loser === 0 ? 'get' : 'gets'} a Joker!</b> Kitty shared out 7 and 7 again.`);
  }
  if (r.jokerTo != null || r.jokerOff.length) flashText(r.jokerTo != null ? 'Joker for' : 'Joker removed',
    r.jokerTo != null ? `${TEAM_SYM[r.jokerTo]} 🃏` : '🃏');
}

const matchOver = () => !isKitty() && (G.score[0] >= TARGET || G.score[1] >= TARGET);

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

function nextRound() {
  UI.overlay = null;
  if (matchOver()) { newMatch(); return; }
  G.dealer = nextSeat(G.dealer);
  startRound();
}

// =========================================================================
//  AI
// =========================================================================
function suitStrength(hand, s) {
  const W = { J: 5, '9': 3, A: 1.5, '10': 1, K: 0.5, Q: 0.5 };
  const cs = hand.filter(c => c.suit === s);
  return cs.reduce((t, c) => t + W[c.rank], 0) + cs.length * 1.5;
}
function bestSuit(hand) {
  let best = null, bv = -1;
  for (const s of SUITS) {
    const v = suitStrength(hand, s);
    if (v > bv) { bv = v; best = s; }
  }
  return { suit: best, value: bv };
}

function aiBid(p) {
  const R = G.R, hand = R.hands[p];
  const { suit, value } = bestSuit(hand);
  const side = hand.filter(c => c.suit !== suit)
    .reduce((t, c) => t + (c.rank === 'J' ? 2 : c.rank === '9' ? 0.5 : 0), 0);
  const noise = Math.random() * 2 - 1;
  const max = R.phase === 'bidding2'
    ? Math.floor(16.5 + (value + side) * 1.1 + noise)   // 8 cards: only very strong hands reach 40
    : Math.floor(23 + (value + side) * 0.9 + noise);
  const all = legalBids(p);
  if (all.includes(THANI) && (sureThani(hand) || thaniOdds(hand) >= THANI_NERVE)) return THANI;
  const options = all.filter(v => v !== THANI);
  if (!options.length) return null;
  const nxt = options[0];
  if (R.high === 0) return nxt;          // forced opening bid
  return nxt <= max ? nxt : null;
}

/**
 * A hand that cannot lose a trick when it leads every one with no trumps:
 * for every card held, every higher card of that suit is also in the hand
 * (an equal card elsewhere doesn't matter, because the first one played wins).
 * E.g. J J 9 9 of spades plus J J 9 9 of hearts: lead the Jacks, then the 9s.
 */
const isTop = (c, hand) => CARDS.every(o => o.suit !== c.suit || POWER[o.rank] <= POWER[c.rank] || hand.some(h => h.id === o.id));
function sureThani(hand) { return hand.every(c => isTop(c, hand)); }

/**
 * How likely is a Thani to succeed with this hand? Deal the 40 unseen cards at random many times
 * (24 to the three opponents, 16 to the partners who sit out) and play it out: the caller leads
 * a card nobody can beat, opponents follow suit keeping their high cards, and a single trick lost
 * ends it. A missing higher card may be with a partner, or an opponent may be forced to play it.
 */
const THANI_NERVE = 0.65;   // call when about 2 in 3 deals work out (+4 if won vs +5 to them if lost)
function thaniOdds(hand, samples = 240) {
  if (hand.filter(c => isTop(c, hand)).length < 4) return 0;   // nowhere near: don't bother
  const mine = new Set(hand.map(c => c.id));
  const unknown = CARDS.filter(c => !mine.has(c.id));
  let wins = 0;
  for (let s = 0; s < samples; s++) {
    const u = shuffle(unknown.slice());
    if (simThani(hand.slice(), [u.slice(0, 8), u.slice(8, 16), u.slice(16, 24)])) wins++;
  }
  return wins / samples;
}
function simThani(my, opp) {
  const beatable = c => opp.some(h => h.some(o => o.suit === c.suit && POWER[o.rank] > POWER[c.rank]));
  while (my.length) {
    const safe = my.filter(c => !beatable(c)).sort((a, b) => POWER[b.rank] - POWER[a.rank]);
    if (!safe.length) return false;
    const lead = safe[0];
    my.splice(my.indexOf(lead), 1);
    for (const h of opp) {
      const follow = h.filter(o => o.suit === lead.suit);
      const pool = follow.length ? follow : h;          // void: throw the least useful card
      pool.sort((a, b) => POWER[a.rank] - POWER[b.rank]);
      h.splice(h.indexOf(pool[0]), 1);
    }
  }
  return true;
}

function aiTrump(p) {
  const hand = G.R.hands[p];
  const { suit } = bestSuit(hand);
  const cs = hand.filter(c => c.suit === suit).sort((a, b) => POWER[a.rank] - POWER[b.rank]);
  return cs[0].id; // lowest card of the best suit goes face-down
}

function knownTrump(p) {
  const R = G.R;
  if ((R.trump.revealed || p === R.bidder) && R.trump.suit !== 'NT') return R.trump.suit;
  return null;
}
/** Unseen cards (from p's perspective) of the same suit that strictly outrank `card`. */
function unseenHigher(card, p) {
  const R = G.R;
  const mine = new Set(R.hands[p].map(c => c.id));
  return CARDS.filter(c => c.suit === card.suit && POWER[c.rank] > POWER[card.rank]
    && !R.played.has(c.id) && !mine.has(c.id)).length;
}
function unseenOfSuit(s, p) {
  const R = G.R;
  const mine = new Set(R.hands[p].map(c => c.id));
  return CARDS.filter(c => c.suit === s && !R.played.has(c.id) && !mine.has(c.id)).length;
}
function wouldWin(p, c) {
  const R = G.R;
  const tp = R.trump.revealed && R.trump.suit !== 'NT' && c.suit === R.trump.suit;
  const sim = [...R.plays, { p, card: c, trumpPlay: tp }];
  return sim[winnerIndex(sim)].p === p;
}

// ---------- Card sense: what might the players still to play be holding? ----------
// Bots only use public information: cards played, hand sizes, suits players have shown void in,
// suits the bidder has shown are not thuruppu, and their own hand.
function playersAfter(p) {
  const a = [];
  let q = p;
  for (let i = G.R.plays.length + 1; i < trickSize(); i++) { q = nextPlayer(q); a.push(q); }
  return a;
}
function isVoidKnown(q, s) { const v = G.R.voids; return !!(v && v[q] && v[q].includes(s)); }
function unseenCards(p) {
  const R = G.R;
  const mine = new Set(R.hands[p].map(c => c.id));
  return CARDS.filter(c => !R.played.has(c.id) && !mine.has(c.id));
}
/** Chance that q holds at least one of k unseen cards of suit s, spread over everyone who could hold them. */
function pHolds(q, k, s, p) {
  if (k <= 0 || isVoidKnown(q, s)) return 0;
  const R = G.R;
  let N = 0;
  for (let x = 0; x < 6; x++) if (x !== p && !sitsOut(x) && !isVoidKnown(x, s)) N += R.hands[x].length;
  const n = R.hands[q].length;
  if (!N || !n) return 0;
  return 1 - Math.pow(1 - Math.min(1, n / N), k);
}
function pVoid(q, s, p, unseen) {
  if (isVoidKnown(q, s)) return 1;
  return 1 - pHolds(q, unseen.filter(c => c.suit === s).length, s, p);
}
/** Chance that q, who plays after p, takes the trick away from `best`. */
function beatProb(q, best, p, unseen) {
  const R = G.R;
  const led = R.plays[0].card.suit;
  if (best.trumpPlay) {                                   // q needs a higher thuruppu
    const ts = R.trump.suit;
    const higher = unseen.filter(c => c.suit === ts && POWER[c.rank] > POWER[best.card.rank]).length;
    const pv = led === ts ? 1 : pVoid(q, led, p, unseen);
    return pv * pHolds(q, higher, ts, p);
  }
  // q beats with a higher card of the led suit…
  const higher = unseen.filter(c => c.suit === led && POWER[c.rank] > POWER[best.card.rank]).length;
  const pHigh = pHolds(q, higher, led, p);
  // …or by being void and cutting.
  const pv = pVoid(q, led, p, unseen);
  let pCut = 0;
  const kt = knownTrump(p);
  if (R.trump.revealed) {
    if (R.trump.suit !== 'NT' && R.trump.suit !== led)
      pCut = 0.9 * pHolds(q, unseen.filter(c => c.suit === R.trump.suit).length, R.trump.suit, p);
  } else if (p === R.bidder) {
    if (kt && kt !== led) pCut = 0.6 * pHolds(q, unseen.filter(c => c.suit === kt).length, kt, p);
  } else {
    const cand = SUITS.filter(s => s !== led && !(R.notTrump || []).includes(s));
    if (cand.length) pCut = q === R.bidder ? 0.85 * 0.7 : 0.5 * 0.55; // has one × chooses to ask
  }
  return Math.min(1, pHigh + pv * pCut);
}
const asPlay = (p, c) => ({ p, card: c, trumpPlay: G.R.trump.revealed && G.R.trump.suit !== 'NT' && c.suit === G.R.trump.suit });
/** Chance `best` still wins after everyone left to play (as seen by p). */
function holdProb(best, p) {
  const unseen = unseenCards(p);
  let h = 1;
  for (const q of playersAfter(p)) if (team(q) !== team(best.p)) h *= 1 - beatProb(q, best, p, unseen);
  return h;
}
/** Chance one of p's partners still to play takes the trick off the opponents. */
function partnerRescue(p, best) {
  const unseen = unseenCards(p);
  let miss = 1;
  for (const q of playersAfter(p)) if (team(q) === team(p)) miss *= 1 - beatProb(q, best, p, unseen);
  return 1 - miss;
}

function botPlay(p) {
  const R = G.R;
  if (R.phase !== 'play' || R.turn !== p || R.busy) return;
  if (canCallCot(p) && aiWantsCot(p)) callCot(p);
  const L = legal(p);
  if (L.canReveal && (L.cards.length === 0 || aiWantsReveal(p))) {
    reveal(p);
    timer = setTimeout(() => {
      if (G.R !== R) return;
      playCard(p, aiPickCard(p, legal(p).cards).id);
    }, 700);
    return;
  }
  playCard(p, aiPickCard(p, L.cards).id);
}

/**
 * Should a player who can't follow suit ask for the thuruppu ("cut")?
 * Weighs it the way a player at the table would:
 *  - how likely I am to hold a thuruppu at all, from what the table has seen
 *    (the bidder never leads or discards a hidden thuruppu, so those suits are ruled out);
 *  - what the trick is worth if I take it: points already down, plus what my partners
 *    still to play will throw in once they see me winning, plus taking the lead;
 *  - the risk an opponent still to play over-cuts me (higher if it is the bidder);
 *  - the cost of exposing the thuruppu, which helps the bidder's side if I am defending
 *    and gives up the bidder's secret if I am the bidder. Cheaper late in the round.
 */
/**
 * Call COT when I'm on lead and every card I hold is a certain winner from here:
 * a thuruppu with no higher one still out, or a top card of its suit with no thuruppu
 * left anywhere to cut it. Leading them one by one then takes every remaining trick.
 */
function aiWantsCot(p) {
  const R = G.R;
  if (R.plays.length !== 0) return false;
  const ts = R.trump.revealed ? (R.trump.suit === 'NT' ? null : R.trump.suit)
    : (p === R.bidder ? (R.trump.suit === 'NT' ? null : R.trump.suit) : undefined);
  if (ts === undefined) return false;                 // I don't know the thuruppu: too risky
  const trumpsOut = ts ? unseenOfSuit(ts, p) : 0;
  return R.hands[p].every(c => unseenHigher(c, p) === 0 && (c.suit === ts || trumpsOut === 0));
}

function aiWantsReveal(p) {
  const R = G.R, plays = R.plays, n = plays.length;
  const wPlay = plays[winnerIndex(plays)];
  const led = plays[0].card.suit;
  const hand = R.hands[p];

  // How likely am I to hold a thuruppu?
  let pHave;
  if (p === R.bidder) {
    if (R.trump.suit === 'NT') return false;
    pHave = hand.some(c => c.suit === R.trump.suit) ? 1 : 0;
  } else {
    const cand = SUITS.filter(s => !(R.notTrump || []).includes(s));
    if (!cand.length) return false;                 // looks like no trump: nothing to gain
    pHave = cand.filter(s => s !== led && hand.some(c => c.suit === s)).length / cand.length;
  }
  if (pHave === 0) return false;

  // Who still plays after me, and could they over-cut me?
  const after = playersAfter(p);
  const unseen = unseenCards(p);
  const partnersAfter = after.filter(q => team(q) === team(p)).length;
  const oppsAfter = after.length - partnersAfter;
  let hold = 1;
  for (const q of after) {
    if (team(q) === team(p)) continue;
    let risk;
    if (p === R.bidder) {                               // I know the thuruppu: count higher ones still out
      const ts = R.trump.suit;
      const lifted = hand.find(c => c.id === R.trump.indicator);   // I must cut with my face-down card
      if (!lifted) return false;
      const myTop = POWER[lifted.rank];
      risk = pVoid(q, led, p, unseen) * pHolds(q, unseen.filter(c => c.suit === ts && POWER[c.rank] > myTop).length, ts, p);
    } else {
      risk = pVoid(q, led, p, unseen) * (q === R.bidder ? 0.85 : 0.5) * 0.5;  // void, holds one, and it's higher
    }
    hold *= 1 - risk;
  }

  const pts = trickPoints(plays);
  let stake = pts + 1.5 * partnersAfter + 0.3 * oppsAfter + 1;

  if (team(wPlay.p) === team(p)) {
    // My partner is winning right now. Will it last through the opponents still to play?
    const partnerHold = holdProb(wPlay, p);
    if (partnerHold >= 0.7) return false;
    stake *= 1 - partnerHold;
  } else {
    // An opponent is winning. Might a partner after me take it anyway?
    stake *= 1 - 0.7 * partnerRescue(p, wPlay);
  }

  const late = R.trickNo >= 5;
  let revealCost = 0;
  if (p === R.bidder) revealCost = late ? 0.3 : 1.0;
  else if (team(R.bidder) !== team(p)) revealCost = late ? 0.2 : 0.6;

  const mood = Math.random() * 0.6 - 0.3;          // players aren't machines
  const ev = pHave * hold * stake - (1 - pHave) * 0.5 - revealCost + mood;
  return ev >= 1.4;
}

function aiPickCard(p, cards) {
  const R = G.R;
  if (cards.length === 1) return cards[0];
  const kt = knownTrump(p);
  const isT = c => (kt && c.suit === kt) ? 1 : 0;
  const byLow = (a, b) => isT(a) - isT(b) || POINTS[a.rank] - POINTS[b.rank] || POWER[a.rank] - POWER[b.rank];
  const lowest = () => [...cards].sort(byLow)[0];
  const lowPow = (a, b) => POWER[a.rank] - POWER[b.rank];

  if (R.plays.length === 0) return aiLead(p, cards, kt, isT);

  const plays = R.plays;
  const wPlay = plays[winnerIndex(plays)];
  const partnerWinning = team(wPlay.p) === team(p);
  const pts = trickPoints(plays);
  const last = plays.length === trickSize() - 1;
  const led = plays[0].card.suit;
  const partnersAfter = playersAfter(p).filter(q => team(q) === team(p)).length;

  // Throwing points to a partner. Void with the thuruppu hidden, any 9 or J might be a thuruppu.
  const blindDiscard = !R.trump.revealed && !kt && cards[0].suit !== led;
  const feedCard = generous => {
    const w = blindDiscard || !generous
      ? { '10': 1.6, A: 1.5, '9': 0.3, J: 0.2, K: 0.1, Q: 0 }
      : { '9': 2, '10': 1.6, A: 1.5, J: R.trickNo >= 6 ? 3 : 0.4, K: 0.1, Q: 0 };
    const pool = cards.filter(c => !isT(c));
    return pool.length ? pool.sort((a, b) => w[b.rank] - w[a.rank])[0] : lowest();
  };

  if (partnerWinning) {
    // My partner is winning right now. Can the opponents still to play take it?
    const hold = last ? 1 : holdProb(wPlay, p);
    if (hold >= 0.65) return feedCard(hold >= 0.85);
    // Shaky. If I can win it myself with something much safer, do that.
    if (pts >= 2) {
      const safer = cards.filter(c => wouldWin(p, c))
        .map(c => ({ c, h: holdProb(asPlay(p, c), p) }))
        .filter(o => o.h >= Math.max(0.75, hold + 0.25))
        .sort((a, b) => isT(a.c) - isT(b.c) || POWER[a.c.rank] - POWER[b.c.rank]);
      if (safer.length) return safer[0].c;
    }
    return hold >= 0.6 ? feedCard(false) : lowest();
  }

  // An opponent is winning. Look at each card that would take the lead now and ask
  // how likely it is to survive the players still to come.
  const winners = cards.filter(c => wouldWin(p, c));
  if (winners.length) {
    if (last) return winners.sort((a, b) => isT(a) - isT(b) || lowPow(a, b))[0];   // nobody left: cheapest winner
    const options = winners.map(c => ({ c, h: holdProb(asPlay(p, c), p) }));
    // The cheapest card that will probably hold (don't burn a thuruppu on an empty trick).
    const safe = options.filter(o => o.h >= 0.6)
      .sort((a, b) => isT(a.c) - isT(b.c) || POWER[a.c.rank] - POWER[b.c.rank]);
    if (safe.length && (pts >= 1 || !isT(safe[0].c))) return safe[0].c;
    // Nothing safe, but plenty on the table: go with my best chance.
    if (pts >= 3) return options.sort((a, b) => b.h - a.h || POWER[a.c.rank] - POWER[b.c.rank])[0].c;
  }
  return lowest();
}

function aiLead(p, cards, kt, isT) {
  const R = G.R;
  const highPow = (a, b) => POWER[b.rank] - POWER[a.rank];
  const ourBid = team(R.bidder) === team(p);
  if (R.thani) {
    // Thani: cash the unbeatable cards first (Jacks before the 9s they protect), else the highest card.
    const sure = cards.filter(c => unseenHigher(c, p) === 0);
    return (sure.length ? sure : cards).sort(highPow)[0];
  }
  if (R.trump.revealed && kt && ourBid) {
    const mt = cards.filter(c => isT(c) && unseenHigher(c, p) === 0);
    if (mt.length) return mt.sort(highPow)[0];
  }
  const non = cards.filter(c => !isT(c));
  const pool = non.length ? non : cards;
  const masters = pool.filter(c => unseenHigher(c, p) === 0 && POINTS[c.rank] > 0);
  if (masters.length) return masters.sort(highPow)[0];
  const count = {};
  pool.forEach(c => { count[c.suit] = (count[c.suit] || 0) + 1; });
  return [...pool].sort((a, b) => POINTS[a.rank] - POINTS[b.rank] || count[b.suit] - count[a.suit]
    || POWER[a.rank] - POWER[b.rank])[0];
}

// =========================================================================
//  Persistence (per-device convenience only)
// =========================================================================
function serialize() {
  return G ? JSON.stringify(G, (k, v) => v instanceof Set ? { __set: [...v] } : v) : null;
}
function deserialize(s) {
  return JSON.parse(s, (k, v) => (v && v.__set) ? new Set(v.__set) : v);
}
function save() {
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
  if (R.decided && R.phase === 'play') { R.busy = false; endRound(); return; }   // was showing the early finish
  render();
  if (R.busy) timer = setTimeout(() => finishTrick(R), 700);
  else schedule();
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
    const stack = t => `<i class="kit-stack">${'<i></i>'.repeat(G.kitty[t])}</i>`;
    const held = t => [0, 1, 2, 3, 4, 5].filter(s => team(s) === t).reduce((n, s) => n + G.joker[s], 0);
    const tally = t => held(t) ? `<span class="jk-tally" title="Jokers held now">🃏${held(t)}</span>` : '';
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

function renderSheet() {
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
    if (R.bidder !== 0) { el.innerHTML = waitHTML(`${who(R.bidder)} won at ${R.high}`, 'Choosing the thuruppu…'); return; }
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
  else if (kind === 'menu') o.innerHTML = menuHTML();
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
      <li><b>${TARGET}</b><span>game points wins the match</span></li>
    </ul>
    <div class="col">
      ${saved ? `<button class="btn primary wide" data-act="resume">Continue · round ${saved.roundNo}, ${saved.score[0]}–${saved.score[1]}</button>
                 <button class="btn wide" data-act="new">New match</button>`
              : '<button class="btn primary wide" data-act="new">Start match</button>'}
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
      <div class="seg" role="group" aria-label="Bot speed">
        <span>Bot speed</span>
        <button class="segbtn ${speed === 'normal' ? 'on' : ''}" data-speed="normal">Normal</button>
        <button class="segbtn ${speed === 'fast' ? 'on' : ''}" data-speed="fast">Fast</button>
      </div>
      ${scoringSeg()}
      <button class="btn wide" data-act="askNew">New match</button>
      <button class="btn primary wide" data-act="back">Back to table</button>
    </div>${careerHTML()}${versionHTML()}</div>`;
}

function logHTML() {
  return `<div class="box log"><h2>Game log</h2><ul>${G.log.map(l => `<li>${l}</li>`).join('')}</ul>
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
      ${r.jokerTo != null ? `<div><dt>Joker!</dt><dd class="bad">🃏 ${TEAM_NAME[r.jokerTo]} ran out; kitty reset to 7 · 7</dd></div>` : ''}
      <div><dt>Kitty now</dt><dd><span class="t0c">${TEAM_SYM[0]} ${G.kitty[0]}</span> · <span class="t1c">${TEAM_SYM[1]} ${G.kitty[1]}</span></dd></div>
      <div><dt>Jokers now</dt><dd>${G.joker.some(j => j > 0)
        ? [0, 1, 2, 3, 4, 5].filter(s => G.joker[s] > 0).map(s => `<span class="t${team(s)}c">${esc(NAMES[s])}</span>${G.joker[s] > 1 ? ' ×' + G.joker[s] : ''}`).join(', ')
        : '<span class="muted">none</span>'}</dd></div>`
      : `
      <div><dt>Game points</dt><dd><b>+${r.gain}</b> to ${TEAM_NAME[r.to]}</dd></div>
      <div><dt>Match</dt><dd><span class="t0c">${TEAM_SYM[0]} ${G.score[0]}</span> · <span class="t1c">${TEAM_SYM[1]} ${G.score[1]}</span> <span class="muted">to ${TARGET}</span></dd></div>`}
    </dl>
    ${careerHTML()}
    ${over ? `<div class="champ ${winTeam === 0 ? 'good' : 'bad'}">${winTeam === 0 ? 'Your team wins the match!' : `${TEAM_NAME[winTeam]} wins the match.`}</div>` : ''}
    <div class="row end"><button class="btn ghost" data-act="log">Log</button><button class="btn primary" data-act="next">${over ? 'New match' : 'Next round'}</button></div></div>`;
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
  <p><b>Kitty &amp; Joker</b>: each team starts with a kitty of 7 cards. After each round the losing team pays the winners as many kitty cards as the game points. A team that runs out gets a <b>Joker</b> on every member (Jokers add up) and the kitty is shared out 7 and 7 again. To remove Jokers, the team must win the bidding and make the bid (any bid, Thani or a made COT): in the very first round after its latest Joker, every member removes one; after that, only the player who made the winning bid removes one of their own.</p>
  <p><b>Career score</b> (in the menu and the round summary): every round's game points keep adding up in the background, whichever scoring you play. A new Ace draw starts it again.</p>
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
    case 'new': if (!TEAMS.drawn) startDraw(); else newMatch(); return;
    case 'shuffleTeams':
      if (G && !matchOver() && UI.overlay !== 'intro') { UI.overlay = 'confirmShuffle'; renderOverlay(); }
      else startDraw();
      return;
    case 'drawgo': startDraw(); return;
    case 'scoringYes':
      setScoring(UI.pendingScoring || scoring); UI.pendingScoring = null; overlayReturn = null;
      if (TEAMS.drawn) { newMatch(); render(); } else startDraw();
      return;
    case 'drawskip': if (UI.draw) { UI.draw.step = UI.draw.seq.length; clearInterval(drawTimer); renderOverlay(); } return;
    case 'drawstart': finishDraw(); return;
    case 'resume': { const s = loadSaved(); if (s) resume(s); else newMatch(); return; }
    case 'menu': openOverlay('menu'); return;
    case 'rules': case 'log': case 'names': openOverlay(act); return;
    case 'namesReset':
      DEFAULT_NAMES.forEach((n, i) => { const el = document.getElementById('name' + i); if (el) el.value = i === 0 ? '' : n; });
      return;
    case 'namesSave': saveNames(); return;
    case 'askNew': UI.overlay = 'confirmNew'; renderOverlay(); return;
    case 'back': {
      if (UI.overlay === 'draw') { clearInterval(drawTimer); UI.draw = null; }
      const prev = overlayReturn;
      overlayReturn = null;
      UI.overlay = (prev === 'intro' || prev === 'round') ? prev : null;
      if (!G) UI.overlay = 'intro';
      renderOverlay();
      return;
    }
    case 'next': nextRound(); return;
  }
  if (!R) return;
  switch (act) {
    case 'bid': doBid(0, UI.bidPick); return;
    case 'pass': doBid(0, null); return;
    case 'nt': UI.ntAsk = true; UI.sel = null; renderSheet(); renderHand(); return;
    case 'ntno': UI.ntAsk = false; renderSheet(); return;
    case 'ntyes': UI.ntAsk = false; setTrump(0, 'NT'); return;
    case 'settrump': if (UI.sel != null) setTrump(0, UI.sel); return;
    case 'play': if (UI.sel != null) playCard(0, UI.sel); return;
    case 'reveal': UI.sel = null; reveal(0); return;
    case 'cot': {
      const key = `${G.roundNo}|${R.trickNo}|${R.plays.length}`;
      if (UI.cotArm === key) { UI.cotArm = null; callCot(0); }
      else { UI.cotArm = key; renderSheet(); }
      return;
    }
  }
}

function onCardTap(id) {
  const R = G.R;
  if (R.phase === 'trump' && R.bidder === 0) {
    UI.ntAsk = false;                                // tapping a card means "pick a card instead"
    if (UI.sel === id) { setTrump(0, id); return; }
    UI.sel = id; renderSheet(); renderHand(); return;
  }
  if (R.phase !== 'play' || R.turn !== 0 || R.busy) return;
  const ok = legal(0).cards.some(c => c.id === id);
  if (!ok) { UI.shake = id; renderHand(); return; }
  if (UI.sel === id) { playCard(0, id); return; }
  UI.sel = id; renderSheet(); renderHand();
}

document.addEventListener('click', e => {
  const t = e.target.closest('button, .card');
  if (!t) {
    if (e.target.id === 'overlay' && UI.overlay && UI.overlay !== 'intro' && UI.overlay !== 'round' && UI.overlay !== 'decided') onAction('back');
    return;
  }
  if (t.dataset.act) { onAction(t.dataset.act); return; }
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
    if (G && UI.overlay !== 'intro') { if (TEAMS.drawn) newMatch(); else startDraw(); render(); }
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
  if (e.key === 'Escape' && UI.overlay && UI.overlay !== 'intro' && UI.overlay !== 'round' && UI.overlay !== 'decided') onAction('back');
});

// ---------- Boot ----------
function start(data) {
  document.getElementById('root').innerHTML = shellHTML();
  let saved = null;
  try { saved = data && data.save ? deserialize(data.save) : null; } catch (e) { saved = null; }
  if (saved) { resume(saved); return; }          // hot update: carry straight on
  saved = loadSaved();
  if (saved && (saved.mode === 'kitty' || !(saved.score[0] >= TARGET || saved.score[1] >= TARGET))) G = saved;
  UI.overlay = 'intro';
  if (G) { renderTop(); renderTable(); renderSheet(); renderHand(); }
  renderOverlay();
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
      if (UI.overlay && UI.overlay !== 'intro' && UI.overlay !== 'round' && UI.overlay !== 'decided') onAction('back');
      else if (G && UI.overlay !== 'intro') onAction('menu');
      else App.exitApp();
    });
    App.addListener('pause', () => save());          // keep the game when the app goes to the background
  } catch (e) { /* plugin missing */ }
})();

try { window.claude?.hot?.snapshot?.(() => ({ save: serialize() })); } catch (e) { /* not in a viewer */ }
if (window.claude?.hot?.ready) window.claude.hot.ready(start);
else start(window.claude?.hot?.data ?? {});
