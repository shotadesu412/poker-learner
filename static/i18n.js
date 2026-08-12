// ==============================
// i18n.js — フロントエンドの多言語対応 (ja / en)
// ==============================
// 使い方:
//   HTML:  <button data-i18n="action.fold">フォールド</button>
//          <input data-i18n-placeholder="coach.input_placeholder">
//          <a data-i18n-title="nav.home">      ← title属性
//          <p data-i18n-html="coach.limit_msg">  ← <br>を含む場合
//   JS:    t('bet.call_amount', { amount: 2.5 })
//
// HTMLに書いてある日本語はフォールバック兼ソース。applyI18n() が
// data-i18n を持つ要素を現在の言語で上書きする。
//
// 言語は localStorage('poker_lang') に保存。未設定なら端末の言語で自動判定
// （ja* → 日本語 / それ以外 → 英語）。切り替え時はページをリロードして
// サーバー生成テキスト（評価コメント等）も含めて全体を作り直す。
//
// ★ 文言を追加するときは必ず ja / en 両方に書くこと。
//   en が無いキーは ja にフォールバックする（表示は壊れないが未翻訳が残る）。

const I18N = {
    ja: {
        // --- 共通 / ナビ ---
        "app.name": "ポーカーラッシュ",
        "app.subtitle": "Poker Strategy Training",
        "nav.home": "ホーム",
        "nav.settings": "設定",
        "nav.range_chart": "レンジ表",
        "common.done": "完了",
        "common.back": "← 戻る",
        "common.loading": "読み込み中...",
        "common.none": "なし",
        "common.yes": "あり",

        // --- ホーム画面 ---
        "home.logo_a": "ポーカー",
        "home.logo_b": "ラッシュ",
        "home.play": "ゲームスタート (Play)",
        "home.stats": "分析データ (Stats)",
        "home.settings": "設定 (Settings)",
        "home.section.display": "表示",
        "home.section.account": "アカウント",
        "home.feedback_label": "アクション評価",
        "home.feedback_desc": "アクションごとの解説コメントを表示",
        "home.speed_label": "表示速度",
        "home.speed_normal": "通常",
        "home.speed_fast": "速い",
        "home.premium_plan": "プレミアムプラン",
        "home.premium_active": "加入中",
        "home.premium_upgrade": "アップグレード",

        // --- 言語設定 ---
        "settings.section.language": "言語 / Language",
        "settings.language_label": "表示言語",

        // --- ゲーム画面 ---
        "game.board_tap_hint": "履歴 / ボード",
        "game.show_board": "▲ ボードを見る",
        "game.show_history": "▲ 履歴を見る",
        "game.tap_for_range": "(タップでレンジ)",
        "game.eval_detail": "評価詳細",
        "game.reason_title.eval": "アクション評価",
        "game.reason_title.explain": "アクション解説",
        "action.fold": "フォールド",
        "action.check": "チェック",
        "action.call": "コール",
        "action.bet": "ベット",
        "action.raise": "レイズ",
        "action.call_amount": "コール ({amount}bb)",
        "game.next_hand": "次のハンドへ (Next Hand)",
        "game.ask_coach": "AIコーチに相談する",
        "game.spot_mode": "スポット練習",
        "game.spot_mode_on": "スポット練習 ON",
        "game.spot_fix_position": "ポジション固定",
        "game.spot_random": "ランダム",
        "game.spot_participated_only": "参加ハンドのみ（フォールドは自動スキップ）",

        // --- ベットサイズ選択 ---
        "bet.panel_title.bet": "ベットサイズ選択",
        "bet.panel_title.raise": "レイズサイズ選択",
        "bet.size_small_pot": "小 Small ({pct}% pot)",
        "bet.size_medium_pot": "中 Medium ({pct}% pot)",
        "bet.size_large_pot": "大 Large ({pct}% pot)",
        "bet.size_small_x": "小 Small ({mult}x)",
        "bet.size_medium_x": "中 Medium ({mult}x)",
        "bet.size_large_x": "大 Large ({mult}x)",
        "bet.size_allin": "All-in (5.0x)",

        // --- AIコーチ ---
        "coach.title": "AI ポーカーコーチ",
        "coach.input_placeholder": "質問を入力... (例: リバーでコールすべきだった？)",
        "coach.send": "送信",
        "coach.initial_question": "このハンド全体を通じて私が改善するべき点や、良かった点を簡潔に解説してください。",
        "coach.connect_failed": "コーチに接続できませんでした。しばらく後に再試行してください。",
        "coach.send_failed": "送信に失敗しました。再度お試しください。",
        "coach.limit_title": "AIコーチ",
        "coach.limit_msg": "続けるには広告の視聴が必要です<br><span class=\"coach-limit-sub\">広告を見るか、プレミアムで広告なしに</span>",
        "coach.limit_watch_ad": "広告を見て続ける",
        "coach.limit_or": "── または ──",
        "coach.limit_go_premium": "プレミアムで広告なしにする",
        "ad.load_failed": "広告を読み込めませんでした。通信環境をご確認のうえ、しばらくしてからもう一度お試しください。",

        // --- レンジ表 ---
        "range.title": "レンジ表",
        "range.tab_compare": "比較",
        "range.tab_preflop": "推奨レンジ",
        "range.title_hero": "Hero ({pos}) レンジ",
        "range.title_cpu": "CPU ({pos}) レンジ",
        "range.title_compare": "Hero vs CPU 比較",
        "range.title_preflop": "{pos} 推奨レンジ",
        "range.legend_pair": "ペア",
        "range.legend_suited": "スーテッド",
        "range.legend_offsuit": "オフスート",
        "range.legend_out": "圏外",
        "range.legend_hero_only": "Heroのみ",
        "range.legend_cpu_only": "CPUのみ",
        "range.legend_both": "両方",
        "range.legend_in_range": "推奨範囲内",
        "range.legend_under": "アンダー",
        "range.legend_over": "オーバー",
        "range.note": "※ 色の濃さ = 残存可能性（重み）　セルをタップで詳細",
        "range.tip_hero_cpu": "Hero: {hero} / CPU: {cpu}",
        "range.tip_rec_yours": "推奨: {rec} / あなたの実績: {yours}",
        "range.tip_under": "推奨: あり / あなたの実績: なし（少なめ）",
        "range.tip_over": "推奨: なし / あなたの実績: {yours}（多め）",

        // --- 購入モーダル ---
        "purchase.title": "プレミアムプラン",
        "purchase.plan_name": "プレミアムプラン",
        "purchase.price_loading": "読み込み中…",
        "purchase.renew_note": "月額の自動更新サブスクリプション。次回更新日の24時間前までにキャンセルしない限り自動更新されます。いつでもキャンセル可能。",
        "purchase.feature.no_ads": "広告なし",
        "purchase.feature.unlimited_coach": "AIコーチ無制限",
        "purchase.feature.position_stats": "ポジション別詳細統計",
        "purchase.feature.leaks": "よくあるミス分析（リーク）",
        "purchase.feature.hand_history": "ハンド履歴（直近30件）",
        "purchase.feature.spot_mode": "スポット練習モード",
        "purchase.start": "サブスクリプションを開始",
        "purchase.restore": "購入を復元",
        "purchase.privacy": "プライバシーポリシー",
        "purchase.terms": "利用規約",
        "purchase.status.active": "プレミアムプランご利用中です",
        "purchase.status.processing": "処理中...",
        "purchase.status.restoring": "復元中...",
        "purchase.status.ios_only_buy": "iOSアプリからのみ購入できます",
        "purchase.status.ios_only_restore": "iOSアプリからのみ復元できます",
        "purchase.status.activated": "プレミアムを有効化しました",
        "purchase.status.restored": "購入を復元しました",
        "purchase.status.cancelled": "キャンセルされました",
        "purchase.status.not_found": "復元できる購入が見つかりませんでした",

        // --- 設定モーダル（ゲーム画面） ---
        "settings.title": "設定",
        "settings.section.display": "表示",
        "settings.section.plan": "プラン",
        "settings.section.rules": "ゲームルール（変更不可）",
        "settings.feedback": "アクション評価",
        "settings.speed": "表示速度",
        "settings.speed_normal": "通常",
        "settings.speed_fast": "速い",
        "settings.premium_plan": "プレミアムプラン",
        "settings.premium_active": "✓ 加入中",
        "settings.premium_upgrade": "アップグレード",
        "settings.rule.format": "形式",
        "settings.rule.format_value": "ヘッズアップ",
        "settings.rule.stack": "スタック",
        "settings.rule.blinds": "ブラインド",
        "settings.rule.opponent": "対戦相手",
        "settings.rule.position": "ポジション",
        "settings.rule.position_value": "ランダム",

        // --- 分析ページ ---
        "stats.page_title": "プレイ分析 | ポーカーラッシュ",
        "stats.title": "プレイ分析",
        "stats.period.all": "全期間",
        "stats.period.30d": "直近30日",
        "stats.period.7d": "直近7日",
        "stats.period.last": "直近1セッション",
        "stats.loading_data": "データ読み込み中...",
        "stats.section.overview": "総合スコア",
        "stats.gto_label": "正解率（良い選択の割合）",
        "stats.badge.vpip": "参加率",
        "stats.badge.pfr": "レイズ率",
        "stats.badge.hands": "練習回数",
        "stats.badge.avg_loss": "平均損失 (bb)",
        "stats.section.streets": "ストリート別 正解・ミスの割合",
        "stats.legend.optimal": "◎ 最適",
        "stats.legend.good": "◯ 良好",
        "stats.legend.marginal": "△ 要改善",
        "stats.legend.bad": "× ミス",
        "stats.section.personal_range": "マイ プリフロップ レンジ表",
        "stats.pr.open": "オープン",
        "stats.pr.3bet": "3ベット",
        "stats.pr.call": "コール",
        "stats.pr.unplayed": "未プレイ",
        "stats.section.position": "ポジション別 正解率",
        "stats.th.position": "ポジション",
        "stats.th.hands": "参加回数",
        "stats.th.accuracy": "正解率",
        "stats.premium_lock": "プレミアムプランで解放",
        "stats.section.leaks": "よくあるミス Top5",
        "stats.section.coach_history": "AIコーチ フィードバック履歴",
        "stats.section.hand_history": "ハンド履歴",
        "stats.no_data": "データがありません",
        "stats.no_leaks": "目立ったミスは見つかりませんでした",
        "stats.no_coach_history": "AIコーチに相談した履歴はまだありません",
        "stats.no_hand_history": "ハンド履歴がまだありません",
        "stats.no_preflop_data": "プリフロップデータがまだありません。ゲームをプレイすると表示されます。",
        "stats.hands_count": "{n}回",
        "stats.avg_loss": "平均損失 -{v} bb",
        "stats.hand_n": "ハンド {n}",
        "stats.show_detail": "▼ 詳細を見る",
        "stats.hide_detail": "▲ 閉じる",
        "stats.you": "あなた",
        "stats.board": "ボード",
        "stats.no_actions": "アクションなし",
        "stats.pr_tooltip": "{combo}: オープン{open} 3Bet{threebet} コール{call} フォールド{fold}",
        "street.PREFLOP": "プリフロップ",
        "street.FLOP": "フロップ",
        "street.TURN": "ターン",
        "street.RIVER": "リバー",

        // --- 用語解説 ---
        "glossary.GTO.term": "GTO",
        "glossary.GTO.def": "Game Theory Optimal の略。\nお互いが最適な防衛戦略をとることで誰も搾取されない、数学的な理論上の最適戦略。このアプリの推奨はその考え方を参考にしたものです。",
        "glossary.MDF.term": "MDF",
        "glossary.MDF.def": "Minimum Defense Frequency（最低防衛頻度）の略。\n相手のベットに対して、自分が最低限コールやレイズで守るべき割合。この頻度より少ない守りでは相手のブラフが得をしてしまいます。",
        "glossary.SPR.term": "SPR",
        "glossary.SPR.def": "Stack to Pot Ratio（スタック対ポット比）の略。\n残りのチップがポットの何倍かを示します。SPRが低いほど「オールインしやすい状況」になります。",
        "glossary.EV.term": "EV",
        "glossary.EV.def": "Expected Value（期待値）の略。\nある選択を長期間繰り返したとき、平均的にどれだけ得するかを示します。EV+ならプラスの選択、EV-ならマイナスの選択です。",
        "glossary.pot_odds.term": "ポットオッズ",
        "glossary.pot_odds.def": "コールに必要なチップに対して、ポットがどれだけ大きいかの割合。\n例：ポット100bbに50bbのコールなら33%の勝率があれば損益分岐点です。",
        "glossary.fold_equity.term": "フォールドエクイティ",
        "glossary.fold_equity.def": "ベットやレイズで相手を降ろせる確率から得られる追加利益のこと。\nブラフが成立する根拠のひとつです。",
        "glossary.donk_bet.term": "ドンクベット",
        "glossary.donk_bet.def": "前のストリートでベットしていなかった（アグレッサーでない）側が、先にベットすること。\n意外性はありますが、レンジが読まれやすくなるリスクもあります。",
        "glossary.polarized.term": "ポラライズ",
        "glossary.polarized.def": "極端に強いハンドと弱いハンド（ブラフ）の2種類だけでプレイするレンジ構成のこと。\n大きなベットサイズに向いています。",
        "glossary.cbet.term": "Cベット",
        "glossary.cbet.def": "コンティニュエーション・ベット（継続ベット）の略。\n前のストリートでレイズしたプレイヤーが、次のストリートでも続けてベットすること。",
        "glossary.range_advantage.term": "レンジアドバンテージ",
        "glossary.range_advantage.def": "自分のレンジ全体の平均的な強さが、相手より高い状態。\nレンジ優位があるとベットやブラフが通りやすくなります。",
        "glossary.equity.term": "エクイティ",
        "glossary.equity.def": "勝率のこと。\nそのハンドが最終的にポットを獲得できる確率を表します。"
    },

    en: {
        // --- common / nav ---
        "app.name": "Poker Rush",
        "app.subtitle": "Poker Strategy Training",
        "nav.home": "Home",
        "nav.settings": "Settings",
        "nav.range_chart": "Ranges",
        "common.done": "Done",
        "common.back": "← Back",
        "common.loading": "Loading...",
        "common.none": "none",
        "common.yes": "yes",

        // --- home ---
        "home.logo_a": "Poker",
        "home.logo_b": "Rush",
        "home.play": "Play",
        "home.stats": "Stats",
        "home.settings": "Settings",
        "home.section.display": "DISPLAY",
        "home.section.account": "ACCOUNT",
        "home.feedback_label": "Action feedback",
        "home.feedback_desc": "Show a coaching comment after each action",
        "home.speed_label": "Animation speed",
        "home.speed_normal": "Normal",
        "home.speed_fast": "Fast",
        "home.premium_plan": "Premium",
        "home.premium_active": "Active",
        "home.premium_upgrade": "Upgrade",

        // --- language setting ---
        "settings.section.language": "言語 / Language",
        "settings.language_label": "Language",

        // --- game ---
        "game.board_tap_hint": "History / Board",
        "game.show_board": "▲ Show board",
        "game.show_history": "▲ Show history",
        "game.tap_for_range": "(tap for range)",
        "game.eval_detail": "Feedback",
        "game.reason_title.eval": "Action feedback",
        "game.reason_title.explain": "Action explained",
        "action.fold": "Fold",
        "action.check": "Check",
        "action.call": "Call",
        "action.bet": "Bet",
        "action.raise": "Raise",
        "action.call_amount": "Call ({amount}bb)",
        "game.next_hand": "Next Hand",
        "game.ask_coach": "Ask the AI coach",
        "game.spot_mode": "Spot practice",
        "game.spot_mode_on": "Spot practice ON",
        "game.spot_fix_position": "Lock position",
        "game.spot_random": "Random",
        "game.spot_participated_only": "Played hands only (auto-skip folds)",

        // --- bet sizing ---
        "bet.panel_title.bet": "Choose bet size",
        "bet.panel_title.raise": "Choose raise size",
        "bet.size_small_pot": "Small ({pct}% pot)",
        "bet.size_medium_pot": "Medium ({pct}% pot)",
        "bet.size_large_pot": "Large ({pct}% pot)",
        "bet.size_small_x": "Small ({mult}x)",
        "bet.size_medium_x": "Medium ({mult}x)",
        "bet.size_large_x": "Large ({mult}x)",
        "bet.size_allin": "All-in (5.0x)",

        // --- AI coach ---
        "coach.title": "AI Poker Coach",
        "coach.input_placeholder": "Ask a question... (e.g. should I have called the river?)",
        "coach.send": "Send",
        "coach.initial_question": "Briefly explain what I should improve and what I did well across this hand.",
        "coach.connect_failed": "Could not reach the coach. Please try again in a moment.",
        "coach.send_failed": "Failed to send. Please try again.",
        "coach.limit_title": "AI Coach",
        "coach.limit_msg": "Watch an ad to keep going<br><span class=\"coach-limit-sub\">Watch an ad, or go Premium for an ad-free experience</span>",
        "coach.limit_watch_ad": "Watch an ad to continue",
        "coach.limit_or": "── or ──",
        "coach.limit_go_premium": "Go Premium and remove ads",
        "ad.load_failed": "The ad could not be loaded. Please check your connection and try again shortly.",

        // --- ranges ---
        "range.title": "Ranges",
        "range.tab_compare": "Compare",
        "range.tab_preflop": "Recommended",
        "range.title_hero": "Hero ({pos}) range",
        "range.title_cpu": "CPU ({pos}) range",
        "range.title_compare": "Hero vs CPU",
        "range.title_preflop": "{pos} recommended range",
        "range.legend_pair": "Pairs",
        "range.legend_suited": "Suited",
        "range.legend_offsuit": "Offsuit",
        "range.legend_out": "Not in range",
        "range.legend_hero_only": "Hero only",
        "range.legend_cpu_only": "CPU only",
        "range.legend_both": "Both",
        "range.legend_in_range": "In range",
        "range.legend_under": "Under",
        "range.legend_over": "Over",
        "range.note": "Color intensity = weight remaining. Tap a cell for details.",
        "range.tip_hero_cpu": "Hero: {hero} / CPU: {cpu}",
        "range.tip_rec_yours": "Recommended: {rec} / You: {yours}",
        "range.tip_under": "Recommended: yes / You: never played it (too tight)",
        "range.tip_over": "Recommended: no / You: {yours} (too loose)",

        // --- purchase ---
        "purchase.title": "Premium",
        "purchase.plan_name": "Premium plan",
        "purchase.price_loading": "Loading...",
        "purchase.renew_note": "Auto-renewing monthly subscription. It renews automatically unless cancelled at least 24 hours before the next renewal date. Cancel any time.",
        "purchase.feature.no_ads": "No ads",
        "purchase.feature.unlimited_coach": "Unlimited AI coach",
        "purchase.feature.position_stats": "Detailed stats by position",
        "purchase.feature.leaks": "Common mistakes (leak finder)",
        "purchase.feature.hand_history": "Hand history (last 30)",
        "purchase.feature.spot_mode": "Spot practice mode",
        "purchase.start": "Start subscription",
        "purchase.restore": "Restore purchase",
        "purchase.privacy": "Privacy Policy",
        "purchase.terms": "Terms of Use",
        "purchase.status.active": "Your Premium plan is active",
        "purchase.status.processing": "Processing...",
        "purchase.status.restoring": "Restoring...",
        "purchase.status.ios_only_buy": "Purchases are only available in the iOS app",
        "purchase.status.ios_only_restore": "Restoring is only available in the iOS app",
        "purchase.status.activated": "Premium activated",
        "purchase.status.restored": "Purchase restored",
        "purchase.status.cancelled": "Cancelled",
        "purchase.status.not_found": "No purchase available to restore",

        // --- settings (game screen) ---
        "settings.title": "Settings",
        "settings.section.display": "DISPLAY",
        "settings.section.plan": "PLAN",
        "settings.section.rules": "GAME RULES (FIXED)",
        "settings.feedback": "Action feedback",
        "settings.speed": "Animation speed",
        "settings.speed_normal": "Normal",
        "settings.speed_fast": "Fast",
        "settings.premium_plan": "Premium",
        "settings.premium_active": "✓ Active",
        "settings.premium_upgrade": "Upgrade",
        "settings.rule.format": "Format",
        "settings.rule.format_value": "Heads-up",
        "settings.rule.stack": "Stacks",
        "settings.rule.blinds": "Blinds",
        "settings.rule.opponent": "Opponent",
        "settings.rule.position": "Position",
        "settings.rule.position_value": "Random",

        // --- stats page ---
        "stats.page_title": "Play Analysis | Poker Rush",
        "stats.title": "Play Analysis",
        "stats.period.all": "All time",
        "stats.period.30d": "Last 30 days",
        "stats.period.7d": "Last 7 days",
        "stats.period.last": "Last session",
        "stats.loading_data": "Loading data...",
        "stats.section.overview": "Overall score",
        "stats.gto_label": "Accuracy (share of good decisions)",
        "stats.badge.vpip": "VPIP",
        "stats.badge.pfr": "PFR",
        "stats.badge.hands": "Hands played",
        "stats.badge.avg_loss": "Avg. loss (bb)",
        "stats.section.streets": "Accuracy by street",
        "stats.legend.optimal": "◎ Optimal",
        "stats.legend.good": "◯ Good",
        "stats.legend.marginal": "△ Needs work",
        "stats.legend.bad": "× Mistake",
        "stats.section.personal_range": "My preflop range",
        "stats.pr.open": "Open",
        "stats.pr.3bet": "3-bet",
        "stats.pr.call": "Call",
        "stats.pr.unplayed": "Not played",
        "stats.section.position": "Accuracy by position",
        "stats.th.position": "Position",
        "stats.th.hands": "Hands",
        "stats.th.accuracy": "Accuracy",
        "stats.premium_lock": "Unlock with Premium",
        "stats.section.leaks": "Top 5 common mistakes",
        "stats.section.coach_history": "AI coach feedback history",
        "stats.section.hand_history": "Hand history",
        "stats.no_data": "No data yet",
        "stats.no_leaks": "No notable mistakes found",
        "stats.no_coach_history": "You haven't asked the AI coach about any hands yet",
        "stats.no_hand_history": "No hand history yet",
        "stats.no_preflop_data": "No preflop data yet. Play some hands and it will show up here.",
        "stats.hands_count": "{n}",
        "stats.avg_loss": "Avg. loss -{v} bb",
        "stats.hand_n": "Hand {n}",
        "stats.show_detail": "▼ Show detail",
        "stats.hide_detail": "▲ Hide",
        "stats.you": "You",
        "stats.board": "Board",
        "stats.no_actions": "No actions",
        "stats.pr_tooltip": "{combo}: open {open} / 3-bet {threebet} / call {call} / fold {fold}",
        "street.PREFLOP": "Preflop",
        "street.FLOP": "Flop",
        "street.TURN": "Turn",
        "street.RIVER": "River",

        // --- glossary ---
        "glossary.GTO.term": "GTO",
        "glossary.GTO.def": "Short for Game Theory Optimal.\nThe mathematically unexploitable strategy: if both players play it, neither can be exploited. This app's recommendations are based on that idea.",
        "glossary.MDF.term": "MDF",
        "glossary.MDF.def": "Short for Minimum Defense Frequency.\nThe minimum share of your range you must continue with (call or raise) against a bet. Defend less often than this and your opponent's bluffs become profitable.",
        "glossary.SPR.term": "SPR",
        "glossary.SPR.def": "Short for Stack to Pot Ratio.\nHow many times the pot your remaining stack is. The lower the SPR, the closer the spot is to getting all-in.",
        "glossary.EV.term": "EV",
        "glossary.EV.def": "Short for Expected Value.\nHow much a decision gains on average if you repeat it many times. EV+ is a profitable choice, EV- is a losing one.",
        "glossary.pot_odds.term": "pot odds",
        "glossary.pot_odds.def": "The size of the pot relative to the chips you must put in to call.\nExample: calling 50bb into a 100bb pot means you break even at 33% equity.",
        "glossary.fold_equity.term": "fold equity",
        "glossary.fold_equity.def": "The extra value you gain from the chance that a bet or raise makes your opponent fold.\nIt is one of the reasons a bluff can be profitable.",
        "glossary.donk_bet.term": "donk bet",
        "glossary.donk_bet.def": "Betting first into the player who was the aggressor on the previous street.\nIt can surprise your opponent, but it also risks capping and exposing your range.",
        "glossary.polarized.term": "polarized",
        "glossary.polarized.def": "A range built only from very strong hands and bluffs, with nothing in between.\nIt suits large bet sizes.",
        "glossary.cbet.term": "c-bet",
        "glossary.cbet.def": "Short for continuation bet.\nWhen the player who raised on the previous street bets again on the next one.",
        "glossary.range_advantage.term": "range advantage",
        "glossary.range_advantage.def": "When your whole range is on average stronger than your opponent's.\nWith a range advantage, your bets and bluffs get through more often.",
        "glossary.equity.term": "equity",
        "glossary.equity.def": "Your chance of winning.\nThe probability that your hand ends up taking down the pot."
    }
};

const I18N_GLOSSARY_KEYS = [
    "GTO", "MDF", "SPR", "EV", "pot_odds", "fold_equity",
    "donk_bet", "polarized", "cbet", "range_advantage", "equity"
];

const LANG_STORAGE_KEY = "poker_lang";

// 端末の言語で自動判定。ja* のみ日本語、それ以外は英語。
function detectLang() {
    const nav = (navigator.language || navigator.userLanguage || "en").toLowerCase();
    return nav.startsWith("ja") ? "ja" : "en";
}

function loadLang() {
    try {
        const saved = localStorage.getItem(LANG_STORAGE_KEY);
        if (saved === "ja" || saved === "en") return saved;
    } catch (e) { /* localStorage 不可の環境は自動判定に任せる */ }
    return detectLang();
}

let currentLang = loadLang();

function getLang() { return currentLang; }

// 言語を切り替えて再読み込み。サーバー生成の評価コメントも作り直させるため
// 部分再描画ではなくリロードする（MVP方針: 確実さ優先）。
function setLang(lang) {
    if (lang !== "ja" && lang !== "en") return;
    if (lang === currentLang) return;
    try { localStorage.setItem(LANG_STORAGE_KEY, lang); } catch (e) { /* ignore */ }
    location.reload();
}

// t('key', {name: value}) — {name} を置換する
function t(key, params) {
    const table = I18N[currentLang] || I18N.ja;
    let text = table[key];
    if (text === undefined) text = I18N.ja[key];
    if (text === undefined) return key;
    if (params) {
        Object.keys(params).forEach(function (p) {
            text = text.split("{" + p + "}").join(params[p]);
        });
    }
    return text;
}

// API 呼び出しに lang を付ける（サーバー側の評価コメント生成に使う）
function withLang(url) {
    const sep = url.indexOf("?") === -1 ? "?" : "&";
    return url + sep + "lang=" + currentLang;
}

// data-i18n 属性を持つ要素を現在の言語で書き換える
function applyI18n(root) {
    const scope = root || document;
    scope.querySelectorAll("[data-i18n]").forEach(function (elm) {
        elm.textContent = t(elm.getAttribute("data-i18n"));
    });
    scope.querySelectorAll("[data-i18n-html]").forEach(function (elm) {
        elm.innerHTML = t(elm.getAttribute("data-i18n-html"));
    });
    scope.querySelectorAll("[data-i18n-placeholder]").forEach(function (elm) {
        elm.placeholder = t(elm.getAttribute("data-i18n-placeholder"));
    });
    scope.querySelectorAll("[data-i18n-title]").forEach(function (elm) {
        elm.title = t(elm.getAttribute("data-i18n-title"));
    });
    document.documentElement.lang = currentLang;
}

// ==============================
// 用語解説（評価コメント中の用語をタップ可能にする）
// ==============================
function glossaryEntries() {
    return I18N_GLOSSARY_KEYS.map(function (k) {
        return { term: t("glossary." + k + ".term"), def: t("glossary." + k + ".def") };
    });
}

function glossaryLookup(term) {
    const needle = String(term).toLowerCase();
    const hit = glossaryEntries().find(function (e) { return e.term.toLowerCase() === needle; });
    return hit ? hit.def : "";
}

function escapeAttr(s) {
    return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// 長い用語を先に当てて1パスで置換する。
// （用語ごとに replace を繰り返すと "fold equity" の中の "equity" を
//   二重にラップしてしまうため、必ず1パスでまとめて処理する）
function linkifyGlossary(text) {
    if (!text) return text;
    const entries = glossaryEntries()
        .filter(function (e) { return e.term; })
        .sort(function (a, b) { return b.term.length - a.term.length; });
    if (!entries.length) return text;
    const pattern = entries
        .map(function (e) { return e.term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); })
        .join("|");
    // 英語は語境界を必須にする。これが無いと "EV" が "leverages" の中に
    // マッチしてしまう。日本語は語境界の概念が無いので境界なしで照合する。
    const body = currentLang === "en" ? "\\b(" + pattern + ")\\b" : "(" + pattern + ")";
    const flags = currentLang === "en" ? "gi" : "g";
    return text.replace(new RegExp(body, flags), function (match) {
        return '<span class="glossary-term" data-tooltip="' + escapeAttr(glossaryLookup(match)) + '">' + match + "</span>";
    });
}

document.addEventListener("DOMContentLoaded", function () { applyI18n(); });
