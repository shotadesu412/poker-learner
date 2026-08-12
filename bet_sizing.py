# bet_sizing.py

from i18n import t

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
    "RIVER": {"small": 0.50, "medium": 0.75, "large": 1.00}  # River: standard GTO sizing (no overbet default)
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

# ブラフ頻度専用テクスチャ乗数（TEXTURE_MULTIPLIERとは用途が異なる）
# ドライ: 相手のエクイティが低くフォール드率が高い → 純ブラフが通りやすい
# ウェット: 相手がドローを多く持ちコールしやすい → 純ブラフは危険。セミブラフで補う
BLUFF_FREQ_TEXTURE_MULTIPLIER = {
    "dry": 1.20,
    "semi_wet": 1.00,
    "wet": 0.75,
    "paired": 1.10,
    "monotone": 0.80,  # モノトーンはフラッシュドロー多数→コールされやすい
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


def get_spr_size_adjustment(spr: float) -> float:
    """
    SPRによる過度なベットサイズ抑制を廃止し、より柔軟なサイズを許容する。
    """
    if spr < 2.0:
        return 1.00   # 超低SPRでもサイズの硬直的抑制を解除
    elif spr < 4.0:
        return 1.00   # 3Betポット相当でも抑制を解除
    elif spr < 8.0:
        return 1.00   # 標準SPR: そのまま
    else:
        return 1.10   # ディープ: やや大きめも許容


def evaluate_bet_sizing(pot: float, bet_amount: float, board_texture: str, spr: float = None) -> dict:
    """
    ユーザーが選択したベットサイズに対し、GTO理論に基づいた
    ボードテクスチャ別フィードバックを返す。
    ※ 閾値を大幅に緩和し、ポラライズされた大きなベットも許容する。
    """
    if pot <= 0:
        return {"evaluation": EVAL_MARGINAL, "reason": t("sizing.no_pot")}

    fraction = bet_amount / pot

    # SPR補正をfractionに適用（3Betポットでは大きいベットを緩和）
    adjusted_threshold_multiplier = 1.0
    if spr is not None:
        adjusted_threshold_multiplier = 1.0 / get_spr_size_adjustment(spr)

    # --- モノトーンボード (Qc7c2c等) ---
    if board_texture == "monotone":
        if fraction > 0.75 * adjusted_threshold_multiplier:
            return {
                "evaluation": EVAL_MARGINAL,
                "reason": t("sizing.monotone.too_big", pct=fraction * 100)
            }
        return {
            "evaluation": EVAL_GOOD,
            "reason": t("sizing.monotone.good", pct=fraction * 100)
        }

    # --- ペアボード (KK5, 884等) ---
    elif board_texture == "paired":
        if fraction > 1.00 * adjusted_threshold_multiplier:
            return {
                "evaluation": EVAL_MARGINAL,
                "reason": t("sizing.paired.too_big", pct=fraction * 100)
            }
        return {
            "evaluation": EVAL_GOOD,
            "reason": t("sizing.paired.good", pct=fraction * 100)
        }

    # --- ウェット・ダイナミックボード (986o, KQTo等) ---
    elif board_texture == "wet":
        if fraction < 0.40 * adjusted_threshold_multiplier:
            return {
                "evaluation": EVAL_BAD,
                "reason": t("sizing.wet.too_small", pct=fraction * 100)
            }
        if fraction > 1.10 * adjusted_threshold_multiplier:
            return {
                "evaluation": EVAL_MARGINAL,
                "reason": t("sizing.wet.too_big", pct=fraction * 100)
            }
        return {
            "evaluation": EVAL_GOOD,
            "reason": t("sizing.wet.good", pct=fraction * 100)
        }

    # --- セミウェットボード ---
    elif board_texture == "semi_wet":
        if fraction < 0.25 * adjusted_threshold_multiplier:
            return {
                "evaluation": EVAL_MARGINAL,
                "reason": t("sizing.semiwet.small", pct=fraction * 100)
            }
        return {
            "evaluation": EVAL_GOOD,
            "reason": t("sizing.semiwet.good", pct=fraction * 100)
        }

    # --- ドライ・静的ボード (A83r, K72r等) ---
    else:  # dry
        if fraction > 1.20 * adjusted_threshold_multiplier:
            return {
                "evaluation": EVAL_MARGINAL,
                "reason": t("sizing.dry.too_big", pct=fraction * 100)
            }
        return {
            "evaluation": EVAL_GOOD,
            "reason": t("sizing.dry.good", pct=fraction * 100)
        }

