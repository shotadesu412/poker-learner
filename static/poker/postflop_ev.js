// ポストフロップの判定（2026/11/17〜）。選べるアクションの期待値（EV）を並べて比べ、
// 「最善手からどれだけ損したか（ポットに対する割合）」で ◎◯△× を付ける。
//
// 以前の判定は「勝率 ÷ 必要勝率」の比や固定の閾値を組み合わせたもので、
//   - 同じ場面のコール/フォールド/レイズを比べていない（それぞれ別の基準で採点）
//   - フォールドエクイティが相手のレンジを見ていない（0.40 + 0.30×サイズ の固定式）
//   - 相手のコールレンジがベットサイズで変わらない
//   - リバーでも「実現率」で勝率を割り引く / IP・OOP をポジション名で決め打ち
// といった弱点があり、大量のハンドで検証すると「生の勝率と必要勝率だけで決める素朴な判定」より
// 被ベット時の判定精度が低かった（scratchpad の監査。CLAUDE.md・MIGRATION_NOTES.md 参照）。
//
// モデル（1ストリート先読み。Chen & Ankenman "The Mathematics of Poker" の1ストリートの考え方）:
//   基準 = 今フォールド（またはチェックせず何もしない）したときを 0 とした追加の損得（bb）
//   コール   : R × eq × (P + c) − c
//   ベット b : FE × P + (1 − FE) × (R × eqC × (P + 2b) − b)
//   レイズ   : ベットと同じ形（相手が追加で払う額を含める）
//   チェック : R × eq × P
//   P = 今のポット / c = コール額 / eq = 相手の推定レンジに対する勝率
//   FE（相手が降りる割合）と eqC（続けてくる手に対する勝率）は、相手レンジの各コンボについて
//   行動モデル（range_model.js の ActionModel。CPU が実際に使う確率）で「このサイズに降りる/続ける確率」を出して求める。
//   その際の相手の勝率は「あなたがこのサイズで打ったあとのあなたのレンジ（ベイズ更新）」に対するもの。
//   （最初の版は相手が最小防衛頻度 MDF = P/(P+b) で守ると仮定したが、強いレンジでベットしてきた相手まで
//    MDF 分降りる計算になり、勝率22%の手のレイズが最善と出たため置き換えた）
//   R = 実現率（エクイティのうち実際に回収できる割合）。リバーは 1。それ以外は IP/OOP・手の種類で決める
// 勝率は相手の推定レンジ（ranges.js がアクションごとに更新）の各コンボに対して計算する。
// 勝率は range_model.js の順位表（リバー・ターンは全通り、フロップは固定の80通り）で計算するので、
// 同じ局面なら何度計算しても同じ判定になる（以前は 1000 回のモンテカルロで約11%の選択肢の記号が揺れた）。
//
// 依存: hand_eval.js, ranges.js, hand_classifier.js, rng.js, messages.js, pyfmt.js, bet_sizing.js, range_model.js

(function (root) {
  if (typeof module !== 'undefined') {
    for (const m of ['hand_eval', 'ranges', 'hand_classifier', 'rng', 'messages', 'pyfmt', 'bet_sizing', 'range_model']) require('./' + m + '.js');
  }

  const t = (k, kw) => root.Messages.t(k, kw);

  // 画面のボタンと同じサイズ（script.js の getActionSizes と揃える）
  const BET_SIZES = { FLOP: [0.33, 0.55, 0.85], TURN: [0.33, 0.66, 1.0], RIVER: [0.33, 0.75, 1.5] };
  const RAISE_MULTS = { FLOP: [2.5, 3.5, 4.5], TURN: [2.5, 3.5, 4.5], RIVER: [2.5, 3.5, 5.0] };

  // 実現率の直線（勝率 0.5 での値と傾き）。tools/audit のロールアウトに合わせた
  const REALIZE = {
    FLOP: { ip: { base: 0.95, slope: 1.0 }, oop: { base: 0.82, slope: 1.3 } },
    TURN: { ip: { base: 0.95, slope: 0.6 }, oop: { base: 0.85, slope: 0.8 } },
  };

  // 判定の閾値（最善手との差 ÷ ポット）
  const GRADE = { optimal: 0.02, good: 0.07, marginal: 0.15 };

  const PostflopEV = {
    BET_SIZES, RAISE_MULTS, GRADE,

    // 実現率（エクイティのうち実際に回収できる割合）。強い手ほど高く、弱い手ほど低い（強い手は後のストリートや
    // 相手のベットからさらに取れ、弱い手は後で降ろされる）。係数は大量ハンドのロールアウトで測った値に合わせた
    // （tools/audit。フロップ OOP で勝率20%の手は約0.4、70%の手は約1.1）。
    //   passive  … チェック・コールした側 / aggressor … ベット・レイズしてコールされた側
    realization(kind, street, ip, heroHand, board, eq = 0.5) {
      if (kind === 'aggressor') return street === 'RIVER' ? 1.0 : (ip ? 1.0 : 0.92);
      if (street === 'RIVER') {
        if (kind === 'call' || ip) return 1.0;                 // コールで終わる / IP のチェックはショーダウン
        return Math.max(0.5, Math.min(1.3, 1.0 + 0.6 * (eq - 0.5)));   // OOP のチェックは相手のベットに対応が要る
      }
      const C = REALIZE[street][ip ? 'ip' : 'oop'];
      let r = C.base + C.slope * (eq - 0.5);
      const draw = root.HandClassifier.detectDrawStrength(heroHand, board);
      if (draw === 'STRONG_DRAW') r = Math.max(r, ip ? 1.0 : 0.9);   // 強いドローは完成したときに追加で取れる
      return Math.max(0.3, Math.min(1.4, r));
    },

    // 選べるアクション（画面のボタンと同じ）。[action, 追加で出す額]
    options(eng) {
      const f = Math.max(0, eng.currentBet - eng.heroInvested);
      const pot = eng.potSize;
      const max = eng.maxAdditionalBet('HERO');
      const out = [];
      if (f > 0.01) { out.push(['FOLD', 0]); out.push(['CALL', Math.min(f, eng.heroStack)]); }
      else out.push(['CHECK', 0]);
      const kind = f > 0.01 ? 'RAISE' : 'BET';
      if (max > f + 0.05) {
        const raw = f > 0.01 ? RAISE_MULTS[eng.street].map((m) => f * m) : BET_SIZES[eng.street].map((x) => pot * x);
        const seen = new Set();
        for (let s of raw) {
          s = Math.round(s * 10) / 10;
          if (s >= max - 0.05) s = max;
          if (seen.has(s)) continue;
          seen.add(s);
          out.push([kind, s]);
        }
      }
      return out;
    },

    // 1つのアクションの EV（今フォールド/何もしない = 0 基準）
    actionEv(ctx, action, amount) {
      const { pot, facing, eq, street, ip, heroHand, board } = ctx;
      if (action === 'FOLD') return { ev: 0 };
      if (action === 'CHECK') {
        const R = PostflopEV.realization('check', street, ip, heroHand, board, eq);
        return { ev: R * eq * pot };
      }
      if (action === 'CALL') {
        const c = amount;
        const R = PostflopEV.realization('call', street, ip, heroHand, board, eq);
        return { ev: R * eq * (pot + c) - c };
      }
      // BET / RAISE: amount = 追加で出す額。相手が追加で払う額 = amount - facing
      const resp = PostflopEV.response(ctx, action, amount);
      const oppCall = Math.max(0, amount - facing);
      const R = PostflopEV.realization('aggressor', street, ip, heroHand, board);
      const ev = resp.fe * pot + (1 - resp.fe) * (Math.min(1, R * resp.eqC) * (pot + amount + oppCall) - amount);
      return { ev, fe: resp.fe, eqC: resp.eqC };
    },

    // あなたが amount を打ったときの相手の反応（行動モデル）。fe = 降りる割合、eqC = 続けてくる手に対する勝率
    response(ctx, action, amount) {
      const RM = root.RangeModel;
      const { table, cpuVec, heroVec, cpuVecPublic, eHero, heroCtx, eng } = ctx;
      const heroAfter = RM.posterior(table, heroVec, cpuVecPublic, heroCtx, action, amount, false);
      // CPU が実際に持っているのは（あなたの手札と重ならない）公開レンジなので、防衛の境目は公開レンジで計算する
      const eCpuPub = table.equityVector(cpuVecPublic, heroAfter);
      const eCpu = eCpuPub;
      const base = {
        street: ctx.street, facing: Math.max(0.01, amount - ctx.facing), pot: ctx.pot + amount,
        stack: eng.cpuStack, ip: !ctx.ip, wasAggressor: false, opponentChecked: false, texture: '',
      };
      base.mdfE = RM.mdfEdge(eCpuPub, cpuVecPublic, base);
      let wSum = 0, wFold = 0, wCont = 0, eqCont = 0;
      for (let i = 0; i < RM.N; i++) {
        const w = cpuVec[i];
        if (!(w > 0) || Number.isNaN(eCpu[i]) || Number.isNaN(eHero[i])) continue;
        const nr = table.nowRank[i];
        const dist = RM.ActionModel.probs({ ...base, e: eCpu[i], made: nr <= 6185, draw: table.draw(i) });
        let pf = 0;
        for (const o of dist) if (o.action === 'FOLD') pf += o.p;
        wSum += w; wFold += w * pf; wCont += w * (1 - pf); eqCont += w * (1 - pf) * eHero[i];
      }
      if (wSum <= 0) return { fe: 0, eqC: ctx.eq };
      return { fe: wFold / wSum, eqC: wCont > 0 ? eqCont / wCont : ctx.eq };
    },

    // 判定本体。eng はアクション前のエンジン
    evaluate(eng, action, amount) {
      const { Py } = root;
      const heroHand = eng.heroHand, board = eng.board;
      const facing = Math.max(0, eng.currentBet - eng.heroInvested);
      const RM = root.RangeModel;
      const table = RM.tableFor(board);
      const cpuVecPublic = RM.toVec(eng.cpuRange);
      const cpuVec = RM.removeCards(cpuVecPublic, heroHand);   // あなたの手札と重なるコンボは除く
      const eHero = table.handVsCombos(RM.comboIndex(heroHand));
      let ws = 0, es = 0;
      for (let i = 0; i < RM.N; i++) if (cpuVec[i] > 0 && !Number.isNaN(eHero[i])) { ws += cpuVec[i]; es += cpuVec[i] * eHero[i]; }
      const ctx = {
        pot: eng.potSize, facing, eq: ws > 0 ? es / ws : 0.5, street: eng.street,
        ip: eng.isHeroIp, heroHand, board, maxBet: eng.maxAdditionalBet('HERO'),
        table, cpuVec, cpuVecPublic, heroVec: RM.toVec(eng.heroRange), eHero, heroCtx: eng._modelContext('HERO'), eng,
      };
      if (action === 'CALL') amount = Math.min(facing, eng.heroStack);
      const opts = PostflopEV.options(eng).map(([a, x]) => ({ action: a, amount: x, ...PostflopEV.actionEv(ctx, a, x) }));
      let chosen = opts.find((o) => o.action === action && Math.abs(o.amount - amount) < 0.051);
      if (!chosen) {
        chosen = { action, amount, ...PostflopEV.actionEv(ctx, action, amount) };
        opts.push(chosen);
      }
      const best = opts.reduce((a, b) => (b.ev > a.ev ? b : a));
      const loss = Math.max(0, best.ev - chosen.ev);
      const lossPct = loss / Math.max(0.5, ctx.pot);
      const B = root.BetSizing;
      let evaluation = lossPct <= GRADE.optimal ? B.EVAL_OPTIMAL : lossPct <= GRADE.good ? B.EVAL_GOOD
        : lossPct <= GRADE.marginal ? B.EVAL_MARGINAL : B.EVAL_BAD;

      const name = (o) => PostflopEV.actionName(o, ctx);
      const lines = [];
      const kw = { best: name(best), pct: lossPct * 100, bb: loss };
      if (best === chosen || lossPct <= 0.005) lines.push(t('pf.verdict.best', { act: name(chosen) }));
      else if (evaluation === B.EVAL_OPTIMAL) lines.push(t('pf.verdict.close', kw));
      else if (evaluation === B.EVAL_GOOD) lines.push(t('pf.verdict.good', kw));
      else if (evaluation === B.EVAL_MARGINAL) lines.push(t('pf.verdict.inaccuracy', kw));
      else lines.push(t('pf.verdict.mistake', kw));

      // 根拠
      if (facing > 0.01) {
        const req = facing / (ctx.pot + facing);
        if (ctx.street === 'RIVER') lines.push(t('pf.basis.facing_river', { eq: ctx.eq * 100, req: req * 100 }));
        else {
          const R = PostflopEV.realization('call', ctx.street, ctx.ip, heroHand, board, ctx.eq);
          lines.push(t('pf.basis.facing', { eq: ctx.eq * 100, real: Math.min(1, R * ctx.eq) * 100, req: req * 100 }));
        }
      } else {
        lines.push(t('pf.basis.check', { eq: ctx.eq * 100 }));
      }
      const agg = (chosen.action === 'BET' || chosen.action === 'RAISE') ? chosen
        : ((best.action === 'BET' || best.action === 'RAISE') ? best : null);
      if (agg) lines.push(t('pf.basis.bet', { act: name(agg), fe: agg.fe * 100, eqc: agg.eqC * 100 }));
      const fmt = (v) => (v >= 0 ? '+' : '') + Py.formatFixed(v, 1);
      lines.push(t('pf.ev_list', {
        list: opts.slice().sort((a, b) => b.ev - a.ev)
          .map((o) => `・${name(o)} ${fmt(o.ev)}bb${o === chosen ? ' ' + t('pf.you') : ''}`).join('\n'),
      }));
      return {
        evaluation, reason: lines.join('\n'), ev: chosen.ev, ev_loss: loss, loss_pct: lossPct,
        req_eq: facing > 0.01 ? facing / (ctx.pot + facing) : 0, realized_eq: ctx.eq,
        best: { action: best.action, amount: best.amount },
        options: opts.map((o) => ({ action: o.action, amount: Py.round(o.amount, 2), ev: Py.round(o.ev, 3) })),
      };
    },

    actionName(o, ctx) {
      if (o.action === 'FOLD') return t('pf.act.fold');
      if (o.action === 'CALL') return t('pf.act.call');
      if (o.action === 'CHECK') return t('pf.act.check');
      const allIn = o.action !== 'FOLD' && ctx && o.amount >= 0 && Math.abs(o.amount - ctx.maxBet) < 0.06;
      if (allIn) return t('pf.act.allin');
      if (o.action === 'BET') return t('pf.act.bet', { pct: o.amount / Math.max(0.01, ctx.pot) * 100 });
      return t('pf.act.raise', { x: o.amount / Math.max(0.01, ctx.facing) });
    },
  };

  root.PostflopEV = PostflopEV;
  if (typeof module !== 'undefined') module.exports = PostflopEV;
})(typeof window !== 'undefined' ? window : globalThis);
