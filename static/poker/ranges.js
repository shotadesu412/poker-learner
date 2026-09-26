// プリフロップレンジ（ranges.py の JS 移植）。データは ranges.json を Python と共有する。
//
// ⚠️ レンジは Object ではなく Map（combo → 重み）で持つ。
//   JS の Object は "22"〜"99" のような整数っぽいキーを先頭に並べ替えてしまい、
//   Python（dict はファイル順）と反復順が変わる。update_range_after_action は
//   同点コンボの順位を反復順で決めるので、順序がずれると結果が変わる。
//
// 読み込み: ブラウザは await Ranges.load()（fetch）、Node は require した時点で読み込み済み。
// 依存: hand_eval.js（ポストフロップの強さ順ソート）, messages.js（ハンド解説）。ブラウザでは先に <script> で読むこと

(function (root) {
  const RANKS_DESC = 'AKQJT98765432';
  const SUITS = 'shdc';

  // JSON.parse すると整数っぽいキーの順序が壊れるので、全キーに接頭辞を付けてから
  // parse し、Map に詰め直す。文字列トークンを正しく切り出してから判定しているので、
  // 値の文字列の中に ":" があっても誤爆しない。
  function parseOrdered(text) {
    const guarded = text.replace(/"(?:[^"\\]|\\.)*"(?=\s*:)/g, (key) => '"k' + key.slice(1));
    const toMap = (v) => {
      if (Array.isArray(v)) return v.map(toMap);
      if (v && typeof v === 'object') {
        const m = new Map();
        for (const [k, x] of Object.entries(v)) m.set(k.slice(1), toMap(x));
        return m;
      }
      return v;
    };
    return toMap(JSON.parse(guarded));
  }

  // "position_ranges.LJ" のような文字列は参照。同じ Map オブジェクトに解決する（Python と同じ）
  function resolveRefs(data) {
    for (const acts of data.get('ranges').values()) {
      for (const [act, v] of acts) {
        if (typeof v === 'string') {
          const dot = v.indexOf('.');
          acts.set(act, data.get(v.slice(0, dot)).get(v.slice(dot + 1)));
        }
      }
    }
    return data;
  }

  function generateAllHandsDict() {
    const hands = new Map();
    for (let i = 0; i < RANKS_DESC.length; i++) {
      for (let j = i; j < RANKS_DESC.length; j++) {
        const r1 = RANKS_DESC[i], r2 = RANKS_DESC[j];
        if (r1 === r2) {
          hands.set(r1 + r2, 1.0);
        } else {
          hands.set(r1 + r2 + 's', 1.0);
          hands.set(r1 + r2 + 'o', 1.0);
        }
      }
    }
    return hands;
  }

  const Ranges = {
    ALL_HANDS_DICT: generateAllHandsDict(),
    positionRanges: null,
    threebetRanges: null,
    GTO_3BET_MATRIX: null,
    RANGES: null,

    _init(text) {
      const data = resolveRefs(parseOrdered(text));
      this.positionRanges = data.get('position_ranges');
      this.threebetRanges = data.get('threebet_ranges');
      this.GTO_3BET_MATRIX = data.get('gto_3bet_matrix');
      this.RANGES = data.get('ranges');
      return this;
    },

    async load(url = '/static/poker/ranges.json') {
      if (this.RANGES) return this;
      const res = await fetch(url);
      if (!res.ok) throw new Error('ranges.json の読み込みに失敗: ' + res.status);
      return this._init(await res.text());
    },

    classifyRange(weight) {
      if (weight >= 1.0) return 'CORE';
      if (weight > 0.0) return 'MIXED';
      return 'FOLD';
    },

    // ranges.get_range_by_category と同じフォールバック規則
    //  - UTG の open は LJ へエイリアス
    //  - vs_open_call が空なら call ∪ 3bet を合成（SB の 3bet-or-fold 対応）
    //  - それでも空なら全ハンド
    getRangeByCategory(category, action = 'open') {
      const posData = this.RANGES.get(category) || new Map();
      let result = posData.get(action);
      const empty = (r) => !r || r.size === 0;

      if (empty(result) && action === 'open' && category === 'UTG') {
        result = (this.RANGES.get('LJ') || new Map()).get('open') || new Map();
      }
      if (empty(result) && action === 'vs_open_call') {
        const merged = new Map(posData.get('vs_open_call') || []);
        for (const [combo, w] of (posData.get('vs_open_3bet') || [])) {
          merged.set(combo, Math.max(merged.has(combo) ? merged.get(combo) : 0.0, w));
        }
        if (merged.size) result = merged;
      }
      if (empty(result)) return this.ALL_HANDS_DICT;
      return result;
    },

    getPreflopFeedback(classification) {
      const t = (k) => root.Messages.t(k);
      if (classification === 'CORE') return t('hand.range.standard');
      if (classification === 'MIXED') return t('hand.range.borderline');
      return t('hand.range.out');
    },

    // ranges.get_hand_reason と同じ（判定順も同じにしてある）
    getHandReason(comboStr) {
      const t = (k) => root.Messages.t(k);
      const inList = (list) => list.includes(comboStr);
      if (inList(['A5s', 'A4s', 'A3s', 'A2s', 'K5s', 'K4s'])) return t('hand.suited_ace_king');
      if (inList(['KJo', 'KTo', 'QJo', 'QTo', 'JTo'])) return t('hand.trap_offsuit');
      if (inList(['AJo', 'ATo'])) return t('hand.marginal_broadway');
      if (inList(['K9s', 'QTs', 'Q9s', 'J8s'])) return t('hand.kicker_risk');
      if (inList(['AA', 'KK', 'QQ'])) return t('hand.premium');
      if (inList(['AKs', 'AKo'])) return t('hand.ak');
      if (inList(['76s', '65s', '54s', '87s', '98s'])) return t('hand.suited_connector');
      if (comboStr.length === 2 && comboStr[0] === comboStr[1]) return t('hand.pocket_pair');
      return t('hand.standard');
    },

    // "AKs" → [["As","Ks"], ...] / "77" → 6通り / "AhKh" → 1通り
    parseCombo(comboStr) {
      const combos = [];
      if (comboStr.length === 2) {
        const r = comboStr[0];
        for (let i = 0; i < 4; i++)
          for (let j = i + 1; j < 4; j++) combos.push([r + SUITS[i], r + SUITS[j]]);
      } else if (comboStr.length === 3) {
        const [r1, r2, t] = comboStr;
        if (t === 's') {
          for (const s of SUITS) combos.push([r1 + s, r2 + s]);
        } else if (t === 'o') {
          for (const s1 of SUITS)
            for (const s2 of SUITS) if (s1 !== s2) combos.push([r1 + s1, r2 + s2]);
        }
      } else if (comboStr.length === 4) {
        combos.push([comboStr.slice(0, 2), comboStr.slice(2, 4)]);
      }
      return combos;
    },

    // ranges.sort_range_by_strength と同じ。強い順のコンボ名配列を返す。
    // Array.prototype.sort は安定ソートなので、同点は Python と同じく元の反復順のまま残る。
    sortRangeByStrength(rangeMap, board = []) {
      const keys = [...rangeMap.keys()];
      if (!board || board.length === 0) {
        const RANK = { A: 14, K: 13, Q: 12, J: 11, T: 10, 9: 9, 8: 8, 7: 7, 6: 6, 5: 5, 4: 4, 3: 3, 2: 2 };
        const strength = (c) => {
          if (!c) return [0, 0, 0];
          let r1 = RANK[c[0]] || 0;
          let r2 = c.length > 1 ? (RANK[c[1]] || 0) : 0;
          if (r2 > r1) [r1, r2] = [r2, r1];
          if (c.length >= 2 && c[0] === c[1]) return [3, r1, r2];
          if (c.length >= 3 && c[2] === 's') return [2, r1, r2];
          return [1, r1, r2];
        };
        const cmp = (a, b) => (b[0] - a[0]) || (b[1] - a[1]) || (b[2] - a[2]);  // 降順
        const keyed = keys.map((k) => [k, strength(k)]);
        keyed.sort((x, y) => cmp(x[1], y[1]));
        return keyed.map((x) => x[0]);
      }
      const { Card, HandEvaluator: HE } = root;
      if (!HE) throw new Error('hand_eval.js が読み込まれていない');
      const deadStr = board.map((c) => Card.toStr(c));
      const postflop = (comboStr) => {
        let best = 9999;
        for (const pair of this.parseCombo(comboStr)) {
          if (pair.some((c) => deadStr.includes(c))) continue;
          const score = HE.evaluate(board, pair.map(Card.fromStr));
          if (score < best) best = score;
        }
        return best;
      };
      const keyed = keys.map((k) => [k, postflop(k)]);
      keyed.sort((x, y) => x[1] - y[1]);  // 昇順（スコアが小さいほど強い）
      return keyed.map((x) => x[0]);
    },

    // ranges.update_range_after_action と同じ。新しい Map を返す（引数は変更しない）。
    // 戻り値の反復順は「強い順」になり、次回の更新の同点処理に効く。
    updateRangeAfterAction(rangeMap, actionType, betSize = null, board = []) {
      const updated = new Map();
      if (!rangeMap || rangeMap.size === 0) return updated;
      if (actionType === 'FOLD') {
        for (const k of rangeMap.keys()) updated.set(k, 0.0);
        return updated;
      }
      const sorted = this.sortRangeByStrength(rangeMap, board);
      const total = sorted.length;
      for (let i = 0; i < total; i++) {
        const combo = sorted[i];
        const percentile = i / total;
        const weight = rangeMap.get(combo);
        if (weight <= 0.0) {
          updated.set(combo, 0.0);
          continue;
        }
        let w = weight;
        // 小さいベット = レンジベット（ほぼ絞らない）/ 大きいベット = ポラライズ（中間が抜ける）
        if (actionType === 'LARGE_BET') {
          if (percentile < 0.30) w = weight * 1.0;
          else if (percentile < 0.70) w = weight * 0.2;
          else w = weight * 0.8;
        } else if (actionType === 'SMALL_BET') {
          if (percentile < 0.50) w = weight * 1.0;
          else if (percentile < 0.80) w = weight * 0.9;
          else w = weight * 0.7;
        } else if (actionType === 'CALL') {
          if (percentile < 0.20) w = weight * 0.3;
          else if (percentile < 0.80) w = weight * 1.0;
          else w = weight * 0.0;
        }
        updated.set(combo, Math.max(0.0, Math.min(1.0, w)));
      }
      return updated;
    },

    getPossibleHoleCardsWeighted(rangeCategory, action = 'open', deadCards = []) {
      const out = [];
      for (const [comboStr, weight] of this.getRangeByCategory(rangeCategory, action)) {
        if (weight <= 0.0) continue;
        for (const combo of this.parseCombo(comboStr)) {
          if (!combo.some((c) => deadCards.includes(c))) out.push([combo, weight]);
        }
      }
      return out;
    },
  };

  if (typeof module !== 'undefined') {
    const fs = require('fs');
    const path = require('path');
    require('./hand_eval.js');
    require('./messages.js');
    Ranges._init(fs.readFileSync(path.join(__dirname, 'ranges.json'), 'utf8'));
    module.exports = Ranges;
  }
  root.Ranges = Ranges;
})(typeof window !== 'undefined' ? window : globalThis);
