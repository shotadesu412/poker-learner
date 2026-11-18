// BB と SB の「オープンに対するコールレンジ」をオープンした位置ごとに作り、ranges.json に書き込む（2026/11/17）。
//   node tools/ranges/gen_blind_defend.js          … 計算結果を表示するだけ
//   node tools/ranges/gen_blind_defend.js --write  … ranges.json の BB/SB に vs_open_call_vs_<位置> を書き込む（既存の値は上書き）
//
// SB: 6人卓の標準チャートは SB を「3ベットかフォールド」にする（後ろの BB にスクイーズされるため）。
// あなたの判定はその理論どおり（2026/11/18 shota 指定。evaluator.js の preflopSpot は SB の vs_open_call_vs_* を使わない）。
// SB の vs_open_call_vs_* は、CPU が SB でコールするとき（仕様で CPU はオープンに降りない）の手札と、
// あなたが SB でコールしたときのレンジ推定にだけ使う。2人の勝負ならコールで得になる手（監査で勝率40%以上のコールは
// フォールドより +0.97bb）を、BB と同じ方法で選んでいる。
//
// 以前の BB のコールレンジ（vs_open_call）は全ハンドの約21%で、オープンした位置にかかわらず共通だった。
// 公開されている 6max 100bb の解析では BB は BTN のオープンに 45〜70% 程度で守る。大量ハンドの検証でも、
// 表の外（勝率30〜60%）のコールがフォールドより平均 +0.4〜+2.5bb 得だった。
//
// 作り方（ポットオッズ + エクイティ実現率。Janda "Applications of No-Limit Hold'em" の考え方）:
//   必要勝率 = (オープン額 − 1) ÷ (オープン額 × 2 + 0.5)        … BB が追加で払う額 ÷ コール後のポット
//   ハンドのオープンレンジに対する勝率（オールイン勝率）× 実現率 ≥ 必要勝率 ならコール
//   実現率は OOP の BB の目安: ペア 0.80 / スーテッドのコネクター・ブロードウェイ 0.85 / その他スーテッド 0.75 /
//   オフスートのブロードウェイ 0.75 / オフスートのコネクター 0.68 / その他オフスート 0.62
//   既存の表（vs_open_call）のハンドは残し、3ベットのレンジ（vs_open_3bet）のハンドは足さない。
// 勝率は固定の乱数で 6000 回のモンテカルロ（同じ入力なら毎回同じ結果）。
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..', '..');
const D = path.join(ROOT, 'static', 'poker') + '/';
require(D + 'rng.js'); require(D + 'game.js');
const { RangeModel: RM, Ranges, Card, HandEvaluator: HE, Rng, BetSizing } = globalThis;

const SAMPLES = 6000;
const OPENERS = ['UTG', 'HJ', 'CO', 'BTN', 'SB'];
const ORDER = 'AKQJT98765432';
const W = (c) => (c.length === 2 ? 6 : c.endsWith('s') ? 4 : 12);

function realization(cls) {
  const pair = cls.length === 2, suited = cls.endsWith('s');
  const hi = ORDER.indexOf(cls[0]), lo = ORDER.indexOf(cls[1]);
  const gap = lo - hi, broadway = lo <= 4;
  if (pair) return 0.80;
  if (suited) return gap <= 2 || broadway ? 0.85 : 0.75;
  if (broadway) return 0.75;
  if (gap <= 1 && lo <= 9) return 0.68;
  return 0.62;
}

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

const result = { BB: {}, SB: {} };
// オープンの総額（SB は自分のブラインド 0.5 にオープン額を足す。エンジンと同じ）
const openTotal = (op) => BetSizing.PREFLOP_OPENS[op] + (op === 'SB' ? 0.5 : 0);
let k = 0;
for (const defender of ['BB', 'SB']) {
  const chartCall = Ranges.getRangeByCategory(defender, 'vs_open_call');
  const chart3 = Ranges.getRangeByCategory(defender, 'vs_open_3bet');
  // SB の vs_open_call は空で、getRangeByCategory が call ∪ 3bet に合成する。表のコールは無いものとして扱う
  const callChart = defender === 'SB' ? new Map() : chartCall;
  for (const op of OPENERS) {
    if (op === defender) continue;
    if (defender === 'SB' && op === 'SB') continue;
    if (defender === 'SB' && !['UTG', 'HJ', 'CO', 'BTN'].includes(op)) continue;
    const size = openTotal(op);
    const posted = defender === 'BB' ? 1.0 : 0.5;
    const dead = defender === 'BB' ? (op === 'SB' ? 0 : 0.5) : 1.0;   // 降りた側のブラインド
    const req = (size - posted) / (size * 2 + dead);
    const eqs = classEquities(Ranges.getRangeByCategory(op, 'open'), 20261117 + k++);
    const call = {};
    let combos = 0;
    for (const cls of Ranges.ALL_HANDS_DICT.keys()) {
      const inCall = (callChart.get(cls) || 0) > 0;
      const in3 = (chart3.get(cls) || 0) > 0;
      if (inCall) call[cls] = callChart.get(cls);
      // BB vs SB だけはポストフロップで BB が後に動く（IP）。IP の実現率は OOP より約0.15高い（上限1.0）
      const R = defender === 'BB' && op === 'SB' ? Math.min(1.0, realization(cls) + 0.15) : realization(cls);
      if (!inCall && !in3 && eqs.get(cls) * R >= req) call[cls] = 1.0;
      if (call[cls] || in3) combos += W(cls) * Math.max(call[cls] || 0, in3 ? chart3.get(cls) : 0);
    }
    result[defender][op] = call;
    console.log(`${defender} vs ${op}: オープン ${size}bb / 必要勝率 ${(req * 100).toFixed(1)}% / 守る割合（コール+3ベット）${(combos / 1326 * 100).toFixed(1)}%`);
  }
}

if (process.argv.includes('--write')) {
  const file = path.join(D, 'ranges.json');
  let text = fs.readFileSync(file, 'utf8');
  const fmt = (m) => '{' + Object.entries(m).map(([k, v]) => `"${k}": ${Number.isInteger(v) ? v.toFixed(1) : v}`).join(', ') + '}';
  text = text.replace(/\n   "vs_open_call_vs_[A-Z]+": \{[^\n]*\},/g, '');
  for (const defender of ['BB', 'SB']) {
    const head = `  "${defender}": {\n   "open": `;
    const blockStart = text.indexOf(head, text.indexOf('"ranges": {'));
    if (blockStart < 0) throw new Error(`ranges.${defender} が見つからない`);
    const anchorStart = text.indexOf('   "vs_open_call": ', blockStart);
    const anchorEnd = text.indexOf('\n', anchorStart);
    const lines = Object.keys(result[defender]).map((op) => `   "vs_open_call_vs_${op}": ${fmt(result[defender][op])},`).join('\n');
    text = text.slice(0, anchorEnd + 1) + lines + '\n' + text.slice(anchorEnd + 1);
  }
  fs.writeFileSync(file, text);
  console.log('ranges.json に書き込みました');
}
