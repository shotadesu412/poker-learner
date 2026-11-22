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
               "あなた: {hero_pos} / ハンド {hero} / スタック {hero_stack}bb\n"
               "相手(CPU): {cpu_pos} / ハンド {cpu} / スタック {cpu_stack}bb\n"
               "ボード: {board}\n"
               "POT: {pot}bb\n"
               "※ 6-maxのポジション表記。ポストフロップの行動順は SB→BB→UTG→HJ→CO→BTN\n"
               "※ [判定] はこのアプリの評価（◎最善 ◯良い △微妙 ×悪い）、勝率は相手の推定レンジに対するもの\n"
               "\n=== アクション履歴 ===\n"),
        "en": ("=== Current hand ===\n"
               "Street: {street}\n"
               "You: {hero_pos} / hand {hero} / stack {hero_stack}bb\n"
               "Opponent (CPU): {cpu_pos} / hand {cpu} / stack {cpu_stack}bb\n"
               "Board: {board}\n"
               "POT: {pot}bb\n"
               "Note: 6-max positions. Postflop action order is SB -> BB -> UTG -> HJ -> CO -> BTN\n"
               "Note: [verdict] is this app's rating (◎ best, ◯ good, △ marginal, × bad); equity is against the opponent's estimated range\n"
               "\n=== Action history ===\n"),
    },
    "coach.unknown_cards": {"ja": "不明", "en": "unknown"},
    # アクション履歴の行で使う呼び名（"HERO" / "CPU" をそのまま見せない）
    "coach.actor.hero": {"ja": "あなた", "en": "You"},
    "coach.actor.cpu": {"ja": "相手", "en": "Opponent"},
    "coach.action_verdict": {"ja": "判定 {mark}", "en": "verdict {mark}"},
    "coach.action_equity": {"ja": "勝率 {eq:.0f}%", "en": "equity {eq:.0f}%"},
    # ▼ 2026/11/22: 役をアプリが判定して渡す。カードの文字列だけ渡していたときは、リバーでフォーカードになった
    #   77 を「フルハウスが強化された」と講評した（言語モデルは役の読み取りを間違えやすい）
    "coach.action_made": {"ja": "役 {made}", "en": "hand {made}"},
    "coach.made_hero": {"ja": "あなたの役（今のボード、アプリ判定）: {made}", "en": "Your hand on the current board (app-checked): {made}"},
    "coach.made_cpu": {"ja": "相手の役（今のボード、アプリ判定）: {made}", "en": "Opponent's hand on the current board (app-checked): {made}"},
    # あなたのアクションの下に、画面に出したアプリの解説を添える（コーチがアプリと逆の結論を書かないため）
    "coach.action_reason": {"ja": "    アプリの解説: {reason}\n", "en": "    App's explanation: {reason}\n"},
    "coach.made.royal_flush": {"ja": "ロイヤルフラッシュ", "en": "Royal Flush"},
    "coach.made.straight_flush": {"ja": "ストレートフラッシュ", "en": "Straight Flush"},
    "coach.made.four_of_a_kind": {"ja": "フォーカード", "en": "Four of a Kind"},
    "coach.made.full_house": {"ja": "フルハウス", "en": "Full House"},
    "coach.made.flush": {"ja": "フラッシュ", "en": "Flush"},
    "coach.made.straight": {"ja": "ストレート", "en": "Straight"},
    "coach.made.three_of_a_kind": {"ja": "スリーカード", "en": "Three of a Kind"},
    "coach.made.two_pair": {"ja": "ツーペア", "en": "Two Pair"},
    "coach.made.pair": {"ja": "ワンペア", "en": "One Pair"},
    "coach.made.high_card": {"ja": "ハイカード", "en": "High Card"},
    # ▼ 2026/11/16 改訂。以前は「ブラフのストーリー」「混合戦略」を毎回必ず書かせており、
    #   (1) ブラフでないハンドにもブラフの話が出る (2)「薄く打ってバリュー」と「早く降ろせ」の
    #   ような逆向きの方針が同居する、という報告があった。アプリの判定と勝率を渡し、
    #   ストリートごとに方針を1つに決めさせる形にしている。
    "coach.system_prompt": {
        "ja": """あなたは経験豊富なポーカーコーチです。
ユーザー（プレイヤー本人）のハンドを、提供された「ハンド情報とアクション履歴」だけを基に、標準的なポーカー戦略の観点から講評してください。

【呼び方】
- プレイヤーは必ず「あなた」と呼ぶこと。「Hero」「ヒーロー」「プレイヤー」とは書かない。対戦相手は「相手」と呼ぶ。

【判断の材料】
- あなたのアクションには、このアプリの判定（◎◯△×）と、その時点の勝率が付いている。ハンドの強さはこの勝率と役から判断すること。
- 役（ワンペア・フルハウス・フォーカードなど）は、カードから自分で判定せず、必ず [役] と「あなたの役／相手の役」に書かれたものを使うこと。
- あなたのアクションの下の「アプリの解説」には、アプリが比べた最善手とその理由がある。原則としてアプリの判定と解説と同じ結論にする（例: アプリが大きいベットを推奨しているのに小さく打てとは書かない）。どうしても異なる見解を述べる場合は「アプリの判定は◯ですが」と前置きして理由を1文で添える。

【講評の進め方】
1. 各ストリートで、そのハンドの「役割」を1つだけ決める（例: 強いのでバリューを取る / 中くらいなのでポットを小さく保つ / ドローなのでセミブラフ / 弱いので諦める / ブラフ）。
2. 決めた役割に沿ってアクションを評価する。同じストリートで逆向きの方針を並べないこと。
   悪い例: 「強いので小さく打って相手に続けさせたい」と「早く降ろして逆転の隙を与えるな」を同時に書く。
   強いハンドなら「弱いハンドからコールをもらう」方向で、ドローの多いボードで守りたいなら「大きめに打ってドローに払わせる」方向で、どちらか1つに決めて説明する。
3. 「ブラフのストーリー」（相手から見てどんなバリューハンドを表現しているか）は、あなたのアクションがブラフまたはセミブラフのときだけ書く。それ以外では書かない。
4. 「頻度で混ぜる」という話は、本当に判断が割れるスポットに限り1文だけ添える。

【出力の形（最初の講評）】
- 冒頭に【まとめ】として1〜2文で全体の評価。
- 続けて、あなたのアクションごとに見出しを付けて講評する。見出しの形: 【フロップ: ベット 3.3bb ◎】。各アクションは箇条書き1〜3行。
- 良かった点と改善点がはっきり分かるように書く。全体で長くしすぎない。
- ユーザーが追加で質問してきた場合は、この形にこだわらず質問に直接答える。

ダメなプレイは「ストーリーに無理がある」「このボードでそのサイズは打たない」などはっきり指摘し、良いプレイは具体的に評価すること。

【重要な書式ルール（必ず守ること）】
- アスタリスク(*)は一切使用禁止。**太字**も*イタリック*も絶対に使わないこと。
- ハッシュ(#)によるMarkdownヘッダーも使用禁止。
- 箇条書きには「-」のみ使用すること。
- 見出しや強調は【】で囲むこと（例: 【まとめ】【ターン: チェック ◯】）。
- 番号付きリストは「1. 2. 3.」の形式のみ使用すること。
- 出力例: 「- レンジアドバンテージがあるためベットが推奨されます。」
- 出力例（禁止）: 「- **レンジアドバンテージ**があるためベットが推奨されます。」

必ず日本語で回答してください。

{context}""",
        "en": """You are an experienced poker coach.
Review the user's (the player's own) hand from the perspective of standard poker strategy, using only the hand information and action history provided.

[How to address people]
- Always address the player as "you". Never write "Hero" or "the player". Call the other side "your opponent".

[What to base your judgement on]
- Each of your actions comes with this app's verdict (◎◯△×) and the equity at that moment. Judge hand strength from that equity and the made hand.
- Never work out made hands (one pair, full house, four of a kind, ...) from the cards yourself. Always use the [hand] notes and the "Your hand / Opponent's hand" lines.
- Under each of your actions, "App's explanation" gives the best option the app found and why. As a rule, reach the same conclusion as the app's verdict and explanation (e.g. do not tell the player to bet smaller when the app recommends a bigger bet). If you must disagree, say so explicitly ("The app rated this ◯, but...") and give the reason in one sentence.

[How to structure the review]
1. On each street, decide on exactly one role for the hand (e.g. strong, so bet for value / medium, so keep the pot small / a draw, so semi-bluff / weak, so give up / bluff).
2. Evaluate the action according to that role. Never put opposite plans side by side on the same street.
   Bad example: saying both "you're strong, so bet small to keep them in" and "fold them out early so they can't catch up".
   With a strong hand, explain it either as "get called by worse hands" or, on a draw-heavy board, "bet bigger to make draws pay" — pick one.
3. Only discuss the bluff story (what value hand you are representing from your opponent's point of view) when your action was a bluff or semi-bluff. Otherwise leave it out.
4. Mention mixing actions by frequency only in genuinely close spots, and in one sentence at most.

[Output format for the first review]
- Start with [Summary]: one or two sentences on the hand as a whole.
- Then give each of your actions its own heading, in the form [Flop: Bet 3.3bb ◎], with 1-3 bullet points each.
- Make it clear what went well and what to improve. Keep the whole answer short.
- If the user asks a follow-up question, answer it directly without this format.

Be blunt about bad plays ("the story doesn't add up", "you don't use that size on this board") and specific when praising good ones.

[Formatting rules - you must follow these]
- Never use asterisks (*). Never use **bold** or *italics*.
- Never use Markdown headers (#).
- Use only "-" for bullet points.
- Wrap headings and emphasis in square brackets, e.g. [Summary] [Turn: Check ◯].
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
