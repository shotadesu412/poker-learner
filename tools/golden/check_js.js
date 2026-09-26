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

const CHECKS = {
  hand_evaluator: checkHandEvaluator,
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
