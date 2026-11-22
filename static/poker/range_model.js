// レンジ（相手の手札の確率分布）をコンボ単位で持ち、アクションごとにベイズ更新する（2026/11/17〜）。
//
// 考え方（Southey ほか "Bayes' Bluff: Opponent Modelling in Poker", UAI 2005 /
//         Billings ほか "Opponent Modeling in Poker", AAAI 1998 の重みテーブル）:
//   事後の重み(手札) ∝ 事前の重み(手札) × P(観測したアクション | 手札)
//   P(アクション | 手札) は ActionModel（このファイル）で計算する。CPU も同じモデルの確率で実際に行動するので、
//   「あなたから見た CPU のレンジ」と「CPU が実際に持っている手の分布」が一致する。
//   以前は「強さ順に並べて上位30%は残す・中間は0.15倍…」という固定の削り方で、手札ごとの行動確率を見ていなかった。
//
// 速度: 全1326コンボの役の強さを「ランアウト（残りのボード）ごと」に一度だけ計算してキャッシュする（RankTable）。
//   勝率ベクトル（レンジの各コンボが相手レンジに勝つ確率）は、その順位表に重みを流すだけで求まる。
//   リバーは1通り、ターンは残り全カード、フロップと プリフロップは局面から決まる固定の乱数でランアウトを選ぶ
//   （同じ局面なら毎回同じ値になる）。コンボ同士のカードの重なり（相手レンジ内の除外）は近似として無視する。
//
// 依存: hand_eval.js, ranges.js, hand_classifier.js, rng.js

(function (root) {
  if (typeof module !== 'undefined') {
    for (const m of ['hand_eval', 'ranges', 'hand_classifier', 'rng']) require('./' + m + '.js');
  }

  const N = 1326;
  const RUNOUTS = { 0: 60, 3: 80 };   // プリフロップ / フロップのランアウト数（ターン・リバーは全通り）
  const BAD = 0x7fffffff;

  // ---- コンボの番号付け ----
  let CARDS = null, CARD_IDX = null, COMBOS = null, KEY = null, KEY_IDX = null;
  function init() {
    if (COMBOS) return;
    const { Card } = root;
    CARDS = [];
    for (const r of Card.STR_RANKS) for (const s of 'shdc') CARDS.push(Card.fromStr(r + s));
    CARD_IDX = new Map(CARDS.map((c, i) => [c, i]));
    COMBOS = []; KEY = []; KEY_IDX = new Map();
    for (let i = 0; i < 52; i++) for (let j = i + 1; j < 52; j++) {
      const k = Card.toStr(CARDS[j]) + Card.toStr(CARDS[i]);   // ランクの高い方が先（STR_RANKS は昇順）
      KEY_IDX.set(k, COMBOS.length);
      KEY_IDX.set(Card.toStr(CARDS[i]) + Card.toStr(CARDS[j]), COMBOS.length);
      KEY.push(k);
      COMBOS.push([CARDS[i], CARDS[j]]);
    }
  }
  function comboIndex(cards) {
    init();
    const { Card } = root;
    return KEY_IDX.get(Card.toStr(cards[0]) + Card.toStr(cards[1]));
  }

  // Map（"AKs" / "77" / "AhKh" → 重み）⇄ Float64Array(1326)
  function toVec(rangeMap) {
    init();
    const v = new Float64Array(N);
    if (!rangeMap) return v;
    for (const [key, w] of rangeMap) {
      if (!(w > 0)) continue;
      for (const pair of root.Ranges.parseCombo(key)) {
        const i = KEY_IDX.get(pair[0] + pair[1]);
        if (i !== undefined) v[i] = w;
      }
    }
    return v;
  }
  function toMap(vec) {
    init();
    const m = new Map();
    for (let i = 0; i < N; i++) if (vec[i] > 0) m.set(KEY[i], vec[i]);
    return m;
  }
  // 画面表示用: 169種類のハンド名ごとの平均重み
  function toClassMap(vec) {
    init();
    const { Card } = root;
    const order = 'AKQJT98765432';
    const sum = new Map(), cnt = new Map();
    for (let i = 0; i < N; i++) {
      const [a, b] = COMBOS[i].map(Card.toStr);
      let x = a, y = b;
      if (order.indexOf(x[0]) > order.indexOf(y[0])) [x, y] = [y, x];
      const cls = x[0] === y[0] ? x[0] + y[0] : x[0] + y[0] + (x[1] === y[1] ? 's' : 'o');
      sum.set(cls, (sum.get(cls) || 0) + vec[i]);
      cnt.set(cls, (cnt.get(cls) || 0) + 1);
    }
    const out = new Map();
    for (const cls of root.Ranges.ALL_HANDS_DICT.keys()) {
      const v = (sum.get(cls) || 0) / (cnt.get(cls) || 1);
      if (v > 0) out.set(cls, Math.round(v * 1000) / 1000);
    }
    return out;
  }
  // 指定カードを含むコンボの重みを0にしたコピー
  function removeCards(vec, cards) {
    init();
    const out = Float64Array.from(vec);
    const dead = new Set(cards);
    for (let i = 0; i < N; i++) if (out[i] > 0 && (dead.has(COMBOS[i][0]) || dead.has(COMBOS[i][1]))) out[i] = 0;
    return out;
  }

  function hashCards(cards, salt) {
    let h = 2166136261 ^ salt;
    for (const c of cards) { h ^= c; h = Math.imul(h, 16777619) >>> 0; }
    return h >>> 0;
  }

  // ---- ランアウトごとの順位表 ----
  class RankTable {
    constructor(board) {
      init();
      const { HandEvaluator: HE } = root;
      this.board = board.slice();
      const dead = new Set(board);
      const deck = CARDS.filter((c) => !dead.has(c));
      let runouts;
      if (board.length === 5) runouts = [[]];
      else if (board.length === 4) runouts = deck.map((c) => [c]);
      else {
        const need = 5 - board.length;
        const rng = root.Rng.seeded(hashCards(board, board.length));
        runouts = [];
        for (let i = 0; i < RUNOUTS[board.length]; i++) runouts.push(rng.sample(deck, need));
      }
      this.runouts = runouts;
      this.ranks = [];   // Int32Array(N) per runout（BAD = ボード/ランアウトとカードが重なる）
      this.order = [];   // 弱い順のコンボ番号（BAD を除く）
      for (const extra of runouts) {
        const full = board.concat(extra);
        const used = new Set(full);
        const rk = new Int32Array(N);
        const idx = [];
        for (let i = 0; i < N; i++) {
          const [a, b] = COMBOS[i];
          if (used.has(a) || used.has(b)) { rk[i] = BAD; continue; }
          rk[i] = HE.evaluate(full, COMBOS[i]);
          idx.push(i);
        }
        idx.sort((p, q) => rk[q] - rk[p]);   // ランク値が大きい = 弱い
        this.ranks.push(rk);
        this.order.push(Int32Array.from(idx));
      }
      // 今のボードでの役の強さ（ドロー判定・表示用）
      this.nowRank = new Int32Array(N);
      if (board.length >= 3) {
        const used = new Set(board);
        for (let i = 0; i < N; i++) {
          const [a, b] = COMBOS[i];
          this.nowRank[i] = (used.has(a) || used.has(b)) ? BAD : HE.evaluate(board, COMBOS[i]);
        }
      }
      this._draw = null;
    }

    // 各コンボのドローの強さ（フロップ・ターンのみ）。必要になった時だけ計算
    draw(i) {
      if (this.board.length < 3 || this.board.length >= 5) return 'NONE';
      if (!this._draw) this._draw = new Array(N);
      if (this._draw[i] === undefined) this._draw[i] = root.HandClassifier.detectDrawStrength(COMBOS[i], this.board);
      return this._draw[i];
    }

    // vecA の各コンボが vecB（相手レンジ）に勝つ確率。vecA の重みが0のコンボは NaN
    equityVector(vecA, vecB) {
      const acc = new Float64Array(N), cnt = new Float64Array(N);
      for (let r = 0; r < this.ranks.length; r++) {
        const rk = this.ranks[r], order = this.order[r];
        let total = 0;
        for (let p = 0; p < order.length; p++) total += vecB[order[p]];
        if (total <= 0) continue;
        let below = 0;
        let p = 0;
        while (p < order.length) {
          let q = p, tie = 0;
          const v = rk[order[p]];
          while (q < order.length && rk[order[q]] === v) { tie += vecB[order[q]]; q++; }
          for (let s = p; s < q; s++) {
            const i = order[s];
            if (vecA[i] > 0) { acc[i] += (below + tie / 2) / total; cnt[i] += 1; }
          }
          below += tie;
          p = q;
        }
      }
      const out = new Float64Array(N);
      for (let i = 0; i < N; i++) out[i] = cnt[i] > 0 ? acc[i] / cnt[i] : NaN;
      return out;
    }

    // 特定の手札（あなたの手）が、相手の各コンボに勝つ確率（カードの重なりは正確に除外）
    handVsCombos(handIdx) {
      const out = new Float64Array(N).fill(NaN);
      const [h1, h2] = COMBOS[handIdx];
      const acc = new Float64Array(N), cnt = new Float64Array(N);
      for (let r = 0; r < this.ranks.length; r++) {
        const rk = this.ranks[r];
        const h = rk[handIdx];
        if (h === BAD) continue;
        for (let i = 0; i < N; i++) {
          const v = rk[i];
          if (v === BAD) continue;
          const [a, b] = COMBOS[i];
          if (a === h1 || a === h2 || b === h1 || b === h2) continue;
          acc[i] += h < v ? 1 : h === v ? 0.5 : 0;
          cnt[i] += 1;
        }
      }
      for (let i = 0; i < N; i++) if (cnt[i] > 0) out[i] = acc[i] / cnt[i];
      return out;
    }
  }

  const TABLE_CACHE = new Map();
  function tableFor(board) {
    const key = board.join(',');
    let t = TABLE_CACHE.get(key);
    if (!t) {
      if (TABLE_CACHE.size > 8) TABLE_CACHE.clear();
      t = new RankTable(board);
      TABLE_CACHE.set(key, t);
    }
    return t;
  }

  // ---- 行動モデル（CPU の思考と、レンジ推定の両方で使う）----
  // s: { street, e（相手レンジへの勝率）, draw, made, facing, pot, stack, wasAggressor, ip, opponentChecked, texture }
  // 戻り値: [{ action, amount, p }]（amount は追加で出す額）。確率の合計は1
  const sig = (x, w) => 1 / (1 + Math.exp(-x / w));
  const SOFT = 0.03;   // 閾値をなめらかにする幅（勝率の計算誤差で急に行動が変わらないように）

  const ActionModel = {
    // 調整用の係数（engine の検証で決めた値。CLAUDE.md の「CPU の実測」参照）
    P: {
      raiseValueThr: { FLOP: 0.75, TURN: 0.78, RIVER: 0.85 },
      raiseValueP: 0.6, semiBluffRaiseP: 0.3, riverBluffRaiseP: 0.04, riverBluffRaiseMaxE: 0.12,
      // ドンク（主導権の無い相手が先に打ってきた）への返し（2026/11/21〜）。理論では受けた側はバリュー・強いドロー・
      // 一部の弱い手でレイズを返す。以前はふつうのベットと同じ扱いで、フロップの小さいドンクにレイズ 3%・フォールド 24% だった
      vsDonkValueShift: 0.08, vsDonkValueP: 0.7, vsDonkDrawP: 0.5, vsDonkAirP: 0.12, vsDonkAirMaxE: 0.40,
      realizeIp: 0.92, realizeOop: 0.80, realizeAirMult: 0.80, drawNeedBonus: 0.04,
      looseCallP: 0.25, looseCallBand: 0.9,
      riverCallPenalty: 0.0,
      mdfShare: 0.9,   // 実際のプレイヤーは理論値（MDF）より少し多く降りる
      valueThr: { FLOP: 0.65, TURN: 0.68, RIVER: 0.70 },
      valueBetP: 0.85, donkValueBetP: 0.35,
    },

    sizeOrJam(amount, stack) { return amount >= stack * 0.6 ? stack : amount; },

    probs(s) {
      const P = ActionModel.P;
      const out = [];
      const isRiver = s.street === 'RIVER';
      const strongDraw = s.draw === 'STRONG_DRAW';
      if (s.facing > 0.01) {
        const eReq = s.facing / (s.pot + s.facing);
        const canRaise = s.stack > s.facing + 0.01;
        let pRaise = 0;
        if (canRaise) {
          const vThr = P.raiseValueThr[s.street];
          const isValue = sig(s.e - vThr, SOFT / 2);
          let other = 0;
          if (!isRiver && strongDraw) other = P.semiBluffRaiseP;
          else if (isRiver) other = P.riverBluffRaiseP * sig(P.riverBluffRaiseMaxE - s.e, SOFT / 2);
          pRaise = isValue * P.raiseValueP + (1 - isValue) * other;
          if (s.vsDonk && !isRiver) {
            // ドンクへの返し: バリューの基準を少し下げ、強いドローと一部の弱い手もレイズする
            const v2 = sig(s.e - (vThr - P.vsDonkValueShift), SOFT / 2);
            const o2 = strongDraw ? P.vsDonkDrawP : (s.e < P.vsDonkAirMaxE ? P.vsDonkAirP : 0);
            pRaise = v2 * P.vsDonkValueP + (1 - v2) * o2;
          }
        }
        let realize = 1.0;
        if (!isRiver) {
          realize = s.ip ? P.realizeIp : P.realizeOop;
          if (!s.made && !strongDraw) realize *= P.realizeAirMult;
        }
        const need = eReq - (!isRiver && strongDraw ? P.drawNeedBonus : 0) + (isRiver ? P.riverCallPenalty : 0);
        const eqReal = s.e * realize;
        // 防衛の下限: レンジの上位（MDF × mdfShare）の手は降りない。mdfE はその境目の勝率（posterior / CPU の思考で計算）。
        // これが無いと、相手のベットレンジをバリュー寄りに見積もったときに降りすぎる（Chen & Ankenman の MDF）
        const byPrice = sig(eqReal - need, SOFT / 2);
        const byMdf = s.mdfE === undefined ? 0 : sig(s.e - s.mdfE, SOFT / 2);
        const callFull = Math.max(byPrice, byMdf);
        const callLoose = sig(eqReal - need * P.looseCallBand, SOFT / 2) - callFull;
        const pCallCond = callFull + Math.max(0, callLoose) * P.looseCallP;
        const pCall = (1 - pRaise) * pCallCond;
        const raiseAmt = ActionModel.sizeOrJam(s.facing * 3.0, s.stack);
        if (pRaise > 0) out.push({ action: 'RAISE', amount: raiseAmt, p: pRaise });
        out.push({ action: 'CALL', amount: Math.min(s.facing, s.stack), p: pCall });
        out.push({ action: 'FOLD', amount: 0, p: Math.max(0, 1 - pRaise - pCall) });
        return out;
      }

      // 先に動く / チェックされた
      const st = s.street;
      const sizeFor = (strong) => {
        let size;
        if (st === 'FLOP') size = (s.wasAggressor && (s.texture === 'dry' || s.texture === 'paired')) ? 0.33 : 0.66;
        else if (st === 'TURN') size = 0.66;
        else size = strong ? 1.0 : 0.75;
        return ActionModel.sizeOrJam(Math.max(1.0, s.pot * size), s.stack);
      };
      const donkSpot = !s.wasAggressor && !s.ip && !s.opponentChecked;
      const isValue = sig(s.e - P.valueThr[st], SOFT);
      const pValueBet = isValue * (donkSpot ? P.donkValueBetP : P.valueBetP);

      let bluffP;
      if (donkSpot) bluffP = strongDraw ? 0.10 : 0.03;
      else if (s.wasAggressor) {
        if (st === 'FLOP') bluffP = s.e < 0.45 ? (strongDraw ? 0.65 : 0.45) : 0.35;
        else if (st === 'TURN') bluffP = strongDraw ? 0.55 : (s.e < 0.35 ? 0.25 : 0.15);
        else bluffP = s.e < 0.20 ? 0.40 : 0.0;
      } else {
        if (st === 'FLOP') bluffP = strongDraw ? 0.50 : (s.e < 0.45 ? 0.35 : 0.20);
        else if (st === 'TURN') bluffP = strongDraw ? 0.45 : (s.e < 0.35 ? 0.30 : 0.15);
        else bluffP = s.e < 0.20 ? 0.30 : 0.0;
      }
      const pOther = (1 - isValue) * bluffP;
      if (s.stack > 0.01) {
        if (st === 'RIVER') {
          // リバーのサイズは強さで変わる（とても強い手は 100%、それ以外は 75%）
          const veryStrong = sig(s.e - 0.85, SOFT);
          const big = sizeFor(true), normal = sizeFor(false);
          const pBet = pValueBet + pOther;
          const pBig = pValueBet * veryStrong;
          if (Math.abs(big - normal) < 0.01) out.push({ action: 'BET', amount: big, p: pBet });
          else {
            out.push({ action: 'BET', amount: big, p: pBig });
            out.push({ action: 'BET', amount: normal, p: pBet - pBig });
          }
        } else {
          out.push({ action: 'BET', amount: sizeFor(false), p: pValueBet + pOther });
        }
      }
      const pBetTotal = out.reduce((a, o) => a + o.p, 0);
      out.push({ action: 'CHECK', amount: 0, p: Math.max(0, 1 - pBetTotal) });
      return out;
    },

    // 観測したアクションの尤度。サイズはモデルの候補のうち近いものに合わせる（あなたのベットは任意のサイズなので、
    // 種類（ベット/レイズ）の合計確率に「大きいベットほど中くらいの手が減る」補正を掛ける）
    likelihood(dist, action, amount, s, sizeStrict) {
      const type = action === 'BET' || action === 'RAISE' ? 'AGG' : action;
      const same = dist.filter((o) => (type === 'AGG' ? (o.action === 'BET' || o.action === 'RAISE') : o.action === action));
      if (same.length === 0) return 0;
      if (type !== 'AGG') return same.reduce((a, o) => a + o.p, 0);
      if (sizeStrict) {
        let best = null;
        for (const o of same) if (!best || Math.abs(o.amount - amount) < Math.abs(best.amount - amount)) best = o;
        return best.p;
      }
      let p = same.reduce((a, o) => a + o.p, 0);
      const frac = amount / Math.max(0.01, s.pot);
      if (frac >= 0.6) p *= 1 - 0.5 * Math.exp(-((s.e - 0.52) ** 2) / (2 * 0.12 ** 2));   // 大きいベットは両極（中くらいの手を減らす）
      return p;
    },
  };

  // レンジ vec のうち、勝率の高い方から frac の割合に入る最後の手の勝率
  function quantileE(eq, vec, frac) {
    const idx = [];
    let total = 0;
    for (let i = 0; i < N; i++) if (vec[i] > 0 && !Number.isNaN(eq[i])) { idx.push(i); total += vec[i]; }
    if (!idx.length) return undefined;
    idx.sort((a, b) => eq[b] - eq[a]);
    let acc = 0;
    for (const i of idx) { acc += vec[i]; if (acc >= frac * total) return eq[i]; }
    return eq[idx[idx.length - 1]];
  }
  // ベットに直面した側の防衛の境目（MDF = ベット前のポット ÷ ベット後のポット）。
  // 防衛の下限は probs で sig(e − 境目) なので、その「なめらかに守る量」の合計がちょうど MDF × mdfShare になる境目を二分法で探す
  // （2026/11/22〜）。以前は分位点そのものを境目にしていたため、勝率がほぼ同じ手のかたまり（ボードをプレイする A ハイなど）が
  // 境目に来ると、サイズに関係なくかたまり全体が約5割守る計算になっていた（33% でも 150% でも降りる割合が同じ）
  function mdfEdge(eq, vec, ctx) {
    if (!(ctx.facing > 0.01)) return undefined;
    const mdf = Math.max(0, ctx.pot - ctx.facing) / Math.max(0.01, ctx.pot);
    const frac = mdf * ActionModel.P.mdfShare;
    const q = quantileE(eq, vec, frac);
    if (q === undefined) return undefined;
    const idx = [];
    let total = 0;
    for (let i = 0; i < N; i++) if (vec[i] > 0 && !Number.isNaN(eq[i])) { idx.push(i); total += vec[i]; }
    const target = frac * total;
    const defended = (x) => { let s = 0; for (const i of idx) s += vec[i] * sig(eq[i] - x, SOFT / 2); return s; };
    let lo = q - 0.3, hi = q + 0.3;   // defended は x について単調減少
    for (let k = 0; k < 40; k++) {
      const mid = (lo + hi) / 2;
      if (defended(mid) > target) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  const RangeModel = {
    N, init, quantileE, mdfEdge, comboIndex, toVec, toMap, toClassMap, removeCards, tableFor, RankTable, ActionModel,
    combos() { init(); return COMBOS; },
    keys() { init(); return KEY; },

    // vec のレンジがアクションを取ったあとの事後分布。ctx は stateFor が作る状況（e 以外）
    posterior(table, vec, oppVec, ctx, action, amount, sizeStrict = false) {
      const eq = table.equityVector(vec, oppVec);
      const mdfE = mdfEdge(eq, vec, ctx);
      const out = new Float64Array(N);
      let sum = 0;
      for (let i = 0; i < N; i++) {
        if (!(vec[i] > 0) || Number.isNaN(eq[i])) continue;
        const made = table.nowRank[i] !== BAD && table.nowRank[i] <= 6185;
        const s = { ...ctx, e: eq[i], made, draw: table.draw(i), mdfE };
        const l = ActionModel.likelihood(ActionModel.probs(s), action, amount, s, sizeStrict);
        out[i] = vec[i] * l;
        sum += out[i];
      }
      if (sum <= 0) return Float64Array.from(vec);   // モデルでは起こりえない行動: 更新しない
      // 正規化は最大値を1にする（既存の表示・サンプリングは相対重みしか使わない）
      let mx = 0;
      for (let i = 0; i < N; i++) if (out[i] > mx) mx = out[i];
      for (let i = 0; i < N; i++) out[i] /= mx;
      return out;
    },
  };

  root.RangeModel = RangeModel;
  if (typeof module !== 'undefined') module.exports = RangeModel;
})(typeof window !== 'undefined' ? window : globalThis);
