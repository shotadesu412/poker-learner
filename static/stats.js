// stats.js — 分析ページのデータ取得とUI描画ロジック
const PERIOD_LABELS = { all: "全期間", "30d": "直近30日", "7d": "直近7日", last: "直近1セッション" };
let currentPeriod = "all";

// ==============================
// 初期化
// ==============================
document.addEventListener("DOMContentLoaded", () => {
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

async function loadAll(period) {
    showLoading(true);
    try {
        const userId = localStorage.getItem("poker_user_id") || "";
        const [overview, position, streets, leaks, aiHistory] = await Promise.all([
            fetch(`/api/stats/overview?period=${period}`).then(r => r.json()),
            fetch("/api/stats/position").then(r => r.json()),
            fetch("/api/stats/streets").then(r => r.json()),
            fetch("/api/stats/leaks").then(r => r.json()),
            fetch(`/api/stats/saved_hands?user_id=${userId}`).then(r => r.json()),
        ]);
        renderOverview(overview);
        renderPosition(position);
        renderStreets(streets);
        renderLeaks(leaks);
        renderAiHistory(aiHistory);
    } catch (e) {
        console.error("Stats API error:", e);
    }
    showLoading(false);
}

// ==============================
// オーバービュー
// ==============================
function renderOverview(data) {
    const rate = data.gto_match_rate ?? 0;
    document.getElementById("gto-score").textContent = rate + "%";
    document.getElementById("gauge-bar").style.width = rate + "%";
    document.getElementById("stat-vpip").textContent = data.vpip + "%";
    document.getElementById("stat-pfr").textContent = data.pfr + "%";
    document.getElementById("stat-threebet").textContent = data.three_bet_rate + "%";
    document.getElementById("stat-actions").textContent = data.total_actions;
    document.getElementById("stat-ev-loss").textContent = (data.avg_ev_loss ?? 0).toFixed(3) + " bb";
    document.getElementById("stat-total-hands").textContent = Math.round(data.vpip > 0 ? data.total_actions / 4 : 0);
}

// ==============================
// ポジション別テーブル
// ==============================
function renderPosition(rows) {
    const tbody = document.getElementById("pos-table-body");
    if (!rows || rows.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="no-data">データがありません</td></tr>`;
        return;
    }
    tbody.innerHTML = rows.map(r => {
        const gtoClass = r.gto_rate >= 70 ? "gto-high" : r.gto_rate >= 50 ? "gto-mid" : "gto-low";
        const handsLabel = r.hands === 0 ? "—" : r.hands + "手";
        return `<tr>
            <td class="pos-name">${r.pos}</td>
            <td>${handsLabel}</td>
            <td>${r.vpip}%</td>
            <td>${r.pfr}%</td>
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
// リークファインダー
// ==============================
function renderLeaks(leaks) {
    const container = document.getElementById("leak-list");
    if (!leaks || leaks.length === 0) {
        container.innerHTML = `<div class="no-data">目立ったリークは見つかりませんでした</div>`;
        return;
    }
    container.innerHTML = leaks.map((lk, i) => {
        const isMarginal = lk.evaluation === "△";
        return `<div class="leak-item ${isMarginal ? "marginal" : ""}">
            <div class="leak-desc">${i + 1}. ${lk.description}</div>
            <div class="leak-meta">
                <span>${lk.pos} / ${lk.street}</span>
                <span>アクション: ${lk.action}</span>
                <span>発生: ${lk.count}回</span>
                <span class="leak-ev-loss">平均EV損失: -${lk.avg_ev_loss.toFixed(3)} bb</span>
            </div>
        </div>`;
    }).join("");
}

function showLoading(on) {
    const el = document.getElementById("loading-overlay");
    if (el) el.style.display = on ? "block" : "none";
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
        // Parse date for clean display
        const dt = new Date(h.timestamp);
        const dateStr = dt.toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        
        // Excerpt for the header title (e.g. "ボード: [9♠, J♥...] ...")
        const firstLine = h.hand_context.split('\\n')[1] || h.hand_context.split('\\n')[0];
        
        return `<div class="ai-history-item">
            <div class="ai-history-header" onclick="toggleAiBody(${i})">
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

window.toggleAiBody = function(index) {
    const body = document.getElementById(`ai-body-${index}`);
    const toggle = document.getElementById(`ai-toggle-${index}`);
    if (body.classList.contains('active')) {
        body.classList.remove('active');
        toggle.innerText = "▼ 詳細を見る";
    } else {
        body.classList.add('active');
        toggle.innerText = "▲ 閉じる";
    }
};
