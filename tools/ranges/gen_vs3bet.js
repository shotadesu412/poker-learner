// オープンした後に 3ベットされたときの表（4ベット・コール）を、オープンした位置 × 3ベットした位置ごとに作り、ranges.json に書き込む（2026/11/21）。
//   node tools/ranges/gen_vs3bet.js          … 計算結果を表示するだけ
//   node tools/ranges/gen_vs3bet.js --write  … ranges.json の UTG/HJ/CO/BTN/SB に vs_3bet_4bet_vs_<位置> / vs_3bet_call_vs_<位置> を書き込む
//
// 以前の表（vs_3bet_call / vs_3bet_4bet）は位置によらず、オープンした手の約2割しか続けず（約8割降りる）、理論より大幅に降りすぎだった。
// 6人卓 100bb の解析（beyondgto.com「3-bet poker strategy」。3ベットは IP 2.5倍・ブラインド 3倍）では、オープンした人が降りるのは
// 19〜47%。コールと 4ベットの割合（オープンしたレンジに対する%）を下の TARGET に合わせ、どの手かは次の順で選ぶ（表の手は写さない）:
//   4ベット: 3ベットのレンジに対する勝率の高い順に 4ベット全体の VALUE_SHARE、残りはブロッカーのある手（gen_3bet.js と同じ優先度）
//   コール : 残りを「3ベットのレンジに対する勝率 × 実現率」の高い順。ブラインドに 3ベットされたら IP、それ以外は OOP の実現率
// 表の値は「その手でオープンしていたときに、その行動を取る割合」（0〜1。オープンの重みで割ったもの）
const fs = require('fs');
const path = require('path');
const { classEquities, realizationIp, realizationOop, W, Ranges, D } = require('./lib.js');

// [コール%, 4ベット%]（オープンしたレンジに対する%）
const TARGET = {
  UTG: { HJ: [62, 16], CO: [63, 16], BTN: [64, 16], SB: [66, 11], BB: [66, 10] },
  HJ: { CO: [59, 15], BTN: [61, 16], SB: [64, 10], BB: [64, 10] },
  CO: { BTN: [57, 16], SB: [64, 9], BB: [57, 12] },
  BTN: { SB: [58, 10], BB: [56, 10] },
  SB: { BB: [38, 16] },
};
const VALUE_SHARE = 0.6;
const ORDER = 'AKQJT98765432';
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
for (const op of Object.keys(TARGET)) {
  result[op] = {};
  const open = Ranges.getRangeByCategory(op, 'open');
  const openCombos = [...open.entries()].reduce((s, [c, w]) => s + W(c) * w, 0);
  for (const tb of Object.keys(TARGET[op])) {
    const three = Ranges.getRangeByCategory(tb, 'vs_open_3bet', op);
    const eqs = classEquities(three, 20261123 + k++);
    const [callPct, fourPct] = TARGET[op][tb];
    const ip = tb === 'SB' || tb === 'BB';   // ブラインドに 3ベットされたら、オープンした側が IP（SB vs BB は OOP）
    const R = (c) => (ip && op !== 'SB' ? realizationIp(c) : realizationOop(c));
    const four = {}, call = {};
    // 残っているオープンの重み（クラスごと）
    const left = new Map([...open.entries()].filter(([, w]) => w > 0));
    let used = 0;
    const take = (c, target, into) => {
      const avail = left.get(c) || 0;
      if (avail <= 0) return;
      const room = target - used;
      if (room <= 0.01) return;
      const w = Math.min(avail, Math.round(Math.min(avail * W(c), room) / W(c) * 2) / 2 || 0.5);
      into[c] = (into[c] || 0) + w; left.set(c, avail - w); used += W(c) * w;
    };
    const need4 = fourPct / 100 * openCombos, needC = callPct / 100 * openCombos;
    const byEq = [...left.keys()].sort((a, b) => eqs.get(b) - eqs.get(a));
    for (const c of byEq) { if (used >= need4 * VALUE_SHARE - 0.01) break; take(c, need4 * VALUE_SHARE, four); }
    const bl = [...left.keys()].filter((c) => (left.get(c) || 0) > 0 && bluffScore(c) >= 0)
      .sort((a, b) => bluffScore(b) - bluffScore(a) || eqs.get(b) - eqs.get(a));
    for (const c of bl) { if (used >= need4 - 0.01) break; take(c, need4, four); }
    const fourUsed = used;
    used = 0;
    const byReal = [...left.keys()].filter((c) => (left.get(c) || 0) > 0).sort((a, b) => eqs.get(b) * R(b) - eqs.get(a) * R(a));
    for (const c of byReal) { if (used >= needC - 0.01) break; take(c, needC, call); }
    // 表の値は「オープンしていたときにその行動を取る割合」
    const cond = (m) => Object.fromEntries(Object.entries(m).map(([c, w]) => [c, Math.round(Math.min(1, w / open.get(c)) * 100) / 100]));
    result[op][tb] = { four: cond(four), call: cond(call) };
    console.log(`${op} が ${tb} に3ベットされた: 4ベット ${(fourUsed / openCombos * 100).toFixed(0)}%（目安 ${fourPct}%）/ コール ${(used / openCombos * 100).toFixed(0)}%（目安 ${callPct}%）`);
    console.log('    4ベット:', Object.keys(four).join(' '));
  }
}

if (process.argv.includes('--write')) {
  const file = path.join(D, 'ranges.json');
  let text = fs.readFileSync(file, 'utf8');
  const fmt = (m) => '{' + Object.entries(m).map(([c, v]) => `"${c}": ${Number.isInteger(v) ? v.toFixed(1) : v}`).join(', ') + '}';
  for (const op of Object.keys(result)) {
    const head = `  "${op}": {\n   "open": `;
    const blockStart = text.indexOf(head, text.indexOf('"ranges": {'));
    if (blockStart < 0) throw new Error(`ranges.${op} が見つからない`);
    const blockEnd = text.indexOf('\n  }', blockStart);
    let block = text.slice(blockStart, blockEnd).replace(/\n   "vs_3bet_(call|4bet)_vs_[A-Z]+": \{[^\n]*\},/g, '');
    const anchorStart = block.indexOf('   "vs_3bet_4bet": ');
    if (anchorStart < 0) throw new Error(`ranges.${op}.vs_3bet_4bet が見つからない`);
    const anchorEnd = block.indexOf('\n', anchorStart);
    const lines = Object.keys(result[op]).map((tb) =>
      `   "vs_3bet_4bet_vs_${tb}": ${fmt(result[op][tb].four)},\n   "vs_3bet_call_vs_${tb}": ${fmt(result[op][tb].call)},`).join('\n');
    block = block.slice(0, anchorEnd + 1) + lines + '\n' + block.slice(anchorEnd + 1);
    text = text.slice(0, blockStart) + block + text.slice(blockEnd);
  }
  fs.writeFileSync(file, text);
  console.log('ranges.json に書き込みました');
}
