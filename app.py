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

# 現在のセッション（ハンド）ID
current_session_id: str = str(uuid.uuid4())

@app.get("/")
def serve_index():
    return FileResponse("static/index.html")

@app.get("/api/test_sync")
def test_sync():
    return {"status": "SYNCED"}

@app.get("/api/state")
def get_current_state():
    """
    現在のゲーム状態を返す。ページ再読み込み時に既存の手を復元するために使用。
    hero_hand が空の場合（ゲーム未開始）は has_hand_in_progress=False を返す。
    """
    if not engine.hero_hand:
        return {"has_hand_in_progress": False}
    state = get_game_state()
    state["has_hand_in_progress"] = True
    return state

# We'll use a single global engine instance for this MVP demo
engine = PokerEngine()

class ActionRequest(BaseModel):
    action: str
    amount: float = 0.0

class ChatMessage(BaseModel):
    role: str
    content: str

class AICoachRequest(BaseModel):
    messages: list[ChatMessage]

@app.get("/api/start_hand")
def start_hand():
  global current_session_id
  try:
    MAX_RETRIES = 50
    cpu_msg = ""
    
    # 新しいハンドのセッションIDを発行
    current_session_id = str(uuid.uuid4())
    
    for _ in range(MAX_RETRIES):
        engine.start_new_hand()
        cpu_msg = ""
        
        # Heroが先手（BTNなど）の場合は、そのままゲーム開始
        if engine.is_hero_turn():
            break
            
        # CPUが先手の場合のアクションを計算
        hero_eq_next, cpu_eq_next = EquityCalculator.calc_equity_monte_carlo(engine.hero_hand, engine.board, engine.hero_range_dict, engine.cpu_range_dict, iterations=50)
        cpu_facing = engine.current_bet - engine.cpu_invested
        cpu_action, cpu_amount = engine.cpu_decide(cpu_eq_next, "CHECK", cpu_facing)
        
        # 初手でフォールドした場合はループを継続し、裏で即座に配り直す
        if cpu_action == "FOLD":
            continue
            
        # フォールド以外（CALL, BET, RAISE）でポットに参加してきた場合はループを抜けてゲーム開始
        if cpu_action in ["CALL", "BET", "RAISE"]:
            bet_amount = cpu_facing if cpu_action == "CALL" else cpu_amount
            engine.place_bet("CPU", bet_amount)
            cpu_msg = f"CPU {cpu_action}S {bet_amount > 0 and str(round(bet_amount, 1)) + 'bb' or ''}".strip()
            break

    state = get_game_state()
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
        
        # 1. Calc Equity
        # Determine if 3bet pot (heuristic based on standard sizings)
        is_3bet_pot = (engine.street == "PREFLOP" and engine.current_bet > 2.5) or (engine.street != "PREFLOP" and engine.pot_size > 12.0)
        effective_stack = min(engine.hero_stack, engine.cpu_stack)

        is_preflop = (engine.street == "PREFLOP")
        hero_eq, cpu_eq = EquityCalculator.calc_equity_monte_carlo(engine.hero_hand, engine.board, engine.hero_range_dict, engine.cpu_range_dict, is_preflop=is_preflop, iterations=100)
        hero_range_adv = EquityCalculator.calc_range_advantage(engine.hero_hand, engine.board, engine.hero_range_dict, engine.cpu_range_dict, is_preflop=is_preflop, iterations=100)
        
        eqr = Evaluator.get_eqr_modifier(engine.hero_position, engine.hero_hand, is_3bet_pot, engine.board, range_adv=hero_range_adv)
        realized_equity = hero_eq * eqr
        
        eval_result = "N/A"
        eval_reason = ""
        
        # 2. Evaluate Hero Action
        hero_facing = engine.current_bet - engine.hero_invested
        
        if action == "FOLD":
            engine.update_range_dict("HERO", "FOLD", 0)
            engine.record_action("HERO", "FOLD", 0, realized_equity, engine.pot_size)
            eval_dict = Evaluator.evaluate_fold(
                hero_eq, hero_facing, engine.pot_size, 
                hero_pos=engine.hero_position, cards=engine.hero_hand, is_3bet_pot=is_3bet_pot, board=engine.board, range_adv=hero_range_adv
            )
            # EV損失を計算: チェック/コールのEVが高ければそれと比較
            ev_fold = eval_dict.get("ev", 0.0)
            ev_call_alt = Evaluator.ev_call(hero_eq, engine.pot_size, hero_facing) if hero_facing > 0 else 0.0
            ev_loss_fold = max(0.0, ev_call_alt - ev_fold)
            stats_logger.log_action(
                session_id=current_session_id, street=engine.street, actor="HERO",
                action="FOLD", amount=0.0, equity=realized_equity, pot_size=engine.pot_size,
                hero_pos=engine.hero_position, evaluation=eval_dict["evaluation"], ev_loss=ev_loss_fold
            )
            return {"evaluation": eval_dict["evaluation"], "reason": eval_dict["reason"], "ev_loss": round(ev_loss_fold, 3), "metrics": eval_dict, "state": get_game_state(finished=True), "message": "You Folded"}
            
        elif action == "CALL":
            call_amount = hero_facing
            # ▼ 評価を先に行い、その後レンジを更新する（順序重要）
            eval_dict = Evaluator.evaluate_call(
                hero_eq, call_amount, engine.pot_size,
                hero_pos=engine.hero_position, cards=engine.hero_hand, is_3bet_pot=is_3bet_pot, board=engine.board, effective_stack=effective_stack, range_adv=hero_range_adv, hero_range_dict=engine.hero_range_dict
            )
            eval_result = eval_dict["evaluation"]
            eval_reason = eval_dict["reason"]
            ev_call_val = eval_dict.get("ev", 0.0)
            ev_check_alt = Evaluator.ev_check(hero_eq, engine.pot_size)
            ev_loss_call = max(0.0, ev_check_alt - ev_call_val) if ev_check_alt > ev_call_val else 0.0
            engine.update_range_dict("HERO", "CALL", call_amount)
            engine.record_action("HERO", "CALL", call_amount, realized_equity, engine.pot_size)
            engine.place_bet("HERO", call_amount)
            stats_logger.log_action(
                session_id=current_session_id, street=engine.street, actor="HERO",
                action="CALL", amount=call_amount, equity=realized_equity, pot_size=engine.pot_size,
                hero_pos=engine.hero_position, evaluation=eval_result, ev_loss=ev_loss_call
            )
            
        elif action in ["BET", "RAISE"]:
            # ▼ 評価を先に行い、その後レンジを更新する（順序重要）
            if action == "RAISE":
                eval_dict = Evaluator.evaluate_raise(
                    hero_eq, amount, hero_facing, engine.pot_size,
                    hero_pos=engine.hero_position, cards=engine.hero_hand, board=engine.board, range_adv=hero_range_adv, hero_range_dict=engine.hero_range_dict
                )
            else:
                eval_dict = Evaluator.evaluate_bet(
                    hero_eq, amount, engine.pot_size,
                    hero_pos=engine.hero_position, cards=engine.hero_hand, board=engine.board, range_adv=hero_range_adv, effective_stack=effective_stack
                )
            eval_result = eval_dict["evaluation"]
            eval_reason = eval_dict["reason"]
            ev_bet_val = eval_dict.get("ev", 0.0)
            ev_check_alt2 = Evaluator.ev_check(hero_eq, engine.pot_size)
            ev_loss_bet = max(0.0, ev_check_alt2 - ev_bet_val) if ev_check_alt2 > ev_bet_val else 0.0
            engine.update_range_dict("HERO", action, amount)
            engine.record_action("HERO", action, amount, realized_equity, engine.pot_size)
            engine.place_bet("HERO", amount)
            stats_logger.log_action(
                session_id=current_session_id, street=engine.street, actor="HERO",
                action=action, amount=amount, equity=realized_equity, pot_size=engine.pot_size,
                hero_pos=engine.hero_position, evaluation=eval_result, ev_loss=ev_loss_bet
            )
            
        elif action == "CHECK":
            engine.update_range_dict("HERO", "CHECK", 0)
            engine.record_action("HERO", "CHECK", 0, realized_equity, engine.pot_size)
            eval_dict = Evaluator.evaluate_check(
                hero_eq, 
                engine.pot_size, 
                hero_pos=engine.hero_position, 
                has_initiative=(engine.aggressor == "HERO"),
                is_hero_ip=engine.is_hero_ip,
                cards=engine.hero_hand,
                board=engine.board,
                range_adv=hero_range_adv
            )
            eval_result = eval_dict["evaluation"]
            eval_reason = eval_dict["reason"]
            ev_check_val = eval_dict.get("ev", 0.0)
            ev_bet_alt = Evaluator.ev_bet(hero_eq, engine.pot_size, engine.pot_size * 0.66, fold_equity=0.3)
            ev_loss_check = max(0.0, ev_bet_alt - ev_check_val) if ev_bet_alt > ev_check_val else 0.0
            stats_logger.log_action(
                session_id=current_session_id, street=engine.street, actor="HERO",
                action="CHECK", amount=0.0, equity=realized_equity, pot_size=engine.pot_size,
                hero_pos=engine.hero_position, evaluation=eval_result, ev_loss=ev_loss_check
            )
        
        else:
            raise HTTPException(status_code=400, detail="Invalid action")

        # 3. CPU Action (Ideal) IF it is CPU's turn. 
        cpu_facing = engine.current_bet - engine.cpu_invested
        
        # Check if Hero's action just closed the street
        street_closed_by_hero = False
        
        if action == "CALL":
            if engine.street == "PREFLOP" and engine.cpu_position == "BB" and engine.current_bet == 1.0:
                # Exception: SB (Hero) limps, BB (CPU) has option to check/raise
                street_closed_by_hero = False
            else:
                # Normal call matches invested and closes street
                street_closed_by_hero = (engine.hero_invested == engine.cpu_invested)
                
        elif action == "CHECK":
            # If hero checks, it only closes the street if they are IN POSITION (acting last)
            # Exception: Preflop BB checking their option closes the action
            if engine.is_hero_ip or (engine.street == "PREFLOP" and engine.hero_position == "BB" and engine.current_bet == 1.0):
                street_closed_by_hero = True
            else:
                street_closed_by_hero = False
            
        cpu_msg = ""
        if street_closed_by_hero:
            cpu_action = "CHECK" # Dummy action to immediately pass to advance_street
            cpu_amount = 0
        else:
            cpu_action, cpu_amount = engine.cpu_decide(cpu_eq, action, cpu_facing)
            
            if cpu_action == "FOLD":
                 engine.update_range_dict("CPU", "FOLD", 0)
                 engine.record_action("CPU", "FOLD", 0, cpu_eq, engine.pot_size)
                 return {"evaluation": eval_result, "reason": eval_reason, "state": get_game_state(finished=True), "message": "CPU Folded. You Win.", "cpuAction": "FOLD"}
            
            if cpu_action in ["CALL", "BET", "RAISE"]:
                 if cpu_action == "CALL":
                     engine.update_range_dict("CPU", "CALL", cpu_facing)
                     engine.record_action("CPU", "CALL", cpu_facing, cpu_eq, engine.pot_size)
                     engine.place_bet("CPU", cpu_facing)
                 else:
                     engine.update_range_dict("CPU", cpu_action, cpu_amount)
                     engine.record_action("CPU", cpu_action, cpu_amount, cpu_eq, engine.pot_size)
                     engine.place_bet("CPU", cpu_amount)
                 
                 cpu_msg = f"CPU {cpu_action}S {cpu_amount > 0 and str(round(cpu_amount, 1)) + 'bb' or ''}".strip()
            elif cpu_action == "CHECK":
                 engine.update_range_dict("CPU", "CHECK", 0)
                 engine.record_action("CPU", "CHECK", 0, cpu_eq, engine.pot_size)
                 cpu_msg = "CPU CHECKS"
        
        # Check if CPU acting resolved the street
        hero_facing_after_cpu = engine.current_bet - engine.hero_invested
        if (cpu_action in ["CALL", "CHECK"] and hero_facing_after_cpu == 0) or street_closed_by_hero:
            # 4. Advance Street
            if engine.street == "RIVER":
                return {"evaluation": eval_result, "reason": eval_reason, "state": get_game_state(finished=True), "message": f"{cpu_msg.strip()} => Showdown!", "cpuAction": cpu_action}
                
            current_idx = engine.STREETS.index(engine.street)
            if current_idx + 1 < len(engine.STREETS):
                next_street = engine.STREETS[current_idx + 1]
                engine.advance_street(next_street)
                
                # If CPU acts first on the NEW street, we should theoretically calculate their move here immediately.
                if not engine.is_hero_turn():
                     # CPU acts first on new street
                     hero_eq_next, cpu_eq_next = EquityCalculator.calc_equity_monte_carlo(engine.hero_hand, engine.board, engine.hero_range_dict, engine.cpu_range_dict, iterations=50)
                     cpu_action_2, cpu_amount_2 = engine.cpu_decide(cpu_eq_next, "CHECK", 0) # Facing no bet
                     
                     if cpu_action_2 in ["BET", "RAISE"]:
                          engine.update_range_dict("CPU", cpu_action_2, cpu_amount_2)
                          engine.record_action("CPU", cpu_action_2, cpu_amount_2, cpu_eq_next, engine.pot_size)
                          engine.place_bet("CPU", cpu_amount_2)
                          cpu_msg += f" | Next street CPU {cpu_action_2}S {round(cpu_amount_2, 1)}bb"
                     else:
                          engine.record_action("CPU", "CHECK", 0, cpu_eq_next, engine.pot_size)
                          cpu_msg += f" | Next street CPU CHECKS"
            else:
                return {"evaluation": eval_result, "reason": eval_reason, "state": get_game_state(finished=True), "message": f"{cpu_msg.strip()} => Showdown!", "cpuAction": cpu_action}
                
        return {"evaluation": eval_result, "reason": eval_reason, "state": get_game_state(), "cpuAction": cpu_action, "cpuMessage": cpu_msg}
    except Exception as e:
        import traceback
        with open('trace.txt', 'w') as f:
            f.write(traceback.format_exc())
        raise HTTPException(status_code=500, detail=str(e))

def get_game_state(finished=False):
    hero_eq, cpu_eq = EquityCalculator.calc_equity_monte_carlo(engine.hero_hand, engine.board, engine.hero_range_dict, engine.cpu_range_dict, iterations=50) 
    realized_eq = min(1.0, max(0.0, hero_eq * Evaluator.get_eqr_modifier(engine.hero_position)))
    
    if finished and not engine.cpu_hand:
        engine.generate_realized_cpu_hand()
    
    # Compress the complex dicts to legacy "strong/middle" view roughly for UI visualization
    def compress_range(r_dict):
        s_weight, m_weight, w_weight = 0.0, 0.0, 0.0
        sorted_keys = list(r_dict.keys()) # Keys are already pseudo-sorted by ranges.py upon update
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
    
    return {
        "street": engine.street,
        "potSize": engine.pot_size,
        "heroStack": engine.hero_stack,
        "cpuStack": engine.cpu_stack,
        "heroPos": engine.hero_position,
        "cpuPos": engine.cpu_position,
        "facingBet": engine.current_bet - engine.hero_invested,
        "currentBet": engine.current_bet,
        "heroHand": [Card.int_to_str(c) for c in engine.hero_hand],
        "cpuHand": [Card.int_to_str(c) for c in engine.cpu_hand] if finished else [],
        "board": [Card.int_to_str(c) for c in engine.board],
        "equity": round(realized_eq * 100, 1),
        "heroRange": compress_range(engine.hero_range_dict),
        "cpuRange": compress_range(engine.cpu_range_dict),
        "heroRangeRaw": dict(engine.hero_range_dict),
        "cpuRangeRaw": dict(engine.cpu_range_dict),
        "bluffRatio": round(engine.calculate_theoretical_bluff_frequency(engine.current_bet, engine.pot_size) * 100, 1),
        "finished": finished,
        "history": engine.action_history
    }

@app.post("/api/ai_coach")
def ai_coach(req: AICoachRequest):
    if not openai_client.api_key:
        return {"reply": "エラー: OpenAI APIキーが設定されていません。環境変数をご確認ください。"}
        
    try:
        # Context building
        context_str = f"=== 現在のハンド情報 ===\nボード: {[Card.int_to_str(c) for c in engine.board]}\nHero(あなた): {[Card.int_to_str(c) for c in engine.hero_hand]}\nCPU: {[Card.int_to_str(c) for c in engine.cpu_hand] if engine.cpu_hand else '不明'}\nPOT: {engine.pot_size}bb\n\n=== アクション履歴 ===\n"
        
        for act in engine.action_history:
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

{context_str}"""

        # Prepend system prompt to user conversation
        api_messages = [{"role": "system", "content": system_prompt}]
        for msg in req.messages:
            api_messages.append({"role": msg.role, "content": msg.content})

        response = openai_client.chat.completions.create(
            model="gpt-5.4-nano",
            messages=api_messages,
            max_completion_tokens=1000,
            temperature=0.7
        )
        
        return {"reply": response.choices[0].message.content}
        
    except Exception as e:
        return {"reply": f"コーチAPIでエラーが発生しました: {str(e)}"}


# ==============================
# Stats / Analytics API
# ==============================

@app.get("/stats")
def serve_stats():
    return FileResponse("static/stats.html")


@app.get("/api/stats/overview")
def stats_overview(period: str = Query("all", pattern="^(all|30d|7d|last)$")):
    """全体サマリー: GTO一致率、VPIP、PFR、3-Bet率を返す"""
    try:
        return stats_logger.get_overview(period)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/stats/position")
def stats_position():
    """ポジション別サマリーを返す"""
    try:
        return stats_logger.get_position_stats()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/stats/streets")
def stats_streets():
    """ストリート別評価分布（◎/◯/△/×の件数）を返す"""
    try:
        return stats_logger.get_street_eval_dist()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/stats/leaks")
def stats_leaks():
    """EV損失が大きいシチュエーションTop5を返す"""
    try:
        return stats_logger.get_leaks()
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


