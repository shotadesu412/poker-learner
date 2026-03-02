"""
ranges.py
Defines basic preflop hand ranges for Hero and CPU.
These are simplified default ranges to be used for Monte Carlo Equity Evaluation.
Ranges are defined as list of hands e.g. ["AA", "KK", "AKs", "AJo", ...]
"""

# Helper to generate all combos with default weight 1.0
def generate_all_hands_dict():
    ranks = "AKQJT98765432"
    hands = {}
    for i in range(len(ranks)):
        for j in range(i, len(ranks)):
            r1, r2 = ranks[i], ranks[j]
            if r1 == r2:
                hands[r1 + r2] = 1.0
            else:
                hands[r1 + r2 + "s"] = 1.0
                hands[r1 + r2 + "o"] = 1.0
    return hands

ALL_HANDS_DICT = generate_all_hands_dict()

# GTO Position-Based Opening Ranges (Refactored to Weighted Dictionaries)
RANGES = {
    "UTG": {
        "open": {
            "AA": 1.0, "KK": 1.0, "QQ": 1.0, "JJ": 1.0, "TT": 1.0, "99": 1.0, "88": 1.0, "77": 1.0,
            "AKs": 1.0, "AQs": 1.0, "AJs": 1.0, "ATs": 1.0, "A9s": 1.0, "A8s": 1.0, "A7s": 1.0, "A5s": 1.0,
            "KQs": 1.0, "KJs": 1.0, "KTs": 1.0,
            "QJs": 1.0, "QTs": 1.0,
            "JTs": 1.0, "T9s": 1.0, "98s": 1.0,
            "AKo": 1.0, "AQo": 1.0, "AJo": 0.5
        },
        "vs_3bet_call": {
            "JJ": 1.0, "TT": 1.0, "99": 1.0, "88": 1.0,
            "AQs": 1.0, "AJs": 1.0, "KQs": 1.0, "AKo": 0.5
        },
        "vs_3bet_4bet": {
            "AA": 1.0, "KK": 1.0, "QQ": 1.0, "AKs": 1.0, "AKo": 0.5, "A5s": 0.5
        }
    },
    "MP": {
        "open": {
            "AA": 1.0, "KK": 1.0, "QQ": 1.0, "JJ": 1.0, "TT": 1.0, "99": 1.0, "88": 1.0, "77": 1.0, "66": 1.0, "55": 0.5,
            "AKs": 1.0, "AQs": 1.0, "AJs": 1.0, "ATs": 1.0, "A9s": 1.0, "A8s": 1.0, "A7s": 1.0, "A6s": 0.5, "A5s": 1.0, "A4s": 0.5,
            "KQs": 1.0, "KJs": 1.0, "KTs": 1.0, "K9s": 0.5,
            "QJs": 1.0, "QTs": 1.0, "Q9s": 0.5,
            "JTs": 1.0, "J9s": 0.5, "T9s": 1.0, "98s": 1.0, "87s": 0.5,
            "AKo": 1.0, "AQo": 1.0, "AJo": 1.0, "ATo": 0.5, "KQo": 1.0, "KJo": 0.5
        },
        "vs_open_call": {
            "JJ": 0.5, "TT": 1.0, "99": 1.0, "88": 1.0, "77": 1.0, "66": 0.5,
            "AQs": 0.5, "AJs": 1.0, "ATs": 1.0, "A9s": 0.5,
            "KQs": 1.0, "KJs": 1.0, "KTs": 0.5,
            "QJs": 1.0, "QTs": 0.5, "JTs": 1.0, "T9s": 1.0, "98s": 0.5,
            "AQo": 0.5, "AJo": 1.0, "KQo": 1.0
        },
        "vs_open_3bet": {
            "AA": 1.0, "KK": 1.0, "QQ": 1.0, "JJ": 0.5,
            "AKs": 1.0, "AQs": 0.5, "A5s": 0.5, "A4s": 0.5,
            "AKo": 1.0, "AQo": 0.5
        }
    },
    "CO": {
        "open": {
            "AA": 1.0, "KK": 1.0, "QQ": 1.0, "JJ": 1.0, "TT": 1.0, "99": 1.0, "88": 1.0, "77": 1.0, "66": 1.0, "55": 1.0, "44": 1.0, "33": 0.5, "22": 0.5,
            "AKs": 1.0, "AQs": 1.0, "AJs": 1.0, "ATs": 1.0, "A9s": 1.0, "A8s": 1.0, "A7s": 1.0, "A6s": 1.0, "A5s": 1.0, "A4s": 1.0, "A3s": 1.0, "A2s": 1.0,
            "KQs": 1.0, "KJs": 1.0, "KTs": 1.0, "K9s": 1.0, "K8s": 0.5, "K7s": 0.5,
            "QJs": 1.0, "QTs": 1.0, "Q9s": 1.0, "Q8s": 0.5,
            "JTs": 1.0, "J9s": 1.0, "J8s": 0.5,
            "T9s": 1.0, "T8s": 1.0, "98s": 1.0, "87s": 1.0, "76s": 1.0, "65s": 0.5,
            "AKo": 1.0, "AQo": 1.0, "AJo": 1.0, "ATo": 1.0, "A9o": 0.5, "KQo": 1.0, "KJo": 1.0, "KTo": 0.5, "QJo": 1.0, "QTo": 0.5, "JTo": 0.5
        },
        "vs_open_call": {
            "JJ": 0.5, "TT": 1.0, "99": 1.0, "88": 1.0, "77": 1.0, "66": 0.5,
            "AQs": 0.5, "AJs": 1.0, "ATs": 1.0, "A9s": 0.5,
            "KQs": 1.0, "KJs": 1.0, "KTs": 0.5,
            "QJs": 1.0, "QTs": 0.5, "JTs": 1.0, "T9s": 1.0, "98s": 0.5,
            "AQo": 0.5, "AJo": 1.0, "KQo": 1.0
        },
        "vs_open_3bet": {
            "AA": 1.0, "KK": 1.0, "QQ": 1.0, "JJ": 0.5,
            "AKs": 1.0, "AQs": 0.5, "A5s": 0.5, "A4s": 0.5,
            "AKo": 1.0, "AQo": 0.5
        }
    },
    "BTN": {
        "open": {
            "AA": 1.0, "KK": 1.0, "QQ": 1.0, "JJ": 1.0, "TT": 1.0, "99": 1.0, "88": 1.0, "77": 1.0, "66": 1.0, "55": 1.0, "44": 1.0, "33": 1.0, "22": 1.0,
            "AKs": 1.0, "AQs": 1.0, "AJs": 1.0, "ATs": 1.0, "A9s": 1.0, "A8s": 1.0, "A7s": 1.0, "A6s": 1.0, "A5s": 1.0, "A4s": 1.0, "A3s": 1.0, "A2s": 1.0,
            "KQs": 1.0, "KJs": 1.0, "KTs": 1.0, "K9s": 1.0, "K8s": 1.0, "K7s": 1.0, "K6s": 0.5, "K5s": 0.5, "K4s": 0.5, "K3s": 0.5, "K2s": 0.5,
            "QJs": 1.0, "QTs": 1.0, "Q9s": 1.0, "Q8s": 1.0, "Q7s": 0.5, "Q6s": 0.5, "Q5s": 0.5,
            "JTs": 1.0, "J9s": 1.0, "J8s": 1.0, "J7s": 0.5,
            "T9s": 1.0, "T8s": 1.0, "T7s": 0.5,
            "98s": 1.0, "97s": 1.0, "87s": 1.0, "86s": 0.5, "76s": 1.0, "75s": 0.5, "65s": 1.0, "54s": 0.5,
            "AKo": 1.0, "AQo": 1.0, "AJo": 1.0, "ATo": 1.0, "A9o": 1.0, "A8o": 1.0, "A7o": 0.5, "A6o": 0.5, "A5o": 1.0, "A4o": 0.5,
            "KQo": 1.0, "KJo": 1.0, "KTo": 1.0, "K9o": 0.5, "QJo": 1.0, "QTo": 1.0, "Q9o": 0.5, "JTo": 1.0, "J9o": 0.5, "T9o": 0.5
        },
        "vs_open_call": {
            "JJ": 0.5, "TT": 1.0, "99": 1.0, "88": 1.0, "77": 1.0, "66": 0.5,
            "AQs": 0.5, "AJs": 1.0, "ATs": 1.0, "A9s": 0.5,
            "KQs": 1.0, "KJs": 1.0, "KTs": 0.5,
            "QJs": 1.0, "QTs": 0.5, "JTs": 1.0, "T9s": 1.0, "98s": 0.5,
            "AQo": 0.5, "AJo": 1.0, "KQo": 1.0
        },
        "vs_open_3bet": {
            "AA": 1.0, "KK": 1.0, "QQ": 1.0, "JJ": 0.5,
            "AKs": 1.0, "AQs": 0.5, "A5s": 0.5, "A4s": 0.5,
            "AKo": 1.0, "AQo": 0.5
        }
    },
    "SB": {
        "open": {
            "AA": 1.0, "KK": 1.0, "QQ": 1.0, "JJ": 1.0, "TT": 1.0, "99": 1.0, "88": 1.0, "77": 1.0, "66": 1.0, "55": 1.0, "44": 1.0, "33": 1.0, "22": 1.0,
            "AKs": 1.0, "AQs": 1.0, "AJs": 1.0, "ATs": 1.0, "A9s": 1.0, "A8s": 1.0, "A7s": 1.0, "A6s": 1.0, "A5s": 1.0, "A4s": 1.0, "A3s": 1.0, "A2s": 1.0,
            "KQs": 1.0, "KJs": 1.0, "KTs": 1.0, "K9s": 1.0, "K8s": 1.0, "K7s": 1.0, "K6s": 0.5,
            "QJs": 1.0, "QTs": 1.0, "Q9s": 1.0, "Q8s": 1.0,
            "JTs": 1.0, "J9s": 1.0, "J8s": 1.0,
            "T9s": 1.0, "T8s": 1.0, "98s": 1.0, "87s": 1.0, "76s": 1.0, "65s": 1.0,
            "AKo": 1.0, "AQo": 1.0, "AJo": 1.0, "ATo": 1.0, "A9o": 1.0, "A8o": 1.0, "A7o": 0.5, "A5o": 0.5,
            "KQo": 1.0, "KJo": 1.0, "KTo": 1.0, "K9o": 0.5, "QJo": 1.0, "QTo": 1.0, "JTo": 1.0
        },
        "vs_open_call": {},
        "vs_open_3bet": {}
    },
    "BB": {
        "vs_UTG": {
            "QQ": 0.5, "JJ": 1.0, "TT": 1.0, "99": 1.0, "88": 1.0, "77": 1.0, "66": 1.0, "55": 1.0,
            "AQs": 0.5, "AJs": 1.0, "ATs": 1.0, "A9s": 1.0, "A8s": 1.0, "A7s": 0.5, "A5s": 0.5,
            "KQs": 1.0, "KJs": 1.0, "KTs": 1.0, "K9s": 0.5, 
            "QJs": 1.0, "QTs": 1.0, "JTs": 1.0, "T9s": 1.0, "98s": 1.0, "87s": 1.0,
            "AQo": 1.0, "AJo": 1.0, "ATo": 0.5, "KQo": 1.0, "KJo": 0.5
        },
        "vs_MP": {
            "QQ": 0.5, "JJ": 1.0, "TT": 1.0, "99": 1.0, "88": 1.0, "77": 1.0, "66": 1.0, "55": 1.0, "44": 1.0,
            "AQs": 0.5, "AJs": 1.0, "ATs": 1.0, "A9s": 1.0, "A8s": 1.0, "A7s": 1.0, "A6s": 0.5, "A5s": 1.0, "A4s": 0.5,
            "KQs": 1.0, "KJs": 1.0, "KTs": 1.0, "K9s": 1.0, "K8s": 0.5,
            "QJs": 1.0, "QTs": 1.0, "Q9s": 1.0,
            "JTs": 1.0, "J9s": 1.0, "T9s": 1.0, "98s": 1.0, "87s": 1.0, "76s": 1.0,
            "AQo": 1.0, "AJo": 1.0, "ATo": 1.0, "A9o": 0.5, "KQo": 1.0, "KJo": 1.0, "QJo": 1.0
        },
        "vs_CO": {
            "QQ": 0.5, "JJ": 1.0, "TT": 1.0, "99": 1.0, "88": 1.0, "77": 1.0, "66": 1.0, "55": 1.0, "44": 1.0, "33": 1.0, "22": 1.0,
            "AQs": 0.5, "AJs": 1.0, "ATs": 1.0, "A9s": 1.0, "A8s": 1.0, "A7s": 1.0, "A6s": 1.0, "A5s": 1.0, "A4s": 1.0, "A3s": 1.0, "A2s": 1.0,
            "KQs": 1.0, "KJs": 1.0, "KTs": 1.0, "K9s": 1.0, "K8s": 1.0, "K7s": 1.0, "K6s": 0.5, "K5s": 0.5,
            "QJs": 1.0, "QTs": 1.0, "Q9s": 1.0, "Q8s": 1.0, "Q7s": 0.5,
            "JTs": 1.0, "J9s": 1.0, "J8s": 1.0, "T9s": 1.0, "T8s": 1.0, "98s": 1.0, "87s": 1.0, "76s": 1.0, "65s": 1.0, "54s": 0.5,
            "AQo": 1.0, "AJo": 1.0, "ATo": 1.0, "A9o": 1.0, "A8o": 0.5, "KQo": 1.0, "KJo": 1.0, "KTo": 1.0, "QJo": 1.0, "QTo": 1.0, "JTo": 1.0
        },
        "vs_BTN": {
            "QQ": 0.5, "JJ": 1.0, "TT": 1.0, "99": 1.0, "88": 1.0, "77": 1.0, "66": 1.0, "55": 1.0, "44": 1.0, "33": 1.0, "22": 1.0,
            "AQs": 0.5, "AJs": 1.0, "ATs": 1.0, "A9s": 1.0, "A8s": 1.0, "A7s": 1.0, "A6s": 1.0, "A5s": 1.0, "A4s": 1.0, "A3s": 1.0, "A2s": 1.0,
            "KQs": 1.0, "KJs": 1.0, "KTs": 1.0, "K9s": 1.0, "K8s": 1.0, "K7s": 1.0, "K6s": 1.0, "K5s": 1.0, "K4s": 1.0, "K3s": 1.0, "K2s": 1.0,
            "QJs": 1.0, "QTs": 1.0, "Q9s": 1.0, "Q8s": 1.0, "Q7s": 1.0, "Q6s": 0.5, "Q5s": 0.5,
            "JTs": 1.0, "J9s": 1.0, "J8s": 1.0, "J7s": 1.0, "T9s": 1.0, "T8s": 1.0, "T7s": 0.5, 
            "98s": 1.0, "97s": 1.0, "87s": 1.0, "86s": 1.0, "76s": 1.0, "75s": 0.5, "65s": 1.0, "64s": 0.5, "54s": 1.0,
            "AQo": 1.0, "AJo": 1.0, "ATo": 1.0, "A9o": 1.0, "A8o": 1.0, "A7o": 1.0, "A6o": 0.5, "A5o": 1.0, "A4o": 0.5,
            "KQo": 1.0, "KJo": 1.0, "KTo": 1.0, "K9o": 1.0, "K8o": 0.5, "QJo": 1.0, "QTo": 1.0, "Q9o": 1.0, "JTo": 1.0, "J9o": 1.0, "T9o": 1.0, "98o": 1.0
        },
        "vs_SB": {
            "QQ": 0.5, "JJ": 1.0, "TT": 1.0, "99": 1.0, "88": 1.0, "77": 1.0, "66": 1.0, "55": 1.0, "44": 1.0, "33": 1.0, "22": 1.0,
            "AQs": 0.5, "AJs": 1.0, "ATs": 1.0, "A9s": 1.0, "A8s": 1.0, "A7s": 1.0, "A6s": 1.0, "A5s": 1.0, "A4s": 1.0, "A3s": 1.0, "A2s": 1.0,
            "KQs": 1.0, "KJs": 1.0, "KTs": 1.0, "K9s": 1.0, "K8s": 1.0, "K7s": 1.0, "K6s": 1.0, "K5s": 1.0, "K4s": 1.0, "K3s": 1.0, "K2s": 1.0,
            "QJs": 1.0, "QTs": 1.0, "Q9s": 1.0, "Q8s": 1.0, "Q7s": 1.0, "Q6s": 1.0, "Q5s": 1.0,
            "JTs": 1.0, "J9s": 1.0, "J8s": 1.0, "J7s": 1.0, "T9s": 1.0, "T8s": 1.0, "T7s": 1.0, 
            "98s": 1.0, "97s": 1.0, "87s": 1.0, "86s": 1.0, "76s": 1.0, "75s": 1.0, "65s": 1.0, "64s": 0.5, "54s": 1.0,
            "AQo": 1.0, "AJo": 1.0, "ATo": 1.0, "A9o": 1.0, "A8o": 1.0, "A7o": 1.0, "A6o": 1.0, "A5o": 1.0, "A4o": 1.0, "A3o": 0.5, "A2o": 0.5,
            "KQo": 1.0, "KJo": 1.0, "KTo": 1.0, "K9o": 1.0, "K8o": 1.0, "K7o": 0.5, "QJo": 1.0, "QTo": 1.0, "Q9o": 1.0, "Q8o": 0.5,
            "JTo": 1.0, "J9o": 1.0, "J8o": 0.5, "T9o": 1.0, "T8o": 0.5, "98o": 1.0, "87o": 1.0
        }
    }
}


class HandRange:
    """
    Encapsulates range structure, weighting, combo expansion, and updating rules.
    """
    def __init__(self, combos_dict=None):
        if combos_dict is None:
            self.combos = ALL_HANDS_DICT.copy()
        else:
            self.combos = combos_dict.copy()
            
    def get_raw_dict(self):
        return self.combos

def get_range_by_category(category, action="open"):
    """
    Returns the weighted dictionary for a position and action state.
    """
    pos_data = RANGES.get(category, {})
    
    # Handle BB specific logic (vs_ position)
    if category == "BB" and action.startswith("vs_"):
        return pos_data.get(action, ALL_HANDS_DICT)
        
    return pos_data.get(action, ALL_HANDS_DICT)

def parse_combo(combo_str):
    """
    Parses a string like 'AKs' or 'JJ' into a list of specific card strings 
    for Treys evaluator e.g. ['As', 'Ks'], ['Ah', 'Kh'], etc.
    """
    ranks = '23456789TJQKA'
    suits = 'shdc'
    
    if len(combo_str) == 2:  # Pair e.g. 'AA'
        rank = combo_str[0]
        combos = []
        for i in range(len(suits)):
            for j in range(i+1, len(suits)):
                combos.append([rank+suits[i], rank+suits[j]])
        return combos
    
    elif len(combo_str) == 3:
        rank1, rank2, stype = combo_str[0], combo_str[1], combo_str[2]
        combos = []
        if stype == 's': # Suited
            for s in suits:
                combos.append([rank1+s, rank2+s])
        elif stype == 'o': # Offsuit
            for s1 in suits:
                for s2 in suits:
                    if s1 != s2:
                        combos.append([rank1+s1, rank2+s2])
        return combos
    
    return []

def get_possible_hole_cards_weighted(range_category, action="open", dead_cards=None):
    """
    Returns a list of tuples: [ (['As', 'Ks'], 1.0), (['Ah', 'Qc'], 0.5), ... ]
    Automatically expands string representations and strips dead cards.
    """
    if dead_cards is None:
        dead_cards = []
        
    hands_dict = get_range_by_category(range_category, action)
    all_valid_combos_weighted = []
    
    for combo_str, weight in hands_dict.items():
        if weight <= 0.0:
            continue
            
        specific_combos = parse_combo(combo_str)
        for combo in specific_combos:
            if not any(c in dead_cards for c in combo):
                all_valid_combos_weighted.append((combo, weight))
                
    return all_valid_combos_weighted

from treys import Card

def sort_range_by_strength(range_dict, board=None, treys_evaluator=None):
    """
    Sorts a range dictionary from strongest to weakest based on preflop heuristics 
    or postflop Treys exact evaluation against the current board sequence.
    """
    def preflop_strength(combo_str):
        if not combo_str:
            return (0, 0, 0)
        rank_map = {'A':14, 'K':13, 'Q':12, 'J':11, 'T':10, '9':9, '8':8, '7':7, '6':6, '5':5, '4':4, '3':3, '2':2}
        r1 = rank_map.get(combo_str[0], 0)
        r2 = rank_map.get(combo_str[1], 0) if len(combo_str) > 1 else 0
        if r2 > r1:
            r1, r2 = r2, r1
        if len(combo_str) >= 2 and combo_str[0] == combo_str[1]:
            return (3, r1, r2)
        elif len(combo_str) >= 3 and combo_str[2] == 's':
            return (2, r1, r2)
        else:
            return (1, r1, r2)
            
    if board is None or treys_evaluator is None or len(board) == 0:
        return sorted(range_dict.keys(), key=preflop_strength, reverse=True)
    else:
        dead_cards_str = [Card.int_to_str(c) for c in board]
        
        def postflop_strength(combo_str):
            combos = parse_combo(combo_str)
            best_score = 9999
            for c_str_list in combos:
                if not any(c in dead_cards_str for c in c_str_list):
                    c_ints = [Card.new(c) for c in c_str_list]
                    score = treys_evaluator.evaluate(board, c_ints)
                    if score < best_score:
                        best_score = score
            return best_score
            
        # Treys returns lower integers for stronger hands
        return sorted(range_dict.keys(), key=postflop_strength, reverse=False)

def update_range_after_action(range_dict, action_type, bet_size=None, board=None, treys_evaluator=None):
    """
    Simulates positional polarization and merging over the dict representation of a range
    based on the actions taken. (LARGE_BET, SMALL_BET, CALL, FOLD)
    """
    if not range_dict:
        return {}
        
    updated_range = {}
    
    if action_type == "FOLD":
        for k in range_dict:
            updated_range[k] = 0.0
        return updated_range
        
    sorted_combos = sort_range_by_strength(range_dict, board, treys_evaluator)
    total_combos = len(sorted_combos)
    
    if total_combos == 0:
        return updated_range
        
    for i, combo in enumerate(sorted_combos):
        percentile = i / total_combos
        
        weight = range_dict[combo]
        if weight <= 0.0:
            updated_range[combo] = 0.0
            continue
            
        new_weight = weight
        if action_type == "LARGE_BET":
            if percentile < 0.30:
                new_weight = 1.0 # Top 30% Strong
            elif percentile < 0.70:
                new_weight = 0.0 # Middle 40% 
            else:
                new_weight = 1.0 # Bottom 30% Bluffs
        elif action_type == "SMALL_BET":
            if percentile < 0.50:
                new_weight = 1.0 # Top 50% merges
            elif percentile < 0.80:
                new_weight = 0.5 # Middle merges partially
            else:
                new_weight = 0.0 # Bottom yields
        elif action_type == "CALL":
            if percentile < 0.20:
                new_weight = 0.5 # Top 20% usually raises, reduced weight in calling range
            elif percentile < 0.80:
                new_weight = 1.0 # Middle merges as stable calls
            else:
                new_weight = 0.0 # Bottom folds
                
        updated_range[combo] = max(0.0, min(1.0, float(new_weight)))
        
    return updated_range
