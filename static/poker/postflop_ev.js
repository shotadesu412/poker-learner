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

  // ドンクを最善とする、チェックに対する予測の得の下限（ポット比）。監査で、これ未満の予測は実際には得でなかった
  const DONK_MIN_EDGE = 0.10;

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

    // レイズの3つのサイズ（追加で出す額）。2.5倍・3.5倍と、ポットサイズのレイズ（コール後のポットと同じ額を上乗せ）。
    // 相手のベットが大きく、ポットサイズが元の一番大きい倍率（4.5倍・リバー5倍）より小さいときはその倍率（2026/11/21〜）。
    // 以前は倍率だけで、ポットの1割程度の小さいベットには5倍でもポットに対して小さすぎた。script.js の getActionSizes と揃える
    raiseSizes(street, facing, pot) {
      const m = RAISE_MULTS[street];
      const potRaise = pot + 2 * facing;   // pot は相手のベットを含む。コール額 + (コール後のポット)
      return [facing * m[0], facing * m[1], Math.max(facing * m[2], potRaise)];
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
        const raw = f > 0.01 ? PostflopEV.raiseSizes(eng.street, f, pot) : BET_SIZES[eng.street].map((x) => pot * x);
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
        // 先に動く（相手がまだ動いていない）チェックは、相手のベットまで読む（2026/11/19〜）
        const R = PostflopEV.realization('check', street, ip, heroHand, board, eq);
        const simple = R * eq * pot;
        // 新しい計算は「相手のベットから取れる分」を足すためのもの。弱い手では「ベットされたら降りる」としか見ないので
        // 以前の計算を下回ることがあり（監査でターンの弱い手のチェックを厳しく見すぎた）、大きい方を使う
        if (ctx.firstToAct && ctx.table) {
          const r = PostflopEV.checkFirstEv(ctx);
          return { ev: Math.max(simple, r.ev), pBet: r.pBet };
        }
        return { ev: simple };
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

    // 先に動いてチェックしたときの EV。相手は行動モデル（CPU が実際に使う確率）でチェックかベットを選び、
    //   チェックで返されたら → その手への勝率分を回収（ターン以前は実現率を掛ける）
    //   ベットされたら      → コールとフォールドの得な方（チェックレイズは入れない＝チェックを低めに見る近似）
    // 以前は「勝率 × 実現率 × ポット」だけで、相手がベットしてきたときに取れる分（ブラフや弱い手からのコール分）を
    // 入れていなかった。監査で、ターン・リバーで先に動く勝率80%以上の手は、モデルが「ベットが上」と見る一方、
    // 実際はチェックの方がポットの約2割得だった（tools/audit。2026/11/19）
    checkFirstEv(ctx) {
      const RM = root.RangeModel;
      const { table, cpuVec, heroVec, cpuVecPublic, eHero, heroCtx, eng, pot, street, heroHand, board } = ctx;
      const heroAfter = RM.posterior(table, heroVec, cpuVecPublic, heroCtx, 'CHECK', 0, false);
      const eCpu = table.equityVector(cpuVecPublic, heroAfter);
      const texture = eng.classifyBoardTexture(board);
      const stack = eng.cpuStack;
      const base = {
        street, facing: 0, pot, stack, ip: !ctx.ip, wasAggressor: eng.aggressor === 'CPU', opponentChecked: true, texture,
      };
      // 相手の各コンボがチェックで返す/ベットする確率
      let wSum = 0, wX = 0, eX = 0;
      const bets = new Map();   // ベット額 → { w, e, idx: [[i, 重み]] }
      for (let i = 0; i < RM.N; i++) {
        const w = cpuVec[i];
        if (!(w > 0) || Number.isNaN(eCpu[i]) || Number.isNaN(eHero[i])) continue;
        const dist = RM.ActionModel.probs({ ...base, e: eCpu[i], made: table.nowRank[i] <= 6185, draw: table.draw(i) });
        wSum += w;
        for (const o of dist) {
          if (!(o.p > 0)) continue;
          if (o.action === 'CHECK') { wX += w * o.p; eX += w * o.p * eHero[i]; continue; }
          const k = Math.round(o.amount * 100) / 100;
          const g = bets.get(k) || { w: 0, e: 0, idx: [] };
          g.w += w * o.p; g.e += w * o.p * eHero[i]; g.idx.push([i, w * o.p]);
          bets.set(k, g);
        }
      }
      if (wSum <= 0) {
        const R = PostflopEV.realization('check', street, ctx.ip, heroHand, board, ctx.eq);
        return { ev: R * ctx.eq * pot };
      }
      let ev = 0;
      if (wX > 0) {
        const eq = eX / wX;
        const R = PostflopEV.realization('call', street, ctx.ip, heroHand, board, eq);
        ev += (wX / wSum) * Math.min(1, R * eq) * pot;
      }
      const heroMax = eng.maxAdditionalBet('HERO');
      for (const [b, g] of bets) {
        // ベットされたら: フォールド（0）/ コール / チェックレイズ（ベットの3倍）の得な方
        const eqB = g.e / g.w;
        const Rc = PostflopEV.realization('call', street, ctx.ip, heroHand, board, eqB);
        const callEv = Math.min(1, Rc * eqB) * (pot + 2 * b) - b;
        let raiseEv = -Infinity;
        const r = Math.min(heroMax, b * 3);
        if (r > b + 0.05) {
          const heroCtx2 = { ...heroCtx, facing: b, pot: pot + b, opponentChecked: false };
          const heroRaise = RM.posterior(table, heroAfter, cpuVecPublic, heroCtx2, 'RAISE', r, false);
          const eCpu2 = table.equityVector(cpuVecPublic, heroRaise);
          const s2 = { street, facing: r - b, pot: pot + b + r, stack: Math.max(0, stack - b), ip: !ctx.ip,
            wasAggressor: true, opponentChecked: false, texture };
          // 相手の防衛の下限は、このサイズでベットしてきたレンジで計算する
          const betVec = new Float64Array(RM.N);
          for (const [i, w] of g.idx) betVec[i] = w;
          const hs2 = table.strength();
          s2.mdfE = RM.mdfEdge(hs2, betVec, s2);
          const Ra = PostflopEV.realization('aggressor', street, ctx.ip, heroHand, board);
          let acc = 0;
          for (const [i, w] of g.idx) {
            if (Number.isNaN(eCpu2[i])) continue;
            const d = RM.ActionModel.probs({ ...s2, e: eCpu2[i], made: table.nowRank[i] <= 6185, draw: table.draw(i), hs: hs2[i] });
            let pf = 0;
            for (const o of d) if (o.action === 'FOLD') pf += o.p;
            acc += w * (pf * (pot + b) + (1 - pf) * (Math.min(1, Ra * eHero[i]) * (pot + 2 * r) - r));
          }
          raiseEv = acc / g.w;
        }
        ev += (g.w / wSum) * Math.max(0, callEv, raiseEv);
      }
      return { ev, pBet: 1 - wX / wSum };
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
        // あなたが主導権の無い側で先に打つ（ドンク）なら、CPU はドンクへの返し方で反応する（engine の _modelContext と同じ）
        vsDonk: ctx.facing <= 0.01 && action === 'BET' && eng.streetStartAggressor === 'CPU'
          && !eng.actionHistory.some((a) => a.street === eng.street),
      };
      const hs = table.strength();
      base.mdfE = RM.mdfEdge(hs, cpuVecPublic, base);
      let wSum = 0, wFold = 0, wCont = 0, eqCont = 0;
      for (let i = 0; i < RM.N; i++) {
        const w = cpuVec[i];
        if (!(w > 0) || Number.isNaN(eCpu[i]) || Number.isNaN(eHero[i])) continue;
        const nr = table.nowRank[i];
        const dist = RM.ActionModel.probs({ ...base, e: eCpu[i], made: nr <= 6185, draw: table.draw(i), hs: hs[i] });
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
        // 先に動く = OOP で、このストリートで相手がまだ動いていない（チェックしても相手の番が来る）
        // フロップは以前の計算の方が監査の実測に合っていたので、ターン・リバーだけに使う
        firstToAct: eng.street !== 'FLOP' && !eng.isHeroIp && !eng.actionHistory.some((a) => a.street === eng.street && a.actor === 'CPU'),
      };
      if (action === 'CALL') amount = Math.min(facing, eng.heroStack);
      const opts = PostflopEV.options(eng).map(([a, x]) => ({ action: a, amount: x, ...PostflopEV.actionEv(ctx, a, x) }));
      let chosen = opts.find((o) => o.action === action && Math.abs(o.amount - amount) < 0.051);
      if (!chosen) {
        chosen = { action, amount, ...PostflopEV.actionEv(ctx, action, amount) };
        opts.push(chosen);
      }
      let best = opts.reduce((a, b) => (b.ev > a.ev ? b : a));
      // ドンクの場面（OOP・主導権なし・このストリートで先に動く）はチェックを基準にする（2026/11/21〜）。
      // 理論では主導権の無い側は先にチェックが基本。監査（ロールアウト）では、モデルが予測したドンクの得が
      // ポットの10%未満の場面は、実際にはチェックと同じかチェックの方が得だった（10〜20%: +9.6% / 20%以上: +30%）。
      // そこで、予測の得が10%以上の場面だけドンクを最善とし、それ以外はチェックを最善とする
      const donkSpot = facing <= 0.01 && !ctx.ip && eng.aggressor !== 'HERO'
        && !eng.actionHistory.some((a) => a.street === eng.street);
      let donk = null;
      const checkOpt = opts.find((o) => o.action === 'CHECK');
      if (donkSpot && checkOpt) {
        const bestBet = opts.filter((o) => o.action === 'BET').reduce((a, b) => (!a || b.ev > a.ev ? b : a), null);
        const edge = bestBet ? (bestBet.ev - checkOpt.ev) / Math.max(0.5, ctx.pot) : -1;
        donk = { justified: edge >= DONK_MIN_EDGE, edge };
        if (!donk.justified && (best.action === 'BET')) best = checkOpt;
      }
      const loss = Math.max(0, best.ev - chosen.ev);
      const lossPct = loss / Math.max(0.5, ctx.pot);
      const B = root.BetSizing;
      // モデルが苦手な比べ方は基準を 1.5 倍に緩める（監査で予測の誤差が大きかった）:
      //   - サイズだけの違い（ベット/レイズ同士）: 降りる割合のサイズ依存は近似
      //   - 強い手（勝率60%以上）でのスロープレイ（ベット/レイズの代わりにチェック/コール。EV はプラス）:
      //     後のストリートで取れる分の見積もりが粗く、ソルバーでも混ぜることが多い
      const aggr = (o) => o.action === 'BET' || o.action === 'RAISE';
      // チェック/コールのうち良い方（「このサイズで打つくらいならチェック」を見分けるため）
      const passive = opts.filter((o) => o.action === 'CHECK' || o.action === 'CALL').reduce((a, b) => (!a || b.ev > a.ev ? b : a), null);
      // サイズだけの違いとして緩めるのは、選んだサイズがチェック/コールより得なときだけ（2026/11/21 修正）。
      // 以前はベット同士なら一律に緩めていて、チェックの方が良い大きすぎるベットまで ◯ になっていた
      const sizeOnly = aggr(chosen) && aggr(best) && (!passive || chosen.ev >= passive.ev);
      const slowplay = !aggr(chosen) && aggr(best) && chosen.ev > 0 && ctx.eq >= 0.6 && chosen.action !== 'FOLD';
      const k = sizeOnly || slowplay ? 1.5 : 1.0;
      const gradeOf = (kk) => (lossPct <= GRADE.optimal * kk ? B.EVAL_OPTIMAL : lossPct <= GRADE.good * kk ? B.EVAL_GOOD
        : lossPct <= GRADE.marginal * kk ? B.EVAL_MARGINAL : B.EVAL_BAD);
      let evaluation = gradeOf(k);
      // 緩めたことで記号が変わった（解説で断る）。下のドンクの場面の扱いで変わった分は含めない
      //（以前は「チェックは △ より下にしない」で変わった分まで「スロープレイなので緩めた」と書いていた）
      const softened = evaluation !== gradeOf(1.0);
      // 正当化されないドンクを打った（チェック以上の得はあるが小さい）: チェックが基本なので ◯ まで。
      // チェックより損なドンクは、普通に「チェックの方が良い」で判定する
      const donkUnjustified = donk && !donk.justified && chosen.action === 'BET' && chosen.ev >= checkOpt.ev;
      if (donkUnjustified && (evaluation === B.EVAL_OPTIMAL)) evaluation = B.EVAL_GOOD;
      // ドンクの場面でのチェックは理論の基本なので、ドンクがはっきり得な例外の場面でも △ より下にしない
      if (donk && chosen.action === 'CHECK' && evaluation === B.EVAL_BAD) evaluation = B.EVAL_MARGINAL;

      const name = (o) => PostflopEV.actionName(o, ctx);
      const lines = [];
      const kw = { best: name(best), pct: lossPct * 100, bb: loss };
      if (donkUnjustified) lines.push(t('pf.verdict.donk'));
      else if (best === chosen) lines.push(t('pf.verdict.best', { act: name(chosen) }));
      // 最善手との差がごく小さいときは「ほぼ同じ」（以前は選んだ手を「最善」と書き、続く解説と矛盾することがあった）
      else if (lossPct <= 0.005) lines.push(t('pf.verdict.close', kw));
      else if (evaluation === B.EVAL_OPTIMAL) lines.push(t('pf.verdict.close', kw));
      else if (evaluation === B.EVAL_GOOD) lines.push(t('pf.verdict.good', kw));
      else if (evaluation === B.EVAL_MARGINAL) lines.push(t('pf.verdict.inaccuracy', kw));
      else lines.push(t('pf.verdict.mistake', kw));
      // ドンクが有効な例外の場面は、判定のすぐ後に「ドンクベットが有効」とその理由を書く（2026/11/23 shota 指摘。
      // 以前は解説の最後に一言だけで、ドンクという言葉も無く、なぜ打つのかが伝わらなかった）
      if (donk && donk.justified) {
        const pb = checkOpt.pBet;
        const kwd = { edge: donk.edge * 100, pb: (pb || 0) * 100 };
        lines.push(t(pb !== undefined && pb < 0.5 ? 'pf.why.donk_justified_checkback' : 'pf.why.donk_justified', kwd));
      }

      // 根拠: 数字はコールの判断に要るもの（勝率と必要勝率）だけ
      if (facing > 0.01) {
        const req = facing / (ctx.pot + facing);
        lines.push(t(ctx.street === 'RIVER' ? 'pf.basis.facing_river' : 'pf.basis.facing', { eq: ctx.eq * 100, req: req * 100 }));
      }
      // 考え方（なぜその手が最善か）
      let why;
      if (donkUnjustified) {
        why = [t('pf.why.donk_small', { edge: Math.max(0, donk.edge) * 100 })];
      } else if (donk && !donk.justified && chosen.action === 'BET') {
        why = [t('pf.why.donk_worse')];
        // 強い手なら、なぜチェックが得か（相手が打ってくる）を添える
        // なぜチェックが得かを添える: 強い手 → 相手が打ってくる / 弱い手 → ブラフとして降りない / 中くらい → ポットを小さく
        const kw2 = { act: name(chosen), best: name(checkOpt), fe: (chosen.fe || 0) * 100, eqc: (chosen.eqC || 0) * 100, eq: ctx.eq * 100 };
        if (ctx.eq >= 0.6 && checkOpt.pBet > 0.2) why.push(t('pf.why.check_induce', { best: name(checkOpt), pb: checkOpt.pBet * 100 }));
        else if (ctx.eq < 0.2) why.push(t('pf.why.bad_bluff', kw2));
        else if (ctx.eq < 0.35) why.push(t('pf.why.bluff_sdv', kw2));
        else if (ctx.eq < 0.6) why.push(t('pf.why.pot_control', kw2));
      } else if (donk && !donk.justified && chosen.action === 'CHECK') {
        why = [t('pf.why.check_donk_spot')];
      } else {
        why = PostflopEV.explain(ctx, chosen, best, { lossPct, facing, softened, name, heroHand, board, passive, checkOpt });
      }
      for (const w of why) lines.push(w);
      if (!donkUnjustified && !(best === chosen || lossPct <= 0.005)) lines.push(t('pf.ev_diff', { bb: loss }));
      return {
        evaluation, reason: lines.join('\n'), ev: chosen.ev, ev_loss: loss, loss_pct: lossPct,
        req_eq: facing > 0.01 ? facing / (ctx.pot + facing) : 0, realized_eq: ctx.eq,
        best: { action: best.action, amount: best.amount },
        donk,   // ドンクの場面なら { justified, edge }（game.js のドンクの扱いに使う）
        options: opts.map((o) => ({ action: o.action, amount: Py.round(o.amount, 2), ev: Py.round(o.ev, 3) })),
      };
    },

    // 判定の「考え方」の文。勝率の帯（強い手 / 中くらい / 弱い手）と、最善手・選んだ手の種類で選ぶ
    //   強い手（60%以上）: バリュー。中くらい（35〜60%）: ショーダウンを目指す・ポットを小さく。弱い手: ブラフかあきらめる
    explain(ctx, chosen, best, o) {
      const aggr = (x) => x.action === 'BET' || x.action === 'RAISE';
      const eq = ctx.eq;
      const strong = eq >= 0.6, weak = eq < 0.35;
      const isBest = best === chosen || o.lossPct <= 0.005;
      const lines = [];
      const P = (x) => x * 100;
      const req = o.facing > 0.01 ? o.facing / (ctx.pot + o.facing) : 0;
      const real = o.facing > 0.01 && ctx.street !== 'RIVER'
        ? Math.min(1, PostflopEV.realization('call', ctx.street, ctx.ip, o.heroHand, o.board, eq) * eq) : eq;
      const mdf = o.facing > 0.01 ? Math.max(0, (ctx.pot - o.facing) / ctx.pot) : 0;
      const allIn = (x) => aggr(x) && Math.abs(x.amount - ctx.maxBet) < 0.06;
      const target = isBest ? chosen : best;   // 説明する手（最善手）
      if (!isBest && aggr(chosen) && aggr(best)) {
        const pas = o.passive;
        if (pas && chosen.ev < pas.ev) {
          // 選んだサイズはチェック/コールより悪い: 「サイズだけ」ではなく、このサイズなら打たない方が良い
          const close = (best.ev - pas.ev) / Math.max(0.5, ctx.pot) < 0.02;
          lines.push(t(close ? 'pf.why.size_worse_close' : 'pf.why.size_worse', { passive: o.name(pas), best: o.name(best) }));
          return lines;
        }
        // 差がサイズだけのとき、その手の役割（バリュー/ブラフ）と、サイズで何が変わるか（降りる割合・続けてくる手への勝率）を書く
        // （2026/11/22〜。以前は「差はサイズだけです」だけで、なぜ大きく/小さく打つのかが分からなかった）
        //   バリュー（勝率60%以上）/ ブラフ（20%未満）/ その間は数字だけ並べる（どちらとも言い切れないため）
        const bigger = best.amount > chosen.amount;
        if (!allIn(best)) lines.push(t('pf.why.size', { best: o.name(best) }));
        let key;
        if (strong) key = bigger ? (Math.abs(best.fe - chosen.fe) < 0.03 ? 'size_value_big_nofold' : 'size_value_big') : 'size_value_small';
        else if (eq < 0.2) key = bigger ? 'size_bluff_big' : 'size_bluff_small';
        else key = 'size_mid';
        lines.push(t('pf.why.' + key, {
          best: o.name(best), alt: o.name(chosen), fb: P(best.fe), fa: P(chosen.fe), eqcb: P(best.eqC), eqca: P(chosen.eqC),
        }));
        // 小さいベットへのレイズ: 倍率より、ポットに対してどれだけ大きく返すか
        const before = ctx.pot - o.facing;
        if (chosen.action === 'RAISE' && strong && o.facing > 0.01 && before > 0 && o.facing / before < 0.25 && best.amount > chosen.amount) {
          lines.push(t('pf.why.raise_vs_small', { pct: P(o.facing / before) }));
        }
        if (o.softened) lines.push(t('pf.why.soft_size'));
        return lines;
      }
      if (aggr(target)) {
        const kw = { act: o.name(target), alt: o.name(chosen), fe: P(target.fe), eqc: P(target.eqC), eq: P(eq) };
        if (strong) lines.push(t(isBest ? 'pf.why.value' : 'pf.why.missed_value', kw));
        else if (weak) lines.push(t(isBest ? 'pf.why.bluff' : 'pf.why.missed_bluff', kw));
        // リバーは後のカードが無いので「ドローに無料でカードを見せない」ではなく、弱い手からコールをもらう（薄いバリュー）
        else if (ctx.street === 'RIVER') lines.push(t(isBest ? 'pf.why.thin_value' : 'pf.why.missed_thin_value', kw));
        else lines.push(t(isBest ? 'pf.why.protect' : 'pf.why.missed_protect', kw));
        if (!isBest && o.softened) lines.push(t('pf.why.soft_slowplay'));
        return lines;
      }
      // 最善手がチェック・コール・フォールド
      if (!isBest && aggr(chosen)) {
        const kw = { act: o.name(chosen), best: o.name(best), fe: P(chosen.fe), eqc: P(chosen.eqC), eq: P(eq) };
        // チェック/コールが勝る理由: 打つと強い手ばかり続けてくる / チェックすれば相手が打ってくる / 弱い手が降りてしまう
        const pb = o.checkOpt && best === o.checkOpt ? o.checkOpt.pBet : undefined;
        if (strong && chosen.eqC < 0.5) lines.push(t('pf.why.bet_called_by_better', kw));
        else if (strong && pb > 0.2) lines.push(t('pf.why.check_induce_strong', { ...kw, pb: P(pb) }));
        else if (strong) lines.push(t('pf.why.trap_better', kw));
        // ショーダウンで勝てる見込みがある手をブラフにする必要はない
        else if (weak && eq >= 0.2 && best.action === 'CHECK') lines.push(t('pf.why.bluff_sdv', kw));
        else if (weak) lines.push(t('pf.why.bad_bluff', kw));
        else lines.push(t('pf.why.pot_control', kw));
        return lines;
      }
      const kw = { eq: P(eq), real: P(real), req: P(req), mdf: P(mdf) };
      if (target.action === 'CALL') lines.push(t(isBest ? 'pf.why.call' : 'pf.why.overfold', kw));
      else if (target.action === 'FOLD') lines.push(t(isBest ? 'pf.why.fold' : 'pf.why.overcall', kw));
      else if (target.action === 'CHECK') {
        if (strong) lines.push(t('pf.why.check_strong', kw));
        else if (weak) lines.push(t('pf.why.check_weak', kw));
        else lines.push(t('pf.why.check_medium', kw));
      }
      return lines;
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
