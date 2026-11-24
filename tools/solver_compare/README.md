# Poker Rush の判定・CPU と GTO ソルバー（GTOpen）の比較（2026/11/24〜）

アプリのコードは変えずに読み込んで呼ぶだけ。判定の「正しさ」を、ソルバーの均衡（相手も GTO）と比べて測る。
`tools/audit/`（アプリの CPU 相手のロールアウト）とは測っているものが違う: こちらは理論との差、audit はアプリの CPU 相手の損得。

## 準備: GTOpen（Apache-2.0）
```
git clone https://github.com/MatthewPDingle/GTOpen.git ~/Projects/gtopen   # 2026/11/24 時点 v1.7.1（commit cb52f9a68）
cd ~/Projects/gtopen && cargo build --release && PORT=3737 ./target/release/gto-server
```
厳密な2人のポストフロップ DCFR。EV の単位はアプリと同じ（ポットの取り分から今後の支払いを引く）ので差をそのまま比べられる。
サーバーは1つの局面しか持てないので、solve_* を同時に2本走らせないこと。

## 何を比べるか（比べられる局面だけ）
- **あなたが OOP で、そのストリートの最初の判断**だけ。ソルバーはストリートの始まりから解くので、レンジ・ポット・スタックが両者で完全に一致する。
  途中のノードは、ソルバーの均衡のレンジとアプリの推定レンジがずれるので比べない（比べると「相手レンジが違う比較」になる）
- プリフロップ・3人以上は対象外。今はリバーだけ（ターンは後のストリートまで木に入るので遅い）
- 木: あなたはアプリのボタン（リバー 33/75/150%、レイズ 2.5倍・3.5倍・ポット）、CPU は行動モデルのサイズ（リバー 75/100%、レイズ 3倍）
- 混合戦略は1つの正解にしない（Action Match = アプリの推奨を GTO が取る頻度）。最重要は EV Loss（ソルバー上の最善との差）
- アプリが理論の方針として決めている扱い（ドンクの場面はチェックが基準）は `donkRule` で分けて見る

## 判定の比較
```
node tools/solver_compare/export_spots.js static/poker <seed> <ハンド数> s<seed>.jsonl [RIVER]   # 8本並列、1500ハンドで約120局面
node tools/solver_compare/solve_spots.js all.jsonl res.jsonl          # リバー1局面 約0.2秒
node tools/solver_compare/analyze.js all.jsonl res.jsonl out/          # summary.md / spots.csv / options.csv
```

## CPU の打ち方の校正（あなたがチェックした後の CPU）
```
CALIB=1 node tools/solver_compare/export_spots.js static/poker <seed> 800 s<seed>.jsonl
node tools/solver_compare/solve_calib.js all.jsonl res.jsonl      # あなたのレイズは 3倍だけの木
node tools/solver_compare/calib_analyze.js all.jsonl res.jsonl
```
CPU のレンジの手を強さの順位で10段に分け、段ごとに各サイズで打つ頻度と、あなたの3倍のチェックレイズに降りる確率をアプリと GTO で並べる。
CPU の係数（range_model.js の `ActionModel.P`）を変えたら、これで「自然な割合」から外れていないか確かめる。

## 2026/11/25 の結果（リバー約1,000局面）
| | EV損失 平均 | 重大(>7%) | Action Match | 強い手のチェックしすぎ |
|---|---|---|---|---|
| CPU を直す前 | ポットの2.4% | 9.9% | 52% | 58% |
| 直した後 | 2.1% | 7.9% | 57% | 40% |

直したのは CPU のリバーのサイズの選び方（サイズで強さが分かった）と、レイズに対する防衛の下限の計算（CLAUDE.md 参照）。
