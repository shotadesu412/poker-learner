"""ハンド全体のテープ比較用ベクタ（フェーズ5: エンジン・CPU AI・ゲーム進行の JS 移植）。

Python の random と treys の Deck を fake_random.FakeRandom に差し替えた状態で、実際の API
（/api/start_hand・/api/action・/api/state）を TestClient で叩いてハンドを最後まで進め、
レスポンスの JSON 全体と統計の保存呼び出しを記録する。
JS 版（static/poker/game.js）は同じシードの Rng.seeded で同じ操作を再生し、全件一致を確認する
（tools/golden/check_js.js の game_tape）。

    python3 tools/golden/game_tape.py          # 生成（挙動を意図的に変えた時だけ）
    python3 tools/golden/game_tape.py --check  # 再現確認

ヒーローの行動はテープとは別の乱数で選んで記録する（JS はそれをそのまま再生する）。
"""
import argparse
import json
import os
import random
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
os.environ.setdefault("OPENAI_API_KEY", "dummy")
os.environ.setdefault("POKER_DB_PATH", os.path.join(tempfile.mkdtemp(), "golden.db"))
os.chdir(ROOT)  # app は static/ を相対パスでマウントする

from fastapi.testclient import TestClient  # noqa: E402
import app as A  # noqa: E402
import stats_logger  # noqa: E402
from fake_random import patched  # noqa: E402

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vectors", "game_tape.json")
GAMES = 40
HANDS_PER_GAME = 5  # 同じエンジンで続けて遊ぶ（4ハンドに1回のレンジ内配布も通るように）


def choose_action(policy, state):
    """ヒーローの行動（合法手の中から）。金額はアプリ（script.js）のプリセットに合わせ、
    境界値（プリフロップの合計ちょうど 5.0bb = CPU の「標準オープン」判定の境目）とオールインも混ぜる。"""
    facing = state["facingBet"]
    pot = state["potSize"]
    street = state["street"]
    invested = state["currentBet"] - facing   # ヒーローが今のストリートで入れている額
    to_five = 5.0 - invested
    if facing > 0:
        kind = policy.choices(["FOLD", "CALL", "RAISE"], weights=[15, 50, 35])[0]
        if kind != "RAISE":
            return kind, 0.0
        if street == "PREFLOP":
            if state["currentBet"] <= 1.0:   # オープン（script.js: 2.0 / 2.5 / 3.0bb）
                sizes = [2.0, 2.5, 3.0, to_five, 200.0]
            else:                            # 3ベット（2.7x〜3.5x）/ 4ベット以降（2.2x〜2.8x）
                sizes = [facing * 2.7, facing * 3.0, facing * 3.5, facing * 2.2, facing * 2.8, 200.0]
                if to_five > facing:
                    sizes.append(to_five)
        else:
            sizes = [facing * 2.5, facing * 3.0, facing * 3.5, 200.0]
        return kind, round(policy.choice(sizes), 1)
    kind = policy.choices(["CHECK", "BET"], weights=[55, 45])[0]
    if kind == "BET":
        if street == "PREFLOP":
            return kind, round(policy.choice([2.0, 2.5, 3.0, to_five, 200.0]), 1)
        return kind, round(policy.choice([pot * 0.33, pot * 0.5, pot * 0.75, pot, 200.0]), 1)
    return kind, 0.0


def run_game(seed, spot, position):
    calls = []
    orig = {n: getattr(stats_logger, n) for n in ("start_session", "log_action", "finish_hand")}
    stats_logger.start_session = lambda sid, pos, hand, user_id="": calls.append(
        {"fn": "start_session", "hero_pos": pos, "hero_hand": hand})
    stats_logger.log_action = lambda **kw: calls.append(
        {"fn": "log_action", **{k: v for k, v in kw.items() if k not in ("session_id", "user_id")}})
    stats_logger.finish_hand = lambda **kw: calls.append(
        {"fn": "finish_hand", **{k: v for k, v in kw.items() if k != "session_id"}})
    policy = random.Random(seed * 7 + 1)  # テープとは別系統（Random インスタンスは差し替えの影響を受けない）
    steps = []
    try:
        A._user_engines.clear()
        client = TestClient(A.app)
        with patched(seed) as fake:
            for _ in range(HANDS_PER_GAME):
                params = {"user_id": "g", "spot": spot, "position": position}
                res = client.get("/api/start_hand", params=params).json()
                steps.append({"kind": "start_hand", "req": {"spot": spot, "position": position},
                              "res": res, "rng": fake.count})
                state = res
                for _ in range(30):
                    if state.get("finished"):
                        break
                    if policy.random() < 0.1:  # リロード相当
                        st = client.get("/api/state", params={"user_id": "g"}).json()
                        steps.append({"kind": "state", "req": {}, "res": st, "rng": fake.count})
                    action, amount = choose_action(policy, state)
                    r = client.post("/api/action", json={"action": action, "amount": amount, "user_id": "g"})
                    assert r.status_code == 200, r.text
                    res = r.json()
                    steps.append({"kind": "action", "req": {"action": action, "amount": amount},
                                  "res": res, "rng": fake.count})
                    state = res["state"]
                st = client.get("/api/state", params={"user_id": "g"}).json()
                steps.append({"kind": "state", "req": {}, "res": st, "rng": fake.count})
    finally:
        for n, f in orig.items():
            setattr(stats_logger, n, f)
    return {"seed": seed, "spot": spot, "position": position, "steps": steps, "stats": calls}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()

    games = []
    for g in range(GAMES):
        spot = g % 5 == 4
        position = ["", "BB", "SB", "BTN", "UTG", "CO", "HJ"][g % 7] if spot else ""
        games.append(run_game(1000 + g, spot, position))

    # 集計（カバー範囲の確認用）
    from collections import Counter
    msgs = Counter()
    for gm in games:
        for s in gm["steps"]:
            if s["kind"] == "action":
                m = s["res"].get("message") or ("continue" if s["res"]["state"]["finished"] is False else "?")
                msgs[m.split("=>")[-1].strip()] += 1
    print("  終わり方:", dict(msgs))
    print("  CPU の行動:", dict(Counter(a["action"] for gm in games for s in gm["steps"]
                                      for a in s["res"].get("cpuActions", []))))

    rows = [json.dumps(gm, ensure_ascii=False, sort_keys=True, separators=(",", ":")) for gm in games]
    text = "[\n" + ",\n".join(rows) + "\n]"
    if args.check:
        old = open(OUT, encoding="utf-8").read() if os.path.exists(OUT) else ""
        print("  OK 再現一致" if old == text else "  NG 差分あり")
        sys.exit(0 if old == text else 1)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(text)
    n_steps = sum(len(gm["steps"]) for gm in games)
    print(f"  書き出し {len(games)} ゲーム / {n_steps} ステップ / {len(text) / 1024:.0f} KB")


if __name__ == "__main__":
    main()
