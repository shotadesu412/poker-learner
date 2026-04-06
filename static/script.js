// script.js
let currentState = null;
let currentBetPercent = 50;
let isWaitingForAction = true;

// Global settings loaded from localStorage
let appSettings = JSON.parse(localStorage.getItem("poker_settings")) || {
    showEquity: true,
    showRange: true,
    showFeedback: true,
    speed: "normal"
};
const speedMult = appSettings.speed === "fast" ? 0.4 : 1.0;

// User ID for Saved Hands
let currentUserId = localStorage.getItem("poker_user_id");
if (!currentUserId) {
    currentUserId = 'user_' + Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
    localStorage.setItem("poker_user_id", currentUserId);
}

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

function renderFaceDownCards(containerId, count) {
    const container = el(containerId);
    container.innerHTML = "";
    for (let i = 0; i < count; i++) {
        container.innerHTML += `<div class="face-down-card"></div>`;
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

    // Apply visibility settings
    document.querySelectorAll('.equity-display').forEach(el => {
        if (!appSettings.showEquity) {
            el.style.display = 'none';
        } else {
            // Restore default (empty means fallback to css rule or block)
            el.style.display = '';
        }
    });

    const rangesContainer = document.querySelector('.ranges-container');
    if (rangesContainer) {
        if (!appSettings.showRange) {
            rangesContainer.style.display = 'none';
        } else {
            rangesContainer.style.display = 'flex'; // Default is usually flex
        }
    }

    renderCards('board-container', currentState.board, 5);
    renderCards('hero-cards', currentState.heroHand, 2);

    // CPU cards only available when game finishes in Showdown (backend clears it otherwise)
    if (currentState.cpuHand && currentState.cpuHand.length > 0) {
        renderCards('cpu-cards', currentState.cpuHand, 2);
    } else {
        renderFaceDownCards('cpu-cards', 2);
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
// ボード / 履歴の表示切り替え
let historyOnTop = false;
function toggleHistoryBoard() {
    historyOnTop = !historyOnTop;
    const history = el('eval-history');
    const boardArea = document.querySelector('.board-area');
    if (historyOnTop) {
        if (history) history.style.zIndex = '60';
        if (boardArea) boardArea.style.zIndex = '10';
        const btn = el('btn-toggle-history');
        if (btn) btn.textContent = '📋→ボード';
    } else {
        if (history) history.style.zIndex = '10';
        if (boardArea) boardArea.style.zIndex = '60';
        const btn = el('btn-toggle-history');
        if (btn) btn.textContent = '📋履歴';
    }
}

async function startHand() {
    el('eval-history').innerHTML = "";
    el('message-area').classList.add('hidden');

    // ツマミを非表示にしてリセット
    const handle = el('eval-handle');
    if (handle) handle.classList.add('hidden');
    reasonDrawerOpen = false;

    // Hide reason box on new hand
    const reasonArea = el('reason-area');
    if (reasonArea) {
        reasonArea.classList.remove('show');
        reasonArea.classList.add('hidden');
    }

    // Reset Chat Array and Hide UI
    coachMessages = [];
    el('ai-coach-area').classList.remove('show');
    el('ai-coach-area').classList.add('hidden');
    el('coach-chat-history').innerHTML = "";
    if (el('coach-input')) el('coach-input').value = "";

    try {
        const res = await fetch(`/api/start_hand?user_id=${encodeURIComponent(currentUserId)}`);
        currentState = await res.json();
        updateUI();

        // ハンドカウンターをインクリメント & 広告チェック
        incrementHandCount();
        if (shouldShowHandAd()) {
            showAdModal();
        }

        // Render CPU's first action if they act before the player preflop
        if (currentState.cpuMessage) {
            setTimeout(() => {
                addEvaluationToHistory("", currentState.cpuMessage, "");
            }, 500 * speedMult);
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

    // 前回の評価ドロワーを閉じる
    if (autoCloseReasonTimer) clearTimeout(autoCloseReasonTimer);
    reasonDrawerOpen = false;
    const reasonArea = el('reason-area');
    if (reasonArea) {
        reasonArea.classList.remove('show');
        reasonArea.classList.add('hidden');
    }
    const handle = el('eval-handle');
    if (handle) handle.classList.add('hidden');

    try {
        const res = await fetch('/api/action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: actionType, amount: amount, user_id: currentUserId })
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
        }, 800 * speedMult);

        // Render CPU response if exists
        if (data.cpuMessage) {
            setTimeout(() => {
                addEvaluationToHistory("", data.cpuMessage, "eval-O");
            }, 1000 * speedMult); // 1s delay to seem like CPU is "thinking" after evaluation
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
        }, 1200 * speedMult); // Prevent mashing during animations
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

// Reason Drawer (ツマミ引き出し式)
let autoCloseReasonTimer = null;
let reasonDrawerOpen = false;

function closeReasonArea() {
    reasonDrawerOpen = false;
    const reasonArea = el('reason-area');
    const handle = el('eval-handle');
    if (reasonArea) {
        reasonArea.classList.remove('show');
        setTimeout(() => reasonArea.classList.add('hidden'), 350);
    }
    // ツマミの矢印を下向きに
    if (handle) handle.querySelector('.handle-arrow').textContent = '▲';
}

function openReasonArea() {
    reasonDrawerOpen = true;
    const reasonArea = el('reason-area');
    const handle = el('eval-handle');
    if (reasonArea) {
        reasonArea.classList.remove('hidden');
        setTimeout(() => reasonArea.classList.add('show'), 10);
    }
    if (handle) handle.querySelector('.handle-arrow').textContent = '▼';
    if (autoCloseReasonTimer) clearTimeout(autoCloseReasonTimer);
    autoCloseReasonTimer = setTimeout(() => closeReasonArea(), 8000);
}

function toggleReasonDrawer() {
    if (reasonDrawerOpen) {
        closeReasonArea();
    } else {
        openReasonArea();
    }
}

function showReason(symbol, text) {
    const reasonArea = el('reason-area');
    const symbolSpn = el('reason-symbol');
    const textDiv = el('reason-text');
    const handle = el('eval-handle');
    const handleSymbol = el('handle-eval-symbol');

    if (!reasonArea) return;

    symbolSpn.innerText = symbol;
    textDiv.innerHTML = linkifyGlossary(text);

    let colorVar = "var(--border-color)";
    let textVar = "white";

    if (symbol === "◎") { colorVar = "var(--eval-optimal)"; textVar = "var(--eval-optimal)"; }
    else if (symbol === "◯") { colorVar = "var(--eval-good)"; textVar = "var(--eval-good)"; }
    else if (symbol === "△") { colorVar = "var(--eval-marginal)"; textVar = "var(--eval-marginal)"; }
    else if (symbol === "×") { colorVar = "var(--eval-bad)"; textVar = "var(--eval-bad)"; }

    reasonArea.style.borderLeftColor = colorVar;
    symbolSpn.style.color = textVar;

    // ツマミを更新・表示
    if (handle) {
        handle.classList.remove('hidden');
        handle.style.borderColor = colorVar;
        if (handleSymbol) {
            handleSymbol.textContent = symbol;
            handleSymbol.style.color = textVar;
        }
        handle.querySelector('.handle-arrow').textContent = '▲';
    }

    if (!appSettings.showFeedback) {
        textDiv.style.display = 'none';
        document.querySelector('.reason-title').innerText = "アクション評価";
    } else {
        textDiv.style.display = 'block';
        document.querySelector('.reason-title').innerText = "アクション解説";
    }

    // 評価後は閉じた状態でスタート（ツマミのみ表示）
    reasonArea.classList.remove('show');
    reasonArea.classList.add('hidden');
    reasonDrawerOpen = false;
}

// Evaluation UI Feedback
function showEvaluation(evalSymbol, actionName) {
    const popup = el('eval-popup');
    popup.innerText = evalSymbol;

    // Reset classes
    popup.className = "eval-popup";
    let colorClass = "eval-X"; // Default fallback to prevent empty token error

    // Robust checking in case of encoding weirdness
    if (!evalSymbol) {
        colorClass = "eval-X";
    } else if (evalSymbol.includes("◎")) {
        colorClass = "eval-OO";
    } else if (evalSymbol.includes("◯")) {
        colorClass = "eval-O";
    } else if (evalSymbol.includes("△")) {
        colorClass = "eval-T";
    } else if (evalSymbol.includes("×")) {
        colorClass = "eval-X";
    }

    popup.classList.add(colorClass);
    popup.classList.add('show');

    setTimeout(() => {
        popup.classList.remove('show');
        addEvaluationToHistory(evalSymbol, actionName, colorClass);
    }, 800 * speedMult);
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

function closeCoachArea() {
    const area = el('ai-coach-area');
    if (area) {
        area.classList.remove('show');
        setTimeout(() => area.classList.add('hidden'), 300);
    }
}

async function requestCoachExplanation() {
    // AIコーチカウンターをインクリメント & 広告チェック
    incrementCoachCount();
    if (shouldShowCoachAd()) {
        showAdModal();
    }

    el('ai-coach-area').classList.remove('hidden');
    setTimeout(() => {
        el('ai-coach-area').classList.add('show');
    }, 10);
    el('btn-ai-coach').disabled = true;

    // Build the request array if empty
    if (coachMessages.length === 0) {
        coachMessages.push({ role: "user", content: "このハンド全体を通じて私が改善するべき点や、良かった点を簡潔に解説してください。" });

        // Push a loading placeholder
        coachMessages.push({ role: "assistant", isLoading: true });
        renderCoachChat();

        try {
            const reply = await fetchCoachWithRetry(coachMessages.filter(m => !m.isLoading));
            coachMessages.pop();
            coachMessages.push({ role: "assistant", content: reply });
        } catch (e) {
            coachMessages.pop();
            coachMessages.push({ role: "assistant", content: "コーチに接続できませんでした。しばらく後に再試行してください。" });
        }

        renderCoachChat();
    }

    el('btn-ai-coach').disabled = false;
}

// AIコーチAPIリクエスト（リトライ付き）
async function fetchCoachWithRetry(messages, retries = 2) {
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 30000); // 30秒タイムアウト
            const response = await fetch('/api/ai_coach', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ messages, user_id: currentUserId }),
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            if (data.reply) return data.reply;
            throw new Error('empty reply');
        } catch (e) {
            if (attempt === retries) throw e;
            await new Promise(r => setTimeout(r, 1500 * (attempt + 1))); // 指数バックオフ
        }
    }
}

async function sendCoachMessage() {
    const input = el('coach-input');
    const text = input.value.trim();
    if (!text) return;

    input.value = "";
    input.disabled = true;
    el('btn-coach-send').disabled = true;

    coachMessages.push({ role: "user", content: text });
    coachMessages.push({ role: "assistant", isLoading: true });
    renderCoachChat();

    try {
        const reply = await fetchCoachWithRetry(coachMessages.filter(m => !m.isLoading));
        coachMessages.pop();
        coachMessages.push({ role: "assistant", content: reply });
    } catch (e) {
        coachMessages.pop();
        coachMessages.push({ role: "assistant", content: "送信に失敗しました。再度お試しください。" });
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
document.addEventListener('DOMContentLoaded', async () => {
    // プリフロップ標準レンジをキャッシュ
    fetchPreflopRanges();

    // ページ再読み込み時、まず既存のゲーム状態を復元を試みる
    try {
        const res = await fetch(`/api/state?user_id=${encodeURIComponent(currentUserId)}`);
        const data = await res.json();

        if (data.has_hand_in_progress) {
            // サーバー側でゲームが進行中 → 状態を復元してそのまま続行
            currentState = data;
            updateUI();
            return;
        }
    } catch (e) {
        // stateの取得に失敗した場合は新しくゲームを開始する
        console.warn('Could not restore game state, starting new hand:', e);
    }

    // ゲームが進行中でない（未開始 or サーバー再起動後）→ 新規開始
    startHand();
});


// ============================================
// Range Matrix Rendering
// ============================================

// プリフロップ標準レンジのキャッシュ
let cachedPreflopRanges = null;

async function fetchPreflopRanges() {
    if (cachedPreflopRanges) return;
    try {
        const res = await fetch('/api/preflop_ranges');
        cachedPreflopRanges = await res.json();
    } catch (e) {
        console.warn('preflop_ranges fetch failed:', e);
    }
}

// 現在表示中のレンジモードを管理
let rangeModalMode = 'hero'; // 'hero' | 'cpu' | 'compare' | 'preflop'

function openRangeModal(player) {
    if (!currentState) return;
    rangeModalMode = player === 'HERO' ? 'hero' : 'cpu';
    renderRangeGrid();
    el('range-modal').classList.remove('hidden');
}

function setRangeMode(mode) {
    rangeModalMode = mode;
    // ボタンのアクティブ状態を更新
    ['btn-range-hero', 'btn-range-cpu', 'btn-range-compare', 'btn-range-preflop'].forEach(id => {
        const btn = el(id);
        if (btn) btn.classList.remove('active');
    });
    const modeMap = { hero: 'btn-range-hero', cpu: 'btn-range-cpu', compare: 'btn-range-compare', preflop: 'btn-range-preflop' };
    if (el(modeMap[mode])) el(modeMap[mode]).classList.add('active');
    renderRangeGrid();
}

function renderRangeGrid() {
    if (!currentState) return;

    const heroRange = currentState.heroRangeRaw || {};
    const cpuRange = currentState.cpuRangeRaw || {};
    const heroPos = currentState.heroPos || '';
    const cpuPos = currentState.cpuPos || '';

    // タイトル更新
    const titleMap = {
        hero: `Hero (${heroPos}) レンジ`,
        cpu: `CPU (${cpuPos}) レンジ`,
        compare: 'Hero vs CPU 比較',
        preflop: `${heroPos} 標準GTOレンジ`
    };
    if (el('range-modal-title')) el('range-modal-title').innerText = titleMap[rangeModalMode] || 'レンジ表';

    // プリフロップモードの標準レンジを選択
    let stdRange = null;
    if (rangeModalMode === 'preflop' && cachedPreflopRanges) {
        stdRange = cachedPreflopRanges[heroPos] || null;
    }

    const grid = el('range-grid');
    grid.innerHTML = "";

    const ranks = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];

    for (let r1 = 0; r1 < ranks.length; r1++) {
        for (let r2 = 0; r2 < ranks.length; r2++) {
            let comboName = "";
            let type = "";

            if (r1 === r2) {
                comboName = ranks[r1] + ranks[r2];
                type = "pair";
            } else if (r1 < r2) {
                comboName = ranks[r1] + ranks[r2] + "s";
                type = "suited";
            } else {
                comboName = ranks[r2] + ranks[r1] + "o";
                type = "offsuit";
            }

            const heroW = heroRange[comboName] !== undefined ? heroRange[comboName] : 0.0;
            const cpuW = cpuRange[comboName] !== undefined ? cpuRange[comboName] : 0.0;
            const stdW = stdRange && stdRange[comboName] !== undefined ? stdRange[comboName] : 0.0;

            const cell = document.createElement('div');
            cell.className = 'range-cell';
            cell.innerText = comboName;

            if (rangeModalMode === 'hero') {
                // Hero レンジ表示
                let baseColor = type === "pair" ? "59, 130, 246" : type === "suited" ? "16, 185, 129" : "245, 158, 11";
                if (heroW > 0) {
                    cell.style.backgroundColor = `rgba(${baseColor}, ${heroW})`;
                    cell.style.color = "white";
                } else {
                    cell.style.backgroundColor = "#111";
                    cell.style.color = "#444";
                }
            } else if (rangeModalMode === 'cpu') {
                // CPU レンジ表示
                let baseColor = type === "pair" ? "59, 130, 246" : type === "suited" ? "16, 185, 129" : "245, 158, 11";
                if (cpuW > 0) {
                    cell.style.backgroundColor = `rgba(${baseColor}, ${cpuW})`;
                    cell.style.color = "white";
                } else {
                    cell.style.backgroundColor = "#111";
                    cell.style.color = "#444";
                }
            } else if (rangeModalMode === 'compare') {
                // Hero vs CPU 比較: 両方あれば紫、Heroのみ青、CPUのみオレンジ
                const hasHero = heroW > 0;
                const hasCpu = cpuW > 0;
                if (hasHero && hasCpu) {
                    // 両方 → 紫（オーバーラップ）
                    const intensity = Math.max(heroW, cpuW);
                    cell.style.backgroundColor = `rgba(139, 92, 246, ${intensity})`;
                    cell.style.color = "white";
                    cell.title = `Hero: ${Math.round(heroW*100)}% / CPU: ${Math.round(cpuW*100)}%`;
                } else if (hasHero) {
                    // Heroのみ → 青
                    cell.style.backgroundColor = `rgba(59, 130, 246, ${heroW})`;
                    cell.style.color = "white";
                    cell.title = `Hero: ${Math.round(heroW*100)}% / CPU: なし`;
                } else if (hasCpu) {
                    // CPUのみ → オレンジ
                    cell.style.backgroundColor = `rgba(245, 158, 11, ${cpuW})`;
                    cell.style.color = "white";
                    cell.title = `Hero: なし / CPU: ${Math.round(cpuW*100)}%`;
                } else {
                    cell.style.backgroundColor = "#111";
                    cell.style.color = "#444";
                }
            } else if (rangeModalMode === 'preflop') {
                // 標準GTOレンジ vs 実際のHeroレンジ
                if (stdW > 0 && heroW > 0) {
                    // 両方あり → 緑（GTO通り）
                    cell.style.backgroundColor = `rgba(16, 185, 129, ${Math.max(stdW, heroW)})`;
                    cell.style.color = "white";
                    cell.title = `GTO推奨: あり / あなたの実績: ${Math.round(heroW*100)}%`;
                } else if (stdW > 0) {
                    // GTOでは入るがプレイしていない → 赤（見逃し）
                    cell.style.backgroundColor = `rgba(239, 68, 68, ${stdW * 0.7})`;
                    cell.style.color = "white";
                    cell.title = `GTO推奨: あり / あなたの実績: なし（アンダープレイ）`;
                } else if (heroW > 0) {
                    // GTOでは入らないがプレイした → 黄（過剰）
                    cell.style.backgroundColor = `rgba(253, 224, 71, ${heroW * 0.8})`;
                    cell.style.color = "#111";
                    cell.title = `GTO推奨: なし / あなたの実績: ${Math.round(heroW*100)}%（オーバープレイ）`;
                } else {
                    cell.style.backgroundColor = "#111";
                    cell.style.color = "#444";
                }
            }

            grid.appendChild(cell);
        }
    }

    // アクティブボタンの状態更新
    const modeMap = { hero: 'btn-range-hero', cpu: 'btn-range-cpu', compare: 'btn-range-compare', preflop: 'btn-range-preflop' };
    ['btn-range-hero', 'btn-range-cpu', 'btn-range-compare', 'btn-range-preflop'].forEach(id => {
        const btn = el(id);
        if (btn) btn.classList.remove('active');
    });
    if (el(modeMap[rangeModalMode])) el(modeMap[rangeModalMode]).classList.add('active');

    // 凡例の切り替え
    const legendNormal = el('range-legend-normal');
    const legendCompare = el('range-legend-compare');
    const legendPreflop = el('range-legend-preflop');
    if (legendNormal) legendNormal.classList.toggle('hidden', rangeModalMode === 'compare' || rangeModalMode === 'preflop');
    if (legendCompare) legendCompare.classList.toggle('hidden', rangeModalMode !== 'compare');
    if (legendPreflop) legendPreflop.classList.toggle('hidden', rangeModalMode !== 'preflop');
}

function closeRangeModal() {
    const modal = el('range-modal');
    if (modal) modal.classList.add('hidden');
}

// ============================================
// 広告表示システム
// ============================================
const AD_HAND_INTERVAL = 30;     // 30ハンドごとに広告
const AD_COACH_INTERVAL = 5;     // AIコーチ5回ごとに広告
const AD_DURATION = 30;          // 30秒

let adTimerInterval = null;

function getHandCount() {
    return parseInt(localStorage.getItem('poker_hand_count') || '0', 10);
}

function incrementHandCount() {
    const count = getHandCount() + 1;
    localStorage.setItem('poker_hand_count', count.toString());
    return count;
}

function getCoachCount() {
    return parseInt(localStorage.getItem('poker_coach_count') || '0', 10);
}

function incrementCoachCount() {
    const count = getCoachCount() + 1;
    localStorage.setItem('poker_coach_count', count.toString());
    return count;
}

function shouldShowHandAd() {
    const count = getHandCount();
    return count > 0 && count % AD_HAND_INTERVAL === 0;
}

function shouldShowCoachAd() {
    const count = getCoachCount();
    return count > 0 && count % AD_COACH_INTERVAL === 0;
}

function showAdModal() {
    const modal = el('ad-modal');
    if (!modal) return;

    modal.classList.remove('hidden');
    
    let remaining = AD_DURATION;
    const timerEl = el('ad-timer');
    const countdownEl = el('ad-countdown');
    const closeBtn = el('ad-close-btn');

    closeBtn.disabled = true;
    
    if (timerEl) timerEl.textContent = remaining;
    if (countdownEl) countdownEl.textContent = remaining;

    if (adTimerInterval) clearInterval(adTimerInterval);
    
    adTimerInterval = setInterval(() => {
        remaining--;
        if (timerEl) timerEl.textContent = remaining;
        if (countdownEl) countdownEl.textContent = remaining;

        if (remaining <= 0) {
            clearInterval(adTimerInterval);
            adTimerInterval = null;
            closeBtn.disabled = false;
            closeBtn.innerHTML = '閉じる';
        }
    }, 1000);
}

function closeAdModal() {
    const modal = el('ad-modal');
    if (modal) modal.classList.add('hidden');
    if (adTimerInterval) {
        clearInterval(adTimerInterval);
        adTimerInterval = null;
    }
}
