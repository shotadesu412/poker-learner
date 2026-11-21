"""App Storeスクショ用に、見栄えの良い統計データをローカルDBへ流し込む。

本番DBには一切触れない。POKER_DB_PATH で指定した使い捨てファイルにのみ書く。
実際のユーザー行動から生まれる分布に寄せつつ、too-good-to-be-trueにならない
程度のばらつき（△や×も混ぜる）を持たせる。
"""
import os
import random
import sys
import uuid
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

DB_PATH = os.environ["POKER_DB_PATH"]  # 呼び出し側で必ず設定させる（本番誤爆防止）
import stats_logger  # noqa: E402

USER_ID = "shot_seed_user"
POSITIONS = ["LJ", "HJ", "CO", "BTN", "SB", "BB"]
EVAL_WEIGHTS = [("◎", 40), ("◯", 35), ("△", 18), ("×", 7)]

random.seed(7)


def pick_eval():
    r = random.uniform(0, 100)
    acc = 0
    for sym, w in EVAL_WEIGHTS:
        acc += w
        if r <= acc:
            return sym
    return "◯"


def rand_hand():
    ranks = "AKQJT98765432"
    r1, r2 = random.choice(ranks), random.choice(ranks)
    suits = "shdc"
    return f"{r1}{random.choice(suits)},{r2}{random.choice(suits)}"


def main():
    stats_logger.setup_db()
    now = datetime.now(timezone.utc)

    for i in range(48):
        session_id = str(uuid.uuid4())
        pos = random.choices(POSITIONS, weights=[14, 16, 18, 22, 12, 18])[0]
        ts = now - timedelta(hours=random.uniform(0, 24 * 20))

        stats_logger.start_session(session_id, pos, rand_hand(), USER_ID)

        streets = ["PREFLOP"]
        if random.random() < 0.55:
            streets.append("FLOP")
        if len(streets) > 1 and random.random() < 0.5:
            streets.append("TURN")
        if len(streets) > 2 and random.random() < 0.45:
            streets.append("RIVER")

        action_log = []
        pot = 1.5
        for street in streets:
            action = random.choices(
                ["CALL", "RAISE", "BET", "CHECK", "FOLD"],
                weights=[30, 20, 20, 25, 5],
            )[0]
            amount = round(random.uniform(2, 12), 1) if action in ("BET", "RAISE") else 0.0
            eq = round(random.uniform(30, 75), 1)
            ev_sym = pick_eval()
            ev_loss = round(random.uniform(0.1, 3.5), 2) if ev_sym in ("△", "×") else 0.0
            pot += amount

            stats_logger.log_action(
                session_id=session_id, street=street, actor="HERO", action=action,
                amount=amount, equity=eq, pot_size=pot, hero_pos=pos,
                evaluation=ev_sym, ev_loss=ev_loss, user_id=USER_ID,
            )
            action_log.append({"street": street, "actor": "HERO", "action": action, "amount": amount})

            cpu_action = random.choice(["CALL", "CHECK", "RAISE", "BET"])
            cpu_amount = round(random.uniform(2, 10), 1) if cpu_action in ("BET", "RAISE") else 0.0
            action_log.append({"street": street, "actor": "CPU", "action": cpu_action, "amount": cpu_amount})

            if action == "FOLD":
                break

        winner = random.choices(["YOU", "CPU", "TIE"], weights=[46, 46, 8])[0]
        board = ",".join(random.sample(
            [r + s for r in "AKQJT98765432" for s in "shdc"], 5
        )) if len(streets) > 1 else ""

        stats_logger.finish_hand(
            session_id=session_id, winner=winner, final_pot=round(pot, 1),
            board=board, cpu_hand=rand_hand(), action_log=action_log,
        )

    # AIコーチ履歴も2件だけ入れておく（分析ページの「AIコーチ履歴」セクション用）
    stats_logger.save_ai_feedback(
        user_id=USER_ID, session_id=str(uuid.uuid4()),
        hand_context="=== Current hand ===\nBoard: ['Kh','7c','2d']\n",
        ai_feedback="[Overview]\nSolid flop c-bet, but the turn barrel with a weak pair is thin. "
                    "[What went well]\nGood preflop sizing and position awareness.",
    )
    stats_logger.save_ai_feedback(
        user_id=USER_ID, session_id=str(uuid.uuid4()),
        hand_context="=== Current hand ===\nBoard: ['Qs','Ts','4h','2c']\n",
        ai_feedback="[Overview]\nYour river check-call is well justified given the pot odds. "
                    "[What went well]\nRecognizing the bluff-catcher spot and defending correctly.",
    )

    print(f"seeded {DB_PATH}")


if __name__ == "__main__":
    main()
