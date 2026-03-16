class EVCalculator:
    @staticmethod
    def calculate_required_equity(call_amount, pot_size):
        """ 必要エクイティ (E_req) の計算 """
        if call_amount == 0:
            return 0.0
        return call_amount / (pot_size + call_amount)

    @staticmethod
    def ev_call(equity, pot_size, call_amount, spr=None, hand_category=None, is_ip=True):
        """
        コールアクションの期待値（EV）を計算する。
        数式: equity * (pot_size + call_amount) - call_amount
        ※ポットに双方のコールが入るので等価式: equity * (pot + 2*call) - call
        """
        base_ev = equity * (pot_size + call_amount) - call_amount

        implied_bonus = 0.0
        if spr is not None and hand_category == "STRONG_DRAW":
            # OOPの場合はインプライドオッズを実現しにくいため、ボーナス係数を厳格に半減させる
            position_modifier = 1.0 if is_ip else 0.5
            # 上限をSPR 3.0に制限し、過大なコーリングステーション化を防ぐ
            implied_bonus = equity * (pot_size * 0.3 * min(spr, 3.0)) * position_modifier

        return base_ev + implied_bonus

    @staticmethod
    def ev_check(equity, pot_size):
        """
        チェックアクションの簡易EV。
        双方チェックしてショーダウンを前提とした近似値。
        """
        return equity * pot_size

    @staticmethod
    def ev_bet(equity, pot_size, bet_amount, fold_equity, villain_raise_freq=0.1):
        """
        ベットの期待値を計算する。
        相手がレイズしてくる可能性（villain_raise_freq）を考慮し、
        レイズされた場合はフォールドすると仮定した損失も織り込む。

        シナリオ:
          1. 相手フォールド（確率: fold_equity）                → win pot
          2. 相手コール（確率: (1-fold_equity)*(1-raise_freq)）  → equity showdown
          3. 相手レイズ（確率: (1-fold_equity)*raise_freq）       → lose bet_amount
        """
        # コールされた場合のショーダウンEV
        call_ev = equity * (pot_size + bet_amount) - (1 - equity) * bet_amount
        # フォールドされた場合のEV（ポットを獲得）
        fold_ev = pot_size
        # レイズされて諦めた場合のEV（ベット額を失う）
        raise_ev = -bet_amount

        # 3シナリオの確率（正規化）
        adjusted_call_freq = (1 - fold_equity) * (1 - villain_raise_freq)
        adjusted_raise_freq = (1 - fold_equity) * villain_raise_freq

        return (fold_equity * fold_ev) + (adjusted_call_freq * call_ev) + (adjusted_raise_freq * raise_ev)

    @staticmethod
    def calculate_alpha(bet_amount, pot_size):
        """
        Alpha: ブラフが損益分岐点となるために必要な相手のフォールド頻度。
        MDF（最小防衛頻度）の逆数にあたる。
        Alpha = Bet / (Pot + Bet)
        """
        if pot_size + bet_amount == 0:
            return 0.0
        return bet_amount / (pot_size + bet_amount)

    @staticmethod
    def calculate_mdf(bet_amount, pot_size):
        """
        MDF (Minimum Defense Frequency): 相手のブラフを無制限の利益から守るために
        プレイヤーが防衛すべき最低頻度。
        MDF = Pot / (Pot + Bet) = 1 - Alpha
        """
        if pot_size + bet_amount == 0:
            return 1.0
        return pot_size / (pot_size + bet_amount)

    @staticmethod
    def calculate_theoretical_bluff_frequency(bet_size, pot):
        """
        GTO理論に基づく適切なブラフ割合（Bluff-to-Value Ratio）を計算する。
        相手のブラフキャッチャーをインディファレント（コール/フォールドのEVが等値）に
        するために必要なブラフの割合。

        正しい数式: Bet / (Pot + 2 * Bet)
        ※誤用注意: Bet / (Pot + Bet) はAlpha（必要フォールド頻度）であり別概念。

        例: Pot=100, Bet=100 → 100/300 = 0.333 (33.3%) が正解
        """
        if bet_size <= 0:
            return 0.0
        if pot + 2 * bet_size == 0:
            return 0.0
        return bet_size / (pot + 2 * bet_size)
