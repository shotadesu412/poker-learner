# bet_sizing.py

# GTO Theory Constraints
PREFLOP_OPENS = {
    "UTG": 2.5,
    "HJ": 2.5,
    "CO": 2.3,
    "BTN": 2.2,
    "SB": 2.5,
    "BB": 0.0 # BB does not strictly open
}

PREFLOP_3BET = {
    "IP": 2.8,
    "OOP": 3.5
}

# Updated GTO Bet Sizing
BET_SIZES = {
    "FLOP": {"small": 0.33, "medium": 0.50, "large": 0.75}, # Pot fraction (Requested GTO mainstream sizing)
    "TURN": {"small": 0.33, "medium": 0.66, "large": 1.00},
    "RIVER": {"small": 0.50, "medium": 1.00, "large": 1.50}  # 1.5 = Overbet
}

RAISE_MULTIPLIER = { # Generalized Fallback postflop multi
    "FLOP": {"small": 2.5, "medium": 3.0, "large": 3.5},
    "TURN": {"small": 2.5, "medium": 3.0, "large": 3.5},
    "RIVER": {"small": 2.5, "medium": 3.0, "large": 5.0} # or all-in
}

TEXTURE_MULTIPLIER = {
    "dry": 1.15,
    "semi_wet": 1.0,
    "wet": 0.85,
    "paired": 1.1
}

POSITION_MULTIPLIER = {
    "IP": 1.1,
    "OOP": 0.9
}

# Updated SPR Categories
SPR_MULTIPLIER = {
    "ultra_low": 0.7, # SPR < 1
    "low": 0.85,      # 1 <= SPR < 3
    "mid": 1.0,       # 3 <= SPR <= 6
    "high": 1.15      # SPR > 6
}

# --- Evaluation Indicators ---
EVAL_OPTIMAL = "◎"
EVAL_GOOD = "◯"
EVAL_MARGINAL = "△"
EVAL_BAD = "×"
