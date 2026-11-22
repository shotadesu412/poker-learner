from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse, PlainTextResponse
from typing import Optional
from pydantic import BaseModel, Field
import os
from openai import OpenAI
from i18n import t, set_lang

app = FastAPI(title="Poker Evaluator MVP")


# ==============================
# 言語の解決（リクエスト単位）
# ==============================
# AIコーチのプロンプトとエラー文言のため、リクエストごとに言語を決める。
# 優先順位: ?lang= クエリ > Accept-Language ヘッダ > 日本語。
# 純粋なASGIミドルウェアにしているのは、BaseHTTPMiddleware だと downstream が
# 別タスクになり contextvars の伝播が保証されないため（同じコルーチンで await する）。
class LanguageMiddleware:
    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] == "http":
            set_lang(self._resolve(scope))
        await self.app(scope, receive, send)

    @staticmethod
    def _resolve(scope) -> str:
        query = scope.get("query_string", b"").decode("latin-1")
        for part in query.split("&"):
            if part.startswith("lang="):
                return part[5:]
        for name, value in scope.get("headers", []):
            if name == b"accept-language":
                # "ja-JP,ja;q=0.9,en;q=0.8" の先頭のみ見る
                return value.decode("latin-1").split(",")[0].strip()
        return "ja"


app.add_middleware(LanguageMiddleware)

# OpenAI API Setup
# Requires OPENAI_API_KEY environment variable.
openai_api_key = os.environ.get("OPENAI_API_KEY", "")
openai_client = OpenAI(api_key=openai_api_key)

# AIコーチのモデル設定（2026/8/27 に gpt-5.4-mini から gpt-5.6-luna へ更新）
#
# GPT-5.6 は Sol / Terra / Luna の3構成で、Luna が低コスト・大量処理向け。
# 旧 gpt-5.4-mini と同じ枠で、入力 $0.2 / 出力 $1.2 per 1M tokens。
#
# ▼ 移行時の注意（ハマりどころ）
# - **temperature は渡してはいけない**。GPT-5.6 はデフォルト(1.0)以外を
#   受け付けず、0.7 を渡すと 400 BadRequest でコーチが丸ごと壊れる。
#   top_p や penalty 系も同様に非対応。
# - GPT-5.6 は推論モデルなので、**内部の思考トークンも max_completion_tokens を
#   消費する**。本文が出る前に上限へ到達すると、回答が途中で切れたり
#   空で返ったりする。
#
# ▼ 2026/9/26: 「たまに回答の最後が切れる」報告を受けての対応
#   reasoning_effort="low" + 上限3000 だと、長いハンド履歴や詳細を求める質問で
#   思考だけで3000を使い切り、本文が1文字も出ないことを本番で再現した。
#   思考トークンの消費量は入力次第で大きく振れるため、上限を上げるだけでは
#   「たまに切れる」が残る。
#   → reasoning_effort="none" にして思考トークンをほぼ0にし、上限の全量を
#     本文に使えるようにした。これで不具合のクラス自体が消える。
#     コーチは system prompt で観点が固定された講評タスクで、深い多段推論は
#     不要なため品質への影響は小さい（本番で出力品質を確認済み）。
#   分析が浅いと感じたら "low" に戻せるが、その場合は上限も 12000 程度まで
#   上げないと同じ症状が再発する。
# 環境変数で上書きできるようにしてあるので、問題があれば Render の
# 環境変数を変えるだけで再デプロイなしに切り戻せる。
# ▼ 2026/11/21: gpt-5.6-luna → gpt-6-luna（2026/9/22 リリースの後継。料金は入力 $0.20→$0.10・出力 $1.20→$0.50 / 100万トークン。
#   Chat Completions・reasoning_effort="none" に対応）。切り戻すときは Render の環境変数 COACH_MODEL=gpt-5.6-luna
COACH_MODEL = os.environ.get("COACH_MODEL", "gpt-6-luna")
COACH_REASONING_EFFORT = os.environ.get("COACH_REASONING_EFFORT", "none")
COACH_MAX_TOKENS = int(os.environ.get("COACH_MAX_TOKENS", "4000"))

# Make static dir
os.makedirs("static", exist_ok=True)
app.mount("/static", StaticFiles(directory="static"), name="static")

@app.get("/")
def serve_home():
    return FileResponse("static/home.html")

@app.get("/v2")
def serve_v2():
    # 新しい画面（作業中）。開発者モードのときだけ / /play /stats からここへ移る（static/v2/。2026/11/21〜）
    return FileResponse("static/v2/index.html")

@app.get("/play")
def serve_index():
    return FileResponse("static/index.html")

@app.get("/app-ads.txt", response_class=PlainTextResponse)
def serve_app_ads_txt():
    # AdMob の所有権確認用（広告詐欺防止の認証ファイル）
    return "google.com, pub-2416149393168379, DIRECT, f08c47fec0942fa0\n"

class ChatMessage(BaseModel):
    role: str
    content: str

class CoachAction(BaseModel):
    street: str = Field("", max_length=16)
    actor: str = Field("", max_length=8)
    action: str = Field("", max_length=16)
    amount: float = 0.0
    evaluation: str = Field("", max_length=4)   # あなたのアクションのアプリ判定（◎◯△×）
    equity: Optional[float] = None                # その時点の勝率(%)
    made: str = Field("", max_length=24)          # その時点のあなたの役（アプリが判定。英語の役名）
    reason: str = Field("", max_length=800)       # 画面に出した判定の解説

class CoachHandState(BaseModel):
    """端末のエンジン（static/poker/game.js）で遊んでいるときに、相談するハンドの状態を送ってもらう。
    サーバーにはエンジンの状態が無いため。プロンプトの組み立て自体はサーバーで行う（非公開のため）"""
    street: str = Field("", max_length=16)
    hero_pos: str = Field("", max_length=8)
    cpu_pos: str = Field("", max_length=8)
    hero_stack: float = 0.0
    cpu_stack: float = 0.0
    pot: float = 0.0
    board: list[str] = Field(default_factory=list, max_length=5)
    hero: list[str] = Field(default_factory=list, max_length=2)
    cpu: list[str] = Field(default_factory=list, max_length=2)
    hero_made: str = Field("", max_length=24)     # 今のボードでのあなたの役（アプリが判定）
    cpu_made: str = Field("", max_length=24)      # ショーダウン後の相手の役
    history: list[CoachAction] = Field(default_factory=list, max_length=80)

class AICoachRequest(BaseModel):
    messages: list[ChatMessage]
    user_id: str = "guest"
    state: CoachHandState   # ハンドの状態は端末のエンジンにしか無い

def _trim_to_last_sentence(text: str) -> str:
    """出力が上限で打ち切られたとき、最後の完結した文までに切り詰める。

    文の途中でぶつ切りになった書きかけを見せないためのもの。
    句点が1つも無い（＝1文目すら終わっていない）場合は、切り詰めると
    何も残らないので元のテキストをそのまま返す。
    """
    enders = ("。", "！", "？", ".", "!", "?")
    last = max((text.rfind(e) for e in enders), default=-1)
    if last == -1:
        return text
    return text[: last + 1]


# 役の名前（端末は英語の役名を送る）。コーチが自分で役を読み違えないよう、アプリが判定した役を渡す
_HAND_CLASSES = ("Royal Flush", "Straight Flush", "Four of a Kind", "Full House", "Flush", "Straight",
                 "Three of a Kind", "Two Pair", "Pair", "High Card")


def _made_name(made: str) -> str:
    if made not in _HAND_CLASSES:
        return ""
    return t("coach.made." + made.lower().replace(" ", "_"))


def _coach_context(street, hero_pos, cpu_pos, hero_stack, cpu_stack,
                   board, hero, cpu, pot, history, hero_made="", cpu_made="") -> str:
    """AIコーチに渡すハンド状況の文章。board/hero/cpu はカード文字列のリスト"""
    # リストのまま埋め込むと "['As', 'Kd']" になり、相談履歴にもその形で残るため空白区切りにする
    cards = lambda cs: " ".join(cs) if cs else "-"
    context_str = t(
        "coach.context_header",
        street=street,
        hero_pos=hero_pos,
        cpu_pos=cpu_pos,
        hero_stack=round(hero_stack, 1),
        cpu_stack=round(cpu_stack, 1),
        board=cards(board),
        hero=cards(hero),
        cpu=cards(cpu) if cpu else t("coach.unknown_cards"),
        pot=pot,
    )
    made_lines = []
    if _made_name(hero_made):
        made_lines.append(t("coach.made_hero", made=_made_name(hero_made)))
    if _made_name(cpu_made):
        made_lines.append(t("coach.made_cpu", made=_made_name(cpu_made)))
    if made_lines:
        # ヘッダーの末尾（アクション履歴の見出しの前）に差し込む
        head, sep, tail = context_str.rpartition("\n\n")
        context_str = head + "\n" + "\n".join(made_lines) + sep + tail
    # 各アクションにもポジションを添える。"HERO: CALL" だけだと
    # どの位置からのアクションか分からず、コーチが講評できない
    # 呼び名は「あなた / 相手」。"HERO" のまま渡すとコーチが Hero 表記で答えるため
    pos_of = {"HERO": hero_pos, "CPU": cpu_pos}
    name_of = {"HERO": t("coach.actor.hero"), "CPU": t("coach.actor.cpu")}
    for act in history:
        amt = act.get('amount', 0)
        amt_str = f" {round(amt, 1)}bb" if amt > 0 else ""
        actor = act['actor']
        notes = []
        if actor == "HERO":
            if act.get("evaluation"):
                notes.append(t("coach.action_verdict", mark=act["evaluation"]))
            if act.get("equity") is not None:
                notes.append(t("coach.action_equity", eq=float(act["equity"])))
            if _made_name(act.get("made", "")):
                notes.append(t("coach.action_made", made=_made_name(act["made"])))
        note_str = f" [{' / '.join(notes)}]" if notes else ""
        context_str += (f"[{act['street']}] {name_of.get(actor, actor)}({pos_of.get(actor, '?')}): "
                        f"{act['action']}{amt_str}{note_str}\n")
        reason = (act.get("reason") or "").strip()
        if actor == "HERO" and reason:
            context_str += t("coach.action_reason", reason=" ".join(reason.split()))
    return context_str


@app.post("/api/ai_coach")
def ai_coach(req: AICoachRequest):
    if not openai_client.api_key:
        return {"reply": t("api.coach.no_key")}

    try:
        st = req.state
        context_str = _coach_context(
            st.street, st.hero_pos, st.cpu_pos, st.hero_stack, st.cpu_stack,
            st.board, st.hero, st.cpu, st.pot, [a.model_dump() for a in st.history],
            hero_made=st.hero_made, cpu_made=st.cpu_made)

        system_prompt = t("coach.system_prompt", context=context_str)

        api_messages = [{"role": "system", "content": system_prompt}]
        for msg in req.messages:
            api_messages.append({"role": msg.role, "content": msg.content})

        # temperature は渡さないこと（GPT-5.6 は非対応。詳細は COACH_MODEL のコメント）
        response = openai_client.chat.completions.create(
            model=COACH_MODEL,
            messages=api_messages,
            max_completion_tokens=COACH_MAX_TOKENS,
            reasoning_effort=COACH_REASONING_EFFORT,
        )

        reply_text = response.choices[0].message.content
        finish_reason = response.choices[0].finish_reason

        # 思考トークンで max_completion_tokens を使い切ると content が空で返る。
        # その場合エラーメッセージを出さずに黙って空欄になるのを防ぐ。
        if not reply_text:
            print(f"[AICoach] 空の応答 finish_reason={finish_reason} usage={response.usage}")
            return {"reply": t("api.coach.empty")}

        # 上限に達して途中で止まった場合、文の途中でぶつ切りになる。
        # 最後の完結した文までを残して、中途半端な書きかけを見せない。
        if finish_reason == "length":
            print(f"[AICoach] 上限で打ち切り usage={response.usage}")
            reply_text = _trim_to_last_sentence(reply_text)

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

        # hand_context は端末側で相談履歴を保存するときに使う
        return {"reply": reply_text, "hand_context": context_str}

    except Exception as e:
        import traceback
        traceback.print_exc()
        # error: true で返す。端末側はこれを失敗として扱い（無料回数を戻す・相談履歴に残さない）、
        # 内部のエラー文はユーザーに見せない（2026/11/18〜。以前はエラー文を回答として返していた）
        return {"reply": t("api.coach.error", error=str(e)), "error": True}


@app.get("/stats")
def serve_stats():
    return FileResponse("static/stats.html")


# ==============================
# TWA / PWA サポート
# ==============================

@app.get("/.well-known/assetlinks.json")
def assetlinks():
    """
    TWA (Trusted Web Activity) 用の Digital Asset Links。
    Google Play Console でリリースキーの SHA-256 を取得後に更新すること。
    """
    import json
    links = [
        {
            "relation": ["delegate_permission/common.handle_all_urls"],
            "target": {
                "namespace": "android_app",
                "package_name": "com.pokerlearner.app",
                "sha256_cert_fingerprints": [
                    "TODO: REPLACE_WITH_YOUR_SHA256_FINGERPRINT"
                ]
            }
        }
    ]
    from fastapi.responses import JSONResponse
    return JSONResponse(content=links)
