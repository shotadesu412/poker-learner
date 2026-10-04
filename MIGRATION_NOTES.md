# 移植メモ（JS移植中に気づいたこと）

サーバーを「AIコーチ専念」構成にするための JS 移植作業中のメモ。

**運用ルール**
- 影響範囲が小さい改善は、気づいた時点で直してコミットする（ここには残さない）
- 影響範囲が大きいものは、ここに書くだけにして本筋を止めない。移植が一段落してから判断する

---

## バックアップ

移植前の Python 実装は git タグ `python-engine-v1` で固定済み。

```bash
git show python-engine-v1:poker_engine.py       # 単一ファイルを見る
git worktree add /tmp/engine-v1 python-engine-v1 # 丸ごと展開して比較
```

Python のファイル自体はフェーズ7まで削除しない。並行稼働で比較するため。

---

## 後で判断する改善点

<!-- 形式:
### タイトル
- 気づいた場所:
- 内容:
- 影響範囲:
- 対応案:
-->

### estimate_fold_equity が相手レンジを見ていない

- 気づいた場所: `poker_engine.py` `estimate_fold_equity`
- 内容: フォールドエクイティが `0.40 + 0.30*(bet/pot)` とベットサイズとボードテクスチャだけで決まり、
  相手のレンジもヒーローのハンドも見ていない。評価の判定軸からは外したので実害は減ったが、
  `ev` の数値自体はまだこのモデルに依存しており、統計ページの「平均損失(bb)」の精度に影響する。
- 影響範囲: **大**（全アクションの ev_loss が変わる → 統計の数値が全部動く）
- 対応案: 相手の継続レンジの割合から FE を推定する。移植後に JS 側で実装するのが自然。

### ev_check = equity * pot が将来ストリートを無視している

- 気づいた場所: `ev_calculator.py` `ev_check`
- 内容: チェックしたらハンドが終わる前提の近似。実際は後のストリートが続くので過小評価。
  判定軸からは外したが `ev` には残っている。上の FE の件とセットで見直すのが筋。
- 影響範囲: **大**（同上）
- 対応案: FE の見直しと同時に。

### 使われていないファイル・データ

- 気づいた場所: `ranges.py` の `hand_categories`、ルートの `patch_ranges.py`（Windows パス直書きの
  使い捨てスクリプト）、`test_ranges.py`（print するだけ）
- 内容: どこからも参照されていない。
- 影響範囲: 小
- 対応案: JS へは移さない。フェーズ7で Python と一緒に消す。

### 旧 sample_range が残っている

- 気づいた場所: `range_utils.py`
- 内容: `build_sampler` / `sample_from` に置き換えたが、旧 `sample_range` を互換のため残してある。
  現在どこからも呼ばれていないなら削除してよい。
- 影響範囲: 小（未使用なら削除するだけ）
- 対応案: 移植時に JS 側へは移さない。Python 側もフェーズ7で消す。

### プリフロップ評価がベットサイズを見ていない

- 気づいた場所: `poker_engine.py` `evaluate_preflop_action_gto`
- 内容: `facing_bet` を「0か否か」でしか使っておらず、2.2bb オープンと 10bb オープンで
  同じ評価になる。CPU のオープンは 2.2〜2.5bb 固定なので現状の実害は小さい。
- 影響範囲: 中（プリフロップ評価が変わる）
- 対応案: 移植を機にポットオッズを考慮する形にするか、現状維持のまま移すか要判断。
  **移植では「今の挙動をそのまま再現する」ことを優先し、改善は移植後に行う。**

---

## ゴールデンテストベクタ（フェーズ0）

`tools/golden/vectors/*.json` に現在の挙動を固定。

```bash
python3 tools/golden/generate.py          # 生成（挙動を意図的に変えた時だけ）
python3 tools/golden/generate.py --check  # 回帰テスト（差分があれば exit 1）
```

| ファイル | 件数 | 内容 |
|---|---|---|
| pure_functions | 502 | EQR・必要勝率・MDF・EV・テクスチャ・ハンド分類・サイジング |
| preflop | 8,112 | 169コンボ × 6ポジション × アクション × 3bet有無 |
| postflop | 11,550 | コール/フォールド判定（エクイティは固定値を注入） |
| bet_raise_check | 12,936 | ベット/レイズ/チェックの分岐ロジック |
| ranges | 49 | レンジデータそのもの |
| hand_evaluator | 3,000 | treys の7枚評価の参照値 |

**設計上の要点**: ベット/レイズ/チェックは内部でモンテカルロを呼ぶため、
`equity_vs_calling_range` の戻り値を固定値に差し替えて分岐ロジックだけを
決定的に取り出している。これにより Python の回帰テストとして機能し、
かつ JS 移植後も同じ入力で同じ出力になるはずなのでそのまま流用できる。
モンテカルロ自体の一致は別途、統計的に検証する。

**検証済み**: 以下4種の意図的な改悪をすべて検出できることを確認済み。
  - 閾値の微修正 (BET_VALUE_THRESHOLD 0.60 -> 0.61) → bet_raise_check
  - ドンクベット上限処理の削除 → bet_raise_check
  - リバーのドローガード削除 → pure_functions, postflop
  - レンジから1コンボ削除 → preflop, ranges

---

## フェーズ1: ハンド評価器（完了 2026/9/27）

- `static/poker/hand_table.js` … treys のルックアップテーブル（自動生成・102KB）。
  再生成: `python3 tools/golden/export_tables.py`
- `static/poker/hand_eval.js` … `Card`（treys と同じ32bit整数表現）と `HandEvaluator`
  （`evaluate` / `getRankClass` / `classToString`）
- 検証: ゴールデン3,000件一致 + 全5枚組 2,598,960通りを Python と総当たり比較して不一致0件
- 速度: Node で約145万回/秒（7枚評価）。Python treys の約22倍。
  7枚評価は21通りの5枚組総当たりのまま（treys と同じ）。フェーズ3で遅ければ最適化を検討
- まだどの HTML からも読み込んでいない（フェーズ5で読み込む）。キャッシュバスティング不要

## フェーズ2: レンジデータ（完了 2026/9/27）

- データ本体を `static/poker/ranges.json` に移し、`ranges.py` はそれを読むだけにした。
  `RANGES` 内の `"position_ranges.LJ"` のような文字列は参照で、ローダーが同じオブジェクトに解決する
  （旧コードの `position_ranges.get("LJ")` による共有と同じ構造）
- `static/poker/ranges.js` … `Ranges.getRangeByCategory` / `parseCombo` / `classifyRange` /
  `getPossibleHoleCardsWeighted`。ブラウザは `await Ranges.load()`、Node は require 時に読み込み済み
- **⚠️ JS ではレンジを Object ではなく Map で持つ**。Object は "22"〜"99" のような整数っぽいキーを
  先頭に並べ替えてしまい Python と反復順がずれる。`update_range_after_action` は同点コンボの順位を
  反復順で決めるので、順序も挙動の一部。素の JSON.parse にすると `range_order` が 28件 NG になることを確認済み
- 検証: 旧 ranges.py と値・int/float の型・キー順・オブジェクト共有構造まで一致 / Python 回帰テスト全件一致 /
  新ベクタ `range_order`（反復順・parse_combo・重み付きコンボ展開）を追加し JS で一致 /
  TestClient で12ハンド回して正常動作
- **未移植（後のフェーズで）**:
  - `sort_range_by_strength` / `update_range_after_action` → フェーズ3（`range_utils.py` と一緒に。エクイティ計算の前段なので）
  - `get_hand_reason` / `get_preflop_feedback` → フェーズ4（サーバー側 i18n の文言キーを JS へ移す必要があるため）

## フェーズ3: エクイティ計算（完了 2026/9/27）

- `static/poker/range_utils.js` … `buildSampler` / `sampleFrom` / `pickIndex`（bisect_left 相当）
- `static/poker/ranges.js` に `sortRangeByStrength` / `updateRangeAfterAction` を追加
- `static/poker/equity.js` … `calcEquityMonteCarlo` / `calcRangeAdvantage`。
  乱数関数 `rng` を引数で差し替え可能（テストでシード付き乱数を使えるように）
- 未使用のため移していないもの: `calculate_preflop_score` 系、`calculate_preflop_equity_approx`、
  `sample_range`、`filter_range_by_action`、`normalize_range`（フェーズ7で Python ごと消す）

### 検証
- **決定的な部分は完全一致**（新ベクタ `range_update`）: レンジ絞り込み240回（連続適用含む、順序込み）、
  サンプラーの展開と累積重み、二分探索の位置。「同点の並びを逆にする」改変で60件 NG になることを確認済み
- **モンテカルロは統計検定**（新ベクタ `equity_reference`、別スクリプト `tools/golden/equity_reference.py`）:
  Python 2万回 × 40局面 × 2種（equity / range_adv）を参照値とし、JS 5万回で |z|<4 と系統的偏り Σz/√n<4 を確認。
  以下3種の移植ミスをすべて検出できることを確認済み（z = 10〜35）:
  - 引き分けを勝ちとして数える
  - 相手の手札を山札から除かずにボードを配る
  - レンジの重みを無視して均等に引く
- 速度: JS 1000回で 2〜7ms（Python は約47ms）

### メモ
- `update_range_after_action` は `CHECK` を渡されると重みはそのままで「強い順に並べ替わる」だけになる。
  エンジンは CHECK では呼ばないので実害なし。挙動としては JS でも同じにしてある

## フェーズ4: 評価ロジック（完了 2026/9/27）

### 追加したファイル（すべて `static/poker/`）
| ファイル | 元の Python |
|---|---|
| `pyfmt.js` | Python の `format(x, ".1f")` / `round(x, n)`（偶数丸め）の再現 |
| `messages.js` + `messages.json` | `i18n.py` の `t()`（評価系の文言だけ共有 JSON に移した） |
| `ev_calculator.js` | `ev_calculator.py` |
| `hand_classifier.js` | `hand_classifier.py` |
| `bet_sizing.js` | `bet_sizing.py` |
| `evaluator.js` | `poker_engine.py` の `Evaluator` |
| `ranges.js` に追加 | `get_hand_reason` / `get_preflop_feedback` |

### 検証
- **新ベクタ `evaluator_full`**: 評価関数の戻り値を全フィールド（ev・req_eq・realized_eq・mdf・解説文 ja/en）で固定。
  浮動小数点は丸めずに保存し JS 側は `===` で比較 → **ビット単位で一致**。
  プリフロップは全組み合わせ（169×7ポジション×3bet有無×4アクション×facing 2種）、
  ポストフロップはシード固定の乱数で 12,000件、内部部品（EQR・PI・分類・ドロー・テクスチャ・サイジング）3,000件
- 既存の preflop / postflop / bet_raise_check / pure_functions も全件一致
- `equity_vs_calling_range` は `equity_reference` に参照値を追加して統計検定（None になる5条件は完全一致）
- **意図的な移植ミス7種をすべて検出**（toFixed の丸め / 式の代数的整理 / 閾値0.60→0.61 /
  dict.get の代わりに get_range_by_category / board=[] の扱い / IP 判定に SB / ドロー判定 cnt>=4）。
  うち4種は既存ベクタでは見逃していて、evaluator_full でしか捕まらなかった
- JS のモンテカルロ検定はシード付き乱数にして、毎回同じ結果になるようにした（たまに落ちるテストを防ぐ）

### 移植で気づいた Python 側の罠（挙動はそのまま再現している）
- **`Evaluator` に `calculate_mdf` / `calculate_alpha` が2回定義されている**（103行目と260行目）。
  Python は後の定義が有効なので、JS もそちら（`max(pot, 1e-9)` 付き）に合わせた。
  実際の入力（ベット前ポット > 0）では両者の結果は同じなので実害はない。フェーズ7で片方を消す
- `evaluate_preflop_action_gto` は `get_range_by_category` ではなく `RANGES` を直接 `dict.get` している。
  そのため SB の `vs_open_call` は空のまま（call ∪ 3bet の合成が効かない）。JS も `getOr` で同じにした
  → 2026/9/27 確認: SB は「3ベットかフォールド」の戦略で意図的に空。評価としてはこれで正しい（SB のコールは
  レンジ外扱い）。合成版はエンジンが CPU の継続レンジ（MC 用）に使うためのもので、評価側とは別物。問題なし
- `evaluate_call` の `hero_range_dict` 引数は未使用

### 次（フェーズ5）へのメモ
- `PokerEngine` には `classify_board_texture` / `calculate_theoretical_bluff_frequency` など
  Evaluator・HandClassifier と同名の独自実装がある。混同しないこと

## フェーズ5: エンジン・CPU AI・ゲーム進行（完了 2026/9/27、画面は未接続）

### 追加したファイル（`static/poker/`）
| ファイル | 元の Python |
|---|---|
| `rng.js` | 乱数。`Rng.real()`（本番, Box-Muller）/ `Rng.seeded(seed)`（テスト, fake_random.py と同一） |
| `engine.js` | `poker_engine.py` の `PokerEngine`（配布・ポジション・ベット処理・CPU AI・ショーダウン手の生成） |
| `game.js` | `app.py` の `/api/start_hand`・`/api/action`・`/api/state`・`get_game_state`。戻り値はサーバーの JSON と同じ形 |

### 検証: 乱数テープ方式
- Python の `random` モジュールと treys の `Deck.shuffle` を `tools/golden/fake_random.py` に差し替え、
  実際の API を TestClient で叩いて 40ゲーム×5ハンドを最後までプレイ（`tools/golden/game_tape.py`）
- JS は同じシードで同じ操作を再生し、**レスポンスの JSON 全体・統計の保存呼び出し・乱数の消費数まで全件一致**
  （エクイティの値もビット一致）。ヒーローの行動はアプリのプリセット額（script.js）に合わせ、
  境界値（プリフロップ合計 5.0bb）とオールインも混ぜている
- テープ比較が実際に捕まえたバグ: 評価ロジック内のモンテカルロ（equity_vs_calling_range）が
  エンジンと別の乱数を使っていた → `Evaluator.rng` をゲームがエンジンの乱数に差し替える形に修正
- 意図的な移植ミス7種をすべて検出（短絡評価をやめて乱数を先に読む / 山札の先頭から引く /
  レンジ更新の境界 / 標準オープン判定の境界 / レンジ圧縮の境界 / "3.0bb" を "3bb" と表示 / 乱数の系統を分ける）
- 本番用の乱数でも 400ハンド回して例外 0件、CPU の行動頻度は全21項目で Python と誤差内（最大|z|=1.85）
- 速度: 1ハンド約17ms（Node、数アクション込み）

### 次（フェーズ6）でやること・注意
- 画面（script.js）はまだサーバー API を呼んでいる。`PokerGame` に切り替えるときは:
  - 統計の保存フック（startSession / logAction / finishHand）を IndexedDB に繋ぐ
  - **フラグで切り替えられるようにし、段階的に移行する**（例: localStorage か ?engine=local）
  - 読み込み順: rng → hand_table → hand_eval → pyfmt → messages → ranges → range_utils → equity →
    ev_calculator → hand_classifier → bet_sizing → evaluator → engine → game（`Ranges.load()` と
    `Messages.load()` を await してから開始）
- **AIコーチ（/api/ai_coach）はサーバーのエンジン状態から相談内容を作っている**。
  端末でエンジンを動かすと、サーバーには状態が無くなる → 端末から状態（ポジション・スタック・ボード・
  ハンド・アクション履歴）を送る形に変える必要がある（フェーズ7）
- `heroRangeRaw` / `cpuRangeRaw` は JS では Object に変換して返している。JS の Object は "22" 等の
  キーを先頭に並べ替えるが、画面は表示にしか使っていないので順序は影響しない（接続時に確認すること）

## フェーズ6: 統計を IndexedDB へ + 画面を JS エンジンに接続（完了 2026/9/27、既定はサーバー計算のまま）

### 切り替え方
- **既定は端末計算（2026/10/4〜。フェーズ7-1）**。それまではサーバー計算が既定だった
- URL に `?engine=server` を付けると `localStorage.poker_engine` に保存され、以後その端末はサーバー計算。
  `?engine=local` で戻る。切り替え口は `static/game_api.js`（`GameApi` / `StatsApi`）1か所だけ
- 計算系 API と永続ディスクの削除は 2026/11/4 以降（shota 決定「両方1か月」）
- 端末計算の準備（モジュール読み込み等）に失敗したら自動でサーバー計算に戻る
- 端末モードのモジュールは端末モードのときだけ動的に読み込む（サーバーモードの通信量は増えない）。
  `static/poker/` を変えたら `game_api.js` の `POKER_JS_VERSION` を上げること

### 追加したもの
| ファイル | 内容 |
|---|---|
| `static/poker/stats_calc.js` | `stats_logger.py` の集計（get_*）。IndexedDB に依存しない純関数 |
| `static/poker/stats_store.js` | IndexedDB（DB名 `poker_learner`）。actions / sessions / saved_hands / meta。行の形は SQLite と同じ |
| `static/game_api.js` | サーバー/端末の切り替え口。戻り値はどちらもサーバーの JSON と同じ形 |
| `stats_logger.export_user_data` + `GET /api/stats/export` | 端末モード初回にサーバーの統計を取り込む（読み取りのみ） |
| `/api/ai_coach` の任意項目 `state` | 端末モードではハンド状態を送る。無ければ従来どおり（旧JS互換）。プロンプトはサーバーで組み立てる |
| `tools/golden/stats_vectors.py` | 集計のベクタ（`stats_calc.json`） |
| `tools/e2e/local_engine.js` | WebKit（Playwright）での通し確認 |

### 検証
- **集計**: テープの実データを偽の時計で60日に散らして本物の stats_logger で保存し、全集計（ja/en × 期間4種 ×
  now 4種: 通常・小数部なし・30日/7日の境界ちょうど）を記録 → JS で 115件ビット一致。
  意図的な移植ミス5種を検出（境界 >=、3ベット判定、時刻書式、リークの評価の選び方、action_log 無視）。
  AVG を単純加算にする改変は小数3桁に丸めるため出力が変わらず検出されない（実害なし）
- **IndexedDB**: fake-indexeddb で取り込み→集計がベクタと一致 / 2回目の取り込みはスキップ / 実プレイの保存が件数・順序とも正しい
- **AIコーチ**: サーバーモードのプロンプト292件が改修前と完全一致 / state 経由のプロンプトもサーバーエンジン経由と89件一致 /
  上限超え（history 81件・board 6枚）は 422
- **画面（WebKit）**: サーバーモードで遊ぶ → 端末モードへ（取り込み）→ 25アクション中 start_hand/action/state を一度も呼ばない →
  AIコーチに state が送られサーバーが受理 → 分析ページが IndexedDB から集計（統計 API を呼ばない）→ サーバーモードに戻せる。例外 0件

### SQLite の再現で気づいたこと
- GROUP BY の非集計列（リークの evaluation）は SQLite 3.51 では**グループ内の最初の行**（id 順）。JS もそれに合わせた
- SQLite 3.43+ の AVG は補償付き加算（Kahan-Babuska-Neumaier）。JS も同じ式にしてある
- 時刻は Python の isoformat と同じ文字列（小数部が 0 なら省略）で持ち、期間は文字列比較

### ついでに直した既存バグ（サーバー、本番で発生中だった）
- 分析ページ「直近1セッション」で personal_range が `ambiguous column name` の 500 → Promise.all でポジション別・リーク・
  履歴もまとめて表示されなかった
- 同じく「直近1セッション」の抽出がユーザーで絞られておらず、全ユーザー中の最新ハンドを見ていた

### 既知の制限（端末モード）
- **ハンドの途中でページを離れると、そのハンドは消える**（エンジンはメモリにしか無い。再表示で新しいハンドから）。
  → **許容する（2026/9/27 shota 判断）**。復元の仕組みは作らない
- IndexedDB は端末ローカル。アプリ削除で統計も消える（サーバー時代は user_id が同じなら残っていたが、
  user_id 自体が localStorage なので実質同じ）
- `/api/preflop_ranges` と課金系 API はまだサーバーを呼んでいる（フェーズ7で整理）

### 次（フェーズ7）へのメモ
- 既定を端末モードにするのは**アプリの審査通過後**。まず自分の端末で `?engine=local` を付けて数日使う
- サーバー縮小時に消すもの: /api/start_hand・/api/action・/api/state・/api/stats/*（export は取り込み期間中は残す）、
  Python の計算系ファイル、Render の永続ディスク（export を残す期間との兼ね合いに注意）

## 様子見期間（2026/9/27〜）
- 本番に push 済み。shota の実機で端末計算 ON（設定シート最下部を7回タップ）。「計算クソ早くなった」
- WebKit での本番確認: 既定モードはサーバー API、端末モードは start_hand/action/state を呼ばない、例外 0件
- 次はフェーズ7（CLAUDE.md「現在の状態と次の一手」参照）
