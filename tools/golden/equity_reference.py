"""モンテカルロ・エクイティの参照値（JS 版の統計的な一致検証用）。

乱数列が Python と JS で違うため、エクイティは1件ずつは一致しない。
代わりに Python で試行回数を多めに回した値を参照値として固定し、
JS 側（tools/golden/check_js.js）で「誤差の範囲に収まるか」を検定する。

    python3 tools/golden/equity_reference.py          # 生成（エクイティ計算を意図的に変えた時だけ）
    python3 tools/golden/equity_reference.py --check  # 再現確認（シード固定なので同じ値になる）

generate.py と分けているのは時間がかかるため（1〜2分）。
"""
import argparse
import json
import os
import random
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from treys import Card, Evaluator as TE  # noqa: E402
import ranges  # noqa: E402
from equity import EquityCalculator  # noqa: E402

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vectors", "equity_reference.json")
N = 20000  # Python 側の試行回数（標準誤差 約0.0035）

RANKS = "AKQJT98765432"
HERO_HANDS = ["AsKs", "QhQd", "7c7d", "JsTs", "Ah5h", "9c8d", "KdJc", "2s2h", "AcQd", "6h5h"]
RANGE_PAIRS = [  # (ヒーローのレンジ, CPU のレンジ)
    (("BTN", "open"), ("BB", "vs_open_call")),
    (("CO", "open"), ("SB", "vs_open_call")),
    (("LJ", "open"), ("BTN", "vs_open_call")),
    (("BB", "vs_open_call"), ("BTN", "open")),
    (("HJ", "3bet"), ("CO", "vs_3bet_call")),
]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    args = ap.parse_args()

    rng = random.Random(20260927)
    te = TE()
    full = [r + s for r in RANKS for s in "shdc"]
    spots = []
    for i in range(40):
        hero = HERO_HANDS[i % len(HERO_HANDS)]
        hero_str = [hero[:2], hero[2:]]
        board_n = [0, 3, 4, 5][i % 4]
        board_str = rng.sample([c for c in full if c not in hero_str], board_n)
        (hp, ha), (cp, ca) = RANGE_PAIRS[i % len(RANGE_PAIRS)]
        hero_range = dict(ranges.get_range_by_category(hp, ha))
        cpu_range = dict(ranges.get_range_by_category(cp, ca))
        board = [Card.new(c) for c in board_str]
        # ポストフロップの半分は、実戦と同じく絞り込み済みのレンジで計算する
        narrowed = []
        if board_n and i % 2 == 1:
            kind = ["CALL", "LARGE_BET", "SMALL_BET"][i % 3]
            cpu_range = ranges.update_range_after_action(cpu_range, kind, 5.0, board, te)
            narrowed.append(kind)
        hero_cards = [Card.new(c) for c in hero_str]

        random.seed(1000 + i)
        eq, _ = EquityCalculator.calc_equity_monte_carlo(
            hero_cards, board, hero_range, cpu_range, iterations=N)
        random.seed(5000 + i)
        adv = EquityCalculator.calc_range_advantage(
            hero_cards, board, hero_range, cpu_range, iterations=N)
        spots.append({
            "hero": hero_str, "board": board_str,
            "hero_range": [[k, v] for k, v in hero_range.items()],
            "cpu_range": [[k, v] for k, v in cpu_range.items()],
            "label": f"{hp}/{ha} vs {cp}/{ca}" + (f" →{narrowed[0]}" if narrowed else ""),
            "equity": eq, "range_adv": adv,
        })
        print(f"  {i:2d} {hero} [{' '.join(board_str):14s}] eq={eq:.4f} adv={adv:.4f}  {spots[-1]['label']}")

    # equity_vs_calling_range（ベット評価の軸）: コールレンジへの絞り込み + モンテカルロの組み合わせ
    from poker_engine import Evaluator
    called = []
    for i, sp in enumerate(s for s in spots if s["board"]):
        hero_cards = [Card.new(c) for c in sp["hero"]]
        board = [Card.new(c) for c in sp["board"]]
        bet = [2.0, 4.0, 8.0][i % 3]
        random.seed(9000 + i)
        eq = Evaluator.equity_vs_calling_range(hero_cards, board, dict(sp["hero_range"]), dict(sp["cpu_range"]),
                                              bet, 8.0, iterations=N)
        called.append({"spot": spots.index(sp), "bet": bet, "eq_called": eq})
    # None になる条件（レンジ情報が無い・全コンボの重みが0）
    none_cases = []
    ak, flop = [Card.new("As"), Card.new("Kd")], [Card.new(c) for c in ("Qh", "7c", "2d")]
    for label, call_args in [
        ("no_board", ([Card.new("As"), Card.new("Kd")], [], {"AA": 1.0}, {"KK": 1.0})),
        ("no_cards", ([], flop, {"AA": 1.0}, {"KK": 1.0})),
        ("no_hero_range", (ak, flop, {}, {"KK": 1.0})),
        ("no_cpu_range", (ak, flop, {"AA": 1.0}, {})),
        ("all_zero", (ak, flop, {"AA": 1.0}, {"KK": 0.0, "QQ": 0.0})),
    ]:
        none_cases.append({"label": label, "result": Evaluator.equity_vs_calling_range(*call_args, 4.0, 8.0, iterations=50)})
    print("  eq_called:", [round(c["eq_called"], 4) for c in called])
    print("  none_cases:", none_cases)

    data = {"iterations": N, "spots": spots, "eq_called": called, "none_cases": none_cases}
    text = json.dumps(data, ensure_ascii=False, indent=1)
    if args.check:
        old = open(OUT, encoding="utf-8").read() if os.path.exists(OUT) else ""
        print("  OK 再現一致" if old == text else "  NG 差分あり")
        sys.exit(0 if old == text else 1)
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(text)
    print(f"  書き出し {len(spots)} 局面 / {len(text) / 1024:.0f} KB")


if __name__ == "__main__":
    main()
