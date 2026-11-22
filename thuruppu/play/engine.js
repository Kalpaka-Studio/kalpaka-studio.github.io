'use strict';
/* =========================================================================
   Thuruppu 56 — the rules engine: dealing, bidding, play, scoring, Kitty & Joker, and the bots.
   No screen code and no timers, so the same file runs on the phone (offline play) and on the
   game server (online play). Seats are 0..5 counter-clockwise; team = seat % 2.

   How a host (the screen, or the server) drives it:
     - set the match with useGame(g) / newMatch(opts); call actions such as doBid, setTrump, reveal,
       playCard, callCot, nextRound — each returns quietly if the move isn't allowed;
     - after every action ask nextStep(): it says what happens next on its own (a bot's turn, the end
       of a trick, the early-finish reveal) and gives a `run` to call after the host's chosen delay;
       null means the game is waiting for a human;
     - Engine.emit receives events for the screen: 'round' (new round dealt), 'flash', 'decided',
       'roundEnd'.
   Log lines are stored with tokens, resolved per viewer: {@3} = seat 3's name, {~3|takes|take} =
   the verb for seat 3, {#1} = team 1's name, {$1} = team 1's symbol.
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
const TARGET = 12;
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
// ---------- Match state and the host connection ----------
let G = null;            // the match being played (serialisable). The server swaps it per room with useGame().
const Engine = { emit(type, data) { /* set by the host */ } };
const emit = (type, data) => Engine.emit(type, data);
function useGame(g) { G = g; return g; }

/** Seats played by bots. Offline: everyone but seat 0. Online: empty seats, and anyone who has dropped out. */
const DEFAULT_BOTS = [false, true, true, true, true, true];
const isBot = p => !!(G.bots || DEFAULT_BOTS)[p];

/**
 * Start a match. opts: { dealer (random if left out), mode: 'twelve' | 'kitty', bots: [6 × boolean] }.
 */
function newMatch(opts = {}) {
  const d = Number.isInteger(opts.dealer) ? opts.dealer : Math.floor(Math.random() * 6);
  const mode = opts.mode === 'kitty' ? 'kitty' : 'twelve';
  G = { score: [0, 0], dealer: d, roundNo: 0, log: [], R: null, mode, bots: (opts.bots || DEFAULT_BOTS).slice() };
  if (mode === 'kitty') {
    G.kitty = [7, 7];                       // index = team
    G.joker = Array(6).fill(0);             // Jokers held by each seat
    G.jokerFresh = [false, false];          // team got its latest Joker last round
  }
  startRound();
  return G;
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
    drawDealer, seq, aces,
    order,                                  // order[newSeat] = the seat that moves there
    black: youBlack ? 0 : 1,
    firstDealer: order.indexOf(aces[0]),
  };
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
  dealCards(4);
  const how = R.shuffle === 'full' ? pv(G.dealer, 'shuffles well', 'shuffle well')
    : R.shuffle === 'medium' ? pv(G.dealer, 'shuffles', 'shuffle') : pv(G.dealer, 'shuffles lightly', 'shuffle lightly');
  log(`<b>Round ${G.roundNo}</b> · ${pn(G.dealer)} ${how} and ${pv(G.dealer, 'deals', 'deal')}.`);
  emit('round');
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
// Log tokens (see the header): names, verbs and team labels are filled in by whoever shows the log.
const pn = p => `{@${p}}`;
const pv = (p, third, you) => `{~${p}|${third}|${you}}`;
const tn = t => `{#${t}}`;
const tsy = t => `{$${t}}`;
const tv = (t, third, you) => `{&${t}|${third}|${you}}`;   // verb for a team: "you" form for the viewer's own team
const symHTML = s => s === 'NT' ? 'NT' : `<span class="sym ${isRed(s) ? 'red' : ''}">${SUIT_SYM[s]}</span>`;
const suitHTML = s => s === 'NT' ? '<b>No Trump</b>' : `${symHTML(s)} ${SUIT_NAME[s]}`;
const cardName = c => `${c.rank}${SUIT_SYM[c.suit]}`;
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
    log(v === THANI ? `${pn(p)} ${pv(p, 'calls', 'call')} <b>Thani</b>!` : `${pn(p)} ${pv(p, 'bids', 'bid')} <b>${v}</b>.`);
  } else {
    if (R.high === 0) return;           // the player next to the dealer must open — no pass
    R.passes++; R.lastBid[p] = 'Pass';
    log(`${pn(p)} ${pv(p, 'passes', 'pass')}.`);
  }

  if (R.phase === 'bidding') {
    if (R.high > 0 && (R.passes >= 5 || R.high === 56)) {
      R.phase = 'trump'; R.turn = R.bidder;
      log(`Highest bidder: ${pn(R.bidder)} at <b>${R.high}</b>.`);
      return;
    }
  } else if (R.high === THANI || R.passes >= (R.raised2 ? 5 : 6)) {
    endSecondRound();
    return;
  }
  R.turn = nextSeat(p);
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
    log(`<b>Thani!</b> ${pn(R.bidder)} must win all 8 tricks alone. No thuruppu; partners sit out.`);
  } else if (R.raised2) {
    // The new highest bidder chooses the thuruppu afresh; the old face-down card simply goes back into play.
    R.trump = { suit: null, revealed: false, indicator: null, revealedBy: -1 };
    R.notTrump = [];
    R.phase = 'trump'; R.turn = R.bidder;
    log(`Highest bidder: ${pn(R.bidder)} at <b>${R.high}</b>; new thuruppu.`);
  } else {
    R.phase = 'play'; R.turn = R.leader;
    log(`No raise. ${pn(R.leader)} ${pv(R.leader, 'leads', 'lead')}.`);
  }
}

// ---------- Trump selection ----------
function setTrump(p, choice) {
  const R = G.R;
  if (R.phase !== 'trump' || p !== R.bidder) return;
  if (choice === 'NT') {
    // No trump is announced to everyone at once; with nothing hidden, nobody can ask for a thuruppu.
    R.trump = { suit: 'NT', revealed: true, indicator: null, revealedBy: p };
    log(`${pn(p)} ${pv(p, 'chooses', 'choose')} <b>no trump</b> for this round.`);
    emit('flash', { label: 'This round', big: 'No trump' });
  } else {
    const c = R.hands[p].find(c => c.id === choice);
    if (!c) return;
    R.trump.suit = c.suit; R.trump.indicator = c.id;
    log(`${pn(p)} secretly ${pv(p, 'sets', 'set')} the thuruppu.`);
  }
  if (R.round2Done) {
    R.phase = 'play'; R.turn = R.leader;
    log(`${pn(R.leader)} ${pv(R.leader, 'leads', 'lead')}.`);
  } else {
    dealCards(4);
    log('Four more cards each.');
    startSecondRound();                  // always: even over 56, someone may call Thani
  }
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
  log(`${pn(p)} ${pv(p, 'calls', 'call')} for thuruppu: ${suitHTML(R.trump.suit)}!`);
  emit('flash', { suit: R.trump.suit });
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
    log(`${pn(p)} ${pv(p, 'plays', 'play')} the face-down card. Thuruppu is ${suitHTML(R.trump.suit)}!`);
    emit('flash', { suit: R.trump.suit });
  } else if (!R.trump.revealed && p === R.bidder && R.plays.length === 0 && c.suit === R.trump.suit) {
    // Forced to lead a thuruppu (nothing else left): leading it reveals it.
    R.trump.revealed = true; R.trump.revealedBy = p;
    log(`${pn(p)} ${pv(p, 'leads', 'lead')} a thuruppu. It is ${suitHTML(R.trump.suit)}!`);
    emit('flash', { suit: R.trump.suit });
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

  if (R.plays.length === trickSize()) {
    R.busy = true; R.turn = -1;            // the full trick stays on the table; nextStep() collects it
  } else {
    R.turn = nextPlayer(p);
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
  log(`${pn(p)} ${pv(p, 'calls', 'call')} <b>COT</b>: ${tn(team(p))} will take all 56 points!`);
  emit('flash', { label: 'Called', big: 'COT' });
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
  log(`${pn(w)} ${pv(w, 'takes', 'take')} trick ${R.trickNo + 1} <span class="muted">(+${pts} ${tn(team(w))})</span>.`);
  R.lastTrick = { plays: R.plays, winner: w, pts };
  (R.pile = R.pile || []).push(...R.plays.map(x => x.card.id));   // gathered in play order for the next deal
  R.plays = []; R.trickNo++; R.busy = false;
  if (R.thani && w !== R.bidder) {             // one lost trick and Thani is over
    log(`${pn(w)} ${pv(w, 'breaks', 'break')} the Thani!`);
    endRound(); return;
  }
  if (R.cot && R.captured[1 - team(R.bidder)] > 0) {   // the other side scored: COT is broken
    log(`${pn(w)} ${pv(w, 'breaks', 'break')} the COT!`);
    endRound(); return;
  }
  if (R.trickNo === 8) { endRound(); return; }
  const decided = decidedResult(R);
  if (decided) { finishEarly(R, decided); return; }
  R.leader = w; R.turn = w;
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
    ? `${tn(bt)} can no longer make ${R.high}. Round decided after trick ${R.trickNo}.`
    : `${tn(bt)} has made ${R.high}. Round decided after trick ${R.trickNo}.`);
  R.busy = true; R.turn = -1;              // nextStep() moves on to the summary after the reveal
  emit('decided');
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
    ? (made ? `${pn(R.bidder)} ${pv(R.bidder, 'wins', 'win')} the Thani: <b>+${gain}</b> ${tn(bt)}.`
            : `Thani lost: ${tn(to)} <b>+${gain}</b>.`)
    : R.cot
    ? (made ? `COT made, all 56 points: ${tn(bt)} <b>+${gain}</b>.` : `COT failed: ${tn(to)} <b>+${gain}</b>.`)
    : made
    ? `${tn(bt)} made ${bid} with ${got}: <b>+${gain}</b>.`
    : `${tn(bt)} went set (${got}/${bid}): ${tn(to)} <b>+${gain}</b>.`);
  if (isKitty()) settleKitty(R);
  emit('roundEnd', R.result);
}

// ---------- Kitty & Joker scoring ----------
// Each team starts with 7 kitty cards; the round's loser pays the winners as many cards as the game points.
// A team that runs out gets a Joker on every member (they stack) and the kitty is shared 7 and 7 again.
// Jokers come off by winning the bidding and making it: in the very first round after the latest Joker
// every member drops one; later, only the player who made the winning bid drops one of their own.
const isKitty = () => !!(G && G.mode === 'kitty');
function settleKitty(R) {
  const r = R.result, loser = 1 - r.to, bt = r.bt;
  const paid = Math.min(r.gain, G.kitty[loser]);
  G.kitty[loser] -= paid; G.kitty[r.to] += paid;
  r.kitty = { paid, from: loser, after: G.kitty.slice() };
  log(`${tn(loser)} ${paid === 1 ? 'pays 1 kitty card' : `pays ${paid} kitty cards`} <span class="muted">(${tsy(0)} ${G.kitty[0]} · ${tsy(1)} ${G.kitty[1]})</span>.`);

  // 1. Removing Jokers: the bidding team won the bidding and made it.
  const seatsOf = t => [0, 1, 2, 3, 4, 5].filter(s => team(s) === t);
  r.jokerOff = [];
  if (r.made && seatsOf(bt).some(s => G.joker[s] > 0)) {
    const off = G.jokerFresh[bt] ? seatsOf(bt).filter(s => G.joker[s] > 0) : (G.joker[R.bidder] > 0 ? [R.bidder] : []);
    off.forEach(s => G.joker[s]--);
    r.jokerOff = off;
    if (off.length > 1) log(`🃏 ${tn(bt)} made it straight away: everyone removes a Joker.`);
    else if (off.length === 1) log(`🃏 ${pn(off[0])} ${pv(off[0], 'removes', 'remove')} a Joker.`);
    else log(`🃏 ${pn(R.bidder)} ${pv(R.bidder, 'has', 'have')} no Joker to remove.`);
  }
  G.jokerFresh = [false, false];                     // the "first round after" chance is used up either way

  // 2. Running out: Joker for the whole team, kitty shared out again.
  r.jokerTo = null;
  if (G.kitty[loser] === 0) {
    seatsOf(loser).forEach(s => G.joker[s]++);
    G.jokerFresh[loser] = true;
    G.kitty = [7, 7];
    r.jokerTo = loser;
    log(`🃏 <b>${tn(loser)} ran out of kitty cards and ${tv(loser, 'gets', 'get')} a Joker!</b> Kitty shared out 7 and 7 again.`);
  }
  if (r.jokerTo != null || r.jokerOff.length) emit('flash', { label: r.jokerTo != null ? 'Joker for' : 'Joker removed',
    big: r.jokerTo != null ? `${tsy(r.jokerTo)} 🃏` : '🃏' });
}

const matchOver = () => !isKitty() && (G.score[0] >= TARGET || G.score[1] >= TARGET);

/** Next deal; after a won First to 12 match, a fresh match with the same seats and scoring. */
function nextRound() {
  if (G.R && G.R.phase !== 'roundEnd') return;
  if (matchOver()) { newMatch({ mode: G.mode, bots: G.bots }); return; }
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
    R.botReveal = p;                       // a short pause so the table sees the thuruppu, then nextStep() plays
    return;
  }
  playCard(p, aiPickCard(p, L.cards).id);
}

/**
 * What happens next without anyone tapping, or null when it's a human's move.
 * kind: 'trick' (collect the full trick), 'decided' (end of the early-finish reveal), 'botCard' (a bot
 * plays after revealing), 'botTrump' (a bot picks the thuruppu), 'bot' (a bot bids or plays).
 * The host waits as long as it likes for each kind, then calls run().
 */
function nextStep() {
  const R = G && G.R;
  if (!R || R.phase === 'roundEnd') return null;
  if (R.busy && R.decided && R.phase === 'play')
    return { kind: 'decided', run: () => { if (G.R === R && R.busy) { R.busy = false; endRound(); } } };
  if (R.busy) return { kind: 'trick', run: () => finishTrick(R) };
  if (R.phase === 'play' && R.botReveal != null && R.botReveal === R.turn) {
    const p = R.turn;
    return { kind: 'botCard', run: () => { if (G.R !== R || R.turn !== p) return; R.botReveal = null; playCard(p, aiPickCard(p, legal(p).cards).id); } };
  }
  if (isBidding(R) && isBot(R.turn)) {
    const p = R.turn;
    return { kind: 'bot', run: () => { if (G.R === R && R.turn === p) doBid(p, aiBid(p)); } };
  }
  if (R.phase === 'trump' && isBot(R.bidder)) {
    const p = R.bidder;
    return { kind: 'botTrump', run: () => { if (G.R === R) setTrump(p, aiTrump(p)); } };
  }
  if (R.phase === 'play' && isBot(R.turn)) {
    const p = R.turn;
    return { kind: 'bot', run: () => { if (G.R === R) botPlay(p); } };
  }
  return null;
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

// ---------- What one player may see (online play) ----------
// The table turned so that seat `me` is seat 0 (and so their team is team 0), with everyone else's
// cards hidden. The screen code then draws it exactly as it draws an offline game.
const rotSeat = (p, me) => (typeof p === 'number' && p >= 0) ? (p - me + 6) % 6 : p;
const rotTeam = (t, me) => (typeof t === 'number' && t >= 0) ? t ^ (me % 2) : t;
/** Turn the seat and team numbers inside log tokens for seat `me`. */
function rotTokens(s, me) {
  return String(s)
    .replace(/\{([@~])(\d)/g, (_, k, p) => `{${k}${rotSeat(+p, me)}`)
    .replace(/\{([&#$])(\d)/g, (_, k, t) => `{${k}${rotTeam(+t, me)}`);
}
function viewFor(me) {
  const R = G.R;
  const rs = p => rotSeat(p, me), rt = t => rotTeam(t, me);
  const seatArr = a => a && [0, 1, 2, 3, 4, 5].map(i => a[(i + me) % 6]);
  const teamArr = a => a && (me % 2 ? [a[1], a[0]] : a.slice());
  const plays = list => list.map(x => ({ p: rs(x.p), card: x.card, trumpPlay: x.trumpPlay }));
  const open = R.phase === 'roundEnd' || (R.busy && R.decided);          // cards are shown face-up
  const knowsTrump = R.trump.revealed || me === R.bidder || R.phase === 'roundEnd';
  const res = R.result;
  return {
    score: teamArr(G.score), dealer: rs(G.dealer), roundNo: G.roundNo, mode: G.mode,
    log: G.log.map(l => rotTokens(l, me)), bots: seatArr(G.bots || DEFAULT_BOTS),
    kitty: teamArr(G.kitty), joker: seatArr(G.joker), jokerFresh: teamArr(G.jokerFresh),
    R: {
      phase: R.phase, high: R.high, bidder: rs(R.bidder), passes: R.passes, turn: rs(R.turn),
      lastBid: seatArr(R.lastBid), leader: rs(R.leader), trickNo: R.trickNo, busy: R.busy,
      hands: seatArr(R.hands.map((h, p) => p === me || open ? h : h.map(() => null))),
      trump: {
        suit: knowsTrump ? R.trump.suit : (R.trump.suit ? '?' : null), revealed: R.trump.revealed,
        indicator: me === R.bidder || R.trump.revealed ? R.trump.indicator : null, revealedBy: rs(R.trump.revealedBy),
      },
      plays: plays(R.plays), captured: teamArr(R.captured), tricksWon: seatArr(R.tricksWon),
      mustPlayTrump: R.mustPlayTrump, voids: seatArr(R.voids), notTrump: R.notTrump,
      lastTrick: R.lastTrick && { plays: plays(R.lastTrick.plays), winner: rs(R.lastTrick.winner), pts: R.lastTrick.pts },
      thani: R.thani, cot: R.cot && { by: rs(R.cot.by), trick: R.cot.trick }, decided: R.decided,
      round2Done: R.round2Done, raised2: R.raised2, shuffle: R.shuffle, botReveal: rs(R.botReveal), played: new Set(),
      result: res && Object.assign({}, res, {
        to: rt(res.to), bt: rt(res.bt), cot: res.cot && { by: rs(res.cot.by), trick: res.cot.trick },
        kitty: res.kitty && { paid: res.kitty.paid, from: rt(res.kitty.from), after: teamArr(res.kitty.after) },
        jokerOff: res.jokerOff && res.jokerOff.map(rs), jokerTo: rt(res.jokerTo),
      }),
    },
  };
}

// ---------- Saving and loading a match ----------
function serialize() {
  return G ? JSON.stringify(G, (k, v) => v instanceof Set ? { __set: [...v] } : v) : null;
}
function deserialize(s) {
  return JSON.parse(s, (k, v) => (v && v.__set) ? new Set(v.__set) : v);
}

// In the browser everything above is shared with game.js as plain globals. On the server
// (Node or Cloudflare) the same file is loaded as a module and used through this list.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    Engine, useGame, game: () => G, newMatch, nextRound, nextStep, makeDraw, isBot,
    doBid, setTrump, reveal, playCard, callCot, legal, legalBids, canCallCot, cotHint,
    matchOver, isKitty, serialize, deserialize, team, CARDS, THANI, TARGET,
    viewFor, rotTokens, rotSeat, rotTeam, aiBid, aiTrump, aiPickCard, isBidding,
  };
}