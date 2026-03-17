import random
import functools
from treys import Deck, Card, Evaluator as TreysEvaluator
import ranges
import range_utils

_treys_evaluator = TreysEvaluator()

@functools.lru_cache(maxsize=65536)
def cached_evaluate(board_tuple, hand_tuple):
    # board_tuple, hand_tuple are tuples of ints
    return _treys_evaluator.evaluate(list(board_tuple), list(hand_tuple))

class EquityCalculator:
    @staticmethod
    def calculate_preflop_score(cards):
        """ ヒューリスティックなプリフロップスコア計算 (Chen Formula ベース近似) """
        if not cards or len(cards) != 2: return 0.0
        r1 = Card.get_rank_int(cards[0])
        r2 = Card.get_rank_int(cards[1])
        s1 = Card.get_suit_int(cards[0])
        s2 = Card.get_suit_int(cards[1])
        
        def rank_score(r):
            if r == 12: return 10.0 # A
            if r == 11: return 8.0  # K
            if r == 10: return 7.0  # Q
            if r == 9: return 6.0   # J
            if r == 8: return 5.0   # T
            return (r + 2) / 2.0    # 9->5.5, 8->5.0, etc.
            
        score1 = rank_score(r1)
        score2 = rank_score(r2)
        
        base_score = max(score1, score2)
        
        if r1 == r2:
            base_score = max(5.0, base_score * 2.0)
        if s1 == s2:
            base_score += 2.0
            
        diff = abs(r1 - r2)
        if diff == 1:
            base_score += 3.0
        elif diff == 2:
            base_score += 2.0
        elif diff == 3:
            base_score += 1.0
            
        return base_score

    @staticmethod
    def _calculate_range_preflop_score(range_dict, dead_cards_str):
        total_score = 0.0
        total_weight = 0.0
        
        for combo_str, weight in range_dict.items():
            if weight <= 0.0: continue
            parsed = ranges.parse_combo(combo_str)
            for specific_cards_str in parsed:
                if not any(c in dead_cards_str for c in specific_cards_str):
                    cards = [Card.new(c) for c in specific_cards_str]
                    score = EquityCalculator.calculate_preflop_score(cards)
                    total_score += score * weight
                    total_weight += weight
                    
        if total_weight <= 0: return 0.0
        return total_score / total_weight

    @staticmethod
    def _parse_hand_ranks(cards):
        """
        2枚のカード（treys Card int）からランク整数のタプルを返す。
        戻り値: (高ランク, 低ランク) の順。A=12, K=11, ... 2=0
        """
        r1 = Card.get_rank_int(cards[0])
        r2 = Card.get_rank_int(cards[1])
        return (max(r1, r2), min(r1, r2))

    @staticmethod
    def calculate_preflop_equity_approx(hero_cards, target_range_dict, dead_cards_str):
        """
        Chen Formulaによる誤った勝率計算を廃止し、
        ポーカーの数理的対立構造（Matchup）に基づく近似エクイティを算出する。

        対立パターン:
          - ペア vs ペア      : 高ランクペアが約81%優位
          - ペア vs 2枚の非ペア: ランク位置で54-70%
          - 非ペア vs 非ペア   : ドミネイト/フリップ/キッカー差で30-70%
        """
        hero_r_high, hero_r_low = EquityCalculator._parse_hand_ranks(hero_cards)
        is_hero_pair = (hero_r_high == hero_r_low)

        total_equity = 0.0
        total_weight = 0.0

        for combo_str, weight in target_range_dict.items():
            if weight <= 0.0:
                continue
            parsed = ranges.parse_combo(combo_str)
            for specific_cards_str in parsed:
                # デッドカードスキップ
                if any(c in dead_cards_str for c in specific_cards_str):
                    continue
                try:
                    vill_cards_int = [Card.new(c) for c in specific_cards_str]
                except Exception:
                    continue

                vill_r_high, vill_r_low = EquityCalculator._parse_hand_ranks(vill_cards_int)
                is_vill_pair = (vill_r_high == vill_r_low)

                # --- Matchupパターン別エクイティ近似 ---
                if is_hero_pair and is_vill_pair:
                    # ペア vs ペア
                    if hero_r_high > vill_r_high:
                        matchup_eq = 0.81
                    elif hero_r_high < vill_r_high:
                        matchup_eq = 0.19
                    else:
                        matchup_eq = 0.50  # 同ランクペア（通常発生しない）

                elif is_hero_pair and not is_vill_pair:
                    # ペア vs 2枚の非ペア（コイントスに近い）
                    if hero_r_high > vill_r_high:
                        # ペアが両方のオーバーカードより上位
                        matchup_eq = 0.70
                    elif hero_r_high < vill_r_low:
                        # ペアが両カードより下位（下位ペア）
                        matchup_eq = 0.54
                    else:
                        # ペアが相手の2枚の間に挟まれている
                        matchup_eq = 0.60

                elif not is_hero_pair and is_vill_pair:
                    # 非ペア vs 相手ペア（上記の逆）
                    if vill_r_high > hero_r_high:
                        matchup_eq = 1.0 - 0.70
                    elif vill_r_high < hero_r_low:
                        matchup_eq = 1.0 - 0.54
                    else:
                        matchup_eq = 1.0 - 0.60

                else:
                    # 非ペア vs 非ペア
                    if hero_r_high == vill_r_high:
                        # トップカード同値 → キッカー差
                        if hero_r_low > vill_r_low:
                            matchup_eq = 0.70   # キッカー優位ドミネイト
                        elif hero_r_low < vill_r_low:
                            matchup_eq = 0.30   # キッカー劣位ドミネイト
                        else:
                            matchup_eq = 0.50   # 完全同値
                    elif hero_r_low == vill_r_high:
                        # 下のカードに被りがある → 片側ドミネイト
                        matchup_eq = 0.30
                    elif vill_r_low == hero_r_high:
                        # 逆方向の片側ドミネイト
                        matchup_eq = 0.70
                    elif hero_r_high > vill_r_high and hero_r_low > vill_r_low:
                        # 両カードとも上位
                        matchup_eq = 0.65
                    elif hero_r_high < vill_r_high and hero_r_low < vill_r_low:
                        # 両カードとも下位
                        matchup_eq = 0.35
                    else:
                        # フリップ（典型例: AKo vs 22）
                        matchup_eq = 0.50

                total_equity += matchup_eq * weight
                total_weight += weight

        if total_weight <= 0:
            return 0.50
        return max(0.05, min(0.95, total_equity / total_weight))

    @staticmethod
    def calc_equity_monte_carlo(hero_cards, board_cards, hero_range_dict, cpu_range_dict, target_actor="CPU", is_preflop=False, iterations=1000):
        if is_preflop:
            target_dict = cpu_range_dict if target_actor == "CPU" else hero_range_dict
            dead_cards_str = [Card.int_to_str(c) for c in hero_cards] + [Card.int_to_str(c) for c in board_cards]

            # ▼ 修正: Chen FormulaのスコアベースEQ算出を廃止し
            #         Matchupパターンに基づく近似エクイティを使用する。
            hero_equity = EquityCalculator.calculate_preflop_equity_approx(
                hero_cards, target_dict, dead_cards_str
            )
            return hero_equity, 1.0 - hero_equity

        hero_wins = 0
        ties = 0
        total_sims = 0
        
        target_dict = cpu_range_dict if target_actor == "CPU" else hero_range_dict
        dead_cards_str = [Card.int_to_str(c) for c in hero_cards] + [Card.int_to_str(c) for c in board_cards]
        
        # We process range sampling iteratively using our external range logic
        for _ in range(iterations):
            temp_deck = Deck()
            sim_board = list(board_cards)
            
            removals = hero_cards + board_cards
            temp_deck.cards = [c for c in temp_deck.cards if c not in removals]
            
            needed = 5 - len(sim_board)
            if needed > 0:
                drawn = temp_deck.draw(needed)
                if not isinstance(drawn, list): drawn = [drawn]
                sim_board.extend(drawn)
                
            cpu_cards = range_utils.sample_range(target_dict, dead_cards_str=dead_cards_str)
            if not cpu_cards:
                continue
                
            if any(c in sim_board for c in cpu_cards) or any(c in hero_cards for c in cpu_cards):
                 continue
                 
            # Use fixed LRU Cache wrapper for performance
            sim_board_tuple = tuple(sim_board)
            hero_score = cached_evaluate(sim_board_tuple, tuple(hero_cards))
            cpu_score = cached_evaluate(sim_board_tuple, tuple(cpu_cards))
            
            if hero_score < cpu_score:
                hero_wins += 1
            elif hero_score == cpu_score:
                ties += 1
                
            total_sims += 1

        if total_sims == 0:
            return 1.0, 0.0
            
        hero_equity = (hero_wins + ties / 2) / total_sims
        cpu_equity = 1.0 - hero_equity
        return hero_equity, cpu_equity

    @staticmethod
    def calc_range_advantage(hero_cards, board_cards, hero_range_dict, cpu_range_dict, is_preflop=False, iterations=1000):
        if is_preflop:
            return 0.5
            
        hero_wins = 0
        ties = 0
        total_sims = 0
        
        dead_cards_str = [Card.int_to_str(c) for c in hero_cards] + [Card.int_to_str(c) for c in board_cards]
        
        for _ in range(iterations):
            temp_deck = Deck()
            sim_board = list(board_cards)
            
            temp_deck.cards = [c for c in temp_deck.cards if c not in board_cards]
            
            needed = 5 - len(sim_board)
            if needed > 0:
                drawn = temp_deck.draw(needed)
                if not isinstance(drawn, list): drawn = [drawn]
                sim_board.extend(drawn)

            # ▼ 修正: hero_cards（引数）をループ内の変数で上書きしないようリネーム
            sampled_hero = range_utils.sample_range(hero_range_dict, dead_cards_str=dead_cards_str)
            sampled_cpu  = range_utils.sample_range(cpu_range_dict,  dead_cards_str=dead_cards_str)
            
            if not sampled_hero or not sampled_cpu:
                 continue
                 
            if any(c in sim_board for c in sampled_cpu) or any(c in sim_board for c in sampled_hero):
                 continue
            if any(c in sampled_hero for c in sampled_cpu):
                 continue
                 
            sim_board_tuple = tuple(sim_board)
            hero_score = cached_evaluate(sim_board_tuple, tuple(sampled_hero))
            cpu_score  = cached_evaluate(sim_board_tuple, tuple(sampled_cpu))
            
            if hero_score < cpu_score:
                hero_wins += 1
            elif hero_score == cpu_score:
                ties += 1
                
            total_sims += 1
            
        if total_sims == 0:
            return 0.5
            
        hero_equity = (hero_wins + ties / 2) / total_sims
        return hero_equity

