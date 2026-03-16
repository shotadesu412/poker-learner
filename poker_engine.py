import random
import math
from treys import Deck, Card, Evaluator as TreysEvaluator
import ranges

from bet_sizing import (
    PREFLOP_OPENS, PREFLOP_3BET, BET_SIZES, RAISE_MULTIPLIER, 
    TEXTURE_MULTIPLIER, POSITION_MULTIPLIER, SPR_MULTIPLIER,
    EVAL_OPTIMAL, EVAL_GOOD, EVAL_MARGINAL, EVAL_BAD
)
from equity import EquityCalculator
from ev_calculator import EVCalculator
from hand_classifier import HandClassifier
import range_utils
class Evaluator:
    # --- EV Threshold Constants ---
    CALL_IMPLIED_ODDS_THRESHOLD = 0.9
    CALL_OPTIMAL_THRESHOLD = 1.2
    CALL_MARGINAL_THRESHOLD = 0.8
    BET_OPTIMAL_MARGIN_PCT = 0.05
    FOLD_OPTIMAL_THRESHOLD = 1.2

    @staticmethod
    def calculate_required_equity(call_amount, pot_size):
        return EVCalculator.calculate_required_equity(call_amount, pot_size)

    @staticmethod
    def ev_call(equity, pot_size, call_amount, spr=None, hand_category=None):
        return EVCalculator.ev_call(equity, pot_size, call_amount, spr, hand_category)

    @staticmethod
    def ev_check(equity, pot_size):
        return EVCalculator.ev_check(equity, pot_size)

    @staticmethod
    def ev_bet(equity, pot_size, bet_amount, fold_equity):
        return EVCalculator.ev_bet(equity, pot_size, bet_amount, fold_equity)
    
    @staticmethod
    def calculate_alpha(bet_amount, pot_size):
        return EVCalculator.calculate_alpha(bet_amount, pot_size)
    
    @staticmethod
    def calculate_mdf(bet_amount, pot_size):
        return EVCalculator.calculate_mdf(bet_amount, pot_size)

    @staticmethod
    def calculate_theoretical_bluff_frequency(bet_size, pot):
        return EVCalculator.calculate_theoretical_bluff_frequency(bet_size, pot)

    @staticmethod
    def detect_draw_strength(cards, board):
        return HandClassifier.detect_draw_strength(cards, board)

    @staticmethod
    def categorize_hand(cards, board=None):
        return HandClassifier.categorize_hand(cards, board)

    @staticmethod
    def calculate_pi(cards, board=None):
        """
        Playability Index (PI) の計算 (Updated to GTO Constraints)
        """
        if not cards or len(cards) < 2:
            return 1.0
            
        pi = 1.0
        from treys import Card
        r1 = Card.get_rank_int(cards[0])
        r2 = Card.get_rank_int(cards[1])
        s1 = Card.get_suit_int(cards[0])
        s2 = Card.get_suit_int(cards[1])
        
        if s1 == s2:
            pi += 0.08
        if abs(r1 - r2) <= 1:
            pi += 0.06
        if r1 == r2:
            pi += 0.10
            
        # Postflop PI
        if board and len(board) >= 3:
            suits = [Card.get_suit_int(c) for c in cards + board]
            suit_counts = {s: suits.count(s) for s in set(suits)}
            if suit_counts and max(suit_counts.values()) == 4:
                pi += 0.10 # Good playability to hit flush
                
        return pi

    @staticmethod
    def get_eqr_modifier(hero_pos, cards=None, is_3bet_pot=False, board=None, range_adv=0.5, spr=10.0):
        """
        Calculates EQR (Equity Realization) based on:
        1. Position (IP vs OOP)
        2. Playability (Hand Category fragility)
        3. SPR convergence
        4. Range Advantage
        5. Board Texture (New)
        6. Nut Advantage (New)
        """
        base_eqr = 1.0
        category = Evaluator.categorize_hand(cards, board)
        is_ip = hero_pos in ["BTN", "CO", "HJ"] # Rough IP heuristic
        
        # 1. Positional Modifier
        if is_ip:
            base_eqr += 0.10
        else:
            base_eqr -= 0.10
            
        # 2. Playability Modifier (8-tier buckets)
        if category in ["STRONG_DRAW", "MEDIUM_DRAW"]:
            base_eqr += 0.15 # Draws over-realize
        elif category in ["NUT_HAND", "STRONG_MADE"]:
            base_eqr += 0.05 # Strong made hands realize well
        elif category == "AIR" or category == "WEAK_MADE":
            base_eqr -= 0.20 # Air and weak pairs under-realize
        elif category == "WEAK_DRAW":
            base_eqr -= 0.10
            
        if is_3bet_pot:
            # 3bet pots punish marginal/air hands even more heavily
            if category in ["MEDIUM_MADE", "WEAK_MADE", "WEAK_DRAW", "AIR"]:
                base_eqr -= 0.15
                
        # 3. SPR Convergence using SPR_MULTIPLIER categories
        if spr < 1.0:
            spr_adj = (1.0 - base_eqr) * SPR_MULTIPLIER["ultra_low"]
            base_eqr += spr_adj
        elif spr < 3.0:
            spr_adj = (1.0 - base_eqr) * SPR_MULTIPLIER["low"]
            base_eqr += spr_adj
        elif spr > 6.0:
            base_eqr *= SPR_MULTIPLIER["high"]
            
        # 4. Range Advantage Bonus/Penalty
        adv_multiplier = 1.0 + (range_adv - 0.5) * 0.3
        base_eqr *= adv_multiplier
        
        # 5 & 6. Board Texture and Nut Advantage
        if board:
            texture = HandClassifier.classify_board_texture(board)
            if texture == "paired":
                nut_adv = 0.3 if is_ip else -0.1
                base_eqr *= TEXTURE_MULTIPLIER["paired"]
            elif texture == "dry":
                nut_adv = 0.2 if is_ip else -0.1
                base_eqr *= TEXTURE_MULTIPLIER["dry"]
            elif texture == "wet":
                nut_adv = -0.2 if is_ip else 0.2
                base_eqr *= TEXTURE_MULTIPLIER["wet"]
            elif texture == "monotone":
                nut_adv = -0.3 if is_ip else 0.2
                base_eqr *= TEXTURE_MULTIPLIER.get("semi_wet", 1.0)
            else:
                nut_adv = 0.0
                
            base_eqr += (nut_adv * 0.15)
        
        # Add basic PI
        pi = Evaluator.calculate_pi(cards, board)
        
        final_eqr = base_eqr * pi
        return max(0.65, min(1.25, final_eqr))
    
    @staticmethod
    def calculate_alpha(bet_amount, pot_size):
        """ α (Alpha): ブラフが成功する必要最低限の頻度 """
        return bet_amount / (pot_size + bet_amount)
    
    @staticmethod
    def calculate_mdf(bet_amount, pot_size):
        """ MDF (Minimum Defense Frequency) """
        return pot_size / (pot_size + bet_amount)

    @staticmethod
    def get_combo_str(cards, range_dict=None):
        from treys import Card
        if not cards or len(cards) != 2: return ""
        r1 = Card.get_rank_int(cards[0])
        r2 = Card.get_rank_int(cards[1])
        s1_int = Card.get_suit_int(cards[0])
        s2_int = Card.get_suit_int(cards[1])
        ranks = "23456789TJQKA"
        
        # Treys suit ints to string map
        suit_map = {1: 's', 2: 'h', 4: 'd', 8: 'c'}
        s1_char = suit_map.get(s1_int, '')
        s2_char = suit_map.get(s2_int, '')
        
        # Exact hole cards check (e.g., AhKh)
        c1_str = ranks[r1] + s1_char
        c2_str = ranks[r2] + s2_char
        exact_str1 = c1_str + c2_str
        exact_str2 = c2_str + c1_str
        
        if range_dict:
            if exact_str1 in range_dict:
                return exact_str1
            if exact_str2 in range_dict:
                return exact_str2
                
        char1 = ranks[r1]
        char2 = ranks[r2]
        if r1 == r2: return char1 + char2
        if r1 < r2: char1, char2 = char2, char1 # High rank first
        suffix = "s" if s1_int == s2_int else "o"
        return char1 + char2 + suffix

    @staticmethod
    def evaluate_preflop_range(cards, hero_range_dict):
        combo = Evaluator.get_combo_str(cards, hero_range_dict)

        if combo not in hero_range_dict:
            return "fold"

        weight = hero_range_dict.get(combo, 0.0)

        if weight >= 0.75:
            return "play"

        if weight > 0:
            return "mix"

        return "fold"

    @staticmethod
    def evaluate_call(equity, call_amount, pot_size, hero_pos="BTN", cards=None, is_3bet_pot=False, board=None, effective_stack=0.0, range_adv=0.5, hero_range_dict=None):
        if call_amount == 0:
            return {"ev": 0.0, "req_eq": 0.0, "realized_eq": equity, "evaluation": EVAL_OPTIMAL, "reason": "チェック可能にも関わらずコール判定になりました。無料のカードは常に最適です。"}
            
        preflop_prefix = ""
        # PREFLOP RANGE CHECK
        if not board and hero_range_dict is not None:
            decision = Evaluator.evaluate_preflop_range(cards, hero_range_dict)
            
            import ranges
            combo_str = Evaluator.get_combo_str(cards, hero_range_dict)
            weight = hero_range_dict.get(combo_str, 0.0)
            classification = ranges.classify_range(weight)
            feedback = ranges.get_preflop_feedback(classification)
            reason = ranges.get_hand_reason(combo_str)
            
            if decision == "fold":
                return {
                    "ev": 0.0, "req_eq": 0.0, "realized_eq": equity, 
                    "evaluation": EVAL_BAD, 
                    "reason": f"【{classification}】{feedback} {reason}\n(このポジションのGTOレンジではフォールドが基本です。)"
                }
            
            if decision == "mix":
                return {
                    "ev": 0.0, "req_eq": 0.0, "realized_eq": equity, 
                    "evaluation": EVAL_MARGINAL, 
                    "reason": f"【{classification}】{feedback} {reason}\n(このハンドはミックスレンジです。コールとフォールドが混在します。)"
                }
            
            preflop_prefix = f"【{classification}】{feedback} {reason}\n"

        e_req = Evaluator.calculate_required_equity(call_amount, pot_size)
        eqr = Evaluator.get_eqr_modifier(hero_pos, cards, is_3bet_pot, board, range_adv)
        realized_equity = equity * eqr
        
        spr = None
        if effective_stack > 0 and pot_size > 0:
            spr = effective_stack / pot_size
            
        category = Evaluator.categorize_hand(cards, board)
        
        # EV computation
        ev_call_val = Evaluator.ev_call(realized_equity, pot_size, call_amount, spr=spr, hand_category=category)
        
        result_eval = EVAL_BAD
        result_reason = preflop_prefix
        
        if ev_call_val > 0 and realized_equity < e_req * Evaluator.CALL_IMPLIED_ODDS_THRESHOLD:
            result_eval = EVAL_GOOD
            result_reason += f"現在の勝率({realized_equity*100:.1f}%)はオッズにあっていませんが、深いSPR({spr:.1f})によるインプライドオッズでEV({ev_call_val:.1f})がプラスになる利益的なコールです。"
        elif realized_equity >= e_req * Evaluator.CALL_OPTIMAL_THRESHOLD:
            result_eval = EVAL_OPTIMAL
            result_reason += f"必要勝率({e_req*100:.1f}%)に対し、あなたの実現勝率({realized_equity*100:.1f}%)は十分高く、極めて利益的なコールです。"
        elif realized_equity >= e_req:
            result_eval = EVAL_GOOD
            result_reason += f"必要勝率({e_req*100:.1f}%)を満たしており、利益的なコールです。"
        elif realized_equity >= e_req * Evaluator.CALL_MARGINAL_THRESHOLD:
            result_eval = EVAL_MARGINAL
            result_reason += f"必要勝率({e_req*100:.1f}%)にわずかに届いていません。ブラフキャッチ等の追加の理由が必要です。"
        else:
            result_eval = EVAL_BAD
            result_reason += f"必要勝率({e_req*100:.1f}%)に対して実現勝率({realized_equity*100:.1f}%)が低すぎます。フォールドすべきです。"
            
        return {
            "ev": ev_call_val,
            "req_eq": e_req,
            "realized_eq": realized_equity,
            "evaluation": result_eval,
            "reason": result_reason
        }

    @staticmethod
    def evaluate_fold(equity, opponent_bet_size, pot_size, hero_pos="BTN", cards=None, is_3bet_pot=False, board=None, range_adv=0.5):
        if opponent_bet_size == 0:
            return {"ev": 0.0, "req_eq": 0.0, "realized_eq": equity, "evaluation": EVAL_BAD, "reason": "無料で見られる状況でのフォールドは完全なミスプレイです。"}
            
        e_req = Evaluator.calculate_required_equity(opponent_bet_size, pot_size)
        mdf = Evaluator.calculate_mdf(opponent_bet_size, pot_size)
        eqr = Evaluator.get_eqr_modifier(hero_pos, cards, is_3bet_pot, board, range_adv)
        realized_equity = equity * eqr
        
        result_eval = EVAL_OPTIMAL
        result_reason = ""
        
        if realized_equity >= e_req * Evaluator.FOLD_OPTIMAL_THRESHOLD:
            result_eval = EVAL_BAD
            result_reason = f"必要勝率({e_req*100:.1f}%)に対して実現勝率({realized_equity*100:.1f}%)が十分に高く、コールやレイズすべきでした。期待値マイナスです。"
        elif realized_equity >= e_req:
            result_eval = EVAL_MARGINAL
            result_reason = f"必要勝率({e_req*100:.1f}%)を満たしており({realized_equity*100:.1f}%)、フォールドは消極的すぎるかもしれません。"
        elif realized_equity >= (e_req - 0.05):
            # ▼ MDF考慮: 勝率がオッズに5%以内のマージナルスポット
            # このハンドでフォールドが続くと相手の全ブラフが無条件に通ってしまう
            result_eval = EVAL_MARGINAL
            result_reason = (
                f"オッズ（必要勝率{e_req*100:.1f}%）にはわずかに届きませんが（あなたの勝率: {realized_equity*100:.1f}%）、"
                f"MDF（最小防衛頻度: {mdf*100:.0f}%）を考慮してください。"
                f"このようなマージナルなスポットでフォールドが頻発すると、相手はどんな2枚でも"
                f"ブラフをして無限に利益を得られる（エクスプロイトされる）危険性があります。"
                f"ブラフキャッチャーとして一定頻度でコールを検討しましょう。"
            )
        else:
            result_eval = EVAL_OPTIMAL
            result_reason = f"必要勝率({e_req*100:.1f}%)に対し実現勝率({realized_equity*100:.1f}%)が不足しているため、適切なフォールドです。"
            
        return {
            "ev": 0.0,  # Fold EV is always 0
            "req_eq": e_req,
            "mdf": round(mdf, 3),
            "realized_eq": realized_equity,
            "evaluation": result_eval,
            "reason": result_reason
        }

    @staticmethod
    def evaluate_bet(equity, bet_amount, pot_size, hero_pos="BTN", cards=None, board=None, range_adv=0.5):
        eqr = Evaluator.get_eqr_modifier(hero_pos, cards, False, board, range_adv)
        realized_equity = equity * eqr

        # Fold Equity Estimate using MDF threshold
        # If villain defends MDF, fold frequency is (1 - MDF) = bet / (pot + bet)
        fold_equity = bet_amount / (pot_size + bet_amount)
        
        ev_betting = Evaluator.ev_bet(realized_equity, pot_size, bet_amount, fold_equity)
        ev_checking = Evaluator.ev_check(realized_equity, pot_size)
        
        result_eval = EVAL_BAD
        if ev_betting > ev_checking + (Evaluator.BET_OPTIMAL_MARGIN_PCT * pot_size):
            result_eval = EVAL_OPTIMAL
            if range_adv > 0.55:
                result_reason = f"あなたに明確なレンジアドバンテージ(勝率優位)があるため、アグレッシブなベットが正当化されます。EV: {ev_betting:.1f}"
            elif realized_equity < 0.35:
                result_reason = f"勝率は低いですが、高いフォールドエクイティ(相手を降ろす確率)を利用した利益的なブラフベットです。EV: {ev_betting:.1f}"
            else:
                result_reason = f"チェックよりもベットの期待値が明確に上回る、バリューとプレッシャーを兼ね備えたアクションです。EV: {ev_betting:.1f}"
        elif ev_betting >= ev_checking:
            result_eval = EVAL_GOOD
            result_reason = f"ベット期待値(EV: {ev_betting:.1f})がチェック(EV: {ev_checking:.1f})を上回っており、妥当なアクションです。"
        elif ev_betting >= ev_checking - (Evaluator.BET_OPTIMAL_MARGIN_PCT * pot_size):
            result_eval = EVAL_MARGINAL
            result_reason = "ベットとチェックの期待値が拮抗しています。GTOにおいては、相手に読まれないよう頻度（乱数）でアクションを混ぜる（混合戦略）べきスポットです。"
        else:
            result_eval = EVAL_BAD
            result_reason = f"チェックの期待値(EV: {ev_checking:.1f})の方がベット(EV: {ev_betting:.1f})より高いため、ベットは避けるべきです。"

        return {
            "ev": ev_betting,
            "req_eq": 0.0, # N/A for betting
            "realized_eq": realized_equity,
            "evaluation": result_eval,
            "reason": result_reason
        }

    @staticmethod
    def evaluate_raise(equity, raise_amount, opponent_bet_size, pot_size, hero_pos="BTN", cards=None, board=None, range_adv=0.5, hero_range_dict=None):
        preflop_prefix = ""
        # PREFLOP RANGE CHECK
        if not board and hero_range_dict is not None:
            decision = Evaluator.evaluate_preflop_range(cards, hero_range_dict)
            
            import ranges
            combo_str = Evaluator.get_combo_str(cards, hero_range_dict)
            weight = hero_range_dict.get(combo_str, 0.0)
            classification = ranges.classify_range(weight)
            feedback = ranges.get_preflop_feedback(classification)
            reason = ranges.get_hand_reason(combo_str)
            
            if decision == "fold":
                return {
                    "ev": 0.0, "req_eq": 0.0, "realized_eq": equity, 
                    "evaluation": EVAL_BAD, 
                    "reason": f"【{classification}】{feedback} {reason}\n(このポジションのGTOレンジではレイズすべきではないハンドです。)"
                }
                
            if decision == "mix":
                return {
                    "ev": 0.0, "req_eq": 0.0, "realized_eq": equity, 
                    "evaluation": EVAL_MARGINAL, 
                    "reason": f"【{classification}】{feedback} {reason}\n(このハンドはミックスレンジです。稀にレイズが正当化されます。)"
                }
                
            preflop_prefix = f"【{classification}】{feedback} {reason}\n"
                
        eqr = Evaluator.get_eqr_modifier(hero_pos, cards, False, board, range_adv)
        realized_equity = equity * eqr

        # Calculate fold equity dynamically via MDF.
        # FE = bet / (pot + bet)
        total_pot = pot_size + opponent_bet_size
        fold_equity = raise_amount / (total_pot + raise_amount)
        
        ev_raising = Evaluator.ev_bet(realized_equity, total_pot, raise_amount, fold_equity)
        ev_calling = Evaluator.ev_call(realized_equity, pot_size, opponent_bet_size)
        
        if ev_raising > ev_calling + (Evaluator.BET_OPTIMAL_MARGIN_PCT * total_pot):
            result_eval = EVAL_OPTIMAL
            if range_adv > 0.55:
                result_reason = preflop_prefix + f"あなたに明確なレンジアドバンテージ(勝率優位)があるため、アグレッシブなレイズが正当化されます。EV: {ev_raising:.1f}"
            elif realized_equity < 0.35:
                result_reason = preflop_prefix + f"勝率は低いですが、高いフォールドエクイティ(相手を降ろす確率)を利用した利益的なブラフレイズです。EV: {ev_raising:.1f}"
            else:
                result_reason = preflop_prefix + f"コールよりもレイズの期待値が明確に上回る、バリューとプレッシャーを兼ね備えたアクションです。EV: {ev_raising:.1f}"
        elif ev_raising >= ev_calling:
            result_eval = EVAL_GOOD
            result_reason = preflop_prefix + f"レイズ(EV: {ev_raising:.1f})がコール(EV: {ev_calling:.1f})を上回っており、妥当な攻撃的アクションです。"
        elif ev_raising >= ev_calling - (Evaluator.BET_OPTIMAL_MARGIN_PCT * total_pot):
            result_eval = EVAL_MARGINAL
            result_reason = preflop_prefix + "レイズとコールの期待値が拮抗しています。GTOにおいては、相手に読まれないよう頻度（乱数）でアクションを混ぜる（混合戦略）べきスポットです。"
        else:
            result_eval = EVAL_BAD
            result_reason = preflop_prefix + f"コール(EV: {ev_calling:.1f})の方がレイズ(EV: {ev_raising:.1f})よりも高いため、基本的にはコールかフォールドすべきです。"

        return {
            "ev": ev_raising,
            "req_eq": 0.0,
            "realized_eq": realized_equity,
            "evaluation": result_eval,
            "reason": result_reason
        }

    @staticmethod
    def evaluate_check(equity, pot_size, hero_pos="BTN", has_initiative=False, is_hero_ip=False, cards=None, board=None, range_adv=0.5):
        if not has_initiative:
            if not is_hero_ip:
                # OOP
                return {"ev": 0.0, "req_eq": 0.0, "realized_eq": equity, "evaluation": EVAL_OPTIMAL, "reason": "あなたはアグレッサーではなくOOP（ポジション不利）であるため、まずはレンジ全体でチェックし、相手のアクションを見てからディフェンスするのがGTOの基本戦略です。"}
            else:
                # IP
                return {"ev": 0.0, "req_eq": 0.0, "realized_eq": equity, "evaluation": EVAL_OPTIMAL, "reason": "相手が攻撃権を放棄したため、ポットコントロールのためにチェックバックして次のカードを無料で見にいくのは有効な選択です。"}
            
        eqr = Evaluator.get_eqr_modifier(hero_pos, cards, False, board, range_adv)
        realized_equity = equity * eqr
        ev_checking = Evaluator.ev_check(realized_equity, pot_size)
        
        # Compare vs half-pot bet
        half_pot = pot_size / 2.0
        fold_equity = half_pot / (pot_size + half_pot)
        ev_betting_half_pot = Evaluator.ev_bet(realized_equity, pot_size, half_pot, fold_equity)
        
        if ev_checking >= ev_betting_half_pot:
            result_eval = EVAL_OPTIMAL
            if range_adv < 0.45:
                result_reason = "相手のレンジの方が強いため、ベットして無駄にチップを失うより、チェックでポットコントロールを図るのが最適です。"
            else:
                result_reason = f"ベット(EV: {ev_betting_half_pot:.1f})よりチェック(EV: {ev_checking:.1f})が高く、パッシブな進行が最善です。"
        elif ev_checking >= ev_betting_half_pot * 0.8:
            result_eval = EVAL_GOOD
            result_reason = f"チェックの期待値(EV: {ev_checking:.1f})は標準的です。ポットコントロールに適しています。"
        elif ev_checking >= ev_betting_half_pot * 0.5:
            result_eval = EVAL_MARGINAL
            result_reason = f"ベットすべき状況かもしれませんが、チェックも限定的に正当化されます。"
        else:
            result_eval = EVAL_BAD
            result_reason = f"ベット期待値(EV: {ev_betting_half_pot:.1f})が非常に高く、チェックは利益を逃す悪手です。"

        return {
            "ev": ev_checking,
            "req_eq": 0.0,
            "realized_eq": realized_equity,
            "evaluation": result_eval,
            "reason": result_reason
        }

    @staticmethod
    def calculate_preflop_score(cards):
        """ ヒューリスティックなプリフロップスコア計算 (Chen Formula ベース近似) """
        if not cards or len(cards) != 2: return 0.0
        from treys import Card
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
        
        # Pair bonus
        if r1 == r2:
            base_score = max(5.0, base_score * 2.0)
            
        # Suited bonus
        if s1 == s2:
            base_score += 2.0
            
        # Connectedness bonus
        diff = abs(r1 - r2)
        if diff == 1:
            base_score += 3.0
        elif diff == 2:
            base_score += 2.0
        elif diff == 3:
            base_score += 1.0
            
        return base_score

class PokerEngine:
    STREETS = ["PREFLOP", "FLOP", "TURN", "RIVER"]
    
    def __init__(self):
        self.hero_stack = 100
        self.cpu_stack = 100
        self.pot_size = 0
        self.street = "PREFLOP"
        self.evaluator = Evaluator()
        self.treys_evaluator = TreysEvaluator()
        self.deck = Deck()
        self.board = []
        self.hero_hand = []
        self.cpu_hand = []
        
        self.hero_position = "BTN"
        self.cpu_position = "BB"
        
        # Initialize flat combinations mapped to their preflop starting equities
        self.hero_range_dict = ranges.get_range_by_category(self.hero_position, action="open").copy()
        self.cpu_range_dict = ranges.get_range_by_category(self.cpu_position, action="open").copy()
        
        self.cpu_tendency = "BALANCED"
        self.POSITIONS = ["UTG", "HJ", "CO", "BTN", "SB", "BB"]
        
        self.hero_invested = 0.0
        self.cpu_invested = 0.0
        self.current_bet = 0.0
        
        self.aggressor = None
        self.action_history = []
        self.cpu_last_action_intent = None
        
    def is_hero_turn(self):
        """ True if Hero acts, False if CPU acts. """
        preflop_order = ["UTG", "HJ", "CO", "BTN", "SB", "BB"]
        postflop_order = ["SB", "BB", "UTG", "HJ", "CO", "BTN"]
        
        if self.street == "PREFLOP":
             return preflop_order.index(self.hero_position) < preflop_order.index(self.cpu_position)
        else:
             return postflop_order.index(self.hero_position) < postflop_order.index(self.cpu_position)
             
    @property
    def is_hero_ip(self):
        """ True if Hero acts last postflop (In Position) """
        postflop_order = ["SB", "BB", "UTG", "HJ", "CO", "BTN"]
        return postflop_order.index(self.hero_position) > postflop_order.index(self.cpu_position)
        
    def start_new_hand(self):
        self.street = "PREFLOP"
        self.hero_stack = 100.0
        self.cpu_stack = 100.0
        self.pot_size = 1.5 # The SB and BB pre-exist in a standard 6-max
        self.current_bet = 1.0 # BB
        self.hero_invested = 0.0
        self.cpu_invested = 0.0
        self.cpu_hand = []
        
        self.aggressor = None
        self.action_history = []
        self.cpu_last_action_intent = None
        
        self.deal()
        
        # Reset ranges based on new randomized positions
        if self.is_hero_turn():
             # Hero acts first
             self.hero_range_dict = ranges.get_range_by_category(self.hero_position, action="open").copy()
             if self.cpu_position == "BB":
                 action_str = f"vs_{self.hero_position}"
             else:
                 action_str = "vs_open_call"
             self.cpu_range_dict = ranges.get_range_by_category(self.cpu_position, action=action_str).copy()
        else:
             # CPU acts first
             self.cpu_range_dict = ranges.get_range_by_category(self.cpu_position, action="open").copy()
             if self.hero_position == "BB":
                 action_str = f"vs_{self.cpu_position}"
             else:
                 action_str = "vs_open_call"
             self.hero_range_dict = ranges.get_range_by_category(self.hero_position, action=action_str).copy()
        
        # Deduct from stacks if they are actually the blinds
        if self.hero_position == "SB":
            self.hero_stack -= 0.5
            self.hero_invested = 0.5
        elif self.hero_position == "BB":
            self.hero_stack -= 1.0
            self.hero_invested = 1.0
            
        if self.cpu_position == "SB":
            self.cpu_stack -= 0.5
            self.cpu_invested = 0.5
        elif self.cpu_position == "BB":
            self.cpu_stack -= 1.0
            self.cpu_invested = 1.0

    def record_action(self, actor, action, amount, equity, pot_size):
        if action in ["BET", "RAISE"]:
            self.aggressor = actor
            
        self.action_history.append({
            "street": self.street,
            "actor": actor,
            "action": action,
            "amount": amount,
            "equity": equity,
            "pot_size": pot_size
        })

    def deal(self):
        """ 実際のカードを配布し、ポジションをランダム決定する """
        self.deck.shuffle()
        self.board = []
        self.hero_hand = self.deck.draw(2)
        
        # Randomize positions
        positions = list(self.POSITIONS)
        random.shuffle(positions)
        self.hero_position = positions[0]
        self.cpu_position = positions[1]
        
    def place_bet(self, actor, amount):
        if amount <= 0: return
        if actor == "HERO":
            amount = min(amount, self.hero_stack)
            self.hero_stack -= amount
            self.hero_invested += amount
            self.pot_size += amount
            if self.hero_invested > self.current_bet:
                self.current_bet = self.hero_invested
        else:
            amount = min(amount, self.cpu_stack)
            self.cpu_stack -= amount
            self.cpu_invested += amount
            self.pot_size += amount
            if self.cpu_invested > self.current_bet:
                self.current_bet = self.cpu_invested

    def advance_street(self, street_name):
        self.street = street_name
        self.current_bet = 0.0
        self.hero_invested = 0.0
        self.cpu_invested = 0.0
        if street_name == "FLOP":
            self.board = self.deck.draw(3)
        elif street_name in ["TURN", "RIVER"]:
            drawn = self.deck.draw(1)
            self.board.append(drawn[0] if isinstance(drawn, list) else drawn)

    def get_hand_str(self, cards):
        if not cards: return "[]"
        if not isinstance(cards, list):
            cards = [cards]
        return "[" + " ".join([Card.int_to_str(c) for c in cards]) + "]"

    def analyze_board_texture(self, board):
        if len(board) < 3: return "NEUTRAL"
        suits = [Card.get_suit_int(c) for c in board]
        ranks = [Card.get_rank_int(c) for c in board]
        
        suit_counts = {s: suits.count(s) for s in set(suits)}
        max_suit = max(suit_counts.values()) if suit_counts else 0
        
        sorted_ranks = sorted(ranks, reverse=True)
        is_connected = False
        if len(sorted_ranks) >= 3:
            if sorted_ranks[0] - sorted_ranks[2] <= 4:
                is_connected = True
                
        if max_suit >= 3 or (max_suit >= 2 and is_connected):
            return "WET"
        elif max_suit <= 1 and not is_connected:
            return "DRY"
        return "NEUTRAL"

    def classify_board_texture(self, board):
        """
        board: Board Cards
        return: 'dry', 'semi_wet', 'wet', 'paired', 'monotone'
        """
        if len(board) == 0:
             return "dry"
        
        from treys import Card
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

    def get_nuts_advantage(self, board_texture, hero_pos):
        """
        簡易近似ロジック: -1.0 ~ 1.0
        Returns probability scalar. + = IP advantaged, - = OOP advantaged.
        """
        if board_texture == "paired":
            return 0.3
        if board_texture == "dry":
            return 0.2
        if board_texture == "wet":
            return -0.2
        return 0.0

    def _normalize_range(self, weights):
        floor_val = 0.05
        # Ensure k is treated as key
        for k in list(weights.keys()):
            if weights[k] < floor_val:
                 weights[k] = floor_val
        total = sum(weights.values())
        if total > 0:
            for k in list(weights.keys()):
                weights[k] /= total
        return weights

    def update_range_dict(self, actor, action, action_amount=0):
        current_dict = self.hero_range_dict if actor == "HERO" else self.cpu_range_dict
        
        action_type = "CHECK" # default no-op essentially
        
        if action in ["BET", "RAISE"]:
             ratio = action_amount / max(1.0, self.pot_size)
             if ratio >= 0.5:  
                 action_type = "LARGE_BET"
             else:
                 action_type = "SMALL_BET"
        elif action == "CALL":
             action_type = "CALL"
        elif action == "FOLD":
             action_type = "FOLD"
             
        # Only re-weight for actions that physically alter GTO distributions
        if action_type in ["LARGE_BET", "SMALL_BET", "CALL", "FOLD"]:
             updated_dict = ranges.update_range_after_action(current_dict, action_type, action_amount, self.board, self.treys_evaluator)
        else:
             updated_dict = current_dict
             
        if actor == "HERO":
            self.hero_range_dict = updated_dict
        else:
            self.cpu_range_dict = updated_dict

    @staticmethod
    def calculate_theoretical_bluff_frequency(bet_size, pot):
        """
        GTO理論に基づく適切なブラフ割合（Bluff-to-Value Ratio）を計算する。
        相手のブラフキャッチャーをインディファレントにするための正しい数式:
            GTO Bluff Ratio = Bet / (Pot + 2 * Bet)

        ※ Bet / (Pot + Bet) は Alpha（必要フォールド頻度）であり別概念。
        """
        if bet_size <= 0:
            return 0.0
        if pot + 2 * bet_size == 0:
            return 0.0
        return bet_size / (pot + 2 * bet_size)


    def generate_realized_cpu_hand(self):
        """ ショーダウン用に、現在のCPUレンジ（cpu_range_dict）とデッドカードを考慮して、
            確率に基づいた特定の物理的なハンド（Card int配列）を1つ確定させる。
        """
        dead_cards = [Card.int_to_str(c) for c in self.hero_hand] + [Card.int_to_str(c) for c in self.board]
        valid_combos_weighted = []
        for combo_str, weight in self.cpu_range_dict.items():
            if weight <= 0.0: continue
            parsed = ranges.parse_combo(combo_str)
            for specific_cards in parsed:
                if not any(c in dead_cards for c in specific_cards):
                    valid_combos_weighted.append((specific_cards, weight))
        
        if not valid_combos_weighted:
            self.cpu_hand = []
            return
            
        if self.cpu_last_action_intent == "BLUFF":
            cutoff = len(valid_combos_weighted) // 2
            if cutoff > 0:
                valid_combos_weighted = valid_combos_weighted[cutoff:]
            
        import random
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
                    
        self.cpu_hand = [Card.new(c) for c in chosen_str]



    def update_pot(self, amount):
        self.pot_size += amount

    def cpu_decide(self, cpu_equity, opponent_action, opponent_bet_size):
        """ 理想的な動きをするCPU (GTO/Math-based basis) 
            Enforces strict sizing constraints and Range advantage heuristics. 
        """
        is_preflop = (self.street == "PREFLOP")
        hero_range_adv = EquityCalculator.calc_range_advantage(self.hero_hand, self.board, self.hero_range_dict, self.cpu_range_dict, is_preflop=is_preflop, iterations=500)
        cpu_range_adv = 1.0 - hero_range_adv

        # 疑似的な手札の強さを生成（レンジの強さ ± 30%のブレ）
        effective_equity = cpu_range_adv + random.uniform(-0.3, 0.3)
        effective_equity = max(0.01, min(0.99, effective_equity))
        
        if opponent_action in ["BET", "RAISE"]:
            # CPU faces a bet
            e_req = self.evaluator.calculate_required_equity(opponent_bet_size, self.pot_size)
            
            # Note: `cpu_equity` is pre-calculated and passed natively from the engine router (e.g. app.py).
            # The value CPU thinks it has when it looks down at its hand vs User's actual play in this test framework. 
            # Actually in the MVP PokerEngine, self.hero_hand belongs to the HUMAN.
            # And the CPU doesn't have explicit hole cards! It defines itself BY its range.
            # Therefore, 'cpu_equity' is actually the average equity of the CPU's RANGE against the Human's known cards.
            
            is_preflop = (self.street == "PREFLOP")
            if is_preflop:
                if opponent_bet_size <= 4:
                    raise_mult = PREFLOP_3BET["IP"] if self.is_hero_ip else PREFLOP_3BET["OOP"]
                else:
                    raise_mult = random.choice([2.2, 2.5]) # 4-bet+ is smaller
                base_raise_amount = opponent_bet_size * raise_mult
            else:
                mult_table = RAISE_MULTIPLIER.get(self.street, RAISE_MULTIPLIER["FLOP"])
                
                # Phase 17: Nuts Advantage probabilistic sizing scaling
                texture = self.classify_board_texture(self.board)    
                nuts_adv = self.get_nuts_advantage(texture, self.hero_position)
                cpu_nuts = -nuts_adv if self.is_hero_ip else nuts_adv
                large_bet_weight = 1.0 + (cpu_nuts * 0.5)
                
                large_prob = 0.2 # デフォルトを20%に下げ、ポラライズしすぎを防ぐ
                large_prob *= large_bet_weight
                large_prob = max(0.0, min(1.0, large_prob))

                if effective_equity >= e_req * 1.5: # Extreme equity = always large.
                    mult = mult_table["large"]
                elif effective_equity >= e_req * 1.2: 
                    # Probabilistic scale between large and medium based on Nuts Ad
                    mult = mult_table["large"] if random.random() < large_prob else mult_table["medium"]
                else: # Bluff or min
                    mult = mult_table["small"]
                # Postflop sizing strictly matches multi base
                base_raise_amount = opponent_bet_size * mult
            
            # Mathematical MDF Bluff Generation vs Raising
            base_bluff_freq = self.calculate_theoretical_bluff_frequency(base_raise_amount, self.pot_size + opponent_bet_size)
            if self.street == "FLOP":
                bluff_threshold = base_bluff_freq * 0.9
            elif self.street == "TURN":
                bluff_threshold = base_bluff_freq * 1.0
            else:
                bluff_threshold = base_bluff_freq * 1.05
                
            # Phase 14: Board Texture Scaling Heuristics
            texture = self.classify_board_texture(self.board)
            if texture in TEXTURE_MULTIPLIER:
                 bluff_threshold *= TEXTURE_MULTIPLIER[texture]
                
            # Phase 15: Position Bluff Scaling Heuristics
            if self.is_hero_ip:  # If Hero is IP, CPU is OOP
                 bluff_threshold *= POSITION_MULTIPLIER["OOP"]
            else:                # If Hero is OOP, CPU is IP
                 bluff_threshold *= POSITION_MULTIPLIER["IP"]
                 
            # Phase 16: SPR Bluff Scaling Heuristics
            effective_stack = min(self.hero_stack, self.cpu_stack)
            spr = effective_stack / max(1.0, self.pot_size)
            if spr < 3:
                spr_mult = SPR_MULTIPLIER["low"]
            elif spr <= 6:
                spr_mult = SPR_MULTIPLIER["mid"]
            else:
                spr_mult = SPR_MULTIPLIER["high"]
            bluff_threshold *= spr_mult
                
            bluff_threshold = max(0.0, min(1.0, bluff_threshold))
            
            if effective_equity >= e_req * 1.8 or (effective_equity < e_req * 0.5 and random.random() < bluff_threshold):
                # Strong value raise
                self.cpu_last_action_intent = "VALUE" if effective_equity >= e_req * 1.8 else "BLUFF"
                return "RAISE", min(self.cpu_stack, base_raise_amount)
            elif effective_equity >= e_req * 1.4:
                self.cpu_last_action_intent = "VALUE"
                return "RAISE", min(self.cpu_stack, base_raise_amount)
            elif effective_equity >= e_req:
                return "CALL", opponent_bet_size
            else:
                return "FOLD", 0
        else:
            # CPU goes first or faces a check
            is_preflop_open = (self.street == "PREFLOP" and self.current_bet == 1.0)
            
            if is_preflop_open:
                if opponent_action == "CALL" and opponent_bet_size == 0.0:
                    ev_pass = self.evaluator.ev_check(effective_equity, self.pot_size)
                    action_if_pass = "CHECK"
                else:
                    ev_pass = 0.0
                    if self.cpu_position == "SB":
                         action_if_pass = "CALL" # Limp ok
                    else:
                         action_if_pass = "FOLD" # Play tight-aggressive
                
                # Use strict preflop opening sizes based on map
                ideal_bet_size = PREFLOP_OPENS.get(self.cpu_position, 2.5) 
                action_if_bet = "RAISE"
            else:
                ev_pass = self.evaluator.ev_check(effective_equity, self.pot_size)
                
                # Dynamic bet sizing (Postflop)
                bet_table = BET_SIZES.get(self.street, BET_SIZES["FLOP"])
                
                # Phase 17: Nuts Advantage probabilistic sizing scaling
                texture = self.classify_board_texture(self.board)    
                nuts_adv = self.get_nuts_advantage(texture, self.hero_position)
                cpu_nuts = -nuts_adv if self.is_hero_ip else nuts_adv
                large_bet_weight = 1.0 + (cpu_nuts * 0.5)
                
                large_prob = 0.2 # デフォルトを20%に下げ、ポラライズしすぎを防ぐ
                large_prob *= large_bet_weight
                large_prob = max(0.0, min(1.0, large_prob))
                
                # Range Advantage determines sizing selection basis
                if cpu_range_adv > 0.55: # Range Advantage -> High Freq Small Bet
                     target_size_ratio = bet_table["small"]
                else: # Range Disadvantage -> Polarized Freq Large Bet probabilistic switch
                     target_size_ratio = bet_table["large"] if (effective_equity > 0.8 or random.random() < large_prob) else bet_table["medium"]
                
                # Value sizing override 
                if effective_equity > 0.85: target_size_ratio = bet_table["large"]
                     
                ideal_bet_size = self.pot_size * target_size_ratio
                ideal_bet_size = max(1.0, ideal_bet_size)
                action_if_pass = "CHECK"
                action_if_bet = "BET"
                
            ev_bet = self.evaluator.ev_bet(effective_equity, self.pot_size, ideal_bet_size, fold_equity=0.3)
            
            # Mathematical MDF Bluff constraint
            base_bluff_freq = self.calculate_theoretical_bluff_frequency(ideal_bet_size, self.pot_size)
            if self.street == "FLOP":
                bluff_freq = base_bluff_freq * 0.9
            elif self.street == "TURN":
                bluff_freq = base_bluff_freq * 1.0
            else:
                bluff_freq = base_bluff_freq * 1.05
                
            # Phase 14: Board Texture Scaling Heuristics
            texture = self.classify_board_texture(self.board)
            if texture in TEXTURE_MULTIPLIER:
                 bluff_freq *= TEXTURE_MULTIPLIER[texture]
                
            # Phase 15: Position Bluff Scaling Heuristics
            if self.is_hero_ip: # If Hero is IP, CPU is OOP
                 bluff_freq *= POSITION_MULTIPLIER["OOP"]
            else:               # If Hero is OOP, CPU is IP
                 bluff_freq *= POSITION_MULTIPLIER["IP"]
                 
            # Phase 16: SPR Bluff Scaling Heuristics
            effective_stack = min(self.hero_stack, self.cpu_stack)
            spr = effective_stack / max(1.0, self.pot_size)
            if spr < 3:
                spr_mult = SPR_MULTIPLIER["low"]
            elif spr <= 6:
                spr_mult = SPR_MULTIPLIER["mid"]
            else:
                spr_mult = SPR_MULTIPLIER["high"]
            bluff_freq *= spr_mult
                
            bluff_freq = max(0.0, min(1.0, bluff_freq))
            
            is_value_bet = ev_bet > ev_pass and effective_equity > 0.6 # Strict value
            is_bluff_bet = effective_equity < 0.4 and random.random() < bluff_freq
            
            # Additional logic for Preflop Limp (action_if_pass == "CALL")
            if action_if_pass == "CALL":
                 call_cost = self.current_bet - self.cpu_invested
                 ev_call = self.evaluator.ev_call(effective_equity, self.pot_size, call_cost)
                 if is_value_bet or is_bluff_bet:
                     self.cpu_last_action_intent = "VALUE" if is_value_bet else "BLUFF"
                     return action_if_bet, ideal_bet_size
                 elif ev_call > ev_pass:
                     return "CALL", call_cost
                 else:
                     return "FOLD", 0
                     
            if is_value_bet or is_bluff_bet:
                self.cpu_last_action_intent = "VALUE" if is_value_bet else "BLUFF"
                return action_if_bet, ideal_bet_size
            else:
                return action_if_pass, 0

    def get_player_input(self):
        """ CLIからのユーザー入力を取得する """
        print("\n--- Your Turn ---")
        action = input("Enter action (FOLD, CHECK, CALL, BET, RAISE): ").strip().upper()
        amount = 0
        if action in ["BET", "RAISE"]:
            try:
                amount = float(input(f"Enter {action} amount: "))
            except ValueError:
                amount = 0
        return action, amount

def run_session(num_hands=3):
    engine = PokerEngine()
    
    for i in range(num_hands):
        print(f"\n=======================")
        print(f" Hand #{i + 1}")
        print(f"=======================")
        
        engine.pot_size = 1.5 # 1.5bb start for blinds
        engine.hero_stack = 100 - 0.5
        engine.cpu_stack = 100 - 1.0
        engine.deal() # Give player real cards
        
        if i % 2 == 0:
            engine.hero_position, engine.cpu_position = "BTN", "BB"
        else:
            engine.hero_position, engine.cpu_position = "BB", "BTN"
        
        print(f"You are: {'In Position (BTN)' if engine.is_hero_ip else 'Out of Position (BB)'}")
        print(f"Your Hand: {engine.get_hand_str(engine.hero_hand)}")
        
        for street in engine.STREETS:
            engine.advance_street(street)
            print(f"\n--- {street} ---")
            if engine.board:
                print(f"Board: {engine.get_hand_str(engine.board)}")
                
            hero_eq, cpu_eq = EquityCalculator.calc_equity_monte_carlo(engine.hero_hand, engine.board, engine.hero_range_dict, engine.cpu_range_dict, target_actor="CPU", is_preflop=(engine.street=="PREFLOP"), iterations=100)
            
            # EQR調整値の表示
            eqr_modifier = Evaluator.get_eqr_modifier(engine.hero_position, engine.hero_hand, False, engine.board)
            realized_equity = hero_eq * eqr_modifier
            print(f"Pot: {engine.pot_size}bb")
            print(f"Raw Equity: {hero_eq*100:.1f}% | EQR Mod: x{eqr_modifier:.2f} | Realized Equity: {realized_equity*100:.1f}%")
            
            # Simple alternating turns just to demonstrate evaluation
            hero_action, hero_amount = engine.get_player_input()
            
            eval_result = "N/A"
            if hero_action == "FOLD":
                cpu_mock_bet = engine.pot_size / 2
                eval_result = Evaluator.evaluate_fold(realized_equity, cpu_mock_bet, engine.pot_size)
            elif hero_action == "CALL":
                cpu_mock_bet = engine.pot_size / 2
                eval_result = Evaluator.evaluate_call(realized_equity, cpu_mock_bet, engine.pot_size)
                engine.update_pot(cpu_mock_bet * 2)
            elif hero_action == "BET":
                eval_result = Evaluator.evaluate_bet(realized_equity, hero_amount, engine.pot_size)
                engine.update_pot(hero_amount)
            elif hero_action == "RAISE":
                cpu_mock_bet = engine.pot_size / 2
                eval_result = Evaluator.evaluate_raise(realized_equity, hero_amount, cpu_mock_bet, engine.pot_size)
                engine.update_pot(hero_amount)
            elif hero_action == "CHECK":
                eval_result = Evaluator.evaluate_check(realized_equity, engine.pot_size, engine.is_hero_ip)
            
            print(f"Action Evaluation: [{hero_action}] -> {eval_result}")
            
            if hero_action == "FOLD":
                print("You folded. CPU wins.")
                break
                
            # CPU turn
            opponent_bet = hero_amount if hero_action in ["BET", "RAISE"] else 0
            cpu_action, cpu_amount = engine.cpu_decide(cpu_eq, hero_action, opponent_bet)
            print(f"CPU Action: {cpu_action} {cpu_amount if cpu_amount > 0 else ''}")
            
            if cpu_action == "FOLD":
                break
            elif cpu_action == "CALL":
                engine.update_pot(cpu_amount)
            elif cpu_action in ["BET", "RAISE"]:
                engine.update_pot(cpu_amount)

if __name__ == "__main__":
    run_session(1)
