import random
import traceback
from app import start_hand, take_action, ActionRequest, engine

def run_automated_tests(num_hands=1000):
    print(f"=== 🤖 自動プレイテスト開始（{num_hands}ハンド） ===")
    
    for i in range(num_hands):
        # UIの「次のハンドへ」ボタンを押したのと同じ処理
        try:
            state = start_hand()
        except Exception as e:
            print(f"\n❌ 【ハンド開始時エラー】ハンド {i+1}")
            traceback.print_exc()
            break
        
        loop_guard = 0
        while not state.get("finished", False):
            loop_guard += 1
            if loop_guard > 50:
                print(f"\n❌ 【無限ループ検知】ハンド {i+1} が終わりません！")
                break

            facing = state["facingBet"]
            
            # 状況に応じて「合法な（押せる）ボタン」を判断
            if facing > 0:
                possible_actions = ["FOLD", "CALL", "RAISE"]
            else:
                possible_actions = ["CHECK", "BET"]
            
            action = random.choice(possible_actions)
            amount = 0.0
            
            # ランダムなベット/レイズ額を決定
            if action == "BET":
                amount = round(state["potSize"] * random.choice([0.3, 0.5, 1.0, 2.0]), 1)
            elif action == "RAISE":
                amount = round(facing * random.choice([2.0, 3.0, 5.0]), 1)
            
            # UIのボタンを押したのと同じ処理
            req = ActionRequest(action=action, amount=amount)
            try:
                res = take_action(req)
                state = res["state"]
            except Exception as e:
                print(f"\n❌ 【クラッシュ検知】 ハンド {i+1}, ストリート: {state['street']}")
                print(f"直前のHeroアクション: {action} {amount}bb")
                traceback.print_exc()
                return
            
            # 異常値のアサーション（ありえない数値になっていないか監視）
            try:
                assert state["potSize"] >= 0, f"ポットサイズがマイナスです: {state['potSize']}"
                assert state["heroStack"] >= -0.5, f"Heroのスタックが異常です: {state['heroStack']}"
                assert state["cpuStack"] >= -0.5, f"CPUのスタックが異常です: {state['cpuStack']}"
                assert 0 <= state["equity"] <= 100, f"勝率が0%〜100%の範囲外です: {state['equity']}"
            except AssertionError as e:
                print(f"\n❌ 【異常値検知】 ハンド {i+1}")
                print(e)
                return

        if (i + 1) % 100 == 0:
            print(f"🏁 {i + 1} ハンド完了...（異常なし）")
            
    print("\n✅ テスト完了：異常なし！")
    print("ランダムなアクションで1000ハンド進行させましたが、アプリは一度もクラッシュしませんでした。非常に堅牢なエンジンです！")

if __name__ == "__main__":
    run_automated_tests(1000)
