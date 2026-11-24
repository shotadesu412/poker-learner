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

## ▶ 次のセッションへの引き継ぎ（2026/11/22 時点）

**直近の流れ（11/21〜22）**: 3ベット周りを 6人卓の解析に合わせて作り直して push（`ad31e25`）。続いて新しい画面（static/v2、開発者モードだけ）を
3回に分けて作り直して push（`420dc74` `7a90a4c`）。最後の push（11/22）の後、**shota が iPhone の開発者モードで確認中**。
- 再開したらまず shota の感想を聞く。特に「アクションのたびにレンジの面へ戻る」が直ったか（原因は iPhone の scroll-snap と推測。
  パソコンの WebKit では再現できなかったので、実機での確認待ち）と、スワイプの手触り
- 3ベットの作り直しも「微妙だったら伝える」と言われている（プリフロップの判定が大きく変わった。特に3ベットされた後は以前の「フォールド推奨」の多くがコール・4ベットに）
- 解釈して決めたところ（違っていたら直す）: ゲーム画面の上は通常の練習では表題なし（スポット練習だけ設定を出す）、消した「レンジ表」ボタンはゲーム画面の上のもの
- 監査の手順: tools/audit/spots.js は 4本×450ハンドだと誤差が大きい。前後比較は8本（シード1〜8）で見る。11/21 に、監査が判定の代わりに使う
  スタブに最善手（`best`）が無くて 11/19 から動かなかったのを直した

それ以前: 11/15 にフェーズ7（サーバーを AIコーチ専念にする移行）を完了。永続ディスクも削除済み。
続いて 1.0.8 (14) をアーカイブし、マーケティング分析（下の「マーケティングの現状」）を実施した。

### 2026/11/22 の修正（すべて push 済み）
- **防衛の下限（MDF）で勝率がほぼ同じ手のかたまりを正しく分ける**（range_model.js の `mdfEdge`）: 境目を「なめらかに守る量の合計 = MDF × 0.9」になるよう
  二分法で決める。以前はボードをプレイする A ハイなどのかたまりが境目に来ると、サイズに関係なく約5割守る計算だった（33% でも 150% でも降りる割合が同じ →
  強い手で大きいサイズほど過大評価）。shota 報告の2件: 77 の4カードのリバー「150% が 9.8bb 良い ×」→ 3.7bb の △、
  KT の2ペア（3s4d5cTd4s、BTN vs SB）の 75% ベット「150% が 4.5bb 良い ×（降りる約44%で変わらず）」→ 1.3bb の ◯。
  CPU のリバーのポット以上のベットへのフォールドが約38%→約55〜66%（理論上の上限 1−0.9×MDF の範囲）
  **監査の注意**: 手札を固定する tools/audit/spots.js の「一致率」は、CPU が理論どおり守って損得が五分に近づくと下がって見える（最初の前後比較で
  「ブラフのサイズ選び 85%→47%」と出たのはこの見かけ）。CPU の手札を毎回レンジから引き直す同じ局面の前後比較では、推奨が変わった局面で
  新しい推奨の方が得（リバー +2.1±0.35bb、ブラフ +1.3±0.5bb、強い手 +3.4±0.6bb）。この監査の仕組みはローカルブランチ `mdf-tie-fix` の
  tools/audit/spots_paired.js（scratchpad 版は `RESAMPLE=1` で手札を引き直す）
- **まだ一度もアクションしていない側のレンジは全ハンドを表示**（game.js の `heroRangeRaw` / `cpuRangeRaw`）: 内部のレンジは「オープンにコールする」前提で
  先に絞ってあり、それが表示されて動く前から約5%に見え、CPU の席（??? で伏せている）まで推測できた。判定・CPU の計算は変えていない
- **防衛の下限で守る手を「手の強さ」（全コンボに対する勝率。`RankTable.strength()`）の順に選ぶ**（probs の `s.hs`。posterior・CPU の判断・postflop_ev の予測の4か所）: 以前は「相手のベット/レイズのレンジに対する勝率」順。
  レイズのレンジはほぼ強い手だけと見積もられるので CPU の手が横並びになり、ブラフの手まで約5割コールする → 被ベットのリバーの 36% で「レイズが最善」、
  勝率49%の手のレイズ最善や 2ペアのコール ×（オールインとの差 31bb）の原因。試作（境目の修正込み）の監査: リバーでレイズをコールより上と判定 30%→7%
  （当たる向き 77%→86%）、推奨が変わった局面でターン +1.2±0.3bb・リバー +1.1±0.5bb、被ベットの一致率 ターン 77→80% / リバー 91→94%。
  CPU のリバーのレイズへのフォールド 33%→50%、リバーの 100%以上のベットへ約56%、55〜85% へ約40%（いずれも 1−0.9×MDF の範囲）。
  プリフロップの 3ベットへの防衛の下限（engine.js の `_vs3betMdfE`）は今までどおり勝率順
- **ドンクが有効な場面の解説**（2026/11/23 shota 指摘。postflop_ev.js の `pf.why.donk_justified(_checkback)`）: 判定のすぐ後（2行目）に
  「ドンクベットが有効な場面」と理由（チェックより得な量。ターン・リバーはチェックしたときに相手が打ってくる割合も）を書く。以前は解説の最後に一言だけだった。
  あわせて、ドンクの場面で「チェックは △ より下にしない」で記号が変わった分を「スロープレイなので緩めた」と書いていたのを直した
- **リバーの解説の総点検**（postflop_ev.js の `explain`）: サイズの差の理由（役割と、降りる割合・続けてくる手への勝率の比較）、リバーは「薄いバリュー」
  （以前は「ドローに無料でカードを見せない」）、チェックが勝る理由（強い手ばかり続けてくる / 相手が打ってくる / 勝てる手をブラフにしない）、
  ドンクの場面の理由、判定と解説の矛盾（差 0.5% 未満で「最善」と書いていた）を直した
- **AIコーチに役とアプリの解説を渡す**（game_api.js の `coachState` → app.py の `_coach_context`）: 役はカードの文字列だけだと GPT が読み違える
  （4カードを「フルハウスの強化」と講評）。各アクションに役（`made`）と画面の解説（`reason`）、最後に双方の役を付け、プロンプトで「役は自分で判定しない・
  アプリの解説と同じ結論にする」と指示した

### 2026/11/18 に push したもの（判定・CPU の作り直し一式）
- `270eab1` 以降の「CPU に実際の手札 / ポストフロップの判定を期待値比較に / レンジのベイズ更新 / BB のコールレンジ / 防衛の下限」、
  「6人卓の理論優先（SB は 3ベットかフォールド）・BB のリンプ対応・解説の総ざらいと短縮」、「CPU が先にチェックしたときもレンジを更新」、
  「分析ページの見た目の作り直し」「AIコーチの無料回数を端末に保存」。shota が開発用アプリ（下の「動作確認のやり方」）で確認済み
- **勝率の正確さ（2026/11/18 実測）**: 判定に使う勝率（推定レンジに対する勝率）と CPU の実際の手札に対する勝率の差は、フロップ・ターン・リバーとも
  ほぼ 0〜2 ポイント。以前は CPU が新しいストリートで先にチェックしたときにレンジを更新しておらず、リバーで 10〜13 ポイント低く出ていた
- **先に動くチェックの計算（2026/11/19）**: ターン・リバーで OOP が先にチェックするとき、相手が行動モデルでベットしてくる確率と、
  そのときのコール/チェックレイズの損得まで読む（postflop_ev.js の `checkFirstEv`。以前の「勝率×実現率×ポット」との大きい方）。
  監査で、強い手は先にチェックした方がポットの約2割得なのに、モデルは「ベットが上」と見ていた。修正後は予測と実際が一致し、
  先に動く場面の判定の正しさはリバー +2.5→+3.2bb・ターン +1.1→+1.4bb。フロップは以前の計算の方が合っていたのでそのまま。
  残り: 中くらいの手はまだずれがある（ターンで実際はベットが +16% 良いのに予測は −3%）。ただし監査のロールアウトはあなた役が簡易ルールなので、
  後の判断が多いチェックの線ほど不利に出る。ここに合わせるとルールの弱点を正解として取り込むので、2026/11/19 時点では直していない
- **ドンクの場面はチェックが基準**（2026/11/21〜）: OOP・主導権なし・そのストリートで先に動く場面では、モデルが予測するドンクの得が
  ポットの10%以上のときだけドンクを最善にする（理論では主導権の無い側は先にチェックが基本。監査で、予測の得が10%未満の場面は
  実際にはチェックと同じか損だった）。ドンクを勧める割合 66%→24%。チェックは △ より下にしない。正当でないドンクは ◯ まで。
  なお、正当なドンクの多くは「先に打たれてもレイズを返さない」今の CPU の弱点を突く面がある（CPU の対ドンクの打ち方は改善候補）
- **プリフロップのレイズは場面ごとに1サイズ**（2026/11/19 shota 指定。`GameApi.preflopRaise`）: オープン UTG〜BTN 2.5bb・SB 3bb（合計）/
  BB で SB のリンプに 4bb / 3ベット IP 3倍・OOP 4倍 / 4ベット IP 2.2倍・OOP 2.5倍 / それ以上はオールイン。判定はサイズを見ない（レンジ表の前提サイズ）
- **3ベット周りを 6人卓の解析に合わせて作り直した（2026/11/21）**: 3ベットのサイズ（IP 2.5倍・ブラインド 3倍。あなたのボタンと CPU）、
  3ベットの表（守る側 × オープンした位置。`tools/ranges/gen_3bet.js`。割合は解析、中身はバリュー6割＋ブロッカーのブラフ）、
  コールの表（3ベットの手を除いて `gen_ip_call.js` / `gen_blind_defend.js` で作り直し）、3ベットされたときの表
  （オープンした位置 × 3ベットした位置。`gen_vs3bet.js`。続ける割合は解析の 53〜81%。以前は約2割しか続けていなかった）。
  CPU が3ベットされたときもこの表どおりに行動する。生成の順番は gen_3bet → gen_ip_call・gen_blind_defend → gen_vs3bet
- **CPU がドンクを受けたとき**（2026/11/21〜。range_model.js の vsDonk*）: バリューの基準を下げ、強いドローの半分・弱い手の一部でレイズを返す。
  フロップの小さいドンクへのレイズ 3%→23%
### 新しい UI（`static/v2/`。開発者モードのときだけ開く。shota が納得するまで今の画面は変えない）
- **ホームはダッシュボード型**（2026/11/23 shota と相談中。「地味・設定が重い・配置」が不満）: 下のタブは「ホーム」、上は見出し「ホーム」だけ（アプリ名は消した）。◎◯ の割合（直近7日、前の7日に20判断以上あれば差）、
  アクション傾向（分析の「プレイの傾向」と同じ。全期間）、今日の課題（分析のリークの1位で3回以上のもの。**無料の人にも1件だけ見せる** = shota 決定。分析タブのリーク一覧はプレミアムのまま）、今週のカード（2026/11/24 shota 案: 1日10ハンドでカードが1枚、月〜日の7枚で役を作る。カードは端末の ID + 週の初日で決まる並びから曜日順に配るので開き直しても同じ。打たなかった日は配らない。今日の1枚は10ハンドで裏向きに置かれ、タップでめくる（めくった日は localStorage `poker_wc_revealed`）。カードを押すと役のコレクション（終わった週ごとの7枚と役・役ごとの回数。`StatsCalc.getCardCollection`）。同じ日に20ハンドで1日1回「追加の1枚」（同じ並びの8枚目以降・曜日ごとに1枚）を引き、今週のどれか1枚と入れ替えるか選べる（選択は localStorage `poker_wc_swaps`。全部の日で引いて欲張りに入れ替えるとフルハウス約22%・ツーペア約43%）。報酬は今のところ無し。`StatsCalc.getWeekCards`。今日の課題が出ているときは間を詰める（`.hm-body.dense`）。iPhone 13 で1画面、SE はスクロール）。その下、空きの真ん中に（shota の手書きの配置図どおり）
  「練習」（見出し・「ポジションもハンドもランダム」・緑のスタート）と「スポット練習 Premium」（見出し・「ポジション選択可能・参加するハンドだけ」・紫のスタート）→ 紫を押すと下から設定のシート（ホームの section の外に置く。中に置くと iPhone で下のタブの下に描かれて見切れた）。ゲーム画面のボードのタップ（履歴/ボードの切り替え）は新しい画面では消した（`StatsCalc.getHomeSummary`、v2/script.js の `renderHomeStats`）
- 下のタブ（練習・振り返り・分析・設定）の1ページ化。練習タブはホーム（スタート / スポット練習: ポジション・配るハンド（ランダム / 参加するハンドだけ）・スタート）で、
  ゲーム画面は別（下のタブを隠し、左上の戻るでホームへ。進行中のハンドはホームの「続きから」で再開）。
  ゲーム画面の中央は左右スワイプで3枚: 推定レンジ（相手/あなた を切り替え）← アクション履歴（最初の面）→ 横長の楕円のテーブル。
  スワイプは自前の translateX（panels.js。scroll-snap は iPhone で描き直すたびに位置が戻ったのでやめた。2026/11/21）。
  面の名前（レンジ / アクション履歴 / テーブル）を上に並べる。振り返りは上のタブで ハンド履歴 / AIコーチ を切り替え、20件ずつページ送り
  （ハンド履歴は新しい順に 500件まで。`GameApi.loadSecondary` の第2引数）。
  コンセプト: 理論が入った相手と打ち合える → 一手ごとに即評価 → 納得いかないハンドは AI に深く解説してもらう
- **開発者モード（下の節）をオンにすると、`/` `/play` `/stats` を開いたとき `/v2` に移る**（各ページの head の inline script）。オフで今の画面へ戻る。
  新バージョンの確認はこの経路で shota の実機（本番アプリ）で行う。ユーザーには見えない
- 今の画面と共通: `static/poker/`・`style.css`・`i18n.js`・`game_api.js`。新しい画面だけの部品: `static/v2/` の index.html・script.js・stats.js・stats.css・tabs.css・panels.js。
  **共通ファイルを変えるときは両方の画面で確認する**。新しい画面を正式にするときは static/v2/ の中身を今の画面の場所へ移し、振り分けの inline script を消す
- 作業用ブランチ `ui-v2` は 2026/11/21 に static/v2/ へ移したので使わない
- サーバー無しの確認用ページ: https://claude.ai/artifact/3B5aPFbmUDcGuRVBEFYxcs （`python3 tools/preview/build_preview.py <出力先>` → 公開し直し。AIコーチは動かない）
- 残り: 振り返りタブから過去のハンドを AI に相談する（C）。ハンド履歴は今プレミアム限定のまま（課金導線は触らない）。
  新しい画面を正式にする（今の画面と入れ替える）のは shota が納得してから

### shota 待ち（ここから再開）
- 2026/11/23 shota 報告: Apple の規約（PLA）への同意と 1.0.8 (14) のアップロード・提出は完了。ストアの見た目（名前・サブタイトル・キーワード・スクショ）の作り直しは**次のバージョンで**じっくり考える
- **今のサブタイトルとキーワード欄を共有してもらう**（公開ページからは取れなかった）

### Claude がやること（shota の上記を受けて）
- **1.0.8 の提出前に、ストアの見た目を練習アプリ寄りに作り直す**（アプリ名・サブタイトル・キーワード・スクショ1〜3枚目）。
  名前やスクショは新しいバージョンの提出時しか変えられないので、1.0.8 にまとめる。案は「マーケティングの現状」参照。
  順位が一時的に動くトレードオフは説明済み。**提案段階で shota の承認はまだ**
- `2f4e392`（エラー文言の多言語化）は 2026/11/18 の push で本番に出ている
- 提出用の「このバージョンの新機能」（2026/11/19 書き直し。11/18〜19 の判定の作り直し・分析ページを反映）:
  - ja: 判定を大幅に改善：選べるアクションの期待値を比べて ◎◯△× を判定し、相手のレンジもアクションごとに正確に絞り込むように /
    解説を一新：なぜその手が良いのかを短く、理論に沿って説明 / CPU が実際の手札で考え、ブラフもバリューも理論に近い打ち方に /
    分析ページを刷新：あなたのプレイの傾向（タイト・ルース × アグレッシブ・パッシブ）を表示 / 動作を高速化：計算を端末内で行うように /
    不具合の修正と安定性の向上
  - en: Much more accurate feedback: every option is compared by expected value, and opponent ranges are narrowed after each action /
    Clearer explanations: short reasons for why a play is right, based on poker theory / The CPU now plays its real cards with theory-based bluffs and value bets /
    Redesigned stats page: see your play style (tight or loose, aggressive or passive) / Faster gameplay: hands are now calculated on your device /
    Bug fixes and stability improvements

### 後回し（急がない）
- Render の Account Settings → SSH Public Keys から `shota-mac` を削除（もう使わない）
- dev-dashboard: ASC の「App Sessions」「Installation and Deletion」レポートを取り込む（端末計算に移ってから利用状況が見えないため）
- 評価ロジック監査の残り（#2 CPU のポストフロップ透視、#3 平均損失の見直し）: MIGRATION_NOTES.md
- MATCHESS（chess_puzzle）のインプレッション表示: dev-dashboard の CLAUDE.md 参照。管理キーが要る。shota の指示で後回し

## 収益モデル（重要な意思決定を含む）

1. **月額サブスク**: StoreKit 2、商品ID `com.shota.pokerlearner.premium.monthly`
   - プレミアム特典: 広告なし、AIコーチ無制限、スポット練習モード、分析ページの
     プレミアムセクション（ポジション別/リーク/ハンド履歴）解放
2. **リワード広告**: AIコーチは無料3回まで。以降は「広告を見て続ける」か加入の2択
   モーダル（`coach-limit-modal`）。広告を最後まで見ると無料分3回が回復
   - **無料の残り回数は端末（localStorage `poker_coach_free_left`）に保存**（2026/11/18〜）。以前はメモリだけで、読み込み直しや
     アプリの開き直しで3回に戻っていた（API 費用がかかるため shota 指定で修正）。回答を取れなかったとき（通信エラー・サーバーの
     `error: true`）は1回分戻す。同じハンドの相談を開き直すだけでは減らない
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

## 計算ロジックのJS移植（2026/9/27〜11/15 完了）

**サーバーを「AIコーチ専念」構成にするため、計算をクライアントへ移している最中。**
新セッションで作業を引き継ぐ場合は、まず `MIGRATION_NOTES.md` を読むこと。

- **目的**: サーバーの責務を「静的配信 + `/api/ai_coach`」だけにする。
  ゲームエンジン・評価ロジック・エクイティ計算・統計をすべて端末側へ。
  Render の永続ディスクも不要になる
- **きっかけ**: 1アクションあたり約850msのCPUを消費し、同時3リクエストで
  レイテンシが1.7秒→25秒に劣化していた（uvicornワーカー1 + GILで実質直列）。
  エクイティ計算の約10倍高速化で当面は解消したが、伸びた時に備えて移植する
- **即日デプロイは維持される**。JSはアプリに同梱せずRenderから配信するため、
  `git push` で全ユーザーに即反映という今の利点はそのまま
- **Flutter等への移植ではない**。WebViewが既にJSを動かしているので移植先はJS

### 進捗

| フェーズ | 内容 | 状態 |
|---|---|---|
| 0 | ゴールデンテストベクタ整備 | **完了** |
| 1 | ハンド評価器をJSへ | **完了**（`static/poker/hand_eval.js`。全5枚組260万通りでtreysと完全一致） |
| 2 | レンジデータをJSONへ | **完了**（`static/poker/ranges.json` を Python/JS で共有。`ranges.js`） |
| 3 | エクイティ計算をJSへ | **完了**（`equity.js` / `range_utils.js`。MCは統計検定で一致） |
| 4 | Evaluator（評価ロジック）をJSへ | **完了**（`evaluator.js` ほか。全出力を日英コメントまでビット一致） |
| 5 | エンジン・CPU AIをJSへ | **完了**（`engine.js` / `game.js`。乱数テープでハンド全体がビット一致。**画面にはまだ未接続**） |
| 6 | 統計をIndexedDBへ移行 + 画面を JS エンジンに切替 | **完了**（`static/game_api.js`。`?engine=server` / `?engine=local` で端末ごとに切替） |
| 7 | サーバーをAIコーチ専念構成に縮小 | **完了**。7-1 既定を端末計算に切替 = **完了（2026/10/4）** / 7-2 コード削除 = **完了（2026/11/15）** / 永続ディスクの削除 = **完了（2026/11/15）** |

### 現在の状態と次の一手（2026/11/15 時点）

- **2026/11/15: フェーズ7-2 を main にマージ**。計算系・統計・サブスク・レンジの API、Python エンジン一式、
  サーバー計算へのフォールバック、隠しスイッチ（設定の「ポーカーラッシュ」7回タップ）、サーバー統計の取り込みを削除。
  マージ前に Chromium / WebKit の通し確認と、shota の iPhone（Safari）での確認（判定・レンジ・分析ページ・再読み込み後の統計）を実施
- **ゲーム・評価・統計は端末だけで動く**。統計は IndexedDB にしか無い（端末を変える・アプリを消すと消える）
- **プレミアム判定**: localStorage + StoreKit の `onEntitlementStatus` のみ。サーバー DB には持たない
- 端末エンジンを読めないときは再読み込みを案内する画面（`#engine-error`）を出す
- **永続ディスクは 2026/11/15 に削除**。削除前の DB は shota の Mac の `~/Projects/poker-learner-backup/poker_stats_2026-11-15.db`（sha256 一致・integrity ok を確認。git には入れない）
- 削除前の Python 実装は git タグ `python-engine-final`（`git show python-engine-final:poker_engine.py`）。
  移植前のものは `python-engine-v1`
- **評価ロジックの監査結果（2026/11/1）**: 13件中 #1 #4 #5 #6（プリフロップの判定）は修正済み。残りは MIGRATION_NOTES.md「評価ロジック監査」参照
- **ポストフロップの判定は期待値の比較（2026/11/17〜。`static/poker/postflop_ev.js`）**: 選べる全アクション（画面のボタンと同じサイズ）の
  EV を出し、「最善手との差 ÷ ポット」で ◎（2%以内）◯（7%以内）△（15%以内）× を付ける。解説には全選択肢の EV が並ぶ。
  サイズだけの違いと、強い手（勝率60%以上）のスロープレイは基準を1.5倍に緩める（監査でモデルの誤差が大きく、ソルバーでも混ぜる場面のため）。
  相手が降りる割合と、続けてくる手への勝率は range_model.js の行動モデル（CPU が実際に使う確率）で計算する。
  実現率（チェック・コールした側がエクイティのうち回収できる割合）は勝率で変わる直線で、`tools/audit` のロールアウトに合わせた。
  プリフロップは従来どおりレンジ表で判定（BB のコールだけオープンした位置ごとの表）。
  **統計の不連続**: ポストフロップの判定が厳しくなる（ランダム寄りの打ち方で、コールの × 10%→46%、ベットの × 7%→25%）。
  `ev_loss`（平均損失）もポストフロップは「最善手との EV 差（bb）」に変わった。監査では × と判定した手は推奨手より平均で
  フロップ 1.5bb・ターン 3.6bb・リバー 14bb 損しており、判定は当たっている（以前は同じコールの多くが ◎ だった）
- **大規模監査（`tools/audit/`、README あり）**: 判定の正しさ（ロールアウト）と CPU の打ち方の統計。評価ロジックや CPU を変えたら回す
- 改善候補（影響大・要相談）: `estimate_fold_equity` と `ev_check` の見直し
  （平均損失・リークの精度が上がるが、既存統計と数値が不連続になる）。詳細は MIGRATION_NOTES.md
- ディスク削除後のデプロイ（2026/11/15）では、15秒おき40回の監視で 502 は出なかった（無停止デプロイ）

### 評価ロジック・エンジンを変えるときの鉄則

- **正しさは `tools/audit/` で測る**（ゴールデンは「前と同じか」しか見ない）。修正前の static/poker を `git archive` で取り出して並べて回す
- **回帰テストを毎回通す**: `node tools/golden/check_js.js`（ゴールデンベクタで JS 実装を検証。差分があれば exit 1）
  モンテカルロは乱数列が違うので `vectors/equity_reference.json`（Python で2万回×40局面）と統計検定する
- **評価を意図的に変えるとき**: `node tools/golden/compare.js [ref=HEAD] [hands=3000]` で修正前後を同じ条件で比べ、
  変わった場面が想定どおりか確認 → `node tools/golden/check_js.js --update` で期待値を更新 → `git diff` を見る。
  レンジ・ハンド評価・エクイティ参照値のベクタは更新対象外（誤った値を正解にしないため）
- **画面を通した確認**: `tools/e2e/local_engine.js`（Playwright。手順はファイル冒頭。WebKit で回すときは `chromium` を `webkit` に置き換える）
- エンジン・評価ロジックは乱数を必ず `rng` 経由で使う（乱数テープのベクタと一致させるため）
- `static/poker/` のコードはビルド工程なしで `<script>` のグローバルとして読め、
  テスト用に Node の `module.exports` でも読める両対応の形にする（`hand_eval.js` が見本）

### 構成（2026/11/15〜）

```
iPhone
├── Swift（ネイティブ）  StoreKit / AdMob / ATT・UMP / WebView
└── WKWebView
      HTML/CSS/JS ← Renderから配信（即日デプロイ維持）
      ├── ゲームエンジン・CPU AI
      ├── 評価ロジック（Evaluator）
      ├── エクイティ計算（モンテカルロ）
      └── 統計（IndexedDB）
                    ↓ AIコーチの時だけ通信
Render: 静的配信 + /api/ai_coach のみ（ステートレス・ディスク不要）
```

---

## アーキテクチャ（現状）

```
iOSアプリ (SwiftUI + WKWebView)
  └── https://poker-learner.onrender.com/ を表示
        └── FastAPI (app.py) ← Render にデプロイ
              ├── 静的配信（static/。ゲーム・評価・統計は static/poker/ + IndexedDB で端末が計算）
              └── /api/ai_coach（OpenAI）
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
| `requestReview` | App Store レビュー依頼（v1.0.8+）。条件は `script.js` の `noteHandFinished`（累計20ハンド以上・勝った直後・120日に1回） |

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
- `MESSAGES = {key: {"ja": ..., "en": ...}}`。**2026/9/27〜 実体は2か所に分かれている**:
  - 評価コメント・ハンド解説・サイジング・リーク → **`static/poker/messages.json`**
    （JS 版の評価ロジック `static/poker/messages.js` と共有）
  - AIコーチのプロンプト・API エラー → `i18n.py` の `_SERVER_MESSAGES`
    （static に置くと誰でも取得できるため。プロンプトを公開しないこと）
- 書式は `{name}`（文字列のみ）と `{name:.1f}` / `{name:.0f}` だけを使う。JS 版は Python と同じ
  偶数丸め（`pyfmt.js`）で再現しており、`{name}` に数値を渡すとエラーにしている（5 と 5.0 を区別できないため）
- `t("key", **kw)` で解決。`set_lang()` はリクエスト単位で **contextvars** に保持
- `app.py` の `LanguageMiddleware`（純ASGI）が毎リクエストで `set_lang()` する。
  **BaseHTTPMiddleware ではダメ**（downstream が別タスクになり contextvars が
  伝播しない）。同じコルーチンで `await self.app(...)` する形を崩さないこと
- 利用側: `app.py`（AIコーチ）のみ

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
1. サーバー文言 → 評価系は `static/poker/messages.json`、コーチ/API は `i18n.py` の `_SERVER_MESSAGES` に ja/en 両方
2. フロント文言 → `static/i18n.js` の `I18N.ja` と `I18N.en` 両方
3. 新しい fetch → `withLang()` で包む
4. キーの過不足チェック（未定義参照・未翻訳・未使用）はこのスクリプトで確認できる:
   `node` で `static/i18n.js` を eval し、HTML の `data-i18n` と JS の `t('...')` を
   突き合わせる（実装例は過去セッションの scratchpad/check_i18n.js）

## ディレクトリ / 主要ファイル

```
poker-learner/
├── app.py              # FastAPI 本体 (~250行)。画面配信・/api/ai_coach・言語ミドルウェア
├── i18n.py             # ★サーバー側の多言語カタログ（AIコーチのプロンプト・APIエラー）
├── render.yaml         # Render 設定 (uvicorn, OPENAI_API_KEY。ディスクなし)
├── static/
│   ├── i18n.js              # ★フロントの多言語カタログ + t()/applyI18n()/withLang()
│   ├── home.html/.js/.css   # ホーム画面 ("/")
│   ├── index.html           # ゲーム画面 ("/play")
│   ├── script.js            # ゲームJS本体 (~1450行): UI・課金・広告ゲート
│   ├── game_api.js          # ★ゲーム進行・統計の呼び出し口（端末エンジン + IndexedDB）
│   ├── poker/               # ★端末エンジン一式（JS移植。MIGRATION_NOTES.md 参照）
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
- `POST /api/ai_coach` OpenAI 呼び出し（モデル: **`gpt-6-luna`**, 2026/11/21〜。それ以前は `gpt-5.6-luna`。切り戻しは Render の環境変数 `COACH_MODEL`）
  - 設定は app.py 冒頭の `COACH_MODEL` / `COACH_REASONING_EFFORT` / `COACH_MAX_TOKENS`。
    いずれも同名の環境変数で上書き可（Renderの環境変数だけで再デプロイなしに切戻せる）
  - 必須項目 `state`（端末エンジンのハンド状態）。相談履歴はサーバーに保存せず、`hand_context` を返して端末に保存させる
  - `state.history` のあなたのアクションには、アプリの判定（`evaluation`）と勝率（`equity`）が付く（2026/11/16〜）。
    プロンプトは「あなた/相手」と呼ぶ、ストリートごとに方針は1つ、ブラフのストーリーはブラフの時だけ、という形。
    端末側は `hand_state`（送った state）も相談履歴に保存し、分析ページはそれをハンド履歴と同じ見た目で描く
    （それより前の行は `hand_context` の生テキストを `parseLegacyHandContext` で読み取る）
  - **`temperature` を渡してはいけない**。GPT-5.6 はデフォルト(1.0)以外を拒否し
    400 BadRequest になる（top_p・penalty系も同様）。旧コードは 0.7 を渡していた
  - GPT-5.6 は推論モデルで**思考トークンも `max_completion_tokens` を消費する**ため
    上限を 1000→3000 に引き上げ済み。本文が空で返る場合に備えた分岐もある
- `GET /.well-known/assetlinks.json`
- 計算系・統計・サブスク・レンジの API は 2026/11/15 に削除（タグ `python-engine-final` に残っている）

### 端末側の状態
- user_id は端末の localStorage で生成・保持（`poker_user_id`）。アカウントは無い
- **ポジション表記は UTG**（6-max では LJ と同じ席）。レンジデータ（`ranges.json` の `position_ranges`）のキーだけ LJ。
  画面側で UTG から引けるようにしてある（`GameApi.preflopRanges`）。分析ページのポジション別は 2026/11/16 まで
  'LJ' で集計していたため UTG のハンドが常に0件だった（修正済み・旧 LJ 行も UTG に合算）
- 統計・ハンド履歴・AIコーチの相談履歴は IndexedDB（`static/poker/stats_store.js`）

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
- **`ranges.py` の RFI がコメント記載の%より大幅に狭かった**（2026/9/26 修正）。
  実測 LJ 6.8% / HJ 8.1% / CO 13.5% / BTN 25.9% / SB 28.1% しかなく、
  small pair・スーテッドコネクター・弱めのブロードウェイが丸ごと欠落していた。
  結果CPUのレンジが「強いハンドだけ」になり、ポストフロップのエクイティが
  実態より低く出て、**正しいコールが × と判定されていた**
  （例: A-T-4 で 77、必要勝率19.8%に対し実測8.5% → × / 正しくは約22%で ◯）。
  **レンジを触ったら必ず重み換算コンボ数/1326 で%を検算すること**
  （2026/9/27〜 データは `static/poker/ranges.json`。Python と JS の両方がこれを読む）:
  `sum(6 if len(c)==2 else (4 if c.endswith('s') else 12) for ...)`

## 課金（StoreKit 2）

- StoreKitManager.swift。購入成功で即 `isPremium=true`。Web 側は localStorage に保持し、
  起動時の `onEntitlementStatus` で上書きする（サーバーには持たない。2026/11/15〜）
- サンドボックス/審査で「復元」が確認される → `restore()` は必ず
  `AppStore.sync()` を先に呼ぶ実装になっている

## デプロイ / リリース手順

### Web（サーバー+JS）
1. 変更をコミットして `git push origin main`
2. Render が自動デプロイ（数分。無料/Starterプランでコールドスタートあり）
3. **静的アセットを変えたら必ずキャッシュバスティングの ?v= を上げる**
   現在値: `style.css?v=17`（v2 も同じ番号。v2 だけの tabs.css?v=10・v2/script.js?v=10） / `script.js?v=39` / `home.js?v=7` / `home.css?v=10` /
   `stats.css?v=8` / `stats.js?v=9` / `i18n.js?v=21` / `game_api.js?v=26`（index.html, home.html, stats.html 内）
   `static/poker/*.js` と `ranges.json` / `messages.json` は `game_api.js` の `POKER_JS_VERSION`（現在 24）で一括管理
   **i18n.js は3ページ全部で読み込んでいるので、上げるときは3ファイルとも直すこと**
4. 反映確認: `curl -s "https://poker-learner.onrender.com/static/script.js?v=NN" | grep 目印`

### iOS アプリ
- バージョンは pbxproj の `MARKETING_VERSION` / `CURRENT_PROJECT_VERSION`（2箇所ずつ）。
  **公開中: 1.0.7 (13)**（2026/9/27 shota 確認）。**pbxproj は次回提出用の 1.0.8 (14)**（レビュー依頼、alert/confirm の表示。2026/11/15 アーカイブ）
  （Organizer に残っている `1.0.8 (13)`(8/14) は誤って作った未提出のもの。使わない）
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

### 開発者モード（2026/11/21〜）
- 設定の見出し「設定」を7回続けて押す → コードを入力（コードは shota が持っている。script.js と static/v2/script.js には SHA-256 だけ）。localStorage の `poker_dev=1`。オンにすると新しい画面（/v2）が開く
- オンの間: AIコーチの回数制限なし・ハンド履歴のロック解除・各アクションの判定の解説・相手のポジション・AIコーチの回答を表示・「このハンドをコピー」
  （コピーしたテキストを貼ってもらえば、アプリの判定とコーチの食い違いをこちらで再現・検証できる）
- 判定の解説（actions の `reason`）と相手のポジション（sessions の `cpu_pos`）は、11/21 以降の全ユーザーの記録に保存している

### 動作確認のやり方
- **iPhone のアプリで push 前の版を見る**（2026/11/18〜）: Debug ビルドに `DEV_SERVER_URL` を渡すと、そのアプリは Mac のサーバーを表示する
  （ContentView.swift の `renderURL`。Release は常に本番。ATS はローカルネットワークだけ例外）:
  `xcodebuild -project PokerLearner/PokerLearner.xcodeproj -scheme PokerLearner -configuration Debug -destination "id=<端末のUDID>" DEV_SERVER_URL=http://<MacのIP>:8765/ -allowProvisioningUpdates build`
  → `xcrun devicectl device install app --device <devicectl の Identifier> <ビルドした .app>`。App Store 版を置き換える。**入れたビルドのバージョンが App Store の公開版より新しいと、App Store からは入れ直せない**（2026/11/19 に発生）。戻すときは `DEV_SERVER_URL` を渡さずに同じ手順でビルドして上から入れる（本番を表示。データは残る）。**アプリを削除すると端末内の統計が消える**ので削除しない。念のためのバックアップは `xcrun devicectl device copy from --device <Identifier> --domain-type appDataContainer --domain-identifier com.shota.pokerlearner --source Library --destination <保存先>`
- ロジックは `node tools/golden/check_js.js`、画面は `tools/e2e/local_engine.js`（Playwright）。
  サーバーは `OPENAI_API_KEY=dummy python3 -m uvicorn app:app --port 8765`（uvicorn は入っている）。
  `--host 0.0.0.0` で起動すれば同じ Wi-Fi の iPhone の Safari から `http://<MacのIP>:8765/play` で確認できる
- シミュレータ: `xcrun simctl install/launch --console-pty` でログ確認。
  起動直後は ATT ダイアログが出る（タップが必要）。DEBUG ビルドはテスト広告

## マーケティングの現状（2026/11/15 分析）

データは dev-dashboard の `data/kpi.db`（Sales + Analytics）。数字は直近の完了4週（10/12〜11/8）の目安。

| 段階 | 週あたり | 率 |
|---|---|---|
| インプレッション | 約1,300（7月までは週50前後） | — |
| 製品ページ閲覧 | 約50 | **タップ率 3〜4%**（7月までは約20%） |
| 新規DL | 約9 | 閲覧→DL 約18% |
| 新規サブスク | 0（7/13 以降なし。継続1名 518円/月） | — |

- **検索インプレッションの94%は日本**（10/12〜11/12: JP 5,435 / US 311）。英語版は US でタップ率1%・8週でDL1件 → 英語圏への投資は当面しない
- 律速は「検索結果でタップされない」こと。閲覧→DL（18%）は致命的ではないが、閲覧が週50と少なすぎて A/B テストできない
- 評価数 4件（★4.5）。1.0.8 のレビュー依頼で増やす
- アプリ名が「ポーカーラッシュ」だけで、検索結果で練習アプリだと伝わらない可能性。ジャンルは ゲーム/カード（サブにカジノ・教育）
- 方針（shota 未承認・提案段階）: 1.0.8 の提出時にアプリ名・サブタイトル・キーワード・スクショ1〜3枚目を練習アプリ寄りに変える
  → 2〜3週間タップ率を見る → 動かなければ製品ページの最適化（A/B テスト）でアイコンを試す
- 計測の穴: 端末計算に移ってから利用状況（継続率・プレイ量）がサーバーに無い。ASC Analytics の
  「App Sessions」「Installation and Deletion」レポートは既存リクエストで取れるはず（dev-dashboard に未取り込み）

## 未解決のタスク / 既知の課題

### v1.0.7 英語版リリース — 公開済み（2026/9/27 shota 確認）
アプリ 1.0.7 (13) は App Store で公開中。当時の App Store Connect 側の作業（米国配信・英語ローカライズ・
サブスク商品の英語表示・年齢制限・英語版規約）は、個別の完了状況までは確認していない。
気になったら App Store Connect で確認すること。

### 継続課題
7. **App Store Connect の「マーケティングURL」に `https://poker-learner.onrender.com`
   を設定**。AdMob の app-ads.txt 警告の解消に必要。
   app-ads.txt 自体はサーバー実装済み・配信確認済み
8. **AdMob 管理画面で UMP 同意フォームが未設定**（起動ログに毎回エラー。
   米国のみなら影響軽微だが、**EEA/英国に広げるなら必須**）
9. `verify_purchase` の実トークン検証（App Store Server API）
10. 広告表示率の改善効果を AdMob レポートで確認（v1.0.7 浸透後）
11. ~~WKWebView の `alert()` / `confirm()` がアプリ内で表示されない~~ → 1.0.8 (14) で修正
    （ContentView.swift の Coordinator に実装。シミュレータで alert と confirm の結果が JS に返ることを確認。1.0.7 以前は引き続き出ない）

## 作業時の注意（このプロジェクト固有）

- コミットメッセージは日本語。バージョンを上げたら `(vX.Y.Z)` を付ける習慣
- `poker_stats.db` / `trace*.txt` / `*.log` / スクリーンショット類はローカルの
  実行時生成物。**コミットに含めない**（git status に常に出るが無視）
- 評価ロジック（Evaluator）はポーカー文献と照合しながら細かく調整してきた経緯が
  ある（EQR・SPR・MDF・ブラフキャッチャー等）。安易に数値をいじらない。
  変更するときは git log の該当コミットの意図を確認する。ポストフロップは 2026/11/17 に postflop_ev.js へ置き換えた
  （evaluator.js の evaluateCall 等はプリフロップの経路だけで使っている）
- CPU戦略の仕様: プリフロップのオープンに対して CPU は フォールドなし
  （95%コール/5%3ベット）— 練習機会を最大化するための意図的な仕様。CPU が先に動くときも必ず参加する（SB は時々リンプ）
- **CPU は実際の手札で判断する**（2026/11/16〜）。手札はプリフロップで初めて必要になった時点で「その行動に合うレンジ」から引き、
  山札から抜く（＝その行動を取る手だけを配る条件付きの配布。ショーダウンで手を後から作ることはしない）。
  CPU の手札はハンド中に画面にもコーチにも出さないこと（`GameApi.coachState` はショーダウン後だけ送る）
- **レンジはコンボ単位でベイズ更新する**（2026/11/17〜。`static/poker/range_model.js`）。
  事後の重み ∝ 事前の重み × P(そのアクション | 手札)。P は `ActionModel.probs`（CPU の行動ルールそのもの）で、
  **CPU はこの確率で実際に行動し、あなたから見た CPU のレンジも同じ確率で更新する**ので、推定と実際が食い違わない。
  あなたのレンジも同じモデル（「普通に打つ人」）で更新し、CPU はそれに対する勝率で判断する。
  以前は「強さ順に並べて上位30%は残す・中間は0.15倍」の固定の削り方で、チェックでは更新もしていなかった。
  勝率は「ストリートごとの全1326コンボの順位表」（`RankTable`。リバー1通り・ターン全カード・フロップ80通り・プリフロップ60通りの
  固定ランアウト）から求めるので、同じ局面なら同じ値になる。1アクション約20ms（Node）
- **CPU の行動ルール**（`ActionModel.P` で調整）: バリュー（勝率が閾値以上）・ブラフ（役割とストリートごとの頻度）・
  被ベット時は「勝率×実現率 ≥ 必要勝率」でコール。さらに**防衛の下限**としてレンジの上位「MDF × 0.9」は降りない
  （MDF = ベット前のポット ÷ ベット後のポット。Chen & Ankenman『The Mathematics of Poker』）。
  これが無いと、あなたのベットレンジをバリュー寄りに見積もったときに降りすぎる（リバーの33%ベットに44%フォールドしていた）。
  3ベットへの対応は表（4ベット/コール）+ 値段（勝率×実現率 ≥ 必要勝率）+ 防衛の下限（MDF × 0.8）（`_vs3betProbs`）
- **判定は 6人卓の理論を優先し、直感に反するところは解説で補う**（2026/11/18 shota 指定）。このアプリは2人の勝負だが、
  「このゲームの仕組みならこうなる」ではなく実戦の6人卓の基準で判定する。例: SB はオープンに対して「3ベットかフォールド」
  （後ろの BB にスクイーズされ、ずっと OOP のため）。BB はすでに降りているが、判定はそのまま理論どおりにして、理由を解説に書く
- **HJ・CO・BTN のコールレンジもオープンした位置ごと**（2026/11/21〜。`tools/ranges/gen_ip_call.js`）: コールする割合は 6人卓 100bb の解析
  （beyondgto.com の Defense。HJ vs UTG 4% / CO vs UTG・HJ 5% / BTN vs UTG 7%・HJ 8%・CO 9%）に合わせ、どの手かは
  「オープンレンジに対する勝率 × IP の実現率」の高い順（3ベットの表の手は除く）。IP の実現率はスーテッドを 1 超え・オフスートは下げた目安。
  以前は3席とも共通の約6%。3ベットの表（解析では 7〜10%）は保留のまま（今の表は 2〜4%）。CPU が同じ席でコールするときも同じレンジ
- **BB のコールレンジはオープンした位置ごと**（`ranges.json` の `vs_open_call_vs_<位置>`。`tools/ranges/gen_blind_defend.js` で生成）。
  ポットオッズ × エクイティ実現率で作った（Janda『Applications of No-Limit Hold'em』の考え方）。以前の BB は全ハンドの約21%で位置にかかわらず共通だった。
  コール+3ベットで BB: UTG 29% / HJ 31% / CO 42% / SB 53%（BB が IP）/ BTN 57%。公開されている 6max 100bb の解析は BB vs BTN で 45〜70%。
  **SB にも同じ作りの `vs_open_call_vs_<位置>` があるが、CPU が SB でコールするとき（仕様で降りない）の手札と、あなたが SB でコールしたときの
  レンジ推定にだけ使う**。あなたの判定には使わない（evaluator.js の `preflopSpot`）
- **プリフロップの解説**（evaluator.js の `preflopSpot` / `preflopExplain`）: 1行目に「このハンドはこの場面で何をするハンドか」、
  混ぜるハンドは推奨の頻度、場面の考え方（後ろの人数・ポジション・必要勝率・相手のオープンの広さ・守る割合など、数字は ranges.json から計算）、
  ハンドの特徴。プリフロップのレイズはレンジ表で確定する（以前は表の中の 3ベットでも勝率で採点し直して × になることがあった）。
  BB が SB のリンプに対応する場面（チェック/レイズ）は専用の判定（以前はオープンの表やポストフロップの判定に回っていて、AA のレイズや 72o のチェックが × だった）。
  BB のリンプ対応の表は無いので、3ベットする強さの手を「レイズしたい手」とし、それ以外のレイズも ◯
- **分析ページの「プレイの傾向」**（2026/11/19〜。参加率・レイズ率の置き換え）: 6人卓の理論（推奨）と比べて、参加の広さ（タイト/ルース）と
  攻める回数（アグレッシブ/パッシブ）で4タイプに分ける。各アクションに「推奨ならどうしていたか」を `tendency` として記録し
  （game.js の `_tendency`。プリフロップはレンジ表の頻度、ポストフロップは最善手、◎ の手は推奨どおり扱い）、`StatsCalc.getPlayStyle` で集計。
  各軸 30 判断から表示。11/19 より前の記録には無いので数えない
- **ポストフロップの解説**（postflop_ev.js の `explain`）: 判定・勝率に加えて「考え方」の1文（バリュー / ブラフ / ポットを守る / ポットを小さく /
  降りすぎ（MDF）/ コールしすぎ / サイズ / オールイン）。判定を緩めたことで記号が変わったときだけ、緩めたことを書く
- 実測の目安（2026/11/17、`tools/audit/cpu_stats.js`）: CPU のフォールド率 33%ベットに 10〜27% / 55〜85%に 22〜41% / ポット以上に 37〜47%
  （理論上の上限 = 1 − 0.9×MDF の範囲内）、フロップのチェックレイズ 6% / ターン 8%、ドンク 12〜14%、Cベット IP 54% / OOP 44%、
  3ベットへのフォールド 30〜47%（アプリの 3ベットは 2.2〜3倍と小さめなので、理論上もこの程度守る）、ショーダウン率 35%。
  フロップ時点の SPR 中央値 16（3ベットポット 7）。100bb は標準的な深さで変える必要なし（2026/11/16 確認）
- Web は素の JS（フレームワークなし）。既存のコードスタイル（グローバル関数 +
  onclick 属性 + el() ヘルパー）に合わせる
