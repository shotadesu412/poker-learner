// export_spots.js の局面を GTOpen（ローカルのサーバー）で解き、あなたの手札の各アクションの頻度と EV を取り出す。
//   node tools/solver_compare/solve_spots.js <spots.jsonl> <出力.jsonl> [目標の収束度 %pot=0.3] [最大反復=4000]
// GTOpen は別に起動しておく（~/Projects/gtopen で PORT=3737 ./target/release/gto-server）。
//
// 木（ベットサイズ）は Poker Rush に合わせる:
//   あなた（OOP）: ベットはアプリのボタンと同じ（フロップ 33/55/85・ターン 33/66/100・リバー 33/75/150%）、
//                  レイズは 2.5倍・3.5倍・ポットサイズ（アプリの3つ目は max(4.5〜5倍, ポットサイズ)）
//   CPU（IP）   : CPU の行動モデルが使うサイズ（フロップ 33/66・ターン 66・リバー 75/100%）、レイズは 3倍
// EV の単位は Poker Rush と同じ「ポットの取り分（今後の自分の支払いを引く）」なので、アクション間の差をそのまま比べられる。
const fs = require('fs');
const [, , IN, OUT, TARGET = '0.3', MAXIT = '4000'] = process.argv;
const API = process.env.GTO_API || 'http://127.0.0.1:3737';

const STREET_IDX = { FLOP: 0, TURN: 1, RIVER: 2 };
const HERO_BET = { FLOP: '33 55 85', TURN: '33 66 100', RIVER: '33 75 150' };
const CPU_BET = { FLOP: '33 66', TURN: '66', RIVER: '75 100' };
const HERO_RAISE = '2.5x 3.5x 100';
const CPU_RAISE = '3x';

// 重みは最大を 1 にそろえ、1e-4 未満は省く。ただし keep（あなたの手札）は最低 1e-4 で残す
// （推定レンジでの重みが極端に小さい手札。相手の均衡はほぼ変わらず、その手札の EV は重みに関係なく決まる）
function rangeString(obj, keep) {
  let max = 0;
  for (const k in obj) max = Math.max(max, obj[k]);
  const parts = [];
  for (const k in obj) {
    let w = obj[k] / max;
    if (keep && sameCombo(k, keep)) w = Math.max(w, 1e-4);
    if (w < 1e-4) continue;
    parts.push(w >= 0.9999 ? k : `${k}:${w.toFixed(4)}`);
  }
  return parts.join(',');
}

async function post(path, body) {
  const r = await fetch(API + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${path} ${r.status}: ${t.slice(0, 300)}`);
  return JSON.parse(t);
}
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const sameCombo = (a, b) => [a.slice(0, 2), a.slice(2, 4)].sort().join() === [b.slice(0, 2), b.slice(2, 4)].sort().join();

// あなたの手札の、推定レンジ内での相対的な重み（最大 = 1）。小さいほど「普通は取らない打ち方をした手札」
function heroRel(s) {
  let max = 0, w = 0;
  for (const k in s.heroRange) { max = Math.max(max, s.heroRange[k]); if (sameCombo(k, s.hero)) w = s.heroRange[k]; }
  return max > 0 ? w / max : 0;
}

async function solveSpot(s) {
  const st = STREET_IDX[s.street];
  const sizes = (bet, raise) => [0, 1, 2].map((i) => (i === st ? { bet, raise, donk: bet } : { bet: '', raise: '', donk: '' }));
  const spot = {
    board: s.board, range_oop: rangeString(s.heroRange, s.hero), range_ip: rangeString(s.cpuRange),
    starting_pot: s.pot, effective_stack: s.stack, allin_threshold: 100, add_allin: false, max_raises: 3,
    oop: sizes(HERO_BET[s.street], HERO_RAISE), ip: sizes(CPU_BET[s.street], CPU_RAISE),
  };
  // フロップ・ターンは後のストリートも木に入る。サイズは同じ規則で埋める
  for (let i = st + 1; i < 3; i++) {
    const name = ['FLOP', 'TURN', 'RIVER'][i];
    spot.oop[i] = { bet: HERO_BET[name], raise: HERO_RAISE, donk: HERO_BET[name] };
    spot.ip[i] = { bet: CPU_BET[name], raise: CPU_RAISE, donk: '' };
  }
  const info = await post('/api/spot', spot);
  const t0 = Date.now();
  await post('/api/solve', { max_iterations: Number(MAXIT), target_exploit_pct: Number(TARGET) });
  let status;
  for (;;) {
    await sleep(150);
    status = await (await fetch(API + '/api/status')).json();
    if (status.state !== 'running') break;
  }
  const node = await post('/api/node', { path: [] });
  const hand = node.players[0].hands.find((h) => sameCombo(h.combo, s.hero));
  if (!hand) return { id: s.id, error: 'hero combo missing in solver range' };
  // あなたがチェックした後の CPU（IP）の打つ頻度（レンジ全体、到達確率で重み付け）。アプリの CPU の頻度と比べる
  let ipStab, stabGto;
  const ci = node.actions.findIndex((a) => a.kind === 'check' || /^check/i.test(a.label));
  if (ci >= 0) {
    const n2 = await post('/api/node', { path: [{ type: 'action', index: ci }] });
    const chk = n2.actions.findIndex((a) => a.kind === 'check' || /^check/i.test(a.label));
    let w = 0, b = 0;
    for (const h of n2.players[1].hands) {
      if (!h.strategy || !(h.reach > 0)) continue;
      const m = h.reach * (h.valid || 1);
      w += m; b += m * (1 - (chk >= 0 ? h.strategy[chk] : 0));
    }
    ipStab = w > 0 ? b / w : undefined;
    // CPU の各ベットに対する、あなたの手札の勝率（GTO の打ってくるレンジに対して）
    stabGto = [];
    for (let ai = 0; ai < n2.actions.length; ai++) {
      if (ai === chk) continue;
      let fw = 0;
      for (const h of n2.players[1].hands) if (h.strategy && h.reach > 0) fw += h.reach * (h.valid || 1) * h.strategy[ai];
      const n3 = await post('/api/node', { path: [{ type: 'action', index: ci }, { type: 'action', index: ai }] });
      const hh = n3.players[0].hands.find((h) => sameCombo(h.combo, s.hero));
      stabGto.push({ pct: Math.round(n2.actions[ai].amount / node.pot * 100), amount: n2.actions[ai].amount, freq: w > 0 ? fw / w : 0, heroEq: hh ? hh.eq : null,
        heroOptions: hh ? n3.actions.map((a, j) => ({ label: a.label, amount: a.amount, freq: hh.strategy[j], ev: hh.evs[j] })) : null });
    }
  }
  const actions = node.actions.map((a, i) => ({ label: a.label, kind: a.kind, amount: a.amount, freq: hand.strategy[i], ev: hand.evs[i] }));
  return {
    id: s.id, heroWeightRel: heroRel(s), nodes: info.nodes, iterations: status.iteration, exploit_pct: status.exploit_pct, secs: (Date.now() - t0) / 1000,
    pot: node.pot, ipStab, stabGto, solver: actions,
  };
}

(async () => {
  const spots = fs.readFileSync(IN, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const out = fs.createWriteStream(OUT, { flags: 'a' });
  const done = new Set();
  if (fs.existsSync(OUT)) for (const l of fs.readFileSync(OUT, 'utf8').split('\n')) if (l) done.add(JSON.parse(l).id);
  for (const s of spots) {
    if (done.has(s.id)) continue;
    try {
      const r = await solveSpot(s);
      out.write(JSON.stringify(r) + '\n');
      console.error(`${s.id} ${r.error || `it=${r.iterations} expl=${r.exploit_pct.toFixed(3)}% ${r.secs.toFixed(1)}s`}`);
    } catch (e) {
      out.write(JSON.stringify({ id: s.id, error: String(e.message || e) }) + '\n');
      console.error(`${s.id} ERROR ${e.message}`);
    }
  }
  out.end();
})();
