// Python と同じ数値の丸め・書式化。
//
// Python の format(x, ".1f") と round(x, n) は「x の正確な2進値」を基準に、
// ちょうど中間のときは偶数側へ丸める（0.25 → "0.2", 12.25 → "12.2"）。
// JS の toFixed は中間のとき大きい側へ丸める（0.25 → "0.3"）ので、そのままだとずれる。
// 中間でない値は toFixed も Python も「正確な値に最も近い方」なので一致する。

(function (root) {
  // format(x, `.${digits}f`) と同じ文字列を返す
  function formatFixed(x, digits) {
    if (!Number.isFinite(x)) throw new Error('formatFixed: 有限の数ではない: ' + x);
    const neg = x < 0 || Object.is(x, -0);
    const a = Math.abs(x);
    let out = a.toFixed(digits);
    // toFixed(100) は2進値の正確な10進展開（中間判定に必要な桁までは誤差が出ない）
    const exact = a.toFixed(100);
    const dot = exact.indexOf('.');
    const frac = exact.slice(dot + 1);
    const next = frac[digits];
    const rest = frac.slice(digits + 1);
    if (next === '5' && /^0*$/.test(rest)) {
      // ちょうど中間: 切り捨てた値の最終桁が偶数ならそのまま、奇数なら切り上げ（= toFixed の結果）
      const truncated = digits === 0 ? exact.slice(0, dot) : exact.slice(0, dot + 1 + digits);
      const lastDigit = Number(truncated[truncated.length - 1]);
      if (lastDigit % 2 === 0) out = truncated;
    }
    return (neg ? '-' : '') + out;
  }

  // Python の round(x, n)（n >= 0）
  function round(x, n) {
    return parseFloat(formatFixed(x, n));
  }

  const Py = { formatFixed, round };
  root.Py = Py;
  if (typeof module !== 'undefined') module.exports = Py;
})(typeof window !== 'undefined' ? window : globalThis);
