// CPU の打ち方を、ポジション・ストリート・役割（プリフロップのレイザー/コーラー）・IP/OOP 別に測る。
//   node cpu_stats.js <static/poker> <seed> <ハンド数> <out.json>
// あなた役は spots.js の contPolicy に 20% の探索を混ぜたもの（いろいろなサイズ・ラインを CPU に見せるため）
const fs = require('fs');
const path = require('path');
const [, , DIR, SEED = '1', HANDS = '3000', OUT = 'cpu.json'] = process.argv;
require(path.join(DIR, 'rng.js'));
require(path.join(DIR, 'game.js'));
const { PokerGame, PokerEngine, Rng, Ranges, HandEvaluator, HandClassifier, Equity, Card } = globalThis;
const hooks = { logAction() {}, newSessionId: () => 's', startSession() {}, finishHand() {} };
const seed = Number(SEED);
const game = new PokerGame({ rng: Rng.seeded(seed * 104729 + 7), hooks });
let p = (seed * 2246822519) >>> 0;
const rnd = () => { p = (p * 1664525 + 1013904223) >>> 0; return p / 4294967296; };
const comboKey = (c) => PokerEngine.comboKey(c);
const rangeW = (pos, cat, c) => (Ranges.getRangeByCategory(pos, cat).get(c) || 0);

const C = {};   // カウンタ: C[key][outcome]
const inc = (k, o, n = 1) => { C[k] = C[k] || {}; C[k][o] = (C[k][o] || 0) + n; };

function heroPolicy(e, st) {
  const f = e.currentBet - e.heroInvested;
  const c = comboKey(e.heroHand);
  const eq = st.equity / 100;
  const max = e.maxAdditionalBet('HERO');
  const pot = e.potSize;
  if (e.street === 'PREFLOP') {
    const raises = e.preflopRaiseCount;
    if (raises === 0) {
      if (rangeW(e.heroPosition, 'open', c) > 0.4) return ['BET', [2.0, 2.5, 3.0][Math.floor(rnd() * 3)]];
      return f > 0.01 ? ['FOLD', 0] : ['CHECK', 0];
    }
    if (raises === 1) {
      // 3ベットを多めに混ぜて CPU の 3ベットへの対応を測る
      if ((rangeW(e.heroPosition, 'vs_open_3bet', c) > 0.3 || rnd() < 0.12) && max > f * 3) return ['RAISE', f * 3];
      if (rangeW(e.heroPosition, 'vs_open_call', c) > 0.2 || eq > 0.45) return ['CALL', 0];
      return ['FOLD', 0];
    }
    if (raises === 2 && rnd() < 0.15 && max > f * 2.5) return ['RAISE', f * 2.5];   // 4ベットも少し
    if (f <= 0.01) return ['CHECK', 0];
    return eq > 0.5 ? ['CALL', 0] : ['FOLD', 0];
  }
  if (f > 0.01) {
    const req = f / (pot + f);
    if ((eq > 0.8 || rnd() < 0.04) && max > f * 3) return ['RAISE', Math.min(max, f * 3)];
    return eq >= req ? ['CALL', 0] : ['FOLD', 0];
  }
  const r = rnd();
  const sizes = { FLOP: [0.33, 0.55, 0.85], TURN: [0.33, 0.66, 1.0], RIVER: [0.33, 0.75, 1.5] }[e.street];
  const sz = sizes[Math.floor(rnd() * 3)];
  if (eq > 0.62 || (e.aggressor === 'HERO' && r < 0.55) || r < 0.2) return ['BET', Math.min(max, Math.round(pot * sz * 10) / 10)];
  return ['CHECK', 0];
}

// CPU の手札が、その時点のあなたのレンジに対してどれくらいか（バリュー/ブラフの判定用）
function cpuEqNow(e) {
  if (e.cpuHand.length !== 2) return null;
  return Equity.calcEquityMonteCarlo(e.cpuHand, e.board, e.cpuRange, e.heroRange, 'HERO', e.street === 'PREFLOP', 300, rnd)[0];
}

const SD = { n: 0, cpuWon: 0, wtsdFlopSeen: 0, flopSeen: 0 };
for (let h = 0; h < Number(HANDS); h++) {
  let st = game.startHand({});
  const e = game.engine;
  const cpuPos = e.cpuPosition;
  // CPU が先に動いた（ファーストイン）
  for (const a of st.cpuActions || []) inc(`PF 01 CPU first-in ${cpuPos.padEnd(3)}`, a.action === 'RAISE' ? 'open' : a.action === 'CALL' ? 'limp' : a.action);
  let guard = 0;
  let sawFlop = false;
  while (!st.finished && guard++ < 40) {
    const street = e.street;
    const pfr = e.preflopRaiseCount;
    const cpuWasPfr = (() => { const x = e.actionHistory.filter((a) => a.street === 'PREFLOP' && (a.action === 'BET' || a.action === 'RAISE')).pop(); return x && x.actor === 'CPU'; })();
    const ipStr = e.isHeroIp ? 'CPU OOP' : 'CPU IP ';
    const role = cpuWasPfr ? 'CPU=PFR ' : 'CPU=call';
    const potType = pfr >= 2 ? '3BP' : 'SRP';
    const before = { pot: e.potSize, facingHero: e.currentBet - e.heroInvested };
    const a = heroPolicy(e, st);
    if (street !== 'PREFLOP') sawFlop = true;
    const r = game.action({ action: a[0], amount: a[1] });
    const cpuAs = r.cpuActions || [];
    const resp = cpuAs.find((x) => x.street === street);
    // ---- プリフロップ ----
    if (street === 'PREFLOP' && (a[0] === 'BET' || a[0] === 'RAISE') && resp) {
      const lvl = pfr === 0 ? 'vs open' : pfr === 1 ? 'vs 3bet' : 'vs 4bet';
      inc(`PF 02 CPU ${lvl.padEnd(8)} ${cpuPos.padEnd(3)}`, resp.action);
    }
    if (street === 'PREFLOP' && a[0] === 'CALL' && pfr === 0 && resp) inc(`PF 03 CPU vs limp ${cpuPos}`, resp.action);
    // ---- ポストフロップ: あなたのベットに対する CPU ----
    if (street !== 'PREFLOP' && a[0] === 'BET' && resp) {
      const frac = a[1] / before.pot;
      const sz = frac < 0.45 ? '33%' : frac < 0.95 ? '55-85%' : '100%+';
      inc(`${street.padEnd(5)} vsBet ${sz.padEnd(6)} ${ipStr}`, resp.action);
      inc(`${street.padEnd(5)} vsBet all    ${potType} ${role}`, resp.action);
    }
    if (street !== 'PREFLOP' && a[0] === 'RAISE' && resp) inc(`${street.padEnd(5)} vsRaise`, resp.action);
    // あなたがチェック → CPU（IP）が動く
    if (street !== 'PREFLOP' && a[0] === 'CHECK' && resp && !e.isHeroIp) {
      const lbl = cpuWasPfr ? (street === 'FLOP' ? 'Cbet IP' : 'barrel/bet IP') : 'stab IP (hero checked)';
      inc(`${street.padEnd(5)} ${lbl.padEnd(22)} ${potType}`, resp.action === 'BET' ? 'BET' : 'CHECK');
    }
    // CPU が OOP で先に動いた（次のストリートの先頭アクション）
    for (const x of cpuAs) {
      if (x.street !== street && x.street !== 'PREFLOP') {
        const lbl = cpuWasPfr ? (x.street === 'FLOP' ? 'Cbet OOP' : 'barrel/lead OOP') : 'donk/lead OOP';
        inc(`${x.street.padEnd(5)} ${lbl.padEnd(22)} ${potType}`, x.action === 'BET' ? 'BET' : 'CHECK');
      }
    }
    // CPU のチェックレイズ: あなたが IP でベットし、CPU はその前にチェックしていた
    if (street !== 'PREFLOP' && a[0] === 'BET' && e.isHeroIp && resp) inc(`${street.padEnd(5)} CPU check-raise rate`, resp.action === 'RAISE' ? 'xr' : 'other');
    // CPU のベットの中身（ベットしたときの CPU の手札の強さ）
    for (const x of cpuAs) {
      if ((x.action === 'BET' || x.action === 'RAISE') && x.street !== 'PREFLOP' && x.street === e.street) {
        const ce = cpuEqNow(e);
        if (ce !== null) inc(`${x.street.padEnd(5)} CPU bet composition`, ce >= 0.6 ? 'value(>=60%)' : ce >= 0.4 ? 'medium' : 'bluff(<40%)');
      }
    }
    st = r.state;
  }
  if (sawFlop) {
    SD.flopSeen++;
    const last = e.actionHistory[e.actionHistory.length - 1];
    if (st.showdownResult && !(last && last.action === 'FOLD')) { SD.wtsdFlopSeen++; if (st.showdownResult.winner === 'CPU') SD.cpuWon++; }
  }
}
C['SUMMARY'] = { WTSD: SD.wtsdFlopSeen, flopSeen: SD.flopSeen, cpuWonSD: SD.cpuWon };
fs.writeFileSync(OUT, JSON.stringify(C));
