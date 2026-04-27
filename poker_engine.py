import random
import math
from treys import Deck, Card, Evaluator as TreysEvaluator
import ranges

from bet_sizing import (
    PREFLOP_OPENS, PREFLOP_3BET, BET_SIZES, RAISE_MULTIPLIER, 
    TEXTURE_MULTIPLIER, BLUFF_FREQ_TEXTURE_MULTIPLIER, POSITION_MULTIPLIER, SPR_MULTIPLIER,
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
    def ev_bet(equity, pot_size, bet_amount, fold_equity, villain_raise_freq=0.1):
        return EVCalculator.ev_bet(equity, pot_size, bet_amount, fold_equity, villain_raise_freq)
    
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
    def get_eqr_modifier(hero_pos, cards=None, is_3bet_pot=False, board=None, range_adv=0.5, spr=10.0, street=None):
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
            base_eqr -= 0.05 # (緩和) Air and weak pairs under-realize
        elif category == "WEAK_DRAW":
            base_eqr -= 0.05 # (緩和) 
            
        if is_3bet_pot:
            # 3bet pots punish marginal/air hands even more heavily
            if category in ["MEDIUM_MADE", "WEAK_MADE", "WEAK_DRAW", "AIR"]:
                base_eqr -= 0.05 # (緩和) 3bet pots margin penalty
                
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

        # Street-specific EQR bounds:
        # River: no draws can complete, over-realization impossible → cap at 1.0, floor 0.50
        # Turn: one card to come, draws still alive → cap at 1.15, floor 0.55
        # Flop: two cards to come, draws can over-realize → cap at 1.20, floor 0.60
        # Preflop: widest range, many streets to play → cap at 1.25, floor 0.65
        if street == "RIVER":
            return max(0.50, min(1.0, final_eqr))
        elif street == "TURN":
            return max(0.55, min(1.15, final_eqr))
        elif street == "FLOP":
            return max(0.60, min(1.20, final_eqr))
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
    def evaluate_preflop_action_gto(cards, action_taken, hero_pos, is_3bet_pot, facing_bet, cpu_pos="SB"):
        import ranges
        from bet_sizing import EVAL_OPTIMAL, EVAL_GOOD, EVAL_MARGINAL, EVAL_BAD
        
        pos_ranges = ranges.RANGES.get(hero_pos, {})
        
        if facing_bet == 0:
            call_range = pos_ranges.get("open", {})
            raise_range = pos_ranges.get("open", {})
            fold_msg = "オープン可能なハンドです。"
        elif not is_3bet_pot:
            if hero_pos == "BB":
                # BBは相手のポジションによってコールレンジが変わるが、デフォルトとしてvs_open_callを使用
                call_range = pos_ranges.get(f"vs_{cpu_pos}", pos_ranges.get("vs_open_call", {}))
            else:
                call_range = pos_ranges.get("vs_open_call", {})
            raise_range = pos_ranges.get("vs_open_3bet", pos_ranges.get("3bet", {}))
            fold_msg = "このポジションの推奨レンジでは参加しにくいハンドです。"
        else:
            call_range = pos_ranges.get("vs_3bet_call", {})
            raise_range = pos_ranges.get("vs_3bet_4bet", pos_ranges.get("4bet_bluff", {}))
            fold_msg = "3-Bet/4-Betに対してはフォールドが基本となるハンドです。"
            
        combo_str = Evaluator.get_combo_str(cards, ranges.ALL_HANDS_DICT)
        reason_txt = ranges.get_hand_reason(combo_str)
        
        call_weight = call_range.get(combo_str, 0.0)
        raise_weight = raise_range.get(combo_str, 0.0)
        
        # 評価判定
        if action_taken == "CALL":
            if call_weight > 0:
                classification = ranges.classify_range(call_weight)
                return "play", EVAL_GOOD, f"【良い選択】このハンドでのコールは基本的なプレイです。 {reason_txt}"
            elif raise_weight > 0:
                classification = ranges.classify_range(raise_weight)
                return "fold", EVAL_BAD, f"【レイズ推奨】このハンドはコールよりレイズして主導権を握る方が効果的です。 {reason_txt}"
            else:
                return "fold", EVAL_BAD, f"【改善余地あり】{fold_msg} {reason_txt}"

        elif action_taken == "RAISE":
            if raise_weight > 0:
                classification = ranges.classify_range(raise_weight)
                return "play", EVAL_OPTIMAL, f"【推奨】良いレイズ(3-Bet/4-Bet)です。主導権を握りましょう。 {reason_txt}"
            elif call_weight > 0:
                classification = ranges.classify_range(call_weight)
                return "mix", EVAL_MARGINAL, f"【コール推奨】このハンドはレイズよりコールで参加する方が無難です。 {reason_txt}"
            else:
                return "fold", EVAL_BAD, f"【改善余地あり】{fold_msg} {reason_txt}\n(ブラフとして打つ場合は頻度に注意してください)"

        elif action_taken == "FOLD":
            if raise_weight > 0.5:
                return "mix", EVAL_BAD, f"【フォールド過多】強いハンドです。レイズで参加することを検討しましょう。 {reason_txt}"
            elif call_weight > 0.5:
                return "mix", EVAL_BAD, f"【フォールド過多】コールできる強さのハンドです。相手にブラフの余地を与えすぎないようにしましょう。 {reason_txt}"
            elif raise_weight > 0 or call_weight > 0:
                return "play", EVAL_MARGINAL, f"【やや降り過ぎ】プレイできるハンドです。頻繁にフォールドすると相手に読まれやすくなります。 {reason_txt}"
            else:
                return "play", EVAL_OPTIMAL, f"【推奨】このハンドではフォールドが無難な選択です。 {fold_msg}"
                
        return "play", EVAL_GOOD, reason_txt

    @staticmethod
    def evaluate_call(equity, call_amount, pot_size, hero_pos="BTN", cards=None, is_3bet_pot=False, board=None, effective_stack=0.0, range_adv=0.5, hero_range_dict=None, street=None):
        if call_amount == 0:
            return {"ev": 0.0, "req_eq": 0.0, "realized_eq": equity, "evaluation": EVAL_OPTIMAL, "reason": "チェック可能な状況です。無料でカードを見られるときはチェックが基本です。"}
            
        preflop_prefix = ""
        # PREFLOP RANGE CHECK
        if not board:
            decision, e_eval, e_reason = Evaluator.evaluate_preflop_action_gto(cards, "CALL", hero_pos, is_3bet_pot, call_amount, cpu_pos=hero_range_dict.get("_cpu_pos", "SB") if hero_range_dict else "SB")
            preflop_prefix = e_reason + "\n"
            
            if decision == "fold":
                return {
                    "ev": 0.0, "req_eq": 0.0, "realized_eq": equity, 
                    "evaluation": e_eval, 
                    "reason": preflop_prefix
                }
            if decision == "mix":
                return {
                    "ev": 0.0, "req_eq": 0.0, "realized_eq": equity, 
                    "evaluation": e_eval, 
                    "reason": preflop_prefix
                }

        e_req = Evaluator.calculate_required_equity(call_amount, pot_size)
        eqr = Evaluator.get_eqr_modifier(hero_pos, cards, is_3bet_pot, board, range_adv, street=street)
        realized_equity = equity * eqr

        spr = None
        if effective_stack > 0 and pot_size > 0:
            spr = effective_stack / pot_size
            
        category = Evaluator.categorize_hand(cards, board)
        
        # EV computation
        ev_call_val = Evaluator.ev_call(realized_equity, pot_size, call_amount, spr=spr, hand_category=category)
        
        result_eval = EVAL_BAD
        result_reason = preflop_prefix

        # equity が高い順に判定する（低equity + implied odds が高equity より良い評価になる逆転を防ぐ）
        if realized_equity >= e_req * Evaluator.CALL_OPTIMAL_THRESHOLD:
            result_eval = EVAL_OPTIMAL
            result_reason += f"リスクに対して勝率({realized_equity*100:.1f}%)が十分に高く、極めて優位なコールです。"
        elif realized_equity >= e_req:
            result_eval = EVAL_GOOD
            result_reason += f"ベット額に対して見合う勝率({realized_equity*100:.1f}%)があり、妥当な防衛（コール）です。"
        elif realized_equity >= e_req * Evaluator.CALL_MARGINAL_THRESHOLD:
            if ev_call_val > 0:
                # オッズにわずかに届かないが、インプライドオッズでプラスEV
                result_eval = EVAL_GOOD
                result_reason += f"現在の勝率({realized_equity*100:.1f}%)はオッズにわずかに届いていませんが、後のラウンドで稼げる可能性（インプライドオッズ）を加味すれば利益的なコールです。"
            else:
                result_eval = EVAL_MARGINAL
                result_reason += f"勝率({realized_equity*100:.1f}%)がオッズに届いていません。相手のブラフをキャッチするなどの明確な理由がない限り、頻繁なコールは控えましょう。"
        elif ev_call_val > 0:
            # 大きくオッズに届かないが、強いインプライドオッズ（強いドロー等）でプラスEV
            result_eval = EVAL_MARGINAL
            result_reason += f"現在の勝率({realized_equity*100:.1f}%)はオッズにあっていませんが、後のラウンドで大きく稼げる可能性（インプライドオッズ）を加味すれば利益的なコールです。"
        else:
            result_eval = EVAL_BAD
            result_reason += f"【見送り推奨】相手のベット額に対してハンドの強さが見合っていません。フォールドも選択肢として検討してみましょう。"
            
        return {
            "ev": ev_call_val,
            "req_eq": e_req,
            "realized_eq": realized_equity,
            "evaluation": result_eval,
            "reason": result_reason
        }

    @staticmethod
    def evaluate_fold(equity, opponent_bet_size, pot_size, hero_pos="BTN", cards=None, is_3bet_pot=False, board=None, range_adv=0.5, street=None):
        if opponent_bet_size == 0:
            return {"ev": 0.0, "req_eq": 0.0, "realized_eq": equity, "evaluation": EVAL_BAD, "reason": "ベットがない状況でのフォールドは不利な選択です。無料でカードを見られる場合はチェックを選びましょう。"}
            
        # PREFLOP RANGE CHECK
        if not board:
            import ranges
            decision, e_eval, e_reason = Evaluator.evaluate_preflop_action_gto(cards, "FOLD", hero_pos, is_3bet_pot, opponent_bet_size, cpu_pos="SB")
            if decision == "mix": # FOLDing a good hand is bad
                return {
                    "ev": 0.0, "req_eq": 0.0, "realized_eq": equity, 
                    "evaluation": e_eval, 
                    "reason": e_reason
                }
            # Optional: if play and optimal (correct fold), you can just return the optimal directly
            if decision == "play" and e_eval == EVAL_OPTIMAL:
                return {
                    "ev": 0.0, "req_eq": 0.0, "realized_eq": equity, "evaluation": EVAL_OPTIMAL, "reason": e_reason
                }
            
        e_req = Evaluator.calculate_required_equity(opponent_bet_size, pot_size)
        mdf = Evaluator.calculate_mdf(opponent_bet_size, pot_size)
        eqr = Evaluator.get_eqr_modifier(hero_pos, cards, is_3bet_pot, board, range_adv, street=street)
        realized_equity = equity * eqr
        
        result_eval = EVAL_OPTIMAL
        result_reason = ""
        
        if realized_equity >= e_req * Evaluator.FOLD_OPTIMAL_THRESHOLD:
            result_eval = EVAL_BAD
            result_reason = f"【リスク回避過多】十分に勝てる見込みがあるハンド({realized_equity*100:.1f}%)を捨ててしまいました。期待値の観点からマイナスのプレイであり、コールかレイズすべきでした。"
        elif realized_equity >= e_req:
            result_eval = EVAL_MARGINAL
            result_reason = f"【フォールド過多】オッズに見合う勝率({realized_equity*100:.1f}%)を持っています。フォールドは消極的すぎるかもしれません。"
        elif realized_equity >= (e_req - 0.02):
            # ▼ MDF考慮: 勝率がオッズに2%以内のボーダーラインスポット
            result_eval = EVAL_MARGINAL
            result_reason = (
                f"【ボーダーライン】オッズにわずかに届きません（あなたの勝率: {realized_equity*100:.1f}% / 必要: {e_req*100:.1f}%）。"
                f"毎回フォールドすると相手に読まれやすくなるため、時にはコールも検討できます。"
            )
        else:
            result_eval = EVAL_OPTIMAL
            result_reason = f"逆転の確率({realized_equity*100:.1f}%)が低いため、無駄なチップの支払いを避ける適切なフォールドです。"
            
        return {
            "ev": 0.0,  # Fold EV is always 0
            "req_eq": e_req,
            "mdf": round(mdf, 3),
            "realized_eq": realized_equity,
            "evaluation": result_eval,
            "reason": result_reason
        }

    @staticmethod
    def evaluate_bet(equity, bet_amount, pot_size, hero_pos="BTN", cards=None, board=None, range_adv=0.5, effective_stack=0.0, street=None):
        from bet_sizing import evaluate_bet_sizing, get_spr_size_adjustment
        from hand_classifier import HandClassifier

        # Street-dependent margin: River=0.15, Turn=0.10, Flop/Pre=0.05
        if street == "RIVER":
            margin_pct = 0.15
        elif street == "TURN":
            margin_pct = 0.10
        else:
            margin_pct = Evaluator.BET_OPTIMAL_MARGIN_PCT

        eqr = Evaluator.get_eqr_modifier(hero_pos, cards, False, board, range_adv, street=street)
        realized_equity = equity * eqr

        # SPR計算
        spr = None
        if effective_stack > 0 and pot_size > 0:
            spr = effective_stack / pot_size

        # Fold Equity Estimate using MDF threshold
        fold_equity = bet_amount / (pot_size + bet_amount)
        
        ev_betting = Evaluator.ev_bet(realized_equity, pot_size, bet_amount, fold_equity)
        ev_checking = Evaluator.ev_check(realized_equity, pot_size)

        # ボードテクスチャ別サイジング評価
        texture = "dry"
        sizing_feedback = ""
        if board and len(board) >= 3:
            texture = HandClassifier.classify_board_texture(board)
            sizing_result = evaluate_bet_sizing(pot_size, bet_amount, texture, spr=spr)
            if sizing_result["evaluation"] in ("△", "×"):
                sizing_feedback = f"\n\n📐 サイジング: {sizing_result['reason']}"
        
        result_eval = EVAL_BAD
        if ev_betting > ev_checking + (margin_pct * pot_size):
            result_eval = EVAL_OPTIMAL
            if range_adv > 0.55:
                result_reason = f"【推奨】レンジ優位がある状況でのベットは効果的です。アグレッシブに主導権を握りましょう。"
            elif realized_equity < 0.35:
                result_reason = f"【推奨】ハンドは弱めですが、相手を降ろせる可能性（フォールドエクイティ）を活かしたブラフとして機能します。"
            else:
                result_reason = f"【推奨・バリュー】チェックよりベットの方が期待値が高い状況です。バリューとプレッシャーを兼ね備えた良い選択です。"
        elif ev_betting >= ev_checking:
            result_eval = EVAL_GOOD
            result_reason = f"【良い選択】ベットによる期待値がチェックをわずかに上回っています。プレッシャーをかける妥当なアクションです。"
        elif ev_betting >= ev_checking - (margin_pct * pot_size):
            result_eval = EVAL_MARGINAL
            result_reason = "【どちらでも】ベットとチェックの期待値が拮抗しています。状況に応じてアクションを混ぜることで相手に読まれにくくなります。"
        else:
            result_eval = EVAL_BAD
            result_reason = f"【改善余地あり】この状況ではチェックして様子を見る方が期待値が高い可能性があります。"

        return {
            "ev": ev_betting,
            "req_eq": 0.0,
            "realized_eq": realized_equity,
            "evaluation": result_eval,
            "reason": result_reason + sizing_feedback
        }


    @staticmethod
    def evaluate_raise(equity, raise_amount, opponent_bet_size, pot_size, hero_pos="BTN", cards=None, board=None, range_adv=0.5, hero_range_dict=None, street=None):
        preflop_prefix = ""
        # PREFLOP RANGE CHECK
        if not board:
            decision, e_eval, e_reason = Evaluator.evaluate_preflop_action_gto(cards, "RAISE", hero_pos, is_3bet_pot=False, facing_bet=opponent_bet_size, cpu_pos=hero_range_dict.get("_cpu_pos", "SB") if hero_range_dict else "SB")
            preflop_prefix = e_reason + "\n"
            
            if decision == "fold" or decision == "mix":
                return {
                    "ev": 0.0, "req_eq": 0.0, "realized_eq": equity, 
                    "evaluation": e_eval, 
                    "reason": preflop_prefix
                }
                
        # Street-dependent margin for raise evaluation
        if street == "RIVER":
            raise_margin_pct = 0.15
        elif street == "TURN":
            raise_margin_pct = 0.10
        else:
            raise_margin_pct = Evaluator.BET_OPTIMAL_MARGIN_PCT

        eqr = Evaluator.get_eqr_modifier(hero_pos, cards, False, board, range_adv, street=street)
        realized_equity = equity * eqr

        # Calculate fold equity dynamically via MDF.
        # FE = bet / (pot + bet)
        total_pot = pot_size + opponent_bet_size
        fold_equity = raise_amount / (total_pot + raise_amount)

        ev_raising = Evaluator.ev_bet(realized_equity, total_pot, raise_amount, fold_equity)
        ev_calling = Evaluator.ev_call(realized_equity, pot_size, opponent_bet_size)

        if ev_raising > ev_calling + (raise_margin_pct * total_pot):
            result_eval = EVAL_OPTIMAL
            if range_adv > 0.55:
                result_reason = preflop_prefix + f"【推奨】レンジ優位がある状況でのレイズは効果的です。アグレッシブに主導権を握りましょう。"
            elif realized_equity < 0.35:
                result_reason = preflop_prefix + f"【推奨】ハンドは弱めですが、相手を降ろせる可能性（フォールドエクイティ）を活かしたブラフレイズとして機能します。"
            else:
                result_reason = preflop_prefix + f"【推奨・バリュー】コールよりレイズの方が期待値が高い状況です。バリューとプレッシャーを兼ね備えた良い選択です。"
        elif ev_raising >= ev_calling:
            result_eval = EVAL_GOOD
            result_reason = preflop_prefix + f"【良い選択】レイズの期待値がコールをわずかに上回っています。積極的なアクションとして妥当です。"
        elif ev_raising >= ev_calling - (raise_margin_pct * total_pot):
            result_eval = EVAL_MARGINAL
            result_reason = preflop_prefix + "【どちらでも】レイズとコールの期待値が拮抗しています。状況に応じてアクションを混ぜることで相手に読まれにくくなります。"
        else:
            result_eval = EVAL_BAD
            result_reason = preflop_prefix + f"【改善余地あり】この状況ではコールかフォールドの方が期待値が高い可能性があります。レイズはリスクが高めです。"

        return {
            "ev": ev_raising,
            "req_eq": 0.0,
            "realized_eq": realized_equity,
            "evaluation": result_eval,
            "reason": result_reason
        }

    @staticmethod
    def evaluate_check(equity, pot_size, hero_pos="BTN", has_initiative=False, is_hero_ip=False, cards=None, board=None, range_adv=0.5, street=None):
        if not has_initiative and not is_hero_ip:
            # OOP で先にチェック: 標準的なパッシブプレイ（ドンクベットは上級者向け）
            return {"ev": 0.0, "req_eq": 0.0, "realized_eq": equity, "evaluation": EVAL_GOOD, "reason": "ポジション不利（OOP）でアグレッサーでもない場合、まずチェックして相手のアクションを見てからディフェンスするのが基本です。"}
        # IP かつ no-initiative（相手がチェック → ヒーローにベット/チェックバックの選択権）は
        # has_initiative=True と同様に EV 評価へ。強いハンドでのチェックバックを正しく罰する。
            
        eqr = Evaluator.get_eqr_modifier(hero_pos, cards, False, board, range_adv, street=street)
        realized_equity = equity * eqr
        ev_checking = Evaluator.ev_check(realized_equity, pot_size)
        
        # 強いハンドは EV 比較に依らず直接評価（バリューミスは常に BAD）
        if realized_equity >= 0.65:
            return {
                "ev": ev_checking,
                "req_eq": 0.0,
                "realized_eq": realized_equity,
                "evaluation": EVAL_BAD,
                "reason": "【バリューの取り逃し】非常に強いハンドです。チェックすると相手に無料でカードを見せてしまいます。バリューベットして相手からチップを引き出しましょう。"
            }

        # Compare vs half-pot bet using realistic fold equity.
        # alpha (= bet/(pot+bet) = 1/3 for half-pot) は理論的最低折たたみ率であり、
        # これを fold_equity に使うと ev_check/ev_bet の比が equity に関わらず
        # 常に約 0.833 の定数になってしまい、閾値の 0.8/0.5 に全く引っかからない。
        # 実際の折たたみ率 55% を使うことで equity に応じた正しい差別化が可能になる。
        half_pot = pot_size / 2.0
        fold_equity = 0.55
        ev_betting_half_pot = Evaluator.ev_bet(realized_equity, pot_size, half_pot, fold_equity)

        if ev_checking >= ev_betting_half_pot:
            result_eval = EVAL_OPTIMAL
            if range_adv < 0.45:
                result_reason = "【推奨】相手のレンジが強い可能性が高いため、チェックでポットを抑えるのが無難な選択です。"
            else:
                result_reason = "【推奨】チェックして様子を見るのが良い選択です。無駄なリスクを避けられます。"
        elif ev_checking >= ev_betting_half_pot * 0.75:
            result_eval = EVAL_GOOD
            result_reason = "【妥当】チェックしてポットを小さく保つ（ポットコントロール）のは妥当な選択です。"
        elif ev_checking >= ev_betting_half_pot * 0.55:
            result_eval = EVAL_MARGINAL
            result_reason = "【やや消極的】ベットしてプレッシャーをかけるべき状況かもしれませんが、チェックで様子を見るのも手です。"
        else:
            result_eval = EVAL_BAD
            result_reason = "【ブラフの機会損失】ハンドは弱いですが、ベットすることで相手を降ろせる可能性（フォールドエクイティ）があります。この状況でチェックするとフォールドエクイティを無駄にしています。"

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
        self.cpu_effective_equity = None  # cpu_decide()でサンプリングした実効エクイティ（ショーダウン手選択に使用）

        # ハンドカウンター（5回に1回レンジ内からハンドを選ぶ）
        self.hand_count = 0
        # ハンド終了フラグ（リロード時の状態復元に使用）
        self.hand_finished = False
        
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
        self.cpu_effective_equity = None

        self.hand_count += 1
        self.hand_finished = False
        self.deal()
        
        # Reset ranges based on new randomized positions
        if self.is_hero_turn():
             # Hero acts first
             self.hero_range_dict = ranges.get_range_by_category(self.hero_position, action="open").copy()
             self.cpu_range_dict = ranges.get_range_by_category(self.cpu_position, action="vs_open_call").copy()
        else:
             # CPU acts first
             self.cpu_range_dict = ranges.get_range_by_category(self.cpu_position, action="open").copy()
             self.hero_range_dict = ranges.get_range_by_category(self.hero_position, action="vs_open_call").copy()
        
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

    def _pick_range_combo(self, pos):
        """ポジションのGTOレンジから重み付きランダムでコンボを1つ選び (r1str, r2str, is_suited) を返す。失敗時None"""
        try:
            from ranges import position_ranges
            # PokerEngine の POSITIONS は "UTG" だが position_ranges のキーは "LJ"
            pos_alias = {"UTG": "LJ"}.get(pos, pos)
            pos_range = position_ranges.get(pos_alias, {})
            if not pos_range:
                return None
            combos = list(pos_range.items())
            weights = [max(0.01, w) for _, w in combos]
            chosen = random.choices(combos, weights=weights, k=1)[0][0]
            suits_list = ['s', 'h', 'd', 'c']
            if len(chosen) == 2:   # ペア e.g. "AA"
                r = chosen[0]
                s1, s2 = random.sample(suits_list, 2)
                return (r + s1, r + s2)
            elif chosen.endswith('s'):  # スーテッド e.g. "AKs"
                r1, r2 = chosen[0], chosen[1]
                suit = random.choice(suits_list)
                return (r1 + suit, r2 + suit)
            else:                  # オフスート e.g. "AKo"
                r1, r2 = chosen[0], chosen[1]
                s1, s2 = random.sample(suits_list, 2)
                return (r1 + s1, r2 + s2)
        except Exception:
            return None

    def deal(self):
        """ 実際のカードを配布し、ポジションをランダム決定する """
        self.deck.shuffle()
        self.board = []

        # Randomize positions
        positions = list(self.POSITIONS)
        random.shuffle(positions)
        self.hero_position = positions[0]
        self.cpu_position = positions[1]

        # スポット練習モード: 常にGTOレンジ内のハンドを配布
        force_range = getattr(self, 'spot_mode', False) or (self.hand_count > 0 and self.hand_count % 4 == 0)
        if force_range:
            combo = self._pick_range_combo(self.hero_position)
            if combo:
                try:
                    c1 = Card.new(combo[0])
                    c2 = Card.new(combo[1])
                    if c1 in self.deck.cards and c2 in self.deck.cards and c1 != c2:
                        self.deck.cards.remove(c1)
                        self.deck.cards.remove(c2)
                        self.hero_hand = [c1, c2]
                        return
                except Exception:
                    pass

        self.hero_hand = self.deck.draw(2)
        
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
        pos = self.hero_position if actor == "HERO" else self.cpu_position
        
        # PREFLOP SPECIFIC OVERRIDES
        if self.street == "PREFLOP":
            num_raises = sum(1 for a in self.action_history if a["action"] in ["BET", "RAISE"])
            if action in ["BET", "RAISE"]:
                if num_raises == 0:
                    new_dict = ranges.get_range_by_category(pos, action="open").copy()
                elif num_raises == 1:
                    new_dict = ranges.get_range_by_category(pos, action="3bet").copy()
                else:
                    new_dict = ranges.get_range_by_category(pos, action="4bet_bluff").copy()
            elif action == "CALL":
                if num_raises == 0:
                    new_dict = ranges.get_range_by_category(pos, action="open").copy()
                elif num_raises == 1:
                    new_dict = ranges.get_range_by_category(pos, action="vs_open_call").copy()
                else:
                    new_dict = ranges.get_range_by_category(pos, action="vs_3bet_call").copy()
            elif action == "FOLD":
                new_dict = {k: 0.0 for k in current_dict.keys()}
            else:
                new_dict = current_dict

            if actor == "HERO":
                self.hero_range_dict = new_dict
            else:
                self.cpu_range_dict = new_dict
            return
            
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
            cpu_effective_equity（その手で実際に意思決定した強さ）に近いハンドを選択する。
            これにより「フォールドしたCPUは弱いハンドだった」が自然に再現される。
        """
        dead_cards = set(Card.int_to_str(c) for c in self.hero_hand) | set(Card.int_to_str(c) for c in self.board)
        valid_combos = []
        for combo_str, weight in self.cpu_range_dict.items():
            if weight <= 0.0:
                continue
            parsed = ranges.parse_combo(combo_str)
            for specific_cards in parsed:
                if not any(c in dead_cards for c in specific_cards):
                    valid_combos.append((specific_cards, weight))

        if not valid_combos:
            # フォールバック: ウェイトが全滅（FOLD更新後など）した場合、
            # CPUポジションのオープンレンジから非デッドカードのコンボを平等に使う
            from ranges import position_ranges
            fallback_range = position_ranges.get(self.cpu_position, {})
            for combo_str in fallback_range:
                parsed = ranges.parse_combo(combo_str)
                for specific_cards in parsed:
                    if not any(c in dead_cards for c in specific_cards):
                        valid_combos.append((specific_cards, 1.0))
            if not valid_combos:
                self.cpu_hand = []
                return

        target_eq = getattr(self, 'cpu_effective_equity', None)

        if target_eq is not None and len(self.board) >= 3:
            # 各コンボをtreysでスコアリングし、エクイティを正規化
            scored = []
            for specific_cards, weight in valid_combos:
                try:
                    hand_ints = [Card.new(c) for c in specific_cards]
                    score = self.treys_evaluator.evaluate(self.board, hand_ints)
                    scored.append((specific_cards, weight, score))
                except Exception:
                    scored.append((specific_cards, weight, 5000))

            # treys: スコアが低いほど強い(1=ロイヤルフラッシュ, 7462=最弱)
            # 正規化: 強いほど1.0に近い値になるよう反転
            scores_only = [s for _, _, s in scored]
            min_s, max_s = min(scores_only), max(scores_only)
            score_range = max(1, max_s - min_s)

            def to_norm_eq(treys_score):
                return 1.0 - (treys_score - min_s) / score_range

            # target_eqに最も近い上位20%のコンボを候補とし、その中でweight加重サンプリング
            scored_by_dist = sorted(scored, key=lambda x: abs(to_norm_eq(x[2]) - target_eq))
            top_n = max(1, len(scored_by_dist) // 5)
            candidates = scored_by_dist[:top_n]

            total_w = sum(w for _, w, _ in candidates)
            if total_w <= 0:
                chosen_str = candidates[0][0]
            else:
                r = random.uniform(0, total_w)
                cum = 0.0
                chosen_str = candidates[0][0]
                for combo, w, _ in candidates:
                    cum += w
                    if r <= cum:
                        chosen_str = combo
                        break
        else:
            # ボードなし or target_eq未設定: weight加重ランダム選択
            total_weight = sum(w for _, w in valid_combos)
            if total_weight <= 0:
                chosen_str = random.choice(valid_combos)[0]
            else:
                r = random.uniform(0, total_weight)
                cum = 0.0
                chosen_str = valid_combos[-1][0]
                for combo, w in valid_combos:
                    cum += w
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

        # ボード対応ハンドシミュレーション:
        # cpu_equity（MCで算出したレンジ平均エクイティ）を基準に、
        # 今回CPUが保持しているハンドの強さを正規分布でサンプリングする。
        # これにより「レンジ平均は高くても今回の手は弱い」というフォールドが自然に発生する。
        # ストリートが進むほど分散を大きくし、リバーでは強弱の差が最大化する。
        street_variance = {"PREFLOP": 0.08, "FLOP": 0.14, "TURN": 0.17, "RIVER": 0.20}.get(self.street, 0.14)
        board_variance_bonus = 0.0
        if self.board:
            _tex = self.classify_board_texture(self.board)
            board_variance_bonus = {"wet": 0.06, "monotone": 0.08, "paired": 0.05, "semi_wet": 0.03, "dry": 0.00}.get(_tex, 0.00)
        effective_equity = random.gauss(cpu_equity, street_variance + board_variance_bonus)
        effective_equity = max(0.05, min(0.95, effective_equity))
        # ショーダウン手選択のために保存（最後のアクションの値が使われる）
        self.cpu_effective_equity = effective_equity
        
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
                # --- RNG混合戦略による3-Bet判定 ---
                # GTO_3BET_MATRIX からポジション対ポジションの適正3-Bet頻度を取得
                cpu_is_ip = not self.is_hero_ip  # Heroがip → CPUはOOP
                opener_pos = self.hero_position  # HeroがRFIした場合
                cpu_pos = self.cpu_position

                gto_matrix = getattr(ranges, "GTO_3BET_MATRIX", {})
                situation_3bet_freq = gto_matrix.get(cpu_pos, {}).get(opener_pos, 0.10)
                
                # 3-Betサイズ: IP=3.0x、OOP=3.5x (GTO標準サイジング)
                if cpu_is_ip:
                    raise_mult = 3.0  # インポジション: コンパクトな3-Bet
                else:
                    raise_mult = 3.5  # アウトオブポジション: 大きめ3-Bet（SPR削減）
                    
                if opponent_bet_size > 4:
                    raise_mult = random.choice([2.2, 2.5])  # 4-bet+ はより小さく
                    
                base_raise_amount = max(opponent_bet_size * raise_mult, opponent_bet_size + 2.0)

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
                # Postflop sizing strictly matches multi base (minimum: 2x opponent bet)
                base_raise_amount = max(opponent_bet_size * mult, opponent_bet_size * 2.0)
            
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
            
            # プリフロップとポストフロップで判定ロジックを分岐
            if is_preflop:
                # --- プリフロップ 3-Bet: RNG混合戦略 ---
                # バリュー3-Bet (AA/KK/QQ/AKs等の強いハンド): 常時RAISE
                if effective_equity >= e_req * 2.5:
                    self.cpu_last_action_intent = "VALUE"
                    return "RAISE", min(self.cpu_stack, base_raise_amount)
                
                # マージナルな3-Bet候補: situation_3bet_freqに基づくRNG判定
                # effective_equity が十分あり、かつGTOマトリクスの頻度上限以内の場合のみRAISE
                # 例: BB vs LJ open → situation_3bet_freq=0.056 → randはその確率でのみRAISE
                elif effective_equity >= e_req * 1.3:
                    if random.random() < situation_3bet_freq * 1.5:  # 若干余裕を持たせる
                        self.cpu_last_action_intent = "VALUE"
                        return "RAISE", min(self.cpu_stack, base_raise_amount)
                    else:
                        return "CALL", opponent_bet_size
                
                # 弱いハンドのブラフ3-Bet: さらに低確率 (ブロッカー系)
                elif effective_equity < e_req * 0.6 and random.random() < situation_3bet_freq * 0.4:
                    self.cpu_last_action_intent = "BLUFF"
                    return "RAISE", min(self.cpu_stack, base_raise_amount)
                
                # コールする価値がある (オッズに合う)
                elif effective_equity >= e_req:
                    return "CALL", opponent_bet_size
                else:
                    return "FOLD", 0
            else:
                # ポストフロップ
                if effective_equity >= e_req * 2.2 or (effective_equity < e_req * 0.65 and random.random() < bluff_threshold):
                    # 強いバリューまたはブラフ/セミブラフレイズ
                    self.cpu_last_action_intent = "VALUE" if effective_equity >= e_req * 1.8 else "BLUFF"
                    return "RAISE", min(self.cpu_stack, base_raise_amount)
                elif effective_equity >= e_req:
                    # オッズに合う: 確実にコール
                    self.cpu_last_action_intent = "CALL"
                    return "CALL", opponent_bet_size
                elif effective_equity >= e_req * 0.85:
                    # マージナルゾーン: MDF（最小防衛頻度）ベースで確率的にコール/フォールド
                    # GTOではこのゾーンのハンドを一定頻度でディフェンスする必要がある
                    mdf = self.evaluator.calculate_mdf(opponent_bet_size, self.pot_size)
                    # ベットが大きいほどMDFが低く（相手に多くフォールドを許す）なるため自然な挙動
                    if random.random() < mdf * 0.6:  # MDFの60%をコール閾値として使用
                        self.cpu_last_action_intent = "CALL"
                        return "CALL", opponent_bet_size
                    else:
                        self.cpu_last_action_intent = "FOLD"
                        return "FOLD", 0
                else:
                    # エクイティが大幅に不足: フォールド
                    self.cpu_last_action_intent = "FOLD"
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
                
            # Fix #1: fold_equityを動的計算（alpha公式）に変更。固定0.3は不正確
            fold_equity_est = ideal_bet_size / (self.pot_size + ideal_bet_size)
            # Fix #4: ストリート別にレイズ頻度を設定（リバーは少ない）
            street_raise_freq = {"FLOP": 0.12, "TURN": 0.08, "RIVER": 0.03}.get(self.street, 0.10)
            ev_bet = self.evaluator.ev_bet(effective_equity, self.pot_size, ideal_bet_size,
                                          fold_equity=fold_equity_est, villain_raise_freq=street_raise_freq)
            
            # Mathematical MDF Bluff constraint
            base_bluff_freq = self.calculate_theoretical_bluff_frequency(ideal_bet_size, self.pot_size)
            if self.street == "FLOP":
                bluff_freq = base_bluff_freq * 0.9
            elif self.street == "TURN":
                bluff_freq = base_bluff_freq * 1.0
            else:
                bluff_freq = base_bluff_freq * 1.05
                
            # Fix #3: ブラフ頻度にはベットサイズ用MULTIPLIERではなく専用乗数を使う
            # ドライ→ブラフしやすい(1.20)、ウェット→純ブラフは危険(0.75)
            texture = self.classify_board_texture(self.board)
            bluff_freq *= BLUFF_FREQ_TEXTURE_MULTIPLIER.get(texture, 1.0)
                
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
            
            # value / bluff / semibluff の閾値をストリート別に設定
            # FLOP : Cbetレンジ広め。バリュー/ブラフゾーンをほぼ接続しセミブラフも全面活用
            # TURN : ドロー残り1枚。セミブラフを適度に許容。ミドルゾーンに混合戦略
            # RIVER: ドロー完成なし。トップペア+でバリュー、純ブラフのみ。ミドルはチェック
            if self.street == "RIVER":
                value_eq_threshold = 0.54   # トップペア相当からバリューベット
                bluff_eq_threshold = 0.32   # 純ブラフのみ（バックドア程度）
                semibluff_freq_mult = 0.0   # リバーにセミブラフなし
            elif self.street == "TURN":
                value_eq_threshold = 0.52   # ミドルペア+でバリューベット
                bluff_eq_threshold = 0.42   # セミブラフ上限（強いドロー）
                semibluff_freq_mult = 0.6   # セミブラフを適度に許容
            else:  # FLOP
                value_eq_threshold = 0.50   # Cbetレンジを広く設定
                bluff_eq_threshold = 0.48   # バリュー/ブラフゾーンをほぼ接続
                semibluff_freq_mult = 1.0   # フロップはセミブラフを積極活用

            is_value_bet = ev_bet > ev_pass and effective_equity >= value_eq_threshold
            is_bluff_bet = effective_equity < bluff_eq_threshold and random.random() < bluff_freq
            # セミブラフ: バリューとブラフの間のゾーン（ドロー・中程度のペア等）
            is_semibluff_bet = (
                bluff_eq_threshold <= effective_equity < value_eq_threshold
                and random.random() < (bluff_freq * semibluff_freq_mult)
            )

            # Additional logic for Preflop Limp (action_if_pass == "CALL")
            if action_if_pass == "CALL":
                 call_cost = self.current_bet - self.cpu_invested
                 ev_call = self.evaluator.ev_call(effective_equity, self.pot_size, call_cost)
                 if is_value_bet or is_bluff_bet or is_semibluff_bet:
                     self.cpu_last_action_intent = "VALUE" if is_value_bet else "BLUFF"
                     return action_if_bet, ideal_bet_size
                 elif ev_call > ev_pass:
                     return "CALL", call_cost
                 else:
                     return "FOLD", 0

            if is_value_bet or is_bluff_bet or is_semibluff_bet:
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
