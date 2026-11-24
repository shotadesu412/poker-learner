// CPU の打ち方を GTO と比べる（あなたがチェックした後の CPU（IP））。
//   node tools/solver_compare/calib_analyze.js <spots.jsonl（CALIB=1）> <solve_calib の出力.jsonl> [出力.json]
// CPU のレンジの各コンボを「レンジの中での手の強さの順位」（強い方から 0〜100%）で10段に分け、段ごとに
//   ・各サイズで打つ頻度（アプリの CPU / GTO）
//   ・打った後に、あなたの3倍のチェックレイズへ降りる確率
// を比べる（SPR 1.7 以上の局面。CPU のサイズは 75% と 100%）。どちらも CPU のレンジの重み（降りる確率は、そのサイズで打つ重み）で平均する。
// 両者のレンジは同じ（export_spots の cpuRange をそのままソルバーに渡している）ので、順位の段はそのまま比べられる。
const fs = require('fs');
const [, , SPOTS, RES, OUTJSON] = process.argv;
const norm = (c) => [c.slice(0, 2), c.slice(2, 4)].sort().join('');
const res = new Map(fs.readFileSync(RES, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => !r.error).map((r) => [r.id, r]));

const NB = 10;
const acc = {};   // size → { m: {bet[], fold[], fw[]}, g: {...}, w[] }
const tot = { w: 0 };
const get = (k) => (acc[k] = acc[k] || { w: Array(NB).fill(0), mb: Array(NB).fill(0), gb: Array(NB).fill(0), mfw: Array(NB).fill(0), mf: Array(NB).fill(0), gfw: Array(NB).fill(0), gf: Array(NB).fill(0) });
let spots = 0;
for (const l of fs.readFileSync(SPOTS, 'utf8').trim().split('\n')) {
  const s = JSON.parse(l);
  const r = res.get(s.id);
  if (!s.calib || !r) continue;
  // CPU のサイズがオールインに変わる浅い局面（SPR 1.7 未満）は、サイズの比べ方が変わるので除く
  if (s.stack / s.pot < 1.7) continue;
  const sz = s.calib.sizes;
  // ソルバーのサイズ（75・100）とアプリのサイズを額で対応づける。アプリが打たないサイズは頻度 0
  const all = [...new Set([...sz, ...r.sizes])];
  const rows = s.calib.combos.filter((c) => r.combos[norm(c[0])]);
  if (!rows.length) continue;
  spots++;
  // レンジの中での強さの順位（重み付き。強い方から）
  const sorted = [...rows].sort((a, b) => b[2] - a[2]);
  const W = rows.reduce((a, c) => a + c[1], 0);
  let cum = 0;
  const pctOf = new Map();
  for (let i = 0; i < sorted.length;) {
    let j = i, w = 0;
    while (j < sorted.length && sorted[j][2] === sorted[i][2]) { w += sorted[j][1]; j++; }
    const mid = (cum + w / 2) / W;
    for (let k = i; k < j; k++) pctOf.set(sorted[k][0], mid);
    cum += w; i = j;
  }
  for (const c of rows) {
    const b = Math.min(NB - 1, Math.floor(pctOf.get(c[0]) * NB));
    const w = c[1] / W;   // 局面ごとにレンジの重みを 1 にそろえる
    const [gs, gfold] = r.combos[norm(c[0])];
    tot.w += w;
    for (const k of all) {
      const a = get(k);
      const mi = sz.indexOf(k), gi = r.sizes.indexOf(k);
      const mp = mi >= 0 ? c[4 + mi] : 0;
      const mf = mi >= 0 ? c[4 + sz.length + mi] : null;
      const gp = gi >= 0 ? gs[1 + gi] : 0;
      const gf = gi >= 0 ? gfold[gi] : null;
      a.w[b] += w; a.mb[b] += w * mp; a.gb[b] += w * gp;
      if (mf !== null && mp > 0) { a.mfw[b] += w * mp; a.mf[b] += w * mp * mf; }
      if (gf !== null && gf !== undefined && gp > 0) { a.gfw[b] += w * gp; a.gf[b] += w * gp * gf; }
    }
  }
}

const pc = (x) => (Number.isFinite(x) ? (x * 100).toFixed(0).padStart(4) + '%' : '    -');
const out = { spots, sizes: {} };
console.log(`局面 ${spots}`);
for (const k of Object.keys(acc).sort((a, b) => a - b)) {
  const a = acc[k];
  const sum = (xs) => xs.reduce((p, q) => p + q, 0);
  const mBet = sum(a.mb) / sum(a.w), gBet = sum(a.gb) / sum(a.w);
  const mFold = sum(a.mf) / sum(a.mfw), gFold = sum(a.gf) / sum(a.gfw);
  // 打つレンジのうち、下位5割（ブラフ側）の割合
  const mBl = sum(a.mb.slice(5)) / sum(a.mb), gBl = sum(a.gb.slice(5)) / sum(a.gb);
  console.log(`\n== ポットの${k}% ==  打つ頻度 アプリ${pc(mBet)} / GTO${pc(gBet)}   打つ手のうち下位5割 アプリ${pc(mBl)} / GTO${pc(gBl)}   3倍のチェックレイズに降りる アプリ${pc(mFold)} / GTO${pc(gFold)}`);
  console.log('順位(強い方から)   打つ:アプリ   GTO    降りる:アプリ   GTO');
  for (let b = 0; b < NB; b++) {
    console.log(`${String(b * 10).padStart(3)}-${String(b * 10 + 10).padStart(3)}%        ${pc(a.mb[b] / a.w[b])}  ${pc(a.gb[b] / a.w[b])}          ${pc(a.mf[b] / a.mfw[b])}  ${pc(a.gf[b] / a.gfw[b])}`);
  }
  out.sizes[k] = { mBet, gBet, mBluffShare: mBl, gBluffShare: gBl, mFold, gFold,
    byDecile: a.w.map((w, b) => ({ mBet: a.mb[b] / w, gBet: a.gb[b] / w, mFold: a.mf[b] / a.mfw[b], gFold: a.gf[b] / a.gfw[b] })) };
}
if (OUTJSON) fs.writeFileSync(OUTJSON, JSON.stringify(out, null, 2));
