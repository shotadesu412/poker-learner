// ゲームエンジンと CPU AI（poker_engine.py の PokerEngine の JS 移植）。
//
// ⚠️ 移植方針: 今の Python の挙動をそのまま再現する（改善は移植後）。
//   - 乱数は必ず this.rng 経由（rng.js）。読む順番・読む条件（短絡評価で読まない場合を含む）も
//     Python と同じにしてある。ここを変えると tools/golden のテープ比較が通らなくなる
//   - CPU の戦略仕様: 標準オープンに対してはフォールドなし（95%コール/5%3ベット）。
//     練習機会を最大化するための意図的な仕様
//
// 依存: hand_eval.js, ranges.js, range_utils.js, equity.js, evaluator.js, hand_classifier.js,
//       bet_sizing.js, rng.js

(function (root) {
  if (typeof module !== 'undefined') {
    for (const m of ['hand_eval', 'ranges', 'range_utils', 'equity', 'evaluator', 'hand_classifier',
      'bet_sizing', 'rng']) require('./' + m + '.js');
  }

  const getOr = (m, key, dflt) => (m && m.has(key) ? m.get(key) : dflt);
  const PREFLOP_ORDER = ['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB'];
  const POSTFLOP_ORDER = ['SB', 'BB', 'UTG', 'HJ', 'CO', 'BTN'];

  // treys の Deck と同じ: GetFullDeck の順（ランク 2..A × スート s,h,d,c）をシャッフルし、末尾から引く
  class Deck {
    constructor(rng) {
      this.rng = rng;
      this.shuffle();
    }
    static fullDeck() {
      const { Card } = root;
      const out = [];
      for (const r of Card.STR_RANKS) for (const s of 'shdc') out.push(Card.fromStr(r + s));
      return out;
    }
    shuffle() {
      this.cards = Deck.fullDeck();
      this.rng.shuffle(this.cards);
    }
    draw(n = 1) {
      const out = [];
      for (let i = 0; i < n; i++) out.push(this.cards.pop());
      return out;
    }
  }

  class PokerEngine {
    constructor(rng = root.Rng.real()) {
      const { Ranges } = root;
      this.rng = rng;
      this.STREETS = ['PREFLOP', 'FLOP', 'TURN', 'RIVER'];
      this.heroStack = 100;
      this.cpuStack = 100;
      this.potSize = 0;
      this.street = 'PREFLOP';
      this.deck = new Deck(rng);   // Python も生成時に1回シャッフルする（乱数を消費する）
      this.board = [];
      this.heroHand = [];
      this.cpuHand = [];
      this.heroPosition = 'BTN';
      this.cpuPosition = 'BB';
      this.heroRange = new Map(Ranges.getRangeByCategory(this.heroPosition, 'open'));
      this.cpuRange = new Map(Ranges.getRangeByCategory(this.cpuPosition, 'open'));
      this.cpuTendency = 'BALANCED';
      this.POSITIONS = ['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB'];
      this.heroInvested = 0.0;
      this.cpuInvested = 0.0;
      this.currentBet = 0.0;
      this.aggressor = null;
      this.actionHistory = [];
      this.cpuLastActionIntent = null;
      this.cpuEffectiveEquity = null;  // cpuDecide でサンプリングした実効エクイティ（ショーダウン手選択に使う）
      this.handCount = 0;              // 4ハンドに1回はレンジ内のハンドを配る
      this.handFinished = false;
      this.spotMode = false;
      this.forcedPosition = '';
      this._pfVsOpen = false;
    }

    isHeroTurn() {
      const order = this.street === 'PREFLOP' ? PREFLOP_ORDER : POSTFLOP_ORDER;
      return order.indexOf(this.heroPosition) < order.indexOf(this.cpuPosition);
    }

    // ポストフロップでヒーローが後手（In Position）か
    get isHeroIp() {
      return POSTFLOP_ORDER.indexOf(this.heroPosition) > POSTFLOP_ORDER.indexOf(this.cpuPosition);
    }

    startNewHand() {
      const { Ranges } = root;
      this.street = 'PREFLOP';
      this.heroStack = 100.0;
      this.cpuStack = 100.0;
      this.potSize = 1.5;   // SB と BB
      this.currentBet = 1.0;
      this.heroInvested = 0.0;
      this.cpuInvested = 0.0;
      this.cpuHand = [];
      this.aggressor = null;
      this.actionHistory = [];
      this.cpuLastActionIntent = null;
      this.cpuEffectiveEquity = null;
      this.handCount += 1;
      this.handFinished = false;
      this.deal();

      if (this.isHeroTurn()) {
        this.heroRange = new Map(Ranges.getRangeByCategory(this.heroPosition, 'open'));
        this.cpuRange = new Map(Ranges.getRangeByCategory(this.cpuPosition, 'vs_open_call'));
      } else {
        this.cpuRange = new Map(Ranges.getRangeByCategory(this.cpuPosition, 'open'));
        this.heroRange = new Map(Ranges.getRangeByCategory(this.heroPosition, 'vs_open_call'));
      }

      if (this.heroPosition === 'SB') { this.heroStack -= 0.5; this.heroInvested = 0.5; }
      else if (this.heroPosition === 'BB') { this.heroStack -= 1.0; this.heroInvested = 1.0; }
      if (this.cpuPosition === 'SB') { this.cpuStack -= 0.5; this.cpuInvested = 0.5; }
      else if (this.cpuPosition === 'BB') { this.cpuStack -= 1.0; this.cpuInvested = 1.0; }
    }

    recordAction(actor, action, amount, equity, potSize) {
      if (action === 'BET' || action === 'RAISE') this.aggressor = actor;
      this.actionHistory.push({ street: this.street, actor, action, amount, equity, pot_size: potSize });
    }

    // ポジションの GTO レンジから重み付きでコンボを1つ選ぶ。失敗時 null
    _pickRangeCombo(pos) {
      try {
        const alias = pos === 'UTG' ? 'LJ' : pos;   // position_ranges のキーは LJ
        const posRange = getOr(root.Ranges.positionRanges, alias, new Map());
        if (posRange.size === 0) return null;
        const combos = [...posRange];
        const weights = combos.map(([, w]) => Math.max(0.01, w));
        const chosen = this.rng.choices(combos, weights)[0][0];
        const suits = ['s', 'h', 'd', 'c'];
        if (chosen.length === 2) {
          const [s1, s2] = this.rng.sample(suits, 2);
          return [chosen[0] + s1, chosen[0] + s2];
        }
        if (chosen.endsWith('s')) {
          const suit = this.rng.choice(suits);
          return [chosen[0] + suit, chosen[1] + suit];
        }
        const [s1, s2] = this.rng.sample(suits, 2);
        return [chosen[0] + s1, chosen[1] + s2];
      } catch (e) {
        return null;
      }
    }

    // カードを配り、ポジションをランダムに決める
    deal() {
      const { Card } = root;
      this.deck.shuffle();
      this.board = [];

      const forced = this.forcedPosition;
      if (forced && this.POSITIONS.includes(forced)) {
        this.heroPosition = forced;
        this.cpuPosition = this.rng.choice(this.POSITIONS.filter((p) => p !== forced));
      } else {
        const positions = this.POSITIONS.slice();
        this.rng.shuffle(positions);
        this.heroPosition = positions[0];
        this.cpuPosition = positions[1];
      }

      // スポット練習、または4ハンドに1回はレンジ内のハンドを配る
      const forceRange = this.spotMode || (this.handCount > 0 && this.handCount % 4 === 0);
      if (forceRange) {
        const combo = this._pickRangeCombo(this.heroPosition);
        if (combo) {
          try {
            const c1 = Card.fromStr(combo[0]), c2 = Card.fromStr(combo[1]);
            if (this.deck.cards.includes(c1) && this.deck.cards.includes(c2) && c1 !== c2) {
              this.deck.cards.splice(this.deck.cards.indexOf(c1), 1);
              this.deck.cards.splice(this.deck.cards.indexOf(c2), 1);
              this.heroHand = [c1, c2];
              return;
            }
          } catch (e) { /* Python と同じく通常の配布に落とす */ }
        }
      }
      this.heroHand = this.deck.draw(2);
    }

    placeBet(actor, amount) {
      if (amount <= 0) return;
      if (actor === 'HERO') {
        amount = Math.min(amount, this.heroStack);
        this.heroStack -= amount;
        this.heroInvested += amount;
        this.potSize += amount;
        if (this.heroInvested > this.currentBet) this.currentBet = this.heroInvested;
      } else {
        amount = Math.min(amount, this.cpuStack);
        this.cpuStack -= amount;
        this.cpuInvested += amount;
        this.potSize += amount;
        if (this.cpuInvested > this.currentBet) this.currentBet = this.cpuInvested;
      }
    }

    advanceStreet(streetName) {
      this.street = streetName;
      this.currentBet = 0.0;
      this.heroInvested = 0.0;
      this.cpuInvested = 0.0;
      if (streetName === 'FLOP') this.board = this.deck.draw(3);
      else if (streetName === 'TURN' || streetName === 'RIVER') this.board.push(this.deck.draw(1)[0]);
    }

    // このアクションで追加投入できる上限 = min(自分のスタック, 相手がコールできる額)
    maxAdditionalBet(actor) {
      let ownStack, ownInv, oppStack, oppInv;
      if (actor === 'HERO') {
        [ownStack, ownInv, oppStack, oppInv] = [this.heroStack, this.heroInvested, this.cpuStack, this.cpuInvested];
      } else {
        [ownStack, ownInv, oppStack, oppInv] = [this.cpuStack, this.cpuInvested, this.heroStack, this.heroInvested];
      }
      const callableTotal = oppInv + oppStack;
      return Math.max(0.0, Math.min(ownStack, callableTotal - ownInv));
    }

    isAllIn(actor) {
      return (actor === 'HERO' ? this.heroStack : this.cpuStack) <= 0.01;
    }

    // オールイン成立後、残りのストリートを全て配る
    runOutBoard() {
      const order = ['FLOP', 'TURN', 'RIVER'];
      while (this.street !== 'RIVER') {
        const nxt = this.street === 'PREFLOP' ? 'FLOP' : order[order.indexOf(this.street) + 1];
        this.advanceStreet(nxt);
      }
    }

    // PokerEngine.classify_board_texture は HandClassifier と同一の実装（2026/9 に照合済み）
    classifyBoardTexture(board) {
      return root.HandClassifier.classifyBoardTexture(board);
    }

    getNutsAdvantage(boardTexture) {
      if (boardTexture === 'paired') return 0.3;
      if (boardTexture === 'dry') return 0.2;
      if (boardTexture === 'wet') return -0.2;
      return 0.0;
    }

    updateRangeDict(actor, action, actionAmount = 0) {
      const { Ranges } = root;
      const current = actor === 'HERO' ? this.heroRange : this.cpuRange;
      const pos = actor === 'HERO' ? this.heroPosition : this.cpuPosition;
      let updated;

      if (this.street === 'PREFLOP') {
        const numRaises = this.actionHistory.filter((a) => a.action === 'BET' || a.action === 'RAISE').length;
        if (action === 'BET' || action === 'RAISE') {
          const cat = numRaises === 0 ? 'open' : numRaises === 1 ? '3bet' : '4bet_bluff';
          updated = new Map(Ranges.getRangeByCategory(pos, cat));
        } else if (action === 'CALL') {
          const cat = numRaises === 0 ? 'open' : numRaises === 1 ? 'vs_open_call' : 'vs_3bet_call';
          updated = new Map(Ranges.getRangeByCategory(pos, cat));
        } else if (action === 'FOLD') {
          updated = new Map([...current.keys()].map((k) => [k, 0.0]));
        } else {
          updated = current;
        }
      } else {
        let type = 'CHECK';
        if (action === 'BET' || action === 'RAISE') {
          type = actionAmount / Math.max(1.0, this.potSize) >= 0.5 ? 'LARGE_BET' : 'SMALL_BET';
        } else if (action === 'CALL') type = 'CALL';
        else if (action === 'FOLD') type = 'FOLD';
        updated = type === 'CHECK' ? current
          : Ranges.updateRangeAfterAction(current, type, actionAmount, this.board);
      }
      if (actor === 'HERO') this.heroRange = updated; else this.cpuRange = updated;
    }

    // GTO のブラフ割合 = Bet / (Pot + 2*Bet)
    static calculateTheoreticalBluffFrequency(betSize, pot) {
      if (betSize <= 0) return 0.0;
      if (pot + 2 * betSize === 0) return 0.0;
      return betSize / (pot + 2 * betSize);
    }

    // ショーダウン用に CPU の実ハンドを作る。cpuEffectiveEquity（実際に意思決定した強さ）に近いものを選ぶ
    generateRealizedCpuHand() {
      const { Card, Ranges, HandEvaluator } = root;
      const dead = new Set(this.heroHand.map(Card.toStr).concat(this.board.map(Card.toStr)));
      let valid = [];
      for (const [comboStr, weight] of this.cpuRange) {
        if (weight <= 0.0) continue;
        for (const pair of Ranges.parseCombo(comboStr)) {
          if (!pair.some((c) => dead.has(c))) valid.push([pair, weight]);
        }
      }
      if (valid.length === 0) {
        // 重みが全滅（FOLD 更新後など）: CPU ポジションのオープンレンジから均等に（UTG の別名解決はしない。Python と同じ）
        const fallback = getOr(Ranges.positionRanges, this.cpuPosition, new Map());
        for (const comboStr of fallback.keys()) {
          for (const pair of Ranges.parseCombo(comboStr)) {
            if (!pair.some((c) => dead.has(c))) valid.push([pair, 1.0]);
          }
        }
        if (valid.length === 0) { this.cpuHand = []; return; }
      }

      const targetEq = this.cpuEffectiveEquity;
      let chosen;
      if (targetEq !== null && targetEq !== undefined && this.board.length >= 3) {
        const scored = valid.map(([pair, w]) => {
          let score;
          try { score = HandEvaluator.evaluate(this.board, pair.map(Card.fromStr)); } catch (e) { score = 5000; }
          return [pair, w, score];
        });
        const scores = scored.map((x) => x[2]);
        const minS = Math.min(...scores), maxS = Math.max(...scores);
        const range = Math.max(1, maxS - minS);
        const norm = (s) => 1.0 - (s - minS) / range;
        // targetEq に近い上位20%を候補にして重み付きで引く（sort は安定なので Python と同順）
        const byDist = scored.slice().sort((a, b) => Math.abs(norm(a[2]) - targetEq) - Math.abs(norm(b[2]) - targetEq));
        const topN = Math.max(1, Math.floor(byDist.length / 5));
        const candidates = byDist.slice(0, topN);
        let totalW = 0;
        for (const [, w] of candidates) totalW += w;
        if (totalW <= 0) {
          chosen = candidates[0][0];
        } else {
          const r = this.rng.uniform(0, totalW);
          let cum = 0.0;
          chosen = candidates[0][0];
          for (const [pair, w] of candidates) {
            cum += w;
            if (r <= cum) { chosen = pair; break; }
          }
        }
      } else {
        let total = 0;
        for (const [, w] of valid) total += w;
        if (total <= 0) {
          chosen = this.rng.choice(valid)[0];
        } else {
          const r = this.rng.uniform(0, total);
          let cum = 0.0;
          chosen = valid[valid.length - 1][0];
          for (const [pair, w] of valid) {
            cum += w;
            if (r <= cum) { chosen = pair; break; }
          }
        }
      }
      this.cpuHand = chosen.map(Card.fromStr);
    }

    updatePot(amount) { this.potSize += amount; }

    // CPU の行動を決める。戻り値 [action, amount]
    cpuDecide(cpuEquity, opponentAction, opponentBetSize) {
      const { Equity, Evaluator: Ev, BetSizing: B } = root;
      const rng = this.rng;
      const isPreflop = this.street === 'PREFLOP';
      const heroRangeAdv = Equity.calcRangeAdvantage(this.heroHand, this.board, this.heroRange, this.cpuRange,
        isPreflop, 500, rng.random);
      const cpuRangeAdv = 1.0 - heroRangeAdv;

      // レンジ平均のエクイティから「今回持っているハンドの強さ」を正規分布でサンプリングする。
      // ストリートが進むほど分散を大きくする
      const streetVariance = { PREFLOP: 0.08, FLOP: 0.14, TURN: 0.17, RIVER: 0.20 }[this.street] ?? 0.14;
      let boardVarianceBonus = 0.0;
      if (this.board.length > 0) {
        const tex = this.classifyBoardTexture(this.board);
        boardVarianceBonus = { wet: 0.06, monotone: 0.08, paired: 0.05, semi_wet: 0.03, dry: 0.00 }[tex] ?? 0.00;
      }
      let eff = rng.gauss(cpuEquity, streetVariance + boardVarianceBonus);
      eff = Math.max(0.05, Math.min(0.95, eff));
      this.cpuEffectiveEquity = eff;

      if (opponentAction === 'BET' || opponentAction === 'RAISE') {
        const eReq = Ev.calculateRequiredEquity(opponentBetSize, this.potSize);
        let handPercentile, situation3betFreq, baseRaiseAmount;

        if (isPreflop) {
          // ヒーローの実カードは見ずに「レンジ内のどのハンドを引いたか」を一様にサンプリング
          const numRaises = this.actionHistory.filter((a) => a.action === 'BET' || a.action === 'RAISE').length;
          const isStandardOpen = numRaises <= 1 && this.currentBet <= 5.0;
          handPercentile = rng.random();   // 0=レンジ最弱, 1=最強
          if (isStandardOpen) {
            this._pfVsOpen = true;
            eff = 0.30 + handPercentile * 0.35;
            this.cpuEffectiveEquity = eff;
          } else {
            this._pfVsOpen = false;
            // vs 3ベット/特大ベット: ベットサイズから導く防衛頻度で確率的にフォールド
            const defendFreq = Math.max(0.15, Math.min(0.80, 1.0 - eReq * 1.6));
            if (handPercentile < (1.0 - defendFreq)) {
              this.cpuLastActionIntent = 'FOLD';
              this.cpuEffectiveEquity = 0.25 + handPercentile * 0.15;
              return ['FOLD', 0];
            }
            const pNorm = (handPercentile - (1.0 - defendFreq)) / Math.max(defendFreq, 1e-9);
            eff = 0.33 + pNorm * 0.30;
            this.cpuEffectiveEquity = eff;
          }
        }
        if (isPreflop) {
          const cpuIsIp = !this.isHeroIp;
          situation3betFreq = getOr(getOr(root.Ranges.GTO_3BET_MATRIX, this.cpuPosition, new Map()), this.heroPosition, 0.10);
          let raiseMult = cpuIsIp ? 3.0 : 3.5;   // IP はコンパクト、OOP は大きめ
          if (opponentBetSize > 4) raiseMult = rng.choice([2.2, 2.5]);   // 4ベット以上は小さく
          baseRaiseAmount = Math.max(opponentBetSize * raiseMult, opponentBetSize + 2.0);
        } else {
          const multTable = B.RAISE_MULTIPLIER[this.street] || B.RAISE_MULTIPLIER.FLOP;
          const texture = this.classifyBoardTexture(this.board);
          const nutsAdv = this.getNutsAdvantage(texture);
          const cpuNuts = this.isHeroIp ? -nutsAdv : nutsAdv;
          const largeBetWeight = 1.0 + (cpuNuts * 0.5);
          let largeProb = 0.2;
          largeProb *= largeBetWeight;
          largeProb = Math.max(0.0, Math.min(1.0, largeProb));
          let mult;
          if (eff >= eReq * 1.5) mult = multTable.large;
          else if (eff >= eReq * 1.2) mult = rng.random() < largeProb ? multTable.large : multTable.medium;
          else mult = multTable.small;
          baseRaiseAmount = Math.max(opponentBetSize * mult, opponentBetSize * 2.0);
        }

        const baseBluffFreq = PokerEngine.calculateTheoreticalBluffFrequency(baseRaiseAmount, this.potSize + opponentBetSize);
        let bluffThreshold;
        if (this.street === 'FLOP') bluffThreshold = baseBluffFreq * 0.9;
        else if (this.street === 'TURN') bluffThreshold = baseBluffFreq * 1.0;
        else bluffThreshold = baseBluffFreq * 1.05;
        const texture = this.classifyBoardTexture(this.board);
        if (texture in B.TEXTURE_MULTIPLIER) bluffThreshold *= B.TEXTURE_MULTIPLIER[texture];
        bluffThreshold *= this.isHeroIp ? B.POSITION_MULTIPLIER.OOP : B.POSITION_MULTIPLIER.IP;
        const effectiveStack = Math.min(this.heroStack, this.cpuStack);
        const spr = effectiveStack / Math.max(1.0, this.potSize);
        bluffThreshold *= spr < 3 ? B.SPR_MULTIPLIER.low : spr <= 6 ? B.SPR_MULTIPLIER.mid : B.SPR_MULTIPLIER.high;
        bluffThreshold = Math.max(0.0, Math.min(1.0, bluffThreshold));

        if (isPreflop) {
          // 標準オープンへの防衛: フォールドなし・95%コール・5%3ベット（上位4% + 最下位1%）
          if (this._pfVsOpen) {
            if (handPercentile >= 0.96 || handPercentile <= 0.01) {
              this.cpuLastActionIntent = handPercentile >= 0.96 ? 'VALUE' : 'BLUFF';
              return ['RAISE', Math.min(this.cpuStack, baseRaiseAmount)];
            }
            return ['CALL', opponentBetSize];
          }
          if (eff >= eReq * 2.5) {
            this.cpuLastActionIntent = 'VALUE';
            return ['RAISE', Math.min(this.cpuStack, baseRaiseAmount)];
          } else if (eff >= eReq * 1.3) {
            if (rng.random() < situation3betFreq * 1.5) {
              this.cpuLastActionIntent = 'VALUE';
              return ['RAISE', Math.min(this.cpuStack, baseRaiseAmount)];
            }
            return ['CALL', opponentBetSize];
          } else if (eff < eReq * 0.6 && rng.random() < situation3betFreq * 0.4) {
            this.cpuLastActionIntent = 'BLUFF';
            return ['RAISE', Math.min(this.cpuStack, baseRaiseAmount)];
          } else if (eff >= eReq) {
            return ['CALL', opponentBetSize];
          }
          return ['FOLD', 0];
        }

        // ポストフロップ
        if (eff >= eReq * 2.2 || (eff < eReq * 0.65 && rng.random() < bluffThreshold)) {
          this.cpuLastActionIntent = eff >= eReq * 1.8 ? 'VALUE' : 'BLUFF';
          return ['RAISE', Math.min(this.cpuStack, baseRaiseAmount)];
        } else if (eff >= eReq) {
          this.cpuLastActionIntent = 'CALL';
          return ['CALL', opponentBetSize];
        } else if (eff >= eReq * 0.85) {
          // マージナルゾーン: MDF ベースで確率的にコール/フォールド（pot はベット前を渡す）
          const mdf = Ev.calculateMdf(opponentBetSize, this.potSize - opponentBetSize);
          if (rng.random() < mdf * 0.6) {
            this.cpuLastActionIntent = 'CALL';
            return ['CALL', opponentBetSize];
          }
          this.cpuLastActionIntent = 'FOLD';
          return ['FOLD', 0];
        }
        this.cpuLastActionIntent = 'FOLD';
        return ['FOLD', 0];
      }

      // CPU が先に動く / チェックされた
      const isPreflopOpen = this.street === 'PREFLOP' && this.currentBet === 1.0;
      let evPass, actionIfPass, idealBetSize, actionIfBet;
      if (isPreflopOpen) {
        if (opponentAction === 'CALL' && opponentBetSize === 0.0) {
          evPass = Ev.evCheck(eff, this.potSize);
          actionIfPass = 'CHECK';
        } else {
          evPass = 0.0;
          actionIfPass = this.cpuPosition === 'SB' ? 'CALL' : 'FOLD';   // SB はリンプ可、他はタイトに
        }
        idealBetSize = B.PREFLOP_OPENS[this.cpuPosition] ?? 2.5;
        actionIfBet = 'RAISE';
      } else {
        evPass = Ev.evCheck(eff, this.potSize);
        const betTable = B.BET_SIZES[this.street] || B.BET_SIZES.FLOP;
        const texture = this.classifyBoardTexture(this.board);
        const nutsAdv = this.getNutsAdvantage(texture);
        const cpuNuts = this.isHeroIp ? -nutsAdv : nutsAdv;
        const largeBetWeight = 1.0 + (cpuNuts * 0.5);
        let largeProb = 0.2;
        largeProb *= largeBetWeight;
        largeProb = Math.max(0.0, Math.min(1.0, largeProb));
        let targetSizeRatio;
        if (cpuRangeAdv > 0.55) targetSizeRatio = betTable.small;   // レンジ優位 → 小さく高頻度
        else targetSizeRatio = (eff > 0.8 || rng.random() < largeProb) ? betTable.large : betTable.medium;
        if (eff > 0.85) targetSizeRatio = betTable.large;
        idealBetSize = this.potSize * targetSizeRatio;
        idealBetSize = Math.max(1.0, idealBetSize);
        actionIfPass = 'CHECK';
        actionIfBet = 'BET';
      }

      const foldEquityEst = idealBetSize / (this.potSize + idealBetSize);
      const streetRaiseFreq = { FLOP: 0.12, TURN: 0.08, RIVER: 0.03 }[this.street] ?? 0.10;
      const evBet = Ev.evBet(eff, this.potSize, idealBetSize, foldEquityEst, streetRaiseFreq);

      const baseBluffFreq = PokerEngine.calculateTheoreticalBluffFrequency(idealBetSize, this.potSize);
      let bluffFreq;
      if (this.street === 'FLOP') bluffFreq = baseBluffFreq * 0.9;
      else if (this.street === 'TURN') bluffFreq = baseBluffFreq * 1.0;
      else bluffFreq = baseBluffFreq * 1.05;
      const texture = this.classifyBoardTexture(this.board);
      bluffFreq *= B.BLUFF_FREQ_TEXTURE_MULTIPLIER[texture] ?? 1.0;
      bluffFreq *= this.isHeroIp ? B.POSITION_MULTIPLIER.OOP : B.POSITION_MULTIPLIER.IP;
      const effectiveStack = Math.min(this.heroStack, this.cpuStack);
      const spr = effectiveStack / Math.max(1.0, this.potSize);
      bluffFreq *= spr < 3 ? B.SPR_MULTIPLIER.low : spr <= 6 ? B.SPR_MULTIPLIER.mid : B.SPR_MULTIPLIER.high;
      bluffFreq = Math.max(0.0, Math.min(1.0, bluffFreq));

      // ストリート別の閾値（フロップは C ベット広め、リバーはセミブラフなし）
      let valueEqThreshold, bluffEqThreshold, semibluffFreqMult;
      if (this.street === 'RIVER') { valueEqThreshold = 0.54; bluffEqThreshold = 0.32; semibluffFreqMult = 0.0; }
      else if (this.street === 'TURN') { valueEqThreshold = 0.52; bluffEqThreshold = 0.42; semibluffFreqMult = 0.6; }
      else { valueEqThreshold = 0.50; bluffEqThreshold = 0.48; semibluffFreqMult = 1.0; }

      const isValueBet = evBet > evPass && eff >= valueEqThreshold;
      const isBluffBet = eff < bluffEqThreshold && rng.random() < bluffFreq;
      const isSemibluffBet = bluffEqThreshold <= eff && eff < valueEqThreshold &&
        rng.random() < (bluffFreq * semibluffFreqMult);

      if (actionIfPass === 'CALL') {
        const callCost = this.currentBet - this.cpuInvested;
        if (callCost <= 0.01) {   // 追加コストが無いのにフォールドは不可
          if (isValueBet || isBluffBet || isSemibluffBet) {
            this.cpuLastActionIntent = isValueBet ? 'VALUE' : 'BLUFF';
            return [actionIfBet, idealBetSize];
          }
          return ['CHECK', 0];
        }
        const evCall = Ev.evCall(eff, this.potSize, callCost);
        if (isValueBet || isBluffBet || isSemibluffBet) {
          this.cpuLastActionIntent = isValueBet ? 'VALUE' : 'BLUFF';
          return [actionIfBet, idealBetSize];
        } else if (evCall > evPass) {
          return ['CALL', callCost];
        }
        return ['FOLD', 0];
      }
      if (isValueBet || isBluffBet || isSemibluffBet) {
        this.cpuLastActionIntent = isValueBet ? 'VALUE' : 'BLUFF';
        return [actionIfBet, idealBetSize];
      }
      return [actionIfPass, 0];
    }
  }

  root.PokerEngine = PokerEngine;
  root.PokerDeck = Deck;
  if (typeof module !== 'undefined') module.exports = { PokerEngine, Deck };
})(typeof window !== 'undefined' ? window : globalThis);
