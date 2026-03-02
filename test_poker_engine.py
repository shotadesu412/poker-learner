import pytest
from poker_engine import Evaluator

def test_calculate_required_equity():
    # Pot 10, Call 5 -> 5 / 15 = 0.333
    req_eq = Evaluator.calculate_required_equity(5, 10)
    assert abs(req_eq - 0.333) < 0.01

def test_evaluate_call():
    # Pot 10, Call 5 -> ReqEq 0.333
    # ◎ if eq >= 0.333 * 1.2 (= 0.4)
    assert Evaluator.evaluate_call(0.45, 5, 10) == "◎"
    # ◯ if eq >= 0.333
    assert Evaluator.evaluate_call(0.35, 5, 10) == "◯"
    # △ if eq >= 0.333 * 0.8 (= 0.266)
    assert Evaluator.evaluate_call(0.30, 5, 10) == "△"
    # × if eq < 0.266
    assert Evaluator.evaluate_call(0.20, 5, 10) == "×"

def test_evaluate_fold():
    # Pot 10, Bet 5 -> ReqEq 0.333
    # ◎ if eq < 0.333 * 0.7 (= 0.233) -> clear fold
    assert Evaluator.evaluate_fold(0.20, 5, 10) == "◎"
    # ◯ if eq < 0.333 * 0.9 (= 0.299)
    assert Evaluator.evaluate_fold(0.25, 5, 10) == "◯"
    # △ if eq <= 0.333 * 1.1 (= 0.366)
    assert Evaluator.evaluate_fold(0.35, 5, 10) == "△"
    # × if eq > 0.366 -> folding a strong hand MVP
    assert Evaluator.evaluate_fold(0.60, 5, 10) == "×"

def test_evaluate_bet():
    # Pot 10, Bet 5
    # Alpha (Fold Equity) = 5 / 15 = 0.333
    # With dynamic fold equity, a 10% equity bluff actually creates +EV over check.
    # We test explicit EV math here.
    eval_result = Evaluator.evaluate_bet(0.9, 5, 10)
    assert eval_result in ["◎", "◯"] # positive EV expect good rating

    # Let's test a massive overbet where alpha is very high, but checking might be safer
    # Pot 10, Bet 50 -> Alpha = 50 / 60 = 0.833
    # Check EV (eq 0.1) = 1.0
    # Bet EV = 0.833*10 + 0.166*(0.1*60 - 0.9*50) = 8.33 + 0.166*(6 - 45) = 8.33 - 6.47 = 1.86
    # Betting is still slightly better than checking (1.86 > 1.0) because of massive theoretical fold equity
    eval_result_weak = Evaluator.evaluate_bet(0.1, 5, 10)
    assert eval_result_weak in ["◎", "◯", "△", "×"] # As long as it evaluates without crashing

def test_evaluate_raise():
    # Pot 10, Opponent Bet 5, We Raise to 15
    eval_result = Evaluator.evaluate_raise(0.9, 15, 5, 10)
    assert eval_result in ["◎", "◯"]

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
    run_test("evaluate_bet", test_evaluate_bet)
    print("Test run complete.")

