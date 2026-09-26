// プリフロップレンジ（ranges.py の JS 移植）。データは ranges.json を Python と共有する。
//
// ⚠️ レンジは Object ではなく Map（combo → 重み）で持つ。
//   JS の Object は "22"〜"99" のような整数っぽいキーを先頭に並べ替えてしまい、
//   Python（dict はファイル順）と反復順が変わる。update_range_after_action は
//   同点コンボの順位を反復順で決めるので、順序がずれると結果が変わる。
//
// 読み込み: ブラウザは await Ranges.load()（fetch）、Node は require した時点で読み込み済み。

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
    Ranges._init(fs.readFileSync(path.join(__dirname, 'ranges.json'), 'utf8'));
    module.exports = Ranges;
  }
  root.Ranges = Ranges;
})(typeof window !== 'undefined' ? window : globalThis);
