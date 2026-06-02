// static/home.js

document.addEventListener("DOMContentLoaded", () => {
    const defaultSettings = { showFeedback: true, speed: "normal" };
    let currentSettings = JSON.parse(localStorage.getItem("poker_settings")) || defaultSettings;

    // --- 設定モーダルを開く ---
    const settingsBtn = document.getElementById("settings-btn");
    if (settingsBtn) {
        settingsBtn.onclick = () => openHomeSettings();
    }

    window.openHomeSettings = function() {
        const modal = document.getElementById("settings-modal");
        if (!modal) return;

        // UIに現在の設定を反映
        const fbToggle = document.getElementById("toggle-feedback");
        if (fbToggle) fbToggle.checked = currentSettings.showFeedback !== false;

        const segNormal = document.getElementById("home-seg-normal");
        const segFast   = document.getElementById("home-seg-fast");
        if (segNormal && segFast) {
            segNormal.classList.toggle("active", currentSettings.speed !== "fast");
            segFast.classList.toggle("active", currentSettings.speed === "fast");
        }

        // プレミアムステータス
        const premStatus = document.getElementById("home-premium-status");
        if (premStatus) {
            const isPremium = localStorage.getItem("poker_is_premium") === "true";
            if (isPremium) {
                premStatus.textContent = "✓ 加入中";
                premStatus.className = "home-premium-status is-premium";
            } else {
                premStatus.innerHTML = '<button class="home-premium-upgrade-btn" onclick="location.href=\'/play#premium\'">アップグレード</button>';
                premStatus.className = "home-premium-status";
            }
        }

        modal.classList.remove("hidden");
    };

    window.closeHomeSettings = function() {
        const modal = document.getElementById("settings-modal");
        if (modal) modal.classList.add("hidden");
    };

    window.setHomeSpeed = function(speed) {
        currentSettings.speed = speed;
        localStorage.setItem("poker_settings", JSON.stringify(currentSettings));
        const segNormal = document.getElementById("home-seg-normal");
        const segFast   = document.getElementById("home-seg-fast");
        if (segNormal && segFast) {
            segNormal.classList.toggle("active", speed !== "fast");
            segFast.classList.toggle("active", speed === "fast");
        }
    };

    // アクション評価トグルは変更時に即保存
    document.addEventListener("change", (e) => {
        if (e.target.id === "toggle-feedback") {
            currentSettings.showFeedback = e.target.checked;
            localStorage.setItem("poker_settings", JSON.stringify(currentSettings));
        }
    });
});
