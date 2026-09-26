// ハンド分類・ドロー検出・ボードテクスチャ（hand_classifier.py の JS 移植）。
// 依存: hand_eval.js

(function (root) {
  if (typeof module !== 'undefined') require('./hand_eval.js');

  // rankSet 内に5枚連続があるか。A は high/low 両対応（ホイール A2345）
  function hasStraight(rankSet) {
    const s = new Set(rankSet);
    if (s.has(12)) s.add(-1);
    for (let lo = -1; lo < 9; lo++) {
      let ok = true;
      for (let i = 0; i < 5; i++) if (!s.has(lo + i)) { ok = false; break; }
      if (ok) return true;
    }
    return false;
  }

  // 2 = オープンエンド相当（完成ランク2種以上）/ 1 = ガットショット / 0 = なし
  function straightDrawLevel(rankSet) {
    const base = new Set(rankSet);
    if (hasStraight(base)) return 0;
    let outRanks = 0;
    for (let r = 0; r < 13; r++) {
      if (base.has(r)) continue;
      if (hasStraight(new Set([...base, r]))) outRanks++;
    }
    if (outRanks >= 2) return 2;
    if (outRanks === 1) return 1;
    return 0;
  }

  function countBy(arr) {
    const m = new Map();
    for (const x of arr) m.set(x, (m.get(x) || 0) + 1);
    return m;
  }

  const HandClassifier = {
    // ヒーローのホールカードが関与しているドローだけを返す
    detectDrawStrength(cards, board) {
      const { Card } = root;
      if (!board || board.length === 0) return 'NONE';
      // リバーはもう引くカードが無いのでドローは存在しない
      if (board.length >= 5) return 'NONE';

      const holeSuits = cards.map(Card.getSuitInt);
      const suitTotal = countBy(cards.concat(board).map(Card.getSuitInt));
      const holeHas = (s) => holeSuits.includes(s);
      let isFlushDraw = false, isBackdoorFlush = false;
      for (const [s, cnt] of suitTotal) {
        if (cnt === 4 && holeHas(s)) isFlushDraw = true;
        if (cnt === 3 && holeHas(s)) isBackdoorFlush = true;
      }

      const boardRanks = new Set(board.map(Card.getRankInt));
      const holeRanks = cards.map(Card.getRankInt);
      const boardLevel = straightDrawLevel(boardRanks);
      const combinedLevel = straightDrawLevel(new Set([...boardRanks, ...holeRanks]));
      const heroLevel = combinedLevel > boardLevel ? combinedLevel : 0;
      const isOesd = heroLevel === 2;
      const isGutshot = heroLevel === 1;

      if (isFlushDraw && (isOesd || isGutshot)) return 'STRONG_DRAW';  // コンボドロー
      if (isOesd) return 'STRONG_DRAW';
      if (isFlushDraw) return 'STRONG_DRAW';
      if (isGutshot) return 'MEDIUM_DRAW';
      if (isBackdoorFlush) return 'WEAK_DRAW';
      return 'NONE';
    },

    categorizeHand(cards, board = null) {
      const { Card, HandEvaluator } = root;
      if (!cards || cards.length < 2) return 'AIR';
      const r1 = Card.getRankInt(cards[0]);
      const r2 = Card.getRankInt(cards[1]);
      const isSuited = Card.getSuitInt(cards[0]) === Card.getSuitInt(cards[1]);

      if (board && board.length >= 3) {
        let score = 7462;
        try { score = HandEvaluator.evaluate(board, cards); } catch (e) { /* Python と同じく最弱扱い */ }
        if (score < 1600) return 'NUT_HAND';
        if (score < 3000) return 'STRONG_MADE';
        if (score < 5000) return 'MEDIUM_MADE';
        const draw = HandClassifier.detectDrawStrength(cards, board);
        if (draw !== 'NONE') return draw;
        return score <= 6185 ? 'WEAK_MADE' : 'AIR';
      }

      // プリフロップ: ハイカード強度の階層だけを表す（スーテッド等の加点は calculate_pi 側）
      const hi = Math.max(r1, r2), lo = Math.min(r1, r2);
      if (r1 === r2) {
        if (r1 >= 9) return 'STRONG_MADE';   // JJ+
        if (r1 >= 4) return 'MEDIUM_MADE';   // 66-TT
        return 'WEAK_MADE';                  // 22-55
      }
      if (hi === 12 && lo >= 10) return 'STRONG_MADE';  // AK, AQ
      if ((hi === 12 && lo >= 7 && isSuited) || (hi >= 10 && lo >= 9 && isSuited) || (hi === 12 && lo >= 9)) {
        return 'MEDIUM_MADE';
      }
      if (hi >= 10 && lo >= 8) return 'WEAK_MADE';  // オフスートブロードウェイ
      return 'AIR';
    },

    // 'dry' / 'semi_wet' / 'wet' / 'paired' / 'monotone'
    classifyBoardTexture(board) {
      const { Card } = root;
      if (board.length === 0) return 'dry';
      const suits = board.map(Card.getSuitInt);
      const ranks = board.map(Card.getRankInt);
      const maxSuit = Math.max(...countBy(suits).values());
      if (maxSuit >= 3) return 'monotone';
      if (Math.max(...countBy(ranks).values()) >= 2) return 'paired';

      const sorted = ranks.slice().sort((a, b) => b - a);
      let highly = false, semi = false;
      if (sorted.length >= 3) {
        for (let i = 0; i < sorted.length - 2; i++) {
          const gap = sorted[i] - sorted[i + 2];
          if (gap <= 3) highly = true;
          else if (gap <= 4) semi = true;
        }
      }
      if (maxSuit === 2 && highly) return 'wet';
      if (maxSuit === 2 || highly || semi) return 'semi_wet';
      return 'dry';
    },
  };

  root.HandClassifier = HandClassifier;
  if (typeof module !== 'undefined') module.exports = HandClassifier;
})(typeof window !== 'undefined' ? window : globalThis);
