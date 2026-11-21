// HJ・CO・BTN の「オープンに対するコールレンジ」を、オープンした位置ごとに作り、ranges.json に書き込む（2026/11/21）。
//   node tools/ranges/gen_ip_call.js          … 計算結果を表示するだけ
//   node tools/ranges/gen_ip_call.js --write  … ranges.json の HJ/CO/BTN に vs_open_call_vs_<位置> を書き込む（既存の値は上書き）
//
// 以前の HJ・CO・BTN のコールレンジは全ハンドの約6%で、3席とも同じ・オープンした位置にもよらなかった。
// 6人卓 100bb の解析（beyondgto.com の Defense。2.5bb のオープンに対する解）では、コール（フラット）の割合は
//   HJ vs UTG 4% / CO vs UTG 5% / CO vs HJ 5% / BTN vs UTG 7% / BTN vs HJ 8% / BTN vs CO 9%
// BTN は必ずポジションを取れるのでコールが多く、HJ・CO は後ろにスクイーズされる人が多いので少ない。
//
// 作り方: コールする割合（上の数字）は解析に合わせ、どの手でコールするかは BB のコールレンジ（gen_blind_defend.js）と同じ考え方で選ぶ。
//   オープンレンジに対する勝率（オールイン勝率）× IP の実現率 の高い順に、3ベットの表に入っている手を除いて、割合に達するまで入れる。
//   表の手を写すのではなく、割合だけを目安にする。実現率は下の realizationIp（IP の目安）
// 勝率は固定の乱数で 6000 回のモンテカルロ（同じ入力なら毎回同じ結果）。
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const D = path.join(ROOT, 'static', 'poker') + '/';
require(D + 'rng.js'); require(D + 'game.js');
const { RangeModel: RM, Ranges, Card, HandEvaluator: HE, Rng } = globalThis;

const SAMPLES = 6000;
const ORDER = 'AKQJT98765432';
const W = (c) => (c.length === 2 ? 6 : c.endsWith('s') ? 4 : 12);
// 解析のコールの割合（全ハンドに対する%）
const TARGET = {
  HJ: { UTG: 4 },
  CO: { UTG: 5, HJ: 5 },
  BTN: { UTG: 7, HJ: 8, CO: 9 },
};

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

const result = {};
let k = 0;
for (const defender of Object.keys(TARGET)) {
  result[defender] = {};
  for (const op of Object.keys(TARGET[defender])) {
    // 3ベットの表はオープンした位置ごと（gen_3bet.js。先に作っておく）
    const three = Ranges.getRangeByCategory(defender, 'vs_open_3bet', op);
    const eqs = classEquities(Ranges.getRangeByCategory(op, 'open'), 20261121 + k++);
    const cands = [...Ranges.ALL_HANDS_DICT.keys()]
      .filter((c) => !((three.get(c) || 0) > 0))
      .map((c) => ({ c, score: eqs.get(c) * realizationIp(c) }))
      .sort((a, b) => b.score - a.score);
    const need = TARGET[defender][op] / 100 * 1326;
    const call = {};
    let combos = 0;
    for (const { c } of cands) {
      if (combos >= need - 0.01) break;
      const left = need - combos;
      const w = W(c) <= left ? 1.0 : Math.round(left / W(c) * 2) / 2;   // 最後の1つは 0.5 単位で混ぜる
      if (w <= 0) break;
      call[c] = w;
      combos += W(c) * w;
    }
    result[defender][op] = call;
    const three3 = [...three.entries()].reduce((s, [c, w]) => s + W(c) * w, 0) / 1326 * 100;
    console.log(`${defender} vs ${op}: コール ${(combos / 1326 * 100).toFixed(1)}%（目安 ${TARGET[defender][op]}%）/ 3ベット（今の表）${three3.toFixed(1)}%`);
    console.log('   ', Object.keys(call).join(' '));
  }
}

if (process.argv.includes('--write')) {
  const file = path.join(D, 'ranges.json');
  let text = fs.readFileSync(file, 'utf8');
  const fmt = (m) => '{' + Object.entries(m).map(([c, v]) => `"${c}": ${Number.isInteger(v) ? v.toFixed(1) : v}`).join(', ') + '}';
  for (const defender of Object.keys(result)) {
    const head = `  "${defender}": {\n   "open": `;
    const blockStart = text.indexOf(head, text.indexOf('"ranges": {'));
    if (blockStart < 0) throw new Error(`ranges.${defender} が見つからない`);
    const blockEnd = text.indexOf('\n  }', blockStart);
    // 既存の vs_open_call_vs_* を消してから、vs_open_call の行の下に入れる
    let block = text.slice(blockStart, blockEnd).replace(/\n   "vs_open_call_vs_[A-Z]+": \{[^\n]*\},/g, '');
    const anchorStart = block.indexOf('   "vs_open_call": ');
    if (anchorStart < 0) throw new Error(`ranges.${defender}.vs_open_call が見つからない`);
    const anchorEnd = block.indexOf('\n', anchorStart);
    const lines = Object.keys(result[defender]).map((op) => `   "vs_open_call_vs_${op}": ${fmt(result[defender][op])},`).join('\n');
    block = block.slice(0, anchorEnd + 1) + lines + '\n' + block.slice(anchorEnd + 1);
    text = text.slice(0, blockStart) + block + text.slice(blockEnd);
  }
  fs.writeFileSync(file, text);
  console.log('ranges.json に書き込みました');
}
