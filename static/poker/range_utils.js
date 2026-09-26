// レンジからのサンプリング（range_utils.py の build_sampler / sample_from の JS 移植）。
// 旧 sample_range / filter_range_by_action / normalize_range は未使用のため移していない。
//
// 依存: hand_eval.js（Card）, ranges.js（Ranges.parseCombo）

(function (root) {
  if (typeof module !== 'undefined') {
    require('./hand_eval.js');
    require('./ranges.js');
  }

  const RangeUtils = {
    // レンジを一度だけ展開して、累積重みつきの配列にする。空なら null。
    // 戻り値: { combos: [[cardInt, cardInt], ...], cum: [...], total }
    buildSampler(rangeMap, deadCardsStr = []) {
      const { Card, Ranges } = root;
      const dead = new Set(deadCardsStr);
      const combos = [];
      const cum = [];
      let total = 0.0;
      for (const [comboStr, weight] of rangeMap) {
        if (weight <= 0.0) continue;
        for (const pair of Ranges.parseCombo(comboStr)) {
          if (!dead.has(pair[0]) && !dead.has(pair[1])) {
            combos.push(pair.map(Card.fromStr));
            total += weight;
            cum.push(total);
          }
        }
      }
      if (combos.length === 0) return null;
      return { combos, cum, total };
    },

    // Python の bisect.bisect_left(cum, r) と同じ（r 以上になる最初の位置）
    pickIndex(sampler, r) {
      const { cum, combos } = sampler;
      let lo = 0, hi = cum.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cum[mid] < r) lo = mid + 1; else hi = mid;
      }
      return Math.min(lo, combos.length - 1);
    },

    // 重み付きで1コンボ引く。rng は [0,1) を返す関数（テストで差し替えられるように）
    sampleFrom(sampler, rng = Math.random) {
      if (!sampler) return null;
      const { combos, total } = sampler;
      if (total <= 0) return combos[Math.floor(rng() * combos.length)].slice();
      return combos[RangeUtils.pickIndex(sampler, rng() * total)].slice();
    },
  };

  root.RangeUtils = RangeUtils;
  if (typeof module !== 'undefined') module.exports = RangeUtils;
})(typeof window !== 'undefined' ? window : globalThis);
