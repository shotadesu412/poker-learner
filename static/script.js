// script.js
let currentState = null;
let currentBetPercent = 50;
let isWaitingForAction = true;

// AI Coach Global States
let coachMessages = [];

const POKER_GLOSSARY = {
    "GTO": "Game Theory Optimalの略。\nお互いが最適な防衛戦略をとることで誰も搾取（負か）されない数学的最適戦略。",
    "MDF": "Minimum Defense Frequency（最低防衛頻度）。\n相手のベットに対して自分が最低限コールやレイズで守るべきハンドの割合。",
    "SPR": "Stack to Pot Ratio（スタック対ポット比）。\n残りのスタック（チップ量）がポットに対してどれくらい大きいかを示す指標。",
    "ドンクベット": "自分にアグレッサー（イニシアチブ）がないのにOOPから先にベットすること。",
    "ポラライズ": "極端に強いハンド（ナッツ級）と弱いハンド（ブラフ）の2極端なレンジでプレイすること。大きなベットサイズになる。",
    "Cベット": "コンティニュエーション・ベット。\n前のストリートでアグレッサーだったプレイヤーが、フロップ以降でも継続して打つベット。",
    "レンジアドバンテージ": "あなたのレンジ全体が持つ勝率が、相手のレンジの勝率よりも高い（有利な）状態。",
    "エクイティ": "勝率のこと。そのハンドがポットを獲得できる確率の期待値。"
};

function linkifyGlossary(text) {
    if (!text) return text;
    let replacedText = text;
    Object.keys(POKER_GLOSSARY).forEach(term => {
        // Simple global string replace ignoring context bounds for MVP
        // In robust production this would use Regex word boundaries (\b またはポジティブ先読み等)
        const regex = new RegExp(`(${term})`, 'g');
        const tooltip = POKER_GLOSSARY[term];
        replacedText = replacedText.replace(regex, `<span class="glossary-term" data-tooltip="${tooltip}">$1</span>`);
    });
    return replacedText;
}

// Utility UI Handlers
function el(id) { return document.getElementById(id); }

function updateHTML(id, val) {
    if (el(id)) el(id).innerHTML = val;
}

// Map treys rank/suit representations to visual ones
const suitMap = {
    's': { symbol: '♠', color: 'black' },
    'h': { symbol: '♥', color: 'red' },
    'd': { symbol: '♦', color: 'red' },
    'c': { symbol: '♣', color: 'black' }
};

function parseCardStr(cardStr) {
    if (!cardStr || cardStr.length !== 2) return null;
    const rank = cardStr[0] === 'T' ? '10' : cardStr[0];
    const suitChar = cardStr[1].toLowerCase();

    if (!suitMap[suitChar]) return { rank, symbol: '?', color: 'black' };

    return { rank, symbol: suitMap[suitChar].symbol, color: suitMap[suitChar].color };
}

function renderCards(containerId, cardsArray, maxCards) {
    const container = el(containerId);
    container.innerHTML = "";

    for (let i = 0; i < maxCards; i++) {
        if (i < cardsArray.length) {
            const parsed = parseCardStr(cardsArray[i]);
            if (parsed) {
                container.innerHTML += `
                <div class="card ${parsed.color}">
                    <span class="rank">${parsed.rank}</span>
                    <span class="main-val">${parsed.symbol}</span>
                    <span class="suit">${parsed.symbol}</span>
                </div>
                `;
            }
        } else {
            container.innerHTML += `<div class="empty-card"></div>`;
        }
    }
}

function updateUI() {
    if (!currentState) return;

    if (currentState.finished) {
        updateHTML('street-display', "SHOWDOWN");
    } else {
        updateHTML('street-display', currentState.street);
    }

    updateHTML('pot-size', currentState.potSize.toFixed(1));
    updateHTML('hero-stack', currentState.heroStack.toFixed(1));
    updateHTML('cpu-stack', currentState.cpuStack.toFixed(1));
    updateHTML('hero-pos', `(${currentState.heroPos})`);
    updateHTML('cpu-pos', `(${currentState.cpuPos})`);
    updateHTML('equity-val', currentState.equity);

    if (currentState.heroRange) {
        el('hero-range-strong').style.width = `${currentState.heroRange.strong * 100}%`;
        el('hero-range-strong').innerText = `${Math.round(currentState.heroRange.strong * 100)}%`;
        el('hero-range-mid').style.width = `${currentState.heroRange.middle * 100}%`;
        el('hero-range-mid').innerText = `${Math.round(currentState.heroRange.middle * 100)}%`;
        el('hero-range-weak').style.width = `${currentState.heroRange.weak * 100}%`;
        el('hero-range-weak').innerText = `${Math.round(currentState.heroRange.weak * 100)}%`;
    }

    if (currentState.cpuRange) {
        el('cpu-range-strong').style.width = `${currentState.cpuRange.strong * 100}%`;
        el('cpu-range-strong').innerText = `${Math.round(currentState.cpuRange.strong * 100)}%`;
        el('cpu-range-mid').style.width = `${currentState.cpuRange.middle * 100}%`;
        el('cpu-range-mid').innerText = `${Math.round(currentState.cpuRange.middle * 100)}%`;
        el('cpu-range-weak').style.width = `${currentState.cpuRange.weak * 100}%`;
        el('cpu-range-weak').innerText = `${Math.round(currentState.cpuRange.weak * 100)}%`;
    }

    if (currentState.bluffRatio !== undefined) {
        updateHTML('bluff-ratio-val', currentState.bluffRatio);
    }

    renderCards('board-container', currentState.board, 5);
    renderCards('hero-cards', currentState.heroHand, 2);

    // CPU cards only available when game finishes in Showdown (backend clears it otherwise)
    if (currentState.cpuHand && currentState.cpuHand.length > 0) {
        renderCards('cpu-cards', currentState.cpuHand, 2);
    } else {
        renderCards('cpu-cards', [], 2); // default hidden empty slots
    }

    // Toggle actions based on game finish state
    if (currentState.finished) {
        el('action-area').classList.add('hidden');
        el('restart-area').classList.remove('hidden');
    } else {
        el('action-area').classList.remove('hidden');
        el('restart-area').classList.add('hidden');

        // Handle mutually exclusive action buttons cleanly based on whether there's a strict VOLUNTARY bet
        const hasVoluntaryBet = (currentState.street === "PREFLOP" && currentState.currentBet > 1.0) ||
            (currentState.street !== "PREFLOP" && currentState.currentBet > 0);

        if (hasVoluntaryBet) {
            el('btn-check').style.display = 'none';
            el('btn-bet').style.display = 'none';

            el('btn-call').style.display = '';
            el('btn-raise').style.display = '';
            el('btn-call').innerText = `コール (${currentState.facingBet.toFixed(1)}bb)`;
            el('btn-fold').disabled = false;
        } else {
            el('btn-raise').style.display = 'none';

            // Unopened pot: if facing the 1bb blind (or limp) we can still Call (Limp)
            if (currentState.facingBet > 0) {
                el('btn-call').style.display = '';
                el('btn-call').innerText = `コール (${currentState.facingBet.toFixed(1)}bb)`;
                el('btn-check').style.display = 'none';
            } else {
                el('btn-call').style.display = 'none';
                el('btn-check').style.display = '';
            }

            el('btn-bet').style.display = '';
            el('btn-fold').disabled = false;
        }
    }
}

// Interaction
async function startHand() {
    el('eval-history').innerHTML = "";
    el('message-area').classList.add('hidden');

    // Hide reason box on new hand
    const reasonArea = el('reason-area');
    if (reasonArea) {
        reasonArea.classList.remove('show');
        reasonArea.classList.add('hidden');
    }

    // Reset Chat Array and Hide UI
    coachMessages = [];
    el('ai-coach-area').classList.add('hidden');
    el('coach-chat-history').innerHTML = "";
    if (el('coach-input')) el('coach-input').value = "";

    try {
        const res = await fetch('/api/start_hand');
        currentState = await res.json();
        updateUI();

        // Render CPU's first action if they act before the player preflop
        if (currentState.cpuMessage) {
            setTimeout(() => {
                addEvaluationToHistory("", currentState.cpuMessage, "");
            }, 500);
        }
    } catch (e) {
        console.error(e);
        alert("Server communication error");
    }
}

async function takeAction(actionType, amount = 0) {
    if (!currentState || currentState.finished) return;

    // Disable buttons temporarily
    document.querySelectorAll('.action-btn').forEach(b => b.disabled = true);

    // Hide previous reason immediately on new action click
    const reasonArea = el('reason-area');
    if (reasonArea) {
        reasonArea.classList.remove('show');
        reasonArea.classList.add('hidden');
    }

    try {
        const res = await fetch('/api/action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: actionType, amount: amount })
        });
        const data = await res.json();

        // Show evaluation animation
        const actionText = amount > 0 ? `${actionType} ${amount.toFixed(1)}bb` : actionType;
        showEvaluation(data.evaluation || "", actionText);

        // Wait for the popup animation to vanish then show reason UI
        setTimeout(() => {
            if (data.evaluation && data.reason) {
                showReason(data.evaluation, data.reason);
            }
        }, 800);

        // Render CPU response if exists
        if (data.cpuMessage) {
            setTimeout(() => {
                addEvaluationToHistory("", data.cpuMessage, "eval-O");
            }, 1000); // 1s delay to seem like CPU is "thinking" after evaluation
        }

        // Update state
        currentState = data.state;

        if (data.message) {
            el('message-area').innerText = data.message;
            el('message-area').classList.remove('hidden');
        }

    } catch (e) {
        console.error(e);
        alert("Action failed to process");
    } finally {
        setTimeout(() => {
            // Re-enable all buttons unconditionally; updateUI will handle hiding the main action area anyway
            document.querySelectorAll('.action-btn').forEach(b => b.disabled = false);
            updateUI();
        }, 1200); // Prevent mashing during animations
    }
}

// Bet Panel UI Logic
function getActionSizes(actionType) {
    let options = [];
    const street = currentState.street; // "PREFLOP", "FLOP", "TURN", "RIVER"
    const pot = currentState.potSize;
    const facing = currentState.facingBet;

    if (street === "PREFLOP") {
        if (actionType === "BET") { // Open raise
            options = [
                { label: "Small (2.0bb)", amount: 2.0 },
                { label: "Medium (2.5bb)", amount: 2.5 },
                { label: "Large (3.0bb)", amount: 3.0 }
            ];
        } else { // 3bet+
            if (facing <= 4.0) { // arbitrary threshold for standard 3bet
                options = [
                    { label: "Small (2.7x)", amount: facing * 2.7 },
                    { label: "Medium (3.0x)", amount: facing * 3.0 },
                    { label: "Large (3.5x)", amount: facing * 3.5 }
                ];
            } else { // 4bet+
                options = [
                    { label: "Small (2.2x)", amount: facing * 2.2 },
                    { label: "Medium (2.5x)", amount: facing * 2.5 },
                    { label: "Large (2.8x)", amount: facing * 2.8 }
                ];
            }
        }
    } else { // POSTFLOP
        if (actionType === "BET") {
            let mults = [0.33, 0.55, 0.85]; // FLOP
            if (street === "TURN") mults = [0.33, 0.66, 1.0];
            if (street === "RIVER") mults = [0.33, 0.75, 1.5];

            options = [
                { label: `小 Small (${Math.round(mults[0] * 100)}% pot)`, amount: pot * mults[0] },
                { label: `中 Medium (${Math.round(mults[1] * 100)}% pot)`, amount: pot * mults[1] },
                { label: `大 Large (${Math.round(mults[2] * 100)}% pot)`, amount: pot * mults[2] }
            ];
        } else { // RAISE POSTFLOP
            let mults = [2.5, 3.5, 4.5]; // FLOP / TURN
            if (street === "RIVER") mults = [2.5, 3.5, 5.0];

            options = [
                { label: `小 Small (${mults[0]}x)`, amount: facing * mults[0] },
                { label: `中 Medium (${mults[1]}x)`, amount: facing * mults[1] },
                { label: street === "RIVER" ? "All-in (5.0x)" : `大 Large (${mults[2]}x)`, amount: facing * mults[2] }
            ];
        }
    }

    // round to 1 decimal place cleanly
    return options.map(o => ({
        label: o.label,
        amount: Math.round(o.amount * 10) / 10
    }));
}

function openBetPanel(actionType) {
    el('bet-panel').classList.add('active');
    el('modal-overlay').classList.add('active');

    const hasVoluntaryBet = (currentState.street === "PREFLOP" && currentState.currentBet > 1.0) ||
        (currentState.street !== "PREFLOP" && currentState.currentBet > 0);

    if (!actionType) actionType = hasVoluntaryBet ? "RAISE" : "BET";
    const isRaising = actionType === "RAISE";

    // Update Modal Title
    const headerTitle = el('bet-panel').querySelector('h3');
    if (headerTitle) {
        headerTitle.innerText = isRaising ? "レイズサイズ選択" : "ベットサイズ選択";
    }

    const container = el('dynamic-bet-options');
    container.innerHTML = ''; // clear

    const sizes = getActionSizes(actionType);

    sizes.forEach(s => {
        const btn = document.createElement('button');

        // Add specific class for Raise styling dynamically
        if (isRaising) {
            btn.className = 'action-btn btn-raise full-width';
        } else {
            btn.className = 'action-btn btn-primary full-width';
        }

        btn.style.padding = '15px';
        btn.style.fontSize = '1.2rem';
        btn.style.marginBottom = '10px';
        btn.style.borderRadius = '8px';
        btn.innerText = s.label + ` (${s.amount.toFixed(1)} bb)`;
        btn.onclick = () => {
            closeBetPanel();
            takeAction(actionType, s.amount);
        };
        container.appendChild(btn);
    });
}

// Removing legacy adjustment and static styling functions
function closeBetPanel() {
    el('bet-panel').classList.remove('active');
    el('modal-overlay').classList.remove('active');
}

// Reason UI Feedback
function showReason(symbol, text) {
    const reasonArea = el('reason-area');
    const symbolSpn = el('reason-symbol');
    const textDiv = el('reason-text');

    if (!reasonArea) return;

    symbolSpn.innerText = symbol;
    textDiv.innerText = text;

    // Colorize based on eval mapping
    let colorVar = "var(--border-color)";
    let textVar = "white";

    if (symbol === "◎") { colorVar = "var(--eval-optimal)"; textVar = "var(--eval-optimal)"; }
    else if (symbol === "◯") { colorVar = "var(--eval-good)"; textVar = "var(--eval-good)"; }
    else if (symbol === "△") { colorVar = "var(--eval-marginal)"; textVar = "var(--eval-marginal)"; }
    else if (symbol === "×") { colorVar = "var(--eval-bad)"; textVar = "var(--eval-bad)"; }

    reasonArea.style.borderLeftColor = colorVar;
    symbolSpn.style.color = textVar;

    // Unhide and trigger animation
    reasonArea.classList.remove('hidden');
    // small reflow delay so CSS transforms engage
    setTimeout(() => {
        reasonArea.classList.add('show');
    }, 10);
}

// Evaluation UI Feedback
function showEvaluation(evalSymbol, actionName) {
    const popup = el('eval-popup');
    popup.innerText = evalSymbol;

    // Reset classes
    popup.className = "eval-popup";
    let colorClass = "";
    if (evalSymbol === "◎") colorClass = "eval-OO";
    else if (evalSymbol === "◯") colorClass = "eval-O";
    else if (evalSymbol === "△") colorClass = "eval-T";
    else if (evalSymbol === "×") colorClass = "eval-X";

    popup.classList.add(colorClass);
    popup.classList.add('show');

    setTimeout(() => {
        popup.classList.remove('show');
        addEvaluationToHistory(evalSymbol, actionName, colorClass);
    }, 800);
}

function addEvaluationToHistory(symbol, action, colorClass) {
    const history = el('eval-history');
    const item = document.createElement('div');
    item.className = 'history-item';
    const symbolHtml = symbol ? `<span class="${colorClass}">${symbol}</span>` : '';
    item.innerHTML = `<span>${action}</span> ${symbolHtml}`;
    history.prepend(item);

    // limit history depth
    if (history.children.length > 5) {
        history.removeChild(history.lastChild);
    }
}

// ============================================
// AI Coach Chat integration
// ============================================

function renderCoachChat() {
    const chatContainer = el('coach-chat-history');
    chatContainer.innerHTML = "";

    coachMessages.forEach(msg => {
        if (msg.role === "system") return; // Keep system hidden

        const div = document.createElement('div');
        div.className = `chat-bubble ${msg.role === 'user' ? 'user' : 'assistant'}`;

        if (msg.isLoading) {
            div.innerHTML = `<span class="chat-loading">...</span>`;
        } else {
            // Convert definitions into tooltips before insertion
            div.innerHTML = linkifyGlossary(msg.content);
        }

        chatContainer.appendChild(div);
    });

    chatContainer.scrollTop = chatContainer.scrollHeight;
}

async function requestCoachExplanation() {
    el('ai-coach-area').classList.remove('hidden');
    el('btn-ai-coach').disabled = true;

    // Build the request array if empty
    if (coachMessages.length === 0) {
        coachMessages.push({ role: "user", content: "このハンド全体を通じて私が改善するべき点や、良かった点を簡潔に解説してください。" });

        // Push a loading placeholder
        coachMessages.push({ role: "assistant", isLoading: true });
        renderCoachChat();

        try {
            const response = await fetch('/api/ai_coach', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages: coachMessages.filter(m => !m.isLoading) })
            });
            const data = await response.json();

            // Remove loader, add real reply
            coachMessages.pop();
            coachMessages.push({ role: "assistant", content: data.reply });
        } catch (e) {
            coachMessages.pop();
            coachMessages.push({ role: "assistant", content: "コーチに接続できませんでした。" });
        }

        renderCoachChat();
    }

    el('btn-ai-coach').disabled = false;
}

async function sendCoachMessage() {
    const input = el('coach-input');
    const text = input.value.trim();
    if (!text) return;

    // Disable inputs
    input.value = "";
    input.disabled = true;
    el('btn-coach-send').disabled = true;

    // Push User message
    coachMessages.push({ role: "user", content: text });
    coachMessages.push({ role: "assistant", isLoading: true });
    renderCoachChat();

    try {
        const response = await fetch('/api/ai_coach', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages: coachMessages.filter(m => !m.isLoading) })
        });
        const data = await response.json();

        // Remove loader, add real reply
        coachMessages.pop();
        coachMessages.push({ role: "assistant", content: data.reply });
    } catch (e) {
        coachMessages.pop();
        coachMessages.push({ role: "assistant", content: "送信に失敗しました。" });
    }

    input.disabled = false;
    el('btn-coach-send').disabled = false;
    renderCoachChat();
    input.focus();
}

function handleCoachInputKeyPress(event) {
    if (event.key === 'Enter') {
        sendCoachMessage();
    }
}

// Init
document.addEventListener('DOMContentLoaded', () => {
    startHand();
});
