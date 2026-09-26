// ハンド評価器（treys の JS 移植）。
// Python の treys と完全に同じスコア（1=ロイヤルフラッシュ 〜 7462=最弱ハイカード、小さいほど強い）を返す。
// カードも treys と同じ 32bit 整数表現にしてあるので、Python の Card.get_rank_int 等を
// そのまま 1 対 1 で移植できる。
//
//   |xxxbbbbb|bbbbbbbb|cdhsrrrr|xxpppppp|
//   b = ランクのビット / cdhs = スート / r = ランク(0-12) / p = ランクの素数
//
// 依存: hand_table.js（HAND_TABLE。先に <script> で読み込むこと）

(function (root) {
  const TABLE = (typeof HAND_TABLE !== 'undefined') ? HAND_TABLE : require('./hand_table.js');

  const STR_RANKS = '23456789TJQKA';
  const PRIMES = [2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41];
  const SUIT_TO_INT = { s: 1, h: 2, d: 4, c: 8 };
  const INT_TO_SUIT = 'xshxdxxxc';

  // オブジェクトのキーは文字列になるので、数値キーの Map に詰め替えておく
  const FLUSH = new Map(Object.entries(TABLE.flush).map(([k, v]) => [Number(k), v]));
  const UNSUITED = new Map(Object.entries(TABLE.unsuited).map(([k, v]) => [Number(k), v]));
  const B = TABLE.boundaries;

  const Card = {
    STR_RANKS,
    PRIMES,

    // 'As' -> treys の整数表現
    fromStr(s) {
      const rank = STR_RANKS.indexOf(s[0]);
      const suit = SUIT_TO_INT[s[1]];
      if (rank < 0 || !suit) throw new Error('invalid card: ' + s);
      return ((1 << rank) << 16) | (suit << 12) | (rank << 8) | PRIMES[rank];
    },
    toStr(c) {
      return STR_RANKS[Card.getRankInt(c)] + INT_TO_SUIT[Card.getSuitInt(c)];
    },
    getRankInt(c) { return (c >> 8) & 0xF; },
    getSuitInt(c) { return (c >> 12) & 0xF; },
    getBitrankInt(c) { return (c >> 16) & 0x1FFF; },
    getPrime(c) { return c & 0x3F; },
  };

  function primeProductFromRankbits(rankbits) {
    let product = 1;
    for (let i = 0; i < 13; i++) {
      if (rankbits & (1 << i)) product *= PRIMES[i];
    }
    return product;
  }

  function five(a, b, c, d, e) {
    if (a & b & c & d & e & 0xF000) {
      const handOR = (a | b | c | d | e) >> 16;
      return FLUSH.get(primeProductFromRankbits(handOR));
    }
    const prime = (a & 0xFF) * (b & 0xFF) * (c & 0xFF) * (d & 0xFF) * (e & 0xFF);
    return UNSUITED.get(prime);
  }

  // 5〜7枚から全ての5枚組を試して最小スコアを返す（treys の _five/_six/_seven と同じ）
  function bestOf(cards) {
    const n = cards.length;
    if (n < 5 || n > 7) throw new Error('evaluate expects 5-7 cards, got ' + n);
    let min = B.MAX_HIGH_CARD;
    for (let i = 0; i < n - 4; i++)
      for (let j = i + 1; j < n - 3; j++)
        for (let k = j + 1; k < n - 2; k++)
          for (let l = k + 1; l < n - 1; l++)
            for (let m = l + 1; m < n; m++) {
              const s = five(cards[i], cards[j], cards[k], cards[l], cards[m]);
              if (s < min) min = s;
            }
    return min;
  }

  const HandEvaluator = {
    // treys の Evaluator.evaluate(hand, board) と同じ。引数は整数カードの配列
    evaluate(hand, board) {
      return bestOf(hand.concat(board));
    },
    getRankClass(hr) {
      const order = ['MAX_ROYAL_FLUSH', 'MAX_STRAIGHT_FLUSH', 'MAX_FOUR_OF_A_KIND', 'MAX_FULL_HOUSE',
        'MAX_FLUSH', 'MAX_STRAIGHT', 'MAX_THREE_OF_A_KIND', 'MAX_TWO_PAIR', 'MAX_PAIR', 'MAX_HIGH_CARD'];
      if (hr < 0) throw new Error('invalid hand rank: ' + hr);
      for (const key of order) {
        if (hr <= B[key]) return TABLE.rankClass[String(B[key])];
      }
      throw new Error('invalid hand rank: ' + hr);
    },
    classToString(classInt) {
      return TABLE.classNames[String(classInt)];
    },
  };

  root.Card = Card;
  root.HandEvaluator = HandEvaluator;
  if (typeof module !== 'undefined') module.exports = { Card, HandEvaluator };
})(typeof window !== 'undefined' ? window : globalThis);
