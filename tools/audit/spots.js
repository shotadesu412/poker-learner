// 評価ロジックの大規模監査（1プロセス分）。
//   node tools/audit/spots.js <static/poker のパス> <seed> <ハンド数> <出力.jsonl> [サンプル率=0.35] [ロールアウト数=16]
//
// やること:
//  1. あなた役（探索つきの簡易ルール）でハンドを進める
//  2. あなたの手番のうち一部を「スポット」として切り出し、選べる各アクションについて
//     - アプリの判定（◎◯△×）を取る
//     - その局面をコピーして、最後まで打ち切った収支を K 回平均する（ロールアウト）
//       CPU は実際のロジック・実際の手札のまま。残りのボードは毎回シャッフル。
//       アクション間で同じ乱数種を使う（共通乱数法: 差の分散を減らす）
//  3. 特徴量（ストリート・ポジション・ポットの種類・手の分類・表示勝率・CPU の実際の手札への勝率）と一緒に1行で書き出す
//
// 1スポット内では CPU の手札が固定なので、1スポットの最善手は「透視」になる。比べるのは
// 「同じ判定（例: コール×）を受けたスポット群の平均 EV 差」で、判定は観測できる情報だけの関数なので不偏になる。
const fs = require('fs');
const path = require('path');
const [, , DIR, SEED = '1', HANDS = '200', OUT = 'out.jsonl', SAMPLE = '0.35', ROLL = '16'] = process.argv;
require(path.join(DIR, 'rng.js'));
require(path.join(DIR, 'game.js'));
const G = globalThis;
const { PokerGame, PokerEngine, PokerDeck, Rng, Card, Ranges, HandEvaluator, HandClassifier, Evaluator, Equity } = G;

// ---- 高速モード（ロールアウトの2回目以降）: 評価計算を飛ばし、あなた側の勝率計算を軽くする ----
let FAST = false;
const orig = {};
for (const k of ['evaluateFold', 'evaluateCall', 'evaluateBet', 'evaluateRaise', 'evaluateCheck', 'applyFirstIn']) {
  orig[k] = Evaluator[k];
  Evaluator[k] = function (...a) {
    if (FAST) return k === 'applyFirstIn' ? a[0] : { ev: 0, evaluation: '-', reason: '' };
    return orig[k].apply(this, a);
  };
}
let origPFEval = null;
if (G.PostflopEV) {
  const origPF = G.PostflopEV.evaluate;
  origPFEval = (...a) => origPF.apply(G.PostflopEV, a);
  G.PostflopEV.evaluate = function (...a) {
    if (FAST) return { evaluation: '-', reason: '', ev: 0, ev_loss: 0, loss_pct: 0, realized_eq: 0.5, best: { action: 'CHECK', amount: 0 }, options: [] };
    return origPF.apply(this, a);
  };
}
const origRA = Equity.calcRangeAdvantage;
Equity.calcRangeAdvantage = function (...a) { return FAST ? 0.5 : origRA.apply(this, a); };
const origMC = Equity.calcEquityMonteCarlo;
Equity.calcEquityMonteCarlo = function (h, b, hr, cr, target, pf, it, rng) {
  if (FAST && target === 'CPU') it = Math.min(it, 150);
  return origMC.call(this, h, b, hr, cr, target, pf, it, rng);
};

const hooks = { logAction() {}, newSessionId: () => 's', startSession() {}, finishHand() {} };
const seed = Number(SEED);
const game = new PokerGame({ rng: Rng.seeded(seed * 7919 + 13), hooks });
let p = (seed * 2654435761) >>> 0;
const rnd = () => { p = (p * 1664525 + 1013904223) >>> 0; return p / 4294967296; };

function cloneGame(src, rseed) {
  const e = src.engine;
  const c = Object.create(PokerEngine.prototype);
  Object.assign(c, e);
  c.rng = Rng.seeded(rseed);
  c.deck = Object.create(PokerDeck.prototype);
  c.deck.rng = c.rng;
  c.deck.cards = e.deck.cards.slice();
  c.rng.shuffle(c.deck.cards);
  c.board = e.board.slice();
  c.heroHand = e.heroHand.slice();
  c.cpuHand = e.cpuHand.slice();
  c.heroRange = new Map(e.heroRange);
  c.cpuRange = new Map(e.cpuRange);
  c.actionHistory = e.actionHistory.map((a) => ({ ...a }));
  const g = new PokerGame({ rng: c.rng, hooks });
  g.engine = c;
  return g;
}

const comboKey = (cards) => PokerEngine.comboKey(cards);
const rangeW = (pos, cat, c) => (Ranges.getRangeByCategory(pos, cat).get(c) || 0);

// 選べるアクション（画面のボタンと同じサイズ）
function legal(e) {
  const f = e.currentBet - e.heroInvested;
  const pot = e.potSize;
  const max = e.maxAdditionalBet('HERO');
  const out = [];
  const pre = e.street === 'PREFLOP';
  const voluntary = (pre && e.currentBet > 1.0) || (!pre && e.currentBet > 0);
  if (f > 0.01) out.push(['FOLD', 0]);
  out.push(f > 0.01 ? ['CALL', 0] : ['CHECK', 0]);
  let sizes;
  if (pre) sizes = voluntary ? (f <= 4 ? [f * 3.0] : [f * 2.5]) : [2.5];
  else if (voluntary) sizes = [f * 3.0];
  else sizes = ({ FLOP: [0.33, 0.55, 0.85], TURN: [0.33, 0.66, 1.0], RIVER: [0.33, 0.75, 1.5] })[e.street].map((x) => pot * x);
  const kind = voluntary ? 'RAISE' : 'BET';
  // プリフロップのファーストインは UI が BET を送る（SB のコール = リンプも CALL）
  if (max > f + 0.05) {
    const seen = new Set();
    for (let s of sizes) {
      s = Math.round(s * 10) / 10;
      if (s >= max - 0.05) s = max;
      if (seen.has(s)) continue;
      seen.add(s);
      out.push([kind, s]);
    }
  }
  return out;
}

// 続きの打ち方（あなた役）。表示勝率と必要勝率で素直に打つ
function contPolicy(e, st) {
  const f = e.currentBet - e.heroInvested;
  const c = comboKey(e.heroHand);
  const eq = st.equity / 100;
  const max = e.maxAdditionalBet('HERO');
  if (e.street === 'PREFLOP') {
    const raises = e.preflopRaiseCount;
    if (raises === 0) {
      if (rangeW(e.heroPosition, 'open', c) > 0.4) return ['BET', 2.5];
      return f > 0.01 ? ['FOLD', 0] : ['CHECK', 0];
    }
    if (raises === 1) {
      if (rangeW(e.heroPosition, 'vs_open_3bet', c) > 0.5 && max > f * 3) return ['RAISE', f * 3];
      if (rangeW(e.heroPosition, 'vs_open_call', c) > 0.2 || eq > 0.45) return ['CALL', 0];
      return f > 0.01 ? ['FOLD', 0] : ['CHECK', 0];
    }
    if (f <= 0.01) return ['CHECK', 0];
    return eq > 0.5 ? ['CALL', 0] : ['FOLD', 0];
  }
  const pot = e.potSize;
  if (f > 0.01) {
    const req = f / (pot + f);
    if (eq > 0.82 && max > f * 3) return ['RAISE', Math.min(max, f * 3)];
    return eq >= req ? ['CALL', 0] : ['FOLD', 0];
  }
  if (eq > 0.62 || (e.aggressor === 'HERO' && e.street === 'FLOP' && eq > 0.3)) return ['BET', Math.min(max, Math.round(pot * 0.66 * 10) / 10)];
  return ['CHECK', 0];
}

// 探索つき（本流のハンドを進める用）: 25% でランダムな合法手
function explorePolicy(e, st) {
  if (rnd() < 0.25) { const L = legal(e); return L[Math.floor(rnd() * L.length)]; }
  return contPolicy(e, st);
}

// ハンド終了時のあなたの収支（ハンド開始からの bb）
function heroNet(g, st) {
  const e = g.engine;
  const put = 100 - e.heroStack;
  const last = e.actionHistory[e.actionHistory.length - 1];
  if (last && last.action === 'FOLD') return last.actor === 'HERO' ? -put : e.potSize - put;
  if (e.board.length === 5 && e.cpuHand.length === 2) {
    const h = HandEvaluator.evaluate(e.board, e.heroHand), c = HandEvaluator.evaluate(e.board, e.cpuHand);
    return h < c ? e.potSize - put : h === c ? e.potSize / 2 - put : -put;
  }
  return NaN;
}

function playOut(g, first, wantEval) {
  FAST = !wantEval;
  let r = g.action({ action: first[0], amount: first[1] });
  const verdict = r.evaluation;
  const cpuResp = (r.cpuActions || [])[0] ? r.cpuActions[0].action : null;
  FAST = true;
  let st = r.state;
  let guard = 0;
  while (!st.finished && guard++ < 30) {
    const a = contPolicy(g.engine, st);
    r = g.action({ action: a[0], amount: a[1] });
    st = r.state;
  }
  FAST = false;
  return { net: heroNet(g, st), verdict, cpuResp };
}

// CPU の実際の手札に対するあなたの勝率（残りボードはランダム）
function trueEquity(e, n = 300) {
  if (e.cpuHand.length !== 2) return null;
  const dead = new Set(e.heroHand.concat(e.cpuHand, e.board));
  const deck = [];
  for (const r of Card.STR_RANKS) for (const s of 'shdc') { const c = Card.fromStr(r + s); if (!dead.has(c)) deck.push(c); }
  if (e.board.length === 5) {
    const h = HandEvaluator.evaluate(e.board, e.heroHand), c = HandEvaluator.evaluate(e.board, e.cpuHand);
    return h < c ? 1 : h === c ? 0.5 : 0;
  }
  let w = 0;
  for (let i = 0; i < n; i++) {
    const b = e.board.slice(); const d = deck.slice();
    while (b.length < 5) { const j = Math.floor(rnd() * d.length); b.push(d.splice(j, 1)[0]); }
    const h = HandEvaluator.evaluate(b, e.heroHand), c = HandEvaluator.evaluate(b, e.cpuHand);
    w += h < c ? 1 : h === c ? 0.5 : 0;
  }
  return w / n;
}

const out = fs.openSync(OUT, 'w');
const K = Number(ROLL);
let spotId = 0;
for (let h = 0; h < Number(HANDS); h++) {
  let st = game.startHand({});
  const e = game.engine;
  let guard = 0;
  while (!st.finished && guard++ < 30) {
    const focus = e.street !== 'PREFLOP' || (e.heroPosition === 'BB' && e.preflopRaiseCount === 1 && e.aggressor === 'CPU');
    if (rnd() < Number(SAMPLE) && (!process.env.FOCUS || focus)) {
      const f = e.currentBet - e.heroInvested;
      const feat = {
        id: `${seed}-${spotId++}`, street: e.street, heroPos: e.heroPosition, cpuPos: e.cpuPosition, ip: e.isHeroIp,
        raises: e.preflopRaiseCount, firstIn: e.isFirstIn, agg: e.aggressor, facing: +f.toFixed(2), pot: +e.potSize.toFixed(2),
        eff: +Math.min(e.heroStack, e.cpuStack).toFixed(2), hand: comboKey(e.heroHand),
        cat: HandClassifier.categorizeHand(e.heroHand, e.board),
        draw: e.board.length ? HandClassifier.detectDrawStrength(e.heroHand, e.board) : 'NONE',
        tex: e.board.length ? HandClassifier.classifyBoardTexture(e.board) : '',
        shown: st.equity / 100,
        lastCpu: (() => { const x = e.actionHistory.filter((a) => a.actor === 'CPU' && a.street === e.street).pop(); return x ? x.action : null; })(),
        cpuBetFrac: f > 0.01 ? +(f / Math.max(0.01, e.potSize - f)).toFixed(2) : 0,
      };
      // 生の計算勝率（実現率なし）
      FAST = false;
      feat.raw = origMC(e.heroHand, e.board, e.heroRange, e.cpuRange, 'CPU', e.street === 'PREFLOP', 600, rnd)[0];
      feat.truth = trueEquity(e);
      const acts = [];
      const base = Math.floor(rnd() * 1e9);
      for (const a of legal(e)) {
        const nets = [];
        let verdict = null, resp = {};
        for (let j = 0; j < K; j++) {
          const g = cloneGame(game, base + j);
          const res = playOut(g, a, j === 0);
          if (j === 0) verdict = res.verdict;
          if (res.cpuResp) resp[res.cpuResp] = (resp[res.cpuResp] || 0) + 1;
          nets.push(res.net);
        }
        const ok = nets.filter((x) => !Number.isNaN(x));
        acts.push({ a: a[0], amt: +a[1].toFixed(2), v: verdict, ev: ok.reduce((s, x) => s + x, 0) / ok.length, n: ok.length,
          sd: Math.sqrt(ok.reduce((s, x) => s + x * x, 0) / ok.length - (ok.reduce((s, x) => s + x, 0) / ok.length) ** 2), resp });
      }
      // モデルが予測した各アクションの EV（実現率の較正用）
      if (G.PostflopEV && e.street !== 'PREFLOP') {
        FAST = false;
        const pe = origPFEval(e, acts[0].a, acts[0].amt);
        for (const a of acts) {
          const o = pe.options.find((x) => x.action === a.a && Math.abs(x.amount - a.amt) < 0.06);
          if (o) a.pred = o.ev;
        }
        const RM = G.RangeModel;
        feat.eqModel = pe.realized_eq;
      }
      feat.acts = acts;
      fs.writeSync(out, JSON.stringify(feat) + '\n');
    }
    const a = explorePolicy(e, st);
    st = game.action({ action: a[0], amount: a[1] }).state;
  }
}
fs.closeSync(out);
