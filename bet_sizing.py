# bet_sizing.py

# GTO Theory Constraints
PREFLOP_OPENS = {
    "UTG": 2.5,
    "HJ": 2.5,
    "CO": 2.3,
    "BTN": 2.2,
    "SB": 2.5,
    "BB": 0.0 # BB does not strictly open
}

PREFLOP_3BET = {
    "IP": 2.8,
    "OOP": 3.5
}

# Updated GTO Bet Sizing
BET_SIZES = {
    "FLOP": {"small": 0.33, "medium": 0.50, "large": 0.75}, # Pot fraction (Requested GTO mainstream sizing)
    "TURN": {"small": 0.33, "medium": 0.66, "large": 1.00},
    "RIVER": {"small": 0.50, "medium": 1.00, "large": 1.50}  # 1.5 = Overbet
}

RAISE_MULTIPLIER = { # Generalized Fallback postflop multi
    "FLOP": {"small": 2.5, "medium": 3.0, "large": 3.5},
    "TURN": {"small": 2.5, "medium": 3.0, "large": 3.5},
    "RIVER": {"small": 2.5, "medium": 3.0, "large": 5.0} # or all-in
}

# ▼ 修正: ドライとウェットの乗数を理論に基づき反転した
# ドライボード: フォールドEQの非弾力性を活かし、安くワイドにベット (25-35%)
# ウェットボード: 相手のドローに利益的オッズを与えないため大きくベット (55-80%)
TEXTURE_MULTIPLIER = {
    "dry": 0.75,      # ドライ → 小さく頻度高くベット
    "semi_wet": 1.0,
    "wet": 1.25,      # ウェット → 大きくエクイティ否定
    "paired": 1.1
}

# ▼ 修正: IPとOOPの乗数を理論に基づき修正した
# IP（後手有利）: 小さくワイドにCBetできる
# OOP（先手不利）: ポラライズしたサイズで情報面での不利を補完する
POSITION_MULTIPLIER = {
    "IP": 0.90,
    "OOP": 1.10
}

# Updated SPR Categories
SPR_MULTIPLIER = {
    "ultra_low": 0.7, # SPR < 1
    "low": 0.85,      # 1 <= SPR < 3
    "mid": 1.0,       # 3 <= SPR <= 6
    "high": 1.15      # SPR > 6
}

# --- Evaluation Indicators ---
EVAL_OPTIMAL = "◎"
EVAL_GOOD = "◯"
EVAL_MARGINAL = "△"
EVAL_BAD = "×"


def evaluate_bet_sizing(pot: float, bet_amount: float, board_texture: str) -> dict:
    """
    ユーザーが選択したベットサイズに対し、GTO理論に基づいた
    ボードテクスチャ別フィードバックを返す。

    ウェットボードで小さく打つ → フリーカードを与える最悪手
    ドライボードで大きく打つ  → 弱いハンドを逃し強いハンドにのみ呼ばれる
    """
    if pot <= 0:
        return {"evaluation": EVAL_MARGINAL, "reason": "ポットサイズが不明のため評価できません。"}

    fraction = bet_amount / pot

    if board_texture == "wet" and fraction < 0.40:
        return {
            "evaluation": EVAL_BAD,
            "reason": (
                f"ウェットボードに対してベットサイズ({fraction*100:.0f}%ポット)が小さすぎます。"
                "相手のストレートやフラッシュドローに利益的なポットオッズ（フリーカード）を"
                "提供してしまっています。55〜80%以上のサイズでエクイティを否定してください。"
            )
        }
    elif board_texture == "dry" and fraction > 0.70:
        return {
            "evaluation": EVAL_MARGINAL,
            "reason": (
                f"ドライボードに対してベットサイズ({fraction*100:.0f}%ポット)が大きすぎます。"
                "このボードでは相手は役がなければサイズに関わらず降ります。"
                "大きく打つことで弱いハンドを逃し、強いハンドにのみコールされるリスクが高まります。"
                "25〜35%の少額ベットでレンジ全体の頻度を高めましょう。"
            )
        }

    return {
        "evaluation": EVAL_GOOD,
        "reason": "ボードテクスチャの特性に概ね合致したベットサイジングです。"
    }
