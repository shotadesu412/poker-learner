// stats.js — 分析ページのデータ取得とUI描画ロジック
let currentPeriod = "all";
let isPremium = false;

document.addEventListener("DOMContentLoaded", async () => {
    const userId = localStorage.getItem("poker_user_id") || "";

    // サブスク状態を取得してからコンテンツをロード
    try {
        const res = await fetch(`/api/subscription?user_id=${encodeURIComponent(userId)}`);
        const data = await res.json();
        isPremium = data.is_premium || false;
    } catch (e) {
        isPremium = false;
    }

    applyPremiumGates();
    loadAll(currentPeriod);

    document.querySelectorAll(".period-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            currentPeriod = btn.dataset.period;
            document.querySelectorAll(".period-btn").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            loadAll(currentPeriod);
        });
    });
});

function applyPremiumGates() {
    const lockIds = ["lock-position", "lock-leaks", "lock-hand-history"];
    lockIds.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.style.display = isPremium ? "none" : "flex";
    });
}

async function loadAll(period) {
    showLoading(true);
    const userId = localStorage.getItem("poker_user_id") || "";
    try {
        const [overview, streets] = await Promise.all([
            fetch(`/api/stats/overview?period=${period}&user_id=${userId}`).then(r => r.json()),
            fetch(`/api/stats/streets?user_id=${userId}`).then(r => r.json()),
        ]);
        renderOverview(overview);
        renderStreets(streets);

        const [position, leaks, aiHistory, handHistory, personalRange] = await Promise.all([
            fetch(`/api/stats/position?user_id=${userId}`).then(r => r.json()),
            fetch(`/api/stats/leaks?user_id=${userId}`).then(r => r.json()),
            fetch(`/api/stats/saved_hands?user_id=${userId}`).then(r => r.json()),
            fetch(`/api/stats/hand_history?user_id=${userId}`).then(r => r.json()),
            fetch(`/api/stats/personal_range?period=${period}&user_id=${userId}`).then(r => r.json()),
        ]);
        renderPosition(position);
        renderLeaks(leaks);
        renderAiHistory(aiHistory);
        renderHandHistory(handHistory);
        renderPersonalRange(personalRange);
    } catch (e) {
        console.error("Stats API error:", e);
    }
    showLoading(false);
}

// ==============================
// 総合スコア
// ==============================
function renderOverview(data) {
    const rate = data.gto_match_rate ?? 0;
    document.getElementById("gto-score").textContent = rate + "%";
    document.getElementById("gauge-bar").style.width = rate + "%";
    document.getElementById("stat-vpip").textContent = data.vpip + "%";
    document.getElementById("stat-pfr").textContent = data.pfr + "%";
    document.getElementById("stat-actions").textContent = data.total_actions;
    document.getElementById("stat-ev-loss").textContent = (data.avg_ev_loss ?? 0).toFixed(2) + " bb";
}

// ==============================
// ポジション別テーブル
// ==============================
function renderPosition(rows) {
    const tbody = document.getElementById("pos-table-body");
    if (!rows || rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="3" class="no-data">データがありません</td></tr>`;
        return;
    }
    tbody.innerHTML = rows.map(r => {
        const gtoClass = r.gto_rate >= 70 ? "gto-high" : r.gto_rate >= 50 ? "gto-mid" : "gto-low";
        const handsLabel = r.hands === 0 ? "—" : r.hands + "回";
        return `<tr>
            <td class="pos-name">${r.pos}</td>
            <td>${handsLabel}</td>
            <td><span class="gto-chip ${gtoClass}">${r.gto_rate}%</span></td>
        </tr>`;
    }).join("");
}

// ==============================
// ストリート別評価分布
// ==============================
function renderStreets(data) {
    const container = document.getElementById("street-bars");
    const streets = ["PREFLOP", "FLOP", "TURN", "RIVER"];
    const labels = { PREFLOP: "プリフロップ", FLOP: "フロップ", TURN: "ターン", RIVER: "リバー" };

    container.innerHTML = streets.map(st => {
        const d = data[st] || { "◎": 0, "◯": 0, "△": 0, "×": 0 };
        const total = d["◎"] + d["◯"] + d["△"] + d["×"];
        const pct = (n) => total > 0 ? Math.round(n / total * 100) : 0;
        const oo = pct(d["◎"]), o = pct(d["◯"]), t = pct(d["△"]), x = pct(d["×"]);
        const seg = (w, cls, label) => w > 0
            ? `<div class="bar-seg ${cls}" style="width:${w}%">${w > 8 ? label : ""}</div>`
            : "";
        const barHTML = total > 0
            ? seg(oo, "bar-optimal", "◎") + seg(o, "bar-good", "◯") + seg(t, "bar-marginal", "△") + seg(x, "bar-bad", "×")
            : `<div class="bar-empty"></div>`;
        return `<div class="street-row">
            <div class="street-label">${labels[st]}</div>
            <div class="stacked-bar">${barHTML}</div>
            <div class="street-total">${total > 0 ? total + "回" : "—"}</div>
        </div>`;
    }).join("");
}

// ==============================
// よくあるミス
// ==============================
function renderLeaks(leaks) {
    const container = document.getElementById("leak-list");
    if (!leaks || leaks.length === 0) {
        container.innerHTML = `<div class="no-data">目立ったミスは見つかりませんでした</div>`;
        return;
    }
    const actionLabel = { FOLD: "フォールド", CALL: "コール", BET: "ベット", RAISE: "レイズ", CHECK: "チェック" };
    container.innerHTML = leaks.map((lk, i) => {
        const isMarginal = lk.evaluation === "△";
        return `<div class="leak-item ${isMarginal ? "marginal" : ""}">
            <div class="leak-desc">${i + 1}. ${lk.description}</div>
            <div class="leak-meta">
                <span>${lk.pos} / ${lk.street}</span>
                <span>${actionLabel[lk.action] || lk.action} × ${lk.count}回</span>
                <span class="leak-ev-loss">平均損失 -${lk.avg_ev_loss.toFixed(2)} bb</span>
            </div>
        </div>`;
    }).join("");
}

// ==============================
// AIコーチ履歴
// ==============================
function renderAiHistory(historyData) {
    const container = document.getElementById("ai-history-list");
    if (!historyData || historyData.length === 0) {
        container.innerHTML = `<div class="no-data">AIコーチに相談した履歴はまだありません</div>`;
        return;
    }
    container.innerHTML = historyData.map((h, i) => {
        const dt = new Date(h.timestamp);
        const dateStr = dt.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        return `<div class="ai-history-item">
            <div class="ai-history-header" onclick="toggleCollapse('ai-body-${i}', 'ai-toggle-${i}')">
                <span style="font-weight:bold;">ハンド ${historyData.length - i} <span class="ai-history-date">(${dateStr})</span></span>
                <span class="ai-history-toggle" id="ai-toggle-${i}">▼ 詳細を見る</span>
            </div>
            <div class="ai-history-body" id="ai-body-${i}">
                <div class="ai-context-box">${h.hand_context}</div>
                <div class="ai-feedback-box">${h.ai_feedback}</div>
            </div>
        </div>`;
    }).join("");
}

// ==============================
// ハンド履歴
// ==============================
function renderHandHistory(hands) {
    const container = document.getElementById("hand-history-list");
    if (!hands || hands.length === 0) {
        container.innerHTML = `<div class="no-data">ハンド履歴がまだありません</div>`;
        return;
    }
    const evalIcon = { "◎": "◎", "◯": "◯", "△": "△", "×": "×" };
    const evalClass = { "◎": "eval-optimal", "◯": "eval-good", "△": "eval-marginal", "×": "eval-bad" };
    const actionLabel = { FOLD: "フォールド", CALL: "コール", BET: "ベット", RAISE: "レイズ", CHECK: "チェック" };

    container.innerHTML = hands.map((h, i) => {
        const dt = new Date(h.date);
        const dateStr = dt.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        const cards = h.hole_cards || "??";
        const pos = h.position || "?";
        const actionsHtml = (h.actions || []).map(a => {
            const cls = evalClass[a.evaluation] || "";
            const lbl = actionLabel[a.action] || a.action;
            const amt = a.amount > 0 ? ` ${a.amount.toFixed(1)}bb` : "";
            return `<span class="hh-action ${cls}">[${a.street.slice(0,2)}] ${lbl}${amt}</span>`;
        }).join(" ");

        return `<div class="hh-item">
            <div class="hh-header" onclick="toggleCollapse('hh-body-${i}', 'hh-toggle-${i}')">
                <span class="hh-cards">${cards}</span>
                <span class="hh-pos">${pos}</span>
                <span class="hh-date">${dateStr}</span>
                <span class="hh-toggle" id="hh-toggle-${i}">▼</span>
            </div>
            <div class="hh-body" id="hh-body-${i}">
                <div class="hh-actions">${actionsHtml || "アクションなし"}</div>
            </div>
        </div>`;
    }).join("");
}

// ==============================
// パーソナルレンジグリッド
// ==============================
function renderPersonalRange(data) {
    const container = document.getElementById("personal-range-grid");
    if (!container) return;

    const ranks = ['A','K','Q','J','T','9','8','7','6','5','4','3','2'];
    const hasData = data && Object.keys(data).length > 0;

    if (!hasData) {
        container.innerHTML = `<div class="no-data" style="grid-column:span 13;padding:16px;text-align:center;font-size:0.8rem;color:#666;">プリフロップデータがまだありません。ゲームをプレイすると表示されます。</div>`;
        return;
    }

    container.innerHTML = "";
    for (let r1 = 0; r1 < 13; r1++) {
        for (let r2 = 0; r2 < 13; r2++) {
            let combo;
            if (r1 === r2) {
                combo = ranks[r1] + ranks[r2];
            } else if (r1 < r2) {
                combo = ranks[r1] + ranks[r2] + "s";
            } else {
                combo = ranks[r2] + ranks[r1] + "o";
            }

            const cell = document.createElement("div");
            cell.className = "pr-cell";
            cell.innerText = combo;

            const d = data[combo];
            if (d) {
                const total = (d.OPEN || 0) + (d["3BET"] || 0) + (d.CALL || 0) + (d.FOLD || 0);
                const played = total - (d.FOLD || 0);
                const playRate = total > 0 ? played / total : 0;
                const opacity = Math.max(0.3, Math.min(1.0, 0.3 + playRate * 0.7));

                let bg = "#374151"; // fold / no play
                if ((d["3BET"] || 0) > 0 && (d["3BET"] || 0) >= (d.OPEN || 0)) {
                    bg = `rgba(139,92,246,${opacity})`; // 3bet = purple
                } else if ((d.OPEN || 0) > 0) {
                    bg = `rgba(16,185,129,${opacity})`; // open = green
                } else if ((d.CALL || 0) > 0) {
                    bg = `rgba(59,130,246,${opacity})`; // call = blue
                }
                cell.style.background = bg;

                const tip = `${combo}: オープン${d.OPEN||0} 3Bet${d["3BET"]||0} コール${d.CALL||0} フォールド${d.FOLD||0}`;
                cell.innerHTML += `<span class="pr-tooltip">${tip}</span>`;
            }

            container.appendChild(cell);
        }
    }
}

function toggleCollapse(bodyId, toggleId) {
    const body = document.getElementById(bodyId);
    const toggle = document.getElementById(toggleId);
    if (!body) return;
    const isOpen = body.classList.contains('active');
    body.classList.toggle('active', !isOpen);
    if (toggle) toggle.textContent = isOpen ? "▼ 詳細を見る" : "▲ 閉じる";
}

function showLoading(on) {
    const el = document.getElementById("loading-overlay");
    if (el) el.style.display = on ? "block" : "none";
}
