// EV 計算（ev_calculator.py の JS 移植）。式の計算順序も Python と同じにしてある
// （浮動小数点の結果をビット単位で一致させるため。式を整理・簡約しないこと）。

(function (root) {
  const EVCalculator = {
    // 必要エクイティ。pot_size は相手のベット込み
    calculateRequiredEquity(callAmount, potSize) {
      if (callAmount === 0) return 0.0;
      return callAmount / (potSize + callAmount);
    },

    evCall(equity, potSize, callAmount, spr = null, handCategory = null, isIp = true) {
      const baseEv = equity * (potSize + callAmount) - callAmount;
      let impliedBonus = 0.0;
      if (spr !== null && spr !== undefined && handCategory === 'STRONG_DRAW') {
        // OOP はインプライドオッズを実現しにくいので半減。SPR は 3.0 で頭打ち
        const positionModifier = isIp ? 1.0 : 0.5;
        impliedBonus = equity * (potSize * 0.3 * Math.min(spr, 3.0)) * positionModifier;
      }
      return baseEv + impliedBonus;
    },

    evCheck(equity, potSize) {
      return equity * potSize;
    },

    evBet(equity, potSize, betAmount, foldEquity, villainRaiseFreq = 0.1) {
      const callEv = equity * (potSize + betAmount) - (1 - equity) * betAmount;
      const foldEv = potSize;
      const raiseEv = -betAmount;
      const adjustedCallFreq = (1 - foldEquity) * (1 - villainRaiseFreq);
      const adjustedRaiseFreq = (1 - foldEquity) * villainRaiseFreq;
      return (foldEquity * foldEv) + (adjustedCallFreq * callEv) + (adjustedRaiseFreq * raiseEv);
    },

    calculateAlpha(betAmount, potSize) {
      if (potSize + betAmount === 0) return 0.0;
      return betAmount / (potSize + betAmount);
    },

    // pot_size はベット前のポット
    calculateMdf(betAmount, potSize) {
      if (potSize + betAmount === 0) return 1.0;
      return potSize / (potSize + betAmount);
    },

    // Bet / (Pot + 2*Bet)。Bet / (Pot + Bet) は Alpha で別概念
    calculateTheoreticalBluffFrequency(betSize, pot) {
      if (betSize <= 0) return 0.0;
      if (pot + 2 * betSize === 0) return 0.0;
      return betSize / (pot + 2 * betSize);
    },
  };

  root.EVCalculator = EVCalculator;
  if (typeof module !== 'undefined') module.exports = EVCalculator;
})(typeof window !== 'undefined' ? window : globalThis);
