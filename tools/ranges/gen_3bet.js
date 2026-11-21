// オープンに対する 3ベットの表を、守る側・オープンした位置ごとに作り、ranges.json に書き込む（2026/11/21）。
//   node tools/ranges/gen_3bet.js          … 計算結果を表示するだけ
//   node tools/ranges/gen_3bet.js --write  … ranges.json の HJ/CO/BTN/SB/BB に vs_open_3bet_vs_<位置> を書き込む（既存の値は上書き）
//
// 以前の 3ベットの表は全ハンドの 2〜7% で、オープンした位置にもよらなかった。6人卓 100bb の解析（beyondgto.com の Defense。
// 2.5bb のオープン、SB は 3bb。3ベットは IP 2.5倍・ブラインド 3倍）では 3ベットの割合は下の TARGET（全ハンドに対する%）。
//
// 作り方（表の手を写さず、割合だけを目安にする）:
//   バリュー: オープンレンジに対する勝率（オールイン勝率）の高い順に、3ベット全体の VALUE_SHARE まで
//   ブラフ  : 残りから、ブロッカーと扱いやすさの順（スーテッドのエース A5s〜A2s → 他のスーテッドのエース → スーテッドのキング →
//             スーテッドコネクター）。3ベットのブラフは「相手の強い手を減らすブロッカー」と「コールされても後で稼げる」手を選ぶのが定石
//             （Janda "Applications of NLHE" の 3ベットの構成）
// 生成後は gen_ip_call.js と gen_blind_defend.js でコールの表を作り直す（3ベットに入った手はコールから除く）
const fs = require('fs');
const path = require('path');
const { classEquities, W, Ranges, D } = require('./lib.js');

const TARGET = {
  HJ: { UTG: 6 },
  CO: { UTG: 7, HJ: 8 },
  BTN: { UTG: 7, HJ: 8, CO: 10 },
  SB: { UTG: 6, HJ: 7, CO: 9, BTN: 13 },
  BB: { UTG: 6, HJ: 8, CO: 10, BTN: 13, SB: 17 },
};
const VALUE_SHARE = 0.6;
const ORDER = 'AKQJT98765432';

// ブラフの優先度（大きいほど先に選ぶ）。ペアとオフスートは基本ブラフにしない（広い場面だけ A5o〜A2o）
function bluffScore(c) {
  if (c.length === 2) return -1;
  const hi = c[0], lo = c[1], suited = c.endsWith('s');
  const gap = ORDER.indexOf(lo) - ORDER.indexOf(hi);
  if (!suited) return hi === 'A' && '5432'.includes(lo) ? 1 : -1;
  let s = 0;
  if (hi === 'A') s += 10 + ('5432'.includes(lo) ? 3 : 0);
  else if (hi === 'K') s += 6;
  if (gap <= 1) s += 4; else if (gap === 2) s += 2;
  return s;
}

const result = {};
let k = 0;
for (const def of Object.keys(TARGET)) {
  result[def] = {};
  for (const op of Object.keys(TARGET[def])) {
    const eqs = classEquities(Ranges.getRangeByCategory(op, 'open'), 20261122 + k++);
    const need = TARGET[def][op] / 100 * 1326;
    const out = {};
    let combos = 0;
    const add = (c, cap) => {
      const left = cap - combos;
      if (left <= 0.01) return false;
      const w = W(c) <= left ? 1.0 : Math.round(left / W(c) * 2) / 2;
      if (w <= 0) return false;
      out[c] = w; combos += W(c) * w;
      return true;
    };
    // バリュー
    const byEq = [...Ranges.ALL_HANDS_DICT.keys()].sort((a, b) => eqs.get(b) - eqs.get(a));
    for (const c of byEq) { if (combos >= need * VALUE_SHARE - 0.01) break; add(c, need * VALUE_SHARE); }
    const valueCombos = combos;
    // ブラフ
    const bluffs = [...Ranges.ALL_HANDS_DICT.keys()].filter((c) => !(c in out) && bluffScore(c) >= 0)
      .sort((a, b) => bluffScore(b) - bluffScore(a) || eqs.get(b) - eqs.get(a));
    for (const c of bluffs) { if (combos >= need - 0.01) break; add(c, need); }
    result[def][op] = out;
    console.log(`${def} vs ${op}: 3ベット ${(combos / 1326 * 100).toFixed(1)}%（目安 ${TARGET[def][op]}%。バリュー ${(valueCombos / 1326 * 100).toFixed(1)}%）`);
    console.log('   ', Object.entries(out).map(([c, w]) => w < 1 ? `${c}(${w})` : c).join(' '));
  }
}

if (process.argv.includes('--write')) {
  const file = path.join(D, 'ranges.json');
  let text = fs.readFileSync(file, 'utf8');
  const fmt = (m) => '{' + Object.entries(m).map(([c, v]) => `"${c}": ${Number.isInteger(v) ? v.toFixed(1) : v}`).join(', ') + '}';
  for (const def of Object.keys(result)) {
    const head = `  "${def}": {\n   "open": `;
    const blockStart = text.indexOf(head, text.indexOf('"ranges": {'));
    if (blockStart < 0) throw new Error(`ranges.${def} が見つからない`);
    const blockEnd = text.indexOf('\n  }', blockStart);
    let block = text.slice(blockStart, blockEnd).replace(/\n   "vs_open_3bet_vs_[A-Z]+": \{[^\n]*\},/g, '');
    const anchorStart = block.indexOf('   "vs_open_3bet": ');
    if (anchorStart < 0) throw new Error(`ranges.${def}.vs_open_3bet が見つからない`);
    const anchorEnd = block.indexOf('\n', anchorStart);
    const lines = Object.keys(result[def]).map((op) => `   "vs_open_3bet_vs_${op}": ${fmt(result[def][op])},`).join('\n');
    block = block.slice(0, anchorEnd + 1) + lines + '\n' + block.slice(anchorEnd + 1);
    text = text.slice(0, blockStart) + block + text.slice(blockEnd);
  }
  fs.writeFileSync(file, text);
  console.log('ranges.json に書き込みました');
}
