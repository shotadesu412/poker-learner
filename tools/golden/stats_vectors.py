"""統計の集計用ベクタ（フェーズ6: 統計を端末の IndexedDB へ移すための JS 移植）。

ゲームテープ（game_tape.json）に記録された実際の保存呼び出しを、偽の時計で60日に散らして
本物の stats_logger 経由で SQLite に保存し、分析ページの全 API の戻り値を記録する。
JS 版（static/poker/stats_calc.js）は export_user_data() の行だけから同じ集計を出す
（tools/golden/check_js.js の stats_calc）。

    python3 tools/golden/stats_vectors.py          # 生成（集計を意図的に変えた時だけ）
    python3 tools/golden/stats_vectors.py --check  # 再現確認

同じ DB に別ユーザー（B）のハンドも時間を交互にして混ぜ、B の方が後に遊んだ状態にする
（「直近1セッション」がユーザーで絞られているかを確認するため）。
"""
import argparse
import json
import os
import sys
import tempfile
from datetime import datetime, timedelta, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
os.environ.setdefault("POKER_DB_PATH", os.path.join(tempfile.mkdtemp(), "stats_golden.db"))

import i18n  # noqa: E402
import stats_logger as S  # noqa: E402

VEC = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vectors")
OUT = os.path.join(VEC, "stats_calc.json")
USER_A = "user-A_1234"
USER_B = "user-B_5678"
PERIODS = ["all", "30d", "7d", "last"]


class Clock:
    now = None


class FakeDatetime(datetime):
    @classmethod
    def now(cls, tz=None):
        return Clock.now


def build_db():
    S.datetime = FakeDatetime
    S.setup_db()
    games = json.load(open(os.path.join(VEC, "game_tape.json"), encoding="utf-8"))
    # ゲームをハンド単位に分解
    hands = []
    for gm in games:
        cur = None
        for c in gm["stats"]:
            if c["fn"] == "start_session":
                cur = [c]
                hands.append(cur)
            else:
                cur.append(c)
    base = datetime(2026, 7, 29, 3, 0, 0, 250000, tzinfo=timezone.utc)
    span = timedelta(days=60)
    n = len(hands)
    for i, calls in enumerate(hands):
        user = USER_B if i % 5 == 4 else USER_A
        sid = f"sid-{i:04d}"
        t = base + span * i / n
        if i % 23 == 7:
            t = t.replace(microsecond=0)   # isoformat が小数部を省略するケース
        hero_hand = calls[0]["hero_hand"] if i % 41 != 3 else ""   # 手札未記録の旧データ
        Clock.now = t
        S.start_session(sid, calls[0]["hero_pos"], hero_hand, user_id=user)
        for k, c in enumerate(calls[1:]):
            Clock.now = t + timedelta(seconds=7 * (k + 1), microseconds=k * 1111)
            if c["fn"] == "log_action":
                kw = {k2: v for k2, v in c.items() if k2 != "fn"}
                S.log_action(session_id=sid, user_id=user, **kw)
            elif i % 17 != 5:   # action_log 保存前の旧データ（finish_hand が無い）
                kw = {k2: v for k2, v in c.items() if k2 != "fn"}
                S.finish_hand(session_id=sid, **kw)
        if user == USER_A and i % 3 == 0:
            Clock.now = t + timedelta(minutes=5)
            S.save_ai_feedback(user, sid, f"context {i}\n[PREFLOP] HERO", f"feedback {i}")
    # 最後は B が遊んだ状態にする
    Clock.now = base + span + timedelta(hours=1)
    S.start_session("sid-B-last", "BTN", "Ah,Kd", user_id=USER_B)
    S.log_action(session_id="sid-B-last", street="PREFLOP", actor="HERO", action="RAISE", amount=2.5,
                 equity=0.6, pot_size=1.5, hero_pos="BTN", evaluation="◎", ev_loss=0.0, user_id=USER_B)
    return hands


def snapshot(now):
    Clock.now = now
    out = {"now": now.isoformat(), "results": {}}
    for lang in ("ja", "en"):
        i18n.set_lang(lang)
        r = {}
        for p in PERIODS:
            r[f"overview:{p}"] = S.get_overview(p, USER_A)
            r[f"personal_range:{p}"] = S.get_personal_range_stats(p, USER_A)
        r["position"] = S.get_position_stats(USER_A)
        r["streets"] = S.get_street_eval_dist(USER_A)
        r["leaks"] = S.get_leaks(USER_A)
        r["saved_hands"] = S.get_saved_hands(USER_A)
        r["hand_history:30"] = S.get_hand_history(USER_A, 30)
        r["hand_history:1000"] = S.get_hand_history(USER_A, 1000)
        out["results"][lang] = r
    return out


def generate():
    build_db()
    data = S.export_user_data(USER_A)
    assert data["actions"] and all(a["user_id"] == USER_A for a in data["actions"])
    first = datetime.fromisoformat(data["actions"][0]["timestamp"])
    nows = [
        datetime(2026, 9, 27, 4, 30, 0, 123456, tzinfo=timezone.utc),   # 通常
        datetime(2026, 9, 27, 4, 30, 0, 0, tzinfo=timezone.utc),        # 小数部が省略される now
    ]
    # 期間の境界ちょうど（timestamp == cutoff）を踏む now
    t30 = datetime.fromisoformat(data["actions"][len(data["actions"]) // 3]["timestamp"])
    t7 = datetime.fromisoformat(data["actions"][len(data["actions"]) * 7 // 8]["timestamp"])
    nows.append(t30 + timedelta(days=30))
    nows.append(t7 + timedelta(days=7))
    assert first < nows[0]
    return {"user_id": USER_A, "data": data, "snapshots": [snapshot(n) for n in nows]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()
    vec = generate()
    text = json.dumps(vec, ensure_ascii=False, sort_keys=True)
    if args.check:
        old = open(OUT, encoding="utf-8").read()
        if old != text:
            print("NG stats_calc: 生成結果が保存済みのベクタと違う")
            sys.exit(1)
        print("OK stats_calc")
        return
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(text)
    d = vec["data"]
    print(f"保存: {OUT}  actions={len(d['actions'])} sessions={len(d['sessions'])} "
          f"saved_hands={len(d['saved_hands'])} snapshots={len(vec['snapshots'])}")


if __name__ == "__main__":
    main()
