// 乱数（Python の random モジュールで使っている関数と同じインターフェース）。
//
//   Rng.real()        … 本番用。Math.random ベース。gauss は Box-Muller（Python と同じ正規分布）
//   Rng.seeded(seed)  … テスト用。tools/golden/fake_random.py と完全に同じ列・同じアルゴリズム。
//                       Python 側もこれに差し替えてベクタを作っているので、ハンド全体がビット一致する
//
// エンジン・CPU AI はこのオブジェクト経由でしか乱数を使わないこと（Math.random 直呼び禁止）。
// 乱数を読む順番も Python と同じにしてある。順番を変えるとテストが通らなくなる。

(function (root) {
  function methods(next) {
    const rng = {
      random: next,
      uniform: (a, b) => a + (b - a) * next(),
      choice: (seq) => seq[Math.floor(next() * seq.length)],
      // 部分 Fisher-Yates（コピーを並べ替えて先頭 k 個）
      sample: (population, k) => {
        const a = population.slice();
        const n = a.length;
        for (let i = 0; i < k; i++) {
          const j = i + Math.floor(next() * (n - i));
          const t = a[i]; a[i] = a[j]; a[j] = t;
        }
        return a.slice(0, k);
      },
      shuffle: (x) => {
        for (let i = x.length - 1; i > 0; i--) {
          const j = Math.floor(next() * (i + 1));
          const t = x[i]; x[i] = x[j]; x[j] = t;
        }
      },
      // Python の random.choices(population, weights, k=1)（累積重み + bisect_right）
      choices: (population, weights) => {
        const cum = [];
        let acc = 0;
        for (const w of weights) { acc += w; cum.push(acc); }
        const r = next() * acc;
        let lo = 0, hi = cum.length - 1;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (r < cum[mid]) hi = mid; else lo = mid + 1;
        }
        return [population[lo]];
      },
    };
    return rng;
  }

  const Rng = {
    real() {
      const rng = methods(Math.random);
      rng.gauss = (mu, sigma) => {
        // Box-Muller（1 - u で log(0) を避ける）
        const u1 = 1 - Math.random(), u2 = Math.random();
        return mu + sigma * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      };
      return rng;
    },

    seeded(seed) {
      let state = seed >>> 0;
      let count = 0;
      const next = () => {
        count++;
        state = (state + 0x6D2B79F5) >>> 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      const rng = methods(next);
      // テスト専用の近似（log/cos を使わず、Python とビット一致させるため）
      rng.gauss = (mu, sigma) => {
        let z = 0.0;
        for (let i = 0; i < 12; i++) z += next();
        return mu + sigma * (z - 6.0);
      };
      rng.count = () => count;
      return rng;
    },
  };

  root.Rng = Rng;
  if (typeof module !== 'undefined') module.exports = Rng;
})(typeof window !== 'undefined' ? window : globalThis);
