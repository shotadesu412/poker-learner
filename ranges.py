"""
ranges.py
Defines basic preflop hand ranges for Hero and CPU.
These are updated simplified default ranges based on 6-max 100bb beginner strategy.
"""

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

# --- NEW EDUCATIONAL RANGES & FEEDBACK ---

position_ranges = {
    # LJ (UTG in 6-Max): RFI 17.6% — タイトなリニアレンジのみ
    "LJ": {
        "AA": 1, "KK": 1, "QQ": 1, "JJ": 1, "TT": 1, "99": 1, "88": 1,
        "AKs": 1, "AQs": 1, "AJs": 1, "ATs": 1,
        "KQs": 1, "KJs": 1,
        "AKo": 1, "AQo": 1,
    },
    # HJ (MP in 6-Max): RFI 21.4% — 上位ハンドを少し追加
    "HJ": {
        "AA": 1, "KK": 1, "QQ": 1, "JJ": 1, "TT": 1, "99": 1, "88": 1, "77": 1,
        "AKs": 1, "AQs": 1, "AJs": 1, "ATs": 1, "A5s": 0.5, "A4s": 0.5,
        "KQs": 1, "KJs": 1, "QJs": 0.5,
        "AKo": 1, "AQo": 1, "AJo": 0.5,
    },
    # CO: RFI 27.8% — ポジション優位を活かして拡大
    "CO": {
        "AA": 1, "KK": 1, "QQ": 1, "JJ": 1, "TT": 1, "99": 1, "88": 1, "77": 1,
        "66": 1, "55": 0.5,
        "AKs": 1, "AQs": 1, "AJs": 1, "ATs": 1, "A9s": 0.5,
        "A5s": 1, "A4s": 1, "A3s": 0.5, "A2s": 0.5,
        "KQs": 1, "KJs": 1, "KTs": 1, "QJs": 1, "QTs": 0.5,
        "JTs": 1, "T9s": 0.5, "98s": 0.5,
        "AKo": 1, "AQo": 1, "AJo": 1, "ATo": 0.5,
        "KQo": 1, "KJo": 0.5, "QJo": 0.5,
    },
    # BTN: RFI 43.5% — ポジション最有利、レンジ最大
    "BTN": {
        "AA": 1, "KK": 1, "QQ": 1, "JJ": 1, "TT": 1, "99": 1, "88": 1, "77": 1,
        "66": 1, "55": 1, "44": 1, "33": 0.5, "22": 0.5,
        "AKs": 1, "AQs": 1, "AJs": 1, "ATs": 1, "A9s": 1, "A8s": 1, "A7s": 0.5,
        "A6s": 0.5, "A5s": 1, "A4s": 1, "A3s": 1, "A2s": 1,
        "KQs": 1, "KJs": 1, "KTs": 1, "K9s": 1, "K8s": 0.5, "K7s": 0.5,
        "QJs": 1, "QTs": 1, "Q9s": 1, "Q8s": 0.5,
        "JTs": 1, "J9s": 1, "J8s": 0.5,
        "T9s": 1, "T8s": 1, "98s": 1, "87s": 1, "76s": 1, "65s": 0.5,
        "AKo": 1, "AQo": 1, "AJo": 1, "ATo": 1, "A9o": 1, "A8o": 0.5,
        "KQo": 1, "KJo": 1, "KTo": 1, "K9o": 0.5,
        "QJo": 1, "QTo": 1, "Q9o": 0.5,
        "JTo": 1, "J9o": 0.5,
        "T9o": 0.5,
    },
    # SB: RFI 62.3% (BvB構造 — スクイーズ回避のため3bet-or-fold傾向)
    "SB": {
        "AA": 1, "KK": 1, "QQ": 1, "JJ": 1, "TT": 1, "99": 1, "88": 1, "77": 1,
        "66": 1, "55": 1, "44": 1, "33": 1, "22": 0.5,
        "AKs": 1, "AQs": 1, "AJs": 1, "ATs": 1, "A9s": 1, "A8s": 1, "A7s": 1,
        "A6s": 1, "A5s": 1, "A4s": 1, "A3s": 1, "A2s": 1,
        "KQs": 1, "KJs": 1, "KTs": 1, "K9s": 1, "K8s": 1, "K7s": 0.5,
        "QJs": 1, "QTs": 1, "Q9s": 1, "Q8s": 0.5,
        "JTs": 1, "J9s": 1, "J8s": 0.5,
        "T9s": 1, "T8s": 1, "98s": 1, "87s": 1, "76s": 1, "65s": 1,
        "AKo": 1, "AQo": 1, "AJo": 1, "ATo": 1, "A9o": 1, "A8o": 1, "A7o": 0.5,
        "KQo": 1, "KJo": 1, "KTo": 1, "K9o": 0.5,
        "QJo": 1, "QTo": 1, "Q9o": 0.5,
        "JTo": 1, "J9o": 0.5,
        "T9o": 0.5, "98o": 0.5,
    }
}

# ============================================================
# GTO_3BET_MATRIX: ポジション対ポジションの適正3-Bet頻度
# cpu_pos → opener_pos → 頻度(0.0〜1.0)
# 出典: 100bb 6-Max GTOソルバーベースライン
# ============================================================
GTO_3BET_MATRIX = {
    # HJ vs LJ open
    "HJ": {"LJ": 0.079, "UTG": 0.079},
    # CO vs open
    "CO": {"LJ": 0.083, "UTG": 0.083, "HJ": 0.095},
    # BTN vs open
    "BTN": {"LJ": 0.083, "UTG": 0.083, "HJ": 0.095, "CO": 0.128},
    # SB vs open (3-bet or fold が基本戦略)
    "SB": {"LJ": 0.074, "UTG": 0.074, "HJ": 0.092, "CO": 0.115, "BTN": 0.151},
    # BB vs open (コーリングレンジが広いのでポラライズ3-bet)
    "BB": {"LJ": 0.056, "UTG": 0.056, "HJ": 0.072, "CO": 0.091, "BTN": 0.139, "SB": 0.174},
}

threebet_ranges = {
    # --- BTNからのオープンに対する各ポジションの3-Betレンジ ---
    # SB vs BTN open: リニアレンジ (3-bet or fold)
    "SB_vs_BTN": {
        "AA": 1, "KK": 1, "QQ": 1, "JJ": 1, "TT": 1, "99": 0.5,
        "AKs": 1, "AQs": 1, "AJs": 1, "ATs": 0.5,
        "KQs": 1, "KJs": 0.5,
        "AKo": 1, "AQo": 1, "AJo": 0.5,
        # ブラフ用ブロッカーハンド (低頻度)
        "A5s": 0.5, "A4s": 0.5, "A3s": 0.3,
        "K9s": 0.3, "QTs": 0.3,
    },
    # SB vs CO open
    "SB_vs_CO": {
        "AA": 1, "KK": 1, "QQ": 1, "JJ": 1, "TT": 0.5,
        "AKs": 1, "AQs": 1, "AJs": 0.5,
        "KQs": 1,
        "AKo": 1, "AQo": 0.5,
        "A5s": 0.5, "A4s": 0.3,
    },
    # BB vs BTN open: ポラライズレンジ (コーリングレンジが広い)
    "BB_vs_BTN": {
        # バリュー
        "AA": 1, "KK": 1, "QQ": 1, "JJ": 0.5,
        "AKs": 1, "AQs": 0.5, "AKo": 1,
        # ブロッカーブラフ (低頻度)
        "A5s": 0.4, "A4s": 0.4, "A3s": 0.3, "A2s": 0.2,
        "K9s": 0.3, "Q9s": 0.2,
        "T8s": 0.2, "76s": 0.2, "65s": 0.2,
    },
    # BB vs CO open
    "BB_vs_CO": {
        "AA": 1, "KK": 1, "QQ": 1, "JJ": 0.5,
        "AKs": 1, "AQs": 0.3, "AKo": 1,
        "A5s": 0.3, "A4s": 0.3,
        "K9s": 0.2, "T8s": 0.2,
    },
    # BB vs HJ open
    "BB_vs_HJ": {
        "AA": 1, "KK": 1, "QQ": 1, "JJ": 0.3,
        "AKs": 1, "AKo": 1,
        "A5s": 0.3, "A4s": 0.2,
    },
    # BB vs LJ open (最もタイト)
    "BB_vs_LJ": {
        "AA": 1, "KK": 1, "QQ": 1,
        "AKs": 1, "AKo": 1,
        "A5s": 0.2,
    },
    # CO vs BTN open
    "CO_vs_BTN": {
        "AA": 1, "KK": 1, "QQ": 1, "JJ": 0.5, "TT": 0.3,
        "AKs": 1, "AQs": 0.5, "AKo": 1,
        "A5s": 0.4, "A4s": 0.3,
        "KQs": 0.3, "T9s": 0.3,
    },
    # BTN vs CO open (一般的なIO IP 3-bet)
    "BTN_vs_CO": {
        "AA": 1, "KK": 1, "QQ": 1, "JJ": 0.5, "TT": 0.3,
        "AKs": 1, "AQs": 0.5, "AKo": 1, "AQo": 0.3,
        "A5s": 0.5, "A4s": 0.4, "A3s": 0.3,
        "KQs": 0.3, "KJs": 0.2,
        "T9s": 0.3, "98s": 0.3,
    },
}


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
        return "このポジションと状況における標準的な参加レンジです。"
    elif classification == "MIXED":
        return "プレイするかどうか状況次第の境界線のハンドです。頻度でアクションを混ぜることが多いです。"
    else:
        return "このポジションでは参加しにくいハンドです。フォールドが無難な選択です。"

def get_hand_reason(combo_str):
    if combo_str in ["A5s", "A4s", "A3s", "A2s", "K5s", "K4s"]:
        return "スーテッドエースやスーテッドキングで、プレイアビリティとブロッカー効果があります。"
    elif combo_str in ["KJo", "KTo", "QJo", "QTo", "JTo"]:
        return "ドミネートされやすい危険なトラップハンドです。"
    elif combo_str in ["AJo", "ATo"]:
        return "強いレンジに支配されやすく、弱いレンジには強いマージナルなハンドです。"
    elif combo_str in ["K9s", "QTs", "Q9s", "J8s"]:
        return "プレイアビリティは高いものの、トップペア時のキッカー負けリスクがあります。"
    elif combo_str in ["AA", "KK", "QQ"]:
        return "最強クラスのプレミアムハンドです。自信を持ってアグレッシブにプレイしましょう。"
    elif combo_str in ["AKs", "AKo"]:
        return "非常に強力なプレミアムハンドで、3BETや4BETにも適しています。"
    elif combo_str in ["76s", "65s", "54s", "87s", "98s"]:
        return "ストレートやフラッシュを作りやすい投機的なハンド（スーテッドコネクター）です。"
    elif len(combo_str) == 2 and combo_str[0] == combo_str[1]: # Pocket pairs
        return "セットマイン（スリーカード狙い）のポテンシャルを持つポケットペアです。"
    return "ポジションに応じた標準的なレンジ構成ハンドです。"

# Backward compatibility map for the engine's current structure
RANGES = {
    "UTG": {
        "open": position_ranges.get("UTG", {}),
        "vs_3bet_call": {"JJ": 1.0, "TT": 1.0, "99": 1.0, "88": 1.0, "AQs": 1.0, "AJs": 1.0, "KQs": 1.0, "AKo": 0.5},
        "vs_3bet_4bet": {"AA": 1.0, "KK": 1.0, "QQ": 1.0, "AKs": 1.0, "AKo": 0.5, "A5s": 0.5},
        "3bet": {"AA": 1.0, "KK": 1.0, "QQ": 1.0, "AKs": 1.0, "AQs": 0.5},
        "4bet_bluff": {"A5s": 1.0, "A4s": 1.0, "KQs": 0.5}
    },
    "LJ": {
        "open": position_ranges.get("LJ", position_ranges.get("UTG", {})),
        "vs_3bet_call": {"JJ": 1.0, "TT": 1.0, "99": 1.0, "88": 1.0, "AQs": 1.0, "AJs": 1.0, "KQs": 1.0, "AKo": 0.5},
        "vs_3bet_4bet": {"AA": 1.0, "KK": 1.0, "QQ": 1.0, "AKs": 1.0, "AKo": 0.5, "A5s": 0.5},
        "3bet": {"AA": 1.0, "KK": 1.0, "QQ": 1.0, "AKs": 1.0},
        "4bet_bluff": {"A5s": 1.0, "A4s": 1.0}
    },
    "HJ": {
        "open": position_ranges.get("HJ", {}),
        "vs_open_call": {"JJ": 0.5, "TT": 1.0, "99": 1.0, "88": 1.0, "77": 1.0, "AQs": 0.5, "AJs": 1.0, "ATs": 1.0, "KQs": 1.0, "QJs": 1.0, "JTs": 1.0, "AQo": 0.5, "AJo": 1.0, "KQo": 1.0},
        "vs_open_3bet": {"AA": 1.0, "KK": 1.0, "QQ": 1.0, "JJ": 0.5, "AKs": 1.0, "AQs": 0.5},
        "vs_3bet_call": {"JJ": 1.0, "TT": 1.0, "99": 1.0, "88": 1.0, "AQs": 1.0, "AJs": 1.0, "KQs": 1.0, "AKo": 0.5},
        "vs_3bet_4bet": {"AA": 1.0, "KK": 1.0, "QQ": 1.0, "AKs": 1.0, "AKo": 0.5, "A5s": 0.5},
        "3bet": {"AA": 1.0, "KK": 1.0, "QQ": 1.0, "JJ": 0.5, "AKs": 1.0, "AQs": 0.5, "A5s": 0.5, "A4s": 0.5, "AKo": 1.0, "AQo": 0.5},
        "4bet_bluff": {"A5s": 1.0, "A4s": 1.0, "A3s": 0.5}
    },
    "CO": {
        "open": position_ranges.get("CO", {}),
        "vs_open_call": {"JJ": 0.5, "TT": 1.0, "99": 1.0, "88": 1.0, "77": 1.0, "AQs": 0.5, "AJs": 1.0, "ATs": 1.0, "KQs": 1.0, "QJs": 1.0, "JTs": 1.0, "AQo": 0.5, "AJo": 1.0, "KQo": 1.0},
        "vs_open_3bet": threebet_ranges.get("BTN_vs_CO", {"AA": 1.0, "KK": 1.0, "QQ": 1.0, "JJ": 0.5, "AKs": 1.0, "AQs": 0.5, "A5s": 0.5, "A4s": 0.5, "AKo": 1.0, "AQo": 0.5}),
        "vs_3bet_call": {"JJ": 1.0, "TT": 1.0, "99": 1.0, "88": 1.0, "AQs": 1.0, "AJs": 1.0, "KQs": 1.0, "AKo": 0.5},
        "vs_3bet_4bet": {"AA": 1.0, "KK": 1.0, "QQ": 1.0, "AKs": 1.0, "AKo": 0.5, "A5s": 0.5},
        "3bet": {"AA": 1.0, "KK": 1.0, "QQ": 1.0, "JJ": 0.5, "AKs": 1.0, "AQs": 0.5, "A5s": 0.5, "A4s": 0.5, "AKo": 1.0, "AQo": 0.5},
        "4bet_bluff": {"A5s": 1.0, "A4s": 1.0, "K9s": 0.5, "Q9s": 0.5}
    },
    "BTN": {
        "open": position_ranges.get("BTN", {}),
        "vs_open_call": {"JJ": 0.5, "TT": 1.0, "99": 1.0, "88": 1.0, "77": 1.0, "AQs": 0.5, "AJs": 1.0, "ATs": 1.0, "KQs": 1.0, "QJs": 1.0, "JTs": 1.0, "AQo": 0.5, "AJo": 1.0, "KQo": 1.0},
        "vs_open_3bet": {"AA": 1.0, "KK": 1.0, "QQ": 1.0, "JJ": 0.5, "AKs": 1.0, "AQs": 0.5, "A5s": 0.5, "A4s": 0.5, "AKo": 1.0, "AQo": 0.5},
        "vs_3bet_call": {"JJ": 1.0, "TT": 1.0, "99": 1.0, "88": 1.0, "AQs": 1.0, "AJs": 1.0, "KQs": 1.0, "AKo": 0.5},
        "vs_3bet_4bet": {"AA": 1.0, "KK": 1.0, "QQ": 1.0, "AKs": 1.0, "AKo": 0.5, "A5s": 0.5},
        "3bet": {"AA": 1.0, "KK": 1.0, "QQ": 1.0, "JJ": 0.5, "AKs": 1.0, "AQs": 0.5, "A5s": 0.5, "A4s": 0.5, "AKo": 1.0, "AQo": 0.5},
        "4bet_bluff": {"A5s": 1.0, "A4s": 1.0, "A3s": 1.0, "A2s": 1.0}
    },
    "SB": {
        "open": position_ranges.get("SB", {}),
        "vs_open_call": {},  # SBはスクイーズリスクのため基本は3bet-or-fold
        "vs_open_3bet": threebet_ranges.get("SB_vs_BTN"),
        "vs_3bet_call": {"JJ": 1.0, "TT": 1.0, "99": 1.0, "AQs": 1.0, "AJs": 1.0, "KQs": 1.0, "AKo": 0.5},
        "vs_3bet_4bet": {"AA": 1.0, "KK": 1.0, "QQ": 1.0, "AKs": 1.0},
        "3bet": threebet_ranges.get("SB_vs_BTN"),
        "4bet_bluff": {"A5s": 1.0, "A4s": 1.0}
    },
    "BB": {
        "open": {},
        # BBのコーリングレンジ: 広いポラライズコールレンジ (ポジション上先手なので広くコールできる)
        "vs_open_call": {
            "22": 1.0, "33": 1.0, "44": 1.0, "55": 1.0, "66": 1.0, "77": 1.0, "88": 1.0, "99": 1.0,
            "TT": 1.0, "JJ": 1.0, "QQ": 1.0,
            "AJs": 1.0, "ATs": 1.0, "A9s": 1.0, "A8s": 1.0, "A7s": 0.5, "A6s": 0.5,
            "A5s": 0.5, "A4s": 0.5, "A3s": 0.5,
            "KQs": 1.0, "KJs": 1.0, "KTs": 1.0, "K9s": 1.0, "K8s": 0.5,
            "QJs": 1.0, "QTs": 1.0, "Q9s": 1.0,
            "JTs": 1.0, "J9s": 1.0, "J8s": 0.5,
            "T9s": 1.0, "T8s": 1.0, "98s": 1.0, "87s": 1.0, "76s": 1.0, "65s": 1.0, "54s": 0.5,
            "AQo": 1.0, "AJo": 1.0, "ATo": 1.0, "A9o": 0.5,
            "KQo": 1.0, "KJo": 1.0, "KTo": 0.5,
            "QJo": 1.0, "QTo": 0.5,
            "JTo": 1.0, "J9o": 0.5,
            "T9o": 0.5, "98o": 0.5,
        },
        # BBの3-betレンジ: ポラライズ（コーリングレンジに入らない強いバリューとブロッカーブラフのみ）
        "vs_open_3bet": threebet_ranges.get("BB_vs_BTN"),
        "vs_3bet_call": {"JJ": 1.0, "TT": 1.0, "99": 1.0, "88": 1.0, "AQs": 1.0, "AJs": 1.0, "KQs": 1.0, "AKo": 0.5},
        "vs_3bet_4bet": {"AA": 1.0, "KK": 1.0, "QQ": 1.0, "AKs": 1.0, "AKo": 0.5},
        "3bet": threebet_ranges.get("BB_vs_BTN"),
        "4bet_bluff": {"A5s": 1.0, "A4s": 1.0}
    }
}

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
    """
    pos_data = RANGES.get(category, {})
    
    # Handle BB specific logic (vs_ position)
    if category == "BB" and action.startswith("vs_"):
        return pos_data.get(action, ALL_HANDS_DICT)
        
    return pos_data.get(action, ALL_HANDS_DICT)

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
        if action_type == "LARGE_BET":
            if percentile < 0.30:
                new_weight = weight * 1.0 # Top 30% Strong
            elif percentile < 0.70:
                new_weight = weight * 0.2 # Middle 40% (Merge/Pot control)
            else:
                new_weight = weight * 0.8 # Bottom 30% Bluffs
        elif action_type == "SMALL_BET":
            if percentile < 0.50:
                new_weight = weight * 1.0 # Top 50%
            elif percentile < 0.80:
                new_weight = weight * 0.5 # Middle 30%
            else:
                new_weight = weight * 0.1 # Bottom 20%
        elif action_type == "CALL":
            if percentile < 0.20:
                new_weight = weight * 0.3 # Top 20% reduced
            elif percentile < 0.80:
                new_weight = weight * 1.0 # Middle 60%
            else:
                new_weight = weight * 0.0 # Bottom 20% folds
                
        updated_range[combo] = max(0.0, min(1.0, float(new_weight)))
        
    return updated_range
