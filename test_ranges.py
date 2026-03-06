import ranges

print("=== Classification ===")
c1 = ranges.classify_range(1.0)
c2 = ranges.classify_range(0.5)
c3 = ranges.classify_range(0.0)
print(f"1.0 -> {c1}")
print(f"0.5 -> {c2}")
print(f"0.0 -> {c3}")

print("\n=== Preflop Feedback ===")
print("CORE:", ranges.get_preflop_feedback(c1))
print("MIXED:", ranges.get_preflop_feedback(c2))
print("FOLD:", ranges.get_preflop_feedback(c3))

print("\n=== Hand Reasons ===")
for hand in ["A5s", "KJo", "98s", "72o", "AA"]:
    print(f"{hand}: {ranges.get_hand_reason(hand)}")

print("\n=== UTG Open Range Check ===")
utg = ranges.get_range_by_category("UTG", "open")
print(f"AA weight: {utg.get('AA', 0)}")
print(f"AJo weight: {utg.get('AJo', 0)}")

from poker_engine import PokerEngine
pe = PokerEngine()
pe.start_new_hand()
print(f"\nEngine Hero Pos: {pe.hero_position}")
print(f"Engine CPU Pos: {pe.cpu_position}")
print("OK. All loaded successfully without syntax errors.")
