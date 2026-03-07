from treys import Card, Evaluator as TreysEvaluator

class HandClassifier:
    @staticmethod
    def detect_draw_strength(cards, board):
        if not board:
            return "NONE"
            
        ranks = sorted(list(set([Card.get_rank_int(c) for c in cards + board])))
        suits = [Card.get_suit_int(c) for c in cards + board]
        suit_counts = {s: suits.count(s) for s in set(suits)}
        max_suit = max(suit_counts.values()) if suit_counts else 0

        is_flush_draw = (max_suit == 4)
        is_oesd = False
        is_gutshot = False

        # Wheel straight check (A, 2, 3, 4, 5) where A=12, 2=0, 3=1, 4=2, 5=3
        # In treys: 2=0, 3=1, 4=2, 5=3... A=12
        if 12 in ranks:
            wheel_ranks = sorted([r for r in ranks if r in [0, 1, 2, 3]] + [-1]) # -1 represents Ace for wheel
            if len(wheel_ranks) >= 4:
                for i in range(len(wheel_ranks)-3):
                    window = wheel_ranks[i:i+4]
                    if max(window) - min(window) == 3:
                        is_oesd = True
                    elif max(window) - min(window) == 4:
                        is_gutshot = True

        for i in range(len(ranks)-3):
            window = ranks[i:i+4]
            if max(window) - min(window) == 3:
                is_oesd = True
            elif max(window) - min(window) == 4:
                is_gutshot = True

        if is_flush_draw and (is_oesd or is_gutshot):
            return "STRONG_DRAW" # Combo draw
        elif is_oesd:
            return "STRONG_DRAW" # Open-ended straight draw
        elif is_flush_draw:
            return "STRONG_DRAW" # Flush draw
        elif is_gutshot:
            return "MEDIUM_DRAW" # Gutshot straight draw
        elif max_suit == 3:
            return "WEAK_DRAW"   # Backdoor flush draw
            
        return "NONE"

    @staticmethod
    def categorize_hand(cards, board=None):
        """
        Categorize hand into 8 discrete buckets for heuristic modeling:
        NUT_HAND, STRONG_MADE, MEDIUM_MADE, WEAK_MADE, 
        STRONG_DRAW, MEDIUM_DRAW, WEAK_DRAW, AIR
        """
        if not cards or len(cards) < 2:
            return "AIR"
            
        r1 = Card.get_rank_int(cards[0])
        r2 = Card.get_rank_int(cards[1])
        s1 = Card.get_suit_int(cards[0])
        s2 = Card.get_suit_int(cards[1])
        is_suited = (s1 == s2)
            
        # Postflop evaluation
        if board and len(board) >= 3:
            evaluator = TreysEvaluator()
            score = 7462 # Default worst score
            try:
                score = evaluator.evaluate(board, cards)
            except:
                pass
            
            # Use explicit GTO threshold rules requested by user
            if score < 1600:
                return "NUT_HAND"
            elif score < 3000:
                return "STRONG_MADE"
            elif score < 5000:
                return "MEDIUM_MADE"
            else:
                # WEAK_MADE or AIR, priority to draws
                draw_strength = HandClassifier.detect_draw_strength(cards, board)
                if draw_strength != "NONE":
                    return draw_strength
                    
                if score <= 6185:
                    return "WEAK_MADE"
                else:
                    return "AIR"
                
        # Preflop basic heuristic categories
        if is_suited:
            if r1 >= 10 and r2 >= 10:
                return "STRONG_DRAW"
                
        if r1 >= 10 and r2 >= 10:
             return "STRONG_MADE"
             
        if r1 == r2:
            if r1 >= 9: return "STRONG_MADE"
            if r1 >= 5: return "MEDIUM_MADE"
            return "WEAK_MADE"
            
        return "AIR"

    @staticmethod
    def classify_board_texture(board):
        """
        board: Board Cards
        return: 'dry', 'semi_wet', 'wet', 'paired', 'monotone'
        """
        if len(board) == 0:
             return "dry"
        
        suits = [Card.get_suit_int(c) for c in board]
        ranks = [Card.get_rank_int(c) for c in board]
        
        suit_counts = {s: suits.count(s) for s in set(suits)}
        rank_counts = {r: ranks.count(r) for r in set(ranks)}
        max_suit = max(suit_counts.values()) if suit_counts else 0
        
        # 1. Monotone
        if max_suit >= 3:
            return "monotone"
            
        # 2. Paired board
        if max(rank_counts.values()) >= 2:
            return "paired"
            
        # Connectivity Assessment
        sorted_ranks = sorted(ranks, reverse=True)
        is_highly_connected = False
        is_semi_connected = False
        
        if len(sorted_ranks) >= 3:
            for i in range(len(sorted_ranks) - 2):
                 gap = sorted_ranks[i] - sorted_ranks[i+2]
                 if gap <= 3: # 7 6 5, J T 8 (OESD/Gutter dense)
                      is_highly_connected = True
                 elif gap <= 4: # Q 9 8, K T 8 (Some gutters)
                      is_semi_connected = True
                      
        # 3. Wet
        if max_suit == 2 and is_highly_connected:
            return "wet"
            
        # 4. Semi_wet
        if max_suit == 2 or is_highly_connected or is_semi_connected:
            return "semi_wet"
            
        # 5. Dry
        return "dry"
