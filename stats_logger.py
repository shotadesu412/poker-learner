"""
stats_logger.py
ポーカーアクション履歴をSQLiteに永続保存し、各種分析メトリクスを集計するモジュール。
Render Starterプランの永続ディスクを活用。
"""
import sqlite3
import os
from datetime import datetime, timedelta, timezone
from typing import Optional

# DBファイルのパス — 環境変数で上書き可能
DB_PATH = os.environ.get("POKER_DB_PATH", "poker_stats.db")


def _get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def setup_db():
    """テーブルを初期化（初回起動時のみ実行）"""
    conn = _get_conn()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS actions (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id  TEXT    NOT NULL,
            timestamp   TEXT    NOT NULL,
            street      TEXT    NOT NULL,
            actor       TEXT    NOT NULL,
            action      TEXT    NOT NULL,
            amount      REAL    DEFAULT 0.0,
            equity      REAL    DEFAULT 0.0,
            pot_size    REAL    DEFAULT 0.0,
            hero_pos    TEXT    DEFAULT '',
            evaluation  TEXT    DEFAULT '',
            ev_loss     REAL    DEFAULT 0.0
        )
    """)
    # セッションテーブル (ハンド単位のサマリー)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS sessions (
            session_id  TEXT PRIMARY KEY,
            started_at  TEXT NOT NULL,
            hero_pos    TEXT DEFAULT '',
            result      TEXT DEFAULT ''  -- WIN/LOSE/FOLD
        )
    """)
    conn.commit()
    conn.close()


def log_action(
    session_id: str,
    street: str,
    actor: str,
    action: str,
    amount: float,
    equity: float,
    pot_size: float,
    hero_pos: str,
    evaluation: str = "",
    ev_loss: float = 0.0,
):
    """アクションを1件記録する"""
    conn = _get_conn()
    conn.execute(
        """INSERT INTO actions
           (session_id, timestamp, street, actor, action, amount, equity, pot_size, hero_pos, evaluation, ev_loss)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            session_id,
            datetime.now(timezone.utc).isoformat(),
            street,
            actor,
            action,
            amount,
            equity,
            pot_size,
            hero_pos,
            evaluation,
            ev_loss,
        ),
    )
    conn.commit()
    conn.close()


def start_session(session_id: str, hero_pos: str):
    conn = _get_conn()
    conn.execute(
        "INSERT OR IGNORE INTO sessions (session_id, started_at, hero_pos) VALUES (?, ?, ?)",
        (session_id, datetime.now(timezone.utc).isoformat(), hero_pos),
    )
    conn.commit()
    conn.close()


def end_session(session_id: str, result: str):
    conn = _get_conn()
    conn.execute(
        "UPDATE sessions SET result=? WHERE session_id=?",
        (result, session_id),
    )
    conn.commit()
    conn.close()


def _period_filter(period: str) -> str:
    """期間フィルタ用のSQLサブクエリを返す"""
    now = datetime.now(timezone.utc)
    if period == "7d":
        cutoff = (now - timedelta(days=7)).isoformat()
        return f"AND timestamp >= '{cutoff}'"
    elif period == "30d":
        cutoff = (now - timedelta(days=30)).isoformat()
        return f"AND timestamp >= '{cutoff}'"
    elif period == "last":
        # 直近1セッション
        return "AND session_id = (SELECT session_id FROM actions WHERE actor='HERO' ORDER BY timestamp DESC LIMIT 1)"
    return ""  # all


# ==============================
# 集計クエリ群
# ==============================

def get_overview(period: str = "all") -> dict:
    """
    GTO一致率、VPIP、PFR、3-Bet率を集計して返す。
    """
    pf = _period_filter(period)
    conn = _get_conn()

    # 全HEROアクション数
    total = conn.execute(
        f"SELECT COUNT(*) FROM actions WHERE actor='HERO' {pf}"
    ).fetchone()[0]

    if total == 0:
        conn.close()
        return {
            "total_actions": 0,
            "gto_match_rate": 0.0,
            "vpip": 0.0,
            "pfr": 0.0,
            "three_bet_rate": 0.0,
            "avg_ev_loss": 0.0,
        }

    # GTO一致率 (◎ or ◯)
    gto_match = conn.execute(
        f"SELECT COUNT(*) FROM actions WHERE actor='HERO' AND evaluation IN ('◎','◯') {pf}"
    ).fetchone()[0]

    # VPIP: プリフロップでCALL/BET/RAISEした割合
    pf_total_hands = conn.execute(
        f"SELECT COUNT(DISTINCT session_id) FROM actions WHERE actor='HERO' AND street='PREFLOP' {pf}"
    ).fetchone()[0]

    vpip_hands = conn.execute(
        f"""SELECT COUNT(DISTINCT session_id) FROM actions
            WHERE actor='HERO' AND street='PREFLOP'
            AND action IN ('CALL','BET','RAISE') {pf}"""
    ).fetchone()[0]

    # PFR: プリフロップでRAISE/BETした割合
    pfr_hands = conn.execute(
        f"""SELECT COUNT(DISTINCT session_id) FROM actions
            WHERE actor='HERO' AND street='PREFLOP'
            AND action IN ('RAISE','BET') {pf}"""
    ).fetchone()[0]

    # 3-Bet率: プリフロップでRAISEした中で、current_betが既にある状態（amount > 3.5 は3bet相当）
    three_bet = conn.execute(
        f"""SELECT COUNT(*) FROM actions
            WHERE actor='HERO' AND street='PREFLOP'
            AND action='RAISE' AND amount > 3.5 {pf}"""
    ).fetchone()[0]

    # 平均EV損失
    avg_ev_loss = conn.execute(
        f"SELECT AVG(ev_loss) FROM actions WHERE actor='HERO' AND ev_loss > 0 {pf}"
    ).fetchone()[0] or 0.0

    conn.close()

    hands = max(pf_total_hands, 1)
    return {
        "total_actions": total,
        "gto_match_rate": round(gto_match / total * 100, 1),
        "vpip": round(vpip_hands / hands * 100, 1),
        "pfr": round(pfr_hands / hands * 100, 1),
        "three_bet_rate": round(three_bet / hands * 100, 1),
        "avg_ev_loss": round(avg_ev_loss, 3),
    }


def get_position_stats() -> list:
    """ポジション別 参加率・レイズ率・GTO一致率 を集計"""
    conn = _get_conn()
    positions = ["LJ", "HJ", "CO", "BTN", "SB", "BB"]
    result = []

    for pos in positions:
        hands = conn.execute(
            "SELECT COUNT(DISTINCT session_id) FROM actions WHERE actor='HERO' AND street='PREFLOP' AND hero_pos=?",
            (pos,),
        ).fetchone()[0]

        if hands == 0:
            result.append({"pos": pos, "hands": 0, "vpip": 0.0, "pfr": 0.0, "gto_rate": 0.0})
            continue

        vpip = conn.execute(
            "SELECT COUNT(DISTINCT session_id) FROM actions WHERE actor='HERO' AND street='PREFLOP' AND hero_pos=? AND action IN ('CALL','BET','RAISE')",
            (pos,),
        ).fetchone()[0]

        pfr = conn.execute(
            "SELECT COUNT(DISTINCT session_id) FROM actions WHERE actor='HERO' AND street='PREFLOP' AND hero_pos=? AND action IN ('RAISE','BET')",
            (pos,),
        ).fetchone()[0]

        total_eval = conn.execute(
            "SELECT COUNT(*) FROM actions WHERE actor='HERO' AND hero_pos=? AND evaluation != ''",
            (pos,),
        ).fetchone()[0]
        good_eval = conn.execute(
            "SELECT COUNT(*) FROM actions WHERE actor='HERO' AND hero_pos=? AND evaluation IN ('◎','◯')",
            (pos,),
        ).fetchone()[0]

        result.append({
            "pos": pos,
            "hands": hands,
            "vpip": round(vpip / hands * 100, 1),
            "pfr": round(pfr / hands * 100, 1),
            "gto_rate": round(good_eval / max(total_eval, 1) * 100, 1),
        })

    conn.close()
    return result


def get_street_eval_dist() -> dict:
    """ストリート別 評価分布（◎/◯/△/×の件数）を集計"""
    conn = _get_conn()
    streets = ["PREFLOP", "FLOP", "TURN", "RIVER"]
    result = {}

    for st in streets:
        row = {}
        for ev in ["◎", "◯", "△", "×"]:
            count = conn.execute(
                "SELECT COUNT(*) FROM actions WHERE actor='HERO' AND street=? AND evaluation=?",
                (st, ev),
            ).fetchone()[0]
            row[ev] = count
        result[st] = row

    conn.close()
    return result


def get_leaks() -> list:
    """EV損失が大きいシチュエーションTop5を特定"""
    conn = _get_conn()

    rows = conn.execute(
        """
        SELECT street, action, hero_pos, evaluation,
               AVG(ev_loss) as avg_ev_loss,
               COUNT(*) as cnt
        FROM actions
        WHERE actor='HERO' AND ev_loss > 0.01 AND evaluation IN ('△','×')
        GROUP BY street, action, hero_pos
        ORDER BY avg_ev_loss DESC
        LIMIT 5
        """
    ).fetchall()

    leaks = []
    for r in rows:
        desc = _leak_description(r["street"], r["action"], r["hero_pos"], r["evaluation"])
        leaks.append({
            "street": r["street"],
            "action": r["action"],
            "pos": r["hero_pos"],
            "evaluation": r["evaluation"],
            "avg_ev_loss": round(r["avg_ev_loss"], 3),
            "count": r["cnt"],
            "description": desc,
        })

    conn.close()
    return leaks


def _leak_description(street: str, action: str, pos: str, evaluation: str) -> str:
    """リーク内容を人間が読みやすい日本語に変換"""
    ev_label = {"△": "やや問題", "×": "大きな問題"}
    prefix = ev_label.get(evaluation, "")
    action_jp = {"FOLD": "フォールド過多", "CALL": "コール（ステーション傾向）", "RAISE": "オーバーベット", "BET": "ベットサイジング不正確", "CHECK": "パッシブなチェック"}.get(action, action)
    return f"[{prefix}] {pos}ポジション {street}での{action_jp}"


def reset_all():
    """全データをリセット（デバッグ・開発用）"""
    conn = _get_conn()
    conn.execute("DELETE FROM actions")
    conn.execute("DELETE FROM sessions")
    conn.commit()
    conn.close()
