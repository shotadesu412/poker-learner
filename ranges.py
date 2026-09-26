"""
ranges.py
Defines basic preflop hand ranges for Hero and CPU.
These are updated simplified default ranges based on 6-max 100bb beginner strategy.
"""

import json
import os

from i18n import t

def generate_all_hands_dict():
    ranks = "AKQJT98765432"
    hands = {}
    for i in range(len(ranks)):
        for j in range(i, len(ranks)):
            r1, r2 = ranks[i], ranks[j]
            if r1 == r2:
                hands[r1 + r2] = 1.0
            else:
                hands[r1 + r2 + "s"] = 1.0
                hands[r1 + r2 + "o"] = 1.0
    return hands

ALL_HANDS_DICT = generate_all_hands_dict()

# --- レンジデータ ---
# データ本体は static/poker/ranges.json（JS 版 static/poker/ranges.js と共有）。
# レンジを変えるときは JSON を編集し、% を重み換算コンボ数/1326 で検算すること。
# 経緯や注意点は JSON 内の "_notes" に残してある。

_RANGES_JSON = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static", "poker", "ranges.json")


def _load_ranges_json(path=_RANGES_JSON):
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    # "position_ranges.LJ" のような文字列は参照。同じ dict オブジェクトに解決する
    for acts in data["ranges"].values():
        for act, v in acts.items():
            if isinstance(v, str):
                table, key = v.split(".", 1)
                acts[act] = data[table][key]
    return data


_DATA = _load_ranges_json()

position_ranges = _DATA["position_ranges"]

# GTO_3BET_MATRIX: ポジション対ポジションの適正3-Bet頻度 (cpu_pos → opener_pos → 頻度)
# 出典: 100bb 6-Max GTOソルバーベースライン
GTO_3BET_MATRIX = _DATA["gto_3bet_matrix"]

threebet_ranges = _DATA["threebet_ranges"]


hand_categories = {
    "premium": ["AA", "KK", "QQ", "AKs", "AKo"],
    "strong": ["JJ", "TT", "99", "AQs", "AJs", "ATs", "AQo"],
    "medium": ["88", "77", "66", "55", "KQs", "KJs", "KTs", "QJs", "QTs", "JTs", "AJo", "ATo", "KQo", "KJo"],
    "speculative": ["44", "33", "22", "A9s", "A8s", "A7s", "A6s", "A5s", "A4s", "A3s", "A2s", 
                    "K9s", "K8s", "K7s", "K6s", "K5s", "K4s", "K3s", "K2s",
                    "Q9s", "Q8s", "Q7s", "Q6s", "Q5s", "J9s", "J8s", "J7s",
                    "T9s", "T8s", "T7s", "98s", "97s", "87s", "86s", "76s", "75s", "65s", "64s", "54s"],
    "weak": []
}

def classify_range(weight):
    if weight >= 1.0:
        return "CORE"
    elif weight > 0.0:
        return "MIXED"
    else:
        return "FOLD"

def get_preflop_feedback(classification):
    if classification == "CORE":
        return t("hand.range.standard")
    elif classification == "MIXED":
        return t("hand.range.borderline")
    else:
        return t("hand.range.out")

def get_hand_reason(combo_str):
    if combo_str in ["A5s", "A4s", "A3s", "A2s", "K5s", "K4s"]:
        return t("hand.suited_ace_king")
    elif combo_str in ["KJo", "KTo", "QJo", "QTo", "JTo"]:
        return t("hand.trap_offsuit")
    elif combo_str in ["AJo", "ATo"]:
        return t("hand.marginal_broadway")
    elif combo_str in ["K9s", "QTs", "Q9s", "J8s"]:
        return t("hand.kicker_risk")
    elif combo_str in ["AA", "KK", "QQ"]:
        return t("hand.premium")
    elif combo_str in ["AKs", "AKo"]:
        return t("hand.ak")
    elif combo_str in ["76s", "65s", "54s", "87s", "98s"]:
        return t("hand.suited_connector")
    elif len(combo_str) == 2 and combo_str[0] == combo_str[1]: # Pocket pairs
        return t("hand.pocket_pair")
    return t("hand.standard")

# RANGES: ポジション × 状況 → レンジ（参照は _load_ranges_json で解決済み）
RANGES = _DATA["ranges"]

class HandRange:
    """
    Encapsulates range structure, weighting, combo expansion, and updating rules.
    """
    def __init__(self, combos_dict=None):
        if combos_dict is None:
            self.combos = ALL_HANDS_DICT.copy()
        else:
            self.combos = combos_dict.copy()
            
    def get_raw_dict(self):
        return self.combos

def get_range_by_category(category, action="open"):
    """
    Returns the weighted dictionary for a position and action state.

    ▼ 修正: 空レンジのフォールバックを追加。
    - UTGのopenはデータキーが"LJ"のため空になっていた → LJへエイリアス。
    - SBのvs_open_callは意図的に空(3bet-or-fold戦略)だが、エンジンは
      これを「継続レンジ」として使うため、空だとMCが計算不能になり
      勝率50%フォールバックに落ちていた → 継続レンジ = call ∪ 3bet で構成。
    """
    pos_data = RANGES.get(category, {})
    result = pos_data.get(action, None)

    # UTG open → LJデータへのエイリアス
    if (result is None or not result) and action == "open" and category == "UTG":
        result = RANGES.get("LJ", {}).get("open", {})

    # 継続レンジが空: コールレンジ + 3betレンジを合成（3bet-or-foldポジション対応）
    if (result is None or not result) and action == "vs_open_call":
        merged = dict(pos_data.get("vs_open_call", {}) or {})
        for combo, w in (pos_data.get("vs_open_3bet", {}) or {}).items():
            merged[combo] = max(merged.get(combo, 0.0), w)
        if merged:
            result = merged

    if result is None or not result:
        return ALL_HANDS_DICT
    return result

def parse_combo(combo_str):
    ranks = '23456789TJQKA'
    suits = 'shdc'
    
    if len(combo_str) == 2:
        rank = combo_str[0]
        combos = []
        for i in range(len(suits)):
            for j in range(i+1, len(suits)):
                combos.append([rank+suits[i], rank+suits[j]])
        return combos
    
    elif len(combo_str) == 3:
        rank1, rank2, stype = combo_str[0], combo_str[1], combo_str[2]
        combos = []
        if stype == 's':
            for s in suits:
                combos.append([rank1+s, rank2+s])
        elif stype == 'o':
            for s1 in suits:
                for s2 in suits:
                    if s1 != s2:
                        combos.append([rank1+s1, rank2+s2])
        return combos
        
    elif len(combo_str) == 4:
        # e.g. "AhKh"
        return [[combo_str[0:2], combo_str[2:4]]]
    
    return []

def get_possible_hole_cards_weighted(range_category, action="open", dead_cards=None):
    if dead_cards is None:
        dead_cards = []
        
    hands_dict = get_range_by_category(range_category, action)
    all_valid_combos_weighted = []
    
    for combo_str, weight in hands_dict.items():
        if weight <= 0.0:
            continue
            
        specific_combos = parse_combo(combo_str)
        for combo in specific_combos:
            if not any(c in dead_cards for c in combo):
                all_valid_combos_weighted.append((combo, weight))
                
    return all_valid_combos_weighted

from treys import Card

def sort_range_by_strength(range_dict, board=None, treys_evaluator=None):
    def preflop_strength(combo_str):
        if not combo_str:
            return (0, 0, 0)
        rank_map = {'A':14, 'K':13, 'Q':12, 'J':11, 'T':10, '9':9, '8':8, '7':7, '6':6, '5':5, '4':4, '3':3, '2':2}
        r1 = rank_map.get(combo_str[0], 0)
        r2 = rank_map.get(combo_str[1], 0) if len(combo_str) > 1 else 0
        if r2 > r1:
            r1, r2 = r2, r1
        if len(combo_str) >= 2 and combo_str[0] == combo_str[1]:
            return (3, r1, r2)
        elif len(combo_str) >= 3 and combo_str[2] == 's':
            return (2, r1, r2)
        else:
            return (1, r1, r2)
            
    if board is None or treys_evaluator is None or len(board) == 0:
        return sorted(range_dict.keys(), key=preflop_strength, reverse=True)
    else:
        dead_cards_str = [Card.int_to_str(c) for c in board]
        
        def postflop_strength(combo_str):
            combos = parse_combo(combo_str)
            best_score = 9999
            for c_str_list in combos:
                if not any(c in dead_cards_str for c in c_str_list):
                    c_ints = [Card.new(c) for c in c_str_list]
                    try:
                        score = treys_evaluator.evaluate(board, c_ints)
                    except TypeError as e:
                        import json
                        dump = {
                            "board": board,
                            "board_types": [str(type(x)) for x in board] if board else None,
                            "c_ints": c_ints,
                            "c_ints_types": [str(type(x)) for x in c_ints]
                        }
                        with open("error_dump.json", "w") as f:
                            json.dump(dump, f, indent=2)
                        raise e
                    if score < best_score:
                        best_score = score
            return best_score
            
        return sorted(range_dict.keys(), key=postflop_strength, reverse=False)

def update_range_after_action(range_dict, action_type, bet_size=None, board=None, treys_evaluator=None):
    if not range_dict:
        return {}
        
    updated_range = {}
    
    if action_type == "FOLD":
        for k in range_dict:
            updated_range[k] = 0.0
        return updated_range
        
    sorted_combos = sort_range_by_strength(range_dict, board, treys_evaluator)
    total_combos = len(sorted_combos)
    
    if total_combos == 0:
        return updated_range
        
    for i, combo in enumerate(sorted_combos):
        percentile = i / total_combos
        
        weight = range_dict[combo]
        if weight <= 0.0:
            updated_range[combo] = 0.0
            continue
            
        new_weight = weight
        # ▼ 2026/9/26 修正: SMALL_BET と LARGE_BET でブラフ帯の扱いが逆転していた。
        #   旧: SMALL_BET は下位20%を ×0.1 で潰し、LARGE_BET は下位30%を ×0.8 で残す
        #   → 「小さいベットほど相手が強い」という理論と逆の結果になり、
        #     小さいCベット（最頻出）に対してヒーローのエクイティが不当に低く出て、
        #     理論上正しいコールが厳しく採点されていた。
        #
        #   正しい考え方:
        #     小さいベット = レンジベット。高頻度でレンジ全体を打つのでほぼ絞られない
        #     大きいベット = ポラライズ。強いハンドとブラフが残り、中間が抜ける
        if action_type == "LARGE_BET":
            # ポラライズ（この配分は元から概ね正しいので据え置き）
            if percentile < 0.30:
                new_weight = weight * 1.0 # 上位30% バリュー
            elif percentile < 0.70:
                new_weight = weight * 0.2 # 中位40% 降りる/チェックに回る
            else:
                new_weight = weight * 0.8 # 下位30% ブラフ
        elif action_type == "SMALL_BET":
            # レンジベット: 元のレンジをほぼ保ち、わずかにバリュー寄りにするだけ
            if percentile < 0.50:
                new_weight = weight * 1.0 # 上位50%
            elif percentile < 0.80:
                new_weight = weight * 0.9 # 中位30%
            else:
                new_weight = weight * 0.7 # 下位20% 安いブラフとして打つので残す
        elif action_type == "CALL":
            if percentile < 0.20:
                new_weight = weight * 0.3 # Top 20% reduced
            elif percentile < 0.80:
                new_weight = weight * 1.0 # Middle 60%
            else:
                new_weight = weight * 0.0 # Bottom 20% folds
                
        updated_range[combo] = max(0.0, min(1.0, float(new_weight)))
        
    return updated_range
