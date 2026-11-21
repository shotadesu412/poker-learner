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
      'bet_sizing', 'rng', 'range_model']) require('./' + m + '.js');
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

    // プリフロップのレイズ回数（オープン=1、3ベット=2）。ポストフロップでも参照する
    get preflopRaiseCount() {
      return this.actionHistory.filter((a) => a.street === 'PREFLOP' && (a.action === 'BET' || a.action === 'RAISE')).length;
    }

    get is3betPot() {
      return this.preflopRaiseCount >= 2;
    }

    // プリフロップでまだ誰もアクションしていない
    get isFirstIn() {
      return this.street === 'PREFLOP' && this.actionHistory.length === 0;
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
        this.cpuRange = new Map(Ranges.getRangeByCategory(this.cpuPosition, 'vs_open_call', this.heroPosition));
      } else {
        this.cpuRange = new Map(Ranges.getRangeByCategory(this.cpuPosition, 'open'));
        this.heroRange = new Map(Ranges.getRangeByCategory(this.heroPosition, 'vs_open_call', this.cpuPosition));
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
      // このストリートが始まった時点で主導権を持っていた側（ドンクを受けたかの判定に使う。2026/11/21〜）
      this.streetStartAggressor = this.aggressor;
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
        const per3 = (kind) => {
          // 3ベットされた後の行動: 3ベットした位置ごとの表（「その手でオープンしていたときの割合」）を今のレンジに掛ける
          const tb = actor === 'HERO' ? this.cpuPosition : this.heroPosition;
          const m = (Ranges.RANGES.get(pos) || new Map()).get('vs_3bet_' + kind + '_vs_' + tb);
          if (!m) return null;
          return new Map([...current.entries()].map(([c, w0]) => [c, w0 * Math.min(1, m.get(c) || 0)]));
        };
        if ((action === 'BET' || action === 'RAISE') && numRaises === 2 && per3('4bet')) {
          updated = per3('4bet');
        } else if (action === 'CALL' && numRaises === 2 && actor === 'HERO' && per3('call')) {
          updated = per3('call');
        } else if (action === 'BET' || action === 'RAISE') {
          const cat = numRaises === 0 ? 'open' : numRaises === 1 ? 'vs_open_3bet' : '4bet_bluff';
          // 3ベットはオープンした位置ごとの表（2026/11/21〜。以前は位置によらない '3bet'）
          const opener = actor === 'HERO' ? this.cpuPosition : this.heroPosition;
          updated = new Map(Ranges.getRangeByCategory(pos, cat, numRaises === 1 ? opener : null));
        } else if (actor === 'CPU' && numRaises === 2 && this.aggressor === 'HERO' && (action === 'CALL' || action === 'FOLD')) {
          // CPU が 3ベットにコール/フォールド: 実際に使った確率（_vs3betProbs）でベイズ更新
          const RM = root.RangeModel;
          const table = RM.tableFor([]);
          const vec = RM.toVec(current);
          const eq = table.equityVector(vec, RM.toVec(this.heroRange));
          const facing = this.currentBet - this.cpuInvested;
          const mdfE = this._vs3betMdfE(eq, vec, facing);
          const out = new Float64Array(RM.N);
          for (let i = 0; i < RM.N; i++) {
            if (!(vec[i] > 0) || Number.isNaN(eq[i])) continue;
            const cls = PokerEngine.comboKey(RM.combos()[i]);
            out[i] = vec[i] * this._vs3betProbs(cls, eq[i], facing, mdfE)[action];
          }
          updated = RM.toMap(out);
        } else if (action === 'CALL') {
          const cat = numRaises === 0 ? 'open' : numRaises === 1 ? 'vs_open_call' : 'vs_3bet_call';
          const opener = actor === 'HERO' ? this.cpuPosition : this.heroPosition;
          updated = new Map(Ranges.getRangeByCategory(pos, cat, opener));
        } else if (action === 'FOLD') {
          updated = new Map([...current.keys()].map((k) => [k, 0.0]));
        } else {
          updated = current;
        }
      } else if (action === 'FOLD') {
        updated = new Map([...current.keys()].map((k) => [k, 0.0]));
      } else {
        // ベイズ更新: 重み × P(このアクション | 手札)。CPU の行動は同じモデルで決まる（range_model.js）
        const RM = root.RangeModel;
        const table = RM.tableFor(this.board);
        const vec = RM.toVec(current);
        const opp = RM.toVec(actor === 'HERO' ? this.cpuRange : this.heroRange);
        const ctx = this._modelContext(actor);
        updated = RM.toMap(RM.posterior(table, vec, opp, ctx, action, actionAmount, actor === 'CPU'));
      }
      if (actor === 'HERO') this.heroRange = updated; else this.cpuRange = updated;
    }

    // GTO のブラフ割合 = Bet / (Pot + 2*Bet)
    static calculateTheoreticalBluffFrequency(betSize, pot) {
      if (betSize <= 0) return 0.0;
      if (pot + 2 * betSize === 0) return 0.0;
      return betSize / (pot + 2 * betSize);
    }

    // CPU の手札は行動を決める時点で必ず持っている。万一無ければ（CPU が一度も動いていない等）
    // 今の CPU のレンジから引く（以前はショーダウンで「勝率が近い手」を後から作っていた）
    generateRealizedCpuHand() {
      if (this.cpuHand.length === 2) return;
      this._assignCpuHand(this.cpuRange);
    }

    updatePot(amount) { this.potSize += amount; }

    // ===== CPU の思考（2026/11/16 作り直し）=====
    // CPU は自分の手札で判断する。以前は「CPU レンジ vs あなたの実際の手札」の勝率に乱数を足して判断し、
    // 手札はショーダウンで後付けしていたため、あなたの手札が弱いほどレイズされ、強いほど降りられていた（透視）。
    // 手札はプリフロップで初めて必要になった時点で「その時の行動に合うレンジ」から引く。
    // あなたからは見えないので、配った時点で決めておくのと統計的に同じ。

    static comboKey(cards) {
      const { Card } = root;
      const order = 'AKQJT98765432';
      let [a, b] = cards.map(Card.toStr);
      if (order.indexOf(a[0]) > order.indexOf(b[0])) [a, b] = [b, a];
      if (a[0] === b[0]) return a[0] + b[0];
      return a[0] + b[0] + (a[1] === b[1] ? 's' : 'o');
    }

    // レンジ（{コンボ: 重み}）から CPU の手札を重み付きで引き、山札から抜く
    _assignCpuHand(rangeMap) {
      const { Card, Ranges } = root;
      const dead = new Set(this.heroHand.concat(this.board));
      const pool = [];
      for (const [comboStr, w] of rangeMap) {
        if (w <= 0) continue;
        for (const pair of Ranges.parseCombo(comboStr)) {
          const cs = pair.map(Card.fromStr);
          if (!cs.some((c) => dead.has(c))) pool.push([cs, w]);
        }
      }
      let chosen;
      if (pool.length === 0) {
        chosen = this.deck.cards.filter((c) => !dead.has(c)).slice(0, 2);
      } else {
        let total = 0;
        for (const [, w] of pool) total += w;
        let r = this.rng.uniform(0, total);
        chosen = pool[pool.length - 1][0];
        for (const [cs, w] of pool) { r -= w; if (r <= 0) { chosen = cs; break; } }
      }
      this.cpuHand = chosen;
      this.deck.cards = this.deck.cards.filter((c) => c !== chosen[0] && c !== chosen[1]);
    }

    // CPU の手札が、あなたの（推定）レンジに対して勝つ確率
    _cpuEquity(iterations = 300) {
      if (this.cpuHand.length < 2) return 0.5;
      const [eq] = root.Equity.calcEquityMonteCarlo(this.cpuHand, this.board, this.cpuRange, this.heroRange,
        'HERO', this.street === 'PREFLOP', iterations, this.rng.random);
      return eq;
    }

    _inRange(category) {
      const m = root.Ranges.getRangeByCategory(this.cpuPosition, category);
      if (m === root.Ranges.ALL_HANDS_DICT) return 0.0;   // データが無いカテゴリは「含まない」
      return m.get(PokerEngine.comboKey(this.cpuHand)) || 0.0;
    }

    // CPU の行動を決める。戻り値 [action, amount]（amount は追加で出す額）。
    // 第1引数（以前の「透視」エクイティ）は使わない。呼び出し側の互換のため残している
    cpuDecide(_unused, opponentAction, opponentBetSize) {
      if (this.street === 'PREFLOP') return this._cpuPreflop(opponentBetSize);
      return this._cpuPostflop(opponentBetSize);
    }

    _cpuPreflop(facing) {
      const { Ranges, BetSizing: B } = root;
      const rng = this.rng;
      const raises = this.preflopRaiseCount;
      const pos = this.cpuPosition;
      const cpuIsIp = !this.isHeroIp;

      if (raises === 0) {
        if (facing > 0.01) {
          // CPU が最初に参加する。初手フォールドは練習にならないので、オープンレンジの手を持っている前提（仕様）
          if (!this.cpuHand.length) this._assignCpuHand(Ranges.getRangeByCategory(pos, 'open'));
          if (pos === 'SB' && rng.random() < 0.18) {   // SB は時々リンプ
            this.cpuLastActionIntent = 'CALL';
            return ['CALL', facing];
          }
          this.cpuLastActionIntent = 'VALUE';
          return ['RAISE', B.PREFLOP_OPENS[pos] ?? 2.5];
        }
        // あなたのリンプに BB で: 強い手はレイズ、それ以外はチェック
        if (!this.cpuHand.length) this._assignCpuHand(Ranges.ALL_HANDS_DICT);
        const eq = this._cpuEquity(200);
        if (eq >= 0.60 && rng.random() < 0.75) {
          this.cpuLastActionIntent = 'VALUE';
          return ['RAISE', 3.0];
        }
        return ['CHECK', 0];
      }

      if (raises === 1 && !this.cpuHand.length) {
        // あなたのオープンに対して: フォールドなし・95%コール・5%3ベット（練習機会を増やすための仕様）
        // 3ベットは「オープン額の何倍に」: IP の席 2.5倍、ブラインド 3倍（あなたのボタンと同じ。6人卓 100bb の解析。2026/11/21〜）
        const raiseMult = (pos === 'SB' || pos === 'BB') ? 3.0 : 2.5;
        const raiseAdd = Math.max(0, this.currentBet * raiseMult - this.cpuInvested);
        if (rng.random() < 0.05) {
          const r3 = Ranges.getRangeByCategory(pos, 'vs_open_3bet', this.heroPosition);
          this._assignCpuHand(r3 !== Ranges.ALL_HANDS_DICT ? r3 : Ranges.getRangeByCategory(pos, '3bet'));
          this.cpuLastActionIntent = 'VALUE';
          return ['RAISE', Math.min(this.cpuStack, Math.max(raiseAdd, facing + 2.0))];
        }
        this._assignCpuHand(Ranges.getRangeByCategory(pos, 'vs_open_call', this.heroPosition));
        this.cpuLastActionIntent = 'CALL';
        return ['CALL', facing];
      }

      // 手札を持った状態でレイズされた（オープン→3ベットされた / リンプ→レイズされた / 3ベット→4ベットされた）
      const eReq = root.Evaluator.calculateRequiredEquity(facing, this.potSize);
      if (raises === 2 && this.aggressor === 'HERO') {
        // 3ベットされた: レンジ表（4ベット/コール）+ 表の外でも 3ベットのレンジに十分戦える手はコール。
        // あなたから見た CPU のレンジも同じ確率で更新する（updateRangeDict）
        const RM = root.RangeModel;
        const table = RM.tableFor([]);
        const idx = RM.comboIndex(this.cpuHand);
        const cpuVec = RM.toVec(this.cpuRange);
        cpuVec[idx] = Math.max(cpuVec[idx], 1e-9);
        const eqv = table.equityVector(cpuVec, RM.toVec(this.heroRange));
        const eq3 = eqv[idx];
        const mdfE = this._vs3betMdfE(eqv, cpuVec, facing);
        const pr = this._vs3betProbs(PokerEngine.comboKey(this.cpuHand), Number.isNaN(eq3) ? 0.5 : eq3, facing, mdfE);
        const r = rng.random();
        if (r < pr.RAISE) {
          this.cpuLastActionIntent = r < pr.value ? 'VALUE' : 'BLUFF';
          return ['RAISE', Math.min(this.cpuStack, facing * 2.4)];
        }
        if (r < pr.RAISE + pr.CALL) { this.cpuLastActionIntent = 'CALL'; return ['CALL', facing]; }
        this.cpuLastActionIntent = 'FOLD';
        return ['FOLD', 0];
      }
      const eq = this._cpuEquity(200);
      const spr = Math.min(this.heroStack, this.cpuStack) / Math.max(1.0, this.potSize);
      if (raises >= 3 && eq >= 0.55) {
        // 4ベット以降に強い手: スタックが浅ければオールイン、深ければコール
        this.cpuLastActionIntent = 'VALUE';
        return spr < 3 ? ['RAISE', this.cpuStack] : ['CALL', facing];
      }
      if (raises <= 2 && eq >= 0.62 && rng.random() < 0.6) {
        this.cpuLastActionIntent = 'VALUE';
        return ['RAISE', Math.min(this.cpuStack, facing * 3.0)];
      }
      if (eq >= eReq) { this.cpuLastActionIntent = 'CALL'; return ['CALL', facing]; }
      this.cpuLastActionIntent = 'FOLD';
      return ['FOLD', 0];
    }

    // 3ベットに対する防衛の下限の勝率（CPU のレンジのうち上位 MDF × VS3BET_MDF_SHARE に入る境目）
    _vs3betMdfE(eqv, vec, facing) {
      const mdf = Math.max(0, this.potSize - facing) / Math.max(0.01, this.potSize);
      return root.RangeModel.quantileE(eqv, vec, mdf * PokerEngine.VS3BET_MDF_SHARE);
    }

    // 3ベットに対する CPU の行動確率（手札の種類 cls と、3ベットのレンジに対する勝率 eq3 から）
    _vs3betProbs(cls, eq3, facing, mdfE) {
      const R = root.Ranges;
      const pos = this.cpuPosition;
      const w = (cat) => { const m = R.getRangeByCategory(pos, cat); return m === R.ALL_HANDS_DICT ? 0 : (m.get(cls) || 0); };
      // 3ベットした位置ごとの表があれば、その割合どおりに行動する（2026/11/21〜。あなたの判定と同じ表。
      // 解析の「3ベットされたときの続ける割合」に合わせて作ってあるので、値段や防衛の下限で広げない）
      const posData = R.RANGES.get(pos);
      const per = posData && posData.get('vs_3bet_call_vs_' + this.heroPosition);
      if (per) {
        const r4 = Math.min(1, (posData.get('vs_3bet_4bet_vs_' + this.heroPosition) || new Map()).get(cls) || 0);
        const c = Math.min(1 - r4, per.get(cls) || 0);
        return { RAISE: r4, value: r4, CALL: c, FOLD: Math.max(0, 1 - r4 - c) };
      }
      const w4 = w('vs_3bet_4bet'), wb = w('4bet_bluff'), wc = w('vs_3bet_call');
      const value = Math.min(1, w4);
      const bluff = (1 - value) * Math.min(1, wb) * 0.5;
      const raise = value + bluff;
      const callChart = Math.min(1 - raise, wc * (1 - Math.min(1, wb) * 0.5));
      // 値段で決める: 3ベットのレンジに対する勝率 × 実現率 ≥ 必要勝率。小さい 3ベットほど広く守る。
      // さらにレンジの上位（MDF × VS3BET_MDF_SHARE）は降りない（mdfE。小さい 3ベットに降りすぎないため）
      const eReq = facing / (this.potSize + facing);
      const realize = !this.isHeroIp ? PokerEngine.VS3BET_REALIZE.IP : PokerEngine.VS3BET_REALIZE.OOP;
      const byPrice = 1 / (1 + Math.exp(-(eq3 * realize - eReq) / 0.015));
      const byMdf = mdfE === undefined ? 0 : 1 / (1 + Math.exp(-(eq3 - mdfE) / 0.015));
      const byEq = Math.max(byPrice, byMdf);
      const call = callChart + (1 - raise - callChart) * byEq;
      return { RAISE: raise, value, CALL: call, FOLD: Math.max(0, 1 - raise - call) };
    }

    // 行動モデルに渡す状況（勝率 e と手札ごとの値は呼び出し側で足す）。アクションを記録する前の状態で呼ぶこと
    _modelContext(actor) {
      const isHero = actor === 'HERO';
      const inv = isHero ? this.heroInvested : this.cpuInvested;
      const other = isHero ? 'CPU' : 'HERO';
      return {
        street: this.street,
        facing: Math.max(0, this.currentBet - inv),
        pot: this.potSize,
        stack: isHero ? this.heroStack : this.cpuStack,
        wasAggressor: this.aggressor === actor,
        ip: isHero ? this.isHeroIp : !this.isHeroIp,
        opponentChecked: this.actionHistory.some((a) => a.street === this.street && a.actor === other && a.action === 'CHECK'),
        // ドンクを受けた: このストリートの主導権はこちらにあったのに、相手が先に打ってきた（2026/11/21〜）
        vsDonk: this.street !== 'PREFLOP' && this.streetStartAggressor === actor && (() => {
          const first = this.actionHistory.find((a) => a.street === this.street);
          return !!first && first.actor === other && first.action === 'BET';
        })(),
        texture: this.classifyBoardTexture(this.board),
      };
    }

    // CPU の手札の、あなたの推定レンジに対する勝率（レンジ推定と同じ計算）
    _cpuHandEquity() {
      const RM = root.RangeModel;
      const table = RM.tableFor(this.board);
      const idx = RM.comboIndex(this.cpuHand);
      const one = new Float64Array(RM.N);
      one[idx] = 1;
      const e = table.equityVector(one, RM.toVec(this.heroRange))[idx];
      return { table, idx, e: Number.isNaN(e) ? 0.5 : e };
    }

    _cpuPostflop(facing) {
      const RM = root.RangeModel;
      const { table, idx, e } = this._cpuHandEquity();
      this.cpuEffectiveEquity = e;
      const nr = table.nowRank[idx];
      const s = { ...this._modelContext('CPU'), e, made: nr <= 6185, draw: table.draw(idx) };
      if (facing > 0.01) {
        s.facing = facing;
        // 防衛の下限（レンジ推定の posterior と同じ計算）
        const cpuVec = RM.toVec(this.cpuRange);
        s.mdfE = RM.mdfEdge(table.equityVector(cpuVec, RM.toVec(this.heroRange)), cpuVec, s);
      }
      const dist = RM.ActionModel.probs(s);
      let r = this.rng.random();
      let pick = dist[dist.length - 1];
      for (const o of dist) { if (r < o.p) { pick = o; break; } r -= o.p; }
      if (pick.action === 'FOLD') this.cpuLastActionIntent = 'FOLD';
      else if (pick.action === 'CALL') this.cpuLastActionIntent = 'CALL';
      else if (pick.action === 'CHECK') this.cpuLastActionIntent = null;
      else this.cpuLastActionIntent = e < 0.45 ? 'BLUFF' : 'VALUE';
      return [pick.action, pick.amount];
    }
  }

  // 3ベットにレンジ表の外でコールするときの実現率（IP は後のストリートで有利）と、防衛の下限（MDF の何割は守るか）
  PokerEngine.VS3BET_REALIZE = { IP: 0.85, OOP: 0.75 };
  PokerEngine.VS3BET_MDF_SHARE = 0.8;

  root.PokerEngine = PokerEngine;
  root.PokerDeck = Deck;
  if (typeof module !== 'undefined') module.exports = { PokerEngine, Deck };
})(typeof window !== 'undefined' ? window : globalThis);
