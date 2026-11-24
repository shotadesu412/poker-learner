// CPU の打ち方の校正用。export_spots.js を CALIB=1 で書き出した局面を GTOpen で解き、
// あなたがチェックした後の CPU（IP）の各コンボの戦略（チェック / 各サイズ）と、
// 各サイズで打った後にあなたが3倍にチェックレイズしたときに降りる確率を取り出す。
//   node tools/solver_compare/solve_calib.js <spots.jsonl> <出力.jsonl> [目標の収束度 %pot=0.3]
// 木は solve_spots.js と同じ。ただし比べやすいように、あなた（OOP）のレイズはアプリの CPU の読みと同じ 3倍だけにする。
const fs = require('fs');
const [, , IN, OUT, TARGET = '0.3'] = process.argv;
const API = process.env.GTO_API || 'http://127.0.0.1:3737';
const HERO_BET = { FLOP: '33 55 85', TURN: '33 66 100', RIVER: '33 75 150' };
const CPU_BET = { FLOP: '33 66', TURN: '66', RIVER: '75 100' };
const STREET_IDX = { FLOP: 0, TURN: 1, RIVER: 2 };

async function post(p, body) {
  const r = await fetch(API + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const t = await r.text();
  if (!r.ok) throw new Error(`${p} ${r.status}: ${t.slice(0, 300)}`);
  return JSON.parse(t);
}
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
const norm = (c) => [c.slice(0, 2), c.slice(2, 4)].sort().join('');
const isCheck = (a) => a.kind === 'check' || /^check/i.test(a.label);
const isRaise = (a) => a.kind === 'raise' || a.kind === 'bet' || /^(raise|bet|all)/i.test(a.label);
const isFold = (a) => a.kind === 'fold' || /^fold/i.test(a.label);

function rangeString(obj, keep) {
  let max = 0;
  for (const k in obj) max = Math.max(max, obj[k]);
  const parts = [];
  for (const k in obj) {
    let w = obj[k] / max;
    if (keep && norm(k) === norm(keep)) w = Math.max(w, 1e-4);
    if (w < 1e-4) continue;
    parts.push(w >= 0.9999 ? k : `${k}:${w.toFixed(4)}`);
  }
  return parts.join(',');
}

async function solve(s) {
  const st = STREET_IDX[s.street];
  const mk = (bet, raise, donk) => [0, 1, 2].map((i) => (i >= st ? { bet: bet(i), raise, donk: donk(i) } : { bet: '', raise: '', donk: '' }));
  const name = (i) => ['FLOP', 'TURN', 'RIVER'][i];
  const spot = {
    board: s.board, range_oop: rangeString(s.heroRange, s.hero), range_ip: rangeString(s.cpuRange),
    starting_pot: s.pot, effective_stack: s.stack, allin_threshold: 100, add_allin: false, max_raises: 3,
    oop: mk((i) => HERO_BET[name(i)], '3x', (i) => HERO_BET[name(i)]),
    ip: mk((i) => CPU_BET[name(i)], '3x', () => ''),
  };
  await post('/api/spot', spot);
  await post('/api/solve', { max_iterations: 4000, target_exploit_pct: Number(TARGET) });
  let status;
  for (;;) { await sleep(120); status = await (await fetch(API + '/api/status')).json(); if (status.state !== 'running') break; }
  const root = await post('/api/node', { path: [] });
  const ci = root.actions.findIndex(isCheck);
  const n2 = await post('/api/node', { path: [{ type: 'action', index: ci }] });
  const chk = n2.actions.findIndex(isCheck);
  const sizes = [];
  const strat = new Map();   // コンボ → [チェック, サイズごと...]
  for (const h of n2.players[1].hands) if (h.strategy) strat.set(norm(h.combo), h.strategy);
  const fold = new Map();    // コンボ → [サイズごとの降りる確率]
  let si = 0;
  for (let ai = 0; ai < n2.actions.length; ai++) {
    if (ai === chk) continue;
    sizes.push(Math.round(n2.actions[ai].amount / root.pot * 100));
    const n3 = await post('/api/node', { path: [{ type: 'action', index: ci }, { type: 'action', index: ai }] });
    const ri = n3.actions.findIndex((a) => isRaise(a) && !isFold(a) && !/^call/i.test(a.label));
    if (ri >= 0) {
      const n4 = await post('/api/node', { path: [{ type: 'action', index: ci }, { type: 'action', index: ai }, { type: 'action', index: ri }] });
      const fi = n4.actions.findIndex(isFold);
      for (const h of n4.players[1].hands) {
        if (!h.strategy) continue;
        const k = norm(h.combo);
        if (!fold.has(k)) fold.set(k, []);
        fold.get(k)[si] = fi >= 0 ? h.strategy[fi] : 0;
      }
    }
    si++;
  }
  const combos = {};
  for (const [k, v] of strat) {
    const order = [v[chk], ...v.filter((_, j) => j !== chk)];
    combos[k] = [order.map((x) => Math.round(x * 10000) / 10000), (fold.get(k) || []).map((x) => (x === undefined ? null : Math.round(x * 10000) / 10000))];
  }
  return { id: s.id, exploit_pct: status.exploit_pct, sizes, combos };
}

(async () => {
  const spots = fs.readFileSync(IN, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const done = new Set();
  if (fs.existsSync(OUT)) for (const l of fs.readFileSync(OUT, 'utf8').split('\n')) if (l) done.add(JSON.parse(l).id);
  const out = fs.createWriteStream(OUT, { flags: 'a' });
  for (const s of spots) {
    if (done.has(s.id) || !s.calib) continue;
    try {
      const r = await solve(s);
      out.write(JSON.stringify(r) + '\n');
      console.error(`${s.id} expl=${r.exploit_pct.toFixed(3)}% sizes=${r.sizes}`);
    } catch (e) {
      out.write(JSON.stringify({ id: s.id, error: String(e.message || e) }) + '\n');
      console.error(`${s.id} ERROR ${e.message}`);
    }
  }
  out.end();
})();
