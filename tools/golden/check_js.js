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
  // シード付き乱数（mulberry32）で毎回同じ結果にする。たまに落ちるテストは信用されなくなるため
  const seeded = (seed) => () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
  for (const [i, s] of exp.spots.entries()) {
    const hero = s.hero.map(Card.fromStr);
    const board = s.board.map(Card.fromStr);
    const hr = new Map(s.hero_range);
    const cr = new Map(s.cpu_range);
    const [eq] = Equity.calcEquityMonteCarlo(hero, board, hr, cr, 'CPU', false, N_JS, seeded(1000 + i));
    const adv = Equity.calcRangeAdvantage(hero, board, hr, cr, false, N_JS, seeded(5000 + i));
    for (const [name, py, js] of [['equity', s.equity, eq], ['range_adv', s.range_adv, adv]]) {
      const z = zOf(py, js);
      zs.push(z);
      maxZ = Math.max(maxZ, Math.abs(z));
      if (Math.abs(z) >= 4) {
        fails.push(`${name} ${s.hero} [${s.board}] ${s.label}: Python ${py.toFixed(4)} JS ${js.toFixed(4)} z=${z.toFixed(2)}`);
      }
    }
  }
  // equity_vs_calling_range（コールレンジへの絞り込み + モンテカルロ）
  const Ev = require(path.join(ROOT, 'static', 'poker', 'evaluator.js'));
  for (const [i, c] of exp.eq_called.entries()) {
    const s = exp.spots[c.spot];
    const js = Ev.equityVsCallingRange(s.hero.map(Card.fromStr), s.board.map(Card.fromStr),
      new Map(s.hero_range), new Map(s.cpu_range), c.bet, 8.0, N_JS, seeded(9000 + i));
    const z = zOf(c.eq_called, js);
    zs.push(z);
    maxZ = Math.max(maxZ, Math.abs(z));
    if (Math.abs(z) >= 4) fails.push(`eq_called ${s.hero} [${s.board}] bet=${c.bet}: Python ${c.eq_called.toFixed(4)} JS ${js.toFixed(4)} z=${z.toFixed(2)}`);
  }
  const ak = ['As', 'Kd'].map(Card.fromStr), flop = ['Qh', '7c', '2d'].map(Card.fromStr);
  const cases = {
    no_board: [ak, [], new Map([['AA', 1.0]]), new Map([['KK', 1.0]])],
    no_cards: [[], flop, new Map([['AA', 1.0]]), new Map([['KK', 1.0]])],
    no_hero_range: [ak, flop, new Map(), new Map([['KK', 1.0]])],
    no_cpu_range: [ak, flop, new Map([['AA', 1.0]]), new Map()],
    all_zero: [ak, flop, new Map([['AA', 1.0]]), new Map([['KK', 0.0], ['QQ', 0.0]])],
  };
  for (const nc of exp.none_cases) {
    const js = Ev.equityVsCallingRange(...cases[nc.label], 4.0, 8.0, 50);
    if (js !== nc.result) fails.push(`equityVsCallingRange(${nc.label}): 期待 ${nc.result} 実際 ${js}`);
  }

  const bias = zs.reduce((a, b) => a + b, 0) / Math.sqrt(zs.length);
  if (Math.abs(bias) >= 4) fails.push(`系統的な偏り: Σz/√n = ${bias.toFixed(2)}`);
  console.log(`     (最大|z| = ${maxZ.toFixed(2)}, 偏り Σz/√n = ${bias.toFixed(2)})`);
  return { n: zs.length, fails };
}

// ---- フェーズ4: 評価ロジック ----
// generate.py と同じ定数（ベクタはボード名・ハンド文字列で保存されている）
const BOARDS = {
  'dry_K83r': ['Kd', '8s', '3c'],
  'dry_A72r': ['Ad', '7c', '2d'],
  'wet_986tt': ['9h', '8c', '6s'],
  'monotone_Q72': ['Qh', '7h', '2h'],
  'paired_K K 4': ['Kd', 'Kc', '4h'],
  'turn_K83rQ': ['Kd', '8s', '3c', 'Qh'],
  'river_K83rQ2': ['Kd', '8s', '3c', 'Qh', '2d'],
};
const P = (m) => require(path.join(ROOT, 'static', 'poker', m + '.js'));
const splitHand = (h) => [h.slice(0, 2), h.slice(2, 4)];

// 差し替え（Python の staticmethod 差し替えと同じ）。終わったら必ず戻す
function withStubs(obj, stubs, fn) {
  const orig = {};
  for (const k of Object.keys(stubs)) { orig[k] = obj[k]; obj[k] = stubs[k]; }
  try { return fn(); } finally { Object.assign(obj, orig); }
}

function checkPureFunctions() {
  const { Card } = P('hand_eval');
  const Py = P('pyfmt'), EV = P('ev_calculator'), HC = P('hand_classifier'), BS = P('bet_sizing');
  const Ev = P('evaluator');
  P('messages').setLang('ja');
  const rows = load('pure_functions');
  const fails = [];
  const r6 = (x) => Py.round(x, 6);
  const cs = (arr) => arr.map(Card.fromStr);
  for (const r of rows) {
    let got;
    switch (r.fn) {
      case 'realize_equity': got = r6(Ev.realizeEquity(r.equity, r.eqr)); break;
      case 'required_equity': got = r6(EV.calculateRequiredEquity(r.bet, r.pot)); break;
      case 'mdf': got = r6(EV.calculateMdf(r.bet, r.pot)); break;
      case 'alpha': got = r6(EV.calculateAlpha(r.bet, r.pot)); break;
      case 'bluff_freq': got = r6(Ev.calculateTheoreticalBluffFrequency(r.bet, r.pot)); break;
      case 'fold_equity': got = r6(Ev.estimateFoldEquity(r.pot, r.bet, r.texture)); break;
      case 'ev_call': got = r6(EV.evCall(r.equity, r.pot, r.bet)); break;
      case 'ev_check': got = r6(EV.evCheck(r.equity, r.pot)); break;
      case 'ev_bet': got = r6(EV.evBet(r.equity, r.pot, r.bet, r.fold_equity)); break;
      case 'board_texture': got = HC.classifyBoardTexture(cs(BOARDS[r.board])); break;
      case 'categorize_hand': got = HC.categorizeHand(cs(splitHand(r.hand)), cs(BOARDS[r.board])); break;
      case 'detect_draw': got = HC.detectDrawStrength(cs(splitHand(r.hand)), cs(BOARDS[r.board])); break;
      case 'bet_sizing': got = BS.evaluateBetSizing(r.pot, r.bet, r.texture).evaluation; break;
      default: fails.push('未知の fn: ' + r.fn); continue;
    }
    if (got !== r.out) fails.push(`${r.fn} ${JSON.stringify(r)}: 実際 ${got}`);
  }
  return { n: rows.length, fails };
}

function checkPreflop() {
  const { Card } = P('hand_eval');
  const Ev = P('evaluator');
  P('messages').setLang('ja');
  const rows = load('preflop');
  const fails = [];
  const toCards = (combo) => (combo.length === 2 ? [combo[0] + 's', combo[1] + 'h']
    : combo[2] === 's' ? [combo[0] + 's', combo[1] + 's'] : [combo[0] + 's', combo[1] + 'h']).map(Card.fromStr);
  for (const r of rows) {
    const [decision, ev] = Ev.evaluatePreflopActionGto(toCards(r.combo), r.action, r.pos, r.is_3bet_pot, r.facing_bet);
    if (decision !== r.decision || ev !== r.evaluation) {
      fails.push(`${r.combo} ${r.pos} ${r.action} facing=${r.facing_bet} 3bet=${r.is_3bet_pot}: 期待 ${r.decision}/${r.evaluation} 実際 ${decision}/${ev}`);
    }
  }
  return { n: rows.length, fails };
}

function checkPostflop() {
  const { Card } = P('hand_eval');
  const Py = P('pyfmt'), Ev = P('evaluator');
  P('messages').setLang('ja');
  const rows = load('postflop');
  const fails = [];
  const r6 = (x) => Py.round(x, 6);
  for (const r of rows) {
    const board = BOARDS[r.board].map(Card.fromStr);
    const hero = splitHand(r.hand).map(Card.fromStr);
    const potIncl = r.pot_before + r.bet;
    let bad = false;
    if (r.fn === 'call') {
      const c = Ev.evaluateCall(r.equity, r.bet, potIncl, 'BB', hero, false, board, 95.0, r.range_adv, null, r.street);
      bad = c.evaluation !== r.evaluation || r6(c.ev) !== r.ev || r6(c.realized_eq) !== r.realized_eq || r6(c.req_eq) !== r.req_eq;
    } else {
      const f = Ev.evaluateFold(r.equity, r.bet, potIncl, 'BB', hero, false, board, r.range_adv, 95.0, r.street);
      bad = f.evaluation !== r.evaluation || r6(f.realized_eq) !== r.realized_eq || r6(f.req_eq) !== r.req_eq ||
        (f.mdf === undefined ? null : f.mdf) !== (r.mdf === undefined ? null : r.mdf);
    }
    if (bad) fails.push(`${r.fn} ${r.board} ${r.hand} eq=${r.equity} pot=${r.pot_before} bet=${r.bet} adv=${r.range_adv}`);
  }
  return { n: rows.length, fails };
}

function checkBetRaiseCheck() {
  const { Card } = P('hand_eval');
  const Ev = P('evaluator'), HC = P('hand_classifier');
  P('messages').setLang('ja');
  const rows = load('bet_raise_check');
  const fails = [];
  const board = BOARDS['dry_K83r'].map(Card.fromStr);
  const hero = ['7s', '7d'].map(Card.fromStr);
  const hr = new Map([['AA', 1.0]]), cr = new Map([['KK', 1.0]]);
  for (const r of rows) {
    const got = withStubs(Ev, { equityVsCallingRange: () => r.eq_called }, () =>
      withStubs(HC, { detectDrawStrength: () => r.draw }, () => {
        if (r.fn === 'bet') return Ev.evaluateBet(r.equity, r.bet, r.pot, 'BTN', hero, board, 0.5, 95.0, r.street, hr, cr, r.is_donk);
        if (r.fn === 'raise') return Ev.evaluateRaise(r.equity, r.bet, 1.8, r.pot, 'BTN', hero, board, 0.5, hr, 95.0, r.street, cr);
        return Ev.evaluateCheck(r.equity, r.pot, 'BTN', r.has_initiative, r.is_hero_ip, hero, board, 0.5, 95.0, r.street, hr, cr);
      }));
    if (got.evaluation !== r.evaluation) {
      fails.push(`${r.fn} ${JSON.stringify(r)}: 実際 ${got.evaluation}`);
    }
  }
  return { n: rows.length, fails };
}

// evaluator_full: 全フィールドを === で比較（浮動小数点もビット一致、解説文は日英とも）
function checkEvaluatorFull() {
  const { Card } = P('hand_eval');
  const Py = P('pyfmt'), Ev = P('evaluator'), HC = P('hand_classifier'), BS = P('bet_sizing');
  const Msg = P('messages');
  const Ranges = P('ranges');
  const exp = load('evaluator_full');
  const S = exp.strings;
  const fails = [];
  let n = 0;
  const cs = (arr) => arr.map(Card.fromStr);
  const inLangs = (fn) => {
    Msg.setLang('ja'); const ja = fn();
    Msg.setLang('en'); const en = fn();
    Msg.setLang('ja');
    return { ja, en };
  };
  const diff = (label, want, got) => {
    for (const k of Object.keys(want)) {
      if (want[k] !== got[k]) return `${label}: ${k} 期待 ${JSON.stringify(want[k])} 実際 ${JSON.stringify(got[k])}`;
    }
    return null;
  };

  for (const r of exp.preflop) {
    n++;
    const { ja, en } = inLangs(() => Ev.evaluatePreflopActionGto(cs(r.combo.length === 2
      ? [r.combo[0] + 's', r.combo[1] + 'h'] : r.combo[2] === 's' ? [r.combo[0] + 's', r.combo[1] + 's'] : [r.combo[0] + 's', r.combo[1] + 'h']),
      r.action, r.pos, r.is_3bet_pot, r.facing_bet));
    const d = diff(`preflop ${r.combo} ${r.pos} ${r.action} facing=${r.facing_bet} 3bet=${r.is_3bet_pot}`,
      { decision: r.decision, evaluation: r.evaluation, reason_ja: S[r.reason_ja], reason_en: S[r.reason_en] },
      { decision: ja[0], evaluation: ja[1], reason_ja: ja[2], reason_en: en[2] });
    if (d) fails.push(d);
  }

  const hr = new Map([['AA', 1.0]]), cr = new Map([['KK', 1.0]]);
  for (const r of exp.postflop) {
    n++;
    const hero = cs(r.hand), board = cs(r.board);
    const call = () => withStubs(Ev, { equityVsCallingRange: () => r.eq_called }, () => {
      switch (r.fn) {
        case 'call': return Ev.evaluateCall(r.equity, r.bet, r.pot, r.pos, hero, r.is_3bet_pot, board, r.stack, r.range_adv, null, r.street);
        case 'fold': return Ev.evaluateFold(r.equity, r.bet, r.pot + r.bet, r.pos, hero, r.is_3bet_pot, board, r.range_adv, r.stack, r.street);
        case 'bet': return Ev.evaluateBet(r.equity, r.bet, r.pot, r.pos, hero, board, r.range_adv, r.stack, r.street, hr, cr, r.is_donk);
        case 'raise': return Ev.evaluateRaise(r.equity, r.raise_amount, r.bet, r.pot, r.pos, hero, board, r.range_adv, hr, r.stack, r.street, cr);
        default: return Ev.evaluateCheck(r.equity, r.pot, r.pos, r.has_initiative, r.is_hero_ip, hero, board, r.range_adv, r.stack, r.street, hr, cr);
      }
    });
    const { ja, en } = inLangs(call);
    const want = { evaluation: r.evaluation, ev: r.ev, req_eq: r.req_eq, realized_eq: r.realized_eq,
      reason_ja: S[r.reason_ja], reason_en: S[r.reason_en] };
    const got = { evaluation: ja.evaluation, ev: ja.ev, req_eq: ja.req_eq, realized_eq: ja.realized_eq,
      reason_ja: ja.reason, reason_en: en.reason };
    if ('mdf' in r || 'mdf' in ja) { want.mdf = r.mdf; got.mdf = ja.mdf; }
    const d = diff(`${r.fn} ${r.hand} [${r.board}] ${r.pos} eq=${r.equity} pot=${r.pot} bet=${r.bet} stack=${r.stack}`, want, got);
    if (d) fails.push(d);
  }

  for (const r of exp.parts) {
    n++;
    const hero = cs(r.hand), board = cs(r.board);
    const texture = HC.classifyBoardTexture(board);
    const sz = inLangs(() => (board.length ? BS.evaluateBetSizing(r.pot, r.bet, texture, r.sizing_spr)
      : { evaluation: '', reason: '' }));
    const got = {
      eqr: Ev.getEqrModifier(r.pos, hero, r.is_3bet_pot, board, r.range_adv, r.spr, r.street),
      pi: Ev.calculatePi(hero, board),
      category: HC.categorizeHand(hero, board),
      draw: HC.detectDrawStrength(hero, board),
      texture,
      combo: Ev.getComboStr(hero, Ranges.ALL_HANDS_DICT),
    };
    const d = diff(`parts ${r.hand} [${r.board}] ${r.pos} spr=${r.spr} street=${r.street}`,
      { eqr: r.eqr, pi: r.pi, category: r.category, draw: r.draw, texture: r.texture, combo: r.combo }, got);
    if (d) fails.push(d);
    const ds = diff(`sizing pot=${r.pot} bet=${r.bet} ${texture} spr=${r.sizing_spr}`,
      { evaluation: r.sizing.evaluation, reason_ja: S[r.sizing.reason_ja], reason_en: S[r.sizing.reason_en] },
      { evaluation: sz.ja.evaluation, reason_ja: sz.ja.reason, reason_en: sz.en.reason });
    if (ds) fails.push(ds);
  }

  for (const r of exp.format) {
    n++;
    if ('spec' in r) {
      const got = Py.formatFixed(r.x, Number(r.spec.slice(1, -1)));
      if (got !== r.out) fails.push(`format(${r.x}, "${r.spec}"): 期待 ${r.out} 実際 ${got}`);
    } else {
      const got = Py.round(r.x, 3);
      if (got !== r.round3) fails.push(`round(${r.x}, 3): 期待 ${r.round3} 実際 ${got}`);
    }
  }
  return { n, fails };
}

// ---- フェーズ5: エンジン・CPU AI・ゲーム進行（乱数テープで Python と1件ずつ比較）----
// 最初に食い違ったパスを返す（数値は === 。JSON を通した形で比べる）
function firstDiff(want, got, p = '') {
  if (want === got) return null;
  if (typeof want !== typeof got || want === null || got === null || typeof want !== 'object') {
    return `${p || '(root)'}: 期待 ${JSON.stringify(want)} 実際 ${JSON.stringify(got)}`;
  }
  if (Array.isArray(want) !== Array.isArray(got)) return `${p}: 配列かどうかが違う`;
  const keys = new Set([...Object.keys(want), ...Object.keys(got)]);
  for (const k of keys) {
    if (!(k in want)) return `${p}.${k}: Python に無いキー（実際 ${JSON.stringify(got[k]).slice(0, 80)}）`;
    if (!(k in got)) return `${p}.${k}: JS に無いキー（期待 ${JSON.stringify(want[k]).slice(0, 80)}）`;
    const d = firstDiff(want[k], got[k], `${p}.${k}`);
    if (d) return d;
  }
  return null;
}

function checkGameTape() {
  const Rng = P('rng');
  const Game = P('game');
  P('messages').setLang('ja');
  const games = load('game_tape');
  const fails = [];
  let n = 0;
  for (const gm of games) {
    const rng = Rng.seeded(gm.seed);
    const calls = [];
    const game = new Game({
      rng,
      hooks: {
        newSessionId: () => 'sid',
        startSession: (sid, pos, hand) => calls.push({ fn: 'start_session', hero_pos: pos, hero_hand: hand }),
        logAction: ({ session_id, ...kw }) => calls.push({ fn: 'log_action', ...kw }),
        finishHand: ({ session_id, ...kw }) => calls.push({ fn: 'finish_hand', ...kw }),
      },
    });
    for (const [i, st] of gm.steps.entries()) {
      n++;
      let res;
      try {
        if (st.kind === 'start_hand') res = game.startHand(st.req);
        else if (st.kind === 'action') res = game.action(st.req);
        else res = game.currentState();
      } catch (e) {
        fails.push(`seed=${gm.seed} step${i} ${st.kind}: 例外 ${e.stack.split('\n').slice(0, 3).join(' / ')}`);
        break;
      }
      const d = firstDiff(st.res, JSON.parse(JSON.stringify(res)));
      const rngDiff = rng.count() !== st.rng ? `（乱数の消費数 Python ${st.rng} / JS ${rng.count()}）` : '';
      if (d || rngDiff) {
        fails.push(`seed=${gm.seed} step${i} ${st.kind} ${JSON.stringify(st.req)}: ${d || ''}${rngDiff}`);
        break;   // 1つずれると以降は全部ずれるので、ゲームごとに最初の1件だけ出す
      }
    }
    n++;
    const d = firstDiff(gm.stats, JSON.parse(JSON.stringify(calls)));
    if (d && !fails.some((f) => f.startsWith(`seed=${gm.seed} `))) fails.push(`seed=${gm.seed} 統計の保存呼び出し: ${d}`);
  }
  return { n, fails };
}

// フェーズ6: 分析ページの集計。stats_vectors.py が本物の stats_logger で出した戻り値と比較する
function checkStatsCalc() {
  const S = P('stats_calc');
  const M = P('messages');
  const vec = load('stats_calc');
  const fails = [];
  let n = 0;
  // 時刻の書式（Python の isoformat）と往復
  for (const iso of ['2026-09-27T04:30:00.123456+00:00', '2026-09-27T04:30:00+00:00', '2026-01-01T00:00:00.000001+00:00']) {
    n++;
    const { ms, micro } = S.parseIso(iso);
    if (S.formatIso(ms, micro) !== iso) fails.push(`時刻の往復: ${iso} -> ${S.formatIso(ms, micro)}`);
  }
  for (const snap of vec.snapshots) {
    for (const lang of ['ja', 'en']) {
      M.setLang(lang);
      const want = snap.results[lang];
      const got = {};
      for (const p of ['all', '30d', '7d', 'last']) {
        got[`overview:${p}`] = S.getOverview(vec.data, p, snap.now);
        got[`personal_range:${p}`] = S.getPersonalRangeStats(vec.data, p, snap.now);
      }
      got.position = S.getPositionStats(vec.data);
      got.streets = S.getStreetEvalDist(vec.data);
      got.leaks = S.getLeaks(vec.data);
      got.saved_hands = S.getSavedHands(vec.data);
      got['hand_history:30'] = S.getHandHistory(vec.data, 30);
      got['hand_history:1000'] = S.getHandHistory(vec.data, 1000);
      for (const k of Object.keys(want)) {
        n++;
        const d = firstDiff(want[k], JSON.parse(JSON.stringify(got[k])));
        if (d) fails.push(`now=${snap.now} ${lang} ${k}: ${d}`);
      }
    }
  }
  M.setLang('ja');
  return { n, fails };
}

const CHECKS = {
  game_tape: checkGameTape,
  stats_calc: checkStatsCalc,
  pure_functions: checkPureFunctions,
  preflop: checkPreflop,
  postflop: checkPostflop,
  bet_raise_check: checkBetRaiseCheck,
  evaluator_full: checkEvaluatorFull,
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
