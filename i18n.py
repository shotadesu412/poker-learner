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


MESSAGES = {
    # ------------------------------------------------------------------
    # プリフロップ評価 (poker_engine.Evaluator.evaluate_preflop_action_gto)
    # ------------------------------------------------------------------
    "preflop.foldmsg.open": {
        "ja": "オープン可能なハンドです。",
        "en": "This hand is inside your opening range.",
    },
    "preflop.foldmsg.vs_open": {
        "ja": "このポジションの推奨レンジでは参加しにくいハンドです。",
        "en": "This hand is hard to continue with from this position's recommended range.",
    },
    "preflop.foldmsg.vs_3bet": {
        "ja": "3-Bet/4-Betに対してはフォールドが基本となるハンドです。",
        "en": "Against a 3-bet/4-bet, folding is the default with this hand.",
    },
    "preflop.call.good": {
        "ja": "【良い選択】このハンドでのコールは基本的なプレイです。 {reason}",
        "en": "[Good choice] Calling is the standard play with this hand. {reason}",
    },
    "preflop.call.should_raise": {
        "ja": "【レイズ推奨】このハンドはコールよりレイズして主導権を握る方が効果的です。 {reason}",
        "en": "[Raise instead] This hand plays better as a raise, taking the initiative rather than calling. {reason}",
    },
    "preflop.call.out_of_range": {
        "ja": "【改善余地あり】{fold_msg} {reason}",
        "en": "[Room to improve] {fold_msg} {reason}",
    },
    "preflop.raise.optimal": {
        "ja": "【推奨】良いレイズ(3-Bet/4-Bet)です。主導権を握りましょう。 {reason}",
        "en": "[Recommended] A good raise (3-bet/4-bet). Take the initiative. {reason}",
    },
    "preflop.raise.should_call": {
        "ja": "【コール推奨】このハンドはレイズよりコールで参加する方が無難です。 {reason}",
        "en": "[Call instead] This hand is safer entering the pot as a call rather than a raise. {reason}",
    },
    "preflop.raise.out_of_range": {
        "ja": "【改善余地あり】{fold_msg} {reason}\n(ブラフとして打つ場合は頻度に注意してください)",
        "en": "[Room to improve] {fold_msg} {reason}\n(If you are using it as a bluff, keep the frequency low.)",
    },
    "preflop.fold.too_strong": {
        "ja": "【フォールド過多】強いハンドです。レイズで参加することを検討しましょう。 {reason}",
        "en": "[Over-folding] This is a strong hand. Consider entering the pot with a raise. {reason}",
    },
    "preflop.fold.callable": {
        "ja": "【フォールド過多】コールできる強さのハンドです。相手にブラフの余地を与えすぎないようにしましょう。 {reason}",
        "en": "[Over-folding] This hand is strong enough to call. Don't give your opponent too much room to bluff. {reason}",
    },
    "preflop.fold.slightly_tight": {
        "ja": "【やや降り過ぎ】プレイできるハンドです。頻繁にフォールドすると相手に読まれやすくなります。 {reason}",
        "en": "[Slightly tight] This hand is playable. Folding it too often makes you predictable. {reason}",
    },
    "preflop.fold.optimal": {
        "ja": "【推奨】このハンドではフォールドが無難な選択です。 {fold_msg}",
        "en": "[Recommended] Folding is the safe choice with this hand. {fold_msg}",
    },

    # ------------------------------------------------------------------
    # コール評価 (evaluate_call)
    # ------------------------------------------------------------------
    "call.free_check": {
        "ja": "チェック可能な状況です。無料でカードを見られるときはチェックが基本です。",
        "en": "You can check here. When you can see the next card for free, checking is the default.",
    },
    "call.optimal": {
        "ja": "リスクに対して勝率({eq:.1f}%)が十分に高く、極めて優位なコールです。",
        "en": "Your equity ({eq:.1f}%) is far above the risk you are taking — a clearly profitable call.",
    },
    "call.good": {
        "ja": "ベット額に対して見合う勝率({eq:.1f}%)があり、妥当な防衛（コール）です。",
        "en": "Your equity ({eq:.1f}%) justifies the price you are paying — a sound defensive call.",
    },
    "call.implied_good": {
        "ja": "現在の勝率({eq:.1f}%)はオッズにわずかに届いていませんが、後のラウンドで稼げる可能性（インプライドオッズ）を加味すれば利益的なコールです。",
        "en": "Your current equity ({eq:.1f}%) falls just short of the pot odds, but factoring in what you can win on later streets (implied odds) this is still a profitable call.",
    },
    "call.marginal": {
        "ja": "勝率({eq:.1f}%)がオッズに届いていません。相手のブラフをキャッチするなどの明確な理由がない限り、頻繁なコールは控えましょう。",
        "en": "Your equity ({eq:.1f}%) does not meet the pot odds. Unless you have a clear read — such as catching a bluff — avoid calling here too often.",
    },
    "call.implied_marginal": {
        "ja": "現在の勝率({eq:.1f}%)はオッズにあっていませんが、後のラウンドで大きく稼げる可能性（インプライドオッズ）を加味すれば利益的なコールです。",
        "en": "Your current equity ({eq:.1f}%) does not meet the pot odds, but the potential to win a big pot later (implied odds) keeps this call profitable.",
    },
    "call.bad": {
        "ja": "【見送り推奨】相手のベット額に対してハンドの強さが見合っていません。フォールドも選択肢として検討してみましょう。",
        "en": "[Consider passing] Your hand strength does not justify the size of your opponent's bet. Folding is worth considering here.",
    },

    # ------------------------------------------------------------------
    # フォールド評価 (evaluate_fold)
    # ------------------------------------------------------------------
    "fold.no_bet": {
        "ja": "ベットがない状況でのフォールドは不利な選択です。無料でカードを見られる場合はチェックを選びましょう。",
        "en": "Folding when there is no bet to face only costs you. When you can see a card for free, check instead.",
    },
    "fold.clear_loss": {
        "ja": "【明確な損失】必要勝率({req:.1f}%)を大きく上回るハンド({eq:.1f}%)を捨ててしまいました。これはバリューハンドであり、コールかレイズで戦うべき場面です。",
        "en": "[Clear loss] You folded a hand ({eq:.1f}%) well above the required equity ({req:.1f}%). This is a value hand — you should be calling or raising here.",
    },
    "fold.tight": {
        "ja": "【ややタイト】勝率({eq:.1f}%)はオッズ({req:.1f}%)を上回っています。毎回降りると相手のブラフに搾取されるため、この強さのハンドは一定頻度で防衛したいところです。",
        "en": "[Slightly tight] Your equity ({eq:.1f}%) beats the pot odds ({req:.1f}%). Folding every time lets your opponent bluff you profitably — defend with this hand strength at some frequency.",
    },
    "fold.bluffcatcher": {
        "ja": "【妥当な選択】勝率({eq:.1f}%)がオッズ({req:.1f}%)に近いブラフキャッチャーです。この位置のハンドはコールとフォールドの期待値がほぼ等しく、どちらを選んでも大きな損はありません。",
        "en": "[Reasonable] This is a bluff-catcher whose equity ({eq:.1f}%) sits right around the pot odds ({req:.1f}%). Calling and folding have nearly identical EV here, so neither costs you much.",
    },
    "fold.optimal": {
        "ja": "逆転の確率({eq:.1f}%)が必要勝率({req:.1f}%)に届かないため、無駄なチップの支払いを避ける適切なフォールドです。",
        "en": "Your chance of coming from behind ({eq:.1f}%) falls short of the required equity ({req:.1f}%), so this is a correct fold that saves chips.",
    },

    # ------------------------------------------------------------------
    # ベット評価 (evaluate_bet)
    # ------------------------------------------------------------------
    "bet.optimal.range_adv": {
        "ja": "【推奨】レンジ優位がある状況でのベットは効果的です。アグレッシブに主導権を握りましょう。",
        "en": "[Recommended] Betting with a range advantage is effective. Stay aggressive and keep the initiative.",
    },
    "bet.optimal.bluff": {
        "ja": "【推奨】ハンドは弱めですが、相手を降ろせる可能性（フォールドエクイティ）を活かしたブラフとして機能します。",
        "en": "[Recommended] Your hand is weak, but this works as a bluff that leverages your fold equity.",
    },
    "bet.optimal.value": {
        "ja": "【推奨・バリュー】チェックよりベットの方が期待値が高い状況です。バリューとプレッシャーを兼ね備えた良い選択です。",
        "en": "[Recommended - value] Betting has higher EV than checking here. It gets value and applies pressure at the same time.",
    },
    "bet.good": {
        "ja": "【良い選択】ベットによる期待値がチェックをわずかに上回っています。プレッシャーをかける妥当なアクションです。",
        "en": "[Good choice] Betting edges out checking in EV. Applying pressure is a sound action here.",
    },
    "bet.marginal": {
        "ja": "【どちらでも】ベットとチェックの期待値が拮抗しています。状況に応じてアクションを混ぜることで相手に読まれにくくなります。",
        "en": "[Either works] Betting and checking are close in EV. Mixing your actions here keeps you harder to read.",
    },
    "bet.bad": {
        "ja": "【改善余地あり】この状況ではチェックして様子を見る方が期待値が高い可能性があります。",
        "en": "[Room to improve] Checking and seeing what develops likely has higher EV in this spot.",
    },
    "bet.sizing_prefix": {
        "ja": "\n\n📐 サイジング: {reason}",
        "en": "\n\n📐 Sizing: {reason}",
    },

    # ------------------------------------------------------------------
    # レイズ評価 (evaluate_raise)
    # ------------------------------------------------------------------
    "raise.optimal.range_adv": {
        "ja": "【推奨】レンジ優位がある状況でのレイズは効果的です。アグレッシブに主導権を握りましょう。",
        "en": "[Recommended] Raising with a range advantage is effective. Stay aggressive and take the initiative.",
    },
    "raise.optimal.bluff": {
        "ja": "【推奨】ハンドは弱めですが、相手を降ろせる可能性（フォールドエクイティ）を活かしたブラフレイズとして機能します。",
        "en": "[Recommended] Your hand is weak, but this works as a bluff raise that leverages your fold equity.",
    },
    "raise.optimal.value": {
        "ja": "【推奨・バリュー】コールよりレイズの方が期待値が高い状況です。バリューとプレッシャーを兼ね備えた良い選択です。",
        "en": "[Recommended - value] Raising has higher EV than calling here. It gets value and applies pressure at the same time.",
    },
    "raise.good": {
        "ja": "【良い選択】レイズの期待値がコールをわずかに上回っています。積極的なアクションとして妥当です。",
        "en": "[Good choice] Raising edges out calling in EV. A sound aggressive action.",
    },
    "raise.marginal": {
        "ja": "【どちらでも】レイズとコールの期待値が拮抗しています。状況に応じてアクションを混ぜることで相手に読まれにくくなります。",
        "en": "[Either works] Raising and calling are close in EV. Mixing your actions here keeps you harder to read.",
    },
    "raise.bad": {
        "ja": "【改善余地あり】この状況ではコールかフォールドの方が期待値が高い可能性があります。レイズはリスクが高めです。",
        "en": "[Room to improve] Calling or folding likely has higher EV in this spot. Raising carries too much risk here.",
    },

    # ------------------------------------------------------------------
    # チェック評価 (evaluate_check)
    # ------------------------------------------------------------------
    "check.oop_default": {
        "ja": "ポジション不利（OOP）でアグレッサーでもない場合、まずチェックして相手のアクションを見てからディフェンスするのが基本です。",
        "en": "Out of position and without the initiative, the default is to check first, see what your opponent does, and then defend.",
    },
    "check.missed_value": {
        "ja": "【バリューの取り逃し】非常に強いハンドです。チェックすると相手に無料でカードを見せてしまいます。バリューベットして相手からチップを引き出しましょう。",
        "en": "[Missed value] This is a very strong hand. Checking gives your opponent a free card. Bet for value and get chips in.",
    },
    "check.optimal.weak_range": {
        "ja": "【推奨】相手のレンジが強い可能性が高いため、チェックでポットを抑えるのが無難な選択です。",
        "en": "[Recommended] Your opponent's range is likely stronger here, so checking to keep the pot small is the safe choice.",
    },
    "check.optimal": {
        "ja": "【推奨】チェックして様子を見るのが良い選択です。無駄なリスクを避けられます。",
        "en": "[Recommended] Checking and seeing what develops is a good choice. It avoids unnecessary risk.",
    },
    "check.good": {
        "ja": "【妥当】チェックしてポットを小さく保つ（ポットコントロール）のは妥当な選択です。",
        "en": "[Reasonable] Checking to keep the pot small (pot control) is a reasonable choice.",
    },
    "check.marginal": {
        "ja": "【やや消極的】ベットしてプレッシャーをかけるべき状況かもしれませんが、チェックで様子を見るのも手です。",
        "en": "[A bit passive] This may be a spot to bet and apply pressure, though checking to see what develops is defensible.",
    },
    "check.bad": {
        "ja": "【ブラフの機会損失】ハンドは弱いですが、ベットすることで相手を降ろせる可能性（フォールドエクイティ）があります。この状況でチェックするとフォールドエクイティを無駄にしています。",
        "en": "[Missed bluff] Your hand is weak, but betting could still make your opponent fold. Checking here wastes that fold equity.",
    },

    # ------------------------------------------------------------------
    # ハンド解説 (ranges.get_hand_reason)
    # ------------------------------------------------------------------
    "hand.suited_ace_king": {
        "ja": "スーテッドエースやスーテッドキングで、プレイアビリティとブロッカー効果があります。",
        "en": "A suited ace or suited king — good playability plus useful blocker effects.",
    },
    "hand.trap_offsuit": {
        "ja": "ドミネートされやすい危険なトラップハンドです。",
        "en": "A dangerous trap hand that is easily dominated.",
    },
    "hand.marginal_broadway": {
        "ja": "強いレンジに支配されやすく、弱いレンジには強いマージナルなハンドです。",
        "en": "A marginal hand: dominated by strong ranges, but ahead of weak ones.",
    },
    "hand.kicker_risk": {
        "ja": "プレイアビリティは高いものの、トップペア時のキッカー負けリスクがあります。",
        "en": "Good playability, but it risks losing the kicker battle when it makes top pair.",
    },
    "hand.premium": {
        "ja": "最強クラスのプレミアムハンドです。自信を持ってアグレッシブにプレイしましょう。",
        "en": "A top-tier premium hand. Play it aggressively with confidence.",
    },
    "hand.ak": {
        "ja": "非常に強力なプレミアムハンドで、3BETや4BETにも適しています。",
        "en": "A very strong premium hand, well suited to 3-betting and 4-betting.",
    },
    "hand.suited_connector": {
        "ja": "ストレートやフラッシュを作りやすい投機的なハンド（スーテッドコネクター）です。",
        "en": "A speculative suited connector that makes straights and flushes easily.",
    },
    "hand.pocket_pair": {
        "ja": "セットマイン（スリーカード狙い）のポテンシャルを持つポケットペアです。",
        "en": "A pocket pair with set-mining potential.",
    },
    "hand.standard": {
        "ja": "ポジションに応じた標準的なレンジ構成ハンドです。",
        "en": "A standard range-building hand for this position.",
    },
    "hand.range.standard": {
        "ja": "このポジションと状況における標準的な参加レンジです。",
        "en": "A standard continuing range for this position and situation.",
    },
    "hand.range.borderline": {
        "ja": "プレイするかどうか状況次第の境界線のハンドです。頻度でアクションを混ぜることが多いです。",
        "en": "A borderline hand whose play depends on the situation — usually mixed by frequency.",
    },
    "hand.range.out": {
        "ja": "このポジションでは参加しにくいハンドです。フォールドが無難な選択です。",
        "en": "A hand that is hard to continue with from this position. Folding is the safe choice.",
    },

    # ------------------------------------------------------------------
    # ベットサイジング評価 (bet_sizing.evaluate_bet_sizing)
    # ------------------------------------------------------------------
    "sizing.no_pot": {
        "ja": "ポットサイズが不明のため評価できません。",
        "en": "Cannot evaluate: pot size is unknown.",
    },
    "sizing.monotone.too_big": {
        "ja": "モノトーンボードに対してベットサイズ({pct:.0f}%ポット)が大きすぎます。同スート3枚のボードではフラッシュの警戒が必要ですが、大きく打ちすぎる必要はありません。",
        "en": "Your bet ({pct:.0f}% pot) is too large on a monotone board. Three cards of one suit warrant caution about flushes, but that does not call for an oversized bet.",
    },
    "sizing.monotone.good": {
        "ja": "モノトーンボードへの小額ベット({pct:.0f}%ポット)は適切なブロックベットです。フラッシュを持っているかのようにフォールドエクイティを得つつ、コールされた場合の損失を最小化できます。",
        "en": "A small bet ({pct:.0f}% pot) on a monotone board is a good block bet. It represents the flush to pick up fold equity while limiting your loss when called.",
    },
    "sizing.paired.too_big": {
        "ja": "ペアボードでの極端なオーバーベット({pct:.0f}%ポット)はリスクが高いです。通常は25〜33%の小額ベットが高頻度で使われますが、大きなサイズを打つ場合は強いポラライズレンジが必要です。",
        "en": "An extreme overbet ({pct:.0f}% pot) on a paired board is risky. The standard is a high-frequency small bet of 25-33%; large sizes require a genuinely polarized range.",
    },
    "sizing.paired.good": {
        "ja": "ペアボードへのベット({pct:.0f}%ポット)は適切なサイズです。このボードは静的で役の変化が少ないため、小さく頻度を高めてバリューを取りましょう。",
        "en": "Your bet ({pct:.0f}% pot) is a good size on a paired board. These boards are static and change little, so bet small and often to extract value.",
    },
    "sizing.wet.too_small": {
        "ja": "ウェットボードに対してベットサイズ({pct:.0f}%ポット)が小さすぎます。ストレート/フラッシュドロー両方が絡むダイナミックなボードでは、相手のドローに利益的なポットオッズを与えないために55〜80%以上のサイズが必要です。小額ベットはフリーカードを与え、自分のバリューハンドを弱めます。",
        "en": "Your bet ({pct:.0f}% pot) is too small for a wet board. On dynamic boards with both straight and flush draws you need 55-80%+ to deny your opponent's draws profitable odds. Small bets hand out cheap cards and devalue your own value hands.",
    },
    "sizing.wet.too_big": {
        "ja": "ウェットボードへのオーバーベット({pct:.0f}%ポット)はリスクが高いです。ドローが豊富なボードでナッツ優位がない場合、過大なベットはコールされたときの損失が大きくなります。55〜80%を推奨します。",
        "en": "An overbet ({pct:.0f}% pot) on a wet board is risky. Without a nut advantage on a draw-heavy board, oversized bets cost you a lot when called. Aim for 55-80%.",
    },
    "sizing.wet.good": {
        "ja": "ウェットボードへのベット({pct:.0f}%ポット)は適切です。ドローのエクイティ実現を阻止しつつ、バリューを得ることができます。",
        "en": "Your bet ({pct:.0f}% pot) is well sized for a wet board. It denies draws their equity while still getting value.",
    },
    "sizing.semiwet.small": {
        "ja": "セミウェットボードに対してベットサイズ({pct:.0f}%ポット)は少し小さめです。ある程度のドロー可能性があるため、33〜55%程度が推奨されます。",
        "en": "Your bet ({pct:.0f}% pot) is slightly small for a semi-wet board. With some draws available, 33-55% is the usual range.",
    },
    "sizing.semiwet.good": {
        "ja": "セミウェットボードへのベット({pct:.0f}%ポット)は概ね適切なサイジングです。",
        "en": "Your bet ({pct:.0f}% pot) is broadly a good size for a semi-wet board.",
    },
    "sizing.dry.too_big": {
        "ja": "ドライボードでの極端な巨大ベット({pct:.0f}%ポット)です。ポラライズ効果は高いものの、相手のエアーハンドからのコールを得にくくなります。",
        "en": "An extremely large bet ({pct:.0f}% pot) on a dry board. It is highly polarizing, but you lose calls from your opponent's air.",
    },
    "sizing.dry.good": {
        "ja": "ドライボードへのベット({pct:.0f}%ポット)は適切です。ドライボードでは小さく高頻度にベットすることで、相手のレンジ全体から少しずつエクイティを奪えます。",
        "en": "Your bet ({pct:.0f}% pot) is well sized for a dry board. Betting small and often here chips away at equity across your opponent's whole range.",
    },

    # ------------------------------------------------------------------
    # リーク分析ラベル (stats_logger.build_leak_message)
    # ------------------------------------------------------------------
    "leak.severity.marginal": {"ja": "やや問題", "en": "Minor issue"},
    "leak.severity.bad": {"ja": "大きな問題", "en": "Major issue"},
    "leak.action.FOLD": {"ja": "フォールド過多", "en": "over-folding"},
    "leak.action.CALL": {"ja": "コール（ステーション傾向）", "en": "calling too wide (station tendency)"},
    "leak.action.RAISE": {"ja": "オーバーベット", "en": "over-raising"},
    "leak.action.BET": {"ja": "ベットサイジング不正確", "en": "inaccurate bet sizing"},
    "leak.action.CHECK": {"ja": "パッシブなチェック", "en": "passive checking"},
    "leak.message": {
        "ja": "[{severity}] {pos}ポジション {street}での{action}",
        "en": "[{severity}] {action} from {pos} ({street})",
    },

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
    "coach.context_header": {
        "ja": "=== 現在のハンド情報 ===\nボード: {board}\nHero(あなた): {hero}\nCPU: {cpu}\nPOT: {pot}bb\n\n=== アクション履歴 ===\n",
        "en": "=== Current hand ===\nBoard: {board}\nHero (you): {hero}\nCPU: {cpu}\nPOT: {pot}bb\n\n=== Action history ===\n",
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
