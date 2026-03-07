import random
from treys import Card

def sample_range(range_dict, dead_cards_str=None):
    """
    range_dict: {"AKs": 1.0, "QQ": 0.5, "AhKh": 1.0...}
    dead_cards_str: List of string formatted cards ["Ah", "Kc"]
    
    Returns: List of specific Card int arrays representing the sampled combo,
             e.g. [Card.new('Ah'), Card.new('Kh')]
    """
    if dead_cards_str is None:
        dead_cards_str = []
        
    import ranges
    valid_combos_weighted = []
    
    for combo_str, weight in range_dict.items():
        if weight <= 0.0: continue
        parsed = ranges.parse_combo(combo_str)
        for specific_cards_str in parsed:
            # Check dead cards
            if not any(c in dead_cards_str for c in specific_cards_str):
                valid_combos_weighted.append((specific_cards_str, weight))
                
    if not valid_combos_weighted:
        return None
        
    total_weight = sum(w for _, w in valid_combos_weighted)
    if total_weight <= 0:
        chosen_str = random.choice(valid_combos_weighted)[0]
    else:
        r = random.uniform(0, total_weight)
        cum = 0.0
        chosen_str = valid_combos_weighted[-1][0]
        for combo, weight in valid_combos_weighted:
            cum += weight
            if r <= cum:
                chosen_str = combo
                break
                
    return [Card.new(c) for c in chosen_str]

def normalize_range(weights):
    floor_val = 0.05
    for k in weights:
        if weights[k] < floor_val:
            weights[k] = floor_val
    total = sum(weights.values())
    if total > 0:
        for k in weights:
            weights[k] /= total
    return weights
