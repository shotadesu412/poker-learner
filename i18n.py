"""サーバー側の多言語メッセージ（ja / en）。

使い方:
    from i18n import t, set_lang
    set_lang("en")            # リクエスト単位で設定（app.py が行う）
    t("eval.call.optimal", eq=52.3)

言語はリクエスト単位で切り替わるため contextvars で保持する。
FastAPI は sync ハンドラを threadpool で実行するが、そのとき context を
コピーするので同期関数からでも正しい言語が読める。

新しい文言を足すときは必ず ja / en の両方を書くこと。
en が無い場合は ja にフォールバックする（表示は壊れないが未翻訳が残る）。
"""

import contextvars
import json
import os

SUPPORTED_LANGS = ("ja", "en")
DEFAULT_LANG = "ja"

_lang_ctx = contextvars.ContextVar("lang", default=DEFAULT_LANG)


def set_lang(lang):
    """リクエストの言語を設定する。未対応の値は日本語に落とす。"""
    if not lang:
        lang = DEFAULT_LANG
    lang = str(lang).lower().split("-")[0]
    _lang_ctx.set(lang if lang in SUPPORTED_LANGS else DEFAULT_LANG)
    return _lang_ctx.get()


def get_lang():
    return _lang_ctx.get()


def t(key, **kwargs):
    """メッセージIDを現在の言語で解決する。未定義キーはキー名をそのまま返す。"""
    entry = MESSAGES.get(key)
    if entry is None:
        return key
    text = entry.get(get_lang()) or entry[DEFAULT_LANG]
    if kwargs:
        try:
            return text.format(**kwargs)
        except (KeyError, IndexError):
            return text
    return text


# サーバー専用の文言（AIコーチのプロンプトと API エラー）。
# プロンプトを static/ に置くと誰でも取得できてしまうため、ここに残している。
_SERVER_MESSAGES = {
    # ------------------------------------------------------------------
    # API メッセージ (app.py)
    # ------------------------------------------------------------------
    "api.coach.no_key": {
        "ja": "エラー: OpenAI APIキーが設定されていません。環境変数をご確認ください。",
        "en": "Error: the OpenAI API key is not configured. Please check the environment variables.",
    },
    "api.coach.error": {
        "ja": "コーチAPIでエラーが発生しました: {error}",
        "en": "The coach API returned an error: {error}",
    },
    # 思考トークンで上限を使い切り、本文が空で返ってきた場合
    "api.coach.empty": {
        "ja": "コーチの回答を最後まで生成できませんでした。もう一度お試しください。",
        "en": "The coach could not finish its answer. Please try again.",
    },
    # AIコーチのコンテキスト見出しと system prompt。
    # 書式ルールは frontend の formatCoachText() が解釈する記法に合わせている
    # （日本語は【】、英語は[]を見出しに使う。両方ともJS側で太字化される）。
    # ▼ 2026/9/26: ポジション・ストリート・スタックが欠けており、コーチが
    #   「ポジションが分からない」と答えてしまう報告があったため追加した。
    #   ポジションはポーカーの講評に必須なので、消さないこと。
    "coach.context_header": {
        "ja": ("=== 現在のハンド情報 ===\n"
               "ストリート: {street}\n"
               "Hero(あなた): {hero_pos} / ハンド {hero} / スタック {hero_stack}bb\n"
               "CPU: {cpu_pos} / ハンド {cpu} / スタック {cpu_stack}bb\n"
               "ボード: {board}\n"
               "POT: {pot}bb\n"
               "※ 6-maxのポジション表記。ポストフロップの行動順は SB→BB→UTG→HJ→CO→BTN\n"
               "\n=== アクション履歴 ===\n"),
        "en": ("=== Current hand ===\n"
               "Street: {street}\n"
               "Hero (you): {hero_pos} / hand {hero} / stack {hero_stack}bb\n"
               "CPU: {cpu_pos} / hand {cpu} / stack {cpu_stack}bb\n"
               "Board: {board}\n"
               "POT: {pot}bb\n"
               "Note: 6-max positions. Postflop action order is SB -> BB -> UTG -> HJ -> CO -> BTN\n"
               "\n=== Action history ===\n"),
    },
    "coach.unknown_cards": {"ja": "不明", "en": "unknown"},
    "coach.system_prompt": {
        "ja": """あなたは経験豊富なポーカーコーチです。
ユーザーから提供される「ハンド履歴と状況」だけを基に、Hero（プレイヤー）のプレイライン（ストーリー）を標準的なポーカー戦略の観点から評価してください。

以下の観点で、箇条書きを用いて鋭く、かつ論理的にコーチングしてください。

1. 【アクションの妥当性】: 提供されたボードテクスチャとポジション、一般的なハンドレンジの概念から見て、Heroの各ストリートのアクションは戦略的に妥当か？
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

必ず日本語で回答してください。

{context}""",
        "en": """You are an experienced poker coach.
Using only the hand history and situation provided by the user, evaluate the Hero's (the player's) line and the story it tells, from the perspective of standard poker strategy.

Coach sharply and logically, using bullet points, covering these angles:

1. [Soundness of the actions]: Given the board texture, position, and general range concepts provided, is each of Hero's street-by-street actions strategically sound?
2. [Bluff story and line]: If Hero's action is a bluff, is it consistent with the preflop action? From the opponent's point of view, would the value hand Hero is representing actually be played this way?
3. [Mixed strategy]: In marginal spots where you cannot say "always bet" or "always check", explain from general theory why the action should be mixed by frequency.

Be blunt about bad plays — say things like "the story doesn't add up", "your range is capped here", "as a general rule you don't use that size on this board". For good plays, give credit: "perfectly polarized", "excellent line".

[Formatting rules - you must follow these]
- Never use asterisks (*). Never use **bold** or *italics*.
- Never use Markdown headers (#).
- Use only "-" for bullet points.
- Wrap headings and emphasis in square brackets, e.g. [Strengths] [Areas to improve].
- Use only "1. 2. 3." for numbered lists.
- Good example: "- You have a range advantage here, so betting is recommended."
- Forbidden example: "- You have a **range advantage** here, so betting is recommended."

Always answer in English.

{context}""",
    },
    "api.stats.reset_ok": {
        "ja": "統計データをリセットしました",
        "en": "Statistics have been reset.",
    },
    "api.purchase.missing_params": {
        "ja": "user_id と purchase_token が必要です",
        "en": "user_id and purchase_token are required",
    },
}

# 評価コメント・ハンド解説・サイジング・リーク文言は JS（端末側の評価ロジック）と共有するため
# static/poker/messages.json に置いている。文言を足す・直すときはそちらを編集すること。
_SHARED_JSON = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static", "poker", "messages.json")
with open(_SHARED_JSON, encoding="utf-8") as _f:
    _SHARED_MESSAGES = json.load(_f)

MESSAGES = {**_SHARED_MESSAGES, **_SERVER_MESSAGES}
