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

const CHECKS = {
  hand_evaluator: checkHandEvaluator,
  ranges: checkRanges,
  range_order: checkRangeOrder,
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
