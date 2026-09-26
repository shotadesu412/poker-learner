// 評価ロジック（poker_engine.py の Evaluator の JS 移植）。◎◯△× と解説文を返す。
//
// ⚠️ 移植方針: 今の Python の挙動をそのまま再現する。改善は移植が終わってから。
//   - 浮動小数点の計算順序も Python と同じにしてある（結果をビット単位で一致させるため）。
//     式を整理・簡約しないこと
//   - Python の Evaluator には calculate_mdf / calculate_alpha が2回定義されており、
//     後の定義（max(pot, 1e-9) 付き）が有効になっている。こちらもそれに合わせている
//   - 閾値や係数には文献と照合して調整してきた経緯がある。変えるときは git log を確認すること
//
// 依存: hand_eval.js, ranges.js, messages.js, pyfmt.js, ev_calculator.js,
//       hand_classifier.js, bet_sizing.js, equity.js

(function (root) {
  if (typeof module !== 'undefined') {
    for (const m of ['hand_eval', 'pyfmt', 'messages', 'ranges', 'range_utils', 'equity',
      'ev_calculator', 'hand_classifier', 'bet_sizing']) require('./' + m + '.js');
  }

  const t = (k, kw) => root.Messages.t(k, kw);
  const IP_POSITIONS = ['BTN', 'CO', 'HJ'];  // 大まかな IP 判定（Python と同じ）
  const hasCards = (x) => Array.isArray(x) && x.length > 0;       // Python の `if cards:`
  const hasRange = (m) => m instanceof Map && m.size > 0;         // Python の `if range_dict:`
  // Python の dict.get(key, default): キーが「存在しない」ときだけ default（空でも default にしない）
  const getOr = (m, key, dflt) => (m && m.has(key) ? m.get(key) : dflt);

  const Evaluator = {
    CALL_IMPLIED_ODDS_THRESHOLD: 0.9,
    CALL_OPTIMAL_THRESHOLD: 1.2,
    CALL_MARGINAL_THRESHOLD: 0.8,
    BET_OPTIMAL_MARGIN_PCT: 0.05,
    FOLD_OPTIMAL_THRESHOLD: 1.2,
    // 「コールされたときのエクイティ」に対する基準（理由は poker_engine.py のコメント参照）
    BET_VALUE_THRESHOLD: 0.60,
    BET_THIN_VALUE_THRESHOLD: 0.52,
    BET_BLUFF_MAX_EQUITY: 0.33,

    // 実現エクイティ。EQR の影響を (1 - equity) で重み付けし 100% を超えないようにする
    realizeEquity(equity, eqr) {
      const adjusted = equity * (1.0 + (eqr - 1.0) * (1.0 - equity));
      return Math.max(0.02, Math.min(0.99, adjusted));
    },

    // FE = clamp(0.40 + 0.30 * bet/pot, 0.35, 0.65) をテクスチャで微調整
    estimateFoldEquity(potSize, betAmount, texture = null) {
      const pot = Math.max(potSize, 1e-9);
      const ratio = betAmount / pot;
      let fe = 0.40 + 0.30 * ratio;
      fe = Math.max(0.35, Math.min(0.65, fe));
      if (texture === 'dry' || texture === 'paired') fe += 0.05;
      else if (texture === 'wet' || texture === 'monotone') fe -= 0.05;
      return Math.max(0.30, Math.min(0.70, fe));
    },

    calculateRequiredEquity(callAmount, potSize) {
      return root.EVCalculator.calculateRequiredEquity(callAmount, potSize);
    },
    evCall(equity, potSize, callAmount, spr = null, handCategory = null, isIp = true) {
      return root.EVCalculator.evCall(equity, potSize, callAmount, spr, handCategory, isIp);
    },
    evCheck(equity, potSize) { return root.EVCalculator.evCheck(equity, potSize); },
    evBet(equity, potSize, betAmount, foldEquity, villainRaiseFreq = 0.1) {
      return root.EVCalculator.evBet(equity, potSize, betAmount, foldEquity, villainRaiseFreq);
    },
    calculateTheoreticalBluffFrequency(betSize, pot) {
      return root.EVCalculator.calculateTheoreticalBluffFrequency(betSize, pot);
    },
    detectDrawStrength(cards, board) { return root.HandClassifier.detectDrawStrength(cards, board); },
    categorizeHand(cards, board = null) { return root.HandClassifier.categorizeHand(cards, board); },

    // プレイアビリティ補正。ポストフロップは中立(1.0)
    calculatePi(cards, board = null) {
      const { Card } = root;
      if (!cards || cards.length < 2) return 1.0;
      if (board && board.length >= 3) return 1.0;
      const r1 = Card.getRankInt(cards[0]), r2 = Card.getRankInt(cards[1]);
      const s1 = Card.getSuitInt(cards[0]), s2 = Card.getSuitInt(cards[1]);
      let pi = 1.0;
      if (s1 === s2) pi += 0.06;
      if (r1 !== r2 && Math.abs(r1 - r2) <= 1) pi += 0.04;
      if (r1 === r2) pi += 0.06;
      return pi;
    },

    // EQR（エクイティ実現率）。加算合成 + SPR レバレッジ + ストリート別の上下限
    getEqrModifier(heroPos, cards = null, is3betPot = false, board = null, rangeAdv = 0.5, spr = 10.0, street = null) {
      let baseEqr = 1.0;
      const category = Evaluator.categorizeHand(cards, board);
      const isIp = IP_POSITIONS.includes(heroPos);

      baseEqr += isIp ? 0.10 : -0.10;

      if (category === 'STRONG_DRAW') baseEqr += 0.07;
      else if (category === 'MEDIUM_DRAW') baseEqr += 0.03;
      else if (category === 'NUT_HAND' || category === 'STRONG_MADE') baseEqr += 0.05;
      else if (category === 'AIR' || category === 'WEAK_MADE' || category === 'WEAK_DRAW') baseEqr -= 0.05;

      if (is3betPot && ['MEDIUM_MADE', 'WEAK_MADE', 'WEAK_DRAW', 'AIR'].includes(category)) baseEqr -= 0.05;

      const isMade = ['NUT_HAND', 'STRONG_MADE', 'MEDIUM_MADE', 'WEAK_MADE'].includes(category);
      if (hasCards(board)) {
        const texture = root.HandClassifier.classifyBoardTexture(board);
        let nutAdv;
        if (texture === 'dry' || texture === 'paired') {
          if (isMade) baseEqr += 0.05;
          nutAdv = isIp ? 0.2 : -0.1;
        } else if (texture === 'wet') {
          if (category === 'MEDIUM_MADE' || category === 'WEAK_MADE') baseEqr -= 0.08;
          else if (category === 'AIR') baseEqr -= 0.04;
          nutAdv = isIp ? -0.2 : 0.2;
        } else if (texture === 'monotone') {
          if (category === 'MEDIUM_MADE' || category === 'WEAK_MADE') baseEqr -= 0.10;
          else if (category === 'AIR') baseEqr -= 0.06;
          nutAdv = isIp ? -0.3 : 0.2;
        } else {
          nutAdv = 0.0;
        }
        baseEqr += nutAdv * 0.15;
      }

      baseEqr += (rangeAdv - 0.5) * 0.2;
      baseEqr += Evaluator.calculatePi(cards, board) - 1.0;

      let leverage;
      if (spr < 1.0) leverage = 0.3;
      else if (spr < 3.0) leverage = 0.6;
      else if (spr <= 6.0) leverage = 1.0;
      else leverage = 1.3;
      const finalEqr = 1.0 + (baseEqr - 1.0) * leverage;

      const isDraw = ['STRONG_DRAW', 'MEDIUM_DRAW', 'WEAK_DRAW'].includes(category);
      let lo, hi;
      if (street === 'RIVER') { lo = 0.50; hi = 1.0; }
      else if (street === 'TURN') { lo = 0.55; hi = isDraw ? 1.08 : 1.15; }
      else if (street === 'FLOP') { lo = 0.60; hi = isDraw ? 1.10 : 1.20; }
      else { lo = 0.65; hi = isDraw ? 1.12 : 1.25; }
      return Math.max(lo, Math.min(hi, finalEqr));
    },

    // Python では後から定義された方が有効（こちら）
    calculateAlpha(betAmount, potSize) {
      return betAmount / (potSize + betAmount);
    },
    // pot_size は「相手がベットする前」のポット
    calculateMdf(betAmount, potSize) {
      const potBefore = Math.max(potSize, 1e-9);
      return potBefore / (potBefore + betAmount);
    },

    getComboStr(cards, rangeMap = null) {
      const { Card } = root;
      if (!cards || cards.length !== 2) return '';
      const r1 = Card.getRankInt(cards[0]), r2 = Card.getRankInt(cards[1]);
      const s1 = Card.getSuitInt(cards[0]), s2 = Card.getSuitInt(cards[1]);
      const ranks = '23456789TJQKA';
      const suitMap = { 1: 's', 2: 'h', 4: 'd', 8: 'c' };
      const c1 = ranks[r1] + (suitMap[s1] || ''), c2 = ranks[r2] + (suitMap[s2] || '');
      if (hasRange(rangeMap)) {
        if (rangeMap.has(c1 + c2)) return c1 + c2;
        if (rangeMap.has(c2 + c1)) return c2 + c1;
      }
      let ch1 = ranks[r1], ch2 = ranks[r2];
      if (r1 === r2) return ch1 + ch2;
      if (r1 < r2) [ch1, ch2] = [ch2, ch1];
      return ch1 + ch2 + (s1 === s2 ? 's' : 'o');
    },

    // 戻り値: [decision('play'|'mix'|'fold'), 評価記号, 解説文]
    evaluatePreflopActionGto(cards, actionTaken, heroPos, is3betPot, facingBet) {
      const { Ranges, BetSizing: B } = root;
      const posRanges = Ranges.RANGES.get(heroPos) || new Map();
      const empty = new Map();
      let callRange, raiseRange, foldMsg;
      if (facingBet === 0) {
        callRange = getOr(posRanges, 'open', empty);
        raiseRange = getOr(posRanges, 'open', empty);
        foldMsg = t('preflop.foldmsg.open');
      } else if (!is3betPot) {
        // BB のコールレンジを相手の位置で変えるデータは無いので共通の vs_open_call を使う
        callRange = getOr(posRanges, 'vs_open_call', empty);
        raiseRange = getOr(posRanges, 'vs_open_3bet', getOr(posRanges, '3bet', empty));
        foldMsg = t('preflop.foldmsg.vs_open');
      } else {
        callRange = getOr(posRanges, 'vs_3bet_call', empty);
        raiseRange = getOr(posRanges, 'vs_3bet_4bet', getOr(posRanges, '4bet_bluff', empty));
        foldMsg = t('preflop.foldmsg.vs_3bet');
      }

      const comboStr = Evaluator.getComboStr(cards, Ranges.ALL_HANDS_DICT);
      const reason = Ranges.getHandReason(comboStr);
      const callWeight = getOr(callRange, comboStr, 0.0);
      const raiseWeight = getOr(raiseRange, comboStr, 0.0);

      if (actionTaken === 'CALL') {
        if (callWeight > 0) return ['play', B.EVAL_GOOD, t('preflop.call.good', { reason })];
        if (raiseWeight > 0) return ['fold', B.EVAL_BAD, t('preflop.call.should_raise', { reason })];
        return ['fold', B.EVAL_BAD, t('preflop.call.out_of_range', { fold_msg: foldMsg, reason })];
      }
      if (actionTaken === 'RAISE') {
        if (raiseWeight > 0) return ['play', B.EVAL_OPTIMAL, t('preflop.raise.optimal', { reason })];
        if (callWeight > 0) return ['mix', B.EVAL_MARGINAL, t('preflop.raise.should_call', { reason })];
        return ['fold', B.EVAL_BAD, t('preflop.raise.out_of_range', { fold_msg: foldMsg, reason })];
      }
      if (actionTaken === 'FOLD') {
        if (raiseWeight > 0.5) return ['mix', B.EVAL_BAD, t('preflop.fold.too_strong', { reason })];
        if (callWeight > 0.5) return ['mix', B.EVAL_BAD, t('preflop.fold.callable', { reason })];
        if (raiseWeight > 0 || callWeight > 0) return ['play', B.EVAL_MARGINAL, t('preflop.fold.slightly_tight', { reason })];
        return ['play', B.EVAL_OPTIMAL, t('preflop.fold.optimal', { fold_msg: foldMsg })];
      }
      return ['play', B.EVAL_GOOD, reason];
    },

    evaluateCall(equity, callAmount, potSize, heroPos = 'BTN', cards = null, is3betPot = false, board = null,
                 effectiveStack = 0.0, rangeAdv = 0.5, heroRange = null, street = null) {
      const B = root.BetSizing;
      if (callAmount === 0) {
        return { ev: 0.0, req_eq: 0.0, realized_eq: equity, evaluation: B.EVAL_OPTIMAL, reason: t('call.free_check') };
      }
      let preflopPrefix = '';
      if (!hasCards(board)) {
        const [decision, eEval, eReason] = Evaluator.evaluatePreflopActionGto(cards, 'CALL', heroPos, is3betPot, callAmount);
        preflopPrefix = eReason + '\n';
        if (decision === 'fold' || decision === 'mix') {
          return { ev: 0.0, req_eq: 0.0, realized_eq: equity, evaluation: eEval, reason: preflopPrefix };
        }
      }

      const eReq = Evaluator.calculateRequiredEquity(callAmount, potSize);
      let spr = null;
      if (effectiveStack > 0 && potSize > 0) spr = effectiveStack / potSize;

      const eqr = Evaluator.getEqrModifier(heroPos, cards, is3betPot, board, rangeAdv, spr !== null ? spr : 10.0, street);
      const realized = Evaluator.realizeEquity(equity, eqr);
      const category = Evaluator.categorizeHand(cards, board);
      const isIp = IP_POSITIONS.includes(heroPos);
      const evCallVal = Evaluator.evCall(realized, potSize, callAmount, spr, category, isIp);

      let evaluation, reason = preflopPrefix;
      const eq = realized * 100;
      if (realized >= eReq * Evaluator.CALL_OPTIMAL_THRESHOLD) {
        evaluation = B.EVAL_OPTIMAL; reason += t('call.optimal', { eq });
      } else if (realized >= eReq) {
        evaluation = B.EVAL_GOOD; reason += t('call.good', { eq });
      } else if (realized >= eReq * Evaluator.CALL_MARGINAL_THRESHOLD) {
        if (evCallVal > 0) { evaluation = B.EVAL_GOOD; reason += t('call.implied_good', { eq }); }
        else { evaluation = B.EVAL_MARGINAL; reason += t('call.marginal', { eq }); }
      } else if (evCallVal > 0) {
        evaluation = B.EVAL_MARGINAL; reason += t('call.implied_marginal', { eq });
      } else {
        evaluation = B.EVAL_BAD; reason += t('call.bad');
      }
      return { ev: evCallVal, req_eq: eReq, realized_eq: realized, evaluation, reason };
    },

    evaluateFold(equity, opponentBetSize, potSize, heroPos = 'BTN', cards = null, is3betPot = false, board = null,
                 rangeAdv = 0.5, effectiveStack = 0.0, street = null) {
      const B = root.BetSizing;
      if (opponentBetSize === 0) {
        return { ev: 0.0, req_eq: 0.0, realized_eq: equity, evaluation: B.EVAL_BAD, reason: t('fold.no_bet') };
      }
      if (!hasCards(board)) {
        const [decision, eEval, eReason] = Evaluator.evaluatePreflopActionGto(cards, 'FOLD', heroPos, is3betPot, opponentBetSize);
        if (decision === 'mix') {
          return { ev: 0.0, req_eq: 0.0, realized_eq: equity, evaluation: eEval, reason: eReason };
        }
        if (decision === 'play' && eEval === B.EVAL_OPTIMAL) {
          return { ev: 0.0, req_eq: 0.0, realized_eq: equity, evaluation: B.EVAL_OPTIMAL, reason: eReason };
        }
      }

      const eReq = Evaluator.calculateRequiredEquity(opponentBetSize, potSize);
      // pot_size は相手のベット込みなので、MDF にはベット前のポットを渡す
      const mdf = Evaluator.calculateMdf(opponentBetSize, potSize - opponentBetSize);
      const foldSpr = (effectiveStack > 0 && potSize > 0) ? (effectiveStack / potSize) : 10.0;
      const eqr = Evaluator.getEqrModifier(heroPos, cards, is3betPot, board, rangeAdv, foldSpr, street);
      const realized = Evaluator.realizeEquity(equity, eqr);

      // × は「明確なバリューハンドを捨てた」場合だけ。オッズ近辺は無差別（ブラフキャッチャー）
      let evaluation, reason;
      const kw = { eq: realized * 100, req: eReq * 100 };
      if (realized >= eReq * 1.5) { evaluation = B.EVAL_BAD; reason = t('fold.clear_loss', kw); }
      else if (realized >= eReq * 1.15) { evaluation = B.EVAL_MARGINAL; reason = t('fold.tight', kw); }
      else if (realized >= eReq * 0.85) { evaluation = B.EVAL_GOOD; reason = t('fold.bluffcatcher', kw); }
      else { evaluation = B.EVAL_OPTIMAL; reason = t('fold.optimal', kw); }

      return { ev: 0.0, req_eq: eReq, mdf: root.Py.round(mdf, 3), realized_eq: realized, evaluation, reason };
    },

    // ベットしてコールされた場合の、その継続レンジ相手のエクイティ。レンジ情報が無ければ null
    // rng はテスト用（シード付き乱数を渡せるように）。Python 版には無い引数
    equityVsCallingRange(cards, board, heroRange, cpuRange, betAmount, potSize, iterations = 1000, rng = Math.random) {
      if (!hasCards(cards) || !hasCards(board) || !hasRange(heroRange) || !hasRange(cpuRange)) return null;
      try {
        const calling = root.Ranges.updateRangeAfterAction(new Map(cpuRange), 'CALL', betAmount, board);
        let sum = 0;
        for (const w of calling.values()) sum += w;
        if (calling.size === 0 || sum <= 0) return null;
        const [eq] = root.Equity.calcEquityMonteCarlo(cards, board, heroRange, calling, 'CPU', false, iterations, rng);
        return eq;
      } catch (e) {
        return null;  // エクイティ計算の失敗で評価全体を落とさない
      }
    },

    evaluateBet(equity, betAmount, potSize, heroPos = 'BTN', cards = null, board = null, rangeAdv = 0.5,
                effectiveStack = 0.0, street = null, heroRange = null, cpuRange = null, isDonk = false) {
      const { BetSizing: B, HandClassifier: HC } = root;
      let marginPct;
      if (street === 'RIVER') marginPct = 0.15;
      else if (street === 'TURN') marginPct = 0.10;
      else marginPct = Evaluator.BET_OPTIMAL_MARGIN_PCT;

      let spr = null;
      if (effectiveStack > 0 && potSize > 0) spr = effectiveStack / potSize;
      const eqr = Evaluator.getEqrModifier(heroPos, cards, false, board, rangeAdv, spr !== null ? spr : 10.0, street);
      const realized = Evaluator.realizeEquity(equity, eqr);

      let texture = 'dry';
      if (board && board.length >= 3) texture = HC.classifyBoardTexture(board);
      const foldEquity = Evaluator.estimateFoldEquity(potSize, betAmount, texture);
      const evBetting = Evaluator.evBet(realized, potSize, betAmount, foldEquity);
      const evChecking = Evaluator.evCheck(realized, potSize);

      let sizingFeedback = '';
      if (board && board.length >= 3) {
        const sizing = B.evaluateBetSizing(potSize, betAmount, texture, spr);
        if (sizing.evaluation === '△' || sizing.evaluation === '×') {
          sizingFeedback = t('bet.sizing_prefix', { reason: sizing.reason });
        }
      }

      // 「ベットしてコールされたとき勝っているか」を軸にする（バリューベットの定義）
      const eqCalled = Evaluator.equityVsCallingRange(cards, board, heroRange, cpuRange, betAmount, potSize);
      const draw = (hasCards(cards) && hasCards(board)) ? HC.detectDrawStrength(cards, board) : 'NONE';

      let evaluation, reason;
      if (eqCalled === null) {
        // レンジ情報が無い（プリフロップ等）: 従来どおり EV 比較
        if (evBetting > evChecking + (marginPct * potSize)) { evaluation = B.EVAL_OPTIMAL; reason = t('bet.optimal.value'); }
        else if (evBetting >= evChecking) { evaluation = B.EVAL_GOOD; reason = t('bet.good'); }
        else if (evBetting >= evChecking - (marginPct * potSize)) { evaluation = B.EVAL_MARGINAL; reason = t('bet.marginal'); }
        else { evaluation = B.EVAL_BAD; reason = t('bet.bad'); }
      } else if (eqCalled >= Evaluator.BET_VALUE_THRESHOLD) {
        evaluation = B.EVAL_OPTIMAL;
        reason = rangeAdv > 0.55 ? t('bet.optimal.range_adv') : t('bet.optimal.value');
      } else if (eqCalled >= Evaluator.BET_THIN_VALUE_THRESHOLD) {
        evaluation = B.EVAL_GOOD; reason = t('bet.good');
      } else if (draw === 'STRONG_DRAW' || draw === 'MEDIUM_DRAW') {
        evaluation = B.EVAL_OPTIMAL; reason = t('bet.optimal.bluff');   // セミブラフ
      } else if (realized < Evaluator.BET_BLUFF_MAX_EQUITY) {
        evaluation = B.EVAL_GOOD; reason = t('bet.optimal.bluff');      // 全部はブラフできないので ◯ 止まり
      } else if (draw === 'WEAK_DRAW') {
        evaluation = B.EVAL_MARGINAL; reason = t('bet.marginal');
      } else {
        evaluation = B.EVAL_BAD; reason = t('bet.medium_should_check'); // 中途半端な強さ
      }

      // ドンクベットは ◎ にしない（チェックの ◯ を上回らないように）
      if (isDonk && evaluation === B.EVAL_OPTIMAL) {
        evaluation = B.EVAL_GOOD; reason = t('bet.donk');
      }
      return { ev: evBetting, req_eq: 0.0, realized_eq: realized, evaluation, reason: reason + sizingFeedback };
    },

    evaluateRaise(equity, raiseAmount, opponentBetSize, potSize, heroPos = 'BTN', cards = null, board = null,
                  rangeAdv = 0.5, heroRange = null, effectiveStack = 0.0, street = null, cpuRange = null) {
      const { BetSizing: B, HandClassifier: HC } = root;
      let prefix = '';
      if (!hasCards(board)) {
        const [decision, eEval, eReason] = Evaluator.evaluatePreflopActionGto(cards, 'RAISE', heroPos, false, opponentBetSize);
        prefix = eReason + '\n';
        if (decision === 'fold' || decision === 'mix') {
          return { ev: 0.0, req_eq: 0.0, realized_eq: equity, evaluation: eEval, reason: prefix };
        }
      }

      let marginPct;
      if (street === 'RIVER') marginPct = 0.15;
      else if (street === 'TURN') marginPct = 0.10;
      else marginPct = Evaluator.BET_OPTIMAL_MARGIN_PCT;

      const raiseSpr = (effectiveStack > 0 && potSize > 0) ? (effectiveStack / potSize) : 10.0;
      const eqr = Evaluator.getEqrModifier(heroPos, cards, false, board, rangeAdv, raiseSpr, street);
      const realized = Evaluator.realizeEquity(equity, eqr);

      const totalPot = potSize + opponentBetSize;
      const texture = (board && board.length >= 3) ? HC.classifyBoardTexture(board) : null;
      const foldEquity = Evaluator.estimateFoldEquity(totalPot, raiseAmount, texture);
      const evRaising = Evaluator.evBet(realized, totalPot, raiseAmount, foldEquity);
      const evCalling = Evaluator.evCall(realized, potSize, opponentBetSize);

      const eqCalled = Evaluator.equityVsCallingRange(cards, board, heroRange, cpuRange, raiseAmount, totalPot);
      const draw = (hasCards(cards) && hasCards(board)) ? HC.detectDrawStrength(cards, board) : 'NONE';

      let evaluation, reason;
      if (eqCalled === null) {
        if (evRaising > evCalling + (marginPct * totalPot)) { evaluation = B.EVAL_OPTIMAL; reason = prefix + t('raise.optimal.value'); }
        else if (evRaising >= evCalling) { evaluation = B.EVAL_GOOD; reason = prefix + t('raise.good'); }
        else if (evRaising >= evCalling - (marginPct * totalPot)) { evaluation = B.EVAL_MARGINAL; reason = prefix + t('raise.marginal'); }
        else { evaluation = B.EVAL_BAD; reason = prefix + t('raise.bad'); }
      } else if (eqCalled >= Evaluator.BET_VALUE_THRESHOLD) {
        evaluation = B.EVAL_OPTIMAL;
        reason = prefix + (rangeAdv > 0.55 ? t('raise.optimal.range_adv') : t('raise.optimal.value'));
      } else if (eqCalled >= Evaluator.BET_THIN_VALUE_THRESHOLD) {
        evaluation = B.EVAL_GOOD; reason = prefix + t('raise.good');
      } else if (draw === 'STRONG_DRAW' || draw === 'MEDIUM_DRAW') {
        evaluation = B.EVAL_OPTIMAL; reason = prefix + t('raise.optimal.bluff');
      } else if (realized < Evaluator.BET_BLUFF_MAX_EQUITY) {
        evaluation = B.EVAL_GOOD; reason = prefix + t('raise.optimal.bluff');
      } else if (draw === 'WEAK_DRAW') {
        evaluation = B.EVAL_MARGINAL; reason = prefix + t('raise.marginal');
      } else {
        evaluation = B.EVAL_BAD; reason = prefix + t('raise.medium_should_call');
      }
      return { ev: evRaising, req_eq: 0.0, realized_eq: realized, evaluation, reason };
    },

    evaluateCheck(equity, potSize, heroPos = 'BTN', hasInitiative = false, isHeroIp = false, cards = null, board = null,
                  rangeAdv = 0.5, effectiveStack = 0.0, street = null, heroRange = null, cpuRange = null) {
      const { BetSizing: B, HandClassifier: HC } = root;
      if (!hasInitiative && !isHeroIp) {
        // OOP で先にチェック: 標準的なパッシブプレイ
        return { ev: 0.0, req_eq: 0.0, realized_eq: equity, evaluation: B.EVAL_GOOD, reason: t('check.oop_default') };
      }
      const checkSpr = (effectiveStack > 0 && potSize > 0) ? (effectiveStack / potSize) : 10.0;
      const eqr = Evaluator.getEqrModifier(heroPos, cards, false, board, rangeAdv, checkSpr, street);
      const realized = Evaluator.realizeEquity(equity, eqr);
      const evChecking = Evaluator.evCheck(realized, potSize);

      if (realized >= 0.65) {
        return { ev: evChecking, req_eq: 0.0, realized_eq: realized, evaluation: B.EVAL_BAD, reason: t('check.missed_value') };
      }

      // チェックはベットの裏返しとして評価する
      const halfPot = potSize / 2.0;
      const eqCalled = Evaluator.equityVsCallingRange(cards, board, heroRange, cpuRange, halfPot, potSize);
      const draw = (hasCards(cards) && hasCards(board)) ? HC.detectDrawStrength(cards, board) : 'NONE';

      let evaluation, reason;
      const optimalReason = () => (rangeAdv < 0.45 ? t('check.optimal.weak_range') : t('check.optimal'));
      if (eqCalled === null) {
        const texture = (board && board.length >= 3) ? HC.classifyBoardTexture(board) : null;
        const foldEquity = Evaluator.estimateFoldEquity(potSize, halfPot, texture);
        const evBetHalf = Evaluator.evBet(realized, potSize, halfPot, foldEquity);
        if (evChecking >= evBetHalf) { evaluation = B.EVAL_OPTIMAL; reason = optimalReason(); }
        else if (evChecking >= evBetHalf * 0.75) { evaluation = B.EVAL_GOOD; reason = t('check.good'); }
        else if (evChecking >= evBetHalf * 0.55) { evaluation = B.EVAL_MARGINAL; reason = t('check.marginal'); }
        else { evaluation = B.EVAL_BAD; reason = t('check.bad'); }
      } else if (eqCalled >= Evaluator.BET_VALUE_THRESHOLD) {
        evaluation = B.EVAL_BAD; reason = t('check.missed_value');
      } else if (draw === 'STRONG_DRAW' || draw === 'MEDIUM_DRAW') {
        evaluation = B.EVAL_MARGINAL; reason = t('check.marginal');
      } else if (eqCalled >= Evaluator.BET_THIN_VALUE_THRESHOLD) {
        evaluation = B.EVAL_GOOD; reason = t('check.good');
      } else if (realized < Evaluator.BET_BLUFF_MAX_EQUITY) {
        evaluation = B.EVAL_GOOD; reason = t('check.good');
      } else {
        evaluation = B.EVAL_OPTIMAL; reason = optimalReason();
      }
      return { ev: evChecking, req_eq: 0.0, realized_eq: realized, evaluation, reason };
    },
  };

  root.Evaluator = Evaluator;
  if (typeof module !== 'undefined') module.exports = Evaluator;
})(typeof window !== 'undefined' ? window : globalThis);
