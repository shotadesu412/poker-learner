from fastapi import FastAPI, HTTPException, Query
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel
from poker_engine import PokerEngine, Evaluator
from equity import EquityCalculator
from treys import Card
import os
import uuid
from openai import OpenAI
import stats_logger

app = FastAPI(title="Poker Evaluator MVP")

# OpenAI API Setup
# Requires OPENAI_API_KEY environment variable.
openai_api_key = os.environ.get("OPENAI_API_KEY", "")
openai_client = OpenAI(api_key=openai_api_key)

# Stats DB の初期化
stats_logger.setup_db()

# Make static dir
os.makedirs("static", exist_ok=True)
app.mount("/static", StaticFiles(directory="static"), name="static")

# ==============================
# ユーザーごとのエンジン管理（大人数対応）
# ==============================
_user_engines: dict[str, PokerEngine] = {}
_user_sessions: dict[str, str] = {}

def _get_engine(user_id: str) -> PokerEngine:
    """ユーザーIDごとに独立したPokerEngineインスタンスを返す"""
    uid = user_id or "default"
    if uid not in _user_engines:
        _user_engines[uid] = PokerEngine()
    return _user_engines[uid]

def _get_session_id(user_id: str) -> str:
    uid = user_id or "default"
    return _user_sessions.get(uid, "")

def _set_session_id(user_id: str, session_id: str):
    uid = user_id or "default"
    _user_sessions[uid] = session_id


@app.get("/")
def serve_home():
    return FileResponse("static/home.html")

@app.get("/play")
def serve_index():
    return FileResponse("static/index.html")

@app.get("/api/test_sync")
def test_sync():
    return {"status": "SYNCED"}

@app.get("/api/state")
def get_current_state(user_id: str = Query("")):
    """
    現在のゲーム状態を返す。ページ再読み込み時に既存の手を復元するために使用。
    hero_hand が空の場合またはハンド終了済みの場合は has_hand_in_progress=False を返す。
    """
    eng = _get_engine(user_id)
    if not eng.hero_hand or eng.hand_finished:
        return {"has_hand_in_progress": False}
    state = get_game_state(eng)
    state["has_hand_in_progress"] = True
    return state


class ActionRequest(BaseModel):
    action: str
    amount: float = 0.0
    user_id: str = ""

class ChatMessage(BaseModel):
    role: str
    content: str

class AICoachRequest(BaseModel):
    messages: list[ChatMessage]
    user_id: str = "guest"

@app.get("/api/start_hand")
def start_hand(user_id: str = Query("")):
  try:
    eng = _get_engine(user_id)
    MAX_RETRIES = 50
    cpu_msg = ""

    # 新しいハンドのセッションIDを発行（ユーザーごとに管理）
    new_session_id = str(uuid.uuid4())
    _set_session_id(user_id, new_session_id)

    for _ in range(MAX_RETRIES):
        eng.start_new_hand()
        cpu_msg = ""

        # Heroが先手（BTNなど）の場合は、そのままゲーム開始
        if eng.is_hero_turn():
            break

        # CPUが先手の場合のアクションを計算
        hero_eq_next, cpu_eq_next = EquityCalculator.calc_equity_monte_carlo(eng.hero_hand, eng.board, eng.hero_range_dict, eng.cpu_range_dict, iterations=50)
        cpu_facing = eng.current_bet - eng.cpu_invested
        cpu_action, cpu_amount = eng.cpu_decide(cpu_eq_next, "CHECK", cpu_facing)

        # 初手でフォールドした場合はループを継続し、裏で即座に配り直す
        if cpu_action == "FOLD":
            continue

        # フォールド以外（CALL, BET, RAISE）でポットに参加してきた場合はループを抜けてゲーム開始
        if cpu_action in ["CALL", "BET", "RAISE"]:
            bet_amount = cpu_facing if cpu_action == "CALL" else cpu_amount
            eng.place_bet("CPU", bet_amount)
            # アクション履歴に記録（これにより cpu_has_acted=True → ポジション表示される）
            eng.record_action("CPU", cpu_action, bet_amount, 0.5, eng.pot_size)
            cpu_msg = f"CPU {cpu_action}S {bet_amount > 0 and str(round(bet_amount, 1)) + 'bb' or ''}".strip()
            break

    hero_hand_str = ",".join([Card.int_to_str(c) for c in eng.hero_hand]) if eng.hero_hand else ""
    stats_logger.start_session(new_session_id, eng.hero_position, hero_hand_str, user_id=user_id)

    state = get_game_state(eng)
    if cpu_msg:
        state["cpuMessage"] = cpu_msg

    return state
  except Exception as e:
    import traceback
    with open('trace_start.txt', 'w', encoding='utf-8') as f:
        traceback.print_exc(file=f)
    raise HTTPException(status_code=500, detail=str(e))

import traceback
@app.post("/api/action")
def take_action(req: ActionRequest):
    try:
        action = req.action.upper()
        amount = req.amount
        user_id = req.user_id or ""
        eng = _get_engine(user_id)
        current_session_id = _get_session_id(user_id)

        # 1. Calc Equity
        # Determine if 3bet pot (heuristic based on standard sizings)
        is_3bet_pot = (eng.street == "PREFLOP" and eng.current_bet > 2.5) or (eng.street != "PREFLOP" and eng.pot_size > 12.0)
        effective_stack = min(eng.hero_stack, eng.cpu_stack)

        is_preflop = (eng.street == "PREFLOP")
        hero_eq, cpu_eq = EquityCalculator.calc_equity_monte_carlo(eng.hero_hand, eng.board, eng.hero_range_dict, eng.cpu_range_dict, is_preflop=is_preflop, iterations=100)
        hero_range_adv = EquityCalculator.calc_range_advantage(eng.hero_hand, eng.board, eng.hero_range_dict, eng.cpu_range_dict, is_preflop=is_preflop, iterations=100)

        eqr = Evaluator.get_eqr_modifier(eng.hero_position, eng.hero_hand, is_3bet_pot, eng.board, range_adv=hero_range_adv)
        realized_equity = hero_eq * eqr

        eval_result = "N/A"
        eval_reason = ""

        # 2. Evaluate Hero Action
        hero_facing = eng.current_bet - eng.hero_invested

        if action == "FOLD":
            eng.update_range_dict("HERO", "FOLD", 0)
            eng.record_action("HERO", "FOLD", 0, realized_equity, eng.pot_size)
            eval_dict = Evaluator.evaluate_fold(
                hero_eq, hero_facing, eng.pot_size,
                hero_pos=eng.hero_position, cards=eng.hero_hand, is_3bet_pot=is_3bet_pot, board=eng.board, range_adv=hero_range_adv
            )
            ev_fold = eval_dict.get("ev", 0.0)
            ev_call_alt = Evaluator.ev_call(hero_eq, eng.pot_size, hero_facing) if hero_facing > 0 else 0.0
            ev_loss_fold = max(0.0, ev_call_alt - ev_fold)
            stats_logger.log_action(
                session_id=current_session_id, street=eng.street, actor="HERO",
                action="FOLD", amount=0.0, equity=realized_equity, pot_size=eng.pot_size,
                hero_pos=eng.hero_position, evaluation=eval_dict["evaluation"], ev_loss=ev_loss_fold,
                user_id=user_id
            )
            eng.hand_finished = True
            # プリフロップのフォールドではCPUのハンドを公開しない
            show_cpu = (eng.street != "PREFLOP")
            return {"evaluation": eval_dict["evaluation"], "reason": eval_dict["reason"], "ev_loss": round(ev_loss_fold, 3), "metrics": eval_dict, "state": get_game_state(eng, finished=True, show_cpu_hand=show_cpu), "message": "You Folded"}

        elif action == "CALL":
            call_amount = hero_facing
            eval_dict = Evaluator.evaluate_call(
                hero_eq, call_amount, eng.pot_size,
                hero_pos=eng.hero_position, cards=eng.hero_hand, is_3bet_pot=is_3bet_pot, board=eng.board, effective_stack=effective_stack, range_adv=hero_range_adv, hero_range_dict=eng.hero_range_dict
            )
            eval_result = eval_dict["evaluation"]
            eval_reason = eval_dict["reason"]
            ev_call_val = eval_dict.get("ev", 0.0)
            ev_check_alt = Evaluator.ev_check(hero_eq, eng.pot_size)
            ev_loss_call = max(0.0, ev_check_alt - ev_call_val) if ev_check_alt > ev_call_val else 0.0
            eng.update_range_dict("HERO", "CALL", call_amount)
            eng.record_action("HERO", "CALL", call_amount, realized_equity, eng.pot_size)
            eng.place_bet("HERO", call_amount)
            stats_logger.log_action(
                session_id=current_session_id, street=eng.street, actor="HERO",
                action="CALL", amount=call_amount, equity=realized_equity, pot_size=eng.pot_size,
                hero_pos=eng.hero_position, evaluation=eval_result, ev_loss=ev_loss_call,
                user_id=user_id
            )

        elif action in ["BET", "RAISE"]:
            if action == "RAISE":
                eval_dict = Evaluator.evaluate_raise(
                    hero_eq, amount, hero_facing, eng.pot_size,
                    hero_pos=eng.hero_position, cards=eng.hero_hand, board=eng.board, range_adv=hero_range_adv, hero_range_dict=eng.hero_range_dict
                )
            else:
                eval_dict = Evaluator.evaluate_bet(
                    hero_eq, amount, eng.pot_size,
                    hero_pos=eng.hero_position, cards=eng.hero_hand, board=eng.board, range_adv=hero_range_adv, effective_stack=effective_stack
                )
            eval_result = eval_dict["evaluation"]
            eval_reason = eval_dict["reason"]
            ev_bet_val = eval_dict.get("ev", 0.0)
            ev_check_alt2 = Evaluator.ev_check(hero_eq, eng.pot_size)
            ev_loss_bet = max(0.0, ev_check_alt2 - ev_bet_val) if ev_check_alt2 > ev_bet_val else 0.0
            eng.update_range_dict("HERO", action, amount)
            eng.record_action("HERO", action, amount, realized_equity, eng.pot_size)
            eng.place_bet("HERO", amount)
            stats_logger.log_action(
                session_id=current_session_id, street=eng.street, actor="HERO",
                action=action, amount=amount, equity=realized_equity, pot_size=eng.pot_size,
                hero_pos=eng.hero_position, evaluation=eval_result, ev_loss=ev_loss_bet,
                user_id=user_id
            )

        elif action == "CHECK":
            eng.update_range_dict("HERO", "CHECK", 0)
            eng.record_action("HERO", "CHECK", 0, realized_equity, eng.pot_size)
            eval_dict = Evaluator.evaluate_check(
                hero_eq,
                eng.pot_size,
                hero_pos=eng.hero_position,
                has_initiative=(eng.aggressor == "HERO"),
                is_hero_ip=eng.is_hero_ip,
                cards=eng.hero_hand,
                board=eng.board,
                range_adv=hero_range_adv
            )
            eval_result = eval_dict["evaluation"]
            eval_reason = eval_dict["reason"]
            ev_check_val = eval_dict.get("ev", 0.0)
            ev_bet_alt = Evaluator.ev_bet(hero_eq, eng.pot_size, eng.pot_size * 0.66, fold_equity=0.3)
            ev_loss_check = max(0.0, ev_bet_alt - ev_check_val) if ev_bet_alt > ev_check_val else 0.0
            stats_logger.log_action(
                session_id=current_session_id, street=eng.street, actor="HERO",
                action="CHECK", amount=0.0, equity=realized_equity, pot_size=eng.pot_size,
                hero_pos=eng.hero_position, evaluation=eval_result, ev_loss=ev_loss_check,
                user_id=user_id
            )

        else:
            raise HTTPException(status_code=400, detail="Invalid action")

        # 3. CPU Action (Ideal) IF it is CPU's turn.
        cpu_facing = eng.current_bet - eng.cpu_invested

        # Check if Hero's action just closed the street
        street_closed_by_hero = False

        if action == "CALL":
            if eng.street == "PREFLOP" and eng.cpu_position == "BB" and eng.current_bet == 1.0:
                street_closed_by_hero = False
            else:
                street_closed_by_hero = abs(eng.hero_invested - eng.cpu_invested) < 0.01

        elif action == "CHECK":
            if eng.is_hero_ip or (eng.street == "PREFLOP" and eng.hero_position == "BB" and eng.current_bet == 1.0):
                street_closed_by_hero = True
            else:
                street_closed_by_hero = False

        cpu_msg = ""
        if street_closed_by_hero:
            cpu_action = "CHECK"
            cpu_amount = 0
        else:
            cpu_action, cpu_amount = eng.cpu_decide(cpu_eq, action, cpu_facing)

            if cpu_action == "FOLD":
                 eng.update_range_dict("CPU", "FOLD", 0)
                 eng.record_action("CPU", "FOLD", 0, cpu_eq, eng.pot_size)
                 eng.hand_finished = True
                 return {"evaluation": eval_result, "reason": eval_reason, "state": get_game_state(eng, finished=True), "message": "CPU Folded. You Win.", "cpuAction": "FOLD"}

            if cpu_action in ["CALL", "BET", "RAISE"]:
                 if cpu_action == "CALL":
                     eng.update_range_dict("CPU", "CALL", cpu_facing)
                     eng.record_action("CPU", "CALL", cpu_facing, cpu_eq, eng.pot_size)
                     eng.place_bet("CPU", cpu_facing)
                 else:
                     eng.update_range_dict("CPU", cpu_action, cpu_amount)
                     eng.record_action("CPU", cpu_action, cpu_amount, cpu_eq, eng.pot_size)
                     eng.place_bet("CPU", cpu_amount)

                 cpu_msg = f"CPU {cpu_action}S {cpu_amount > 0 and str(round(cpu_amount, 1)) + 'bb' or ''}".strip()
            elif cpu_action == "CHECK":
                 eng.update_range_dict("CPU", "CHECK", 0)
                 eng.record_action("CPU", "CHECK", 0, cpu_eq, eng.pot_size)
                 cpu_msg = "CPU CHECKS"

        # Check if CPU acting resolved the street
        hero_facing_after_cpu = eng.current_bet - eng.hero_invested
        if (cpu_action in ["CALL", "CHECK"] and hero_facing_after_cpu < 0.01) or street_closed_by_hero:
            # 4. Advance Street
            if eng.street == "RIVER":
                eng.hand_finished = True
                return {"evaluation": eval_result, "reason": eval_reason, "state": get_game_state(eng, finished=True), "message": f"{cpu_msg.strip()} => Showdown!", "cpuAction": cpu_action}

            current_idx = eng.STREETS.index(eng.street)
            if current_idx + 1 < len(eng.STREETS):
                next_street = eng.STREETS[current_idx + 1]
                eng.advance_street(next_street)

                if not eng.is_hero_turn():
                     hero_eq_next, cpu_eq_next = EquityCalculator.calc_equity_monte_carlo(eng.hero_hand, eng.board, eng.hero_range_dict, eng.cpu_range_dict, iterations=50)
                     cpu_action_2, cpu_amount_2 = eng.cpu_decide(cpu_eq_next, "CHECK", 0)

                     if cpu_action_2 in ["BET", "RAISE"]:
                          eng.update_range_dict("CPU", cpu_action_2, cpu_amount_2)
                          eng.record_action("CPU", cpu_action_2, cpu_amount_2, cpu_eq_next, eng.pot_size)
                          eng.place_bet("CPU", cpu_amount_2)
                          cpu_msg += f" | Next street CPU {cpu_action_2}S {round(cpu_amount_2, 1)}bb"
                     else:
                          eng.record_action("CPU", "CHECK", 0, cpu_eq_next, eng.pot_size)
                          cpu_msg += f" | Next street CPU CHECKS"
            else:
                eng.hand_finished = True
                return {"evaluation": eval_result, "reason": eval_reason, "state": get_game_state(eng, finished=True), "message": f"{cpu_msg.strip()} => Showdown!", "cpuAction": cpu_action}

        return {"evaluation": eval_result, "reason": eval_reason, "state": get_game_state(eng), "cpuAction": cpu_action, "cpuMessage": cpu_msg}
    except Exception as e:
        import traceback
        with open('trace.txt', 'w') as f:
            f.write(traceback.format_exc())
        raise HTTPException(status_code=500, detail=str(e))

def get_game_state(eng: PokerEngine, finished=False, show_cpu_hand=True):
    hero_eq, cpu_eq = EquityCalculator.calc_equity_monte_carlo(eng.hero_hand, eng.board, eng.hero_range_dict, eng.cpu_range_dict, iterations=50)
    realized_eq = min(1.0, max(0.0, hero_eq * Evaluator.get_eqr_modifier(eng.hero_position)))

    if finished and show_cpu_hand and not eng.cpu_hand:
        eng.generate_realized_cpu_hand()

    def compress_range(r_dict):
        s_weight, m_weight, w_weight = 0.0, 0.0, 0.0
        sorted_keys = list(r_dict.keys())
        t_len = len(sorted_keys)
        if t_len == 0: return {"strong": 0.33, "middle": 0.33, "weak": 0.34}

        for i, k in enumerate(sorted_keys):
            w = r_dict[k]
            if i < t_len * 0.30: s_weight += w
            elif i < t_len * 0.70: m_weight += w
            else: w_weight += w

        tot = s_weight + m_weight + w_weight
        if tot <= 0: return {"strong": 0.33, "middle": 0.33, "weak": 0.34}
        return {"strong": round(s_weight/tot, 2), "middle": round(m_weight/tot, 2), "weak": round(w_weight/tot, 2)}

    # CPUのポジション秘匿ロジック
    display_cpu_pos = eng.cpu_position
    if eng.street == "PREFLOP":
        cpu_has_acted = any(a["actor"] == "CPU" for a in eng.action_history)
        if not cpu_has_acted:
            display_cpu_pos = "???"

    # ショーダウン勝敗判定
    showdown_result = None
    if finished and show_cpu_hand and eng.cpu_hand and eng.hero_hand and len(eng.board) >= 3:
        try:
            hero_score = eng.treys_evaluator.evaluate(eng.board, eng.hero_hand)
            cpu_score  = eng.treys_evaluator.evaluate(eng.board, eng.cpu_hand)
            hero_class = eng.treys_evaluator.get_rank_class(hero_score)
            cpu_class  = eng.treys_evaluator.get_rank_class(cpu_score)
            from treys import Evaluator as TreysEval
            hero_hand_name = TreysEval.class_to_string(hero_class)
            cpu_hand_name  = TreysEval.class_to_string(cpu_class)
            if hero_score < cpu_score:
                winner = "YOU"
            elif cpu_score < hero_score:
                winner = "CPU"
            else:
                winner = "TIE"
            showdown_result = {
                "winner": winner,
                "heroHandName": hero_hand_name,
                "cpuHandName": cpu_hand_name,
            }
        except Exception:
            pass

    return {
        "street": eng.street,
        "potSize": round(eng.pot_size, 2),
        "heroStack": round(eng.hero_stack, 2),
        "cpuStack": round(eng.cpu_stack, 2),
        "heroPos": eng.hero_position,
        "cpuPos": display_cpu_pos,
        "facingBet": round(max(0.0, eng.current_bet - eng.hero_invested), 2),
        "currentBet": round(eng.current_bet, 2),
        "heroHand": [Card.int_to_str(c) for c in eng.hero_hand],
        "cpuHand": [Card.int_to_str(c) for c in eng.cpu_hand] if (finished and show_cpu_hand) else [],
        "board": [Card.int_to_str(c) for c in eng.board],
        "equity": round(realized_eq * 100, 1),
        "showdownResult": showdown_result,
        "heroRange": compress_range(eng.hero_range_dict),
        "cpuRange": compress_range(eng.cpu_range_dict),
        "heroRangeRaw": dict(eng.hero_range_dict),
        "cpuRangeRaw": dict(eng.cpu_range_dict),
        "bluffRatio": round(eng.calculate_theoretical_bluff_frequency(eng.current_bet, eng.pot_size) * 100, 1),
        "finished": finished,
        "history": eng.action_history
    }

@app.post("/api/ai_coach")
def ai_coach(req: AICoachRequest):
    if not openai_client.api_key:
        return {"reply": "エラー: OpenAI APIキーが設定されていません。環境変数をご確認ください。"}

    try:
        eng = _get_engine(req.user_id)
        current_session_id = _get_session_id(req.user_id)

        # Context building
        context_str = f"=== 現在のハンド情報 ===\nボード: {[Card.int_to_str(c) for c in eng.board]}\nHero(あなた): {[Card.int_to_str(c) for c in eng.hero_hand]}\nCPU: {[Card.int_to_str(c) for c in eng.cpu_hand] if eng.cpu_hand else '不明'}\nPOT: {eng.pot_size}bb\n\n=== アクション履歴 ===\n"

        for act in eng.action_history:
            amt = act.get('amount', 0)
            amt_str = f" {round(amt, 1)}bb" if amt > 0 else ""
            context_str += f"[{act['street']}] {act['actor']}: {act['action']}{amt_str}\n"

        system_prompt = f"""あなたは世界トップクラスのポーカープレイヤー兼GTOコーチです。
ユーザーから提供される「ハンド履歴と状況」だけを基に、Hero（プレイヤー）のプレイライン（ストーリー）をGTOの一般論から評価してください。

現在、このアプリは独自の評価エンジンの精度をテスト（デバッグ）しています。そのため、あなたの純粋なポーカー理論に基づいた客観的な意見が必要です。
以下の観点で、箇条書きを用いて鋭く、かつ論理的にコーチングしてください。

1. 【一般論に基づくアクションの妥当性】: 提供されたボードテクスチャとポジション、一般的なハンドレンジの概念から見て、Heroの各ストリートのアクションはGTO的に妥当か？
2. 【ブラフのストーリー性とライン】: Heroのアクションがブラフの場合、プリフロップからのアクションと矛盾していないか？相手から見て「持っていると主張しているバリューハンド」が本当にそのラインでプレイされるか？
3. 【混合戦略の可能性】: 状況的に「必ずベット」「必ずチェック」とは言い切れないマージナルなスポットの場合、なぜ頻度でアクションを混ぜるべきなのかを一般論から解説する。

ダメなプレイには「ストーリーに無理がある」「レンジキャップされている」「一般論としてこのボードでそのサイズは打たない」など厳しく指摘し、良いプレイには「完璧なポラライズです」「見事なラインです」と評価してください。

【重要な書式ルール（必ず守ること）】
- アスタリスク(*)は一切使用禁止。**太字**も*イタリック*も絶対に使わないこと。
- ハッシュ(#)によるMarkdownヘッダーも使用禁止。
- 箇条書きには「-」のみ使用すること。
- 見出しや強調は【】で囲むこと（例: 【良い点】【改善点】）。
- 番号付きリストは「1. 2. 3.」の形式のみ使用すること。
- 出力例: 「- レンジアドバンテージがあるためベットが推奨されます。」
- 出力例（禁止）: 「- **レンジアドバンテージ**があるためベットが推奨されます。」

{context_str}"""

        api_messages = [{"role": "system", "content": system_prompt}]
        for msg in req.messages:
            api_messages.append({"role": msg.role, "content": msg.content})

        response = openai_client.chat.completions.create(
            model="gpt-5.4-mini",
            messages=api_messages,
            max_completion_tokens=1000,
            temperature=0.7
        )

        reply_text = response.choices[0].message.content

        # ポストプロセス: Markdown記法を除去して読みやすくする
        import re
        # **太字** / *イタリック* / ***強調*** を除去
        reply_text = re.sub(r'\*{1,3}([^*\n]+?)\*{1,3}', r'\1', reply_text)
        # 行頭の * を箇条書き「-」に変換
        reply_text = re.sub(r'^\s*\*\s+', '- ', reply_text, flags=re.MULTILINE)
        # 残った単独の * をすべて除去
        reply_text = reply_text.replace('*', '')
        # Markdownヘッダーを除去
        reply_text = re.sub(r'^#{1,6}\s*', '', reply_text, flags=re.MULTILINE)
        # 連続する空行を1行に圧縮
        reply_text = re.sub(r'\n{3,}', '\n\n', reply_text).strip()

        if len(req.messages) == 1:
            stats_logger.save_ai_feedback(
                user_id=req.user_id,
                session_id=current_session_id,
                hand_context=context_str,
                ai_feedback=reply_text
            )

        return {"reply": reply_text}

    except Exception as e:
        import traceback
        traceback.print_exc()
        return {"reply": f"コーチAPIでエラーが発生しました: {str(e)}"}


# ==============================
# Stats / Analytics API
# ==============================

@app.get("/stats")
def serve_stats():
    return FileResponse("static/stats.html")


@app.get("/api/stats/overview")
def stats_overview(period: str = Query("all", pattern="^(all|30d|7d|last)$"), user_id: str = Query("")):
    """全体サマリー: GTO一致率、VPIP、PFR、3-Bet率を返す"""
    try:
        return stats_logger.get_overview(period, user_id=user_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/stats/position")
def stats_position(user_id: str = Query("")):
    """ポジション別サマリーを返す"""
    try:
        return stats_logger.get_position_stats(user_id=user_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/stats/streets")
def stats_streets(user_id: str = Query("")):
    """ストリート別評価分布（◎/◯/△/×の件数）を返す"""
    try:
        return stats_logger.get_street_eval_dist(user_id=user_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/stats/leaks")
def stats_leaks(user_id: str = Query("")):
    """EV損失が大きいシチュエーションTop5を返す"""
    try:
        return stats_logger.get_leaks(user_id=user_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/stats/personal_range")
def stats_personal_range(period: str = Query("all", pattern="^(all|30d|7d|last)$"), user_id: str = Query("")):
    """パーソナルプリフロップレンジ集計を返す"""
    try:
        return stats_logger.get_personal_range_stats(period, user_id=user_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/stats/saved_hands")
def stats_saved_hands(user_id: str = Query("")):
    """指定したユーザーがAIコーチに相談したハンド履歴を返す"""
    try:
        return stats_logger.get_saved_hands(user_id)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.delete("/api/stats/reset")
def stats_reset():
    """統計データをすべてリセット（開発・デバッグ用）"""
    try:
        stats_logger.reset_all()
        return {"status": "ok", "message": "統計データをリセットしました"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ==============================
# プリフロップ標準レンジ API
# ==============================

@app.get("/api/preflop_ranges")
def get_preflop_ranges():
    """
    ポジション別の標準GTO推奨レンジを返す。
    レンジモーダルの「標準レンジオーバーレイ」機能で使用する。
    """
    try:
        from ranges import position_ranges
        return position_ranges
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
