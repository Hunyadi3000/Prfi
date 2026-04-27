'use strict';

// ══════════════════════════════════════════════════
// CONSTANTS
// ══════════════════════════════════════════════════
const SUITS = ['zold','sarga','piros','makk'];
const SI = {
  zold:  { n:'Zöld (Lapi)',  col:'#2e7d32', dark:'#1b5e20' },
  sarga: { n:'Tök (Sárga)',  col:'#e65100', dark:'#bf360c' },
  piros: { n:'Piros (Szív)', col:'#c62828', dark:'#7f0000' },
  makk:  { n:'Makk',         col:'#5d3a1a', dark:'#3e2006' },
};
const VALS  = ['7','8','9','10','A','F','K','Á'];
const VR    = {'7':0,'8':1,'9':2,'10':3,'A':4,'F':5,'K':6,'Á':7};
const VNAME = {'7':'Hetes','8':'Nyolcas','9':'Kilences','10':'Tízes','A':'Alsó','F':'Felső','K':'Király','Á':'Ász'};
const GAMES = [
  { id:2,  n:'Zöld',       trump:'zold',  tp:'color',      tgt:6 },
  { id:3,  n:'Sárga',      trump:'sarga', tp:'color',      tgt:6 },
  { id:4,  n:'Piros',      trump:'piros', tp:'color',      tgt:6 },
  { id:5,  n:'Makk',       trump:'makk',  tp:'color',      tgt:6 },
  { id:6,  n:'Betli',      trump:null,    tp:'betli',      tgt:0 },
  { id:7,  n:'Mizer',      trump:null,    tp:'mizer',      tgt:1 },
  { id:8,  n:'Szanadu',    trump:null,    tp:'szanadu',    tgt:6 },
  { id:9,  n:'Pikkoló',    trump:null,    tp:'pikkolo',    tgt:2 },
  { id:10, n:'Preferansz', trump:null,    tp:'preferansz', tgt:6 },
];
const IS_PC = () => window.innerWidth >= 820;

// ══════════════════════════════════════════════════
// NETWORK STATE
// ══════════════════════════════════════════════════
let peer        = null;
let isHost      = false;
let myIndex     = 0;
let pNames      = ['Gazda','Vendég 1','Vendég 2'];
let roomCode    = '';
let pConns      = [null, null, null];
let hostConn    = null;
let netPhase    = 'lobby';
let joinedCount = 0;
let netError    = '';

const genCode = () => Math.random().toString(36).slice(2,8).toUpperCase();

function doHost(name) {
  pNames[0] = name; isHost = true; myIndex = 0; netError = '';
  roomCode = genCode(); netPhase = 'hosting';
  _makePeer(roomCode);
}

function _makePeer(id) {
  if (peer) { try { peer.destroy(); } catch(e) {} }
  peer = new Peer(id, { debug: 0 });
  peer.on('error', err => {
    if (err.type === 'unavailable-id' && isHost) { roomCode = genCode(); _makePeer(roomCode); }
    else { netError = 'Hálózati hiba: ' + err.message; netPhase = 'lobby'; render(); }
  });
  peer.on('open', () => render());
  if (isHost) {
    peer.on('connection', conn => {
      conn.on('open', () => {
        conn.on('data', data => {
          if (data.type === 'hello') {
            if (joinedCount >= 2) { conn.close(); return; }
            const idx = joinedCount + 1; joinedCount++;
            pNames[idx] = data.name; pConns[idx] = conn;
            conn.metadata = { idx };
            conn.send({ type:'welcome', myIndex:idx, names:pNames });
            _broadcastPlayers();
            if (joinedCount === 2) netPhase = 'ready';
            render();
          } else if (data.type === 'action') {
            _handleAction(data.action, conn.metadata?.idx || _connIdx(conn));
          }
        });
        conn.on('close', () => { netPhase = 'disconnected'; render(); });
      });
    });
  }
}

function _connIdx(c) { return pConns.indexOf(c); }

function doJoin(name, code) {
  netError = ''; isHost = false; netPhase = 'joining'; render();
  if (peer) { try { peer.destroy(); } catch(e) {} }
  peer = new Peer(undefined, { debug: 0 });
  peer.on('error', () => { netError = 'Nem sikerült csatlakozni! Ellenőrizd a kódot.'; netPhase = 'lobby'; render(); });
  peer.on('open', () => {
    hostConn = peer.connect(code.trim().toUpperCase(), { reliable: true });
    hostConn.on('open', () => hostConn.send({ type:'hello', name }));
    hostConn.on('data', data => {
      if      (data.type === 'welcome') { myIndex = data.myIndex; pNames = data.names; netPhase = 'waiting'; render(); }
      else if (data.type === 'players') { pNames = data.names; render(); }
      else if (data.type === 'state')   { state = data.state; pNames = data.names || pNames; netPhase = 'playing'; render(); }
    });
    hostConn.on('close', () => { netPhase = 'disconnected'; render(); });
  });
}

function _broadcastPlayers() {
  [1,2].forEach(i => { if (pConns[i]?.open) pConns[i].send({ type:'players', names:pNames }); });
}
function broadcastState() {
  if (!isHost) return;
  const msg = { type:'state', state, names:pNames };
  [1,2].forEach(i => { if (pConns[i]?.open) pConns[i].send(msg); });
}
function sendAction(action) {
  if (isHost) _handleAction(action, 0);
  else if (hostConn?.open) hostConn.send({ type:'action', action });
}
function _handleAction(action, fromIdx) {
  if (!isHost) return;
  const s = state;
  if      (action.kind==='bid'      && s.phase==='bid'       && s.bidder===fromIdx)     processBid(fromIdx, action.amount);
  else if (action.kind==='play'     && s.phase==='play'      && s.curP===fromIdx)       { const c=s.hands[fromIdx].find(c=>c.id===action.cardId); if(c) _doPlay(fromIdx,c); }
  else if (action.kind==='discard'  && s.phase==='discard'   && s.bidWinner===fromIdx)  _doDiscard(action.cardId);
  else if (action.kind==='pickGame' && s.phase==='selectGame'&& s.bidWinner===fromIdx)  { const g=GAMES.find(g=>g.id===action.gameId); if(g) _doPickGame(g); }
}

// ══════════════════════════════════════════════════
// GAME STATE
// ══════════════════════════════════════════════════
let state = {
  phase:'result', hands:[[],[],[]], talon:[], bidder:0, highBid:0,
  highBidder:null, passed:[false,false,false], activeCnt:3,
  game:null, bidWinner:null, trick:[], tw:[0,0,0], curP:0,
  msg:'', scores:[-10,-10,-10], log:[], showTalon:false,
  liftedCard:null, resultMsg:'Üdvözlet! A gazda indítja az első kört.',
};

const addLog = m => { state.log = [m, ...state.log].slice(0,14); };
const after  = ()  => { render(); broadcastState(); };

function startRound() {
  if (!isHost) return;
  const deck = _shuffle(_mkDeck());
  addLog('── Új kör ──');
  state = { ...state,
    phase:'bid',
    hands: [deck.slice(0,10), deck.slice(10,20), deck.slice(20,30)],
    talon: deck.slice(30,32),
    bidder:0, highBid:0, highBidder:null,
    passed:[false,false,false], activeCnt:3,
    game:null, bidWinner:null,
    trick:[], tw:[0,0,0], curP:0,
    showTalon:false, liftedCard:null, resultMsg:'',
    msg: pNames[0] + ' licitál...',
  };
  after();
}

function processBid(pl, amount) {
  const np = [...state.passed];
  let nHB = state.highBid, nHBr = state.highBidder, nAct = state.activeCnt;
  if (amount) { nHB = amount; nHBr = pl; addLog(`${pNames[pl]}: ${amount} → ${GAMES.find(g=>g.id>=amount)?.n}`); }
  else        { np[pl] = true; nAct--; addLog(`${pNames[pl]}: Passz`); }
  state = { ...state, passed:np, highBid:nHB, highBidder:nHBr, activeCnt:nAct };
  if (nAct <= 1 || nHB >= 10) { _resolveAuction(nHBr, nHB); return; }
  let nx = (pl+1)%3; while (np[nx]) nx = (nx+1)%3;
  state = { ...state, bidder:nx, msg:`${pNames[nx]} licitál...` };
  after();
}

function _resolveAuction(winner, winBid) {
  if (winner === null || winner === undefined) {
    addLog('Körpassz!');
    state = { ...state, resultMsg:'Körpassz – senki sem licitált.', phase:'result' };
    after(); return;
  }
  state = { ...state, bidWinner:winner, showTalon:true };
  addLog(`${pNames[winner]} nyerte (${winBid})`);
  state = { ...state, msg:`${pNames[winner]} megnézi a talont – válasszon játékot!`, phase:'selectGame' };
  after();
}

function _doPickGame(g) {
  const nh = state.hands.map(h=>[...h]), bw = state.bidWinner;
  nh[bw] = [...nh[bw], ...state.talon];
  addLog(`Játék: ${g.n} (${pNames[bw]})`);
  state = { ...state, game:g, hands:nh, showTalon:false, liftedCard:null, phase:'discard', msg:`${pNames[bw]} eldob 2 lapot...` };
  after();
}

function _doDiscard(cardId) {
  const nh = state.hands.map(h=>[...h]), bw = state.bidWinner;
  nh[bw] = nh[bw].filter(c => c.id !== cardId);
  if (nh[bw].length === 10) {
    const sp = state.game.tp==='color' ? (bw+1)%3 : (bw+2)%3;
    state = { ...state, hands:nh, liftedCard:null, curP:sp, phase:'play', msg:`${state.game.n} – ${pNames[sp]} kezd!` };
  } else {
    state = { ...state, hands:nh, liftedCard:null, msg:`${pNames[bw]}: még ${nh[bw].length-10} lapot dob el` };
  }
  after();
}

function _doPlay(pl, card) {
  const nh = state.hands.map((h,i) => i===pl ? h.filter(c=>c.id!==card.id) : h);
  const nt = [...state.trick, { pl, card }];
  state = { ...state, hands:nh, trick:nt };
  if (nt.length < 3) {
    const nx = (pl+1)%3;
    state = { ...state, curP:nx, msg:`${pNames[nx]} köre...` };
    after(); return;
  }
  const w = _trickWinner(nt, state.game?.trump);
  const nTW = state.tw.map((t,i) => i===w ? t+1 : t);
  addLog(`${pNames[w]} viszi (T:${nTW[0]} G:${nTW[1]} B:${nTW[2]})`);
  state = { ...state, tw:nTW };
  if (nh[0].length === 0) {
    state = { ...state, phase:'evaluating', msg:'Utolsó menet...' };
    after();
    setTimeout(() => _evalGame(nTW), 1800);
  } else {
    state = { ...state, phase:'between' }; after();
    setTimeout(() => {
      state = { ...state, trick:[], curP:w, phase:'play', msg:`${pNames[w]} kezd...` };
      after();
    }, 1500);
  }
}

function _evalGame(finalTW) {
  const bw=state.bidWinner, got=finalTW[bw], g=state.game;
  let won = false;
  if (['color','szanadu','preferansz'].includes(g.tp)) won = got >= g.tgt;
  else if (g.tp==='betli')   won = got === 0;
  else if (g.tp==='mizer')   won = got === 1;
  else if (g.tp==='pikkolo') won = got === 2;
  const r = `${won?'✓ Megnyerte':'✗ Megbukott'}: ${pNames[bw]} (${got}/${g.tgt})`;
  addLog(r);
  const ns = [...state.scores];
  if (won) ns[bw] = Math.min(0, ns[bw]+g.id); else ns[bw] -= g.id;
  state = { ...state, scores:ns, resultMsg:r, phase:'result' };
  after();
}

// Helpers
const _mkDeck = () => SUITS.flatMap(s => VALS.map(v => ({ s, v, id:`${s}_${v}` })));
const _shuffle = a => {
  const b = [...a];
  for (let i=b.length-1; i>0; i--) { const j=0|Math.random()*(i+1); [b[i],b[j]]=[b[j],b[i]]; }
  return b;
};
const _trickWinner = (trick, trump) => {
  const lead = trick[0].card.s;
  return trick.reduce((best,cur) => {
    const bp = (best.card.s===trump?100:best.card.s===lead?10:0)+VR[best.card.v];
    const cp = (cur.card.s===trump?100:cur.card.s===lead?10:0)+VR[cur.card.v];
    return cp > bp ? cur : best;
  }).pl;
};

// Local actions
function myBid(amount) {
  if (state.phase!=='bid' || state.bidder!==myIndex) return;
  sendAction({ kind:'bid', amount });
}
function myPickGame(g) {
  if (state.phase!=='selectGame' || state.bidWinner!==myIndex) return;
  sendAction({ kind:'pickGame', gameId:g.id });
}
function myDiscard(cardId) {
  if (state.phase!=='discard' || state.bidWinner!==myIndex) return;
  if (state.liftedCard === cardId) { state.liftedCard=null; sendAction({ kind:'discard', cardId }); }
  else { state = { ...state, liftedCard:cardId }; render(); }
}
function myPlay(card) {
  if (state.phase!=='play' || state.curP!==myIndex) return;
  const lead = state.trick[0]?.card.s;
  if (lead && state.hands[myIndex].some(c=>c.s===lead) && card.s!==lead) {
    state = { ...state, msg:'⚠️ Kötelező azonos színt rakni!' }; render(); return;
  }
  if (state.liftedCard === card.id) { state.liftedCard=null; sendAction({ kind:'play', cardId:card.id }); }
  else { state = { ...state, liftedCard:card.id }; render(); }
}

// ══════════════════════════════════════════════════
// KEYBOARD (PC only)
// ══════════════════════════════════════════════════
document.addEventListener('keydown', e => {
  if (netPhase !== 'playing') return;
  const s = state;
  const myHand = getMyHand();
  const key = e.key;

  if (s.phase==='bid' && s.bidder===myIndex) {
    const avail = GAMES.filter(g=>g.id>s.highBid);
    const n = parseInt(key);
    if (!isNaN(n) && n>=1 && n<=avail.length) { e.preventDefault(); myBid(avail[n-1].id); return; }
    if (key==='p'||key==='P') { e.preventDefault(); myBid(null); return; }
  }

  if ((s.phase==='play'&&s.curP===myIndex)||(s.phase==='discard'&&s.bidWinner===myIndex)) {
    const n = key==='0' ? 10 : parseInt(key);
    if (!isNaN(n) && n>=1 && n<=myHand.length) {
      e.preventDefault();
      const card = myHand[n-1];
      if (s.phase==='discard') myDiscard(card.id);
      else { state = { ...state, liftedCard:card.id }; render(); }
      return;
    }
    if ((key==='Enter'||key===' ') && s.liftedCard) {
      e.preventDefault();
      const card = myHand.find(c=>c.id===s.liftedCard);
      if (card) { if (s.phase==='discard') myDiscard(card.id); else myPlay(card); }
      return;
    }
    if (key==='Escape') { e.preventDefault(); state = { ...state, liftedCard:null }; render(); return; }
  }

  if (s.phase==='selectGame' && s.bidWinner===myIndex) {
    const avail = GAMES.filter(g=>g.id>=s.highBid);
    const n = parseInt(key);
    if (!isNaN(n) && n>=1 && n<=avail.length) { e.preventDefault(); myPickGame(avail[n-1]); }
  }

  if (s.phase==='result' && isHost && (key==='Enter'||key===' ')) {
    e.preventDefault(); startRound();
  }
});

// iOS fixes
(function() {
  try {
    if (document.documentElement) {
      function fixVH() {
        document.documentElement.style.setProperty('--vh', (window.innerHeight * 0.01) + 'px');
      }
      window.addEventListener('resize', fixVH);
      fixVH();
    }
  } catch(e) {}
})();

// ══════════════════════════════════════════════════
// SVG CARD DRAWING – Magyar Kártya
// ══════════════════════════════════════════════════
const NS = 'http://www.w3.org/2000/svg';
const mkS = (tag, attrs) => {
  const e = document.createElementNS(NS, tag);
  if (attrs) Object.entries(attrs).forEach(([k,v]) => e.setAttribute(k,v));
  return e;
};

function drawSuit(parent, suit, cx, cy, size) {
  const g = mkS('g', { transform:`translate(${cx-size/2},${cy-size/2}) scale(${size/20})` });
  if (suit === 'makk') {
    g.appendChild(mkS('ellipse',{cx:10,cy:13.5,rx:5.5,ry:6,fill:'#7b4f2e'}));
    g.appendChild(mkS('ellipse',{cx:8,cy:11,rx:2,ry:3,fill:'rgba(255,255,255,0.12)'}));
    g.appendChild(mkS('path',{d:'M3.5,8.5 Q5,5.5 10,5 Q15,5.5 16.5,8.5 Q13.5,10.5 10,10.5 Q6.5,10.5 3.5,8.5Z',fill:'#4a2810'}));
    [5.5,7.5,10,12.5,14.5].forEach(x => g.appendChild(mkS('line',{x1:x,y1:5.8,x2:x+0.4,y2:10.2,stroke:'#3a1f08','stroke-width':0.7})));
    g.appendChild(mkS('path',{d:'M8.5,5 Q9,1.5 10,1.5 Q11,1.5 11.5,5',fill:'#4a2810'}));
  } else if (suit === 'zold') {
    g.appendChild(mkS('path',{d:'M10,18.5 C10,18.5 1.5,13 1.5,7.5 A5,5,0,0,1,10,3.5 A5,5,0,0,1,18.5,7.5 C18.5,13 10,18.5 10,18.5Z',fill:'#2e7d32',stroke:'#1b5e20','stroke-width':0.5}));
    g.appendChild(mkS('line',{x1:10,y1:5,x2:10,y2:18.5,stroke:'#1b5e20','stroke-width':1.1}));
    [[6.5,9.5,10,7.5],[13.5,9.5,10,7.5],[5.5,13,10,11],[14.5,13,10,11]].forEach(([x1,y1,x2,y2]) => g.appendChild(mkS('line',{x1,y1,x2,y2,stroke:'#1b5e20','stroke-width':0.7})));
  } else if (suit === 'piros') {
    g.appendChild(mkS('path',{d:'M10,17.5 L1.5,8.5 A4.8,4.8,0,0,1,10,4.5 A4.8,4.8,0,0,1,18.5,8.5 Z',fill:'#c62828'}));
    g.appendChild(mkS('ellipse',{cx:7.5,cy:8,rx:2,ry:2.5,fill:'rgba(255,255,255,0.18)'}));
  } else if (suit === 'sarga') {
    g.appendChild(mkS('path',{d:'M6.5,15 L5.5,9.5 Q5.5,4.5 10,4 Q14.5,4.5 14.5,9.5 L13.5,15 Z',fill:'#f9a825',stroke:'#e65100','stroke-width':0.5}));
    g.appendChild(mkS('ellipse',{cx:10,cy:15,rx:5,ry:2,fill:'#e65100'}));
    g.appendChild(mkS('line',{x1:10,y1:15.5,x2:10,y2:18,stroke:'#bf360c','stroke-width':1.4,'stroke-linecap':'round'}));
    g.appendChild(mkS('circle',{cx:10,cy:18.5,r:1.2,fill:'#bf360c'}));
    g.appendChild(mkS('path',{d:'M8.5,4 Q8.5,1.5 10,1.5 Q11.5,1.5 11.5,4',fill:'none',stroke:'#e65100','stroke-width':1.3,'stroke-linecap':'round'}));
    g.appendChild(mkS('ellipse',{cx:8,cy:8,rx:1.5,ry:3,fill:'rgba(255,255,255,0.2)'}));
  }
  parent.appendChild(g);
}

function drawFigure(svg, card) {
  const col=SI[card.s].col, cx=27, g=mkS('g');
  if (card.v === 'K') {
    g.appendChild(mkS('path',{d:`M${cx-7},26 L${cx-7},20 L${cx-4},23 L${cx},18 L${cx+4},23 L${cx+7},20 L${cx+7},26 Z`,fill:'#f9a825',stroke:'#e65100','stroke-width':0.5}));
    g.appendChild(mkS('rect',{x:cx-7,y:26,width:14,height:3,rx:1,fill:'#f9a825'}));
    g.appendChild(mkS('circle',{cx,cy:18,r:1.8,fill:'#ef5350'}));
    g.appendChild(mkS('circle',{cx:cx-5,cy:21,r:1.2,fill:'#42a5f5'}));
    g.appendChild(mkS('circle',{cx:cx+5,cy:21,r:1.2,fill:'#42a5f5'}));
    g.appendChild(mkS('ellipse',{cx,cy:33,rx:6.5,ry:7.5,fill:'#ffd7a8'}));
    g.appendChild(mkS('path',{d:`M${cx-5},36 Q${cx},38 ${cx+5},36`,fill:'#8d6e63',stroke:'#6d4c41','stroke-width':0.8}));
    g.appendChild(mkS('path',{d:`M${cx-4},37 Q${cx-3},40 ${cx},41 Q${cx+3},40 ${cx+4},37`,fill:'#6d4c41'}));
    g.appendChild(mkS('path',{d:`M${cx-10},40 L${cx-11},64 L${cx+11},64 L${cx+10},40 Q${cx},44 ${cx-10},40Z`,fill:col+'ee'}));
    g.appendChild(mkS('rect',{x:cx-10,y:50,width:20,height:3,rx:1,fill:'#f9a825aa'}));
    g.appendChild(mkS('line',{x1:cx+9,y1:35,x2:cx+9,y2:62,stroke:'#c9a227','stroke-width':2,'stroke-linecap':'round'}));
    g.appendChild(mkS('circle',{cx:cx+9,cy:33.5,r:3.2,fill:'#f9a825'}));
    g.appendChild(mkS('circle',{cx:cx+9,cy:33.5,r:1.5,fill:'#ef5350'}));
    g.appendChild(mkS('line',{x1:cx-9,y1:43,x2:cx-9,y2:62,stroke:'#90a4ae','stroke-width':2}));
    g.appendChild(mkS('line',{x1:cx-13,y1:46,x2:cx-5,y2:46,stroke:'#90a4ae','stroke-width':2}));
  } else if (card.v === 'F') {
    g.appendChild(mkS('ellipse',{cx,cy:21,rx:9,ry:2.5,fill:'#37474f'}));
    g.appendChild(mkS('rect',{x:cx-6,y:12,width:12,height:10,rx:1.5,fill:'#37474f'}));
    g.appendChild(mkS('path',{d:`M${cx+5},12 Q${cx+18},5 ${cx+15},18`,fill:'none',stroke:'#ff7043','stroke-width':2,'stroke-linecap':'round'}));
    g.appendChild(mkS('ellipse',{cx,cy:30,rx:6,ry:7,fill:'#ffd7a8'}));
    g.appendChild(mkS('path',{d:`M${cx-4},32 Q${cx-2},31 ${cx},32 Q${cx+2},31 ${cx+4},32`,fill:'none',stroke:'#5d4037','stroke-width':1.3}));
    g.appendChild(mkS('path',{d:`M${cx-9},37 L${cx-10},64 L${cx+10},64 L${cx+9},37 Q${cx},41 ${cx-9},37Z`,fill:col+'dd'}));
    g.appendChild(mkS('line',{x1:cx-8,y1:40,x2:cx-8,y2:62,stroke:'#b0bec5','stroke-width':2.5}));
    g.appendChild(mkS('line',{x1:cx-12,y1:44,x2:cx-4,y2:44,stroke:'#b0bec5','stroke-width':2}));
    g.appendChild(mkS('path',{d:`M${cx-8},39 L${cx-6},36 L${cx-10},36 Z`,fill:'#b0bec5'}));
  } else if (card.v === 'A') {
    g.appendChild(mkS('path',{d:`M${cx-6},22 Q${cx-6},11 ${cx+2},11 Q${cx+9},11 ${cx+9},18 L${cx+9},24 Z`,fill:'#78909c',stroke:'#546e7a','stroke-width':0.8}));
    g.appendChild(mkS('rect',{x:cx-6,y:22,width:15,height:2.5,fill:'#546e7a'}));
    [14,16.5,19].forEach(y => g.appendChild(mkS('line',{x1:cx-3,y1:y,x2:cx+7,y2:y,stroke:'#455a64','stroke-width':0.6})));
    g.appendChild(mkS('ellipse',{cx:cx+1.5,cy:31,rx:5.5,ry:6.5,fill:'#ffd7a8'}));
    g.appendChild(mkS('rect',{x:cx-8,y:37,width:17,height:27,rx:2,fill:'#78909c'}));
    g.appendChild(mkS('path',{d:`M${cx-14},40 L${cx-14},55 Q${cx-11},62 ${cx-8},58 L${cx-8},40 Z`,fill:col,stroke:SI[card.s].dark,'stroke-width':0.8}));
    drawSuit(g, card.s, cx-11, 49, 9);
    g.appendChild(mkS('line',{x1:cx+10,y1:16,x2:cx+10,y2:64,stroke:'#8d6e63','stroke-width':2,'stroke-linecap':'round'}));
    g.appendChild(mkS('polygon',{points:`${cx+10},11 ${cx+7.5},17 ${cx+12.5},17`,fill:'#90a4ae'}));
  }
  svg.appendChild(g);
}

function buildCardSVG(card, lifted, W, H) {
  const svg = mkS('svg',{width:W,height:H,viewBox:'0 0 54 84',role:'img','aria-label':`${VNAME[card.v]} ${SI[card.s].n}`});
  svg.className = 'card-svg ' + (lifted ? 'lifted' : 'normal');
  const isFace = ['A','F','K'].includes(card.v);
  const sc = SI[card.s];
  svg.appendChild(mkS('rect',{width:54,height:84,rx:5,fill:lifted?'#fffce0':'#fdf6e3',stroke:'#c8b49a','stroke-width':0.4}));
  svg.appendChild(mkS('rect',{x:2.5,y:2.5,width:49,height:79,rx:3.5,fill:'none',stroke:sc.col,'stroke-width':0.9}));
  svg.appendChild(mkS('rect',{x:3.8,y:3.8,width:46.4,height:76.4,rx:2.5,fill:'none',stroke:sc.col+'44','stroke-width':0.5}));
  [[5,5],[49,5],[5,79],[49,79]].forEach(([x,y]) => svg.appendChild(mkS('circle',{cx:x,cy:y,r:1.2,fill:sc.col+'66'})));
  if (isFace) {
    svg.appendChild(mkS('rect',{x:3.5,y:3.5,width:47,height:77,rx:3,fill:sc.col+'11'}));
    const tG=mkS('g'); const tv=mkS('text',{x:5,y:11,'font-size':8,'font-weight':'bold',fill:sc.col,'font-family':'Georgia,serif','text-anchor':'middle'}); tv.textContent=card.v; tG.appendChild(tv);
    drawSuit(tG,card.s,5,17,8); svg.appendChild(tG);
    drawFigure(svg, card);
    const bG=mkS('g',{transform:'rotate(180,27,42)'}); const bv=mkS('text',{x:5,y:11,'font-size':8,'font-weight':'bold',fill:sc.col,'font-family':'Georgia,serif','text-anchor':'middle'}); bv.textContent=card.v; bG.appendChild(bv);
    drawSuit(bG,card.s,5,17,8); svg.appendChild(bG);
  } else {
    const tG=mkS('g'); const tv=mkS('text',{x:5,y:11,'font-size':9,'font-weight':'bold',fill:sc.col,'font-family':'Georgia,serif','text-anchor':'middle'}); tv.textContent=card.v; tG.appendChild(tv);
    drawSuit(tG,card.s,5,19,8); svg.appendChild(tG);
    const bG=mkS('g',{transform:'rotate(180,27,42)'}); const bv=mkS('text',{x:5,y:11,'font-size':9,'font-weight':'bold',fill:sc.col,'font-family':'Georgia,serif','text-anchor':'middle'}); bv.textContent=card.v; bG.appendChild(bv);
    drawSuit(bG,card.s,5,19,8); svg.appendChild(bG);
    if (card.v==='Á') {
      drawSuit(svg,card.s,27,40,30);
      svg.appendChild(mkS('circle',{cx:27,cy:40,r:17,fill:'none',stroke:sc.col+'33','stroke-width':2}));
    } else {
      const pos={'7':[[27,42]],'8':[[27,25],[27,59]],'9':[[27,22],[27,42],[27,62]],'10':[[16,25],[38,25],[16,59],[38,59]]}[card.v]||[[27,42]];
      pos.forEach(([cx,cy]) => drawSuit(svg,card.s,cx,cy,pos.length<=2?14:12));
    }
  }
  return svg;
}

function buildBackSVG(W, H) {
  const svg = mkS('svg',{width:W,height:H,viewBox:'0 0 54 84'});
  svg.className = 'back-svg';
  svg.appendChild(mkS('rect',{width:54,height:84,rx:5,fill:'#1a237e'}));
  svg.appendChild(mkS('rect',{x:3,y:3,width:48,height:78,rx:3,fill:'none',stroke:'#3949ab','stroke-width':1.2}));
  for(let x=8;x<50;x+=8) svg.appendChild(mkS('line',{x1:x,y1:5,x2:x,y2:79,stroke:'#3949ab','stroke-width':0.4}));
  for(let y=10;y<79;y+=9) svg.appendChild(mkS('line',{x1:3,y1:y,x2:51,y2:y,stroke:'#3949ab','stroke-width':0.4}));
  [[9,9],[45,9],[9,75],[45,75]].forEach(([cx,cy]) => {
    [0,60,120,180,240,300].forEach(a => { const r=a*Math.PI/180; svg.appendChild(mkS('line',{x1:cx,y1:cy,x2:cx+Math.cos(r)*5,y2:cy+Math.sin(r)*5,stroke:'#5c6bc0','stroke-width':0.8})); });
    svg.appendChild(mkS('circle',{cx,cy,r:2,fill:'#7986cb'}));
  });
  const [cx,cy]=[27,42];
  [0,45,90,135,180,225,270,315].forEach(a => { const r=a*Math.PI/180; svg.appendChild(mkS('line',{x1:cx,y1:cy,x2:cx+Math.cos(r)*8,y2:cy+Math.sin(r)*8,stroke:'#5c6bc0','stroke-width':0.8})); });
  svg.appendChild(mkS('circle',{cx,cy,r:5,fill:'none',stroke:'#7986cb','stroke-width':1.2}));
  svg.appendChild(mkS('circle',{cx,cy,r:2.5,fill:'#7986cb'}));
  const t=mkS('text',{x:cx,y:cy+4,'font-size':6,'font-weight':'bold',fill:'#9fa8da','text-anchor':'middle','font-family':'Georgia,serif'}); t.textContent='M'; svg.appendChild(t);
  return svg;
}

function mkCard(card, onClick, lifted, W=54, H=84) {
  const w = document.createElement('div');
  w.className = 'card-wrap';
  if (onClick) w.addEventListener('click', onClick);
  w.appendChild(buildCardSVG(card, lifted, W, H));
  return w;
}
function mkBack(W=28, H=43) {
  const d = document.createElement('div');
  d.className = 'card-wrap';
  d.appendChild(buildBackSVG(W, H));
  return d;
}

// ══════════════════════════════════════════════════
// DOM HELPERS
// ══════════════════════════════════════════════════
function el(tag, attrs, children) {
  const e = document.createElement(tag);
  if (attrs) Object.entries(attrs).forEach(([k,v]) => {
    if      (k === 'style') Object.assign(e.style, v);
    else if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2).toLowerCase(), v);
    else e.setAttribute(k, v);
  });
  if (children) children.forEach(c => { if (c!=null) e.appendChild(typeof c==='string' ? document.createTextNode(c) : c); });
  return e;
}
const div  = (cls, st, ch) => { const d=el('div',{class:cls,style:st||{}},ch); return d; };
const span = (cls, txt)    => el('span',{class:cls},[txt]);
function btn(cls, cb, children) { return el('button',{class:cls,onClick:cb},children); }
function inp(id, ph, onCh, extra={}) {
  const i = el('input',{ type:'text', id, placeholder:ph, autocomplete:'off', autocorrect:'off', autocapitalize:extra.caps||'off', spellcheck:'false' });
  i.value = extra.val||'';
  i.style.fontSize = '16px';
  i.addEventListener('input', e => onCh(e.target.value));
  return i;
}

// ══════════════════════════════════════════════════
// RENDER ROUTER
// ══════════════════════════════════════════════════
function render() {
  const app = document.getElementById('app');
  app.innerHTML = '';
  if (netPhase==='lobby')        { app.appendChild(rLobby());   return; }
  if (netPhase==='hosting'||netPhase==='ready') { app.appendChild(rHosting()); return; }
  if (netPhase==='joining')      { app.appendChild(rSimple('⏳','Csatlakozás...','Kapcsolódás a gazdához...')); return; }
  if (netPhase==='waiting')      { app.appendChild(rWaiting()); return; }
  if (netPhase==='disconnected') { app.appendChild(rDisconn()); return; }
  app.appendChild(IS_PC() ? rGamePC() : rGameMobile());
}

// ══════════════════════════════════════════════════
// LOBBY
// ══════════════════════════════════════════════════
function rLobby() {
  let n='', c='';
  const wrap = el('div',{class:'screen-center fade-in'});

  wrap.appendChild(el('div',{style:{fontSize:'58px',textAlign:'center'}},['🃏']));
  wrap.appendChild(el('h1',{class:'lobby-title'},['PREFERANSZ']));
  wrap.appendChild(el('p',{class:'lobby-subtitle'},['Többjátékos · 3 ember · bármilyen hálózatról']));

  if (netError) wrap.appendChild(el('div',{class:'error-box'},[netError]));

  const form = el('div',{class:'lobby-form'});

  form.appendChild(el('label',{class:'form-label'},['Neved:']));
  const nameI = inp('inp-name','Pl. Kovács Péter', v=>n=v, {caps:'words'});
  form.appendChild(nameI);

  form.appendChild(btn('btn-primary', () => {
    const nm = document.getElementById('inp-name')?.value || n;
    if (!nm.trim()) { alert('Írd be a nevedet!'); return; }
    doHost(nm.trim());
  }, ['🏠 Új játék indítása']));

  form.appendChild(el('div',{class:'divider'},['— vagy csatlakozz —']));

  form.appendChild(el('label',{class:'form-label'},['Szobakód (6 karakter):']));
  const codeI = inp('inp-code','Pl. AB3X7K', v=>c=v.toUpperCase(), {caps:'characters'});
  codeI.style.letterSpacing='5px'; codeI.style.textAlign='center'; codeI.style.textTransform='uppercase';
  form.appendChild(codeI);

  form.appendChild(btn('btn-secondary', () => {
    const nm = document.getElementById('inp-name')?.value || n;
    const cd = document.getElementById('inp-code')?.value || c;
    if (!nm.trim()) { alert('Írd be a nevedet!'); return; }
    if (!cd.trim()) { alert('Írd be a szobakódot!'); return; }
    doJoin(nm.trim(), cd.trim());
  }, ['🔗 Csatlakozás kóddal']));

  if (IS_PC()) form.appendChild(el('div',{class:'kbd-hint'},['Billentyűk: 1–9 licit/kártya · Enter lerak · P passz · Esc mégsem']));

  wrap.appendChild(form);
  return wrap;
}

// ══════════════════════════════════════════════════
// HOSTING
// ══════════════════════════════════════════════════
function rHosting() {
  const wrap = el('div',{class:'screen-center fade-in'});
  wrap.appendChild(el('div',{style:{fontSize:'48px'}},['🏠']));
  wrap.appendChild(el('h2',{style:{fontSize:'21px',color:'#ffcc02',textAlign:'center'}},['Várakozás a barátokra...']));
  wrap.appendChild(el('p',{class:'lobby-subtitle'},['Küldd el ezt a kódot a 2 barátodnak:']));

  const codeEl = el('div',{class:'room-code', onClick:() => {
    try { navigator.clipboard.writeText(roomCode).then(() => { codeEl.style.background='rgba(76,175,80,0.2)'; setTimeout(()=>codeEl.style.background='',1000); }); } catch(e){}
  }},[roomCode]);
  wrap.appendChild(codeEl);
  wrap.appendChild(el('p',{style:{color:'rgba(255,255,255,0.32)',fontSize:'11px'}},['👆 koppints a másoláshoz']));

  const plist = el('div',{class:'player-list'});
  plist.appendChild(el('div',{class:'player-list-title'},['CSATLAKOZOTT JÁTÉKOSOK']));
  [0,1,2].forEach(i => {
    const row = el('div',{class:'player-row'});
    const dot = el('div',{class:'player-dot'+(i<=joinedCount?' joined':'')},[i<=joinedCount?'✓':'○']);
    const nm  = el('div',{class:'player-name'+(i<=joinedCount?' joined':'')},[i===0?pNames[0]+' (Te – gazda)':pNames[i]||`Vendég ${i} – hiányzik`]);
    row.appendChild(dot); row.appendChild(nm); plist.appendChild(row);
  });
  wrap.appendChild(plist);

  if (joinedCount === 2) {
    wrap.appendChild(btn('btn-green slide-up', ()=>{netPhase='playing';startRound();}, ['▶ Játék indítása!']));
  } else {
    wrap.appendChild(el('div',{class:'lobby-subtitle pulsing'},[`Még ${2-joinedCount} játékos hiányzik...`]));
  }

  wrap.appendChild(btn('btn-ghost', ()=>{netPhase='lobby';joinedCount=0;pConns=[null,null,null];if(peer){peer.destroy();peer=null;}render();},['← Vissza']));
  return wrap;
}

// ══════════════════════════════════════════════════
// SIMPLE STATUS SCREENS
// ══════════════════════════════════════════════════
function rSimple(icon, title, sub) {
  return el('div',{class:'screen-center fade-in'},[
    el('div',{style:{fontSize:'48px'}},[icon]),
    el('h2',{style:{fontSize:'20px',color:'#ffcc02'}},[title]),
    el('p',{class:'lobby-subtitle pulsing'},[sub]),
    btn('btn-ghost', ()=>{netPhase='lobby';if(peer){peer.destroy();peer=null;}render();},[' ← Mégse']),
  ]);
}

function rWaiting() {
  const wrap = el('div',{class:'screen-center fade-in'});
  wrap.appendChild(el('div',{style:{fontSize:'48px'}},['🕐']));
  wrap.appendChild(el('h2',{style:{fontSize:'20px',color:'#ffcc02'}},['Csatlakozva!']));
  wrap.appendChild(el('p',{class:'lobby-subtitle'},['Belépve mint: '+pNames[myIndex]+'\nVárakozás, amíg a gazda elindítja a játékot...']));
  const plist = el('div',{class:'player-list'});
  [0,1,2].forEach(i=>{
    const row=el('div',{class:'player-row'});
    row.appendChild(el('div',{class:'player-dot joined'},[i===0?'👑':i===myIndex?'⭐':'•']));
    row.appendChild(el('div',{class:'player-name joined',style:{color:i===myIndex?'#ffcc02':'white'}},[pNames[i]+(i===0?' (gazda)':'')+(i===myIndex?' – Te':'')]));
    plist.appendChild(row);
  });
  wrap.appendChild(plist);
  return wrap;
}

function rDisconn() {
  return el('div',{class:'screen-center fade-in'},[
    el('div',{style:{fontSize:'48px'}},['📵']),
    el('h2',{style:{fontSize:'20px',color:'#ef9a9a'}},['Kapcsolat megszakadt']),
    el('p',{class:'lobby-subtitle'},['Valamelyik játékos kilépett.']),
    btn('btn-primary', ()=>{netPhase='lobby';joinedCount=0;pConns=[null,null,null];hostConn=null;if(peer){peer.destroy();peer=null;}render();},['Vissza a menübe']),
  ]);
}

// ══════════════════════════════════════════════════
// GAME HELPERS
// ══════════════════════════════════════════════════
const getMyHand = () => SUITS.flatMap(su => state.hands[myIndex].filter(c=>c.s===su).sort((a,b)=>VR[a.v]-VR[b.v]));
const isMyTurn  = () => {
  const s=state;
  return (s.phase==='play'&&s.curP===myIndex)||(s.phase==='bid'&&s.bidder===myIndex)||
         (s.phase==='discard'&&s.bidWinner===myIndex)||(s.phase==='selectGame'&&s.bidWinner===myIndex);
};
const showTrick = () => ['play','between','evaluating'].includes(state.phase);

function buildHeader() {
  const s=state, mt=isMyTurn();
  const hdr = el('div',{class:'game-header'});
  hdr.appendChild(el('span',{class:'header-status'+(mt?' my-turn':'')},[mt?'🎯 Te jössz!':'Játékban']));
  const sb = el('div',{class:'score-board'});
  [0,1,2].forEach(i=>{
    const si=el('div',{class:'score-item'});
    si.appendChild(el('div',{class:'score-name'+(i===myIndex?' me':'')},[pNames[i]+(i===myIndex?' ★':'')]));
    si.appendChild(el('div',{class:'score-val'+(s.scores[i]>=0?' winning':'')},[s.scores[i].toString()]));
    sb.appendChild(si);
  });
  hdr.appendChild(sb);
  return hdr;
}

function buildMsgBar() {
  const mt=isMyTurn();
  return el('div',{class:'msg-bar'+(mt?' my-turn':'')},[state.msg||'...']);
}

function buildBadge() {
  const s=state;
  if (!s.game || !showTrick()) return null;
  const d=el('div',{class:'game-badge'});
  d.appendChild(el('span',{},[s.game.n+(s.game.trump?' · tromf: '+SI[s.game.trump].n:' · nincs tromf')+' · cél:'+s.game.tgt+(s.bidWinner!==null?' · '+pNames[s.bidWinner]:'')]));
  return d;
}

function buildBidPanel() {
  const s=state;
  if (s.phase!=='bid') return null;
  if (s.bidder!==myIndex) return el('div',{class:'waiting-msg pulsing'},[pNames[s.bidder]+' gondolkodik...']);
  const avail=GAMES.filter(g=>g.id>s.highBid);
  const wrap=el('div',{class:'action-panel'});
  wrap.appendChild(el('div',{class:'bid-label'},[s.highBid?`Jelenlegi: ${s.highBid} (${GAMES.find(g=>g.id>=s.highBid)?.n})`:'Nyitó licit – mennyit mondasz?']));
  const bb=el('div',{class:'bid-buttons'});
  avail.forEach((g,i)=>{
    const b=btn('bid-btn',()=>myBid(g.id),[]);
    if(IS_PC()){const k=el('span',{class:'kbd-idx'},[(i+1).toString()]);b.appendChild(k);}
    b.appendChild(document.createTextNode(g.id+'·'+g.n));
    bb.appendChild(b);
  });
  wrap.appendChild(bb);
  const pb=btn('btn-passz',()=>myBid(null),[]);
  if(IS_PC()){pb.appendChild(el('span',{class:'passz-key'},['P']));}
  pb.appendChild(document.createTextNode('Passz'));
  wrap.appendChild(pb);
  return wrap;
}

function buildGamePickPanel() {
  const s=state;
  if (s.phase!=='selectGame') return null;
  if (s.bidWinner!==myIndex) return el('div',{class:'waiting-msg pulsing'},[pNames[s.bidWinner]+' választ játékot...']);
  const avail=GAMES.filter(g=>g.id>=s.highBid);
  const wrap=el('div',{class:'action-panel'});
  wrap.appendChild(el('div',{class:'bid-label'},['Melyik játékot játszod? (min: '+s.highBid+')']));
  const bb=el('div',{class:'game-picker-btns'});
  avail.forEach((g,i)=>{
    const b=btn('game-pick-btn',()=>myPickGame(g),[]);
    if(IS_PC()){b.appendChild(el('span',{class:'kbd-idx'},[(i+1).toString()]));}
    b.appendChild(document.createTextNode(g.n));
    bb.appendChild(b);
  });
  wrap.appendChild(bb);
  return wrap;
}

function buildDiscardHint() {
  const s=state;
  if (s.phase!=='discard') return null;
  if (s.bidWinner!==myIndex) return el('div',{class:'waiting-msg pulsing'},[pNames[s.bidWinner]+' eldob 2 lapot...']);
  const myH=getMyHand();
  return el('div',{class:'discard-hint'},['👆 Koppints a lapra az eldobáshoz ('+(myH.length-10)+' kell)']);
}

function buildLog(maxLines=3) {
  const w=el('div',{class:'game-log'});
  state.log.slice(0,maxLines).forEach((l,i)=>{
    w.appendChild(el('div',{class:'log-line'+(i===0?' latest':'')},[' • '+l]));
  });
  return w;
}

function buildOpponents() {
  const s=state, st=showTrick();
  const row=el('div',{class:'opponents-row'});
  [0,1,2].filter(i=>i!==myIndex).forEach(pi=>{
    const panel=el('div',{class:'opponent-panel'});
    panel.appendChild(el('div',{class:'opponent-name'},[pNames[pi]+(st&&s.curP===pi?' 🎯':'')+' · '+s.tw[pi]+'v']));
    const cards=el('div',{class:'opponent-cards'});
    s.hands[pi].forEach(()=>cards.appendChild(mkBack(IS_PC()?26:20, IS_PC()?40:31)));
    panel.appendChild(cards);
    row.appendChild(panel);
  });
  return row;
}

function buildTalon() {
  const s=state;
  if (!s.showTalon||!s.talon.length) return null;
  const w=el('div',{class:'talon-area'});
  w.appendChild(el('div',{class:'talon-label'},['— Talon —']));
  const cards=el('div',{class:'talon-cards'});
  s.talon.forEach(c=>cards.appendChild(mkCard(c,null,false,IS_PC()?54:44,IS_PC()?84:68)));
  w.appendChild(cards);
  return w;
}

function buildTable() {
  const s=state;
  if (!showTrick()) return null;
  const w=el('div',{class:'table-area'});
  const meta=el('div',{class:'table-meta'});
  meta.appendChild(el('span',{},'Menet '+Math.min(10,s.tw[0]+s.tw[1]+s.tw[2]+s.trick.length)+'/10'));
  meta.appendChild(el('span',{},'T:'+s.tw[0]+' G:'+s.tw[1]+' B:'+s.tw[2]));
  w.appendChild(meta);
  const cards=el('div',{class:'table-cards'});
  if (!s.trick.length) {
    cards.appendChild(el('span',{class:'table-empty'},['— asztal üres —']));
  } else {
    s.trick.forEach(t=>{
      const slot=el('div',{class:'trick-slot'});
      slot.appendChild(el('div',{class:'trick-name'+(t.pl===myIndex?' me':'')},[pNames[t.pl]+(t.pl===myIndex?' (Te)':'')]));
      slot.appendChild(mkCard(t.card,null,false,IS_PC()?54:44,IS_PC()?84:68));
      cards.appendChild(slot);
    });
  }
  w.appendChild(cards);
  return w;
}

function buildHand() {
  const s=state, mt=isMyTurn(), myH=getMyHand();
  const cW=IS_PC()?54:46, cH=IS_PC()?84:71;
  const wrap=el('div',{class:'my-hand-wrap'});
  const meta=el('div',{class:'hand-meta'});
  meta.appendChild(el('span',{class:'hand-label'+(mt?' my-turn':'')},'Te ('+myH.length+' lap)'+(mt?' 🎯':'')));
  meta.appendChild(el('span',{class:'hand-tricks'},s.tw[myIndex]+' viteled'));
  wrap.appendChild(meta);
  const cards=el('div',{class:'hand-cards'});
  myH.forEach(card=>{
    const isLifted=s.liftedCard===card.id;
    const canAct=(s.phase==='play'&&s.curP===myIndex)||(s.phase==='discard'&&s.bidWinner===myIndex);
    cards.appendChild(mkCard(card, canAct?()=>{
      if (s.phase==='discard') myDiscard(card.id); else myPlay(card);
    }:null, isLifted, cW, cH));
  });
  wrap.appendChild(cards);
  if (s.liftedCard) wrap.appendChild(el('div',{class:'lifted-hint'},[s.phase==='discard'?'Koppints újra → eldob!':'Koppints újra → lerak!']));
  return wrap;
}

function buildResultOverlay() {
  const s=state;
  if (s.phase!=='result') return null;
  const emoji=s.resultMsg.startsWith('✓')?'🏆':s.resultMsg.startsWith('✗')?'💀':'🃏';
  const overlay=el('div',{class:'result-overlay'});
  const card=el('div',{class:'result-card'});
  card.appendChild(el('div',{class:'result-emoji'},[emoji]));
  card.appendChild(el('h2',{class:'result-title'},[s.resultMsg||'Kör vége']));
  const scores=el('div',{class:'result-scores'});
  [0,1,2].forEach(i=>{
    const si=el('div',{class:'result-score-item'});
    si.appendChild(el('div',{class:'result-score-name'+(i===myIndex?' me':'')},[pNames[i]+(i===myIndex?' ★':'')]));
    si.appendChild(el('div',{class:'result-score-val'+(s.scores[i]>=0?' winning':'')},[s.scores[i].toString()]));
    scores.appendChild(si);
  });
  card.appendChild(scores);
  const leader=s.scores.indexOf(Math.max(...s.scores));
  if (s.scores.some(sc=>sc>=0)) card.appendChild(el('div',{class:'result-leader'},['🎉 '+pNames[leader]+' vezet!']));
  if (isHost) {
    const nb=btn('btn-next-round',startRound,[]);
    if (IS_PC()) nb.appendChild(el('span',{class:'kbd',style:{marginRight:'8px'}},['Enter']));
    nb.appendChild(document.createTextNode('▶ Következő kör'));
    card.appendChild(nb);
  } else {
    card.appendChild(el('div',{class:'waiting-host pulsing'},['⏳ Gazda indítja a következő kört...']));
  }
  card.appendChild(btn('btn-danger-outline',()=>{netPhase='lobby';joinedCount=0;pConns=[null,null,null];hostConn=null;if(peer){peer.destroy();peer=null;}render();},[' ← Kilépés']));
  overlay.appendChild(card);
  return overlay;
}

// ══════════════════════════════════════════════════
// MOBILE GAME RENDER
// ══════════════════════════════════════════════════
function rGameMobile() {
  const wrap=el('div',{class:'game-wrap'});
  wrap.appendChild(buildHeader());
  wrap.appendChild(buildOpponents());
  const talon=buildTalon(); if(talon) wrap.appendChild(talon);
  const table=buildTable(); if(table) wrap.appendChild(table);
  wrap.appendChild(buildMsgBar());
  const badge=buildBadge(); if(badge) wrap.appendChild(badge);
  const bid=buildBidPanel(); if(bid) wrap.appendChild(bid);
  const pick=buildGamePickPanel(); if(pick) wrap.appendChild(pick);
  const disc=buildDiscardHint(); if(disc) wrap.appendChild(disc);
  wrap.appendChild(buildLog(3));
  wrap.appendChild(buildHand());
  const res=buildResultOverlay(); if(res) wrap.appendChild(res);
  return wrap;
}

// ══════════════════════════════════════════════════
// PC GAME RENDER
// ══════════════════════════════════════════════════
function rGamePC() {
  const s=state;
  const wrap=el('div',{class:'game-wrap'});
  wrap.appendChild(buildHeader());

  const body=el('div',{class:'pc-game-body'});

  // Left column – first opponent + log + kbd hints
  const left=el('div',{class:'pc-left'});
  const others=[0,1,2].filter(i=>i!==myIndex);
  const p1=others[0];

  const op1=el('div',{class:'pc-panel'});
  op1.appendChild(el('div',{class:'pc-panel-title'},[pNames[p1]+(showTrick()&&s.curP===p1?' 🎯':'')+' · '+s.tw[p1]+' vitele']));
  const oc1=el('div',{class:'opponent-cards',style:{justifyContent:'center'}});
  s.hands[p1].forEach(()=>oc1.appendChild(mkBack(26,40))); op1.appendChild(oc1);
  left.appendChild(op1);

  const logPanel=el('div',{class:'pc-panel',style:{flex:'1'}});
  logPanel.appendChild(el('div',{class:'pc-panel-title'},['NAPLÓ']));
  const logLines=el('div',{class:'pc-log-lines'});
  s.log.slice(0,10).forEach((l,i)=>{ const d=el('div',{class:'pc-log-line'+(i===0?' latest':'')},[' • '+l]); logLines.appendChild(d); });
  logPanel.appendChild(logLines);
  left.appendChild(logPanel);

  const kbdPanel=el('div',{class:'pc-panel'});
  kbdPanel.appendChild(el('div',{class:'pc-panel-title'},['BILLENTYŰK']));
  const kbdTbl=el('table',{class:'pc-kbd-table'});
  [['1–9','kártya / licit'],['Enter','lerak'],['P','passz'],['Esc','mégsem']].forEach(([k,v])=>{
    const tr=el('tr'); tr.appendChild(el('td',{},[el('span',{class:'kbd'},[k])])); tr.appendChild(el('td',{},[v])); kbdTbl.appendChild(tr);
  });
  kbdPanel.appendChild(kbdTbl);
  left.appendChild(kbdPanel);
  body.appendChild(left);

  // Center column
  const center=el('div',{class:'pc-center'});
  const talon=buildTalon(); if(talon) center.appendChild(talon);
  const table=buildTable(); if(table) center.appendChild(table);
  center.appendChild(buildMsgBar());
  const badge=buildBadge(); if(badge) center.appendChild(badge);
  const bid=buildBidPanel(); if(bid) center.appendChild(bid);
  const pick=buildGamePickPanel(); if(pick) center.appendChild(pick);
  const disc=buildDiscardHint(); if(disc) center.appendChild(disc);
  center.appendChild(buildHand());
  body.appendChild(center);

  // Right column – second opponent + scores
  const right=el('div',{class:'pc-right'});
  const p2=others[1];
  const op2=el('div',{class:'pc-panel'});
  op2.appendChild(el('div',{class:'pc-panel-title'},[pNames[p2]+(showTrick()&&s.curP===p2?' 🎯':'')+' · '+s.tw[p2]+' vitele']));
  const oc2=el('div',{class:'opponent-cards',style:{justifyContent:'center'}});
  s.hands[p2].forEach(()=>oc2.appendChild(mkBack(26,40))); op2.appendChild(oc2);
  right.appendChild(op2);

  const scPanel=el('div',{class:'pc-panel'});
  scPanel.appendChild(el('div',{class:'pc-panel-title'},['PONTSZÁMOK']));
  [0,1,2].forEach(i=>{
    const row=el('div',{style:{display:'flex',justifyContent:'space-between',padding:'4px 0',borderBottom:'1px solid rgba(255,255,255,0.07)'}});
    row.appendChild(el('span',{style:{fontSize:'12px',color:i===myIndex?'#ffcc02':'#a5d6a7'}},[pNames[i]+(i===myIndex?' ★':'')]));
    row.appendChild(el('span',{style:{fontSize:'16px',fontWeight:'bold',color:s.scores[i]>=0?'#ffee58':'white'}},[s.scores[i].toString()]));
    scPanel.appendChild(row);
  });
  right.appendChild(scPanel);

  const logR=el('div',{class:'pc-panel',style:{flex:'1'}});
  logR.appendChild(el('div',{class:'pc-panel-title'},['JÁTÉK INFO']));
  if(s.game){
    [{k:'Játék',v:s.game.n},{k:'Tromf',v:s.game.trump?SI[s.game.trump].n:'nincs'},{k:'Cél',v:s.game.tgt+' vitele'},{k:'Hirdető',v:s.bidWinner!==null?pNames[s.bidWinner]:'–'}].forEach(({k,v})=>{
      const row=el('div',{style:{display:'flex',justifyContent:'space-between',marginBottom:'5px'}});
      row.appendChild(el('span',{style:{fontSize:'10px',color:'#81c784'}},[k]));
      row.appendChild(el('span',{style:{fontSize:'11px',color:'white'}},[String(v)]));
      logR.appendChild(row);
    });
  } else { logR.appendChild(el('div',{style:{fontSize:'11px',color:'rgba(255,255,255,0.3)',marginTop:'4px'}},['Nincs aktív játék'])); }
  right.appendChild(logR);

  body.appendChild(right);
  wrap.appendChild(body);

  const res=buildResultOverlay(); if(res) wrap.appendChild(res);
  return wrap;
}

// ══════════════════════════════════════════════════
// BOOT
// ══════════════════════════════════════════════════
window.onerror = (msg, src, line) => {
  document.getElementById('app').innerHTML =
    `<div style="color:#ff8a65;padding:28px;font-family:Georgia,serif;text-align:center;"><b>Hiba:</b><br>${msg}<br><small>sor: ${line}</small></div>`;
  return true;
};

window.addEventListener('resize', () => { if (netPhase==='playing') render(); });

try { render(); } catch(e) {
  document.getElementById('app').innerHTML =
    `<div style="color:#ff8a65;padding:28px;font-family:Georgia,serif;text-align:center;"><b>Indítási hiba:</b><br>${e.message}</div>`;
}
