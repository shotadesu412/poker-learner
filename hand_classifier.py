from treys import Card, Evaluator as TreysEvaluator

# 毎回インスタンス化するとハンドごとにルックアップテーブルを再構築して遅いため共有する
_TREYS_EVALUATOR = TreysEvaluator()

class HandClassifier:
    @staticmethod
    def _has_straight(rank_set):
        """rank_set 内に5枚連続（ストレート完成）が存在するか。A は high/low 両対応。"""
        s = set(rank_set)
        if 12 in s:           # A を 1(=-1) としても扱う（ホイール A2345）
            s = s | {-1}
        for lo in range(-1, 9):  # lo..lo+4
            if all((lo + i) in s for i in range(5)):
                return True
        return False

    @staticmethod
    def _straight_draw_level(rank_set):
        """
        ストレートドローの強さを返す（アウツとなる「ランク数」で判定）:
          2 = オープンエンド相当（完成ランクが2種類以上＝約8アウツ）
          1 = ガットショット（完成ランクが1種類＝約4アウツ）
          0 = なし
        """
        base = set(rank_set)
        if HandClassifier._has_straight(base):
            return 0  # すでに完成（ドローではない）
        out_ranks = 0
        for r in range(0, 13):
            if r in base:
                continue
            if HandClassifier._has_straight(base | {r}):
                out_ranks += 1
        if out_ranks >= 2:
            return 2
        elif out_ranks == 1:
            return 1
        return 0

    @staticmethod
    def detect_draw_strength(cards, board):
        """
        ヒーローのホールカードが「関与している」ドローのみを検出する。
        ボード単独で成立するドロー（自分のカードが寄与しないもの）は除外する。
        """
        if not board:
            return "NONE"

        hole_suits = [Card.get_suit_int(c) for c in cards]
        all_suits = [Card.get_suit_int(c) for c in cards + board]
        suit_total = {s: all_suits.count(s) for s in set(all_suits)}

        # --- フラッシュドロー: 合計4枚の同スートに、ヒーローが1枚以上関与していること ---
        is_flush_draw = any(
            cnt == 4 and hole_suits.count(s) >= 1
            for s, cnt in suit_total.items()
        )
        # バックドアフラッシュ（弱）: 合計3枚の同スートに、ヒーローが1枚以上関与
        is_backdoor_flush = any(
            cnt == 3 and hole_suits.count(s) >= 1
            for s, cnt in suit_total.items()
        )

        # --- ストレートドロー: ホールカードを加えることでドローが向上する場合のみ ---
        board_ranks = set(Card.get_rank_int(c) for c in board)
        hole_ranks = set(Card.get_rank_int(c) for c in cards)
        board_level = HandClassifier._straight_draw_level(board_ranks)
        combined_level = HandClassifier._straight_draw_level(board_ranks | hole_ranks)
        # ホールカードが寄与してドローが強くなった分だけを自分のドローとみなす
        hero_straight_level = combined_level if combined_level > board_level else 0

        is_oesd = (hero_straight_level == 2)
        is_gutshot = (hero_straight_level == 1)

        if is_flush_draw and (is_oesd or is_gutshot):
            return "STRONG_DRAW"  # コンボドロー
        elif is_oesd:
            return "STRONG_DRAW"  # オープンエンドストレートドロー
        elif is_flush_draw:
            return "STRONG_DRAW"  # フラッシュドロー
        elif is_gutshot:
            return "MEDIUM_DRAW"  # ガットショット
        elif is_backdoor_flush:
            return "WEAK_DRAW"    # バックドアフラッシュドロー

        return "NONE"

    @staticmethod
    def categorize_hand(cards, board=None):
        """
        Categorize hand into 8 discrete buckets for heuristic modeling:
        NUT_HAND, STRONG_MADE, MEDIUM_MADE, WEAK_MADE, 
        STRONG_DRAW, MEDIUM_DRAW, WEAK_DRAW, AIR
        """
        if not cards or len(cards) < 2:
            return "AIR"
            
        r1 = Card.get_rank_int(cards[0])
        r2 = Card.get_rank_int(cards[1])
        s1 = Card.get_suit_int(cards[0])
        s2 = Card.get_suit_int(cards[1])
        is_suited = (s1 == s2)
            
        # Postflop evaluation
        if board and len(board) >= 3:
            score = 7462 # Default worst score
            try:
                score = _TREYS_EVALUATOR.evaluate(board, cards)
            except:
                pass
            
            # Use explicit GTO threshold rules requested by user
            if score < 1600:
                return "NUT_HAND"
            elif score < 3000:
                return "STRONG_MADE"
            elif score < 5000:
                return "MEDIUM_MADE"
            else:
                # WEAK_MADE or AIR, priority to draws
                draw_strength = HandClassifier.detect_draw_strength(cards, board)
                if draw_strength != "NONE":
                    return draw_strength
                    
                if score <= 6185:
                    return "WEAK_MADE"
                else:
                    return "AIR"
                
        # ▼ 修正: プリフロップ分類の是正
        #   旧実装は AKs を「STRONG_DRAW」(ドロー用EQR上限が適用され不整合)、
        #   スーテッドコネクターを「AIR」に分類していた。
        #   文献上、オフスートブロードウェイは過小実現(ドミネイト・リバースインプライド)、
        #   スーテッド/コネクト性の実現ボーナスは calculate_pi 側で加点されるため、
        #   ここでは「ハイカード強度の階層」のみを表す。
        hi, lo = max(r1, r2), min(r1, r2)

        if r1 == r2:
            if r1 >= 9:  return "STRONG_MADE"   # JJ+
            if r1 >= 4:  return "MEDIUM_MADE"   # 66-TT
            return "WEAK_MADE"                  # 22-55

        if hi == 12 and lo >= 10:               # AK, AQ
            return "STRONG_MADE"

        if (hi == 12 and lo >= 7 and is_suited) or \
           (hi >= 10 and lo >= 9 and is_suited) or \
           (hi == 12 and lo >= 9):
            return "MEDIUM_MADE"                # A9s+, KJs/QJs/KQs, AJo+

        if hi >= 10 and lo >= 8:                # オフスートブロードウェイ (KTo, QJo等)
            return "WEAK_MADE"                  # ドミネイトされやすく過小実現

        return "AIR"

    @staticmethod
    def classify_board_texture(board):
        """
        board: Board Cards
        return: 'dry', 'semi_wet', 'wet', 'paired', 'monotone'
        """
        if len(board) == 0:
             return "dry"
        
        suits = [Card.get_suit_int(c) for c in board]
        ranks = [Card.get_rank_int(c) for c in board]
        
        suit_counts = {s: suits.count(s) for s in set(suits)}
        rank_counts = {r: ranks.count(r) for r in set(ranks)}
        max_suit = max(suit_counts.values()) if suit_counts else 0
        
        # 1. Monotone
        if max_suit >= 3:
            return "monotone"
            
        # 2. Paired board
        if max(rank_counts.values()) >= 2:
            return "paired"
            
        # Connectivity Assessment
        sorted_ranks = sorted(ranks, reverse=True)
        is_highly_connected = False
        is_semi_connected = False
        
        if len(sorted_ranks) >= 3:
            for i in range(len(sorted_ranks) - 2):
                 gap = sorted_ranks[i] - sorted_ranks[i+2]
                 if gap <= 3: # 7 6 5, J T 8 (OESD/Gutter dense)
                      is_highly_connected = True
                 elif gap <= 4: # Q 9 8, K T 8 (Some gutters)
                      is_semi_connected = True
                      
        # 3. Wet
        if max_suit == 2 and is_highly_connected:
            return "wet"
            
        # 4. Semi_wet
        if max_suit == 2 or is_highly_connected or is_semi_connected:
            return "semi_wet"
            
        # 5. Dry
        return "dry"
