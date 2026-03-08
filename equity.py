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
    def calc_equity_monte_carlo(hero_cards, board_cards, hero_range_dict, cpu_range_dict, target_actor="CPU", is_preflop=False, iterations=1000):
        if is_preflop:
            target_dict = cpu_range_dict if target_actor == "CPU" else hero_range_dict
            dead_cards_str = [Card.int_to_str(c) for c in hero_cards] + [Card.int_to_str(c) for c in board_cards]
            
            hero_score = EquityCalculator.calculate_preflop_score(hero_cards)
            cpu_score = EquityCalculator._calculate_range_preflop_score(target_dict, dead_cards_str)
            
            delta = hero_score - cpu_score
            hero_equity = 0.5 + (delta * 0.02)
            hero_equity = max(0.05, min(0.95, hero_equity))
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
                
            hero_cards = range_utils.sample_range(hero_range_dict, dead_cards_str=dead_cards_str)
            cpu_cards = range_utils.sample_range(cpu_range_dict, dead_cards_str=dead_cards_str)
            
            if not hero_cards or not cpu_cards:
                 continue
                 
            if any(c in sim_board for c in cpu_cards) or any(c in sim_board for c in hero_cards):
                 continue
            if any(c in hero_cards for c in cpu_cards): # Collision between sampled hands
                 continue
                 
            sim_board_tuple = tuple(sim_board)
            hero_score = cached_evaluate(sim_board_tuple, tuple(hero_cards))
            cpu_score = cached_evaluate(sim_board_tuple, tuple(cpu_cards))
            
            if hero_score < cpu_score:
                hero_wins += 1
            elif hero_score == cpu_score:
                ties += 1
                
            total_sims += 1
            
        if total_sims == 0:
            return 0.5
            
        hero_equity = (hero_wins + ties / 2) / total_sims
        return hero_equity
