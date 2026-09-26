// ベットサイジング定数と評価（bet_sizing.py の JS 移植）。
// 依存: messages.js

(function (root) {
  if (typeof module !== 'undefined') require('./messages.js');

  const EVAL_OPTIMAL = '◎';
  const EVAL_GOOD = '◯';
  const EVAL_MARGINAL = '△';
  const EVAL_BAD = '×';

  const BetSizing = {
    PREFLOP_OPENS: { UTG: 2.5, HJ: 2.5, CO: 2.3, BTN: 2.2, SB: 2.5, BB: 0.0 },
    PREFLOP_3BET: { IP: 2.8, OOP: 3.5 },
    BET_SIZES: {
      FLOP: { small: 0.33, medium: 0.50, large: 0.75 },
      TURN: { small: 0.33, medium: 0.66, large: 1.00 },
      RIVER: { small: 0.50, medium: 0.75, large: 1.00 },
    },
    RAISE_MULTIPLIER: {
      FLOP: { small: 2.5, medium: 3.0, large: 3.5 },
      TURN: { small: 2.5, medium: 3.0, large: 3.5 },
      RIVER: { small: 2.5, medium: 3.0, large: 5.0 },
    },
    // ドライ → 小さく頻度高く / ウェット → 大きくエクイティ否定
    TEXTURE_MULTIPLIER: { dry: 0.75, semi_wet: 1.0, wet: 1.25, paired: 1.1 },
    BLUFF_FREQ_TEXTURE_MULTIPLIER: { dry: 1.20, semi_wet: 1.00, wet: 0.75, paired: 1.10, monotone: 0.80 },
    POSITION_MULTIPLIER: { IP: 0.90, OOP: 1.10 },
    SPR_MULTIPLIER: { ultra_low: 0.7, low: 0.85, mid: 1.0, high: 1.15 },
    EVAL_OPTIMAL, EVAL_GOOD, EVAL_MARGINAL, EVAL_BAD,

    getSprSizeAdjustment(spr) {
      if (spr < 2.0) return 1.00;
      if (spr < 4.0) return 1.00;
      if (spr < 8.0) return 1.00;
      return 1.10;  // ディープ: やや大きめも許容
    },

    evaluateBetSizing(pot, betAmount, boardTexture, spr = null) {
      const t = (k, kw) => root.Messages.t(k, kw);
      if (pot <= 0) return { evaluation: EVAL_MARGINAL, reason: t('sizing.no_pot') };
      const fraction = betAmount / pot;
      let m = 1.0;
      if (spr !== null && spr !== undefined) m = 1.0 / BetSizing.getSprSizeAdjustment(spr);
      const pct = fraction * 100;

      if (boardTexture === 'monotone') {
        if (fraction > 0.75 * m) return { evaluation: EVAL_MARGINAL, reason: t('sizing.monotone.too_big', { pct }) };
        return { evaluation: EVAL_GOOD, reason: t('sizing.monotone.good', { pct }) };
      }
      if (boardTexture === 'paired') {
        if (fraction > 1.00 * m) return { evaluation: EVAL_MARGINAL, reason: t('sizing.paired.too_big', { pct }) };
        return { evaluation: EVAL_GOOD, reason: t('sizing.paired.good', { pct }) };
      }
      if (boardTexture === 'wet') {
        if (fraction < 0.40 * m) return { evaluation: EVAL_BAD, reason: t('sizing.wet.too_small', { pct }) };
        if (fraction > 1.10 * m) return { evaluation: EVAL_MARGINAL, reason: t('sizing.wet.too_big', { pct }) };
        return { evaluation: EVAL_GOOD, reason: t('sizing.wet.good', { pct }) };
      }
      if (boardTexture === 'semi_wet') {
        if (fraction < 0.25 * m) return { evaluation: EVAL_MARGINAL, reason: t('sizing.semiwet.small', { pct }) };
        return { evaluation: EVAL_GOOD, reason: t('sizing.semiwet.good', { pct }) };
      }
      // dry（とそれ以外）
      if (fraction > 1.20 * m) return { evaluation: EVAL_MARGINAL, reason: t('sizing.dry.too_big', { pct }) };
      return { evaluation: EVAL_GOOD, reason: t('sizing.dry.good', { pct }) };
    },
  };

  root.BetSizing = BetSizing;
  if (typeof module !== 'undefined') module.exports = BetSizing;
})(typeof window !== 'undefined' ? window : globalThis);
