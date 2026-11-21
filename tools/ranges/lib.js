// tools/ranges の生成スクリプトで共通に使う部品（2026/11/21〜）
//   classEquities(openMap, seed) … ハンド名ごとの、オープンレンジに対するオールイン勝率（固定の乱数で 6000 回のモンテカルロ）
//   realizationIp(cls)            … IP でコールしたときの実現率の目安
//   W(cls)                        … ハンド名のコンボ数（ペア 6・スーテッド 4・オフスート 12）
const path = require('path');
const D = path.join(path.resolve(__dirname, '..', '..'), 'static', 'poker') + '/';
require(D + 'rng.js'); require(D + 'game.js');
const { RangeModel: RM, Ranges, Card, HandEvaluator: HE, Rng } = globalThis;

const SAMPLES = 6000;
const ORDER = 'AKQJT98765432';
const W = (c) => (c.length === 2 ? 6 : c.endsWith('s') ? 4 : 12);

// IP でコールしたときの実現率（勝率のうち回収できる割合）の目安。
// IP のスーテッドの手は、後のストリートでドローやバックドアから追加で稼げるので 1 を超える（Janda "Applications of NLHE" の
// エクイティ実現率の考え方。IP のスーテッドコネクターは 100% を超え、オフスートの弱いブロードウェイは強いレンジに支配されて下回る）。
// 最初は BB の OOP の目安 + 0.15 で作ったが、98s のような BTN の典型的なコールが入らず、ATo・KJo が入ったため見直した（2026/11/21）
function realizationIp(cls) {
  const pair = cls.length === 2, suited = cls.endsWith('s');
  const hi = ORDER.indexOf(cls[0]), lo = ORDER.indexOf(cls[1]);
  const gap = lo - hi, broadway = lo <= 4;
  if (pair) return 0.95;
  if (suited) return gap <= 2 || broadway ? 1.08 : 0.95;
  if (broadway) return 0.85;
  if (gap <= 1 && lo <= 9) return 0.80;
  return 0.72;
}

// gen_blind_defend.js と同じ（ハンド名ごとのオープンレンジに対するオールイン勝率）
function classEquities(openMap, seed) {
  const rng = Rng.seeded(seed);
  const deck52 = [];
  for (const r of Card.STR_RANKS) for (const s of 'shdc') deck52.push(Card.fromStr(r + s));
  const vec = RM.toVec(openMap), combos = RM.combos();
  const opp = [], cum = [];
  let tot = 0;
  for (let i = 0; i < RM.N; i++) if (vec[i] > 0) { opp.push(combos[i]); tot += vec[i]; cum.push(tot); }
  const out = new Map();
  for (const cls of Ranges.ALL_HANDS_DICT.keys()) {
    const pairs = Ranges.parseCombo(cls).map((p) => p.map(Card.fromStr));
    let s = 0;
    for (let it = 0; it < SAMPLES; it++) {
      const h = pairs[it % pairs.length];
      let o;
      do {
        const r = rng.random() * tot;
        let a = 0, b = cum.length - 1;
        while (a < b) { const m = (a + b) >> 1; if (cum[m] < r) a = m + 1; else b = m; }
        o = opp[a];
      } while (o.includes(h[0]) || o.includes(h[1]));
      const used = new Set([...h, ...o]);
      const board = rng.sample(deck52.filter((c) => !used.has(c)), 5);
      const x = HE.evaluate(board, h), y = HE.evaluate(board, o);
      s += x < y ? 1 : x === y ? 0.5 : 0;
    }
    out.set(cls, s / SAMPLES);
  }
  return out;
}


// OOP でコールしたときの実現率の目安（gen_blind_defend.js と同じ）
function realizationOop(cls) {
  const pair = cls.length === 2, suited = cls.endsWith('s');
  const hi = ORDER.indexOf(cls[0]), lo = ORDER.indexOf(cls[1]);
  const gap = lo - hi, broadway = lo <= 4;
  if (pair) return 0.80;
  if (suited) return gap <= 2 || broadway ? 0.85 : 0.75;
  if (broadway) return 0.75;
  if (gap <= 1 && lo <= 9) return 0.68;
  return 0.62;
}

const pct = (m) => [...m.entries()].reduce((s, [c, w]) => s + W(c) * w, 0) / 1326 * 100;
module.exports = { classEquities, realizationIp, realizationOop, W, pct, Ranges, D };
