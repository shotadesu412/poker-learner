// spots.js の出力を集計する。 node analyze.js <dir> [--json out.json]
const fs = require('fs');
const path = require('path');
const dir = process.argv[2];
const rows = [];
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.jsonl'))) {
  for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) if (line) rows.push(JSON.parse(line));
}
const SCORE = { '◎': 3, '◯': 2, '△': 1, '×': 0 };
const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN);
const se = (a) => { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1) / a.length); };
const f1 = (x) => (Number.isNaN(x) ? '  -  ' : (x >= 0 ? '+' : '') + x.toFixed(2));
const pct = (x) => (x * 100).toFixed(0) + '%';
const kind = (a) => (a.a === 'BET' || a.a === 'RAISE' ? a.a : a.a);
const potType = (r) => (r.raises >= 2 ? '3BP' : r.raises === 1 ? 'SRP' : 'LIMP');
const situ = (r) => (r.street === 'PREFLOP' ? (r.firstIn ? 'first-in' : r.raises === 1 ? 'vs open' : r.raises === 0 ? 'vs limp' : 'vs 3bet+')
  : (r.facing > 0.01 ? (r.lastCpu === 'RAISE' ? 'vs raise' : 'vs bet') : (r.lastCpu === 'CHECK' ? 'checked to' : 'first to act')));
console.log(`スポット ${rows.length}`);

// ---- 1. 判定の正しさ: 判定記号ごとに「そのスポットの最善手との差（後悔）」と「判定が最善のアクションとの差」 ----
// regret_vs_top = EV(アプリが一番良いと判定したアクション) - EV(このアクション)。
//   ×判定のアクションは本来 EV が低いはず → 正の値が大きいほど判定が当たっている。負なら逆転
function block(title, filter, keyFn) {
  const groups = {};
  for (const r of rows.filter(filter)) {
    const acts = r.acts.filter((a) => a.v && SCORE[a.v] !== undefined);
    if (acts.length < 2) continue;
    const topScore = Math.max(...acts.map((a) => SCORE[a.v]));
    const tops = acts.filter((a) => SCORE[a.v] === topScore);
    const topEv = mean(tops.map((a) => a.ev));
    const best = Math.max(...acts.map((a) => a.ev));
    for (const a of acts) {
      const k = keyFn(r, a);
      if (!k) continue;
      groups[k] = groups[k] || { n: 0, diff: [], regret: [], v: {} };
      const g = groups[k];
      g.n++;
      g.v[a.v] = (g.v[a.v] || 0) + 1;
      if (SCORE[a.v] < topScore) g.diff.push(topEv - a.ev);
      g.regret.push(best - a.ev);
    }
  }
  console.log(`\n== ${title}`);
  for (const k of Object.keys(groups).sort()) {
    const g = groups[k];
    console.log(k.padEnd(46), `n=${String(g.n).padStart(5)}  後悔 ${f1(mean(g.regret))}  最上位判定との差 ${f1(mean(g.diff))}±${se(g.diff).toFixed(2)} (n=${g.diff.length})`);
  }
}

// ---- 2. 判定と EV の順位の一致: スポット内の全ペアで、判定が上の方が EV も上か ----
// 比較用の素朴な判定: 生の勝率（または本当の勝率 = 透視の上限）と必要勝率だけで決める
function simpleScore(r, a, eq) {
  if (r.street === 'PREFLOP') return SCORE[a.v];
  const req = r.facing > 0.01 ? r.facing / (r.pot + r.facing) : 0;
  if (r.facing > 0.01) {
    if (a.a === 'FOLD') return eq < req ? 3 : 0;
    if (a.a === 'CALL') return eq >= req ? (eq > 0.8 ? 2 : 3) : 0;
    return eq > 0.8 ? 3 : 0;
  }
  if (a.a === 'CHECK') return eq < 0.6 ? 3 : 0;
  return eq >= 0.6 ? 3 : 0;
}
const SCORERS = {
  app: (r, a) => SCORE[a.v],
  raw: (r, a) => simpleScore(r, a, r.raw),
  oracle: (r, a) => (r.truth === null || r.truth === undefined ? SCORE[a.v] : simpleScore(r, a, r.truth)),
};
function concord(title, filter, keyFn, scorerName = 'app') {
  const SC = SCORERS[scorerName];
  const G = {};
  for (const r of rows.filter(filter)) {
    const acts = r.acts.filter((a) => SCORE[a.v] !== undefined).map((a) => ({ ...a, s: SC(r, a) }));
    const k = keyFn(r);
    if (!k) continue;
    G[k] = G[k] || { agree: 0, disagree: 0, gain: [], spots: 0, topIsBest: 0 };
    const g = G[k];
    g.spots++;
    for (let i = 0; i < acts.length; i++) for (let j = 0; j < acts.length; j++) {
      if (acts[i].s <= acts[j].s) continue;
      const d = acts[i].ev - acts[j].ev;
      g.gain.push(d);
      if (d > 0) g.agree++; else if (d < 0) g.disagree++;
    }
  }
  console.log(`\n== ${title} [${scorerName}]（判定が上のアクションの EV − 下のアクションの EV。正なら判定が正しい方向）`);
  for (const k of Object.keys(G).sort()) {
    const g = G[k];
    console.log(k.padEnd(40), `spots=${String(g.spots).padStart(5)} ペア一致率 ${pct(g.agree / Math.max(1, g.agree + g.disagree))}  平均差 ${f1(mean(g.gain))}±${se(g.gain).toFixed(2)}bb`);
  }
}

// ---- 3. 各判定ごとに、具体的な2択の EV 差（例: 被ベットで コール − フォールド）----
function pairwise(title, filter, A, B, keyFn) {
  const G = {};
  for (const r of rows.filter(filter)) {
    const a = r.acts.find(A), b = r.acts.find(B);
    if (!a || !b) continue;
    const k = keyFn(r, a, b);
    if (!k) continue;
    (G[k] = G[k] || []).push(a.ev - b.ev);
  }
  console.log(`\n== ${title}`);
  for (const k of Object.keys(G).sort()) console.log(k.padEnd(52), `n=${String(G[k].length).padStart(5)}  差 ${f1(mean(G[k]))}±${se(G[k]).toFixed(2)}bb  正の割合 ${pct(G[k].filter((x) => x > 0).length / G[k].length)}`);
}

const post = (r) => r.street !== 'PREFLOP';
for (const sc of ['app', 'raw', 'oracle']) concord('ストリート × 場面', () => true, (r) => `${r.street.padEnd(7)} ${situ(r)}`, sc);
concord('ポジション（ポストフロップ）', post, (r) => `${r.heroPos} ${r.ip ? 'IP' : 'OOP'} ${potType(r)}`);
concord('ポジション（プリフロップ）', (r) => !post(r), (r) => `${r.heroPos.padEnd(3)} vs ${r.cpuPos.padEnd(3)} ${situ(r)}`);
block('判定記号 × アクション（ポストフロップ）', post, (r, a) => `${r.street.padEnd(6)} ${situ(r).padEnd(12)} ${a.a.padEnd(5)} ${a.v}`);
block('判定記号 × アクション（プリフロップ）', (r) => !post(r), (r, a) => `${situ(r).padEnd(9)} ${a.a.padEnd(5)} ${a.v}`);
pairwise('被ベット: コール − フォールド（コールの判定別）', (r) => post(r) && r.facing > 0.01,
  (a) => a.a === 'CALL', (a) => a.a === 'FOLD', (r, a) => `${r.street.padEnd(6)} ${r.lastCpu === 'RAISE' ? 'raise' : 'bet  '} call=${a.v}`);
pairwise('被ベット: コール − フォールド（表示勝率 − 必要勝率 の帯）', (r) => post(r) && r.facing > 0.01,
  (a) => a.a === 'CALL', (a) => a.a === 'FOLD', (r) => {
    const req = r.facing / (r.pot + r.facing);
    const m = r.shown - req;
    const b = m < -0.15 ? 'a <-15' : m < -0.05 ? 'b -15..-5' : m < 0.05 ? 'c -5..+5' : m < 0.15 ? 'd +5..+15' : 'e >+15';
    return `${r.street.padEnd(6)} ${b}`;
  });
pairwise('被ベット: コール − フォールド（生の計算勝率 − 必要勝率 の帯）', (r) => post(r) && r.facing > 0.01,
  (a) => a.a === 'CALL', (a) => a.a === 'FOLD', (r) => {
    const req = r.facing / (r.pot + r.facing);
    const m = r.raw - req;
    const b = m < -0.15 ? 'a <-15' : m < -0.05 ? 'b -15..-5' : m < 0.05 ? 'c -5..+5' : m < 0.15 ? 'd +5..+15' : 'e >+15';
    return `${r.street.padEnd(6)} ${b}`;
  });
pairwise('先に動く/チェックされた: ベット(最大EVのサイズ) − チェック（チェックの判定別）', (r) => post(r) && r.facing <= 0.01,
  (a) => a.a === 'BET', (a) => a.a === 'CHECK', (r, a, b) => `${r.street.padEnd(6)} ${situ(r).padEnd(12)} check=${b.v}`);
pairwise('ベットサイズ別: ベット − チェック（そのベットの判定別）', (r) => post(r) && r.facing <= 0.01,
  (a) => a.a === 'BET', (a) => a.a === 'CHECK', (r, a) => `${r.street.padEnd(6)} ${(a.amt / r.pot).toFixed(2)} bet=${a.v}`);
// ベットサイズは全サイズを見る
{
  const G = {};
  for (const r of rows.filter((r) => post(r) && r.facing <= 0.01)) {
    const c = r.acts.find((a) => a.a === 'CHECK');
    for (const a of r.acts.filter((a) => a.a === 'BET')) {
      const sz = Math.round(a.amt / r.pot * 100);
      const bucket = sz < 45 ? 'S' : sz < 90 ? 'M' : 'L';
      const k = `${r.street.padEnd(6)} ${bucket} bet=${a.v} ${r.cat}`;
      (G[k] = G[k] || []).push(a.ev - c.ev);
    }
  }
  console.log('\n== ベット − チェック（サイズ帯 × 判定 × 手の分類）。n>=40 のみ');
  for (const k of Object.keys(G).sort()) if (G[k].length >= 40) console.log(k.padEnd(48), `n=${String(G[k].length).padStart(5)} 差 ${f1(mean(G[k]))}±${se(G[k]).toFixed(2)}`);
}

// ---- 4. 勝率の較正 ----
{
  const G = {};
  for (const r of rows.filter((r) => r.truth !== null && r.truth !== undefined)) {
    const k = `${r.street.padEnd(7)} ${situ(r).padEnd(12)} ${potType(r)}`;
    G[k] = G[k] || { s: [], raw: [], t: [] };
    G[k].s.push(r.shown); G[k].raw.push(r.raw); G[k].t.push(r.truth);
  }
  console.log('\n== 勝率の較正: 表示（実現率込み） / 生の計算 / 本当（CPU の実際の手札）');
  for (const k of Object.keys(G).sort()) {
    const g = G[k];
    if (g.t.length < 30) continue;
    console.log(k.padEnd(32), `n=${String(g.t.length).padStart(5)}  表示 ${pct(mean(g.s))} / 生 ${pct(mean(g.raw))} / 本当 ${pct(mean(g.t))}  (生−本当 ${f1((mean(g.raw) - mean(g.t)) * 100)}pt)`);
  }
  // 生の計算勝率の帯ごとの較正（信頼度曲線）
  const B = {};
  for (const r of rows.filter((r) => r.truth !== null && r.truth !== undefined && r.street !== 'PREFLOP')) {
    const b = Math.min(9, Math.floor(r.raw * 10));
    const k = `${r.street.padEnd(6)} ${r.facing > 0.01 ? 'facing' : 'nofacing'} ${b * 10}-${b * 10 + 10}%`;
    (B[k] = B[k] || []).push(r.truth);
  }
  console.log('\n== 生の計算勝率の帯ごとの本当の勝率');
  for (const k of Object.keys(B).sort()) if (B[k].length >= 30) console.log(k.padEnd(30), `n=${String(B[k].length).padStart(5)}  本当 ${pct(mean(B[k]))}`);
}

// ---- 5. モデルの予測 EV と実際（ロールアウト）の較正（postflop_ev.js がある版のみ）----
{
  const G = {};
  const pairs = [['CALL', 'FOLD'], ['BET', 'CHECK'], ['RAISE', 'CALL']];
  for (const r of rows.filter((r) => r.street !== 'PREFLOP')) {
    for (const [x, y] of pairs) {
      const b = r.acts.find((a) => a.a === y && a.pred !== undefined);
      if (!b) continue;
      for (const a of r.acts.filter((a) => a.a === x && a.pred !== undefined)) {
        const d = (a.pred - b.pred) / r.pot;
        const bk = d < -0.3 ? 'a <-30%' : d < -0.1 ? 'b -30..-10%' : d < 0 ? 'c -10..0%' : d < 0.1 ? 'd 0..10%' : d < 0.3 ? 'e 10..30%' : 'f >30%';
        const k = `${r.street.padEnd(6)} ${x}-${y} 予測 ${bk}`;
        (G[k] = G[k] || { p: [], o: [] }).p.push(d);
        G[k].o.push((a.ev - b.ev) / r.pot);
      }
    }
  }
  const ks = Object.keys(G);
  if (ks.length) {
    console.log('\n== モデルの予測 EV 差と実際の EV 差（ポット比）。同じ符号・近い値なら予測が当たっている');
    for (const k of ks.sort()) if (G[k].p.length >= 20) console.log(k.padEnd(40), `n=${String(G[k].p.length).padStart(5)} 予測 ${f1(mean(G[k].p) * 100)}% / 実際 ${f1(mean(G[k].o) * 100)}%±${(se(G[k].o) * 100).toFixed(1)}`);
  }
}

if (process.argv[3] === '--json') fs.writeFileSync(process.argv[4], JSON.stringify({ n: rows.length }));
