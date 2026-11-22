// ゲーム進行（app.py の /api/start_hand・/api/action・/api/state と get_game_state の JS 移植）。
// 戻り値はサーバーの JSON レスポンスと同じ形なので、script.js は fetch の代わりにこれを呼べばよい。
//
// 統計の保存はフック経由（フェーズ6で IndexedDB に繋ぐ）:
//   hooks.startSession(sessionId, heroPos, heroHandStr)
//   hooks.logAction({ session_id, street, actor, action, amount, equity, pot_size, hero_pos, evaluation, ev_loss })
//   hooks.finishHand({ session_id, cpu_pos, winner, final_pot, board, cpu_hand, action_log })
//
// ⚠️ 乱数を読む順番（エクイティ計算の回数・順序を含む）は app.py と同じにしてある。
//
// 依存: engine.js とその依存すべて, pyfmt.js, postflop_ev.js

(function (root) {
  if (typeof module !== 'undefined') {
    require('./engine.js');
    require('./pyfmt.js');
    require('./postflop_ev.js');
  }

  const noop = () => {};
  const newUuid = () => (root.crypto && root.crypto.randomUUID ? root.crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = Math.random() * 16 | 0;
      return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    }));

  // コンボ単位（"AhKh"）のレンジを 169 種類のハンド名ごとの重み（最大1）に直す。ハンド名のレンジはそのまま
  function rangeForDisplay(m) {
    const isCombo = [...m.keys()].some((k) => k.length === 4);
    if (!isCombo) return m;
    const RM = root.RangeModel;
    const cls = RM.toClassMap(RM.toVec(m));
    let mx = 0;
    for (const v of cls.values()) mx = Math.max(mx, v);
    if (mx > 0) for (const [k, v] of cls) cls.set(k, Math.round(v / mx * 1000) / 1000);
    return cls;
  }

  class Game {
    constructor({ rng, hooks } = {}) {
      this.engine = new root.PokerEngine(rng || root.Rng.real());
      this.hooks = { startSession: noop, logAction: noop, finishHand: noop, newSessionId: newUuid, ...(hooks || {}) };
      this.sessionId = '';
    }

    get rngFn() { return this.engine.rng.random; }

    // 評価ロジック内のモンテカルロもエンジンと同じ乱数列を使う（Python と順番を揃えるため）
    _bindRng() { root.Evaluator.rng = this.rngFn; }

    _equity(iterations) {
      const eng = this.engine;
      return root.Equity.calcEquityMonteCarlo(eng.heroHand, eng.board, eng.heroRange, eng.cpuRange,
        'CPU', eng.street === 'PREFLOP', iterations, this.rngFn);
    }

    // /api/state: リロード時の状態復元
    currentState() {
      this._bindRng();
      const eng = this.engine;
      if (eng.heroHand.length === 0 || eng.handFinished) return { has_hand_in_progress: false };
      const state = this.gameState();
      state.has_hand_in_progress = true;
      return state;
    }

    // /api/start_hand
    startHand({ spot = false, position = '' } = {}) {
      this._bindRng();
      const { Py } = root;
      const eng = this.engine;
      eng.spotMode = spot;
      eng.forcedPosition = position ? position.toUpperCase() : '';
      const MAX_RETRIES = 50;
      let cpuMsg = '';
      let cpuFirstActions = [];
      this.sessionId = this.hooks.newSessionId();

      for (let i = 0; i < MAX_RETRIES; i++) {
        eng.startNewHand();
        cpuMsg = '';
        if (eng.isHeroTurn()) break;

        // CPU が先手（CPU は自分の手札で判断する。engine.js の cpuDecide 参照）
        const cpuFacing = eng.currentBet - eng.cpuInvested;
        const [cpuAction, cpuAmount] = eng.cpuDecide(null, 'CHECK', cpuFacing);
        if (cpuAction === 'FOLD') continue;   // 初手フォールドなら裏で配り直す
        if (['CALL', 'BET', 'RAISE'].includes(cpuAction)) {
          const betAmount = cpuAction === 'CALL' ? cpuFacing : cpuAmount;
          eng.placeBet('CPU', betAmount);
          eng.recordAction('CPU', cpuAction, betAmount, 0.5, eng.potSize);
          cpuMsg = `CPU ${cpuAction}S ${betAmount > 0 ? Py.floatStr(Py.round(betAmount, 1)) + 'bb' : ''}`.trim();
          cpuFirstActions = [{ street: 'PREFLOP', action: cpuAction, amount: Py.round(betAmount, 1), allIn: false }];
          break;
        }
      }

      const { Card } = root;
      const heroHandStr = eng.heroHand.length ? eng.heroHand.map(Card.toStr).join(',') : '';
      this.hooks.startSession(this.sessionId, eng.heroPosition, heroHandStr);

      const state = this.gameState();
      if (cpuMsg) state.cpuMessage = cpuMsg;
      if (cpuFirstActions.length) state.cpuActions = cpuFirstActions;
      return state;
    }

    _log(fields) {
      this.hooks.logAction({ session_id: this.sessionId, ...fields });
    }

    // プレイの傾向（分析ページの4タイプ）用に、「推奨ならどうしていたか」と実際の選択を記録する（2026/11/19〜）。
    //   f = 降りる選択肢があった / p, rp = 参加した（コール・レイズ）と推奨の参加確率
    //   c = レイズできた / a, ra = 攻めた（ベット・レイズ）と推奨の攻める確率
    // 判定が ◎ の手は推奨どおりとして扱う（混ぜる場面や僅差の場面を「ずれ」に数えないため）
    _tendency(rec, action, evaluation) {
      if (!rec) return null;
      const p = ['CALL', 'BET', 'RAISE'].includes(action) ? 1 : 0;
      const a = action === 'BET' || action === 'RAISE' ? 1 : 0;
      const ok = evaluation === '◎';
      const r2 = (x) => Math.round(x * 100) / 100;
      return { f: rec.canFold ? 1 : 0, p, rp: ok ? p : r2(rec.rp), c: rec.canRaise ? 1 : 0, a, ra: ok ? a : r2(rec.ra) };
    }

    // /api/action
    action({ action, amount = 0.0 }) {
      this._bindRng();
      const { Py, Evaluator: Ev, Equity } = root;
      const eng = this.engine;
      action = String(action).toUpperCase();

      // ベット/レイズ額を有効スタックでキャップ
      let heroAllIn = false;
      if (action === 'BET' || action === 'RAISE') {
        const maxAdd = eng.maxAdditionalBet('HERO');
        if (amount >= maxAdd - 0.01) { amount = maxAdd; heroAllIn = true; }
      }

      // 1. エクイティ
      const is3betPot = eng.is3betPot;
      const isFirstIn = eng.isFirstIn;   // recordAction の前に読む
      const firstIn = (evalDict) => (isFirstIn ? Ev.applyFirstIn(evalDict, eng.heroHand, action, eng.heroPosition) : evalDict);
      const effectiveStack = Math.min(eng.heroStack, eng.cpuStack);
      const isPreflop = eng.street === 'PREFLOP';

      // ポストフロップは選べるアクションの期待値を比べて判定する（postflop_ev.js）。
      // アクション前の局面で計算する（レンジの更新・チップの移動より先）
      if (!isPreflop && ['FOLD', 'CALL', 'CHECK', 'BET', 'RAISE'].includes(action)) {
        return this._postflopAction(action, amount, heroAllIn);
      }

      // オープンした位置（BB のコールレンジがオープンした位置で変わる）
      // プリフロップの場面（判定の解説に使う）。openerPos は BB のコールレンジがオープンした位置で変わるため
      const openerPos = {
        openerPos: eng.preflopRaiseCount === 1 && eng.aggressor === 'CPU' ? eng.cpuPosition : null,
        villainPos: eng.cpuPosition, pot: eng.potSize, raises: eng.preflopRaiseCount, ip: eng.isHeroIp,
      };
      // 傾向の記録用: この場面のレンジ表の推奨（参加する確率・レイズする確率）
      const pfInfo = Ev.preflopSpot(eng.heroHand, eng.heroPosition, is3betPot, eng.currentBet - eng.heroInvested, openerPos);
      const tendRec = {
        canFold: eng.currentBet - eng.heroInvested > 0.01,
        canRaise: eng.maxAdditionalBet('HERO') > eng.currentBet - eng.heroInvested + 0.05,
        rp: Math.min(1, pfInfo.callWeight + pfInfo.raiseWeight), ra: pfInfo.raiseWeight,
      };
      const [heroEq, cpuEq] = this._equity(1000);
      const heroRangeAdv = Equity.calcRangeAdvantage(eng.heroHand, eng.board, eng.heroRange, eng.cpuRange,
        isPreflop, 400, this.rngFn);
      const sprNow = (effectiveStack > 0 && eng.potSize > 0) ? (effectiveStack / eng.potSize) : 10.0;
      const eqr = Ev.getEqrModifier(eng.heroPosition, eng.heroHand, is3betPot, eng.board, heroRangeAdv, sprNow);
      const realizedEquity = Ev.realizeEquity(heroEq, eqr);

      let evalResult = 'N/A';
      let evalReason = '';

      // 2. ヒーローのアクションを評価
      const heroFacing = eng.currentBet - eng.heroInvested;
      const common = { street: eng.street, actor: 'HERO', equity: realizedEquity, hero_pos: eng.heroPosition };

      if (action === 'FOLD') {
        eng.updateRangeDict('HERO', 'FOLD', 0);
        eng.recordAction('HERO', 'FOLD', 0, realizedEquity, eng.potSize);
        const evalDict = firstIn(Ev.evaluateFold(heroEq, heroFacing, eng.potSize, eng.heroPosition, eng.heroHand, is3betPot,
          eng.board, heroRangeAdv, effectiveStack, eng.street, openerPos));
        const evFold = evalDict.ev ?? 0.0;
        const evCallAlt = heroFacing > 0 ? Ev.evCall(heroEq, eng.potSize, heroFacing) : 0.0;
        const evLossFold = Math.max(0.0, evCallAlt - evFold);
        this._log({ ...common, action: 'FOLD', amount: 0.0, pot_size: eng.potSize, evaluation: evalDict.evaluation, ev_loss: evLossFold, tendency: this._tendency(tendRec, 'FOLD', evalDict.evaluation), reason: evalDict.reason || '' });
        eng.handFinished = true;
        // プリフロップのフォールドでは CPU のハンドを公開しない
        const state = this.gameState({ finished: true, showCpuHand: eng.street !== 'PREFLOP' });
        this._saveHandRecord(state, 'CPU');
        return { evaluation: evalDict.evaluation, reason: evalDict.reason, ev_loss: Py.round(evLossFold, 3),
          metrics: evalDict, state, message: 'You Folded' };
      } else if (action === 'CALL') {
        const callAmount = Math.min(heroFacing, eng.heroStack);   // オールインコール対応
        if (callAmount >= eng.heroStack - 0.01) heroAllIn = true;
        const evalDict = firstIn(Ev.evaluateCall(heroEq, callAmount, eng.potSize, eng.heroPosition, eng.heroHand, is3betPot,
          eng.board, effectiveStack, heroRangeAdv, eng.heroRange, eng.street, openerPos));
        evalResult = evalDict.evaluation;
        evalReason = evalDict.reason;
        const evCallVal = evalDict.ev ?? 0.0;
        const evCheckAlt = Ev.evCheck(heroEq, eng.potSize);
        const evLoss = evCheckAlt > evCallVal ? Math.max(0.0, evCheckAlt - evCallVal) : 0.0;
        eng.updateRangeDict('HERO', 'CALL', callAmount);
        eng.recordAction('HERO', 'CALL', callAmount, realizedEquity, eng.potSize);
        eng.placeBet('HERO', callAmount);
        this._log({ ...common, action: 'CALL', amount: callAmount, pot_size: eng.potSize, evaluation: evalResult, ev_loss: evLoss, tendency: this._tendency(tendRec, 'CALL', evalResult), reason: evalReason || '' });
      } else if (action === 'BET' || action === 'RAISE') {
        let evalDict;
        if (action === 'RAISE') {
          evalDict = Ev.evaluateRaise(heroEq, amount, heroFacing, eng.potSize, eng.heroPosition, eng.heroHand, eng.board,
            heroRangeAdv, eng.heroRange, effectiveStack, eng.street, eng.cpuRange, is3betPot, openerPos);
        } else {
          // ドンクベット = OOP かつ非アグレッサーが先に打つ
          const isDonk = eng.street !== 'PREFLOP' && eng.aggressor !== 'HERO' && !eng.isHeroIp;
          evalDict = Ev.evaluateBet(heroEq, amount, eng.potSize, eng.heroPosition, eng.heroHand, eng.board, heroRangeAdv,
            effectiveStack, eng.street, eng.heroRange, eng.cpuRange, isDonk);
        }
        evalDict = firstIn(evalDict);
        evalResult = evalDict.evaluation;
        evalReason = evalDict.reason;
        const evBetVal = evalDict.ev ?? 0.0;
        const evCheckAlt = Ev.evCheck(heroEq, eng.potSize);
        const evLoss = evCheckAlt > evBetVal ? Math.max(0.0, evCheckAlt - evBetVal) : 0.0;
        eng.updateRangeDict('HERO', action, amount);
        eng.recordAction('HERO', action, amount, realizedEquity, eng.potSize);
        eng.placeBet('HERO', amount);
        this._log({ ...common, action, amount, pot_size: eng.potSize, evaluation: evalResult, ev_loss: evLoss, tendency: this._tendency(tendRec, action, evalResult), reason: evalReason || '' });
      } else if (action === 'CHECK') {
        eng.updateRangeDict('HERO', 'CHECK', 0);
        eng.recordAction('HERO', 'CHECK', 0, realizedEquity, eng.potSize);
        // プリフロップのチェックは BB が SB のリンプに対してだけ。レンジ表の考え方で判定する
        //（以前はポストフロップ用の判定に回っていて、72o のチェックが「ブラフの機会損失」で × になっていた）
        let evalDict;
        if (isPreflop) {
          const [, evaluation, reason] = Ev.evaluatePreflopActionGto(eng.heroHand, 'CHECK', eng.heroPosition, false, 0, openerPos);
          evalDict = { ev: Ev.evCheck(heroEq, eng.potSize), evaluation, reason };
        } else {
          evalDict = Ev.evaluateCheck(heroEq, eng.potSize, eng.heroPosition, eng.aggressor === 'HERO', eng.isHeroIp,
            eng.heroHand, eng.board, heroRangeAdv, effectiveStack, eng.street, eng.heroRange, eng.cpuRange);
        }
        evalResult = evalDict.evaluation;
        evalReason = evalDict.reason;
        const evCheckVal = evalDict.ev ?? 0.0;
        const evBetAlt = Ev.evBet(heroEq, eng.potSize, eng.potSize * 0.66, 0.3);
        const evLoss = evBetAlt > evCheckVal ? Math.max(0.0, evBetAlt - evCheckVal) : 0.0;
        this._log({ ...common, action: 'CHECK', amount: 0.0, pot_size: eng.potSize, evaluation: evalResult, ev_loss: evLoss, tendency: this._tendency(tendRec, 'CHECK', evalResult), reason: evalReason || '' });
      } else {
        throw new Error('Invalid action');
      }

      return this._afterHero(action, amount, heroAllIn, evalResult, evalReason, cpuEq);
    }

    // ポストフロップのあなたのアクション: 判定 → 記録 → CPU の応答
    _postflopAction(action, amount, heroAllIn) {
      const { Py, PostflopEV } = root;
      const eng = this.engine;
      const heroFacing = eng.currentBet - eng.heroInvested;
      if (action === 'CALL') {
        amount = Math.min(heroFacing, eng.heroStack);
        if (amount >= eng.heroStack - 0.01) heroAllIn = true;
      }
      const pf = PostflopEV.evaluate(eng, action, amount);
      // OOP で主導権の無い側が先にチェックするのは基本どおり。期待値の差が小さければ ◯ を下回らない
      let evaluation = pf.evaluation;
      let reason = pf.reason;
      const B = root.BetSizing;
      const firstCheckOop = action === 'CHECK' && eng.aggressor !== 'HERO' && !eng.isHeroIp;
      if (firstCheckOop && (evaluation === B.EVAL_MARGINAL || evaluation === B.EVAL_BAD) && pf.loss_pct <= 0.15) {
        evaluation = B.EVAL_GOOD;
        reason += '\n' + root.Messages.t('pf.note.oop_check');
      }
      // ドンクベット（OOP で主導権の無い側が先に打つ）の扱いは postflop_ev.js が決める（2026/11/21〜）。
      // 以前は一律に ◎ を ◯ にしていたが、今はチェックを基準にし、はっきり得な場面だけドンクを最善にする
      const eq = pf.realized_eq;
      // reason: 画面に出した判定の解説。開発者モードのハンド履歴で見る（2026/11/21〜）
      const common = { street: eng.street, actor: 'HERO', equity: eq, hero_pos: eng.heroPosition, reason };
      // 傾向の記録用: 最善手が参加（コール・レイズ）/ 攻め（ベット・レイズ）か
      const bestA = pf.best.action;
      common.tendency = this._tendency({
        canFold: heroFacing > 0.01,
        canRaise: (pf.options || []).some((o) => o.action === 'BET' || o.action === 'RAISE'),
        rp: ['CALL', 'RAISE'].includes(bestA) ? 1 : 0, ra: bestA === 'BET' || bestA === 'RAISE' ? 1 : 0,
      }, action, evaluation);
      const evLoss = pf.ev_loss;

      if (action === 'FOLD') {
        eng.updateRangeDict('HERO', 'FOLD', 0);
        eng.recordAction('HERO', 'FOLD', 0, eq, eng.potSize);
        this._log({ ...common, action: 'FOLD', amount: 0.0, pot_size: eng.potSize, evaluation, ev_loss: evLoss });
        eng.handFinished = true;
        const state = this.gameState({ finished: true, showCpuHand: true });
        this._saveHandRecord(state, 'CPU');
        return { evaluation, reason, ev_loss: Py.round(evLoss, 3), metrics: pf, state, message: 'You Folded' };
      }
      if (action === 'CHECK') {
        eng.updateRangeDict('HERO', 'CHECK', 0);
        eng.recordAction('HERO', 'CHECK', 0, eq, eng.potSize);
        this._log({ ...common, action: 'CHECK', amount: 0.0, pot_size: eng.potSize, evaluation, ev_loss: evLoss });
      } else {
        eng.updateRangeDict('HERO', action, amount);
        eng.recordAction('HERO', action, amount, eq, eng.potSize);
        eng.placeBet('HERO', amount);
        this._log({ ...common, action, amount, pot_size: eng.potSize, evaluation, ev_loss: evLoss });
      }
      return this._afterHero(action, amount, heroAllIn, evaluation, reason, 1 - eq);
    }

    // あなたのアクションの後: CPU の応答・ストリートの進行・決着
    _afterHero(action, amount, heroAllIn, evalResult, evalReason, cpuEq) {
      const { Py } = root;
      const eng = this.engine;
      // 3. CPU のアクション
      const cpuFacing = eng.currentBet - eng.cpuInvested;
      let streetClosedByHero = false;
      if (action === 'CALL') {
        if (eng.street === 'PREFLOP' && eng.cpuPosition === 'BB' && eng.currentBet === 1.0) streetClosedByHero = false;
        else streetClosedByHero = Math.abs(eng.heroInvested - eng.cpuInvested) < 0.01;
      } else if (action === 'CHECK') {
        streetClosedByHero = eng.isHeroIp || (eng.street === 'PREFLOP' && eng.heroPosition === 'BB' && eng.currentBet === 1.0);
      }

      let cpuMsg = '';
      const cpuActions = [];
      let cpuAction, cpuAmount;
      const heroAmount = Py.round(amount, 1);
      const result = (extra) => ({ evaluation: evalResult, reason: evalReason, cpuAction, cpuActions,
        heroAmount, heroAllIn, ...extra });

      if (streetClosedByHero) {
        cpuAction = 'CHECK';
        cpuAmount = 0;
      } else {
        [cpuAction, cpuAmount] = eng.cpuDecide(cpuEq, action, cpuFacing);

        // ヒーローがオールイン済みならレイズは不可能 → コール
        if (cpuAction === 'RAISE' && eng.isAllIn('HERO')) {
          cpuAction = 'CALL';
          cpuAmount = cpuFacing;
        }
        // CPU のベット/レイズ額を有効スタックでキャップ。コール額以下になったらコール扱い
        if (cpuAction === 'BET' || cpuAction === 'RAISE') {
          const cap = eng.maxAdditionalBet('CPU');
          if (cpuAmount > cap) {
            cpuAmount = cap;
            if (cpuAmount <= cpuFacing + 0.01) { cpuAction = 'CALL'; cpuAmount = cpuFacing; }
          }
        }

        if (cpuAction === 'FOLD') {
          eng.generateRealizedCpuHand();   // レンジを0にする前に生成する
          eng.updateRangeDict('CPU', 'FOLD', 0);
          eng.recordAction('CPU', 'FOLD', 0, cpuEq, eng.potSize);
          eng.handFinished = true;
          cpuActions.push({ street: eng.street, action: 'FOLD', amount: 0, allIn: false });
          const state = this.gameState({ finished: true });
          this._saveHandRecord(state, 'YOU');
          return result({ state, message: 'CPU Folded. You Win.' });
        }

        if (['CALL', 'BET', 'RAISE'].includes(cpuAction)) {
          if (cpuAction === 'CALL') {
            const cpuCallAmount = Math.min(cpuFacing, eng.cpuStack);
            eng.updateRangeDict('CPU', 'CALL', cpuCallAmount);
            eng.recordAction('CPU', 'CALL', cpuCallAmount, cpuEq, eng.potSize);
            eng.placeBet('CPU', cpuCallAmount);
            cpuAmount = cpuCallAmount;
          } else {
            eng.updateRangeDict('CPU', cpuAction, cpuAmount);
            eng.recordAction('CPU', cpuAction, cpuAmount, cpuEq, eng.potSize);
            eng.placeBet('CPU', cpuAmount);
          }
          cpuMsg = `CPU ${cpuAction}S ${cpuAmount > 0 ? Py.floatStr(Py.round(cpuAmount, 1)) + 'bb' : ''}`.trim();
          cpuActions.push({ street: eng.street, action: cpuAction, amount: Py.round(cpuAmount, 1), allIn: eng.isAllIn('CPU') });
        } else if (cpuAction === 'CHECK') {
          eng.updateRangeDict('CPU', 'CHECK', 0);
          eng.recordAction('CPU', 'CHECK', 0, cpuEq, eng.potSize);
          cpuMsg = 'CPU CHECKS';
          cpuActions.push({ street: eng.street, action: 'CHECK', amount: 0, allIn: false });
        }
      }

      // CPU のアクションでストリートが閉じたか
      const heroFacingAfterCpu = eng.currentBet - eng.heroInvested;
      if (((cpuAction === 'CALL' || cpuAction === 'CHECK') && heroFacingAfterCpu < 0.01) || streetClosedByHero) {
        // オールイン成立 → 残りを全て配ってショーダウン
        if (eng.isAllIn('HERO') || eng.isAllIn('CPU')) {
          eng.runOutBoard();
          eng.handFinished = true;
          const state = this.gameState({ finished: true });
          this._saveHandRecord(state);
          return result({ state, message: `${cpuMsg.trim()} => All-in! Showdown!`.trim() });
        }

        // 4. 次のストリートへ
        if (eng.street === 'RIVER') {
          eng.handFinished = true;
          const state = this.gameState({ finished: true });
          this._saveHandRecord(state);
          return result({ state, message: `${cpuMsg.trim()} => Showdown!` });
        }

        const idx = eng.STREETS.indexOf(eng.street);
        if (idx + 1 < eng.STREETS.length) {
          eng.advanceStreet(eng.STREETS[idx + 1]);
          if (!eng.isHeroTurn()) {
            let [cpuAction2, cpuAmount2] = eng.cpuDecide(null, 'CHECK', 0);
            const cpuEqNext = cpuEq;   // 記録用（あなた視点の勝率の裏返し）
            if (cpuAction2 === 'BET' || cpuAction2 === 'RAISE') {
              cpuAmount2 = Math.min(cpuAmount2, eng.maxAdditionalBet('CPU'));
            }
            if ((cpuAction2 === 'BET' || cpuAction2 === 'RAISE') && cpuAmount2 > 0.01) {
              eng.updateRangeDict('CPU', cpuAction2, cpuAmount2);
              eng.recordAction('CPU', cpuAction2, cpuAmount2, cpuEqNext, eng.potSize);
              eng.placeBet('CPU', cpuAmount2);
              cpuMsg += ` | Next street CPU ${cpuAction2}S ${Py.floatStr(Py.round(cpuAmount2, 1))}bb`;
              cpuActions.push({ street: eng.street, action: cpuAction2, amount: Py.round(cpuAmount2, 1), allIn: eng.isAllIn('CPU') });
            } else {
              // 先に動いた CPU のチェックもレンジ推定に使う（2026/11/18 修正）。以前はここだけ更新しておらず、
              // ベットするはずの強い手がレンジに残って、リバーで相手を強く見積もりすぎていた（勝率が10ポイント前後低く出た）
              eng.updateRangeDict('CPU', 'CHECK', 0);
              eng.recordAction('CPU', 'CHECK', 0, cpuEqNext, eng.potSize);
              cpuMsg += ' | Next street CPU CHECKS';
              cpuActions.push({ street: eng.street, action: 'CHECK', amount: 0, allIn: false });
            }
          }
        } else {
          eng.handFinished = true;
          const state = this.gameState({ finished: true });
          this._saveHandRecord(state);
          return result({ state, message: `${cpuMsg.trim()} => Showdown!` });
        }
      }

      return result({ state: this.gameState(), cpuMessage: cpuMsg });
    }

    // ハンド終了時に全アクション・ボード・勝敗を保存（winner 省略時はショーダウン結果から）
    _saveHandRecord(state, winner = '') {
      const { Py, Card } = root;
      const eng = this.engine;
      try {
        if (!winner) winner = (state.showdownResult || {}).winner || '';
        this.hooks.finishHand({
          session_id: this.sessionId,
          cpu_pos: eng.cpuPosition,
          winner,
          final_pot: Py.round(eng.potSize, 2),
          board: eng.board.map(Card.toStr).join(','),
          cpu_hand: (state.cpuHand || []).join(','),
          action_log: eng.actionHistory.map((a) => ({ street: a.street, actor: a.actor, action: a.action, amount: Py.round(a.amount, 2) })),
        });
      } catch (e) { /* 履歴保存の失敗でゲーム進行を止めない */ }
    }

    gameState({ finished = false, showCpuHand = true } = {}) {
      const { Py, Card, Evaluator: Ev, HandEvaluator } = root;
      const eng = this.engine;
      const [heroEq] = this._equity(500);
      const dispStack = Math.min(eng.heroStack, eng.cpuStack);
      const dispSpr = (dispStack > 0 && eng.potSize > 0) ? (dispStack / eng.potSize) : 10.0;
      // 表示用の勝率。リバーは残りのカードが無いので割り引かない。IP/OOP は実際の位置関係で決める
      const realizedEq = eng.street === 'RIVER' ? heroEq
        : Ev.realizeEquity(heroEq, Ev.getEqrModifier(eng.heroPosition, eng.heroHand, false, eng.board, 0.5, dispSpr, null,
          eng.street === 'PREFLOP' ? null : eng.isHeroIp));

      if (finished && showCpuHand && eng.cpuHand.length === 0) eng.generateRealizedCpuHand();

      const compressRange = (m) => {
        let s = 0.0, mid = 0.0, w = 0.0;
        const keys = [...m.keys()];
        const n = keys.length;
        if (n === 0) return { strong: 0.33, middle: 0.33, weak: 0.34 };
        keys.forEach((k, i) => {
          const x = m.get(k);
          if (i < n * 0.30) s += x;
          else if (i < n * 0.70) mid += x;
          else w += x;
        });
        const tot = s + mid + w;
        if (tot <= 0) return { strong: 0.33, middle: 0.33, weak: 0.34 };
        return { strong: Py.round(s / tot, 2), middle: Py.round(mid / tot, 2), weak: Py.round(w / tot, 2) };
      };

      // CPU のポジションはプリフロップで CPU が動くまで伏せる
      const actedYet = (who) => eng.street !== 'PREFLOP' || eng.actionHistory.some((a) => a.actor === who);
      let displayCpuPos = eng.cpuPosition;
      if (eng.street === 'PREFLOP' && !eng.actionHistory.some((a) => a.actor === 'CPU')) displayCpuPos = '???';

      let showdownResult = null;
      if (finished && showCpuHand && eng.cpuHand.length && eng.heroHand.length && eng.board.length >= 3) {
        try {
          const heroScore = HandEvaluator.evaluate(eng.board, eng.heroHand);
          const cpuScore = HandEvaluator.evaluate(eng.board, eng.cpuHand);
          showdownResult = {
            winner: heroScore < cpuScore ? 'YOU' : cpuScore < heroScore ? 'CPU' : 'TIE',
            heroHandName: HandEvaluator.classToString(HandEvaluator.getRankClass(heroScore)),
            cpuHandName: HandEvaluator.classToString(HandEvaluator.getRankClass(cpuScore)),
          };
        } catch (e) { /* Python と同じく null のまま */ }
      }

      return {
        street: eng.street,
        potSize: Py.round(eng.potSize, 2),
        heroStack: Py.round(eng.heroStack, 2),
        cpuStack: Py.round(eng.cpuStack, 2),
        heroPos: eng.heroPosition,
        cpuPos: displayCpuPos,
        facingBet: Py.round(Math.max(0.0, eng.currentBet - eng.heroInvested), 2),
        currentBet: Py.round(eng.currentBet, 2),
        heroHand: eng.heroHand.map(Card.toStr),
        cpuHand: (finished && showCpuHand) ? eng.cpuHand.map(Card.toStr) : [],
        board: eng.board.map(Card.toStr),
        equity: Py.round(realizedEq * 100, 1),
        showdownResult,
        heroRange: compressRange(eng.heroRange),
        cpuRange: compressRange(eng.cpuRange),
        // 画面のレンジ表は 169 種類のハンド名で引く。ポストフロップのレンジはコンボ単位なので平均に直す
        // まだ一度もアクションしていない側は全ハンドを表示する。内部のレンジは「オープンにコールする」などの前提で先に絞ってあるが、
        // それを見せると動く前から手が絞られて見え、CPU の席（??? で隠している）まで推測できてしまう（2026/11/22）
        heroRangeRaw: Object.fromEntries(actedYet('HERO') ? rangeForDisplay(eng.heroRange) : root.Ranges.ALL_HANDS_DICT),
        cpuRangeRaw: Object.fromEntries(actedYet('CPU') ? rangeForDisplay(eng.cpuRange) : root.Ranges.ALL_HANDS_DICT),
        finished,
        // サーバーはレスポンス時点のスナップショットを返すので、ここでもコピーを渡す
        history: eng.actionHistory.map((a) => ({ ...a })),
      };
    }
  }

  root.PokerGame = Game;
  if (typeof module !== 'undefined') module.exports = Game;
})(typeof window !== 'undefined' ? window : globalThis);
