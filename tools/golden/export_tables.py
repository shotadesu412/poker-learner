"""treys のルックアップテーブルを JS から使える形で書き出す。

treys は Cactus Kev のアルゴリズムを使っており、テーブルは
  flush_lookup   : 素数積 -> スコア（フラッシュ用、1,287エントリ）
  unsuited_lookup: 素数積 -> スコア（それ以外、6,175エントリ）
の2枚だけ。これをそのまま JS のオブジェクトにすれば同一の評価ができる。

ビルド工程が無い構成なので、fetch ではなく <script> で読める .js として出力する。
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from treys import Evaluator  # noqa: E402
from treys.lookup import LookupTable  # noqa: E402

OUT = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
    "static", "poker", "hand_table.js")


def main():
    t = Evaluator().table
    flush = {int(k): int(v) for k, v in t.flush_lookup.items()}
    unsuited = {int(k): int(v) for k, v in t.unsuited_lookup.items()}

    # 役クラスの境界値も一緒に出す（get_rank_class 相当をJSで再現するため）
    boundaries = {
        "MAX_ROYAL_FLUSH": LookupTable.MAX_ROYAL_FLUSH,
        "MAX_STRAIGHT_FLUSH": LookupTable.MAX_STRAIGHT_FLUSH,
        "MAX_FOUR_OF_A_KIND": LookupTable.MAX_FOUR_OF_A_KIND,
        "MAX_FULL_HOUSE": LookupTable.MAX_FULL_HOUSE,
        "MAX_FLUSH": LookupTable.MAX_FLUSH,
        "MAX_STRAIGHT": LookupTable.MAX_STRAIGHT,
        "MAX_THREE_OF_A_KIND": LookupTable.MAX_THREE_OF_A_KIND,
        "MAX_TWO_PAIR": LookupTable.MAX_TWO_PAIR,
        "MAX_PAIR": LookupTable.MAX_PAIR,
        "MAX_HIGH_CARD": LookupTable.MAX_HIGH_CARD,
    }
    rank_class = {str(k): int(v) for k, v in LookupTable.MAX_TO_RANK_CLASS.items()}
    class_names = {str(k): v for k, v in LookupTable.RANK_CLASS_TO_STRING.items()}

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    body = (
        "// 自動生成ファイル — 直接編集しないこと。\n"
        "// 生成: python3 tools/golden/export_tables.py\n"
        "// treys のルックアップテーブル（Cactus Kev アルゴリズム）をそのまま写したもの。\n"
        "// Python 側と完全に同じスコアを返すことが前提なので、値を手で変えてはいけない。\n"
        "const HAND_TABLE = {\n"
        f"  flush: {json.dumps(flush, separators=(',', ':'))},\n"
        f"  unsuited: {json.dumps(unsuited, separators=(',', ':'))},\n"
        f"  boundaries: {json.dumps(boundaries, separators=(',', ':'))},\n"
        f"  rankClass: {json.dumps(rank_class, separators=(',', ':'))},\n"
        f"  classNames: {json.dumps(class_names, separators=(',', ':'))}\n"
        "};\n"
        "if (typeof module !== 'undefined') module.exports = HAND_TABLE;\n"
    )
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(body)

    print(f"  flush_lookup    : {len(flush):,} エントリ")
    print(f"  unsuited_lookup : {len(unsuited):,} エントリ")
    print(f"  書き出し        : {OUT}")
    print(f"  サイズ          : {len(body)/1024:.0f} KB")


if __name__ == "__main__":
    main()
