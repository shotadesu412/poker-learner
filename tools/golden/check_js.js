// JS 移植版をゴールデンテストベクタと突き合わせる。
//   node tools/golden/check_js.js      （差分があれば exit 1）
// フェーズが進むごとに CHECKS へ追加していく。
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const VEC = path.join(__dirname, 'vectors');
const load = (name) => JSON.parse(fs.readFileSync(path.join(VEC, name + '.json'), 'utf8'));

function checkHandEvaluator() {
  const { Card, HandEvaluator } = require(path.join(ROOT, 'static', 'poker', 'hand_eval.js'));
  const rows = load('hand_evaluator');
  const fails = [];
  for (const r of rows) {
    const board = r.board.map(Card.fromStr);
    const hand = r.hand.map(Card.fromStr);
    const score = HandEvaluator.evaluate(board, hand);
    const cls = HandEvaluator.getRankClass(score);
    if (score !== r.score || cls !== r.rank_class) {
      fails.push(`${r.hand}|${r.board}: 期待 ${r.score}/${r.rank_class} 実際 ${score}/${cls}`);
    }
    // 文字列 <-> 整数の往復
    for (const s of r.board.concat(r.hand)) {
      if (Card.toStr(Card.fromStr(s)) !== s) fails.push(`Card 往復失敗: ${s}`);
    }
  }
  return { n: rows.length, fails };
}

const POSITIONS = ['LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB', 'UTG'];
const ACTIONS = ['open', 'vs_open_call', 'vs_open_3bet', 'vs_3bet_call', 'vs_3bet_4bet', '3bet', '4bet_bluff'];
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function checkRanges() {
  const Ranges = require(path.join(ROOT, 'static', 'poker', 'ranges.js'));
  const exp = load('ranges');
  const fails = [];
  let n = 0;
  for (const pos of POSITIONS) {
    for (const action of ACTIONS) {
      n++;
      const got = {};
      for (const [k, v] of Ranges.getRangeByCategory(pos, action)) got[k] = Math.round(v * 1e6) / 1e6;
      const want = exp[pos][action];
      const keys = Object.keys(want);
      if (keys.length !== Object.keys(got).length || keys.some((k) => got[k] !== want[k])) {
        fails.push(`${pos}/${action}: 中身が一致しない`);
      }
    }
  }
  return { n, fails };
}

function checkRangeOrder() {
  const Ranges = require(path.join(ROOT, 'static', 'poker', 'ranges.js'));
  const exp = load('range_order');
  const fails = [];
  let n = 0;
  for (const pos of POSITIONS) {
    for (const action of ACTIONS) {
      n++;
      const got = [...Ranges.getRangeByCategory(pos, action).keys()];
      if (!same(got, exp.order[pos][action])) fails.push(`${pos}/${action}: 反復順が違う (先頭 ${got.slice(0, 3)})`);
    }
  }
  for (const [pos, keys] of Object.entries(exp.order.position_ranges)) {
    n++;
    if (!same([...Ranges.positionRanges.get(pos).keys()], keys)) fails.push(`position_ranges.${pos}: 反復順が違う`);
  }
  for (const [combo, want] of Object.entries(exp.parse_combo)) {
    n++;
    if (!same(Ranges.parseCombo(combo), want)) fails.push(`parseCombo(${combo}) が違う`);
  }
  for (const w of exp.weighted) {
    n++;
    if (!same(Ranges.getPossibleHoleCardsWeighted(w.pos, w.action, w.dead), w.result)) {
      fails.push(`getPossibleHoleCardsWeighted(${w.pos}, ${w.action}) が違う`);
    }
  }
  return { n, fails };
}

function checkRangeUpdate() {
  const { Card } = require(path.join(ROOT, 'static', 'poker', 'hand_eval.js'));
  const Ranges = require(path.join(ROOT, 'static', 'poker', 'ranges.js'));
  const RangeUtils = require(path.join(ROOT, 'static', 'poker', 'range_utils.js'));
  const exp = load('range_update');
  const fails = [];
  let n = 0;
  for (const u of exp.updates) {
    const board = u.board.map(Card.fromStr);
    let rd = new Map(Ranges.getRangeByCategory(u.pos, u.action));
    for (const [i, step] of u.steps.entries()) {
      n++;
      rd = Ranges.updateRangeAfterAction(rd, step.kind, 5.0, board);
      const got = [...rd];
      // 順序と値の両方（Python の 1.0 と JS の 1 は数値として比較）
      const ok = got.length === step.result.length &&
        got.every(([k, v], j) => k === step.result[j][0] && v === step.result[j][1]);
      if (!ok) {
        const j = got.findIndex(([k, v], j) => !step.result[j] || k !== step.result[j][0] || v !== step.result[j][1]);
        fails.push(`${u.pos}/${u.action} [${u.board}] step${i} ${step.kind}: ${j}番目で不一致 ` +
          `期待 ${JSON.stringify(step.result[j])} 実際 ${JSON.stringify(got[j])}`);
        break;
      }
    }
  }
  for (const s of exp.samplers) {
    n++;
    const sp = RangeUtils.buildSampler(Ranges.getRangeByCategory(s.pos, s.action), s.dead);
    const combos = sp.combos.map((c) => c.map(Card.toStr));
    if (!same(combos, s.combos) || !same(sp.cum, s.cum) || sp.total !== s.total) {
      fails.push(`buildSampler(${s.pos}/${s.action}) が違う`);
      continue;
    }
    const picks = s.rs.map((r) => RangeUtils.pickIndex(sp, r));
    if (!same(picks, s.picks)) fails.push(`pickIndex(${s.pos}/${s.action}) が bisect_left と違う`);
  }
  n++;
  const empty = RangeUtils.buildSampler(new Map([['AA', 1.0]]), ['As', 'Ah', 'Ad']);
  if ((empty === null) !== exp.empty_is_none[0]) fails.push('全コンボがデッドのとき null にならない');
  return { n, fails };
}

// モンテカルロは乱数列が違うので統計的に比較する。
//  - 各局面: |z| < 4（z = 差 / 両者の標準誤差の合成）
//  - 全体: z の合計 / √件数 が |.| < 4（JS が一貫して高い/低いといった系統的な偏りの検出）
function checkEquityMC() {
  const { Card } = require(path.join(ROOT, 'static', 'poker', 'hand_eval.js'));
  const Equity = require(path.join(ROOT, 'static', 'poker', 'equity.js'));
  const exp = load('equity_reference');
  const N_JS = 50000;
  const fails = [];
  const zs = [];
  let maxZ = 0;
  const zOf = (py, js) => {
    const p = (py + js) / 2;
    const v = Math.max(p * (1 - p), 0.001);
    return (js - py) / Math.sqrt(v / exp.iterations + v / N_JS);
  };
  for (const s of exp.spots) {
    const hero = s.hero.map(Card.fromStr);
    const board = s.board.map(Card.fromStr);
    const hr = new Map(s.hero_range);
    const cr = new Map(s.cpu_range);
    const [eq] = Equity.calcEquityMonteCarlo(hero, board, hr, cr, 'CPU', false, N_JS);
    const adv = Equity.calcRangeAdvantage(hero, board, hr, cr, false, N_JS);
    for (const [name, py, js] of [['equity', s.equity, eq], ['range_adv', s.range_adv, adv]]) {
      const z = zOf(py, js);
      zs.push(z);
      maxZ = Math.max(maxZ, Math.abs(z));
      if (Math.abs(z) >= 4) {
        fails.push(`${name} ${s.hero} [${s.board}] ${s.label}: Python ${py.toFixed(4)} JS ${js.toFixed(4)} z=${z.toFixed(2)}`);
      }
    }
  }
  const bias = zs.reduce((a, b) => a + b, 0) / Math.sqrt(zs.length);
  if (Math.abs(bias) >= 4) fails.push(`系統的な偏り: Σz/√n = ${bias.toFixed(2)}`);
  console.log(`     (最大|z| = ${maxZ.toFixed(2)}, 偏り Σz/√n = ${bias.toFixed(2)})`);
  return { n: zs.length, fails };
}

const CHECKS = {
  hand_evaluator: checkHandEvaluator,
  ranges: checkRanges,
  range_order: checkRangeOrder,
  range_update: checkRangeUpdate,
  equity_mc: checkEquityMC,
};

let failed = false;
for (const [name, fn] of Object.entries(CHECKS)) {
  const { n, fails } = fn();
  if (fails.length) {
    failed = true;
    console.log(`  NG ${name} (${fails.length}/${n.toLocaleString()} 件不一致)`);
    fails.slice(0, 10).forEach((f) => console.log('     ' + f));
  } else {
    console.log(`  OK ${name} (${n.toLocaleString()} 件)`);
  }
}
process.exit(failed ? 1 : 0);
