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
      if (this.cpuHand.length === 2) return;   // 2026/11/16〜 CPU は実際の手札を持っている
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
        const raiseMult = cpuIsIp ? 3.0 : 3.5;
        if (rng.random() < 0.05) {
          const r3 = Ranges.getRangeByCategory(pos, 'vs_open_3bet');
          this._assignCpuHand(r3 !== Ranges.ALL_HANDS_DICT ? r3 : Ranges.getRangeByCategory(pos, '3bet'));
          this.cpuLastActionIntent = 'VALUE';
          return ['RAISE', Math.min(this.cpuStack, Math.max(facing * raiseMult, facing + 2.0))];
        }
        this._assignCpuHand(Ranges.getRangeByCategory(pos, 'vs_open_call'));
        this.cpuLastActionIntent = 'CALL';
        return ['CALL', facing];
      }

      // 手札を持った状態でレイズされた（オープン→3ベットされた / リンプ→レイズされた / 3ベット→4ベットされた）
      const eReq = root.Evaluator.calculateRequiredEquity(facing, this.potSize);
      if (raises === 2 && this.aggressor === 'HERO') {
        const w4 = this._inRange('vs_3bet_4bet'), wb = this._inRange('4bet_bluff'), wc = this._inRange('vs_3bet_call');
        const r = rng.random();
        if (r < w4 || rng.random() < wb * 0.5) {
          this.cpuLastActionIntent = r < w4 ? 'VALUE' : 'BLUFF';
          return ['RAISE', Math.min(this.cpuStack, facing * rng.choice([2.2, 2.5]))];
        }
        if (r < w4 + wc) { this.cpuLastActionIntent = 'CALL'; return ['CALL', facing]; }
        // レンジ表の外でも、3ベットのレンジに十分戦える手（IP はやや広め）はコール。
        // それ以外は降りる（実戦の 3ベットへのフォールド率は 5〜6割）
        // 3ベットのレンジに対して十分戦える手だけ（OOP はさらに厳しく）
        const eq3 = this._cpuEquity(200);
        if (eq3 >= (cpuIsIp ? 0.42 : 0.46) && eq3 >= eReq) { this.cpuLastActionIntent = 'CALL'; return ['CALL', facing]; }
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

    _cpuPostflop(facing) {
      const { Evaluator: Ev, HandClassifier } = root;
      const rng = this.rng;
      const st = this.street;
      const pot = this.potSize;
      const eq = this._cpuEquity(300);
      this.cpuEffectiveEquity = eq;
      const draw = HandClassifier.detectDrawStrength(this.cpuHand, this.board);
      const strongDraw = draw === 'STRONG_DRAW';
      const isRiver = st === 'RIVER';
      // 残りスタックに対して大きすぎるベットは、オールインにまとめる
      const sizeOrJam = (amount) => (amount >= this.cpuStack * 0.6 ? this.cpuStack : amount);

      if (facing > 0.01) {
        // ---- ベット/レイズされた ----
        const eReq = Ev.calculateRequiredEquity(facing, pot);
        const r = rng.random();
        const raiseAmt = sizeOrJam(facing * 3.0);
        if (eq >= (isRiver ? 0.88 : 0.82) && r < 0.6) {
          this.cpuLastActionIntent = 'VALUE';
          return ['RAISE', raiseAmt];
        }
        if (!isRiver && strongDraw && r < 0.20) {
          this.cpuLastActionIntent = 'BLUFF';
          return ['RAISE', raiseAmt];
        }
        if (isRiver && eq < 0.12 && r < 0.04) {
          this.cpuLastActionIntent = 'BLUFF';
          return ['RAISE', raiseAmt];
        }
        // 生の勝率をそのまま全部は回収できない（OOP・役なしは特に）。リバーは残りのカードが無いので割り引かない
        const cpuIpNow = !this.isHeroIp;
        const madeHand = root.HandEvaluator.evaluate(this.board, this.cpuHand) <= 6185;   // ワンペア以上
        let realize = 1.0;
        if (!isRiver) {
          realize = cpuIpNow ? 0.92 : 0.80;
          if (!madeHand && !strongDraw) realize *= 0.80;
        }
        // ドローは次のカードで勝てる分を少し上乗せして考える
        const need = eReq - (!isRiver && strongDraw ? 0.04 : 0.0);
        const eqReal = eq * realize;
        if (eqReal >= need || (eqReal >= need * 0.9 && rng.random() < 0.25)) {
          this.cpuLastActionIntent = 'CALL';
          return ['CALL', facing];
        }
        this.cpuLastActionIntent = 'FOLD';
        return ['FOLD', 0];
      }

      // ---- 先に動く / チェックされた ----
      const cpuIp = !this.isHeroIp;
      const wasAggressor = this.aggressor === 'CPU';   // 直前のストリートまでで最後にベット/レイズしたのが CPU
      const heroChecked = this.actionHistory.some((a) => a.street === st && a.actor === 'HERO' && a.action === 'CHECK');
      const texture = this.classifyBoardTexture(this.board);
      const r = rng.random();

      let size;
      if (st === 'FLOP') size = (wasAggressor && (texture === 'dry' || texture === 'paired')) ? 0.33 : 0.66;
      else if (st === 'TURN') size = 0.66;
      else size = eq >= 0.85 ? 1.0 : 0.75;
      const betAmt = sizeOrJam(Math.max(1.0, pot * size));

      const valueThr = { FLOP: 0.65, TURN: 0.68, RIVER: 0.70 }[st];
      // あなたが前のストリートで攻めていて、CPU が OOP で先に動く場面（ドンク）は基本チェック
      const donkSpot = !wasAggressor && !cpuIp && !heroChecked;

      if (eq >= valueThr) {
        if (r < (donkSpot ? 0.35 : 0.85)) {
          this.cpuLastActionIntent = 'VALUE';
          return ['BET', betAmt];
        }
        return ['CHECK', 0];
      }

      let bluffP;
      if (donkSpot) bluffP = strongDraw ? 0.10 : 0.03;
      else if (wasAggressor) {
        // 前のストリートで攻めた側（Cベット・バレル）
        if (st === 'FLOP') bluffP = eq < 0.45 ? (strongDraw ? 0.65 : 0.45) : 0.35;
        else if (st === 'TURN') bluffP = strongDraw ? 0.55 : (eq < 0.35 ? 0.25 : 0.15);
        else bluffP = eq < 0.20 ? 0.40 : 0.0;
      } else {
        // チェックされた（あなたが攻めるのをやめた）
        if (st === 'FLOP') bluffP = strongDraw ? 0.50 : (eq < 0.45 ? 0.35 : 0.20);
        else if (st === 'TURN') bluffP = strongDraw ? 0.45 : (eq < 0.35 ? 0.30 : 0.15);
        else bluffP = eq < 0.20 ? 0.30 : 0.0;
      }
      if (r < bluffP) {
        this.cpuLastActionIntent = eq < 0.45 ? 'BLUFF' : 'VALUE';
        return ['BET', betAmt];
      }
      return ['CHECK', 0];
    }
  }

  root.PokerEngine = PokerEngine;
  root.PokerDeck = Deck;
  if (typeof module !== 'undefined') module.exports = { PokerEngine, Deck };
})(typeof window !== 'undefined' ? window : globalThis);
