import sys
import os

sys.path.append(os.getcwd())

print("--- 1. コンビネトリクス計算 (_get_combo_count) テスト ---")
try:
    from range_utils import _get_combo_count
    ak_combos = _get_combo_count("AK")
    aa_combos = _get_combo_count("AA")
    aks_combos = _get_combo_count("AKs")
    ako_combos = _get_combo_count("AKo")
    print(f"AK: {ak_combos} (Expected: 16)")
    print(f"AA: {aa_combos} (Expected: 6)")
    print(f"AKs: {aks_combos} (Expected: 4)")
    print(f"AKo: {ako_combos} (Expected: 12)")
except Exception as e:
    print(f"Error in _get_combo_count: {e}")

print("\n--- 2. EQRペナルティ緩和 (get_eqr_modifier) テスト ---")
try:
    from poker_engine import Evaluator
    from treys import Card
    # AIR (High Card) in OOP, non-3bet pot
    cards = [Card.new("Ah"), Card.new("Kc")]
    board = [Card.new("2d"), Card.new("7s"), Card.new("9c")]
    eqr = Evaluator.get_eqr_modifier("BB", cards, is_3bet_pot=False, board=board, range_adv=0.5, spr=10.0)
    print(f"EQR for AIR, OOP, SPR 10: {eqr:.2f} (Should be closer to 0.85 than 0.70)")
except Exception as e:
    print(f"Error in EQR: {e}")

print("\n--- 3. ベットサイズの制約緩和 (evaluate_bet_sizing) テスト ---")
try:
    from bet_sizing import evaluate_bet_sizing
    # Dry board, Pot size bet (100%)
    res = evaluate_bet_sizing(pot=10.0, bet_amount=10.0, board_texture="dry", spr=10.0)
    print(f"Dry board 100% pot bet evaluation: {res['evaluation']}")
    if res['evaluation'] != "△":
        print("Success! 100% bet is no longer marginal on dry board blindly.")
except Exception as e:
    print(f"Error in bet sizing: {e}")

print("\n--- 4. 段階的開示 (cpuPos = '???') テスト ---")
try:
    import app
    engine = app.engine
    
    # Heroが先手の状況を意図的に作成
    engine.hero_position = "UTG"
    engine.cpu_position = "BTN"
    engine.action_history = []
    engine.street = "PREFLOP"
    
    state = app.get_game_state()
    print(f"Hero: {state['heroPos']}, CPU API Response: {state['cpuPos']} (Expected: ???)")
    
    # CPUがアクションしたと仮定
    engine.action_history.append({"actor": "CPU", "action": "CALL", "amount": 1.0, "street": "PREFLOP"})
    state2 = app.get_game_state()
    print(f"Hero: {state2['heroPos']}, CPU API Response After Action: {state2['cpuPos']} (Expected: BTN)")
    
except Exception as e:
    print(f"Error in game state: {e}")

print("\n--- 5. FastAPI エンドポイント (start_hand) 単体テスト ---")
try:
    from fastapi.testclient import TestClient
    client = TestClient(app.app)
    
    res = client.get("/api/start_hand")
    if res.status_code == 200:
        data = res.json()
        print(f"start_hand 成功: Hero={data['heroPos']}, CPU表示={data['cpuPos']}")
    else:
        print(f"start_hand エラー: {res.status_code} {res.text}")
except Exception as e:
    print(f"Error calling /api/start_hand: {e}")

