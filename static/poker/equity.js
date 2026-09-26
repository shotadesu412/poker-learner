// モンテカルロ・エクイティ計算（equity.py の calc_equity_monte_carlo / calc_range_advantage の JS 移植）。
// 未使用の calculate_preflop_score 系・calculate_preflop_equity_approx は移していない。
//
// 乱数列は Python と違うので結果は1件ずつは一致しない。一致は統計的に検証する
// （tools/golden/equity_reference.py が作る参照値と誤差範囲で比較）。
//
// 依存: hand_eval.js, ranges.js, range_utils.js

(function (root) {
  if (typeof module !== 'undefined') {
    require('./hand_eval.js');
    require('./range_utils.js');
  }

  let FULL_DECK = null;
  function fullDeck() {
    if (!FULL_DECK) {
      const { Card } = root;
      FULL_DECK = [];
      for (const r of Card.STR_RANKS) for (const s of 'shdc') FULL_DECK.push(Card.fromStr(r + s));
    }
    return FULL_DECK;
  }

  // avail から needed 枚を重複なしで無作為に選ぶ（Python の random.sample と同じ分布）。
  // 部分的な Fisher-Yates。avail は呼び出し側で作った使い捨て配列なので破壊してよい。
  function drawInto(avail, needed, out, rng) {
    const n = avail.length;
    for (let i = 0; i < needed; i++) {
      const j = i + Math.floor(rng() * (n - i));
      const t = avail[i]; avail[i] = avail[j]; avail[j] = t;
      out.push(avail[i]);
    }
  }

  const Equity = {
    // ヒーローの実ハンド vs 相手レンジ。戻り値 [heroEquity, cpuEquity]
    calcEquityMonteCarlo(heroCards, boardCards, heroRange, cpuRange,
                         targetActor = 'CPU', isPreflop = false, iterations = 1000, rng = Math.random) {
      const { Card, HandEvaluator, RangeUtils } = root;
      const target = targetActor === 'CPU' ? cpuRange : heroRange;
      const deadStr = heroCards.concat(boardCards).map(Card.toStr);
      const dead = new Set(heroCards.concat(boardCards));
      const baseDeck = fullDeck().filter((c) => !dead.has(c));
      const needed = 5 - boardCards.length;

      const sampler = RangeUtils.buildSampler(target, deadStr);
      if (!sampler) return [0.5, 0.5];

      let wins = 0, ties = 0, sims = 0;
      for (let it = 0; it < iterations; it++) {
        const cpu = RangeUtils.sampleFrom(sampler, rng);
        if (!cpu) continue;
        if (dead.has(cpu[0]) || dead.has(cpu[1])) continue;

        let board = boardCards;
        if (needed > 0) {
          const avail = baseDeck.filter((c) => c !== cpu[0] && c !== cpu[1]);
          board = boardCards.slice();
          drawInto(avail, needed, board, rng);
        }
        const h = HandEvaluator.evaluate(board, heroCards);
        const v = HandEvaluator.evaluate(board, cpu);
        if (h < v) wins++;
        else if (h === v) ties++;
        sims++;
      }
      // 計算不能なら中立値。1.0 を返すと全アクションが過大評価される
      if (sims === 0) return [0.5, 0.5];
      const eq = (wins + ties / 2) / sims;
      return [eq, 1.0 - eq];
    },

    // レンジ vs レンジ（ヒーローの実カードは除外しない — 定義通り）
    calcRangeAdvantage(heroCards, boardCards, heroRange, cpuRange,
                       isPreflop = false, iterations = 1000, rng = Math.random) {
      const { Card, HandEvaluator, RangeUtils } = root;
      const deadStr = boardCards.map(Card.toStr);
      const boardSet = new Set(boardCards);
      const baseDeck = fullDeck().filter((c) => !boardSet.has(c));
      const needed = 5 - boardCards.length;

      const hs = RangeUtils.buildSampler(heroRange, deadStr);
      const cs = RangeUtils.buildSampler(cpuRange, deadStr);
      if (!hs || !cs) return 0.5;

      let wins = 0, ties = 0, sims = 0;
      for (let it = 0; it < iterations; it++) {
        const hero = RangeUtils.sampleFrom(hs, rng);
        const cpu = RangeUtils.sampleFrom(cs, rng);
        if (!hero || !cpu) continue;
        if (cpu.includes(hero[0]) || cpu.includes(hero[1])) continue;
        if (boardSet.has(hero[0]) || boardSet.has(hero[1]) || boardSet.has(cpu[0]) || boardSet.has(cpu[1])) continue;

        let board = boardCards;
        if (needed > 0) {
          const used = [hero[0], hero[1], cpu[0], cpu[1]];
          const avail = baseDeck.filter((c) => !used.includes(c));
          board = boardCards.slice();
          drawInto(avail, needed, board, rng);
        }
        const h = HandEvaluator.evaluate(board, hero);
        const v = HandEvaluator.evaluate(board, cpu);
        if (h < v) wins++;
        else if (h === v) ties++;
        sims++;
      }
      if (sims === 0) return 0.5;
      return (wins + ties / 2) / sims;
    },
  };

  root.Equity = Equity;
  if (typeof module !== 'undefined') module.exports = Equity;
})(typeof window !== 'undefined' ? window : globalThis);
