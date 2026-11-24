// script.js
let currentState = null;
let currentBetPercent = 50;
let isWaitingForAction = true;

// Global settings loaded from localStorage
let appSettings = JSON.parse(localStorage.getItem("poker_settings")) || {
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

// サブスクリプション状態
let isPremium = false;
let isSpotMode = false;
let spotPosition = "";        // スポット練習: 固定ポジション（""=ランダム）
let spotParticipatedOnly = false;  // スポット練習: 参加ハンドのみ
let spotHands = "range";      // スポット練習で配るハンド: "range"（参加するハンドだけ）| "random"（2026/11/22〜）

// プレミアム状態の正は StoreKit。起動時の onEntitlementStatus が届くまでは前回の値で描画する
function loadSubscriptionStatus() {
    if (_entitlementReported) return;
    isPremium = localStorage.getItem("poker_is_premium") === "true";
}

// AI Coach Global States
let coachMessages = [];
// AIコーチ・広告のカウンターは「広告システム」セクションで管理

// 用語集 (POKER_GLOSSARY) と linkifyGlossary() は i18n.js が持つ

// ==============================
// 用語解説ポップアップ
// ==============================
function openGlossaryPopup(term, definition) {
    document.getElementById('glossary-popup-term').textContent = term;
    document.getElementById('glossary-popup-body').textContent = definition;
    document.getElementById('glossary-overlay').classList.add('active');
    document.getElementById('glossary-popup').classList.add('active');
}

function closeGlossaryPopup() {
    document.getElementById('glossary-overlay').classList.remove('active');
    document.getElementById('glossary-popup').classList.remove('active');
}

// イベント委譲：動的に生成された.glossary-termに対応
document.addEventListener('click', function(e) {
    const termEl = e.target.closest('.glossary-term');
    if (termEl) {
        e.stopPropagation();
        const term = termEl.textContent;
        const definition = glossaryLookup(term) || termEl.dataset.tooltip || '';
        openGlossaryPopup(term, definition);
    }
});

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

// 相手のポジション。エンジンはプリフロップで相手が動くまで "???" で伏せるが、
// あなたが SB なら残っているのは BB だけなので伏せる意味がない
function displayCpuPos() {
    if (!currentState) return '';
    if (currentState.cpuPos === '???' && currentState.heroPos === 'SB') return 'BB';
    return currentState.cpuPos || '';
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
    updateHTML('cpu-pos', `(${displayCpuPos()})`);
    // スワイプの2・3枚目（相手のレンジ・テーブル）。panels.js
    if (typeof renderPanels === 'function') renderPanels();
    // レンジバーは非表示のため更新不要（heroRangeRaw/cpuRangeRaw はレンジモーダルで使用）

    // レンジバーは非表示（設定から削除済み）

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

        // 追加で出せる上限。相手がオールイン済み・自分のスタックがコール額以下ならレイズは成立しない
        const maxAdd = heroMaxBet();
        const canRaise = maxAdd > currentState.facingBet + 0.05;
        // コール額はスタックまで（足りなければオールインのコール）
        const callAmount = Math.min(currentState.facingBet, currentState.heroStack);
        const callLabel = (currentState.heroStack <= currentState.facingBet + 0.01)
            ? t('action.call_allin', { amount: callAmount.toFixed(1) })
            : t('action.call_amount', { amount: callAmount.toFixed(1) });

        if (hasVoluntaryBet) {
            el('btn-check').style.display = 'none';
            el('btn-bet').style.display = 'none';

            el('btn-call').style.display = '';
            el('btn-raise').style.display = canRaise ? '' : 'none';
            el('btn-call').innerText = callLabel;
            el('btn-fold').disabled = false;
        } else {
            el('btn-raise').style.display = 'none';

            // Unopened pot: if facing the 1bb blind (or limp) we can still Call (Limp)
            if (currentState.facingBet > 0) {
                el('btn-call').style.display = '';
                el('btn-call').innerText = callLabel;
                el('btn-check').style.display = 'none';
            } else {
                el('btn-call').style.display = 'none';
                el('btn-check').style.display = '';
            }

            el('btn-bet').style.display = canRaise ? '' : 'none';
            el('btn-fold').disabled = false;
        }
    }
}

// Interaction
// ボード / 履歴の表示切り替え（デフォルトは履歴が手前）
let historyOnTop = true;
function applyHistoryBoardZIndex() {
    const history = el('eval-history');
    const boardArea = el('board-area');
    const hint = el('board-tap-hint');
    if (historyOnTop) {
        if (history) history.style.zIndex = '60';
        if (boardArea) boardArea.style.zIndex = '10';
        if (hint) hint.textContent = t('game.show_board');
    } else {
        if (history) history.style.zIndex = '10';
        if (boardArea) boardArea.style.zIndex = '60';
        if (hint) hint.textContent = t('game.show_history');
    }
}
function toggleHistoryBoard() {
    historyOnTop = !historyOnTop;
    applyHistoryBoardZIndex();
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
        // サーバー/端末エンジンの切り替えは game_api.js の GameApi が行う
        // スポット練習で「ランダム」のハンドなら、ポジションだけ固定して普通に配る
        currentState = await GameApi.startHand(isSpotMode && spotHands === 'range', isSpotMode ? spotPosition : '');
        updateUI();

        // 30ハンドごとに自動でインタースティシャル広告
        maybeShowHandAd();

        // Render CPU's first action if they act before the player preflop
        if (currentState.cpuActions) {
            addCpuActionsToHistory(currentState.cpuActions, 500);
        } else if (currentState.cpuMessage) {
            setTimeout(() => {
                addEvaluationToHistory("", currentState.cpuMessage, "", "CPU", "PREFLOP");
            }, 500 * speedMult);
        }
    } catch (e) {
        console.error(e);
        alert(t('error.start_failed'));
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
        const data = await GameApi.action(actionType, amount);

        // Show evaluation animation
        // ゲーム状態から正確なアクション表示名を決定（BET/RAISE の誤表記修正）
        const hasActiveBet = currentState && (
            (currentState.street === "PREFLOP" && currentState.currentBet > 1.0) ||
            (currentState.street !== "PREFLOP" && currentState.currentBet > 0)
        );
        let displayAction = actionType;
        if (actionType === "BET" || actionType === "RAISE") {
            displayAction = hasActiveBet ? "RAISE" : "BET";
        }
        // サーバー側でキャップされた実際の金額を優先（オールイン時など）
        const displayAmount = (typeof data.heroAmount === "number" && data.heroAmount > 0) ? data.heroAmount : amount;
        let actionText = displayAmount > 0 ? `${displayAction} ${Number(displayAmount).toFixed(1)}bb` : displayAction;
        if (data.heroAllIn && (actionType === "BET" || actionType === "RAISE" || actionType === "CALL")) {
            actionText += " (ALL-IN)";
        }
        const actionStreet = currentState ? currentState.street : "";
        showEvaluation(data.evaluation || "", actionText, actionStreet);

        // Wait for the popup animation to vanish then show reason UI
        setTimeout(() => {
            if (data.evaluation && data.reason) {
                showReason(data.evaluation, data.reason);
            }
        }, 800 * speedMult);

        // スポット練習「参加ハンドのみ」: PREFLOPフォールド時は自動で次のハンドへ
        if (spotParticipatedOnly && isSpotMode && actionType === "FOLD" && actionStreet === "PREFLOP") {
            setTimeout(() => startHand(), 600 * speedMult);
            return;
        }

        // Render CPU response if exists（構造化データがあれば1アクション=1行・正しいストリートで表示）
        if (data.cpuActions && data.cpuActions.length > 0) {
            addCpuActionsToHistory(data.cpuActions, 1000);
        } else if (data.cpuMessage) {
            setTimeout(() => {
                const cpuStreet = data.state ? data.state.street : actionStreet;
                addEvaluationToHistory("", data.cpuMessage, "", "CPU", cpuStreet);
            }, 1000 * speedMult);
        }

        // Update state
        currentState = data.state;

        // ハンド終了: 勝った直後ならレビュー依頼（表示を見終わる頃に出す）
        if (data.state && data.state.finished) noteHandFinished(data);

        // ショーダウン勝敗表示
        if (data.state && data.state.showdownResult) {
            setTimeout(() => showShowdownResult(data.state.showdownResult), 400 * speedMult);
        } else if (data.message) {
            el('message-area').innerText = data.message;
            el('message-area').classList.remove('hidden');
        }

    } catch (e) {
        console.error(e);
        alert(t('error.action_failed'));
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
        // 場面ごとに1サイズ（GameApi.preflopRaise）。表示は「合計いくらにするか」
        const r = GameApi.preflopRaise();
        if (r.kind === "allin") return [{ label: t('bet.size_allin'), amount: r.add, allIn: true }];
        const label = r.mult
            ? t('bet.pf_' + r.kind, { total: r.total.toFixed(1), mult: String(r.mult) })
            : t('bet.pf_' + r.kind, { total: r.total.toFixed(1) });
        return [{ label, amount: r.add, preflop: true }];
    } else { // POSTFLOP
        if (actionType === "BET") {
            let mults = [0.33, 0.55, 0.85]; // FLOP
            if (street === "TURN") mults = [0.33, 0.66, 1.0];
            if (street === "RIVER") mults = [0.33, 0.75, 1.5];

            options = [
                { label: t('bet.size_small_pot', { pct: Math.round(mults[0] * 100) }), amount: pot * mults[0] },
                { label: t('bet.size_medium_pot', { pct: Math.round(mults[1] * 100) }), amount: pot * mults[1] },
                { label: t('bet.size_large_pot', { pct: Math.round(mults[2] * 100) }), amount: pot * mults[2] }
            ];
        } else { // RAISE POSTFLOP
            // 2.5倍・3.5倍・ポットサイズ（判定側の PostflopEV.raiseSizes と同じ。小さいベットにも大きく返せるように）
            let mults = [2.5, 3.5, 4.5]; // FLOP / TURN
            if (street === "RIVER") mults = [2.5, 3.5, 5.0];
            const potRaise = pot + 2 * facing;
            const usePot = potRaise > facing * mults[2];

            options = [
                { label: t('bet.size_small_x', { mult: mults[0] }), amount: facing * mults[0] },
                { label: t('bet.size_medium_x', { mult: mults[1] }), amount: facing * mults[1] },
                usePot
                    ? { label: t('bet.size_pot_raise'), amount: potRaise }
                    : { label: t('bet.size_large_x', { mult: mults[2] }), amount: facing * mults[2] }
            ];
        }
    }

    // 上限（スタック・相手がコールできる額）を超えるサイズはオールインにまとめる。
    // 以前は上限を見ずに「150bb」のようなボタンを出していた（実際の投入はエンジンが上限で止める）
    const maxAdd = heroMaxBet();
    const out = [];
    for (const o of options) {
        const amount = Math.round(o.amount * 10) / 10;
        if (amount >= maxAdd - 0.05) {
            if (!out.some(x => x.allIn)) out.push({ label: t('bet.size_allin'), amount: maxAdd, allIn: true });
        } else {
            out.push({ label: o.label, amount });
        }
    }
    return out;
}

// あなたがこのアクションで追加で出せる上限（bb）
function heroMaxBet() {
    try { return GameApi.heroMaxBet(); } catch (e) { return Infinity; }
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
        headerTitle.innerText = isRaising ? t('bet.panel_title.raise') : t('bet.panel_title.bet');
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
        // プリフロップは合計額をラベルに入れているので、追加額は付けない
        btn.innerText = s.preflop ? s.label : s.label + ` (${s.amount.toFixed(1)} bb)`;
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
        document.querySelector('.reason-title').innerText = t('game.reason_title.eval');
    } else {
        textDiv.style.display = 'block';
        document.querySelector('.reason-title').innerText = t('game.reason_title.explain');
    }

    // 評価後は閉じた状態でスタート（ツマミのみ表示）
    reasonArea.classList.remove('show');
    reasonArea.classList.add('hidden');
    reasonDrawerOpen = false;
}

// Evaluation UI Feedback
function showEvaluation(evalSymbol, actionName, street) {
    const popup = el('eval-popup');
    popup.innerText = evalSymbol;

    popup.className = "eval-popup";
    let colorClass = "eval-X";

    if (!evalSymbol) { colorClass = "eval-X"; }
    else if (evalSymbol.includes("◎")) { colorClass = "eval-OO"; }
    else if (evalSymbol.includes("◯")) { colorClass = "eval-O"; }
    else if (evalSymbol.includes("△")) { colorClass = "eval-T"; }
    else if (evalSymbol.includes("×")) { colorClass = "eval-X"; }

    popup.classList.add(colorClass);
    popup.classList.add('show');

    setTimeout(() => {
        popup.classList.remove('show');
        addEvaluationToHistory(evalSymbol, actionName, colorClass, "YOU", street);
    }, 800 * speedMult);
}

// CPUアクションの表示テキストを整形（"CPU CALLS 2.2bb" ではなく "CALL 2.2bb" — アクター表示は別チップにあるため）
function formatCpuAction(a) {
    let text = a.action;
    if (a.amount > 0 && (a.action === "BET" || a.action === "RAISE" || a.action === "CALL")) {
        text += ` ${Number(a.amount).toFixed(1)}bb`;
    }
    if (a.allIn) text += " (ALL-IN)";
    return text;
}

// 構造化されたCPUアクション配列を、正しいストリートバッジ付きで1件ずつ履歴に追加
function addCpuActionsToHistory(cpuActions, delayBase) {
    if (!Array.isArray(cpuActions)) return;
    cpuActions.forEach((a, i) => {
        setTimeout(() => {
            addEvaluationToHistory("", formatCpuAction(a), "", "CPU", a.street || "");
        }, (delayBase + i * 350) * speedMult);
    });
}

function addEvaluationToHistory(symbol, action, colorClass, actor, street) {
    const history = el('eval-history');
    if (!history) return;

    const item = document.createElement('div');
    item.className = 'history-item';

    // ストリートバッジ
    const streetColors = { PREFLOP: "#6366f1", FLOP: "#10b981", TURN: "#f59e0b", RIVER: "#ef4444" };
    const streetBg = streetColors[street] || "#555";
    const streetHtml = street
        ? `<span class="hist-street" style="background:${streetBg};">${street.substring(0,2)}</span>`
        : `<span class="hist-street" style="background:#555;">--</span>`;

    // アクター
    const actorLabel = (actor === "YOU" || actor === "HERO")
        ? `<span class="hist-actor you">You</span>`
        : `<span class="hist-actor cpu">CPU</span>`;

    // アクションテキスト
    const actionHtml = `<span class="hist-action">${action}</span>`;

    // 評価シンボル
    const symbolHtml = symbol
        ? `<span class="hist-eval ${colorClass}">${symbol}</span>`
        : '';

    item.innerHTML = `${streetHtml}${actorLabel}${actionHtml}${symbolHtml}`;
    history.appendChild(item);  // 最新を末尾に追加（時系列順）

    // 自動スクロールを末尾に
    history.scrollTop = history.scrollHeight;

    // 最大10件
    while (history.children.length > 10) {
        history.removeChild(history.firstChild);
    }
}

// ショーダウン結果を表示
function showShowdownResult(result) {
    if (!result) return;
    const msgArea = el('message-area');
    if (!msgArea) return;

    let label, colorStyle;
    if (result.winner === "YOU") {
        label = "You Win"; colorStyle = "color: var(--eval-optimal);";
    } else if (result.winner === "CPU") {
        label = "CPU Wins"; colorStyle = "color: var(--eval-bad);";
    } else {
        label = "Tie"; colorStyle = "color: var(--text-muted);";
    }

    msgArea.innerHTML = `
        <div class="showdown-banner" style="${colorStyle}">
            <div class="showdown-label">${label}</div>
        </div>
        <div class="showdown-hands">
            <span class="showdown-you">You: ${result.heroHandName}</span>
            <span class="showdown-vs">vs</span>
            <span class="showdown-cpu">CPU: ${result.cpuHandName}</span>
        </div>`;
    msgArea.classList.remove('hidden');
}

// ============================================
// AI Coach Chat integration
// ============================================

// AIコーチのテキストを読みやすいHTMLに変換
function formatCoachText(text) {
    if (!text) return '';
    let html = text
        // 見出しを太字ブロックに（日本語は【】、英語は[]をコーチに使わせている）
        .replace(/【([^】]+)】/g, '<strong class="coach-heading">【$1】</strong>')
        .replace(/\[([^\][\n]{1,40})\]/g, '<strong class="coach-heading">[$1]</strong>')
        // 番号付きリスト行
        .replace(/^(\d+)\.\s+/gm, '<span class="coach-num">$1.</span> ')
        // 箇条書き行（- で始まる）
        .replace(/^-\s+/gm, '<span class="coach-bullet">▸</span> ')
        // 改行を<br>に
        .replace(/\n/g, '<br>');
    return linkifyGlossary(html);
}

function renderCoachChat() {
    const chatContainer = el('coach-chat-history');
    chatContainer.innerHTML = "";

    coachMessages.forEach(msg => {
        if (msg.role === "system") return;

        const div = document.createElement('div');
        div.className = `chat-bubble ${msg.role === 'user' ? 'user' : 'assistant'}`;

        if (msg.isLoading) {
            div.innerHTML = `<span class="chat-loading">...</span>`;
        } else if (msg.role === 'assistant') {
            div.innerHTML = formatCoachText(msg.content);
        } else {
            div.textContent = msg.content;
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
    // 3回ごとに広告/プレミアムの選択ゲート。広告を見ずに閉じたら続行しない。
    // 同じハンドの相談を開き直すだけ（もう回答がある）ときは回数を使わない
    if (coachMessages.length === 0 && !(await coachGate())) return;

    el('ai-coach-area').classList.remove('hidden');
    setTimeout(() => {
        el('ai-coach-area').classList.add('show');
    }, 10);
    el('btn-ai-coach').disabled = true;

    // Build the request array if empty
    if (coachMessages.length === 0) {
        coachMessages.push({ role: "user", content: t('coach.initial_question') });

        // Push a loading placeholder
        coachMessages.push({ role: "assistant", isLoading: true });
        renderCoachChat();

        try {
            const reply = await fetchCoachWithRetry(coachMessages.filter(m => !m.isLoading));
            coachMessages.pop();
            coachMessages.push({ role: "assistant", content: reply });
        } catch (e) {
            coachMessages.pop();
            coachMessages.push({ role: "assistant", content: t('coach.connect_failed') });
            refundCoachUseOnError();
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
            const handState = GameApi.coachState();
            const response = await fetch(withLang('/api/ai_coach'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                // ハンド状態はサーバーに無いので毎回送る
                body: JSON.stringify({ messages, user_id: currentUserId, state: handState }),
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const data = await response.json();
            if (data.error) {
                // サーバー側の失敗（API キー・OpenAI の障害など）。同じ失敗になるので再試行しない
                const err = new Error('coach api error');
                err.noRetry = true;
                throw err;
            }
            if (data.reply) {
                // 最初の相談だけ履歴に残す（サーバーの save_ai_feedback と同じ条件）
                if (messages.length === 1) GameApi.saveCoachFeedback(data.hand_context, data.reply, handState);
                return data.reply;
            }
            throw new Error('empty reply');
        } catch (e) {
            if (attempt === retries || e.noRetry) throw e;
            await new Promise(r => setTimeout(r, 1500 * (attempt + 1))); // 指数バックオフ
        }
    }
}

async function sendCoachMessage() {
    const input = el('coach-input');
    const text = input.value.trim();
    if (!text) return;

    // 3回ごとに広告/プレミアムの選択ゲート。広告を見ずに閉じたら送信しない
    if (!(await coachGate())) return;

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
        coachMessages.push({ role: "assistant", content: t('coach.send_failed') });
        refundCoachUseOnError();
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

// AIコーチ3回ごとの選択モーダル（広告 or プレミアム）
function showCoachLimitModal() {
    const modal = el('coach-limit-modal');
    if (modal) modal.classList.remove('hidden');
    // ユーザーが「広告を見る」を押す可能性が高いのでこの時点でロード開始
    // （起動時プリロードをやめた分、ここで準備して表示までの待ちを無くす）
    prepareRewardedAd();
}

function closeCoachLimitModal() {
    const modal = el('coach-limit-modal');
    if (modal) modal.classList.add('hidden');
    // 広告を見ずに閉じた → コーチは続行しない
    if (_coachGateResolve) { _coachGateResolve(false); _coachGateResolve = null; }
}

// リワード広告を最後まで視聴したらロック解除してコーチを続行
async function watchAdForCoach() {
    const modal = el('coach-limit-modal');
    if (modal) modal.classList.add('hidden');   // closeを呼ぶとゲートがfalseになるため直接閉じる
    const earned = await showRewardedAd();
    if (earned === true) {
        // 視聴完了 → ロック解除、また無料分を付与
        coachLocked = false;
        coachFreeUsesLeft = AD_COACH_INTERVAL;
        saveCoachFreeUses();
        if (_coachGateResolve) { _coachGateResolve(true); _coachGateResolve = null; }
    } else {
        if (earned === 'unavailable') {
            // 広告を用意できなかった → 通過させず理由を伝える
            alert(t('ad.load_failed'));
        }
        // 途中で閉じた/用意できなかった → ロック維持、続行しない（次も2択が出る）
        if (_coachGateResolve) { _coachGateResolve(false); _coachGateResolve = null; }
    }
}

// Init
document.addEventListener('DOMContentLoaded', async () => {
    loadSubscriptionStatus();
    await GameApi.init();
    if (!GameApi.game) {
        el('engine-error').classList.remove('hidden');
        return;
    }

    // /stats で開いたら分析タブ（以前の分析ページへのリンク・ブックマーク用）
    if (window.location.pathname === '/stats' || window.location.hash === '#stats') showTab('stats');

    // #premium ハッシュでページを開いた場合は購入モーダルを自動表示
    if (window.location.hash === '#premium') {
        history.replaceState(null, '', window.location.pathname);
        openPurchaseModal();
    }

    // プリフロップ標準レンジをキャッシュ
    fetchPreflopRanges();
    // 履歴をデフォルトで手前に
    applyHistoryBoardZIndex();

    // ページ再読み込み時、まず既存のゲーム状態を復元を試みる
    try {
        const data = await GameApi.state();

        if (data.has_hand_in_progress) {
            // ゲームが進行中 → 状態を復元しておき、ホームの「続きから」で再開する
            currentState = data;
            updateUI();
        }
    } catch (e) {
        console.warn('Could not restore game state:', e);
    }
    // 最初はホーム（2026/11/21〜。ゲーム画面はスタートを押してから）
    refreshHome();
});


// ============================================
// Range Matrix Rendering
// ============================================

// プリフロップ標準レンジのキャッシュ
let cachedPreflopRanges = null;
let standaloneRangePos = 'BTN'; // スタンドアロン（ゲーム外）プリフロップモード用ポジション

function fetchPreflopRanges() {
    cachedPreflopRanges = cachedPreflopRanges || GameApi.preflopRanges();
}

// 現在表示中のレンジモードを管理
let rangeModalMode = 'hero'; // 'hero' | 'cpu' | 'compare' | 'preflop'

function openRangeModal(player) {
    if (!currentState) return;
    rangeModalMode = player === 'HERO' ? 'hero' : 'cpu';
    renderRangeGrid();
    const modal = el('range-modal');
    modal.classList.remove('hidden');
    modal.classList.add('active');
}

function openPreflopRangeModal() {
    rangeModalMode = 'preflop';
    ['btn-range-hero', 'btn-range-cpu', 'btn-range-compare', 'btn-range-preflop'].forEach(id => {
        const btn = el(id);
        if (btn) btn.classList.remove('active');
    });
    if (el('btn-range-preflop')) el('btn-range-preflop').classList.add('active');
    updateStandalonePosSelector();
    renderRangeGrid();
    const modal = el('range-modal');
    modal.classList.remove('hidden');
    modal.classList.add('active');
}

function setStandalonePos(pos) {
    standaloneRangePos = pos;
    document.querySelectorAll('.standalone-pos-btn').forEach(b => b.classList.remove('active'));
    const btn = document.querySelector(`.standalone-pos-btn[data-pos="${pos}"]`);
    if (btn) btn.classList.add('active');
    renderRangeGrid();
}

function updateStandalonePosSelector() {
    const sel = el('standalone-pos-selector');
    if (!sel) return;
    sel.style.display = (!currentState && rangeModalMode === 'preflop') ? 'flex' : 'none';
    document.querySelectorAll('.standalone-pos-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.pos === standaloneRangePos);
    });
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
    const sel = el('standalone-pos-selector');
    if (sel) sel.style.display = (!currentState && mode === 'preflop') ? 'flex' : 'none';
    renderRangeGrid();
}

function renderRangeGrid() {
    // スタンドアロン（ゲーム外）プリフロップモードを許可
    if (!currentState && rangeModalMode !== 'preflop') return;

    const heroRange = currentState ? (currentState.heroRangeRaw || {}) : {};
    const cpuRange = currentState ? (currentState.cpuRangeRaw || {}) : {};
    const heroPos = currentState ? (currentState.heroPos || '') : standaloneRangePos;
    const cpuPos = currentState ? displayCpuPos() : '';

    // スタンドアロン時はポジション選択を表示
    const sel = el('standalone-pos-selector');
    if (sel) sel.style.display = (!currentState && rangeModalMode === 'preflop') ? 'flex' : 'none';

    // タイトル更新
    const titleMap = {
        hero: t('range.title_hero', { pos: heroPos }),
        cpu: t('range.title_cpu', { pos: cpuPos }),
        compare: t('range.title_compare'),
        preflop: t('range.title_preflop', { pos: heroPos })
    };
    if (el('range-modal-title')) el('range-modal-title').innerText = titleMap[rangeModalMode] || t('range.title');

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
                    cell.title = t('range.tip_hero_cpu', { hero: Math.round(heroW*100) + '%', cpu: t('common.none') });
                } else if (hasCpu) {
                    // CPUのみ → オレンジ
                    cell.style.backgroundColor = `rgba(245, 158, 11, ${cpuW})`;
                    cell.style.color = "white";
                    cell.title = t('range.tip_hero_cpu', { hero: t('common.none'), cpu: Math.round(cpuW*100) + '%' });
                } else {
                    cell.style.backgroundColor = "#111";
                    cell.style.color = "#444";
                }
            } else if (rangeModalMode === 'preflop') {
                // 推奨レンジ vs 実際のHeroレンジ
                if (stdW > 0 && heroW > 0) {
                    // 両方あり → 緑（推奨通り）
                    cell.style.backgroundColor = `rgba(16, 185, 129, ${Math.max(stdW, heroW)})`;
                    cell.style.color = "white";
                    cell.title = t('range.tip_rec_yours', { rec: t('common.yes'), yours: Math.round(heroW*100) + '%' });
                } else if (stdW > 0) {
                    // 推奨だがプレイしていない → 赤（見逃し）
                    cell.style.backgroundColor = `rgba(239, 68, 68, ${stdW * 0.7})`;
                    cell.style.color = "white";
                    cell.title = t('range.tip_under');
                } else if (heroW > 0) {
                    // 推奨外だがプレイした → 黄（過剰）
                    cell.style.backgroundColor = `rgba(253, 224, 71, ${heroW * 0.8})`;
                    cell.style.color = "#111";
                    cell.title = t('range.tip_over', { yours: Math.round(heroW*100) + '%' });
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
    if (modal) {
        modal.classList.remove('active');
        modal.classList.add('hidden');
    }
}

// ============================================
// 広告システム
// ============================================
const AD_COACH_INTERVAL = 3;    // 無料で使えるAIコーチ回数（これを超えたらゲート）
const AD_HAND_INTERVAL = 30;    // 30ハンドごとに自動インタースティシャル広告
// 残りの無料回数は端末に保存する（2026/11/18〜）。以前はメモリだけで、ページの読み込み直し（分析ページから戻る・
// アプリを開き直す）で3回に戻っていた。AIコーチは API 費用がかかるので、使い切ったら広告を見るか加入するまで戻らない
const COACH_FREE_KEY = "poker_coach_free_left";
let coachFreeUsesLeft = loadCoachFreeUses();  // 残り無料コーチ回数
let coachLocked = coachFreeUsesLeft <= 0;     // ゲート未消化ロック（広告視聴 or 加入で解除）
function loadCoachFreeUses() {
    try {
        const v = localStorage.getItem(COACH_FREE_KEY);
        if (v === null) return AD_COACH_INTERVAL;   // 初回
        const n = parseInt(v, 10);
        return Number.isFinite(n) ? Math.max(0, Math.min(AD_COACH_INTERVAL, n)) : AD_COACH_INTERVAL;
    } catch (e) { return AD_COACH_INTERVAL; }
}
// 直前のゲートで無料分を1回使ったか。回答を取れなかったら戻す（通信エラーで回数だけ減らないように）
let _coachUseConsumed = false;
function refundCoachUseOnError() {
    if (!_coachUseConsumed) return;
    _coachUseConsumed = false;
    coachFreeUsesLeft = Math.min(AD_COACH_INTERVAL, coachFreeUsesLeft + 1);
    coachLocked = false;
    saveCoachFreeUses();
}
function saveCoachFreeUses() {
    try { localStorage.setItem(COACH_FREE_KEY, String(coachFreeUsesLeft)); } catch (e) { /* 保存できなくても進行は止めない */ }
}
let handPlayCount = 0;          // ハンド数
let _coachGateResolve = null;   // コーチゲートのPromise解決用

// --- リワード広告（ユーザーが視聴を選択） ---
// 視聴完了/中断時にiOSネイティブから呼ばれる。earned=true なら最後まで視聴。
let _adResolve = null;
window.onAdDismissed = function(earned) {
    if (_adResolve) { _adResolve(earned === true); _adResolve = null; }
};

// 広告を用意できなかった場合（在庫なし/通信障害/表示失敗）にiOS側から呼ばれる。
// フェイルクローズ: 広告なしでゲートを通過させない（'unavailable' でエラー表示させる）。
window.onAdUnavailable = function() {
    if (_adResolve) { _adResolve('unavailable'); _adResolve = null; }
};

function showRewardedAd() {
    return new Promise(resolve => {
        _adResolve = resolve;
        try {
            window.webkit.messageHandlers.showRewardedAd.postMessage({});
        } catch (e) {
            // iOSアプリ外（ブラウザ等）に広告は存在しない → 閉じ込めず通過させる
            _adResolve = null;
            resolve(true);
        }
    });
}

// --- インタースティシャル広告（30ハンドごとに自動表示） ---
function showInterstitialAd() {
    try {
        window.webkit.messageHandlers.showInterstitialAd.postMessage({});
    } catch (e) { /* iOSアプリ外では無視 */ }
}

// 表示直前ロード用の prepare 通知（旧バージョンのアプリにはハンドラが無いため try/catch）
function prepareRewardedAd() {
    try {
        window.webkit.messageHandlers.prepareRewardedAd.postMessage({});
    } catch (e) { /* 旧アプリ・iOSアプリ外では無視 */ }
}

function prepareInterstitialAd() {
    try {
        window.webkit.messageHandlers.prepareInterstitialAd.postMessage({});
    } catch (e) { /* 旧アプリ・iOSアプリ外では無視 */ }
}

function maybeShowHandAd() {
    if (isPremium) return;
    handPlayCount++;
    const phase = handPlayCount % AD_HAND_INTERVAL;
    if (phase === AD_HAND_INTERVAL - 5) {
        // 表示5ハンド前にロード開始（起動時プリロードをやめた分の先読み）
        prepareInterstitialAd();
    } else if (phase === 0) {
        showInterstitialAd();
    }
}

// --- App Store レビュー依頼 ---
// 表示は iOS 純正のダイアログで、OS が年3回までに制限する（呼んでも出ないことがある）。
// Apple のガイドラインで禁止されているので、事前に「気に入りましたか？」と聞いて振り分けないこと。
const REVIEW_MIN_HANDS = 20;       // 累計ハンド数がこれ未満なら頼まない
const REVIEW_INTERVAL_DAYS = 120;  // 前回からこの日数は頼まない（年3回の上限に合わせる）
const REVIEW_DELAY_MS = 2500;      // 勝敗の表示を見終わるまで待つ

function readReviewNumber(key) {
    try { return Number(localStorage.getItem(key)) || 0; } catch (e) { return 0; }
}

function noteHandFinished(data) {
    const total = readReviewNumber("poker_total_hands") + 1;
    try { localStorage.setItem("poker_total_hands", String(total)); } catch (e) { /* 数えられなければ頼まないだけ */ }

    // showdownResult は CPU フォールド時も入るが、それは後から作った手での比較なので使わない
    const heroWon = data.cpuAction === "FOLD" ||
        (data.state.showdownResult && data.state.showdownResult.winner === "YOU");
    if (!heroWon || total < REVIEW_MIN_HANDS) return;

    const elapsedDays = (Date.now() - readReviewNumber("poker_review_requested_at")) / 86400000;
    if (elapsedDays < REVIEW_INTERVAL_DAYS) return;

    // 次のハンドの開始でインタースティシャルが出るなら、続けて割り込まない
    if (!isPremium && (handPlayCount + 1) % AD_HAND_INTERVAL === 0) return;

    setTimeout(requestAppReview, REVIEW_DELAY_MS);
}

function requestAppReview() {
    try {
        window.webkit.messageHandlers.requestReview.postMessage({});
        // 記録は送れたときだけ。旧アプリ・ブラウザでは記録せず、アプリ更新後に頼めるようにする
        localStorage.setItem("poker_review_requested_at", String(Date.now()));
    } catch (e) { /* 旧アプリ・iOSアプリ外では無視 */ }
}

// --- 開発者モード（2026/11/21〜。shota の確認用） ---
// 設定の見出し「設定」を7回続けて押すとコードの入力欄が出る。正しいコードで localStorage に poker_dev=1 を保存する。
// オンの間: AIコーチの回数制限なし・ハンド履歴に判定の解説と「このハンドをコピー」（stats.js）・ハンド履歴のロック解除。
// コードは平文で置かず SHA-256 だけを置く。AIコーチの回数制限はもともと端末側だけの管理なので、これで危険は増えない
const DEV_CODE_SHA256 = "6bd7eac2d26d0ea359985c9f5340e0090e8181d0076e5711a9143a6e2d49caa5";
function isDevMode() {
    try { return localStorage.getItem("poker_dev") === "1"; } catch (e) { return false; }
}
let _devTaps = 0, _devTapTimer = null;
function devTitleTap() {
    _devTaps++;
    clearTimeout(_devTapTimer);
    _devTapTimer = setTimeout(() => { _devTaps = 0; }, 1500);
    if (_devTaps >= 7) { _devTaps = 0; renderDevRow(true); }
}
function renderDevRow(showInput) {
    const row = el('dev-row');
    if (!row) return;
    if (isDevMode()) {
        row.classList.remove('hidden');
        row.innerHTML = `<span class="settings-row-label">${t('dev.on')}</span><button class="settings-premium-btn" onclick="setDevMode(false)">${t('dev.turn_off')}</button>`;
    } else if (showInput) {
        row.classList.remove('hidden');
        row.innerHTML = `<input id="dev-code" type="password" autocomplete="off" placeholder="${t('dev.code_placeholder')}" style="flex:1;min-width:0;padding:6px 8px;border-radius:6px;border:1px solid #555;background:#111;color:#eee;"><button class="settings-premium-btn" style="margin-left:8px" onclick="submitDevCode()">${t('dev.submit')}</button>`;
    } else {
        row.classList.add('hidden');
    }
}
async function submitDevCode() {
    const v = (el('dev-code') || {}).value || '';
    let hex = '';
    try {
        const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v.trim()));
        hex = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
    } catch (e) { /* 計算できない環境ではオンにしない */ }
    if (hex === DEV_CODE_SHA256) setDevMode(true);
    else { const i = el('dev-code'); if (i) { i.value = ''; i.placeholder = t('dev.wrong'); } }
}
function setDevMode(on) {
    try { if (on) localStorage.setItem("poker_dev", "1"); else localStorage.removeItem("poker_dev"); } catch (e) { /* 無視 */ }
    renderDevRow(false);
    // 新しい画面（/v2）は開発者モード用。オフにしたら今の画面へ戻る
    if (!on) location.href = "/";
}

// --- AIコーチのゲート（広告/プレミアム選択） ---
// 続行してよいか(Promise<bool>)を返す。premiumは常にtrue。
// 無料分を使い切るとロックされ、広告を最後まで見るか加入するまで使えない。
function coachGate() {
    _coachUseConsumed = false;
    if (isPremium || isDevMode()) return Promise.resolve(true);   // 開発者モードは回数制限なし

    // ロック中 or 無料分を使い切り → 消化するまで毎回ゲートを出す
    if (coachLocked || coachFreeUsesLeft <= 0) {
        coachLocked = true;
        return new Promise(resolve => {
            _coachGateResolve = resolve;
            showCoachLimitModal();
        });
    }

    coachFreeUsesLeft--;
    saveCoachFreeUses();
    _coachUseConsumed = true;
    return Promise.resolve(true);
}

// ==============================
// プレミアム購入フロー（StoreKit 2 ブリッジ）
// ==============================
function openPurchaseModal() {
    const modal = el('purchase-modal');
    if (!modal) return;
    const statusEl = el('purchase-status');
    if (statusEl) statusEl.textContent = '';
    if (isPremium) {
        if (statusEl) statusEl.textContent = t('purchase.status.active');
    }
    // ネイティブ(StoreKit)から最新の価格を取得して表示
    try {
        window.webkit.messageHandlers.requestPrice.postMessage({});
    } catch (e) { /* iOSアプリ外では無視 */ }
    modal.classList.remove('hidden');
}

function closePurchaseModal() {
    const modal = el('purchase-modal');
    if (modal) modal.classList.add('hidden');
}

function startPurchase() {
    const statusEl = el('purchase-status');
    const btn = el('btn-purchase');
    if (statusEl) statusEl.textContent = t('purchase.status.processing');
    if (btn) btn.disabled = true;

    try {
        // iOS WKWebView ブリッジ経由でStoreKitを呼び出す
        window.webkit.messageHandlers.purchaseRequest.postMessage({});
    } catch (e) {
        // iOS以外（ブラウザ等）では非対応
        if (statusEl) statusEl.textContent = t('purchase.status.ios_only_buy');
        if (btn) btn.disabled = false;
    }
}

function restorePurchase() {
    const statusEl = el('purchase-status');
    if (statusEl) statusEl.textContent = t('purchase.status.restoring');

    try {
        window.webkit.messageHandlers.restoreRequest.postMessage({});
    } catch (e) {
        if (statusEl) statusEl.textContent = t('purchase.status.ios_only_restore');
    }
}

// StoreKit から呼ばれるコールバック
window.onPurchaseSuccess = async function(info) {
    const statusEl = el('purchase-status');
    const btn = el('btn-purchase');

    // StoreKit が成功した時点でプレミアム有効化
    isPremium = true;
    localStorage.setItem("poker_is_premium", "true");
    applyPremiumUI();
    if (statusEl) statusEl.textContent = t('purchase.status.activated');

    setTimeout(closePurchaseModal, 1500);
    if (btn) btn.disabled = false;
};

window.onRestoreSuccess = function() {
    // isPremiumをすぐに反映（起動時の自動呼び出しでも即時有効化）
    _entitlementReported = true;
    isPremium = true;
    localStorage.setItem("poker_is_premium", "true");
    applyPremiumUI();

    const modal = el('purchase-modal');
    const isModalOpen = modal && !modal.classList.contains('hidden');

    // モーダルが開いている場合（手動復元ボタン押下時）のみUI更新
    if (isModalOpen) {
        const statusEl = el('purchase-status');
        if (statusEl) statusEl.textContent = t('purchase.status.restored');
        setTimeout(closePurchaseModal, 1500);
    }
};

window.onPurchaseCancel = function() {
    const statusEl = el('purchase-status');
    const btn = el('btn-purchase');
    if (statusEl) statusEl.textContent = t('purchase.status.cancelled');
    if (btn) btn.disabled = false;
};

// 復元を試みたが有効な購入が見つからなかった（iOS側から呼ばれる）
window.onRestoreNotFound = function() {
    const statusEl = el('purchase-status');
    if (statusEl) statusEl.textContent = t('purchase.status.not_found');
};

// StoreKitの実権利状態（起動時にiOS側から必ず呼ばれる）。
// 解約・期限切れ・返金後はここで解除される。
let _entitlementReported = false;
window.onEntitlementStatus = function(active) {
    _entitlementReported = true;
    if (active) {
        isPremium = true;
        localStorage.setItem("poker_is_premium", "true");
        applyPremiumUI();
    } else {
        isPremium = false;
        localStorage.setItem("poker_is_premium", "false");
    }
};

function applyPremiumUI() {
    // コーチのロック解除（プレミアムは広告なし・無制限）
    coachLocked = false;
    // 開いているコーチゲートがあれば続行させる
    if (_coachGateResolve) { _coachGateResolve(true); _coachGateResolve = null; }
    const coachModal = el('coach-limit-modal');
    if (coachModal) coachModal.classList.add('hidden');
    // ホームのスポット練習の「Premium」の印を消す
    const badge = el('hm-spot-badge');
    if (badge) badge.classList.add('hidden');
}

// ==============================
// 設定モーダル
// ==============================
// ==============================
// 下のタブ（2026/11/19〜。練習・振り返り・分析・設定）
// ==============================
let currentTab = 'home';
function showTab(name) {
    if (!el('view-' + name)) return;
    currentTab = name;
    document.querySelectorAll('.tab-view').forEach(v => v.classList.toggle('active', v.id === 'view-' + name));
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    // ゲーム画面は下のタブを出さない（左上の戻るでホームへ）
    document.body.classList.toggle('in-game', name === 'play');
    if (name === 'home') refreshHome();
    if (name === 'play' && typeof fitPanels === 'function') requestAnimationFrame(fitPanels);
    // 分析・振り返りは開くたびに最新の記録で描き直す（練習で増えた分を反映）
    if ((name === 'stats' || name === 'review') && typeof StatsPage !== 'undefined') StatsPage.load();
    if (name === 'settings') fillSettings();
}

// 以前の「設定を開く」は設定タブへ
function openSettings() { showTab('settings'); }

function fillSettings() {
    // 現在の値をUIに反映
    const fbCheck = el('setting-feedback');
    if (fbCheck) fbCheck.checked = appSettings.showFeedback !== false;

    const segNormal = el('seg-normal');
    const segFast   = el('seg-fast');
    if (segNormal && segFast) {
        segNormal.classList.toggle('active', appSettings.speed !== 'fast');
        segFast.classList.toggle('active', appSettings.speed === 'fast');
    }

    // 言語セグメントの選択状態
    const segJa = el('seg-lang-ja');
    const segEn = el('seg-lang-en');
    if (segJa && segEn) {
        segJa.classList.toggle('active', getLang() === 'ja');
        segEn.classList.toggle('active', getLang() === 'en');
    }

    // 開発者モードの行（オンのときだけ出す）
    renderDevRow(false);

    // プレミアムステータス表示
    const premStatus = el('settings-premium-status');
    if (premStatus) {
        if (isPremium) {
            premStatus.textContent = t('settings.premium_active');
            premStatus.className = 'settings-premium-status is-premium';
        } else {
            premStatus.innerHTML = '<button class="settings-premium-btn" onclick="openPurchaseModal();">' + t('settings.premium_upgrade') + '</button>';
            premStatus.className = 'settings-premium-status';
        }
    }
}

function closeSettings() { /* 設定はタブになったので閉じるものは無い */ }

function saveSetting(key, value) {
    appSettings[key] = value;
    localStorage.setItem('poker_settings', JSON.stringify(appSettings));
}

function setSpeedSetting(speed) {
    appSettings.speed = speed;
    localStorage.setItem('poker_settings', JSON.stringify(appSettings));
    el('seg-normal').classList.toggle('active', speed !== 'fast');
    el('seg-fast').classList.toggle('active', speed === 'fast');
    // speedMult はページリロードで反映（次のハンドから）
}

// ==============================
// スポット練習モード
// ==============================
// ホームのスタート（spot=true でスポット練習）。スポット練習はプレミアム限定（以前の toggleSpotMode と同じゲート）
function startPractice(spot) {
    if (spot && !isPremium) {
        openPurchaseModal();
        return;
    }
    const sameMode = isSpotMode === spot;
    isSpotMode = spot;
    updatePlayTitle();
    showTab('play');
    // 通常の練習で、進行中のハンドがあれば続きから。モードを変えたら新しいハンド
    if (!spot && sameMode && currentState && !currentState.finished) {
        updateUI();
        if (typeof renderPanels === 'function') renderPanels();
        return;
    }
    startHand();
}

function goHome() {
    showTab('home');
}

// ゲーム画面の上: スポット練習のときだけ設定を出す（通常は戻るボタンだけ）
function updatePlayTitle() {
    const title = el('play-title');
    if (!title) return;
    title.textContent = isSpotMode
        ? t('home2.spot_title', { pos: (spotPosition || t('game.spot_random')) + ' · ' + (spotHands === 'range' ? t('home2.hands_range') : t('game.spot_random')) })
        : '';
}

function setSpotHands(v) {
    spotHands = v;
    document.querySelectorAll('.spot-hand-btn').forEach(b => b.classList.toggle('active', b.dataset.hands === v));
}

// ホームの表示を今の状態に合わせる（進行中のハンドがあれば「続きから」）
function refreshHome() {
    const start = el('btn-home-start');
    if (start) start.textContent = (!isSpotMode && currentState && !currentState.finished) ? t('home2.resume') : t('home2.start');
    const badge = el('hm-spot-badge');
    if (badge) badge.classList.toggle('hidden', !!isPremium);
    renderHomeStats();
}

// 成績と今日の課題（端末の記録から。読めなければ空のまま）
async function renderHomeStats() {
    if (typeof StatsStore === 'undefined' || typeof StatsCalc === 'undefined') return;
    let sum, data;
    try { data = await StatsStore.loadAll(); sum = StatsCalc.getHomeSummary(data); } catch (e) { return; }
    renderWeek(StatsCalc.getWeekCards(data, currentUserId, Date.now(), loadWeekSwaps()[String(weekKeyNow())] || {}));
    // アクション傾向（分析タブの「プレイの傾向」と同じ。全期間）
    try {
        const st = StatsCalc.getPlayStyle(data, 'all');
        const sign = (v) => (v > 0 ? '+' : v < 0 ? '−' : '±') + Math.abs(v).toFixed(1);
        if (st.ready) {
            el('hm-style-name').textContent = t('stats.style.name.' + st.type);
            el('hm-style-sub').textContent = t('stats.style.diff', { loose: sign(st.loose_diff), aggr: sign(st.aggr_diff) });
        } else {
            el('hm-style-name').textContent = '—';
            el('hm-style-sub').textContent = t('home2.style_need', { n: String(st.need) });
        }
    } catch (e) { /* 表示だけなので無視 */ }
    if (sum.leak) {
        const l = sum.leak;
        el('hm-task-title').textContent = t('home2.task_title', { pos: l.pos, street: t('street.' + l.street), action: t('home2.act.' + l.action) });
        el('hm-task-sub').textContent = t('home2.task_sub', { bb: l.avg_ev_loss.toFixed(1), n: l.count });
    } else {
        el('hm-task-title').textContent = '—';
        el('hm-task-sub').textContent = t('home2.task_empty');
    }
}

// 今週のカード: もらったカードは表。今日の1枚は10ハンド打つと裏向きで置かれ、タップでめくる（めくった日は端末に保存）。
// 今日はまだならあと何ハンドか、過ぎた日は空き、先の日は裏向きの模様
const WC_REVEALED_KEY = 'poker_wc_revealed';
let _weekCards = null;

function weekCardFace(card, extra) {
    const c = parseCardStr(card);
    return '<div class="hm-wc got ' + c.color + (extra ? ' ' + extra : '') + '"><b>' + c.rank + '</b><i>' + c.symbol + '</i></div>';
}

// 追加の1枚での入れ替えの選択（端末に保存）: { 週の初日のキー: { 引いた曜日: 入れ替えた曜日 or -1 } }
const WC_SWAPS_KEY = 'poker_wc_swaps';
function loadWeekSwaps() {
    try { return JSON.parse(localStorage.getItem(WC_SWAPS_KEY) || '{}') || {}; } catch (e) { return {}; }
}
function weekKeyNow() {
    const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

// 追加の1枚: 引いたカードと今週のカードを並べ、入れ替える1枚を選ぶ（入れ替えないも可）。1日1回
let _drawTarget = -1;
function openDrawSheet() {
    const w = _weekCards;
    if (!w || !w.drawReady) return;
    _drawTarget = -1;
    // 追加の1枚も裏向きで出し、タップでめくってから入れ替えを選ぶ
    el('hm-draw-card').innerHTML = '<div class="hm-wc ready" onclick="revealDrawCard(this)"><span class="hm-wc-tap">TAP</span></div>';
    el('hm-draw-hint').classList.remove('hidden');
    el('hm-draw-body').classList.add('hidden');
    renderDrawChoices();
    openSheet('draw-sheet');
}
function revealDrawCard(node) {
    const w = _weekCards;
    if (!w) return;
    el('hm-draw-hint').classList.add('hidden');
    flipCardInto(node, w.days[w.todayIdx].draw, () => el('hm-draw-body').classList.remove('hidden'));
}
function renderDrawChoices() {
    const w = _weekCards;
    const names = t('home2.days_mon').split(',');
    el('hm-draw-week').innerHTML = w.days.map((d, i) => {
        const face = d.card ? weekCardFace(d.card, i === _drawTarget ? 'picked' : '') : '<div class="hm-wc missed"></div>';
        return '<div class="hm-wd' + (d.card ? ' pickable' : '') + '"' + (d.card ? ' onclick="pickDrawTarget(' + i + ')"' : '') + '>' + face + '<span>' + names[i] + '</span></div>';
    }).join('');
    const cards = w.days.filter((d) => d.card).map((d) => d.card);
    const now = StatsCalc.bestHandCategory(cards);
    let line = t('home2.draw_keep', { hand: t('home2.rank.' + now) });
    if (_drawTarget >= 0) {
        const after = w.days.map((d, i) => (i === _drawTarget ? w.days[w.todayIdx].draw : d.card)).filter(Boolean);
        line = t('home2.draw_after', { hand: t('home2.rank.' + StatsCalc.bestHandCategory(after)) }) + ' / ' + line;
    }
    el('hm-draw-preview').textContent = line;
    el('hm-draw-swap').disabled = _drawTarget < 0;
}
function pickDrawTarget(i) {
    _drawTarget = _drawTarget === i ? -1 : i;
    renderDrawChoices();
}
function decideDraw(swap) {
    const w = _weekCards;
    if (!w) return;
    const all = loadWeekSwaps();
    const wk = String(w.weekKey);
    all[wk] = all[wk] || {};
    all[wk][w.todayIdx] = swap ? _drawTarget : -1;
    localStorage.setItem(WC_SWAPS_KEY, JSON.stringify(all));
    closeSheet('draw-sheet');
    renderHomeStats();
}

function renderWeek(w) {
    const box = el('hm-wcards');
    if (!box) return;
    _weekCards = w;
    const names = t('home2.days_mon').split(',');
    const today = w.days[w.todayIdx];
    const waiting = today.status === 'got' && localStorage.getItem(WC_REVEALED_KEY) !== String(today.key);
    box.innerHTML = w.days.map((d, i) => {
        let face;
        if (i === w.todayIdx && waiting) {
            face = '<div class="hm-wc ready" onclick="event.stopPropagation(); revealTodayCard(this)"><span class="hm-wc-tap">TAP</span></div>';
        } else if (d.status === 'got') {
            face = weekCardFace(d.card, d.swapped ? 'swapped' : '');
        } else if (d.status === 'today') {
            face = '<div class="hm-wc today"><b>' + d.hands + '</b><i>/' + w.need + '</i></div>';
        } else {
            face = '<div class="hm-wc ' + d.status + '"></div>';
        }
        return '<div class="hm-wd' + (i === w.todayIdx ? ' is-today' : '') + '">' + face + '<span>' + names[i] + '</span></div>';
    }).join('');
    const best = waiting ? w.bestBeforeToday : w.best;
    el('hm-week-best').textContent = best ? t('home2.rank.' + best) : '';
    el('hm-week-text').textContent = waiting ? t('home2.cards_ready')
        : w.drawReady ? t('home2.draw_ready')
        : today.status === 'got' && !w.drawDone ? t('home2.draw_need', { n: String(w.drawNeed - today.hands) })
        : today.status === 'got' ? t('home2.cards_done')
        : t('home2.cards_need', { n: String(w.need - today.hands) });
    el('hm-draw-btn').classList.toggle('hidden', waiting || !w.drawReady);
    // ボタンが出ている間は説明の行を隠して高さを抑える
    el('hm-week-text').classList.toggle('hidden', !waiting && w.drawReady);
}

// カードをめくる（裏 → 表の回転）。node を回転する要素に置き換え、終わったら done を呼ぶ
function flipCardInto(node, card, done) {
    const flip = document.createElement('div');
    flip.className = 'hm-flip';
    flip.innerHTML = '<div class="hm-flip-in"><div class="hm-wc ready hm-flip-back"></div>' + weekCardFace(card, 'hm-flip-front') + '</div>';
    node.replaceWith(flip);
    requestAnimationFrame(() => requestAnimationFrame(() => flip.classList.add('on')));
    setTimeout(done, 750);
}

// 今日の1枚をめくる
function revealTodayCard(node) {
    const w = _weekCards;
    if (!w) return;
    const today = w.days[w.todayIdx];
    localStorage.setItem(WC_REVEALED_KEY, String(today.key));
    flipCardInto(node, today.card, () => renderWeek(w));
}

// ===== 下から出るシート（スポット練習の設定・役のコレクション） =====
function openSheet(id) {
    const sh = el(id);
    if (!sh) return;
    sh.classList.remove('hidden');
    requestAnimationFrame(() => sh.classList.add('open'));
}

function closeSheet(id) {
    const sh = el(id);
    if (!sh) return;
    sh.classList.remove('open');
    setTimeout(() => sh.classList.add('hidden'), 200);
}

function openSpotSheet() { openSheet('spot-sheet'); }
function closeSpotSheet() { closeSheet('spot-sheet'); }

// 役のコレクション: 役ごとの回数と、終わった週ごとの7枚
// 役のコレクション: マイベスト（選んだ1週）、役ごとの回数、終わった週ごとの7枚
const WC_MYBEST_KEY = 'poker_wc_mybest';
let _collection = null;

async function openCollection() {
    try { _collection = StatsCalc.getCardCollection(await StatsStore.loadAll(), currentUserId, Date.now(), loadWeekSwaps()); } catch (e) { return; }
    renderCollection();
    openSheet('collection-sheet');
}

function collectionWeekRow(wk, withStar, isBest) {
    const k = String(wk.start);
    const date = t('home2.collection_week', { m: String(+k.slice(4, 6)), d: String(+k.slice(6, 8)) });
    const cards = wk.cards.map((c) => (c ? weekCardFace(c) : '<div class="hm-wc missed"></div>')).join('');
    const star = withStar ? '<button class="hm-col-star' + (isBest ? ' on' : '') + '" onclick="toggleMyBest(' + wk.start + ')">' + (isBest ? '★' : '☆') + '</button>' : '';
    return '<div class="hm-col-week"><div class="hm-col-week-head"><span>' + date + '</span><b>' + t('home2.rank.' + wk.best) + '</b>' + star + '</div><div class="hm-col-cards">' + cards + '</div></div>';
}

function renderCollection() {
    const col = _collection;
    if (!col) return;
    const bestKey = localStorage.getItem(WC_MYBEST_KEY);
    const best = col.weeks.find((wk) => String(wk.start) === bestKey);
    el('hm-col-mybest').innerHTML = best
        ? collectionWeekRow(best, false, true)
        : '<div class="hm-col-mybest-empty">' + t(col.weeks.length ? 'home2.mybest_empty' : 'home2.mybest_none') + '</div>';
    el('hm-col-grid').innerHTML = col.categories.map((c) => {
        const n = col.counts[c];
        return '<div class="hm-col-item' + (n ? ' has' : '') + '"><span>' + t('home2.rank.' + c) + '</span><b>' + (n ? '×' + n : '—') + '</b></div>';
    }).join('');
    el('hm-col-weeks').innerHTML = col.weeks.length
        ? col.weeks.map((wk) => collectionWeekRow(wk, true, String(wk.start) === bestKey)).join('')
        : '<div class="hm-card-sub">' + t('home2.collection_empty') + '</div>';
}

// ☆ を押した週をマイベストにする（選んでいる週をもう一度押すと外す）
function toggleMyBest(start) {
    if (localStorage.getItem(WC_MYBEST_KEY) === String(start)) localStorage.removeItem(WC_MYBEST_KEY);
    else localStorage.setItem(WC_MYBEST_KEY, String(start));
    renderCollection();
}

function setSpotPosition(pos) {
    spotPosition = pos;
    document.querySelectorAll('.spot-pos-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.pos === pos);
    });
}

function setSpotParticipated(val) {
    spotParticipatedOnly = val;
}
