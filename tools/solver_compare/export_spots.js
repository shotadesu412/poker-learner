// Poker Rush の判定とソルバー（GTOpen）を比べるための局面を書き出す（2026/11/24〜）。
//   node tools/solver_compare/export_spots.js <static/poker のパス> <seed> <ハンド数> <出力.jsonl> [ストリート=RIVER]
//
// アプリのコードは変えない（読み込んで呼ぶだけ）。書き出すのは「そのストリートの最初の判断で、あなたが OOP（先に動く）」局面だけ。
// ソルバーはストリートの始まりから解くので、ここなら両者のレンジ・ポット・スタックが完全に一致する
// （途中のノードは、ソルバー内の均衡のレンジと Poker Rush の推定レンジがずれるため比べない。README 参照）。
//
// あなた役は tools/audit/spots.js と同じ「簡易ルール + 25% ランダム」。プリフロップはレンジ表どおりに参加するので、
// あなたの実際の手札があなたの推定レンジに入らない局面はほぼ出ない（出たら書き出さない）。
const fs = require('fs');
const path = require('path');
const [, , DIR, SEED = '1', HANDS = '200', OUT = 'spots.jsonl', STREET = 'RIVER'] = process.argv;
require(path.join(DIR, 'rng.js'));
require(path.join(DIR, 'game.js'));
const G = globalThis;
const { PokerGame, PokerEngine, Rng, Card, Ranges, PostflopEV, RangeModel, HandClassifier } = G;

const hooks = { logAction() {}, newSessionId: () => 's', startSession() {}, finishHand() {} };
const seed = Number(SEED);
const game = new PokerGame({ rng: Rng.seeded(seed * 7919 + 101), hooks });
let pr = (seed * 2654435761 + 7) >>> 0;
const rnd = () => { pr = (pr * 1664525 + 1013904223) >>> 0; return pr / 4294967296; };
const comboKey = (cards) => PokerEngine.comboKey(cards);
const rangeW = (pos, cat, c) => (Ranges.getRangeByCategory(pos, cat).get(c) || 0);
const cs = (cards) => cards.map(Card.toStr).join('');

// ---- あなた役（tools/audit/spots.js と同じ考え方） ----
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
function policy(e, st) {
  if (e.street !== 'PREFLOP' && rnd() < 0.25) { const L = legal(e); return L[Math.floor(rnd() * L.length)]; }
  return contPolicy(e, st);
}

// レンジ（Float64Array 1326）→ { "AhKh": 重み }（0 は省く）
function vecToObj(vec) {
  const m = RangeModel.toMap(vec);
  const o = {};
  for (const [k, w] of m) o[k] = w;
  return o;
}

// 判定の中で計算される「あなたがチェックしたら CPU が打ってくる確率」（checkFirstEv の pBet）を拾う（アプリのコードは変えない）
let lastPBet;
const origCF = PostflopEV.checkFirstEv;
PostflopEV.checkFirstEv = function (ctx) { const r = origCF.call(this, ctx); lastPBet = r.pBet; return r; };

// あなたがチェックした後に CPU が打ってくるときの、打ってくる手に対するあなたの勝率（サイズごと）。
// postflop_ev.js の checkFirstEv の前半と同じ計算（アプリのコードは変えずに、ここで同じ関数を呼んで再現する）
function stabProfile(e) {
  const RM = RangeModel;
  const table = RM.tableFor(e.board);
  const cpuVecPublic = RM.toVec(e.cpuRange);
  const cpuVec = RM.removeCards(cpuVecPublic, e.heroHand);
  const heroVec = RM.toVec(e.heroRange);
  const heroCtx = e._modelContext('HERO');
  const heroAfter = RM.posterior(table, heroVec, cpuVecPublic, heroCtx, 'CHECK', 0, false);
  const eCpu = table.equityVector(cpuVecPublic, heroAfter);
  const eHero = table.handVsCombos(RM.comboIndex(e.heroHand));
  const base = { street: e.street, facing: 0, pot: e.potSize, stack: e.cpuStack, ip: true, wasAggressor: e.aggressor === 'CPU', opponentChecked: true, texture: e.classifyBoardTexture(e.board) };
  let wSum = 0; const bets = new Map();
  for (let i = 0; i < RM.N; i++) {
    const w = cpuVec[i];
    if (!(w > 0) || Number.isNaN(eCpu[i]) || Number.isNaN(eHero[i])) continue;
    wSum += w;
    for (const o of RM.ActionModel.probs({ ...base, e: eCpu[i], made: table.nowRank[i] <= 6185, draw: table.draw(i) })) {
      if (o.action === 'CHECK' || !(o.p > 0)) continue;
      const k = Math.round(o.amount / e.potSize * 100);
      const g = bets.get(k) || { w: 0, e: 0 };
      g.w += w * o.p; g.e += w * o.p * eHero[i];
      bets.set(k, g);
    }
  }
  // 打たれたときのコール/チェックレイズの EV も、checkFirstEv と同じ計算で出す（ソルバーの同じノードと比べる）
  const heroMax = e.maxAdditionalBet('HERO');
  const pot = e.potSize;
  const res = [];
  for (const [k, g] of bets) {
    const b = Math.round(pot * k) / 100;
    const eqB = g.e / g.w;
    const Rc = PostflopEV.realization('call', e.street, false, e.heroHand, e.board, eqB);
    const callEv = Math.min(1, Rc * eqB) * (pot + 2 * b) - b;
    let raiseEv = null, raiseFold = null;
    const r = Math.min(heroMax, b * 3);
    if (r > b + 0.05) {
      const heroCtx2 = { ...heroCtx, facing: b, pot: pot + b, opponentChecked: false, oppRisk: b };
      const heroRaise = RM.posterior(table, heroAfter, cpuVecPublic, heroCtx2, 'RAISE', r, false);
      const eCpu2 = table.equityVector(cpuVecPublic, heroRaise);
      const s2 = { street: e.street, facing: r - b, pot: pot + b + r, stack: Math.max(0, e.cpuStack - b), ip: true, wasAggressor: true, opponentChecked: false, texture: base.texture, oppRisk: r };
      // この額で打ってくるコンボ（重み）
      const betVec = new Float64Array(RM.N);
      for (let i = 0; i < RM.N; i++) {
        const w = cpuVec[i];
        if (!(w > 0) || Number.isNaN(eCpu[i]) || Number.isNaN(eHero[i])) continue;
        for (const o of RM.ActionModel.probs({ ...base, e: eCpu[i], made: table.nowRank[i] <= 6185, draw: table.draw(i) })) {
          if (o.action !== 'CHECK' && Math.round(o.amount / pot * 100) === k) betVec[i] += w * o.p;
        }
      }
      const hs2 = table.strength();
      s2.mdfE = RM.mdfEdge(hs2, betVec, s2);
      const Ra = PostflopEV.realization('aggressor', e.street, false, e.heroHand, e.board);
      let acc = 0, wsum = 0, fsum = 0;
      for (let i = 0; i < RM.N; i++) {
        const w = betVec[i];
        if (!(w > 0) || Number.isNaN(eCpu2[i])) continue;
        const d = RM.ActionModel.probs({ ...s2, e: eCpu2[i], made: table.nowRank[i] <= 6185, draw: table.draw(i), hs: hs2[i] });
        let pf = 0;
        for (const o of d) if (o.action === 'FOLD') pf += o.p;
        acc += w * (pf * (pot + b) + (1 - pf) * (Math.min(1, Ra * eHero[i]) * (pot + 2 * r) - r));
        wsum += w; fsum += w * pf;
      }
      raiseEv = wsum > 0 ? acc / wsum : null;
      raiseFold = wsum > 0 ? fsum / wsum : null;
    }
    res.push({ pct: k, amount: b, freq: g.w / wSum, heroEq: eqB, callEv, raiseEv, raiseTo: r, raiseFold });
  }
  return res;
}

// CPU の打ち方の校正用（CALIB=1 のときだけ書き出す）: あなたがチェックした後の、CPU のレンジの各コンボの
//   [コンボ, 重み, 手の強さ, チェック, 各サイズで打つ確率..., 各サイズで打った後にあなたの3倍のチェックレイズへ降りる確率...]
// ソルバーの同じノード（solve_calib.js）と、手の強さの順位ごとに比べる（calib_analyze.js）
let KEYS = null;
function cpuProfile(e) {
  const RM = RangeModel;
  if (!KEYS) KEYS = [...RM.toMap(new Float64Array(RM.N).fill(1)).keys()];
  const table = RM.tableFor(e.board);
  const cpuVecPublic = RM.toVec(e.cpuRange);
  const cpuVec = RM.removeCards(cpuVecPublic, e.heroHand);
  const heroVec = RM.toVec(e.heroRange);
  const heroCtx = e._modelContext('HERO');
  const heroAfter = RM.posterior(table, heroVec, cpuVecPublic, heroCtx, 'CHECK', 0, false);
  const eCpu = table.equityVector(cpuVecPublic, heroAfter);
  const hs = table.strength();
  const pot = e.potSize;
  const base = { street: e.street, facing: 0, pot, stack: e.cpuStack, ip: true, wasAggressor: e.aggressor === 'CPU', opponentChecked: true, texture: e.classifyBoardTexture(e.board) };
  const rows = [], sizes = new Set();
  for (let i = 0; i < RM.N; i++) {
    if (!(cpuVec[i] > 0) || Number.isNaN(eCpu[i])) continue;
    const d = RM.ActionModel.probs({ ...base, e: eCpu[i], made: table.nowRank[i] <= 6185, draw: table.draw(i) });
    const bySize = {};
    let pc = 0;
    for (const o of d) {
      if (o.action === 'CHECK') { pc += o.p; continue; }
      const k = Math.round(o.amount / pot * 100);
      bySize[k] = (bySize[k] || 0) + o.p; sizes.add(k);
    }
    rows.push({ i, w: cpuVec[i], hs: hs[i], pc, bySize });
  }
  const sz = [...sizes].sort((a, b) => a - b);
  const heroMax = e.maxAdditionalBet('HERO');
  const foldBy = {};
  for (const k of sz) {
    const b = Math.round(pot * k) / 100;
    const r = Math.min(heroMax, b * 3);
    foldBy[k] = new Map();
    if (!(r > b + 0.05)) continue;
    const heroCtx2 = { ...heroCtx, facing: b, pot: pot + b, opponentChecked: false, oppRisk: b };
    const heroRaise = RM.posterior(table, heroAfter, cpuVecPublic, heroCtx2, 'RAISE', r, false);
    const eCpu2 = table.equityVector(cpuVecPublic, heroRaise);
    const s2 = { street: e.street, facing: r - b, pot: pot + b + r, stack: Math.max(0, e.cpuStack - b), ip: true, wasAggressor: true, opponentChecked: false, texture: base.texture, oppRisk: r };
    const betVec = new Float64Array(RM.N);
    for (const x of rows) betVec[x.i] = x.w * (x.bySize[k] || 0);
    s2.mdfE = RM.mdfEdge(hs, betVec, s2);
    for (const x of rows) {
      if (!(x.bySize[k] > 0) || Number.isNaN(eCpu2[x.i])) continue;
      let pf = 0;
      for (const o of RM.ActionModel.probs({ ...s2, e: eCpu2[x.i], made: table.nowRank[x.i] <= 6185, draw: table.draw(x.i), hs: hs[x.i] })) if (o.action === 'FOLD') pf += o.p;
      foldBy[k].set(x.i, pf);
    }
  }
  const r4 = (v) => Math.round(v * 10000) / 10000;
  return {
    sizes: sz,
    combos: rows.map((x) => [KEYS[x.i], r4(x.w), r4(x.hs), r4(x.pc), ...sz.map((k) => r4(x.bySize[k] || 0)), ...sz.map((k) => (foldBy[k].has(x.i) ? r4(foldBy[k].get(x.i)) : null))]),
  };
}

const out = fs.createWriteStream(OUT);
let written = 0, skippedNotInRange = 0;
for (let h = 0; h < Number(HANDS); h++) {
  let st = game.startHand({});
  for (let i = 0; i < 40 && !st.finished; i++) {
    const e = game.engine;
    // 書き出す局面: 指定ストリートの最初の判断（まだ誰も動いていない）で、あなたが OOP
    const first = e.street === STREET && !e.isHeroIp && !e.actionHistory.some((a) => a.street === e.street);
    if (first && e.currentBet - e.heroInvested <= 0.01) {
      const heroVec = RangeModel.toVec(e.heroRange);
      const cpuVec = RangeModel.toVec(e.cpuRange);
      const hi = RangeModel.comboIndex(e.heroHand);
      // あなたの手札が推定レンジに無い（行動モデル上ほぼ取らない打ち方をした）局面は、手札をごく小さい重みで足す。
      // 相手の均衡はほぼ変わらず、その手札の各アクションの EV は重みに関係なく決まる。集計では injected で分けて見る
      const injected = !(heroVec[hi] > 0);
      if (injected) { skippedNotInRange++; let mx = 0; for (const w of heroVec) mx = Math.max(mx, w); heroVec[hi] = mx * 1e-3; }
      {
        const opts = PostflopEV.options(e).map(([a, x]) => {
          const r = PostflopEV.evaluate(e, a, x);
          return { action: a, amount: x, grade: r.evaluation };
        });
        lastPBet = undefined;
        const r0 = PostflopEV.evaluate(e, opts[0].action, opts[0].amount);
        const cpuStabModel = lastPBet;
        const evs = r0.options;   // [{action, amount, ev}]（同じ局面なので1回の評価で全選択肢の EV が出る）
        const table = RangeModel.tableFor(e.board);
        const ctx = { table, heroVec, cpuVec: RangeModel.removeCards(cpuVec, e.heroHand) };
        const facts = PostflopEV.rangeFacts(ctx);
        out.write(JSON.stringify({
          id: `${seed}-${h}-${e.street}`,
          street: e.street, board: cs(e.board), hero: cs(e.heroHand),
          heroPos: e.heroPosition, cpuPos: e.cpuPosition, cpuHand: cs(e.cpuHand),
          pot: Math.round(e.potSize * 1000) / 1000,
          stack: Math.round(Math.min(e.heroStack, e.cpuStack) * 1000) / 1000,
          prevAggressor: e.aggressor, threeBetPot: e.preflopRaiseCount >= 2,
          category: HandClassifier.categorizeHand(e.heroHand, e.board), injected,
          draw: HandClassifier.detectDrawStrength(e.heroHand, e.board),
          eq: r0.realized_eq, facts, cpuStabModel, stabModel: stabProfile(e),
          pr: { best: r0.best, options: opts.map((o) => ({ ...o, ev: (evs.find((x) => x.action === o.action && Math.abs(x.amount - o.amount) < 0.06) || {}).ev })) },
          heroRange: vecToObj(heroVec), cpuRange: vecToObj(cpuVec),
          ...(process.env.CALIB ? { calib: cpuProfile(e) } : {}),
        }) + '\n');
        written++;
      }
    }
    const a = policy(e, st);
    st = game.action({ action: a[0], amount: a[1] }).state;
  }
}
out.end();
console.error(`seed ${seed}: ${written} spots (${skippedNotInRange} with the hero hand injected into the hero range)`);
