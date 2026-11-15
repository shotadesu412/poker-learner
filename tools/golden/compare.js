// 評価の修正前後を同じ条件で比べる。ランダムな手で同じハンドを遊び、変わった評価と平均損失を経路ごとに出す。
//   node tools/golden/compare.js [比較元の git ref=HEAD] [ハンド数=3000]
// 作業中のファイルと ref の static/poker を比べるので、コミット前に実行する。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');

function legal(e) {
  const f = e.currentBet - e.heroInvested;
  const vol = (e.street === 'PREFLOP' && e.currentBet > 1) || (e.street !== 'PREFLOP' && e.currentBet > 0);
  const sizes = [];
  if (vol) (e.street === 'PREFLOP' ? (f <= 4 ? [2.7, 3, 3.5] : [2.2, 2.5, 2.8]) : [2.5, 3.5]).forEach((x) => sizes.push(Math.round(f * x * 10) / 10));
  else if (e.street === 'PREFLOP') sizes.push(2, 2.5, 3);
  else [0.33, 0.66, 1].forEach((x) => sizes.push(Math.round(e.potSize * x * 10) / 10));
  const max = e.maxAdditionalBet('HERO');
  const out = f > 0 ? [['FOLD', 0], ['CALL', 0]] : [['CHECK', 0]];
  if (max > f + 0.01 || (!vol && max > 0)) sizes.forEach((x) => out.push([vol ? 'RAISE' : 'BET', Math.min(x, max)]));
  return out;
}

// 子プロセス側: 1つの static/poker を動かして結果を書き出す
function snapshot(dir, hands, outFile) {
  require(path.join(dir, 'rng.js'));
  require(path.join(dir, 'game.js'));
  const { PokerGame, Rng, Card } = globalThis;
  const rows = [];
  const game = new PokerGame({ rng: Rng.seeded(11), hooks: { logAction() {}, newSessionId: () => 's', startSession() {}, finishHand() {} } });
  let p = 12345;
  const pick = () => { p = (p * 1664525 + 1013904223) >>> 0; return p / 4294967296; };
  for (let h = 0; h < hands; h++) {
    game.startHand({});
    for (let i = 0; i < 30 && !game.engine.handFinished; i++) {
      const e = game.engine;
      const opts = legal(e);
      const [action, amount] = opts[Math.floor(pick() * opts.length)];
      const raises = e.actionHistory.filter((x) => x.street === 'PREFLOP' && (x.action === 'BET' || x.action === 'RAISE')).length;
      const row = { h, street: e.street, hand: e.heroHand.map(Card.toStr).join(''), action, raises, first: e.actionHistory.length === 0 };
      const r = game.action({ action, amount });
      rows.push({ ...row, ev: r.evaluation, loss: r.ev_loss });
    }
  }
  fs.writeFileSync(outFile, JSON.stringify(rows));
}

if (process.argv[2] === '--snapshot') {
  snapshot(process.argv[3], Number(process.argv[4]), process.argv[5]);
  process.exit(0);
}

const ref = process.argv[2] || 'HEAD';
const hands = Number(process.argv[3]) || 3000;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'poker-compare-'));
try {
  execSync(`git -C "${ROOT}" archive "${ref}" static/poker | tar -x -C "${tmp}"`);
  const run = (dir, name) => {
    const out = path.join(tmp, name);
    const r = spawnSync(process.execPath, [__filename, '--snapshot', dir, String(hands), out], { stdio: 'inherit' });
    if (r.status !== 0) process.exit(r.status || 1);
    return JSON.parse(fs.readFileSync(out, 'utf8'));
  };
  const before = run(path.join(tmp, 'static', 'poker'), 'before.json');
  const after = run(path.join(ROOT, 'static', 'poker'), 'after.json');
  const groups = {};
  let compared = 0;
  for (let i = 0; i < Math.min(before.length, after.length); i++) {
    const a = before[i], b = after[i];
    if (a.h !== b.h || a.hand !== b.hand || a.action !== b.action) {
      console.log(`局面が ${i} 件目（ハンド ${a.h}）でずれた。以降は比較しない（乱数の順番かゲーム進行が変わっている）`);
      break;
    }
    compared++;
    const key = a.street !== 'PREFLOP' ? `ポストフロップ レイズ${Math.min(a.raises, 3)}回`
      : a.first ? `ファーストイン ${a.action}` : `プリフロップ レイズ${Math.min(a.raises, 3)}回 ${a.action}`;
    const g = groups[key] = groups[key] || { n: 0, changed: 0, loss: 0, moves: {} };
    g.n++;
    if (a.ev !== b.ev) { g.changed++; const m = `${a.ev}→${b.ev}`; g.moves[m] = (g.moves[m] || 0) + 1; }
    if (Math.abs((a.loss || 0) - (b.loss || 0)) > 1e-9) g.loss++;
  }
  console.log(`比較元 ${ref} / ${compared} 判断`);
  for (const k of Object.keys(groups).sort()) {
    const g = groups[k];
    console.log(`${k.padEnd(24)} ${String(g.n).padStart(5)}件 評価変化 ${String(g.changed).padStart(4)} 損失変化 ${String(g.loss).padStart(4)} ${JSON.stringify(g.moves)}`);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
