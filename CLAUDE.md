# CLAUDE.md — ポーカーラッシュ (poker-learner)

このファイルは新しいセッションでコンテキストなしに開発を再開できるように、
アプリの仕様・アーキテクチャ・運用手順・意思決定の経緯をまとめたもの。
**大きな変更をしたらこのファイルも更新すること。**

## プロダクト概要

- **アプリ名**: ポーカーラッシュ（英名: Poker Strategy Training / PokerLearner）
- **形態**: iOS アプリ（App Store 配信中）。実体は WKWebView で本番Webを表示するラッパー
- **内容**: ヘッズアップ NLHE のポーカートレーニング。CPU と対戦し、各アクションを
  GTO 準拠の評価ロジックで ◎◯△× 判定。AIコーチ（OpenAI）への相談、分析ページあり
- **ターゲット**: 日本語ユーザー（UI は日本語）
- **開発者**: shota（個人開発）。email: shoooot412@gmail.com

## 収益モデル（重要な意思決定を含む）

1. **月額サブスク**: StoreKit 2、商品ID `com.shota.pokerlearner.premium.monthly`
   - プレミアム特典: 広告なし、AIコーチ無制限、スポット練習モード、分析ページの
     プレミアムセクション（ポジション別/リーク/ハンド履歴）解放
2. **リワード広告**: AIコーチは無料3回まで。以降は「広告を見て続ける」か加入の2択
   モーダル（`coach-limit-modal`）。広告を最後まで見ると無料分3回が回復
3. **インタースティシャル広告**: 30ハンドごとに自動表示（プレミアムは免除）

### 確定済みポリシー（覆す場合はユーザーに確認）
- **広告はフェイルクローズ**: 広告を用意できなかったら「読み込めませんでした」と
  表示してゲートを通さない。以前はフェイルオープンだったが「広告なしでスキップ
  できてしまう」ため 2026/7 に変更（インタースティシャルのみ、進行を止めないため
  未準備時はスキップ）
- **プレミアム判定は StoreKit が正**: サーバーDBはキャッシュ。起動時に
  `onEntitlementStatus(true/false)` が必ず飛び、失効していればJS側で解除して
  サーバーにも `/api/subscription/cancel` を反映（解約後に永久プレミアムが残る
  バグの修正、2026/7/15）
- **広告は表示直前ロード**: 起動時プリロードは廃止（リクエストに対する表示率が
  ~20% まで落ちていた）。リワードはコーチ制限モーダルが開いた時点、
  インタースティシャルは25ハンド目に `prepare*` メッセージでロード（2026/7/21, v1.0.7）

## アーキテクチャ

```
iOSアプリ (SwiftUI + WKWebView)
  └── https://poker-learner.onrender.com/ を表示
        └── FastAPI (app.py) + 素のJS/HTML (static/) ← Render にデプロイ
              └── SQLite (poker_stats.db, Render永続ディスク /data)
```

- **Web が本体**: ゲームロジック・課金ゲート・広告カウントは全部 Web 側。
  JS 修正は Render デプロイだけで全ユーザーに即反映（アプリ審査不要）
- **iOS はブリッジ**: StoreKit・AdMob・ATT/UMP だけネイティブ。
  JS ⇔ Swift は `window.webkit.messageHandlers.*.postMessage` と
  `evaluateJavaScript` で通信

### JS ⇔ Swift ブリッジ一覧（ContentView.swift で登録）

| JS → Swift | 用途 |
|---|---|
| `purchaseRequest` | 購入開始 |
| `restoreRequest` | 復元（AppStore.sync() してから確認） |
| `requestPrice` | 価格表示更新 |
| `showRewardedAd` / `showInterstitialAd` | 広告表示 |
| `prepareRewardedAd` / `prepareInterstitialAd` | 表示直前ロード（v1.0.7+） |

| Swift → JS | 用途 |
|---|---|
| `onPurchaseSuccess(info)` / `onPurchaseCancel()` | 購入結果 |
| `onRestoreSuccess()` / `onRestoreNotFound()` | 復元結果 |
| `onEntitlementStatus(bool)` | 起動時の実権利状態（必ず飛ぶ。falseで解除） |
| `onAdDismissed(earned)` | リワード閉じた（earned=完走） |
| `onAdUnavailable()` | 広告用意できず → JSはエラー表示しゲート維持 |

旧バージョン互換: Swift 側は `window.onEntitlementStatus ? ... : onRestoreSuccess()`
のようにフォールバックし、JS 側の prepare は try/catch で旧アプリを無視する。
**新しいブリッジを足すときも必ず両方向の互換を保つこと**（Webは即時更新される
がアプリは古いバイナリが残るため）。

## 多言語対応 (ja / en) — 2026/8/3 追加

日本語と英語の2言語。**文言はコードに直書きせず必ずカタログ経由にすること。**

### 言語の決まり方
1. `localStorage.poker_lang`（設定画面で切り替えると保存 → `location.reload()`）
2. 未設定なら端末/ブラウザ言語で自動判定（`ja*` → ja / それ以外 → en）
3. サーバーは `?lang=` クエリ > `Accept-Language` ヘッダ > ja の順で解決

既存の日本語ユーザーは今まで通り日本語のまま（自動判定が ja になるため）。

### サーバー側: `i18n.py`
- `MESSAGES = {key: {"ja": ..., "en": ...}}` の1ファイル集中管理
- `t("key", **kw)` で解決。`set_lang()` はリクエスト単位で **contextvars** に保持
- `app.py` の `LanguageMiddleware`（純ASGI）が毎リクエストで `set_lang()` する。
  **BaseHTTPMiddleware ではダメ**（downstream が別タスクになり contextvars が
  伝播しない）。同じコルーチンで `await self.app(...)` する形を崩さないこと
- 利用側: `poker_engine.py`（評価コメント）, `ranges.py`（ハンド解説）,
  `bet_sizing.py`（サイジング評価）, `stats_logger.py`（リーク文言）, `app.py`

### フロント側: `static/i18n.js`
- `I18N = { ja: {...}, en: {...} }` + `t(key, params)`（`{name}` を置換）
- HTML は `data-i18n` / `data-i18n-html` / `data-i18n-placeholder` /
  `data-i18n-title` 属性。`applyI18n()` が DOMContentLoaded で流し込む。
  HTMLに書いてある日本語はフォールバック兼ソース
- **API 呼び出しは必ず `withLang(url)` で包む**（サーバー生成の評価コメントの
  言語がずれるため）
- 用語解説（グロッサリー）も i18n.js が持つ。`linkifyGlossary()` は長い語を先に
  当てる1パス置換。英語は `\b` 語境界必須（無いと "EV" が "leverages" に刺さる）

### iOS ネイティブ
- `{ja,en}.lproj/InfoPlist.strings`: アプリ表示名（ポーカーラッシュ / Poker Rush）と
  ATT 説明文。`Info.plist` 本体は日本語のまま残してある
- `{ja,en}.lproj/Localizable.strings`: スプラッシュ・エラー画面・価格の「/ 月」
- Xcode 16 の同期フォルダ形式（`objectVersion = 77`）なので **ファイルを置くだけで
  ターゲットに入る**。pbxproj の編集は `knownRegions` に ja を足しただけ
- SwiftUI の `Text("key")` は自動でローカライズされるが、**三項演算子を渡すと
  `Text(String)` 側に解決されて翻訳されない**。その場合は `NSLocalizedString` を使う

### 文言を足すときのチェックリスト
1. サーバー文言 → `i18n.py` の `MESSAGES` に ja/en 両方
2. フロント文言 → `static/i18n.js` の `I18N.ja` と `I18N.en` 両方
3. 新しい fetch → `withLang()` で包む
4. キーの過不足チェック（未定義参照・未翻訳・未使用）はこのスクリプトで確認できる:
   `node` で `static/i18n.js` を eval し、HTML の `data-i18n` と JS の `t('...')` を
   突き合わせる（実装例は過去セッションの scratchpad/check_i18n.js）

## ディレクトリ / 主要ファイル

```
poker-learner/
├── app.py              # FastAPI 本体 (~800行)。全API・ゲームフロー制御・言語ミドルウェア
├── i18n.py             # ★サーバー側の多言語カタログ (ja/en) + t()/set_lang()
├── poker_engine.py     # ゲームエンジン (~1600行)。Evaluator(評価), PokerEngine
├── equity.py           # モンテカルロ・エクイティ計算
├── ranges.py           # ポジション別GTOレンジ定義
├── hand_classifier.py, range_utils.py, bet_sizing.py, ev_calculator.py
├── stats_logger.py     # SQLite 永続化 (~620行)。統計・サブスク・ハンド履歴
├── render.yaml         # Render 設定 (uvicorn, /data ディスク, OPENAI_API_KEY)
├── static/
│   ├── i18n.js              # ★フロントの多言語カタログ + t()/applyI18n()/withLang()
│   ├── home.html/.js/.css   # ホーム画面 ("/")
│   ├── index.html           # ゲーム画面 ("/play")
│   ├── script.js            # ゲームJS本体 (~1450行): UI・課金・広告ゲート
│   ├── style.css
│   ├── stats.html/.js/.css  # 分析ページ ("/stats")
│   └── privacy.html(未使用), manifest.json
└── PokerLearner/PokerLearner/   # Xcodeプロジェクト
    ├── ja.lproj/, en.lproj/     # ★InfoPlist.strings, Localizable.strings
    ├── PokerLearnerApp.swift    # 起動フロー: ATT → UMP → AdMob初期化
    ├── ContentView.swift        # WKWebView・ブリッジ・ロード/リトライUI
    ├── StoreKitManager.swift    # StoreKit 2
    ├── AdManager.swift          # AdMob (リワード/インタースティシャル)
    └── Info.plist               # GADApplicationIdentifier 等
```

## API ルート（app.py）

- `GET /` ホーム, `GET /play` ゲーム, `GET /stats` 分析, `GET /app-ads.txt`
- `GET /api/start_hand?user_id=&spot=&position=` 新ハンド
- `POST /api/action` {action, amount, user_id} ハンド進行の中核。
  ハンド終了は5経路（HEROフォールド/CPUフォールド/オールイン/リバー/ストリート閉じ）
  あり、**全てで `_save_hand_record()` を呼んでハンド履歴を保存**している
- `GET /api/state` リロード時の状態復元
- `POST /api/ai_coach` OpenAI 呼び出し（モデル: `gpt-5.4-mini`）
- `GET /api/stats/{overview,position,streets,leaks,personal_range,saved_hands,hand_history}`
- `GET/POST /api/subscription`, `/api/subscription/verify_purchase`, `/api/subscription/cancel`

### サーバー内部状態の注意
- エンジンは `_user_engines: dict[user_id, PokerEngine]`（**メモリ内**）。
  Render 再起動で消える。ハンド途中の復元は `/api/state` が担うが完全ではない
- user_id は端末の localStorage で生成・保持（`poker_user_id`）。アカウントは無い

## DB（SQLite, stats_logger.py）

- `actions`: 全アクションログ。**統計系クエリは全て `actor='HERO'` フィルタ**。
  HERO のみ evaluation(◎◯△×)・ev_loss 付き
- `sessions`: ハンド単位。2026/7/16 に列追加:
  `board, cpu_hand, final_pot, winner(YOU/CPU/TIE), action_log(JSON全アクション)`
- `saved_hands`: AIコーチに相談したハンドとフィードバック
- `subscriptions`: user_id ごとの is_premium（キャッシュ。正は StoreKit）
- マイグレーションは `setup_db()` 内の try/except ALTER TABLE パターン（起動毎に実行）

## 広告（AdMob）

- App ID: `ca-app-pub-2416149393168379~9751019049`（Info.plist）
- 本番ユニット: リワード `.../9738839934`, インタースティシャル `.../6297339288`
- **DEBUGビルドは Google 公式テストID**（AdManager.swift の #if DEBUG）
- 起動フロー: ATT ダイアログ(0.8s遅延) → UMP 同意 → `MobileAds.shared.start()`
- ロードは prepare 時のみ。TTL 55分（AdMob広告は約1時間で失効）。
  ロードTask を共有して二重リクエスト防止。表示時にロード中なら完了を待つ

### 過去の重大バグ（再発防止）
- `MobileAds.initialize()` は **SDK を起動しない**（NSObject の +initialize が
  解決されるだけの no-op）。必ず `MobileAds.shared.start()`。これが原因で
  v1.0.5 以前は広告が一切出なかった
- treys の `Evaluator.class_to_string()` は**インスタンスメソッド**。クラスから
  直接呼ぶと TypeError → ショーダウン勝敗(showdownResult)が常に None だった

## 課金（StoreKit 2）

- StoreKitManager.swift。購入成功で即 `isPremium=true`（サーバー同期は
  バックグラウンド、失敗しても維持）
- `verify_purchase` は**現状トークン未検証**（存在すれば有効扱い）。
  TODO: App Store Server API での実検証
- サンドボックス/審査で「復元」が確認される → `restore()` は必ず
  `AppStore.sync()` を先に呼ぶ実装になっている

## デプロイ / リリース手順

### Web（サーバー+JS）
1. 変更をコミットして `git push origin main`
2. Render が自動デプロイ（数分。無料/Starterプランでコールドスタートあり）
3. **静的アセットを変えたら必ずキャッシュバスティングの ?v= を上げる**
   現在値: `style.css?v=11` / `script.js?v=27` / `home.js?v=4` / `home.css?v=6` /
   `stats.css?v=4` / `stats.js?v=3` / `i18n.js?v=1`（index.html, home.html, stats.html 内）
   **i18n.js は3ページ全部で読み込んでいるので、上げるときは3ファイルとも直すこと**
4. 反映確認: `curl -s "https://poker-learner.onrender.com/static/script.js?v=NN" | grep 目印`

### iOS アプリ
- バージョンは pbxproj の `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION`（2箇所ずつ）。
  **現在: 1.0.8 (13)**（1.0.6(11) がリリース済みの最新。1.0.7(12) は未提出のまま
  破棄し、広告表示率改善＋英語対応をまとめて 1.0.8(13) として提出する方針にした）
- `ITSAppUsesNonExemptEncryption = false` を Info.plist に設定済み
  （HTTPSのみで独自暗号化なし → 免除。提出のたびの質問が出なくなる）
- ビルド確認:
  `xcodebuild -project PokerLearner/PokerLearner.xcodeproj -scheme PokerLearner -configuration Debug -destination 'platform=iOS Simulator,id=<起動中simのUDID>' build`
- アーカイブ（CLI で可能）:
  `xcodebuild ... -configuration Release -destination 'generic/platform=iOS' -archivePath <path>.xcarchive archive -allowProvisioningUpdates`
  → `~/Library/Developer/Xcode/Archives/YYYY-MM-DD/` にコピーすると Organizer に出る
- **アップロードは CLI 不可**（キーチェーンに Distribution 証明書なし、ASC APIキーなし、
  Xcode に Apple ID 未サインイン）。ユーザーが Xcode Organizer → Distribute App で実施
- チームID: `7Z2ZRB6V2J` / Bundle ID: `com.shota.pokerlearner`

### 動作確認のやり方
- ローカルに uvicorn/pytest は無い。`/usr/bin/python3`(3.9) + fastapi/httpx はあるので
  **`fastapi.testclient.TestClient` でインプロセステスト**するのが確実:
  `OPENAI_API_KEY=dummy` と `POKER_DB_PATH=<一時ファイル>` を環境変数で渡し、
  `/api/start_hand` → `/api/action` ループで終局まで回す（過去のテスト例は
  scratchpad に書いた。パターン: CALL/CHECK連打でショーダウン、RAISE 200でオールイン）
- シミュレータ: `xcrun simctl install/launch --console-pty` でログ確認。
  起動直後は ATT ダイアログが出る（タップが必要）。DEBUG ビルドはテスト広告

## 未解決のタスク / 既知の課題

### v1.0.8 英語版リリース（2026/8/13 時点で進行中）
Web側は既に本番反映済み。残りは App Store Connect 側の作業。

1. **1.0.8 (13) の提出** — アーカイブ済み
   （`~/Library/Developer/Xcode/Archives/2026-08-13/PokerLearner_1.0.8_13.xcarchive`）。
   アップロードは Xcode Organizer から（CLI 不可）
2. **配信国に米国を追加**（方針: まず米国だけ。反応を見てから拡大）。
   これをやらないと英語対応しても英語圏ユーザーは来ない
3. **App Store の English (U.S.) ローカライズ**: アプリ名 "Poker Rush"（他社との
   重複要確認）/ サブタイトル / 説明文 / キーワード / What's New /
   **英語UIのスクリーンショット撮り直し**（日本語のままだとリジェクト対象）
4. **サブスク商品のローカライズ**: `com.shota.pokerlearner.premium.monthly` の
   表示名・説明に English を追加。忘れると英語圏の購入シートが日本語になる
5. **年齢制限 17+ と「実際の賭博ではない」旨の明記**（Guideline 5.3 対策）
6. **プライバシーポリシー / 利用規約の英語版**（現在は Notion の日本語ページ。
   `static/privacy.html` は未使用の死にファイル）

### 継続課題
7. **App Store Connect の「マーケティングURL」に `https://poker-learner.onrender.com`
   を設定**。AdMob の app-ads.txt 警告の解消に必要。
   app-ads.txt 自体はサーバー実装済み・配信確認済み
8. **AdMob 管理画面で UMP 同意フォームが未設定**（起動ログに毎回エラー。
   米国のみなら影響軽微だが、**EEA/英国に広げるなら必須**）
9. `verify_purchase` の実トークン検証（App Store Server API）
10. 広告表示率の改善効果を AdMob レポートで確認（v1.0.8 浸透後）

## 作業時の注意（このプロジェクト固有）

- コミットメッセージは日本語。バージョンを上げたら `(vX.Y.Z)` を付ける習慣
- `poker_stats.db` / `trace*.txt` / `*.log` / スクリーンショット類はローカルの
  実行時生成物。**コミットに含めない**（git status に常に出るが無視）
- 評価ロジック（Evaluator）はポーカー文献と照合しながら細かく調整してきた経緯が
  ある（EQR・SPR・MDF・ブラフキャッチャー等）。安易に数値をいじらない。
  変更するときは git log の該当コミットの意図を確認する
- CPU戦略の仕様: プリフロップのオープンに対して CPU は フォールドなし
  （95%コール/5%3ベット）— 練習機会を最大化するための意図的な仕様
- Web は素の JS（フレームワークなし）。既存のコードスタイル（グローバル関数 +
  onclick 属性 + el() ヘルパー）に合わせる
