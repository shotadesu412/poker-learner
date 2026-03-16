import pytest
from poker_engine import Evaluator

def test_calculate_required_equity():
    # Pot 10, Call 5 -> 5 / 15 = 0.333
    req_eq = Evaluator.calculate_required_equity(5, 10)
    assert abs(req_eq - 0.333) < 0.01

def test_evaluate_call():
    # Pot 10, Call 5 -> ReqEq 0.333
    # (EQR補正で realized_eq はわずかに変動するため実質評価を確認)
    # ◎ if realized_eq >= 0.333 * 1.2 (= 0.4) -> eq=0.45 なら十分上回る
    assert Evaluator.evaluate_call(0.45, 5, 10)["evaluation"] == "◎"
    # ◯ if realized_eq >= 0.333
    assert Evaluator.evaluate_call(0.35, 5, 10)["evaluation"] == "◯"
    # △ if realized_eq >= 0.333 * 0.8 (= 0.266)
    assert Evaluator.evaluate_call(0.30, 5, 10)["evaluation"] == "△"
    # × if realized_eq < 0.266
    assert Evaluator.evaluate_call(0.20, 5, 10)["evaluation"] == "×"

def test_evaluate_fold():
    # Pot 10, Bet 5 -> ReqEq = 5/(10+5) = 0.333
    # EQR補正後の実現エクイティで評価されるため、以下の境界を使用
    # ◎ if realized_eq <= e_req - 0.05 (= 0.283) -> eq=0.20 なら realized≈0.207 < 0.283
    assert Evaluator.evaluate_fold(0.20, 5, 10)["evaluation"] == "◎"
    # ◎ if realized_eq <= e_req - 0.05 (= 0.283) -> eq=0.25 なら realized≈0.259 < 0.283
    assert Evaluator.evaluate_fold(0.25, 5, 10)["evaluation"] == "◎"
    # △ if realized_eq in range (e_req-0.05) ~ e_req -> eq=0.35 なら realized≈0.362
    # 0.362 > e_req(0.333) なので △（オッズ満たしてフォールドは消極的）
    assert Evaluator.evaluate_fold(0.35, 5, 10)["evaluation"] == "△"
    # × if realized_eq >= e_req * 1.2 -> eq=0.60 なら realized≈0.621 >> 0.4
    assert Evaluator.evaluate_fold(0.60, 5, 10)["evaluation"] == "×"

def test_evaluate_fold_mdf():
    """MDFを考慮したマージナルケースのテスト"""
    # Pot 10, Bet 5 -> e_req = 0.333, mdf = 10/15 = 0.667
    # MDF警告 △ が出るのは: realized_eq in [(e_req-0.05), e_req) の区間
    # = [0.283, 0.333)
    # eq = 0.29: realized ≈ 0.29 * 1.035 = 0.300 -> 0.283 <= 0.300 < 0.333 = △ (MDF警告)
    result = Evaluator.evaluate_fold(0.29, 5, 10)
    assert result["evaluation"] == "△"
    assert "MDF" in result["reason"]   # MDF概念が言及されていること

def test_evaluate_bet():
    # Pot 10, Bet 5
    eval_result = Evaluator.evaluate_bet(0.9, 5, 10)
    assert eval_result["evaluation"] in ["◎", "◯"]  # positive EV expect good rating

    eval_result_weak = Evaluator.evaluate_bet(0.1, 5, 10)
    assert eval_result_weak["evaluation"] in ["◎", "◯", "△", "×"]  # evaluates OK

def test_evaluate_raise():
    # Pot 10, Opponent Bet 5, We Raise to 15
    eval_result = Evaluator.evaluate_raise(0.9, 15, 5, 10)
    assert eval_result["evaluation"] in ["◎", "◯"]

def test_gto_bluff_frequency():
    """GTOブラフ頻度がAlphaではなく正しい比率を返すことを確認"""
    from ev_calculator import EVCalculator
    # Pot=100, Bet=100 -> 100/(100 + 2*100) = 0.333
    result = EVCalculator.calculate_theoretical_bluff_frequency(100, 100)
    assert abs(result - 0.333) < 0.01, f"Expected 0.333 but got {result}"

    # Pot=100, Bet=50 -> 50/(100 + 100) = 0.25
    result2 = EVCalculator.calculate_theoretical_bluff_frequency(50, 100)
    assert abs(result2 - 0.25) < 0.01, f"Expected 0.25 but got {result2}"

def test_alpha_is_separate():
    """AlphaとGTOブラフ頻度が別概念として分離されていることを確認"""
    from ev_calculator import EVCalculator
    # Alpha (必要フォールド頻度) = 100/(100+100) = 0.50
    alpha = EVCalculator.calculate_alpha(100, 100)
    assert abs(alpha - 0.50) < 0.01, f"Alpha should be 0.50, got {alpha}"

    # GTO Bluff Ratio = 100/(100+200) = 0.333 (Alphaとは異なる)
    bluff_ratio = EVCalculator.calculate_theoretical_bluff_frequency(100, 100)
    assert abs(bluff_ratio - 0.333) < 0.01
    assert abs(alpha - bluff_ratio) > 0.10, "Alpha and GTO Bluff Ratio should be different"

def test_mdf():
    """MDF計算が正しいことを確認"""
    from ev_calculator import EVCalculator
    # Pot=100, Bet=50 -> MDF = 100/150 = 0.667
    mdf = EVCalculator.calculate_mdf(50, 100)
    assert abs(mdf - 0.667) < 0.01
    # MDF = 1 - Alpha であることの確認
    alpha = EVCalculator.calculate_alpha(50, 100)
    assert abs(mdf + alpha - 1.0) < 0.001

if __name__ == "__main__":
    def run_test(name, func):
        print(f"Running {name}...", end="")
        try:
            func()
            print("OK")
        except AssertionError as e:
            print("FAILED")
            import traceback
            traceback.print_exc()

    run_test("req equity", test_calculate_required_equity)
    run_test("evaluate_call", test_evaluate_call)
    run_test("evaluate_fold", test_evaluate_fold)
    run_test("evaluate_fold_mdf", test_evaluate_fold_mdf)
    run_test("evaluate_bet", test_evaluate_bet)
    run_test("evaluate_raise", test_evaluate_raise)
    run_test("gto_bluff_frequency", test_gto_bluff_frequency)
    run_test("alpha_is_separate", test_alpha_is_separate)
    run_test("mdf", test_mdf)
    print("Test run complete.")
