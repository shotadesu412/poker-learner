import random
import math
from treys import Deck, Card, Evaluator as TreysEvaluator
import ranges

# GTO Theory Constraints: https://link-to-gto-sizing-rules.domain (Implemented Phase 12)
PREFLOP_OPENS = {
    "UTG": 2.5,
    "MP": 2.5,
    "CO": 2.3,
    "BTN": 2.2,
    "SB": 2.5,
    "BB": 0.0 # BB does not strictly open
}

PREFLOP_3BET = {
    "IP": 2.8,
    "OOP": 3.5
}

BET_SIZES = {
    "FLOP": {"small": 0.25, "medium": 0.50, "large": 0.75}, # Pot fraction
    "TURN": {"small": 0.33, "medium": 0.66, "large": 1.00},
    "RIVER": {"small": 0.50, "medium": 1.00, "large": 1.50}  # 1.5 = Overbet
}

RAISE_MULTIPLIER = { # Generalized Fallback postflop multi
    "FLOP": {"small": 2.5, "medium": 3.0, "large": 3.5},
    "TURN": {"small": 2.5, "medium": 3.0, "large": 3.5},
    "RIVER": {"small": 2.5, "medium": 3.0, "large": 5.0} # or all-in
}

TEXTURE_MULTIPLIER = {
    "dry": 1.15,
    "semi_wet": 1.0,
    "wet": 0.85,
    "paired": 1.1
}

POSITION_MULTIPLIER = {
    "IP": 1.1,
    "OOP": 0.9
}

SPR_MULTIPLIER = {
    "low": 0.8,     # SPR < 3
    "mid": 1.0,     # 3〜6
    "high": 1.2     # >6
}

# --- 評価記号 ---
EVAL_OPTIMAL = "◎"
EVAL_GOOD = "◯"
EVAL_MARGINAL = "△"
EVAL_BAD = "×"

class Evaluator:
    """
    数学的根拠に基づき、ユーザーのアクションを評価するクラス。
    """
    @staticmethod
    def calculate_required_equity(call_amount, pot_size):
        """ 必要エクイティ (E_req) の計算 """
        if call_amount == 0:
            return 0.0
        return call_amount / (pot_size + call_amount)

    @staticmethod
    def ev_call(equity, pot_size, call_amount, spr=None, hand_category=None):
        """
        EV sanity rules:

        CALL:
            equity * (pot + call) - call

        BET:
            FE * pot
            + (1 - FE) * [ equity*(pot + bet) - (1-equity)*bet ]

        CHECK:
            equity * pot

        No double counting of pot.
        """
        base_ev = equity * (pot_size + call_amount) - call_amount
        
        # Implied odds bonus for strong draws with deep stacks
        if spr is not None and hand_category == "STRONG_DRAW":
            implied_bonus = equity * (pot_size * 0.5 * min(spr, 5.0))
            return base_ev + implied_bonus
            
        return base_ev

    @staticmethod
    def ev_check(equity, pot_size):
        """
        Simplified EV of checking.
        We assume no fold equity and no additional money invested.
        """
        return equity * pot_size

    @staticmethod
    def ev_bet(equity, pot_size, bet_amount, fold_equity):
        """
        EV when betting (no raise back assumed).

        EV = FE * pot
             + (1 - FE) * [ equity * (pot + bet)
                            - (1 - equity) * bet ]
        """
        win_part = equity * (pot_size + bet_amount)
        lose_part = (1 - equity) * bet_amount
        return fold_equity * pot_size + (1 - fold_equity) * (win_part - lose_part)
    
    @staticmethod
    def categorize_hand(cards, board=None):
        """
        簡易的にハンドをカテゴリ分けする
        MADE_HAND, STRONG_DRAW, WEAK_HAND
        """
        if not cards or len(cards) < 2:
            return "WEAK_HAND"
            
        # Postflop evaluation
        if board and len(board) >= 3:
            evaluator = TreysEvaluator()
            try:
                score = evaluator.evaluate(board, cards)
                if score <= 6185: # Pair or better
                    return "MADE_HAND"
            except:
                pass
                
            suits = [TreysEvaluator.get_suit_int(c) for c in cards + board]
            suit_counts = {s: suits.count(s) for s in set(suits)}
            if suit_counts and max(suit_counts.values()) == 4:
                return "STRONG_DRAW"
            return "WEAK_HAND"
            
        # Preflop evaluation
        r1 = TreysEvaluator.get_rank_int(cards[0])
        r2 = TreysEvaluator.get_rank_int(cards[1])
        
        # AA-TT (Pocket pairs T+) are strong made hands preflop
        if r1 == r2 and r1 >= 8: # 8 = Ten
            return "MADE_HAND"
            
        # Top Broadways AK, AQ
        if r1 >= 10 and r2 >= 10:
            return "MADE_HAND"
            
        # Suited Connectors / Suited Broadways -> STRONG_DRAW
        s1 = TreysEvaluator.get_suit_int(cards[0])
        s2 = TreysEvaluator.get_suit_int(cards[1])
        is_suited = (s1 == s2)
        gap = abs(r1 - r2)
        
        if is_suited and (gap <= 2):
            return "STRONG_DRAW"
            
        # Small pocket pairs
        if r1 == r2:
            return "STRONG_DRAW"
            
        return "WEAK_HAND"

    @staticmethod
    def calculate_pi(cards, board=None):
        """
        Playability Index (PI) の計算
        """
        if not cards or len(cards) < 2:
            return 1.0
            
        pi = 1.0
        r1 = TreysEvaluator.get_rank_int(cards[0])
        r2 = TreysEvaluator.get_rank_int(cards[1])
        s1 = TreysEvaluator.get_suit_int(cards[0])
        s2 = TreysEvaluator.get_suit_int(cards[1])
        
        if s1 == s2:
            pi += 0.05
        if abs(r1 - r2) <= 1:
            pi += 0.05
        if r1 == r2:
            pi += 0.05
            
        # Postflop PI
        if board and len(board) >= 3:
            suits = [TreysEvaluator.get_suit_int(c) for c in cards + board]
            suit_counts = {s: suits.count(s) for s in set(suits)}
            if suit_counts and max(suit_counts.values()) == 4:
                pi += 0.10 # Good playability to hit flush
                
        return pi

    @staticmethod
    def get_eqr_modifier(hero_pos, cards=None, is_3bet_pot=False, board=None):
        """
        OOP補正、3BETポット補正、PI補正を加味した実現エクイティ係数
        """
        base_eqr = 1.0
        category = Evaluator.categorize_hand(cards, board)
        
        if hero_pos in ["SB", "BB"]:
            # OOP時のカテゴリ別補正
            if category == "MADE_HAND":
                base_eqr = 0.90
            elif category == "STRONG_DRAW":
                base_eqr = 0.85
            else:
                base_eqr = 0.70
                
        if is_3bet_pot:
            if category == "STRONG_DRAW" or category == "WEAK_HAND":
                base_eqr *= 0.85
                
        # Playability Index
        pi = Evaluator.calculate_pi(cards, board)
        return base_eqr * pi
    
    @staticmethod
    def calculate_alpha(bet_amount, pot_size):
        """ α (Alpha): ブラフが成功する必要最低限の頻度 """
        return bet_amount / (pot_size + bet_amount)
    
    @staticmethod
    def calculate_mdf(bet_amount, pot_size):
        """ MDF (Minimum Defense Frequency) """
        return pot_size / (pot_size + bet_amount)

    @staticmethod
    def evaluate_call(equity, call_amount, pot_size, hero_pos="BTN", cards=None, is_3bet_pot=False, board=None, effective_stack=0.0):
        if call_amount == 0:
            return EVAL_OPTIMAL, "チェック可能にも関わらずコール判定になりました。無料のカードは常に最適です。" # Free card is always optimal if checking
            
        e_req = Evaluator.calculate_required_equity(call_amount, pot_size)
                
        eqr = Evaluator.get_eqr_modifier(hero_pos, cards, is_3bet_pot, board)
        realized_equity = equity * eqr
        
        spr = None
        if effective_stack > 0 and pot_size > 0:
            spr = effective_stack / pot_size
            
        category = Evaluator.categorize_hand(cards, board)
        
        # EV computation
        ev_call_val = Evaluator.ev_call(realized_equity, pot_size, call_amount, spr=spr, hand_category=category)
        
        if ev_call_val > 0 and realized_equity < e_req * 0.9:
            return EVAL_GOOD, f"現在の勝率({realized_equity*100:.1f}%)はオッズにあっていませんが、深いSPR({spr:.1f})によるインプライドオッズでEV({ev_call_val:.1f})がプラスになる利益的なコールです。"
            
        if realized_equity >= e_req * 1.2:
            return EVAL_OPTIMAL, f"必要勝率({e_req*100:.1f}%)に対し、あなたの勝率({realized_equity*100:.1f}%)は十分高く、極めて利益的なコールです。"
        elif realized_equity >= e_req:
            return EVAL_GOOD, f"必要勝率({e_req*100:.1f}%)を満たしており、利益的なコールです。"
        elif realized_equity >= e_req * 0.8:
            return EVAL_MARGINAL, f"必要勝率({e_req*100:.1f}%)にわずかに届いていません。ブラフキャッチ等の追加の理由が必要です。"
        else:
            return EVAL_BAD, f"必要勝率({e_req*100:.1f}%)に対して勝率({realized_equity*100:.1f}%)が低すぎます。フォールドすべきです。"

    @staticmethod
    def evaluate_fold(equity, opponent_bet_size, pot_size, hero_pos="BTN", cards=None, is_3bet_pot=False, board=None):
        if opponent_bet_size == 0:
            return EVAL_BAD, "無料で見られる状況でのフォールドは完全なミスプレイです。"
            
        e_req = Evaluator.calculate_required_equity(opponent_bet_size, pot_size)
                
        eqr = Evaluator.get_eqr_modifier(hero_pos, cards, is_3bet_pot, board)
        realized_equity = equity * eqr
        
        if realized_equity >= e_req * 1.2:
            return EVAL_BAD, f"必要勝率({e_req*100:.1f}%)に対して勝率({realized_equity*100:.1f}%)が十分に高く、コールやレイズすべきでした。期待値マイナスです。"
        elif realized_equity >= e_req:
            return EVAL_MARGINAL, f"必要勝率({e_req*100:.1f}%)を満たしており({realized_equity*100:.1f}%)、フォールドは消極的すぎるかもしれません。"
        else:
            return EVAL_OPTIMAL, f"必要勝率({e_req*100:.1f}%)に対し勝率({realized_equity*100:.1f}%)が不足しているため、適切なフォールドです。"

    @staticmethod
    def evaluate_bet(equity, bet_amount, pot_size, hero_pos="BTN", cards=None, board=None):
        eqr = Evaluator.get_eqr_modifier(hero_pos, cards, False, board)
        realized_equity = equity * eqr

        # ベットサイズに基づいた動的フォールドエクイティの計算 (MDF/Alpha)
        fold_equity = Evaluator.calculate_alpha(bet_amount, pot_size)
        ev_betting = Evaluator.ev_bet(realized_equity, pot_size, bet_amount, fold_equity)
        ev_checking = Evaluator.ev_check(realized_equity, pot_size)
        
        if ev_betting > ev_checking + (0.05 * pot_size):
            return EVAL_OPTIMAL, f"チェックの期待値(EV: {ev_checking:.1f})に対し、ベット(EV: {ev_betting:.1f})が明確に上回っています。強気な最適ベットです。"
        elif ev_betting >= ev_checking:
            return EVAL_GOOD, f"ベット期待値(EV: {ev_betting:.1f})がチェック(EV: {ev_checking:.1f})を上回っており、妥当なアクションです。"
        elif ev_betting >= ev_checking - (0.05 * pot_size):
            return EVAL_MARGINAL, f"期待値(EV: {ev_betting:.1f})がパッシブなラインと拮抗しています。戦略的な意図が必要です。"
        else:
            return EVAL_BAD, f"チェックの期待値(EV: {ev_checking:.1f})の方がベット(EV: {ev_betting:.1f})より高いため、ベットは避けるべきです。"

    @staticmethod
    def evaluate_raise(equity, raise_amount, opponent_bet_size, pot_size, hero_pos="BTN", cards=None, board=None):
        eqr = Evaluator.get_eqr_modifier(hero_pos, cards, False, board)
        realized_equity = equity * eqr

        # レイズ額に対する動的フォールドエクイティの計算
        fold_equity = Evaluator.calculate_alpha(raise_amount, pot_size + opponent_bet_size)
        ev_raising = Evaluator.ev_bet(realized_equity, pot_size + opponent_bet_size, raise_amount, fold_equity)
        
        # 比較対象としてコールした場合のEVを計算
        ev_calling = Evaluator.ev_call(realized_equity, pot_size, opponent_bet_size)
        
        if ev_raising > ev_calling + (0.05 * pot_size):
            return EVAL_OPTIMAL, f"コール(EV: {ev_calling:.1f})に対し、レイズ(EV: {ev_raising:.1f})が明確に上回る非常に強力なプレイです。"
        elif ev_raising >= ev_calling:
            return EVAL_GOOD, f"レイズ(EV: {ev_raising:.1f})がコール(EV: {ev_calling:.1f})を上回っており、妥当な攻撃的アクションです。"
        elif ev_raising >= ev_calling - (0.05 * pot_size):
            return EVAL_MARGINAL, f"レイズ(EV: {ev_raising:.1f})とコール(EV: {ev_calling:.1f})の期待値が拮抗しています。明確な目的が必要です。"
        else:
            return EVAL_BAD, f"コール(EV: {ev_calling:.1f})の方がレイズ(EV: {ev_raising:.1f})よりも高いため、基本的にはコールかフォールドすべきです。"

    @staticmethod
    def evaluate_check(equity, pot_size, hero_pos="BTN", has_initiative=False, is_hero_ip=False, cards=None, board=None):
        if not has_initiative:
            if not is_hero_ip:
                # OOP（先攻）の場合
                return EVAL_OPTIMAL, "あなたはアグレッサーではないため、まずはチェックして相手（レイザー）のアクションを待つのが定石です。"
            else:
                # IP（後攻）の場合
                return EVAL_OPTIMAL, "相手が攻撃権を放棄したため、ポットコントロールのためにチェックバックして次のカードを無料で見にいくのは有効な選択です。"
            
        # チェックが適切かどうか
        eqr = Evaluator.get_eqr_modifier(hero_pos, cards, False, board) # Defaults to None, relying on base EQR
        realized_equity = equity * eqr

        ev_checking = Evaluator.ev_check(realized_equity, pot_size)
        
        # 便宜上、ハーフポットベットのEVと比較して判断する
        half_pot = pot_size / 2.0
        fold_equity = Evaluator.calculate_alpha(half_pot, pot_size)
        ev_betting_half_pot = Evaluator.ev_bet(realized_equity, pot_size, half_pot, fold_equity)
        
        if ev_checking >= ev_betting_half_pot:
            return EVAL_OPTIMAL, f"ベット(EV: {ev_betting_half_pot:.1f})よりチェック(EV: {ev_checking:.1f})が高く、パッシブな進行が最善です。"
        elif ev_checking >= ev_betting_half_pot * 0.8:
            return EVAL_GOOD, f"チェックの期待値(EV: {ev_checking:.1f})は標準的です。ポットコントロールに適しています。"
        elif ev_checking >= ev_betting_half_pot * 0.5:
            return EVAL_MARGINAL, f"ベットすべき状況かもしれませんが、チェックも限定的に正当化されます。"
        else:
            return EVAL_BAD, f"ベット期待値(EV: {ev_betting_half_pot:.1f})が非常に高く、チェックは利益を逃す悪手です。"

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
        self.POSITIONS = ["UTG", "MP", "CO", "BTN", "SB", "BB"]
        
        self.hero_invested = 0.0
        self.cpu_invested = 0.0
        self.current_bet = 0.0
        
        self.aggressor = None
        self.action_history = []
        self.cpu_last_action_intent = None
        
    def is_hero_turn(self):
        """ True if Hero acts, False if CPU acts. """
        preflop_order = ["UTG", "MP", "CO", "BTN", "SB", "BB"]
        postflop_order = ["SB", "BB", "UTG", "MP", "CO", "BTN"]
        
        if self.street == "PREFLOP":
             return preflop_order.index(self.hero_position) < preflop_order.index(self.cpu_position)
        else:
             return postflop_order.index(self.hero_position) < postflop_order.index(self.cpu_position)
             
    @property
    def is_hero_ip(self):
        """ True if Hero acts last postflop (In Position) """
        postflop_order = ["SB", "BB", "UTG", "MP", "CO", "BTN"]
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
        self.hero_range_dict = ranges.get_range_by_category(self.hero_position, action="open").copy()
        
        if self.is_hero_turn():
             # Hero acts first (IP), CPU depends on Hero's open
             if self.cpu_position == "BB":
                 action_str = f"vs_{self.hero_position}"
             else:
                 action_str = "vs_open_call"
             self.cpu_range_dict = ranges.get_range_by_category(self.cpu_position, action=action_str).copy()
        else:
             self.cpu_range_dict = ranges.get_range_by_category(self.cpu_position, action="open").copy()
        
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
        return: 'dry', 'semi_wet', 'wet', 'paired'
        """
        if len(board) == 0:
             return "dry"
        
        suits = [Card.get_suit_int(c) for c in board]
        ranks = [Card.get_rank_int(c) for c in board]
        
        suit_counts = {s: suits.count(s) for s in set(suits)}
        rank_counts = {r: ranks.count(r) for r in set(ranks)}
        max_suit = max(suit_counts.values()) if suit_counts else 0
        
        # 1. Paired board
        if max(rank_counts.values()) >= 2:
            return "paired"
            
        # 2. Wet board logic
        # 同スート2枚以上 (Flush Draw presence) or Connected sequence >= 3
        sorted_ranks = sorted(ranks, reverse=True)
        is_connected = False
        if len(sorted_ranks) >= 3:
            # Check for 3-card straight draw (e.g. 9 8 7, J T 8)
            # A 3-card connected sequence means the gap between the highest and lowest of those 3 is <= 4
            for i in range(len(sorted_ranks) - 2):
                 if sorted_ranks[i] - sorted_ranks[i+2] <= 4:
                      # Additional guard: ensure it's actually 3 distinct cards making up the draw
                      # rank_counts already ensures no pairs in this path if we reached here for a 3-board,
                      # but for River boards (5 cards), we just need a spread of <= 4 across 3 indices.
                      is_connected = True
                      break
                      
        # Severe Wetness: 3-flush
        # Even if a board has 2-flush and connected (e.g. Jh Th 9s), user defined Jh Th 9s as 'wet' manually in instructions.
        if max_suit >= 3 or (max_suit >= 2 and is_connected):
             return "wet"
             
        # 3. Dry board Logic (No flush draw, no connections, no pairs)
        if max_suit <= 1 and not is_connected:
             return "dry"
             
        # 4. Fallback base (Either a 2-flush without straight draw, or a straight draw without flush draw)
        return "semi_wet"

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
        for k in weights:
            if weights[k] < floor_val:
                 weights[k] = floor_val
        total = sum(weights.values())
        for k in weights:
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
        bet_size: 実際のベット額
        pot: ベット前ポットサイズ
        return: 理論ブラフ頻度（0〜1）
        """
        if bet_size <= 0: return 0.0
        return bet_size / (pot + bet_size)

    def _calculate_range_preflop_score(self, range_dict, dead_cards):
        total_score = 0.0
        total_weight = 0.0
        
        for combo_str, weight in range_dict.items():
            if weight <= 0.0: continue
            parsed = ranges.parse_combo(combo_str)
            for specific_cards_str in parsed:
                if not any(c in dead_cards for c in specific_cards_str):
                    cards = [Card.new(c) for c in specific_cards_str]
                    score = Evaluator.calculate_preflop_score(cards)
                    total_score += score * weight
                    total_weight += weight
                    
        if total_weight <= 0: return 0.0
        return total_score / total_weight

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

    def calc_equity_monte_carlo(self, hero_cards, board_cards, iterations=1000, target_actor="CPU"):
        """
        モンテカルロ法によるエクイティ計算（最新版）
        内部辞書（hero_range_dict / cpu_range_dict）の直接的なウェイト分布を用いて計算する。
        """
        if self.street == "PREFLOP":
            # プリフロップは計算コストが高いため、Chen Formulaベースの近似ヒューリスティックを使用する
            target_dict = self.cpu_range_dict if target_actor == "CPU" else self.hero_range_dict
            dead_cards_str = [Card.int_to_str(c) for c in hero_cards] + [Card.int_to_str(c) for c in board_cards]
            
            hero_score = Evaluator.calculate_preflop_score(hero_cards)
            cpu_score = self._calculate_range_preflop_score(target_dict, dead_cards_str)
            
            delta = hero_score - cpu_score
            hero_equity = 0.5 + (delta * 0.02)
            hero_equity = max(0.05, min(0.95, hero_equity))
            return hero_equity, 1.0 - hero_equity

        hero_wins = 0
        ties = 0
        
        # Determine the target evaluation range
        target_dict = self.cpu_range_dict if target_actor == "CPU" else self.hero_range_dict
        
        # Dead cards known to hero
        dead_cards = [Card.int_to_str(c) for c in hero_cards] + [Card.int_to_str(c) for c in board_cards]
        
        # Flatten dictionary weights -> Specific Valid Combinations
        valid_combos_weighted = []
        for combo_str, weight in target_dict.items():
            if weight <= 0.0: continue
            parsed = ranges.parse_combo(combo_str)
            for specific_cards in parsed:
                if not any(c in dead_cards for c in specific_cards):
                    valid_combos_weighted.append((specific_cards, weight))
        
        if not valid_combos_weighted:
             return 1.0, 0.0 # Target has no logical range here
             
        # Helper to pick a random combo based on its native dynamic GTO weight
        total_weight = sum(w for _, w in valid_combos_weighted)
        def pick_weighted_combo():
            if total_weight <= 0:
                return random.choice(valid_combos_weighted)[0] # Fallback
            r = random.uniform(0, total_weight)
            cum = 0.0
            for combo, weight in valid_combos_weighted:
                cum += weight
                if r <= cum:
                    return combo
            return valid_combos_weighted[-1][0]
             
        # Simulate
        for _ in range(iterations):
            temp_deck = Deck() # Create a clean deck
            sim_board = list(board_cards)
            
            # Remove known cards from temp deck explicitly
            removals = hero_cards + board_cards
            temp_deck.cards = [c for c in temp_deck.cards if c not in removals]
            
            # Draw remaining board to river
            needed = 5 - len(sim_board)
            if needed > 0:
                drawn = temp_deck.draw(needed)
                if not isinstance(drawn, list): drawn = [drawn]
                sim_board.extend(drawn)
                
            # Pick purely using the mathematical native dictionary distribution
            cpu_cards_str = pick_weighted_combo()
            cpu_cards = [Card.new(c) for c in cpu_cards_str]
            
            # Make sure CPU cards aren't in the drawn board (highly unlikely if carefully written, but standard bounds check)
            if any(c in sim_board for c in cpu_cards):
                 continue
                 
            # Evaluate using Treys (lower score is better)
            hero_score = self.treys_evaluator.evaluate(sim_board, hero_cards)
            cpu_score = self.treys_evaluator.evaluate(sim_board, cpu_cards)
            
            if hero_score < cpu_score: # Inverse in Treys (Lower is better)
                hero_wins += 1
            elif hero_score == cpu_score:
                ties += 1

        total_sims = iterations
        hero_equity = (hero_wins + ties / 2) / total_sims
        cpu_equity = 1.0 - hero_equity
        return hero_equity, cpu_equity



    def calc_range_advantage(self, hero_cards, board_cards, iterations=1000):
        """
        Calculates the Range Advantage (0 to 1) comparing the CPU's native range dict
        to the Hero's native range dict over the runout. 
        """
        if self.street == "PREFLOP":
            return 0.5
            
        hero_wins = 0
        ties = 0
        total_sims = iterations
        
        # Dead cards known globally (we don't know hero cards when simulating pure range vs range, 
        # but since CPU doesn't know hero's cards, CPU just uses board for pure range vs range abstraction)
        # Note: In real GTO, Range Adv is computed with no known hole cards. CPU estimates both.
        dead_cards = [Card.int_to_str(c) for c in board_cards]
        
        # Parse active ranges 
        hero_combos_weighted = []
        for combo_str, weight in self.hero_range_dict.items():
            if weight <= 0.0: continue
            parsed = ranges.parse_combo(combo_str)
            for specific_cards in parsed:
                if not any(c in dead_cards for c in specific_cards):
                    hero_combos_weighted.append((specific_cards, weight))
                    
        cpu_combos_weighted = []
        for combo_str, weight in self.cpu_range_dict.items():
            if weight <= 0.0: continue
            parsed = ranges.parse_combo(combo_str)
            for specific_cards in parsed:
                if not any(c in dead_cards for c in specific_cards):
                    cpu_combos_weighted.append((specific_cards, weight))
                    
        if not hero_combos_weighted or not cpu_combos_weighted:
             return 0.5
             
        # Total Native Weights
        ht_weight = sum(w for _, w in hero_combos_weighted)
        ct_weight = sum(w for _, w in cpu_combos_weighted)
        
        def pick_combo(c_list, t_weight):
            if t_weight <= 0: return random.choice(c_list)[0]
            r = random.uniform(0, t_weight)
            cum = 0.0
            for combo, weight in c_list:
                cum += weight
                if r <= cum: return combo
            return c_list[-1][0]
            
        hero_wins, ties, valid = 0, 0, 0
        for _ in range(iterations):
            h_str = pick_combo(hero_combos_weighted, ht_weight)
            c_str = pick_combo(cpu_combos_weighted, ct_weight)
            h_cards = [Card.new(c) for c in h_str]
            c_cards = [Card.new(c) for c in c_str]
            
            # bounds check (skip if cards overlap)
            if any(c in board_cards for c in h_cards) or any(c in board_cards for c in c_cards) or any(c in h_cards for c in c_cards): 
                continue
            
            valid += 1
            sim_board = list(board_cards)
            temp_deck = Deck()
            removals = h_cards + c_cards + board_cards
            temp_deck.cards = [c for c in temp_deck.cards if c not in removals]
            needed = 5 - len(sim_board)
            if needed > 0:
                drawn = temp_deck.draw(needed)
                if not isinstance(drawn, list): drawn = [drawn]
                sim_board.extend(drawn)
                
            hero_score = self.treys_evaluator.evaluate(sim_board, h_cards)
            cpu_score = self.treys_evaluator.evaluate(sim_board, c_cards)
            if hero_score < cpu_score: hero_wins += 1
            elif hero_score == cpu_score: ties += 1
            
        return (hero_wins + ties/2.0) / max(1, valid)

    def update_pot(self, amount):
        self.pot_size += amount

    def cpu_decide(self, cpu_equity, opponent_action, opponent_bet_size):
        """ 理想的な動きをするCPU (GTO/Math-based basis) 
            Enforces strict sizing constraints and Range advantage heuristics. 
        """
        hero_range_adv = self.calc_range_advantage(self.hero_hand, self.board, iterations=500)
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
        engine.is_hero_ip = (i % 2 == 0) # Flip IP/OOP 
        
        print(f"You are: {'In Position (BTN)' if engine.is_hero_ip else 'Out of Position (BB)'}")
        print(f"Your Hand: {engine.get_hand_str(engine.hero_hand)}")
        
        for street in engine.STREETS:
            engine.advance_street(street)
            print(f"\n--- {street} ---")
            if engine.board:
                print(f"Board: {engine.get_hand_str(engine.board)}")
                
            hero_eq, cpu_eq = engine.calc_equity_monte_carlo(engine.hero_hand, engine.board, iterations=100)
            
            # EQR調整値の表示
            eqr_modifier = Evaluator.get_eqr_modifier(engine.hero_position)
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
