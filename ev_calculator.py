class EVCalculator:
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
        CALL: equity * (pot + call) - (1 - equity) * call
              which is equivalent to: equity * (pot + 2*call) - call
              Wait, standard EV Call formula:
              EV = (equity * pot) - ((1 - equity) * call)
              = equity * pot - call + equity * call
              = equity * (pot + call) - call
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
    def calculate_alpha(bet_amount, pot_size):
        if pot_size + bet_amount == 0:
            return 0.0
        return bet_amount / (pot_size + bet_amount)

    @staticmethod
    def calculate_theoretical_bluff_frequency(bet_size, pot):
        """
        bet_size: 実際のベット額
        pot: ベット前ポットサイズ
        return: 理論ブラフ頻度（0〜1）
        """
        if bet_size <= 0: return 0.0
        return bet_size / (pot + bet_size)
