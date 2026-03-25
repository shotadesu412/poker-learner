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
    SPR（スタック対ポット比）に応じてベットサイズの推奨値を補正する係数を返す。

    3-Betポット（SPR 2〜4）: スタックが既に小さいため、小さなベットでリバーまでに
    スタック全体を入れ切ることができる。大きなベットは過剰コミットを招く。

    SPR < 2   : 全スタックのコミットを先頭から考慮。小さいベットが最適。
    SPR 2〜4  : 3-Betポット相当。25〜50%ポットで十分コミットを作れる。
    SPR 4〜8  : シングルレイズポット標準。通常サイズ。
    SPR > 8   : ディープスタック。ブロックベットや大きなサイズを活用できる。
    """
    if spr < 2.0:
        return 0.50   # 超低SPR: 非常に小さく打つ
    elif spr < 4.0:
        return 0.65   # 3Betポット相当: 通常の65%サイズに縮小
    elif spr < 8.0:
        return 1.00   # 標準SPR: そのまま
    else:
        return 1.10   # ディープ: やや大きめも許容


def evaluate_bet_sizing(pot: float, bet_amount: float, board_texture: str, spr: float = None) -> dict:
    """
    ユーザーが選択したベットサイズに対し、GTO理論に基づいた
    ボードテクスチャ別フィードバックを返す。

    テクスチャ別推奨サイジング（レポートのヒューリスティクス表に準拠）:
    ドライ・静的 (A83r等)   : 25〜33%ポット（高頻度・小サイズ）
    ペアボード (KK5等)      : 25〜33%ポット（高頻度・小サイズ）
    セミウェット (KJ4等)    : 33〜55%ポット（中頻度・中サイズ）
    ウェット・動的 (986o等) : 55〜80%ポット（中〜低頻度・大サイズ）
    モノトーン (Qc7c2c等)  : 20〜33%ポット（低頻度・小サイズ）
    """
    if pot <= 0:
        return {"evaluation": EVAL_MARGINAL, "reason": "ポットサイズが不明のため評価できません。"}

    fraction = bet_amount / pot

    # SPR補正をfractionに適用（3Betポットでは大きいベットを緩和）
    adjusted_threshold_multiplier = 1.0
    if spr is not None:
        adjusted_threshold_multiplier = 1.0 / get_spr_size_adjustment(spr)

    # --- モノトーンボード (Qc7c2c等) ---
    if board_texture == "monotone":
        if fraction > 0.45 * adjusted_threshold_multiplier:
            return {
                "evaluation": EVAL_MARGINAL,
                "reason": (
                    f"モノトーンボードに対してベットサイズ({fraction*100:.0f}%ポット)が大きすぎます。"
                    "同スート3枚のボードでは自分のレンジにフラッシュが少なく、相手のフラッシュを恐れて"
                    "チェック頻度を高める必要があります。ベットする場合は20〜33%の小額でブロックベットが最適です。"
                )
            }
        return {
            "evaluation": EVAL_GOOD,
            "reason": (
                f"モノトーンボードへの小額ベット({fraction*100:.0f}%ポット)は適切なブロックベットです。"
                "フラッシュを持っているかのようにフォールドエクイティを得つつ、"
                "コールされた場合の損失を最小化できます。"
            )
        }

    # --- ペアボード (KK5, 884等) ---
    elif board_texture == "paired":
        if fraction > 0.55 * adjusted_threshold_multiplier:
            return {
                "evaluation": EVAL_MARGINAL,
                "reason": (
                    f"ペアボードに対してベットサイズ({fraction*100:.0f}%ポット)が大きすぎます。"
                    "このボードはどちらのレンジにもトリップスが含まれにくいため、"
                    "大きなベットは強すぎるハンドを主張しすぎてコールされにくくなります。"
                    "25〜33%の小額で高頻度にベットするのがGTOの基本です。"
                )
            }
        return {
            "evaluation": EVAL_GOOD,
            "reason": (
                f"ペアボードへのベット({fraction*100:.0f}%ポット)は適切なサイズです。"
                "このボードは静的で役の変化が少ないため、小さく頻度を高めてバリューを取りましょう。"
            )
        }

    # --- ウェット・ダイナミックボード (986o, KQTo等) ---
    elif board_texture == "wet":
        if fraction < 0.40 * adjusted_threshold_multiplier:
            return {
                "evaluation": EVAL_BAD,
                "reason": (
                    f"ウェットボードに対してベットサイズ({fraction*100:.0f}%ポット)が小さすぎます。"
                    "ストレート/フラッシュドロー両方が絡むダイナミックなボードでは、"
                    "相手のドローに利益的なポットオッズを与えないために55〜80%以上のサイズが必要です。"
                    "小額ベットはフリーカードを与え、自分のバリューハンドを弱めます。"
                )
            }
        if fraction > 1.10 * adjusted_threshold_multiplier:
            return {
                "evaluation": EVAL_MARGINAL,
                "reason": (
                    f"ウェットボードへのオーバーベット({fraction*100:.0f}%ポット)はリスクが高いです。"
                    "ドローが豊富なボードでナッツ優位がない場合、過大なベットはコールされたときの"
                    "損失が大きくなります。55〜80%を推奨します。"
                )
            }
        return {
            "evaluation": EVAL_GOOD,
            "reason": (
                f"ウェットボードへのベット({fraction*100:.0f}%ポット)は適切です。"
                "ドローのエクイティ実現を阻止しつつ、バリューを得ることができます。"
            )
        }

    # --- セミウェットボード ---
    elif board_texture == "semi_wet":
        if fraction < 0.25 * adjusted_threshold_multiplier:
            return {
                "evaluation": EVAL_MARGINAL,
                "reason": (
                    f"セミウェットボードに対してベットサイズ({fraction*100:.0f}%ポット)は少し小さめです。"
                    "ある程度のドロー可能性があるため、33〜55%程度が推奨されます。"
                )
            }
        return {
            "evaluation": EVAL_GOOD,
            "reason": f"セミウェットボードへのベット({fraction*100:.0f}%ポット)は概ね適切なサイジングです。"
        }

    # --- ドライ・静的ボード (A83r, K72r等) ---
    else:  # dry
        if fraction > 0.70 * adjusted_threshold_multiplier:
            return {
                "evaluation": EVAL_MARGINAL,
                "reason": (
                    f"ドライボードに対してベットサイズ({fraction*100:.0f}%ポット)が大きすぎます。"
                    "このボードでは相手は役がなければサイズに関わらず降ります（フォールドEQの非弾力性）。"
                    "大きく打つことで弱いハンドを逃し、強いハンドにのみコールされるリスクが高まります。"
                    "25〜33%の少額ベットでレンジ全体の頻度を高め、ブラフ比率も維持しましょう。"
                )
            }
        return {
            "evaluation": EVAL_GOOD,
            "reason": (
                f"ドライボードへのベット({fraction*100:.0f}%ポット)は適切です。"
                "ドライボードでは小さく高頻度にベットすることで、"
                "相手のレンジ全体から少しずつエクイティを奪えます。"
            )
        }

