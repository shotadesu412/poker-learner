import re

with open('c:/roker learner/ranges.py', 'r', encoding='utf-8') as f:
    text = f.read()

# 1. Add LJ to position_ranges (Clone UTG for LJ as EP in 6-max)
if '"LJ": {' not in text:
    utg_block_match = re.search(r'"UTG": \{(.*?)\}', text, re.DOTALL)
    if utg_block_match:
        utg_block = utg_block_match.group(1)
        lj_block = f'"LJ": {{{utg_block}}},'
        # Insert LJ after UTG
        text = text.replace('"UTG": {', lj_block + '\n    "UTG": {')

# 2. Add BB to position_ranges (Empty or very tight for open, though BB doesn't open)
if '"BB": {' not in text:
    bb_block = '"BB": {"AA": 1, "KK": 1, "QQ": 1, "AKs": 1},'
    text = text.replace('"SB": {', bb_block + '\n    "SB": {')


# 3. Re-write the RANGES dict totally
ranges_start = text.find('RANGES = {')
if ranges_start != -1:
    # Find matching brace
    ranges_end = -1
    brace_count = 0
    in_ranges = False
    for i, char in enumerate(text[ranges_start:]):
        if char == '{':
            brace_count += 1
            in_ranges = True
        elif char == '}':
            brace_count -= 1
        if in_ranges and brace_count == 0:
            ranges_end = ranges_start + i + 1
            break
            
    # Replacement block
    new_ranges_code = """RANGES = {
    "UTG": {
        "open": position_ranges.get("UTG", {}),
        "vs_3bet_call": {"JJ": 1.0, "TT": 1.0, "99": 1.0, "88": 1.0, "AQs": 1.0, "AJs": 1.0, "KQs": 1.0, "AKo": 0.5},
        "vs_3bet_4bet": {"AA": 1.0, "KK": 1.0, "QQ": 1.0, "AKs": 1.0, "AKo": 0.5, "A5s": 0.5},
        "3bet": {"AA": 1.0, "KK": 1.0, "QQ": 1.0, "AKs": 1.0, "AQs": 0.5},
        "4bet_bluff": {"A5s": 1.0, "A4s": 1.0, "KQs": 0.5}
    },
    "LJ": {
        "open": position_ranges.get("LJ", position_ranges.get("UTG", {})),
        "vs_3bet_call": {"JJ": 1.0, "TT": 1.0, "99": 1.0, "88": 1.0, "AQs": 1.0, "AJs": 1.0, "KQs": 1.0, "AKo": 0.5},
        "vs_3bet_4bet": {"AA": 1.0, "KK": 1.0, "QQ": 1.0, "AKs": 1.0, "AKo": 0.5, "A5s": 0.5},
        "3bet": {"AA": 1.0, "KK": 1.0, "QQ": 1.0, "AKs": 1.0},
        "4bet_bluff": {"A5s": 1.0, "A4s": 1.0}
    },
    "HJ": {
        "open": position_ranges.get("HJ", {}),
        "vs_open_call": {"JJ": 0.5, "TT": 1.0, "99": 1.0, "88": 1.0, "77": 1.0, "AQs": 0.5, "AJs": 1.0, "ATs": 1.0, "KQs": 1.0, "QJs": 1.0, "JTs": 1.0, "AQo": 0.5, "AJo": 1.0, "KQo": 1.0},
        "vs_open_3bet": {"AA": 1.0, "KK": 1.0, "QQ": 1.0, "JJ": 0.5, "AKs": 1.0, "AQs": 0.5},
        "vs_3bet_call": {"JJ": 1.0, "TT": 1.0, "99": 1.0, "88": 1.0, "AQs": 1.0, "AJs": 1.0, "KQs": 1.0, "AKo": 0.5},
        "vs_3bet_4bet": {"AA": 1.0, "KK": 1.0, "QQ": 1.0, "AKs": 1.0, "AKo": 0.5, "A5s": 0.5},
        "3bet": {"AA": 1.0, "KK": 1.0, "QQ": 1.0, "JJ": 0.5, "AKs": 1.0, "AQs": 0.5, "A5s": 0.5, "A4s": 0.5, "AKo": 1.0, "AQo": 0.5},
        "4bet_bluff": {"A5s": 1.0, "A4s": 1.0, "A3s": 0.5}
    },
    "CO": {
        "open": position_ranges.get("CO", {}),
        "vs_open_call": {"JJ": 0.5, "TT": 1.0, "99": 1.0, "88": 1.0, "77": 1.0, "AQs": 0.5, "AJs": 1.0, "ATs": 1.0, "KQs": 1.0, "QJs": 1.0, "JTs": 1.0, "AQo": 0.5, "AJo": 1.0, "KQo": 1.0},
        "vs_open_3bet": threebet_ranges.get("BTN_vs_CO", {"AA": 1.0, "KK": 1.0, "QQ": 1.0, "JJ": 0.5, "AKs": 1.0, "AQs": 0.5, "A5s": 0.5, "A4s": 0.5, "AKo": 1.0, "AQo": 0.5}),
        "vs_3bet_call": {"JJ": 1.0, "TT": 1.0, "99": 1.0, "88": 1.0, "AQs": 1.0, "AJs": 1.0, "KQs": 1.0, "AKo": 0.5},
        "vs_3bet_4bet": {"AA": 1.0, "KK": 1.0, "QQ": 1.0, "AKs": 1.0, "AKo": 0.5, "A5s": 0.5},
        "3bet": {"AA": 1.0, "KK": 1.0, "QQ": 1.0, "JJ": 0.5, "AKs": 1.0, "AQs": 0.5, "A5s": 0.5, "A4s": 0.5, "AKo": 1.0, "AQo": 0.5},
        "4bet_bluff": {"A5s": 1.0, "A4s": 1.0, "K9s": 0.5, "Q9s": 0.5}
    },
    "BTN": {
        "open": position_ranges.get("BTN", {}),
        "vs_open_call": {"JJ": 0.5, "TT": 1.0, "99": 1.0, "88": 1.0, "77": 1.0, "AQs": 0.5, "AJs": 1.0, "ATs": 1.0, "KQs": 1.0, "QJs": 1.0, "JTs": 1.0, "AQo": 0.5, "AJo": 1.0, "KQo": 1.0},
        "vs_open_3bet": {"AA": 1.0, "KK": 1.0, "QQ": 1.0, "JJ": 0.5, "AKs": 1.0, "AQs": 0.5, "A5s": 0.5, "A4s": 0.5, "AKo": 1.0, "AQo": 0.5},
        "vs_3bet_call": {"JJ": 1.0, "TT": 1.0, "99": 1.0, "88": 1.0, "AQs": 1.0, "AJs": 1.0, "KQs": 1.0, "AKo": 0.5},
        "vs_3bet_4bet": {"AA": 1.0, "KK": 1.0, "QQ": 1.0, "AKs": 1.0, "AKo": 0.5, "A5s": 0.5},
        "3bet": {"AA": 1.0, "KK": 1.0, "QQ": 1.0, "JJ": 0.5, "AKs": 1.0, "AQs": 0.5, "A5s": 0.5, "A4s": 0.5, "AKo": 1.0, "AQo": 0.5},
        "4bet_bluff": {"A5s": 1.0, "A4s": 1.0, "A3s": 1.0, "A2s": 1.0}
    },
    "SB": {
        "open": position_ranges.get("SB", {}),
        "vs_open_call": {},
        "vs_open_3bet": threebet_ranges.get("SB_vs_BTN", {"AA": 1.0, "KK": 1.0, "QQ": 1.0, "JJ": 1.0, "TT": 1.0, "99": 1.0, "88": 0.5, "AKs": 1.0, "AQs": 1.0, "AJs": 1.0, "ATs": 1.0, "KQs": 1.0, "KJs": 1.0, "AKo": 1.0, "AQo": 1.0, "AJo": 1.0, "KQo": 1.0, "A5s": 1.0, "A4s": 1.0, "A3s": 0.5, "A2s": 0.5, "KTs": 0.5, "QTs": 0.5, "JTs": 0.5, "76s": 0.5, "65s": 0.5}),
        "vs_3bet_call": {"JJ": 1.0, "TT": 1.0, "99": 1.0, "88": 1.0, "AQs": 1.0, "AJs": 1.0, "KQs": 1.0, "AKo": 0.5},
        "vs_3bet_4bet": {"AA": 1.0, "KK": 1.0, "QQ": 1.0, "AKs": 1.0, "AKo": 0.5, "A5s": 0.5},
        "3bet": threebet_ranges.get("SB_vs_BTN", {"AA": 1.0, "KK": 1.0, "QQ": 1.0, "JJ": 1.0, "TT": 1.0, "99": 1.0, "88": 0.5, "AKs": 1.0, "AQs": 1.0, "AJs": 1.0, "ATs": 1.0, "KQs": 1.0, "KJs": 1.0, "AKo": 1.0, "AQo": 1.0, "AJo": 1.0, "KQo": 1.0, "A5s": 1.0, "A4s": 1.0, "A3s": 0.5, "A2s": 0.5, "KTs": 0.5, "QTs": 0.5, "JTs": 0.5, "76s": 0.5, "65s": 0.5}),
        "4bet_bluff": {"A5s": 1.0, "A4s": 1.0}
    },
    "BB": {
        "open": {},
        "vs_open_call": {"22": 1.0, "33": 1.0, "44": 1.0, "55": 1.0, "66": 1.0, "77": 1.0, "88": 1.0, "99": 1.0, "TT": 1.0, "JJ": 1.0, "QQ": 0.5, "AQs": 0.5, "AJs": 1.0, "ATs": 1.0, "KQs": 1.0, "KJs": 1.0, "KTs": 1.0, "QJs": 1.0, "QTs": 1.0, "JTs": 1.0, "T9s": 1.0, "98s": 1.0, "87s": 1.0, "76s": 1.0, "65s": 1.0, "AQo": 1.0, "AJo": 1.0, "KQo": 1.0},
        "vs_open_3bet": threebet_ranges.get("BB_vs_BTN", {"AA": 1.0, "KK": 1.0, "QQ": 1.0, "JJ": 1.0, "AKs": 1.0, "AQs": 1.0, "AKo": 1.0, "A5s": 1.0, "A4s": 1.0, "A3s": 0.5, "A2s": 0.5, "K9s": 0.5, "K8s": 0.5, "Q9s": 0.5, "J8s": 0.5, "T8s": 0.5, "76s": 0.5, "65s": 0.5, "54s": 0.5}),
        "vs_3bet_call": {"JJ": 1.0, "TT": 1.0, "99": 1.0, "88": 1.0, "AQs": 1.0, "AJs": 1.0, "KQs": 1.0, "AKo": 0.5},
        "vs_3bet_4bet": {"AA": 1.0, "KK": 1.0, "QQ": 1.0, "AKs": 1.0, "AKo": 0.5, "A5s": 0.5},
        "3bet": threebet_ranges.get("BB_vs_BTN", {"AA": 1.0, "KK": 1.0, "QQ": 1.0, "JJ": 1.0, "AKs": 1.0, "AQs": 1.0, "AKo": 1.0, "A5s": 1.0, "A4s": 1.0, "A3s": 0.5, "A2s": 0.5, "K9s": 0.5, "K8s": 0.5, "Q9s": 0.5, "J8s": 0.5, "T8s": 0.5, "76s": 0.5, "65s": 0.5, "54s": 0.5}),
        "4bet_bluff": {"A5s": 1.0, "A4s": 1.0}
    }
}"""
    
    text = text[:ranges_start] + new_ranges_code + text[ranges_end:]
    
with open('c:/roker learner/ranges.py', 'w', encoding='utf-8') as f:
    f.write(text)
    
print("Updated ranges.py successfully.")
