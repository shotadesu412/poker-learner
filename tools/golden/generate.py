"""ゴールデンテストベクタ生成器。

現在の Python 実装の挙動を「正解」として固定し、JSON として書き出す。
JS へ移植したあと、同じ入力で同じ出力になることを機械的に検証するために使う。

重要な方針:
  - モンテカルロを使う関数は乱数で揺れるため、**エクイティは入力として固定値を与える**。
    こうすると Evaluator の判定ロジックだけを決定的に検証できる。
    エクイティ計算そのものの検証は別ファイル（統計的一致で判定）に分ける。
  - 「今の挙動をそのまま再現する」ことが目的なので、ここで正しさの判断はしない。
    評価ロジックの改善は移植が終わってから行う。

使い方:
    python3 tools/golden/generate.py            # 生成して tools/golden/vectors/ に書き出す
    python3 tools/golden/generate.py --check    # 既存ファイルと差分がないか確認（回帰テスト）
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from treys import Card  # noqa: E402
import i18n  # noqa: E402
import ranges  # noqa: E402
from poker_engine import Evaluator  # noqa: E402
from hand_classifier import HandClassifier  # noqa: E402
from bet_sizing import evaluate_bet_sizing  # noqa: E402
from ev_calculator import EVCalculator  # noqa: E402

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vectors")

RANKS = "AKQJT98765432"
POSITIONS = ["LJ", "HJ", "CO", "BTN", "SB", "BB"]

# 代表ボード（テクスチャを網羅する）
BOARDS = {
    "dry_K83r":      ["Kd", "8s", "3c"],
    "dry_A72r":      ["Ad", "7c", "2d"],
    "wet_986tt":     ["9h", "8c", "6s"],
    "monotone_Q72":  ["Qh", "7h", "2h"],
    "paired_K K 4":  ["Kd", "Kc", "4h"],
    "turn_K83rQ":    ["Kd", "8s", "3c", "Qh"],
    "river_K83rQ2":  ["Kd", "8s", "3c", "Qh", "2d"],
}

# ボードと衝突しない代表ハンド
HANDS = [
    ["As", "Ad"], ["7s", "7d"], ["5h", "5d"],
    ["Ah", "Ks"], ["Jh", "9c"], ["Ts", "9s"],
    ["Qc", "Jd"], ["4d", "4s"],
]


def combos_169():
    """169通りの全プリフロップコンボ文字列を返す。"""
    out = []
    for i, r1 in enumerate(RANKS):
        for j, r2 in enumerate(RANKS):
            if i == j:
                out.append(r1 + r2)          # ペア
            elif i < j:
                out.append(r1 + r2 + "s")    # スーテッド
                out.append(r1 + r2 + "o")    # オフスート
    return sorted(set(out))


def combo_to_cards(combo):
    """'AKs' -> ['As','Ks'] のように具体的な2枚へ。検証用に決定的な選び方をする。"""
    if len(combo) == 2:
        return [combo[0] + "s", combo[1] + "h"]
    r1, r2, kind = combo[0], combo[1], combo[2]
    return [r1 + "s", r2 + "s"] if kind == "s" else [r1 + "s", r2 + "h"]


def cards(strs):
    return [Card.new(s) for s in strs]


def gen_preflop():
    """プリフロップ評価: 169コンボ × 6ポジション × 3アクション × 3bet有無。"""
    rows = []
    for combo in combos_169():
        cs = cards(combo_to_cards(combo))
        for pos in POSITIONS:
            for is_3bet in (False, True):
                for action, facing in (("RAISE", 0.0), ("RAISE", 2.5), ("CALL", 2.5), ("FOLD", 2.5)):
                    decision, ev, reason = Evaluator.evaluate_preflop_action_gto(
                        cs, action, pos, is_3bet, facing)
                    rows.append({
                        "combo": combo, "pos": pos, "action": action,
                        "facing_bet": facing, "is_3bet_pot": is_3bet,
                        "decision": decision, "evaluation": ev,
                    })
    return rows


def gen_postflop():
    """ポストフロップ評価。エクイティは固定値を与えて決定的にする。"""
    rows = []
    EQUITIES = [0.05, 0.20, 0.35, 0.50, 0.65, 0.80, 0.95]
    POTS = [(5.5, 1.8), (5.5, 2.75), (5.5, 5.5), (12.0, 8.0), (20.0, 15.0)]

    for bname, bstrs in BOARDS.items():
        board = cards(bstrs)
        street = {3: "FLOP", 4: "TURN", 5: "RIVER"}[len(board)]
        for hstrs in HANDS:
            if set(hstrs) & set(bstrs):
                continue
            hero = cards(hstrs)
            for eq in EQUITIES:
                for pot_before, bet in POTS:
                    pot_incl = pot_before + bet
                    for adv in (0.35, 0.50, 0.65):
                        base = {
                            "board": bname, "hand": "".join(hstrs), "equity": eq,
                            "pot_before": pot_before, "bet": bet, "range_adv": adv,
                            "street": street,
                        }
                        c = Evaluator.evaluate_call(
                            eq, bet, pot_incl, hero_pos="BB", cards=hero,
                            is_3bet_pot=False, board=board, effective_stack=95.0,
                            range_adv=adv, hero_range_dict=None, street=street)
                        rows.append({**base, "fn": "call",
                                     "evaluation": c["evaluation"], "ev": round(c["ev"], 6),
                                     "realized_eq": round(c["realized_eq"], 6),
                                     "req_eq": round(c["req_eq"], 6)})

                        f = Evaluator.evaluate_fold(
                            eq, bet, pot_incl, hero_pos="BB", cards=hero,
                            is_3bet_pot=False, board=board, range_adv=adv,
                            effective_stack=95.0, street=street)
                        rows.append({**base, "fn": "fold",
                                     "evaluation": f["evaluation"],
                                     "realized_eq": round(f["realized_eq"], 6),
                                     "req_eq": round(f["req_eq"], 6),
                                     "mdf": f.get("mdf")})
    return rows


def gen_pure_functions():
    """レンジに依存しない純粋関数。JS移植で最初に通すべき土台。"""
    rows = []

    # EQR と実現エクイティ
    for eq in [0.0, 0.05, 0.2, 0.35, 0.5, 0.65, 0.8, 0.95, 1.0]:
        for eqr in [0.6, 0.8, 1.0, 1.2, 1.4]:
            rows.append({"fn": "realize_equity", "equity": eq, "eqr": eqr,
                         "out": round(Evaluator.realize_equity(eq, eqr), 6)})

    # 必要勝率 / MDF / alpha / ブラフ頻度
    for pot in [5.5, 10.0, 20.0, 100.0]:
        for bet in [1.0, 1.8, 5.0, 10.0, 20.0]:
            rows.append({"fn": "required_equity", "pot": pot, "bet": bet,
                         "out": round(EVCalculator.calculate_required_equity(bet, pot), 6)})
            rows.append({"fn": "mdf", "pot": pot, "bet": bet,
                         "out": round(EVCalculator.calculate_mdf(bet, pot), 6)})
            rows.append({"fn": "alpha", "pot": pot, "bet": bet,
                         "out": round(EVCalculator.calculate_alpha(bet, pot), 6)})
            rows.append({"fn": "bluff_freq", "pot": pot, "bet": bet,
                         "out": round(Evaluator.calculate_theoretical_bluff_frequency(bet, pot), 6)})
            rows.append({"fn": "fold_equity", "pot": pot, "bet": bet, "texture": None,
                         "out": round(Evaluator.estimate_fold_equity(pot, bet), 6)})
            for tex in ["dry", "wet", "paired", "monotone", "semi_wet"]:
                rows.append({"fn": "fold_equity", "pot": pot, "bet": bet, "texture": tex,
                             "out": round(Evaluator.estimate_fold_equity(pot, bet, tex), 6)})

    # EV 計算
    for eq in [0.1, 0.3, 0.5, 0.7, 0.9]:
        for pot in [5.5, 20.0]:
            for bet in [1.8, 5.5]:
                rows.append({"fn": "ev_call", "equity": eq, "pot": pot, "bet": bet,
                             "out": round(EVCalculator.ev_call(eq, pot, bet), 6)})
                rows.append({"fn": "ev_check", "equity": eq, "pot": pot,
                             "out": round(EVCalculator.ev_check(eq, pot), 6)})
                for fe in [0.3, 0.55, 0.7]:
                    rows.append({"fn": "ev_bet", "equity": eq, "pot": pot, "bet": bet,
                                 "fold_equity": fe,
                                 "out": round(EVCalculator.ev_bet(eq, pot, bet, fe), 6)})

    # ボードテクスチャ分類
    for bname, bstrs in BOARDS.items():
        rows.append({"fn": "board_texture", "board": bname,
                     "out": HandClassifier.classify_board_texture(cards(bstrs))})

    # ハンド分類とドロー検出
    for bname, bstrs in BOARDS.items():
        for hstrs in HANDS:
            if set(hstrs) & set(bstrs):
                continue
            hero, board = cards(hstrs), cards(bstrs)
            rows.append({"fn": "categorize_hand", "board": bname, "hand": "".join(hstrs),
                         "out": HandClassifier.categorize_hand(hero, board)})
            rows.append({"fn": "detect_draw", "board": bname, "hand": "".join(hstrs),
                         "out": HandClassifier.detect_draw_strength(hero, board)})

    # ベットサイジング評価
    for tex in ["dry", "wet", "paired", "monotone", "semi_wet"]:
        for pot in [5.5, 20.0]:
            for bet in [1.0, 2.75, 5.5, 11.0]:
                r = evaluate_bet_sizing(pot, bet, tex)
                rows.append({"fn": "bet_sizing", "texture": tex, "pot": pot, "bet": bet,
                             "out": r["evaluation"]})
    return rows


def gen_bet_raise_check():
    """ベット/レイズ/チェックの判定ロジック。

    これらは内部で equity_vs_calling_range()（モンテカルロ）を呼ぶため
    そのままでは決定的にならない。ここでは **その戻り値を固定値に差し替えて**
    分岐ロジックだけを取り出して検証する。
    こうすると:
      - Python 側の回帰テストとして決定的に動く
      - JS 移植後も同じ入力で同じ出力になるはずなので、そのまま流用できる
        （モンテカルロ自体の一致は別途、統計的に検証する）
    """
    rows = []
    # None は「レンジ情報が無く従来のEV比較に落ちる」経路
    EQ_CALLED = [None, 0.10, 0.30, 0.45, 0.50, 0.52, 0.55, 0.60, 0.65, 0.80, 0.95]
    EQUITIES = [0.05, 0.20, 0.32, 0.34, 0.50, 0.70, 0.90]
    DRAWS = ["NONE", "WEAK_DRAW", "MEDIUM_DRAW", "STRONG_DRAW"]

    board = cards(BOARDS["dry_K83r"])
    hero = cards(["7s", "7d"])

    orig_eq = Evaluator.equity_vs_calling_range
    orig_draw = HandClassifier.detect_draw_strength
    try:
        for eq_called in EQ_CALLED:
            Evaluator.equity_vs_calling_range = staticmethod(
                lambda *a, _v=eq_called, **k: _v)
            for draw in DRAWS:
                HandClassifier.detect_draw_strength = staticmethod(
                    lambda *a, _d=draw, **k: _d)
                for eq in EQUITIES:
                    for street in ("FLOP", "TURN", "RIVER"):
                        for pot, bet in ((5.5, 2.75), (12.0, 8.0)):
                            base = {"eq_called": eq_called, "draw": draw, "equity": eq,
                                    "street": street, "pot": pot, "bet": bet}

                            for is_donk in (False, True):
                                b = Evaluator.evaluate_bet(
                                    eq, bet, pot, hero_pos="BTN", cards=hero, board=board,
                                    range_adv=0.5, effective_stack=95.0, street=street,
                                    hero_range_dict={"AA": 1.0}, cpu_range_dict={"KK": 1.0},
                                    is_donk=is_donk)
                                rows.append({**base, "fn": "bet", "is_donk": is_donk,
                                             "evaluation": b["evaluation"]})

                            r = Evaluator.evaluate_raise(
                                eq, bet, 1.8, pot, hero_pos="BTN", cards=hero, board=board,
                                range_adv=0.5, hero_range_dict={"AA": 1.0},
                                effective_stack=95.0, street=street,
                                cpu_range_dict={"KK": 1.0})
                            rows.append({**base, "fn": "raise",
                                         "evaluation": r["evaluation"]})

                            for ini, ip in ((True, True), (True, False), (False, True), (False, False)):
                                ch = Evaluator.evaluate_check(
                                    eq, pot, hero_pos="BTN", has_initiative=ini,
                                    is_hero_ip=ip, cards=hero, board=board, range_adv=0.5,
                                    effective_stack=95.0, street=street,
                                    hero_range_dict={"AA": 1.0}, cpu_range_dict={"KK": 1.0})
                                rows.append({**base, "fn": "check",
                                             "has_initiative": ini, "is_hero_ip": ip,
                                             "evaluation": ch["evaluation"]})
    finally:
        Evaluator.equity_vs_calling_range = orig_eq
        HandClassifier.detect_draw_strength = orig_draw
    return rows


def gen_ranges():
    """レンジデータそのもの。JS側へJSONで持っていく際の一致確認用。"""
    out = {}
    for pos in POSITIONS + ["UTG"]:
        out[pos] = {}
        for action in ["open", "vs_open_call", "vs_open_3bet", "vs_3bet_call",
                       "vs_3bet_4bet", "3bet", "4bet_bluff"]:
            r = ranges.get_range_by_category(pos, action)
            out[pos][action] = {k: round(v, 6) for k, v in sorted(r.items())}
    return out


def gen_range_order():
    """レンジの反復順と parse_combo の展開結果。

    JS の Object は "22" のような整数っぽいキーを先頭に並べ替えるため、順序の一致を別途固定する。
    update_range_after_action は同点コンボの順位を反復順で決めるので、順序も挙動の一部。
    """
    order = {}
    for pos in POSITIONS + ["UTG"]:
        order[pos] = {}
        for action in ["open", "vs_open_call", "vs_open_3bet", "vs_3bet_call",
                       "vs_3bet_4bet", "3bet", "4bet_bluff"]:
            order[pos][action] = list(ranges.get_range_by_category(pos, action).keys())
    order["position_ranges"] = {k: list(v.keys()) for k, v in ranges.position_ranges.items()}
    combos = {c: ranges.parse_combo(c) for c in list(ranges.ALL_HANDS_DICT) + ["AhKh", "Td9c"]}
    weighted = [
        {"pos": pos, "action": action, "dead": dead,
         "result": ranges.get_possible_hole_cards_weighted(pos, action, dead)}
        for pos, action, dead in [
            ("BTN", "open", ["As", "Kd"]),
            ("SB", "vs_open_call", ["7h", "7c", "2d"]),
            ("BB", "vs_open_call", []),
            ("UTG", "open", ["Qs"]),
            ("BB", "open", ["Ah", "Ad", "Kc"]),
        ]
    ]
    return {"order": order, "parse_combo": combos, "weighted": weighted}


def gen_range_update():
    """update_range_after_action / build_sampler の決定的な部分。

    update_range_after_action は戻り値の順序が次の更新の同点処理に効くので、
    [combo, weight] のリストで順序ごと固定する。連続適用（ストリートをまたぐ絞り込み）も含める。
    """
    import random
    from treys import Evaluator as TE
    import range_utils
    te = TE()
    rng = random.Random(20260927)
    full = [r + s for r in RANKS for s in "shdc"]
    base_ranges = [("BTN", "open"), ("BB", "vs_open_call"), ("SB", "vs_open_call"),
                   ("CO", "3bet"), ("LJ", "open"), ("HJ", "vs_3bet_call")]
    kinds = ["LARGE_BET", "SMALL_BET", "CALL", "FOLD", "CHECK"]
    updates = []
    for i in range(120):
        pos, action = base_ranges[i % len(base_ranges)]
        board_n = [0, 3, 4, 5][i % 4]
        board_str = rng.sample(full, board_n)
        board = [Card.new(c) for c in board_str]
        rd = dict(ranges.get_range_by_category(pos, action))
        steps = []
        for _ in range(1 + i % 3):  # 1〜3回続けて絞る
            kind = rng.choice(kinds)
            rd = ranges.update_range_after_action(rd, kind, 5.0, board, te)
            steps.append({"kind": kind, "result": [[k, v] for k, v in rd.items()]})
        updates.append({"pos": pos, "action": action, "board": board_str, "steps": steps})

    samplers = []
    for i, (pos, action) in enumerate(base_ranges):
        dead = rng.sample(full, 2 + i)
        sp = range_utils.build_sampler(ranges.get_range_by_category(pos, action), dead_cards_str=dead)
        combos, cum, total = sp
        rs = [rng.uniform(0, total) for _ in range(30)] + [0.0, total]
        import bisect
        picks = [min(bisect.bisect_left(cum, r), len(combos) - 1) for r in rs]
        samplers.append({
            "pos": pos, "action": action, "dead": dead,
            "combos": [[Card.int_to_str(c) for c in cc] for cc in combos],
            "cum": cum, "total": total, "rs": rs, "picks": picks,
        })
    empty = range_utils.build_sampler({"AA": 1.0}, dead_cards_str=["As", "Ah", "Ad"])
    return {"updates": updates, "samplers": samplers, "empty_is_none": [empty is None]}


def gen_evaluator_full():
    """評価関数の戻り値を丸ごと固定する（フェーズ4 の JS 移植用）。

    既存の preflop / postflop / bet_raise_check は評価記号しか持たないため、
    ここでは全フィールド（ev・req_eq・realized_eq・mdf・reason）を ja / en 両方で残す。
    浮動小数点は丸めずに保存し、JS 側では === で比較する（計算順序が同じならビット一致する）。

    パラメータ空間はシード固定の乱数で広くサンプリングする。
    ベット/レイズ/チェック内部のモンテカルロ（equity_vs_calling_range）は固定値に差し替える。
    """
    import random
    rng = random.Random(4)
    full = [r + s for r in RANKS for s in "shdc"]
    positions = POSITIONS + ["UTG"]

    def both_langs(fn):
        out = {}
        for lang in ("ja", "en"):
            i18n.set_lang(lang)
            out[lang] = fn()
        i18n.set_lang("ja")
        return out

    def pack(res):
        """ja/en の結果を1つにまとめる。reason 以外は言語で変わらないことも確認する。"""
        ja, en = res["ja"], res["en"]
        if isinstance(ja, tuple):
            assert ja[:2] == en[:2]
            return {"decision": ja[0], "evaluation": ja[1], "reason_ja": ja[2], "reason_en": en[2]}
        assert {k: v for k, v in ja.items() if k != "reason"} == {k: v for k, v in en.items() if k != "reason"}
        row = {k: v for k, v in ja.items() if k != "reason"}
        row["reason_ja"], row["reason_en"] = ja["reason"], en["reason"]
        return row

    # --- プリフロップ: 169 × 7ポジション × 3bet有無 × 3アクション × facing(0/2.5) を全部 ---
    preflop = []
    for combo in combos_169():
        cs = cards(combo_to_cards(combo))
        for pos in positions:
            for is_3bet in (False, True):
                for action in ("RAISE", "CALL", "FOLD", "CHECK"):
                    for facing in (0.0, 2.5):
                        r = pack(both_langs(lambda: Evaluator.evaluate_preflop_action_gto(
                            cs, action, pos, is_3bet, facing)))
                        preflop.append({"combo": combo, "pos": pos, "is_3bet_pot": is_3bet,
                                        "action": action, "facing_bet": facing, **r})

    # --- ポストフロップ（とプリフロップの call/fold/raise/bet 経路）: 乱数で広く ---
    EQS = [0.0, 0.02, 0.05, 0.2, 0.3, 0.33, 0.35, 0.5, 0.52, 0.6, 0.65, 0.8, 0.95, 0.99, 1.0]
    POTS = [1.5, 3.0, 5.5, 8.0, 12.0, 20.0, 40.0, 100.0]
    BETS = [0.0, 0.5, 1.0, 1.8, 2.75, 5.5, 8.0, 15.0, 30.0, 95.0]
    ADVS = [0.3, 0.45, 0.5, 0.55, 0.56, 0.7]
    STACKS = [0.0, 2.0, 8.0, 30.0, 95.0, 200.0]
    EQ_CALLED = [None, 0.1, 0.3, 0.45, 0.52, 0.55, 0.6, 0.65, 0.9]

    def rand_spot():
        n_board = rng.choice([0, 3, 3, 3, 4, 4, 5, 5])
        picks = rng.sample(full, 2 + n_board)
        eq = rng.choice(EQS) if rng.random() < 0.5 else rng.random()
        return {
            "hand": picks[:2], "board": picks[2:], "equity": eq,
            "pot": rng.choice(POTS), "bet": rng.choice(BETS),
            "pos": rng.choice(positions), "range_adv": rng.choice(ADVS),
            "stack": rng.choice(STACKS), "is_3bet_pot": rng.random() < 0.25,
            "eq_called": rng.choice(EQ_CALLED),
        }

    def street_of(board):
        return {0: "PREFLOP", 3: "FLOP", 4: "TURN", 5: "RIVER"}[len(board)]

    postflop = []
    orig_eq = Evaluator.equity_vs_calling_range
    try:
        for i in range(12000):
            sp = rand_spot()
            fn = ["call", "fold", "bet", "raise", "check"][i % 5]
            hero, board = cards(sp["hand"]), cards(sp["board"])
            street = street_of(sp["board"])
            Evaluator.equity_vs_calling_range = staticmethod(lambda *a, _v=sp["eq_called"], **k: _v)
            extra = {}
            if fn == "call":
                call = lambda: Evaluator.evaluate_call(
                    sp["equity"], sp["bet"], sp["pot"], hero_pos=sp["pos"], cards=hero,
                    is_3bet_pot=sp["is_3bet_pot"], board=board, effective_stack=sp["stack"],
                    range_adv=sp["range_adv"], street=street)
            elif fn == "fold":
                call = lambda: Evaluator.evaluate_fold(
                    sp["equity"], sp["bet"], sp["pot"] + sp["bet"], hero_pos=sp["pos"], cards=hero,
                    is_3bet_pot=sp["is_3bet_pot"], board=board, range_adv=sp["range_adv"],
                    effective_stack=sp["stack"], street=street)
            elif fn == "bet":
                extra["is_donk"] = rng.random() < 0.3
                call = lambda: Evaluator.evaluate_bet(
                    sp["equity"], sp["bet"], sp["pot"], hero_pos=sp["pos"], cards=hero, board=board,
                    range_adv=sp["range_adv"], effective_stack=sp["stack"], street=street,
                    hero_range_dict={"AA": 1.0}, cpu_range_dict={"KK": 1.0}, is_donk=extra["is_donk"])
            elif fn == "raise":
                extra["raise_amount"] = rng.choice([2.5, 6.0, 9.0, 20.0, 60.0])
                call = lambda: Evaluator.evaluate_raise(
                    sp["equity"], extra["raise_amount"], sp["bet"], sp["pot"], hero_pos=sp["pos"],
                    cards=hero, board=board, range_adv=sp["range_adv"], hero_range_dict={"AA": 1.0},
                    effective_stack=sp["stack"], street=street, cpu_range_dict={"KK": 1.0})
            else:
                extra["has_initiative"] = rng.random() < 0.5
                extra["is_hero_ip"] = rng.random() < 0.5
                call = lambda: Evaluator.evaluate_check(
                    sp["equity"], sp["pot"], hero_pos=sp["pos"], has_initiative=extra["has_initiative"],
                    is_hero_ip=extra["is_hero_ip"], cards=hero, board=board, range_adv=sp["range_adv"],
                    effective_stack=sp["stack"], street=street,
                    hero_range_dict={"AA": 1.0}, cpu_range_dict={"KK": 1.0})
            postflop.append({"fn": fn, "street": street, **sp, **extra, **pack(both_langs(call))})
    finally:
        Evaluator.equity_vs_calling_range = orig_eq

    # --- 内部の部品（EQR など）も単体で固定しておくと、ずれた時に原因を絞り込める ---
    parts = []
    for i in range(3000):
        sp = rand_spot()
        hero, board = cards(sp["hand"]), cards(sp["board"])
        spr = rng.choice([0.5, 1.0, 2.0, 3.0, 5.0, 6.0, 6.5, 10.0])
        street = rng.choice([street_of(sp["board"]), None])
        sizing_spr = rng.choice([None, 1.0, 5.0, 9.0])
        parts.append({
            "hand": sp["hand"], "board": sp["board"], "pos": sp["pos"], "is_3bet_pot": sp["is_3bet_pot"],
            "range_adv": sp["range_adv"], "spr": spr, "street": street,
            "eqr": Evaluator.get_eqr_modifier(sp["pos"], hero, sp["is_3bet_pot"], board,
                                              sp["range_adv"], spr=spr, street=street),
            "pi": Evaluator.calculate_pi(hero, board),
            "category": HandClassifier.categorize_hand(hero, board),
            "draw": HandClassifier.detect_draw_strength(hero, board),
            "texture": HandClassifier.classify_board_texture(board),
            "combo": Evaluator.get_combo_str(hero, ranges.ALL_HANDS_DICT),
            "sizing": pack(both_langs(lambda: evaluate_bet_sizing(
                sp["pot"], sp["bet"], HandClassifier.classify_board_texture(board),
                spr=sizing_spr) if board else {"evaluation": "", "reason": ""})),
            "sizing_spr": sizing_spr, "pot": sp["pot"], "bet": sp["bet"],
        })
    # 数値の丸め境界（Python の {:.1f} は偶数丸め）を踏むケース
    fmt = []
    for x in [0.25, 0.35, 0.45, 12.25, 52.25, 52.35, 0.125, 2.5, 3.5, 99.95, 33.333333, 66.65, 0.05, 1e-9]:
        for spec in (".1f", ".0f"):
            fmt.append({"x": x, "spec": spec, "out": format(x, spec)})
    for x in [0.1234, 0.1235, 0.4445, 1.0005, 2.675, 0.3333333]:
        fmt.append({"x": x, "round3": round(x, 3)})
    # 同じコメント文が何千回も出るので文字列表に括り出す（16MB → 数MB）。
    # reason_ja / reason_en は strings への添字になる。
    strings, index = [], {}

    def intern(text):
        if text not in index:
            index[text] = len(strings)
            strings.append(text)
        return index[text]

    for row in preflop + postflop + [p["sizing"] for p in parts]:
        row["reason_ja"] = intern(row["reason_ja"])
        row["reason_en"] = intern(row["reason_en"])
    return {"preflop": preflop, "postflop": postflop, "parts": parts, "format": fmt, "strings": strings}


def gen_hand_evaluator():
    """treys の7枚評価の参照値。JS実装の完全一致検証に使う。"""
    import random
    random.seed(20260927)
    from treys import Evaluator as TE
    te = TE()
    full = [Card.new(r + s) for r in RANKS for s in "shdc"]
    rows = []
    for _ in range(3000):
        pick = random.sample(full, 7)
        board, hand = pick[:5], pick[5:]
        rows.append({
            "board": [Card.int_to_str(c) for c in board],
            "hand": [Card.int_to_str(c) for c in hand],
            "score": te.evaluate(board, hand),
            "rank_class": te.get_rank_class(te.evaluate(board, hand)),
        })
    return rows


# 大きいセットは「1行1件」で書く（indent=1 だとフィールド毎に改行されて数倍に膨らむ）
COMPACT_SETS = {"evaluator_full"}


def dump_vectors(name, data):
    if name not in COMPACT_SETS:
        return json.dumps(data, ensure_ascii=False, sort_keys=True, indent=1)
    row = lambda v: json.dumps(v, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    parts = []
    for key in sorted(data):
        body = ",\n".join(row(v) for v in data[key])
        parts.append(f'"{key}":[\n{body}\n]')
    return "{\n" + ",\n".join(parts) + "\n}"


SETS = {
    "pure_functions": gen_pure_functions,
    "preflop": gen_preflop,
    "postflop": gen_postflop,
    "bet_raise_check": gen_bet_raise_check,
    "ranges": gen_ranges,
    "range_order": gen_range_order,
    "range_update": gen_range_update,
    "evaluator_full": gen_evaluator_full,
    "hand_evaluator": gen_hand_evaluator,
}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true",
                    help="生成せず、既存ファイルと差分がないか確認する")
    args = ap.parse_args()

    i18n.set_lang("ja")  # 評価記号(◎◯△×)は言語非依存だが念のため固定
    os.makedirs(OUT_DIR, exist_ok=True)

    failed = False
    for name, fn in SETS.items():
        data = fn()
        path = os.path.join(OUT_DIR, f"{name}.json")
        text = dump_vectors(name, data)
        n = len(data) if isinstance(data, list) else sum(len(v) for v in data.values())
        if args.check:
            if not os.path.exists(path):
                print(f"  NG {name}: ファイルが無い")
                failed = True
                continue
            old = open(path, encoding="utf-8").read()
            mark = "OK" if old == text else "NG 差分あり"
            if old != text:
                failed = True
            print(f"  {mark} {name} ({n:,} 件)")
        else:
            with open(path, "w", encoding="utf-8") as f:
                f.write(text)
            print(f"  書き出し {name}: {n:,} 件 / {len(text)/1024:.0f} KB")

    if args.check:
        print("\n差分なし（現在の実装は固定された挙動と一致）" if not failed
              else "\n差分あり。意図した変更かを確認すること")
        sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
