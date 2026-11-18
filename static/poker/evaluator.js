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
  // レンジが全ハンドの何%か（重み換算のコンボ数 / 1326。ペア6・スーテッド4・オフスート12）
  const rangePct = (m) => {
    let n = 0;
    for (const [c, w] of (m || new Map())) n += (c.length === 2 ? 6 : c.endsWith('s') ? 4 : 12) * Math.min(1, w);
    return n / 1326 * 100;
  };
  const unionRange = (a, b) => {
    const u = new Map(a || []);
    for (const [c, w] of (b || new Map())) u.set(c, Math.min(1, (u.get(c) || 0) + w));
    return u;
  };

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
    // isIpOverride: 実際の IP/OOP（相手の位置で決まる）。省略時は従来どおりポジション名で決め打ち（プリフロップの判定用）
    getEqrModifier(heroPos, cards = null, is3betPot = false, board = null, rangeAdv = 0.5, spr = 10.0, street = null, isIpOverride = null) {
      let baseEqr = 1.0;
      const category = Evaluator.categorizeHand(cards, board);
      const isIp = isIpOverride === null ? IP_POSITIONS.includes(heroPos) : isIpOverride;

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

    // プリフロップの場面と、その場面でこのハンドに推奨されるアクションの頻度（レンジ表の重み）。
    // spot（省略可）: { openerPos, villainPos, pot, raises, ip }。文字列ならオープンした位置（以前の呼び方）
    //   - open    : 最初に参加する（レイズかフォールド。リンプのレンジは持たない）
    //   - vs_limp : BB で SB のリンプに対して（チェックかレイズ）
    //   - vs_open : 相手のオープンに対して（コール/3ベット/フォールド）
    //   - vs_3bet : 3ベット（4ベット）に対して
    // 判定は 6人卓の理論（レンジ表）を優先する。このアプリは2人の勝負だが、例えば SB は後ろの BB に
    // スクイーズされる前提で「3ベットかフォールド」と判定し、その理由を解説に書く（2026/11/18 shota 指定）
    preflopSpot(cards, heroPos, is3betPot, facingBet, spot = null) {
      const { Ranges } = root;
      const sp = typeof spot === 'string' ? { openerPos: spot } : (spot || {});
      const posRanges = Ranges.RANGES.get(heroPos) || new Map();
      const empty = new Map();
      let kind, callRange, raiseRange;
      if (facingBet === 0 && heroPos === 'BB') {
        kind = 'vs_limp';
        callRange = empty;
        // BB のリンプ対応の表は無いので、3ベットする強さのハンドを「レイズすべき手」とする（それ以外のレイズも ◯）
        raiseRange = getOr(posRanges, 'vs_open_3bet', empty);
      } else if (facingBet === 0) {
        kind = 'open';
        callRange = empty;
        raiseRange = getOr(posRanges, 'open', empty);
      } else if (!is3betPot) {
        kind = 'vs_open';
        callRange = getOr(posRanges, 'vs_open_call', empty);
        // BB はオープンした位置ごとのコールレンジ（ポットオッズ × 実現率で作成）。
        // SB にも同じ作りのレンジがあるが、それは CPU がコールするとき用。判定は理論どおり 3ベットかフォールド
        if (sp.openerPos && heroPos !== 'SB' && posRanges.has('vs_open_call_vs_' + sp.openerPos)) {
          callRange = posRanges.get('vs_open_call_vs_' + sp.openerPos);
        }
        raiseRange = getOr(posRanges, 'vs_open_3bet', getOr(posRanges, '3bet', empty));
      } else {
        kind = 'vs_3bet';
        callRange = getOr(posRanges, 'vs_3bet_call', empty);
        raiseRange = getOr(posRanges, 'vs_3bet_4bet', getOr(posRanges, '4bet_bluff', empty));
      }
      const comboStr = Evaluator.getComboStr(cards, Ranges.ALL_HANDS_DICT);
      const callWeight = Math.min(1, getOr(callRange, comboStr, 0.0));
      const raiseWeight = Math.min(1, getOr(raiseRange, comboStr, 0.0));
      return { kind, sp, comboStr, callRange, raiseRange, callWeight, raiseWeight };
    },

    // 場面の解説（推奨の頻度・場面の考え方・ハンドの特徴）。判定の1行目は含まない
    preflopExplain(info, heroPos, facingBet) {
      const { Ranges } = root;
      const { kind, sp, comboStr, callWeight: wc, raiseWeight: wr } = info;
      const disp = (p) => (p === 'LJ' ? 'UTG' : p);
      const pos = disp(heroPos);
      const pct = (m) => rangePct(m);
      const lines = [];
      const raiseName = Evaluator.preflopRaiseName(kind, sp);
      // 推奨の頻度（混ぜるハンドのときだけ）
      const wf = Math.max(0, 1 - wc - wr);
      if ((wc > 0 && wc < 1) || (wr > 0 && wr < 1)) {
        const parts = [];
        if (wr > 0) parts.push(t('preflop.freq.item', { act: raiseName, p: wr * 100 }));
        if (wc > 0) parts.push(t('preflop.freq.item', { act: t('preflop.act.call'), p: wc * 100 }));
        if (wf > 0.001) parts.push(t('preflop.freq.item', { act: kind === 'vs_limp' ? t('preflop.act.check') : t('preflop.act.fold'), p: wf * 100 }));
        lines.push(t('preflop.freq', { list: parts.join(t('preflop.freq.sep')) }));
      }
      // 場面の考え方
      const opener = sp.openerPos ? disp(sp.openerPos) : null;
      const behind = { UTG: 5, LJ: 5, HJ: 4, CO: 3, BTN: 2, SB: 1, BB: 0 }[heroPos] ?? 0;
      if (kind === 'open') {
        const open = pct(info.raiseRange);
        if (heroPos === 'BTN') lines.push(t('preflop.why.open_btn', { pct: open }));
        else if (heroPos === 'SB') lines.push(t('preflop.why.open_sb', { pct: open }));
        else lines.push(t('preflop.why.open', { pos, n: String(behind), pct: open }));
      } else if (kind === 'vs_limp') {
        lines.push(t('preflop.why.vs_limp', { pct: pct(info.raiseRange) }));
      } else if (kind === 'vs_open') {
        const openPct = opener ? pct(Ranges.getRangeByCategory(sp.openerPos, 'open')) : null;
        const pot = sp.pot || 0;
        const req = pot > 0 ? facingBet / (pot + facingBet) * 100 : null;
        if (heroPos === 'BB') {
          const def = rangePct(unionRange(info.callRange, info.raiseRange));
          if (opener && req !== null) lines.push(t('preflop.why.vs_open_bb', { opener, open: openPct, req, def }));
          else lines.push(t('preflop.why.vs_open_bb_generic', { def }));
          if (sp.openerPos === 'SB') lines.push(t('preflop.why.vs_open_bb_sb'));
        } else if (heroPos === 'SB') {
          lines.push(t('preflop.why.vs_open_sb', { raise: pct(info.raiseRange) }));
        } else {
          lines.push(t('preflop.why.vs_open_ip', { pos, n: String(behind), tot: rangePct(unionRange(info.callRange, info.raiseRange)) }));
          if (heroPos === 'BTN') lines.push(t('preflop.why.vs_open_btn'));
        }
      } else {
        const four = (sp.raises || 0) >= 3;
        const open = pct(Ranges.RANGES.get(heroPos) && Ranges.RANGES.get(heroPos).get('open'));
        if (four) lines.push(t('preflop.why.vs_4bet'));
        else if (open > 0) lines.push(t('preflop.why.vs_3bet', { tot: rangePct(unionRange(info.callRange, info.raiseRange)) / open * 100 }));
        else lines.push(t('preflop.why.vs_3bet_generic', { tot: rangePct(unionRange(info.callRange, info.raiseRange)) }));
        if (!four && sp.ip === true) lines.push(t('preflop.why.vs_3bet_ip'));
        if (!four && sp.ip === false) lines.push(t('preflop.why.vs_3bet_oop'));
      }
      // ハンドの一般的な特徴（「投機的なハンド」等）は 2026/11/18 に外した（解説が長くなるため）
      return lines;
    },

    preflopRaiseName(kind, sp = {}) {
      if (kind === 'open') return t('preflop.act.open');
      if (kind === 'vs_limp') return t('preflop.act.raise');
      if (kind === 'vs_open') return t('preflop.act.3bet');
      return (sp.raises || 0) >= 3 ? t('preflop.act.5bet') : t('preflop.act.4bet');
    },

    preflopSpotName(kind, heroPos, sp = {}) {
      const disp = (p) => (p === 'LJ' ? 'UTG' : p);
      const pos = disp(heroPos);
      if (kind === 'open') return t('preflop.spot.open', { pos });
      if (kind === 'vs_limp') return t('preflop.spot.vs_limp');
      if (kind === 'vs_open') {
        return sp.openerPos ? t('preflop.spot.vs_open', { pos, opener: disp(sp.openerPos) }) : t('preflop.spot.vs_open_generic', { pos });
      }
      const v = sp.villainPos ? disp(sp.villainPos) : null;
      if ((sp.raises || 0) >= 3) return v ? t('preflop.spot.vs_4bet', { pos, villain: v }) : t('preflop.spot.vs_4bet_generic', { pos });
      return v ? t('preflop.spot.vs_3bet', { pos, villain: v }) : t('preflop.spot.vs_3bet_generic', { pos });
    },

    // 戻り値: [decision('play'|'mix'|'fold'|'final'), 評価記号, 解説文, { verdict, plain, detail }]
    //   play  … 表の上では参加する手。呼び出し側が勝率で評価を続ける（plain + detail を後ろに付ける）
    //   それ以外 … この判定で確定
    evaluatePreflopActionGto(cards, actionTaken, heroPos, is3betPot, facingBet, spot = null) {
      const { BetSizing: B } = root;
      const info = Evaluator.preflopSpot(cards, heroPos, is3betPot, facingBet, spot);
      const { kind, sp, comboStr, callWeight, raiseWeight } = info;
      const detail = Evaluator.preflopExplain(info, heroPos, facingBet);
      const kw = { hand: comboStr, spot: Evaluator.preflopSpotName(kind, heroPos, sp), raise: Evaluator.preflopRaiseName(kind, sp) };
      const out = (decision, ev, key, plainKey = null) => {
        const verdict = t(key, kw);
        const lines = [verdict].concat(kind === 'open' && actionTaken === 'CALL' ? [t('preflop.why.no_limp')] : [], detail);
        return [decision, ev, lines.join('\n'), { verdict, plain: plainKey ? t(plainKey, kw) : verdict, detail: detail.join('\n') }];
      };

      if (kind === 'vs_limp') {
        // チェックは無料でフロップを見られるので基本。強い手はレイズでバリュー
        if (actionTaken === 'CHECK') return raiseWeight > 0 ? out('final', B.EVAL_GOOD, 'preflop.limp.check_strong') : out('final', B.EVAL_OPTIMAL, 'preflop.limp.check');
        if (actionTaken === 'RAISE') return raiseWeight > 0 ? out('final', B.EVAL_OPTIMAL, 'preflop.limp.raise_value') : out('final', B.EVAL_GOOD, 'preflop.limp.raise_other');
      }
      if (actionTaken === 'CALL') {
        if (callWeight > 0) return out('play', B.EVAL_GOOD, 'preflop.call.good', 'preflop.call.plain');
        if (raiseWeight > 0) return out('fold', B.EVAL_BAD, 'preflop.call.should_raise');
        return out('fold', B.EVAL_BAD, 'preflop.call.out_of_range');
      }
      if (actionTaken === 'RAISE') {
        if (raiseWeight > 0) return out('play', B.EVAL_OPTIMAL, 'preflop.raise.optimal', 'preflop.raise.plain');
        if (callWeight > 0) return out('mix', B.EVAL_MARGINAL, 'preflop.raise.should_call');
        return out('fold', B.EVAL_BAD, 'preflop.raise.out_of_range');
      }
      if (actionTaken === 'FOLD') {
        if (raiseWeight > 0.5) return out('mix', B.EVAL_BAD, 'preflop.fold.too_strong');
        if (callWeight > 0.5) return out('mix', B.EVAL_BAD, 'preflop.fold.callable');
        if (raiseWeight > 0 || callWeight > 0) return out('play', B.EVAL_MARGINAL, 'preflop.fold.slightly_tight', 'preflop.fold.slightly_tight');
        return out('play', B.EVAL_OPTIMAL, 'preflop.fold.optimal');
      }
      return ['play', B.EVAL_GOOD, detail.join('\n'), { verdict: '', plain: '', detail: detail.join('\n') }];
    },

    // ファーストイン（誰も参加していない場面）の判定で置き換える。ev は呼び出し元の値を保つ
    applyFirstIn(evalDict, cards, action, heroPos) {
      const gtoAction = action === 'BET' ? 'RAISE' : action;
      const [, evaluation, reason] = Evaluator.evaluatePreflopActionGto(cards, gtoAction, heroPos, false, 0);
      return { ...evalDict, evaluation, reason };
    },

    evaluateCall(equity, callAmount, potSize, heroPos = 'BTN', cards = null, is3betPot = false, board = null,
                 effectiveStack = 0.0, rangeAdv = 0.5, heroRange = null, street = null, openerPos = null) {
      const B = root.BetSizing;
      if (callAmount === 0) {
        return { ev: 0.0, req_eq: 0.0, realized_eq: equity, evaluation: B.EVAL_OPTIMAL, reason: t('call.free_check') };
      }
      // プリフロップ: 表の外なら表で確定。表の中なら勝率で評価し、表の解説を後ろに付ける
      let preflopSuffix = '';
      if (!hasCards(board)) {
        const [decision, eEval, eReason, parts] = Evaluator.evaluatePreflopActionGto(cards, 'CALL', heroPos, is3betPot, callAmount, openerPos);
        if (decision !== 'play') {
          return { ev: 0.0, req_eq: 0.0, realized_eq: equity, evaluation: eEval, reason: eReason };
        }
        // 表の中のコール: 勝率の行のあとに場面の考え方だけ付ける（「コールするハンドです」は勝率の行と重なるので省く）
        preflopSuffix = parts.detail ? '\n' + parts.detail : '';
      }

      const eReq = Evaluator.calculateRequiredEquity(callAmount, potSize);
      let spr = null;
      if (effectiveStack > 0 && potSize > 0) spr = effectiveStack / potSize;

      const eqr = Evaluator.getEqrModifier(heroPos, cards, is3betPot, board, rangeAdv, spr !== null ? spr : 10.0, street);
      const realized = Evaluator.realizeEquity(equity, eqr);
      const category = Evaluator.categorizeHand(cards, board);
      const isIp = IP_POSITIONS.includes(heroPos);
      const evCallVal = Evaluator.evCall(realized, potSize, callAmount, spr, category, isIp);

      let evaluation, reason = '';
      const kw = { eq: realized * 100, req: eReq * 100 };
      if (realized >= eReq * Evaluator.CALL_OPTIMAL_THRESHOLD) {
        evaluation = B.EVAL_OPTIMAL; reason += t('call.optimal', kw);
      } else if (realized >= eReq) {
        evaluation = B.EVAL_GOOD; reason += t('call.good', kw);
      } else if (realized >= eReq * Evaluator.CALL_MARGINAL_THRESHOLD) {
        if (evCallVal > 0) { evaluation = B.EVAL_GOOD; reason += t('call.implied_good', kw); }
        else { evaluation = B.EVAL_MARGINAL; reason += t('call.marginal', kw); }
      } else if (evCallVal > 0) {
        evaluation = B.EVAL_MARGINAL; reason += t('call.implied_marginal', kw);
      } else {
        evaluation = B.EVAL_BAD; reason += t('call.bad', kw);
      }
      reason += preflopSuffix;
      return { ev: evCallVal, req_eq: eReq, realized_eq: realized, evaluation, reason };
    },

    evaluateFold(equity, opponentBetSize, potSize, heroPos = 'BTN', cards = null, is3betPot = false, board = null,
                 rangeAdv = 0.5, effectiveStack = 0.0, street = null, openerPos = null) {
      const B = root.BetSizing;
      if (opponentBetSize === 0) {
        return { ev: 0.0, req_eq: 0.0, realized_eq: equity, evaluation: B.EVAL_BAD, reason: t('fold.no_bet') };
      }
      let preflopSuffix = '';
      if (!hasCards(board)) {
        const [decision, eEval, eReason, parts] = Evaluator.evaluatePreflopActionGto(cards, 'FOLD', heroPos, is3betPot, opponentBetSize, openerPos);
        if (decision === 'mix' || decision === 'final') {
          return { ev: 0.0, req_eq: 0.0, realized_eq: equity, evaluation: eEval, reason: eReason };
        }
        if (decision === 'play' && eEval === B.EVAL_OPTIMAL) {
          return { ev: 0.0, req_eq: 0.0, realized_eq: equity, evaluation: B.EVAL_OPTIMAL, reason: eReason };
        }
        // 表では一部の頻度だけ参加する手: 勝率で評価し、表の解説を後ろに付ける
        preflopSuffix = '\n' + [parts.plain, parts.detail].filter(Boolean).join('\n');
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
      reason += preflopSuffix;

      return { ev: 0.0, req_eq: eReq, mdf: root.Py.round(mdf, 3), realized_eq: realized, evaluation, reason };
    },

    // ベットしてコールされた場合の、その継続レンジ相手のエクイティ。レンジ情報が無ければ null
    // 内部のモンテカルロが使う乱数。ゲーム（game.js）がエンジンと同じ乱数に差し替える。
    // Python は全ての乱数が random モジュールを通るので、JS もエンジンと同じ列を読まないと順番がずれる
    rng: Math.random,

    // rng 引数は Python 版には無い（省略時は Evaluator.rng）
    equityVsCallingRange(cards, board, heroRange, cpuRange, betAmount, potSize, iterations = 1000, rng = Evaluator.rng) {
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
                  rangeAdv = 0.5, heroRange = null, effectiveStack = 0.0, street = null, cpuRange = null, is3betPot = false, openerPos = null) {
      const { BetSizing: B, HandClassifier: HC } = root;
      const prefix = '';   // 以前はプリフロップの表の解説を前に付けていた
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

      if (!hasCards(board)) {
        // プリフロップのレイズはレンジ表（6人卓の理論）で確定する。以前は表の中の 3ベットでも
        // 「コールされたときの勝率」で採点し直していて、A5s のようなブラフの 3ベットが × になることがあった。
        // ev（統計の平均損失に使う）は以前と同じ計算のまま
        const [decision, eEval, eReason] = Evaluator.evaluatePreflopActionGto(cards, 'RAISE', heroPos, is3betPot, opponentBetSize, openerPos);
        if (decision !== 'play') return { ev: 0.0, req_eq: 0.0, realized_eq: equity, evaluation: eEval, reason: eReason };
        return { ev: evRaising, req_eq: 0.0, realized_eq: realized, evaluation: eEval, reason: eReason };
      }
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
