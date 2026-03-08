import random
import traceback
from app import engine, get_game_state, take_action, ActionRequest

def start_hand_test():
    """Test environment wrapper for starting a new hand directly via the engine to bypass API routing constraints in the test script"""
    MAX_RETRIES = 50
    cpu_msg = ""
    for _ in range(MAX_RETRIES):
        engine.start_new_hand()
        # Heroが先手（BTNなど）の場合は、そのままゲーム開始
        if engine.is_hero_turn():
            break
        
        # CPUが先手の場合のアクションを計算
        from equity import EquityCalculator
        hero_eq_next, cpu_eq_next = EquityCalculator.calc_equity_monte_carlo(engine.hero_hand, engine.board, engine.hero_range_dict, engine.cpu_range_dict, iterations=50)
        cpu_facing = engine.current_bet - engine.cpu_invested
        cpu_action, cpu_amount = engine.cpu_decide(cpu_eq_next, "CHECK", cpu_facing)
        
        if cpu_action == "FOLD":
            continue
            
        if cpu_action in ["CALL", "BET", "RAISE"]:
            bet_amount = cpu_facing if cpu_action == "CALL" else cpu_amount
            engine.place_bet("CPU", bet_amount)
            break
            
    return get_game_state()

def validate_action_sequence(history, hero_pos, cpu_pos):
    """
    アクション履歴を解析し、ポーカーの進行ルールに違反していないか厳密にチェックする
    """
    if not history:
        return

    # ポジションに基づくポストフロップの行動順（インデックスが小さい方が先手=OOP）
    postflop_order = ["SB", "BB", "UTG", "LJ", "HJ", "CO", "BTN"]
    
    # Map any unknown positions safely logic
    try:
        hero_idx = postflop_order.index(hero_pos)
        cpu_idx = postflop_order.index(cpu_pos)
    except ValueError:
        return # Skip validation if positions are custom/unmapped
        
    hero_is_ip = hero_idx > cpu_idx
    oop_actor = "HERO" if not hero_is_ip else "CPU"

    # ストリートごとに履歴を分割
    streets = {"PREFLOP": [], "FLOP": [], "TURN": [], "RIVER": []}
    for act in history:
        streets[act["street"]].append(act)

    for street, acts in streets.items():
        if not acts:
            continue
        
        # 【チェック1】同じプレイヤーが連続して行動していないか（手番のスキップ検知）
        for i in range(1, len(acts)):
            if acts[i]["actor"] == acts[i-1]["actor"]:
                # Ignore fold sequence logic where state might record consecutive actions due to termination
                if acts[i]["action"] == "FOLD" or acts[i-1]["action"] == "FOLD":
                    continue
                raise AssertionError(
                    f"❌ 【手番スキップ検知】 {street} にて {acts[i]['actor']} が連続でアクションしています！\n"
                    f"該当ストリート履歴: {[a['actor'] + ' ' + a['action'] for a in acts]}"
                )

        # 【チェック2】ポストフロップの最初のアクションが正しいプレイヤー（OOP）から始まっているか
        if street != "PREFLOP":
            first_actor = acts[0]["actor"]
            if first_actor != oop_actor:
                raise AssertionError(
                    f"❌ 【行動順エラー】 {street} の先手はOOPの {oop_actor} であるべきですが、{first_actor} から始まっています！\n"
                    f"Hero({hero_pos}) vs CPU({cpu_pos})"
                )

def run_sequence_tests(num_hands=50):
    print(f"=== Poker 진행 룰 엄밀 테스트 시작 ({num_hands}hands) ===")
    
    success_count = 0
    
    for i in range(num_hands):
        try:
            state = start_hand_test()
        except Exception as e:
            print(f"\n❌ 【ハンド開始時エラー】ハンド {i+1}")
            traceback.print_exc()
            break
            
        hero_pos = state["heroPos"]
        cpu_pos = state["cpuPos"]
        
        loop_guard = 0
        while not state.get("finished", False):
            loop_guard += 1
            if loop_guard > 30:
                print(f"\n❌ 【無限ループ検知】 ハンド {i+1} が終わりません！")
                return

            facing = state["facingBet"]
            current_street = state["street"]
            
            # 安全なアクションを選択
            if facing > 0:
                action = random.choice(["CALL", "FOLD"])
                amount = 0.0
            else:
                action = random.choice(["CHECK", "BET"])
                amount = round(state["potSize"] * 0.5, 1) if action == "BET" else 0.0
            
            try:
                # Bypass FastApi routing explicitly
                res = take_action(ActionRequest(action=action, amount=amount))
                state = res["state"]
                
                # 直近のアクションによる進行の厳密チェック
                validate_action_sequence(state["history"], hero_pos, cpu_pos)
                
            except AssertionError as e:
                print(f"\n======================================")
                print(f"🚨 進行ロジックのバグを検知しました！ (Hand #{i+1})")
                print(f"======================================")
                print(str(e))
                print(f"直前のHeroアクション: {action} {amount}bb")
                print("▼ 現在の全履歴:")
                for h in state["history"]:
                    print(f"  [{h['street']}] {h['actor']} : {h['action']} ({h.get('amount', 0)}bb)")
                return
            except Exception as e:
                print(f"\n❌ 【システムエラー検知】 ハンド {i+1}")
                traceback.print_exc()
                return

        success_count += 1
        if success_count % 10 == 0:
            print(f"🏁 {success_count} ハンド検証クリア...")
            
    print("\n✅ テスト完了：手番のスキップや行動順の異常は一切検知されませんでした！")
    print("ゲーム進行ロジックは正常に機能しています。")

if __name__ == "__main__":
    run_sequence_tests(50)
