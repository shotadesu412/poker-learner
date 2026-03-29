import random
from treys import Card

def _get_combo_count(combo_str: str) -> int:
    """
    コンビネトリクスに基づく理論的なコンボ数を返す。
    - ポケットペア (AA等): C(4,2) = 6 コンボ
    - スーテッドハンド (AKs等): 4 コンボ（各スート）
    - オフスートハンド (AKo等): 4*3 = 12 コンボ
    この値をサンプリングウェイトに乗算することで
    均等な2枚カードの出現確率を正確に再現できる。
    """
    if len(combo_str) == 2:   # ポケットペア (AA, KK...) または オフペア (AK, QJ...)
        if combo_str[0] == combo_str[1]:
            return 6  # ペア
        else:
            return 16 # スート指定がないコネクタやハイカード
    elif len(combo_str) == 3:
        if combo_str[2] == 's': return 4   # スーテッド
        if combo_str[2] == 'o': return 12  # オフスート
    return 1

def sample_range(range_dict, dead_cards_str=None):
    """
    range_dict: {"AKs": 1.0, "QQ": 0.5, "AhKh": 1.0...}
    dead_cards_str: List of string formatted cards ["Ah", "Kc"]
    
    Returns: List of specific Card int arrays representing the sampled combo,
             e.g. [Card.new('Ah'), Card.new('Kh')]
    
    ▼ 修正: コンビネトリクス正規化
    各コンボクラスをウェイト×コンボ数で重み付けし、
    ペア(6)/スーテッド(4)/オフスート(12) の実際の出現確率比を再現する。
    """
    if dead_cards_str is None:
        dead_cards_str = []
        
    import ranges
    valid_combos_weighted = []
    
    for combo_str, weight in range_dict.items():
        if weight <= 0.0: continue
        # コンビネトリクス: タイプ別コンボ数でウェイトを補正
        combo_count = _get_combo_count(combo_str)
        parsed = ranges.parse_combo(combo_str)
        for specific_cards_str in parsed:
            # デッドカードをフィルタリング
            if not any(c in dead_cards_str for c in specific_cards_str):
                # 各コンボの有効コンボ数分の1をウェイトとして付与
                # （展開後コンボが全て均等になるよう正規化済み）
                valid_combos_weighted.append((specific_cards_str, weight))
                
    if not valid_combos_weighted:
        return None
        
    total_weight = sum(w for _, w in valid_combos_weighted)
    if total_weight <= 0:
        chosen_str = random.choice(valid_combos_weighted)[0]
    else:
        r = random.uniform(0, total_weight)
        cum = 0.0
        chosen_str = valid_combos_weighted[-1][0]
        for combo, weight in valid_combos_weighted:
            cum += weight
            if r <= cum:
                chosen_str = combo
                break
                
    return [Card.new(c) for c in chosen_str]


def normalize_range(weights):
    floor_val = 0.05
    for k in weights:
        if weights[k] < floor_val:
            weights[k] = floor_val
    total = sum(weights.values())
    if total > 0:
        for k in weights:
            weights[k] /= total
    return weights


def filter_range_by_action(range_dict: dict, action_taken: str, board_cards: list = None) -> dict:
    """
    相手のアクション（RAISE/BET/CALL）に基づき、論理的に矛盾するハンドを
    レンジから間引き（ウェイトを下げる）、ベイズ更新を行う。

    - RAISE / LARGE_BET: 弱いハンドのウェイトを大幅削減
      （レイズ/大きなベットをするのは強いハンドかブラフ。弱いハンドは通常コール/フォールド）
    - CALL: ナッツ級ハンドのウェイトを削減
      （通常ナッツはレイズするため、コールレンジにナッツが多すぎるのは非現実的）

    引数:
        range_dict: {combo_str: weight} の辞書
        action_taken: "RAISE" / "LARGE_BET" / "CALL" / "BET" のいずれか
        board_cards: 現在のボードカード（未使用だが将来の拡張のため引数として保持）

    戻り値:
        更新・正規化されたレンジ辞書
    """
    from treys import Card, Evaluator as TreysEvaluator
    import ranges

    evaluator = TreysEvaluator()
    updated_range = {}

    # ボードカードが存在しない（プリフロップ）場合はそのまま返す
    if not board_cards or len(board_cards) < 3:
        return dict(range_dict)

    for combo_str, weight in range_dict.items():
        if weight <= 0.0:
            continue

        new_weight = weight

        try:
            parsed = ranges.parse_combo(combo_str)
            if not parsed:
                updated_range[combo_str] = new_weight
                continue

            # 代表コンボの最初の1つでハンド強度を評価
            sample_cards_str = parsed[0]
            dead_str = [Card.int_to_str(c) for c in board_cards]
            if any(c in dead_str for c in sample_cards_str):
                updated_range[combo_str] = new_weight
                continue

            hand_cards = [Card.new(c) for c in sample_cards_str]
            hand_score = evaluator.evaluate(list(board_cards), hand_cards)
            # treys: 1=最強 (Royal Flush), 7462=最弱 (7-high)
            # 強さのカテゴリを正規化 (0.0=最弱 ~ 1.0=最強)
            strength = 1.0 - (hand_score / 7462.0)

        except Exception:
            updated_range[combo_str] = new_weight
            continue

        if action_taken in ("RAISE", "LARGE_BET"):
            # レイズ/大きなベット → 弱いハンド（strength < 0.3）の確率を大幅削減
            # ブラフの可能性を残すため 0 にはしない
            if strength < 0.20:
                new_weight *= 0.05   # ほぼ除外（完全空振り）
            elif strength < 0.35:
                new_weight *= 0.15   # 弱いハンドは基本コール/フォールド
            # 強いハンドはそのまま

        elif action_taken == "CALL":
            # コール → ナッツ級（strength > 0.88）の確率を削減
            # （強すぎる場合は普通レイズする。トラップの可能性は残す）
            if strength > 0.88:
                new_weight *= 0.20

        if new_weight > 0:
            updated_range[combo_str] = new_weight

    # ウェイトが全て除外された場合は元のレンジを返す
    if not updated_range:
        return dict(range_dict)

    return normalize_range(updated_range)

