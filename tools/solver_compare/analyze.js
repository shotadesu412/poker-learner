// export_spots.js（Poker Rush の判定）と solve_spots.js（GTOpen の解）を突き合わせて集計する。
//   node tools/solver_compare/analyze.js <spots.jsonl> <results.jsonl> <出力フォルダ>
// 出力: spots.csv（1局面1行）、options.csv（1局面×1アクション）、summary.json、summary.md
//
// 指標（すべて「あなたの手札」について。ソルバーの EV は均衡（相手も GTO）での値）:
//   EV Loss        = ソルバーの最善アクションの EV − Poker Rush が推奨したアクションの EV（bb と ポット比）
//   Action Match   = Poker Rush の推奨アクションを GTO が取る頻度（混合戦略を1つの正解にしない）
//   Type Match     = チェック/ベットの種類だけで見た頻度（サイズ違いを除く）
//   Distance       = Poker Rush の推奨（1つの手に確率1）と GTO の頻度の差（全変動距離 = 1 − Action Match）
//   判定の当たり方 = Poker Rush の ◎◯△× ごとの、ソルバー上の EV 損失
// ソルバーの収束度（exploit_pct。ポット比）以下の差は誤差とみなし、EV Loss の判定では「ほぼ同じ」に入れる。
const fs = require('fs');
const path = require('path');
const [, , SPOTS, RES, OUTDIR] = process.argv;
fs.mkdirSync(OUTDIR, { recursive: true });

const spots = new Map(fs.readFileSync(SPOTS, 'utf8').trim().split('\n').map((l) => { const o = JSON.parse(l); return [o.id, o]; }));
const results = fs.readFileSync(RES, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((r) => !r.error && spots.has(r.id));

// 重大度（ポット比の EV 損失）。アプリの判定の閾値（2/7/15%）に、30% を足した5段階
const SEV = [[0.02, 'ok'], [0.07, 'small'], [0.15, 'medium'], [0.30, 'large'], [Infinity, 'huge']];
const sev = (x) => SEV.find(([t]) => x <= t)[1];

// Poker Rush のアクション → ソルバーのアクション（種類と額で対応づけ）
function matchAction(solver, a) {
  if (a.action === 'CHECK') return solver.find((s) => s.kind === 'check' || /^check/i.test(s.label));
  const bets = solver.filter((s) => !(s.kind === 'check' || /^check/i.test(s.label)));
  let best = null;
  for (const s of bets) if (!best || Math.abs(s.amount - a.amount) < Math.abs(best.amount - a.amount)) best = s;
  return best && Math.abs(best.amount - a.amount) <= Math.max(0.15, a.amount * 0.03) ? best : null;
}
const isCheck = (s) => s.kind === 'check' || /^check/i.test(s.label);

const rows = [], optRows = [];
let unmatched = 0;
for (const r of results) {
  const s = spots.get(r.id);
  const pot = s.pot;
  const evs = r.solver.map((a) => a.ev);
  const bestEv = Math.max(...evs);
  const rec = matchAction(r.solver, s.pr.best);
  if (!rec) { unmatched++; continue; }
  const loss = bestEv - rec.ev;
  const lossPct = loss / pot;
  const noise = (r.exploit_pct || 0) / 100;
  const gtoCheck = r.solver.filter(isCheck).reduce((a, x) => a + x.freq, 0);
  const gtoBet = 1 - gtoCheck;
  const prBets = s.pr.best.action !== 'CHECK';
  const typeMatch = prBets ? gtoBet : gtoCheck;
  const eqBand = s.eq >= 0.65 ? 'strong' : s.eq >= 0.35 ? 'medium' : 'weak';
  const f = s.facts || {};
  const heroNut = f.nutH >= 1.5 * f.nutC && f.nutH - f.nutC >= 0.05;
  const cpuNut = f.nutC >= 1.5 * f.nutH && f.nutC - f.nutH >= 0.05;
  const rangeAdv = heroNut ? 'hero_nut_adv' : cpuNut ? 'cpu_nut_adv' : 'even';
  // Poker Rush が理論の基本として決めている扱い（ソルバーとずれても方針として残すかを shota が判断する部分）:
  //   ドンクの場面（前のストリートの主導権が CPU）では、予測の得がポットの10%以上でないとチェックを推奨する
  const donkRule = s.prevAggressor === 'CPU';
  const row = {
    id: s.id, street: s.street, board: s.board, hero: s.hero, heroPos: s.heroPos, cpuPos: s.cpuPos,
    pot, stack: s.stack, spr: s.stack / pot, threeBetPot: s.threeBetPot, prevAggressor: s.prevAggressor, donkRule,
    eq: s.eq, eqBand, category: s.category, rangeAdv, nutH: f.nutH, nutC: f.nutC, weakC: f.weakC,
    heroWeightRel: r.heroWeightRel, unusual: !(r.heroWeightRel >= 0.01),
    prAction: s.pr.best.action, prAmount: s.pr.best.amount, prSizePct: s.pr.best.amount / pot,
    gtoBest: r.solver[evs.indexOf(bestEv)].label, gtoCheck, gtoBet,
    actionMatch: rec.freq, typeMatch, distance: 1 - rec.freq,
    lossBb: loss, lossPct, withinNoise: lossPct <= noise + 0.005, severity: sev(lossPct),
    overBet: prBets && gtoCheck >= 0.5, overCheck: !prBets && gtoBet >= 0.5,
    exploitPct: r.exploit_pct, iterations: r.iterations, cpuStabModel: s.cpuStabModel, cpuStabGto: r.ipStab,
    prEvRec: (s.pr.options.find((o) => o.action === s.pr.best.action && Math.abs(o.amount - s.pr.best.amount) < 0.06) || {}).ev,
    gtoEvRec: rec.ev, gtoEvBest: bestEv,
  };
  rows.push(row);
  for (const o of s.pr.options) {
    const m = matchAction(r.solver, o);
    if (!m) continue;
    optRows.push({ id: s.id, action: o.action, amount: o.amount, grade: o.grade, prEv: o.ev, gtoEv: m.ev, gtoFreq: m.freq,
      gtoLossPct: (bestEv - m.ev) / pot, prLossPct: (Math.max(...s.pr.options.map((x) => x.ev)) - o.ev) / pot, eqBand, donkRule });
  }
}

// ---- 集計 ----
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN);
const median = (xs) => { if (!xs.length) return NaN; const a = [...xs].sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
const pct = (x) => (x * 100).toFixed(1) + '%';
function stats(rs) {
  return {
    n: rs.length,
    evLossMeanBb: mean(rs.map((r) => r.lossBb)), evLossMedianBb: median(rs.map((r) => r.lossBb)),
    evLossMeanPct: mean(rs.map((r) => r.lossPct)), evLossMedianPct: median(rs.map((r) => r.lossPct)),
    actionMatch: mean(rs.map((r) => r.actionMatch)), typeMatch: mean(rs.map((r) => r.typeMatch)),
    majorRate: mean(rs.map((r) => (r.lossPct > 0.07 ? 1 : 0))),
    severity: Object.fromEntries(SEV.map(([, k]) => [k, rs.filter((r) => r.severity === k).length])),
    overBetRate: mean(rs.map((r) => (r.overBet ? 1 : 0))), overCheckRate: mean(rs.map((r) => (r.overCheck ? 1 : 0))),
  };
}
const by = (key, rs = rows) => { const m = {}; for (const r of rs) (m[r[key]] = m[r[key]] || []).push(r); return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, stats(v)])); };
const gradeCal = {};
for (const o of optRows) (gradeCal[o.grade] = gradeCal[o.grade] || []).push(o.gtoLossPct);
const stab = (rs) => ({ n: rs.length, model: mean(rs.filter((r) => r.cpuStabModel !== undefined).map((r) => r.cpuStabModel)), gto: mean(rs.filter((r) => r.cpuStabGto !== undefined).map((r) => r.cpuStabGto)) });
const summary = {
  cpuStabAfterCheck: { all: stab(rows), donkRule: stab(rows.filter((r) => r.donkRule)), noDonkRule: stab(rows.filter((r) => !r.donkRule)) },
  spots: rows.length, unmatched, meanExploitPct: mean(rows.map((r) => r.exploitPct)),
  overall: stats(rows),
  usualLines: stats(rows.filter((r) => !r.unusual)),
  byEqBand: by('eqBand'), byHeroPos: by('heroPos'), byRangeAdv: by('rangeAdv'), byDonkRule: by('donkRule'),
  byPrAction: by('prAction'), byThreeBet: by('threeBetPot'), byUnusual: by('unusual'),
  gradeCalibration: Object.fromEntries(Object.entries(gradeCal).map(([g, xs]) => [g, { n: xs.length, meanLossPct: mean(xs), medianLossPct: median(xs), over7pct: mean(xs.map((x) => (x > 0.07 ? 1 : 0))) }])),
};
fs.writeFileSync(path.join(OUTDIR, 'summary.json'), JSON.stringify(summary, null, 2));

const toCsv = (rs) => { const ks = Object.keys(rs[0] || {}); return [ks.join(','), ...rs.map((r) => ks.map((k) => { const v = r[k]; return typeof v === 'string' && /[,"]/.test(v) ? `"${v.replace(/"/g, '""')}"` : (typeof v === 'number' ? Math.round(v * 10000) / 10000 : v); }).join(','))].join('\n'); };
fs.writeFileSync(path.join(OUTDIR, 'spots.csv'), toCsv(rows));
fs.writeFileSync(path.join(OUTDIR, 'options.csv'), toCsv(optRows));

// ---- 文章 ----
const line = (name, s) => `| ${name} | ${s.n} | ${s.evLossMeanBb.toFixed(2)} | ${pct(s.evLossMeanPct)} | ${pct(s.evLossMedianPct)} | ${pct(s.actionMatch)} | ${pct(s.typeMatch)} | ${pct(s.majorRate)} | ${pct(s.overBetRate)} | ${pct(s.overCheckRate)} |`;
const head = '| 区分 | 件数 | EV損失 平均bb | 平均(ポット比) | 中央値 | Action Match | 種類の一致 | 重大(>7%) | 打ちすぎ | チェックしすぎ |\n|---|---|---|---|---|---|---|---|---|---|';
const table = (title, obj) => `\n### ${title}\n${head}\n${Object.entries(obj).map(([k, v]) => line(k, v)).join('\n')}\n`;
let md = `# Poker Rush の判定 vs GTOpen（${rows.length}局面）\n\nソルバーの平均収束度: ポットの ${(summary.meanExploitPct).toFixed(2)}%\n\n`;
md += `あなたのチェックに CPU が打ってくる頻度: アプリの CPU ${pct(summary.cpuStabAfterCheck.all.model)} / GTO ${pct(summary.cpuStabAfterCheck.all.gto)}\n\n`;
md += `${head}\n${line('全体', summary.overall)}\n${line('普通の打ち方の局面', summary.usualLines)}\n`;
md += table('勝率の帯', summary.byEqBand) + table('ポジション', summary.byHeroPos) + table('レンジの強い手の比べ合い', summary.byRangeAdv);
md += table('ドンクの場面（Poker Rush の理論ルールが効く）', summary.byDonkRule) + table('Poker Rush の推奨', summary.byPrAction) + table('3ベットポット', summary.byThreeBet);
md += `\n### 判定の当たり方（Poker Rush の記号ごとの、ソルバー上の EV 損失）\n| 記号 | 件数 | 平均 | 中央値 | 7%超 |\n|---|---|---|---|---|\n`;
for (const g of ['◎', '◯', '△', '×']) { const c = summary.gradeCalibration[g]; if (c) md += `| ${g} | ${c.n} | ${pct(c.meanLossPct)} | ${pct(c.medianLossPct)} | ${pct(c.over7pct)} |\n`; }
fs.writeFileSync(path.join(OUTDIR, 'summary.md'), md);
console.log(md);
