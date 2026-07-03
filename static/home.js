// static/home.js

document.addEventListener("DOMContentLoaded", () => {
    const defaultSettings = { showFeedback: true, speed: "normal" };
    let currentSettings = JSON.parse(localStorage.getItem("poker_settings")) || defaultSettings;

    // --- 設定モーダルを開く ---
    const settingsBtn = document.getElementById("settings-btn");
    if (settingsBtn) {
        settingsBtn.onclick = () => openHomeSettings();
    }

    // プレミアムステータス表示の描画
    function renderPremiumStatus(isPremium) {
        const premStatus = document.getElementById("home-premium-status");
        if (!premStatus) return;
        if (isPremium) {
            premStatus.textContent = "加入中";
            premStatus.className = "home-premium-status is-premium";
        } else {
            premStatus.innerHTML = '<button class="home-premium-upgrade-btn" onclick="location.href=\'/play#premium\'">アップグレード</button>';
            premStatus.className = "home-premium-status";
        }
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

        // プレミアムステータス: まずキャッシュ値で即描画 → APIで最新化
        // （従来は localStorage の poker_is_premium を読むだけで、どこにも
        //   書き込まれていなかったため加入済みでも常に「アップグレード」表示だった）
        renderPremiumStatus(localStorage.getItem("poker_is_premium") === "true");
        const uid = localStorage.getItem("poker_user_id") || "";
        fetch(`/api/subscription?user_id=${encodeURIComponent(uid)}`)
            .then(r => r.json())
            .then(d => {
                const p = !!d.is_premium;
                localStorage.setItem("poker_is_premium", p ? "true" : "false");
                renderPremiumStatus(p);
            })
            .catch(() => {});

        modal.classList.remove("hidden");
    };

    // iOS StoreKitの復元/購入通知（ホーム画面には script.js が無く、
    // 通知が届いても無視されていたためここで受ける）
    window.onRestoreSuccess = function() {
        localStorage.setItem("poker_is_premium", "true");
        renderPremiumStatus(true);
    };
    window.onPurchaseSuccess = function() {
        localStorage.setItem("poker_is_premium", "true");
        renderPremiumStatus(true);
    };
    window.onPurchaseCancel = window.onPurchaseCancel || function() {};
    window.onAdDismissed = window.onAdDismissed || function() {};

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
