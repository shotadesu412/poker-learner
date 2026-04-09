// static/home.js

document.addEventListener("DOMContentLoaded", () => {
    // ----------------------------
    // Settings Management
    // ----------------------------
    const defaultSettings = {
        showRange: true,
        showFeedback: true,
        speed: "normal"
    };

    // Load from localStorage or use defaults
    let currentSettings = JSON.parse(localStorage.getItem("poker_settings")) || defaultSettings;

    // Elements
    const toggleRange = document.getElementById("toggle-range");
    const toggleFeedback = document.getElementById("toggle-feedback");
    const speedNormal = document.getElementById("speed-normal");
    const speedFast = document.getElementById("speed-fast");

    // Initialize UI with current settings
    function initSettingsUI() {
        if (!currentSettings) return;
        toggleRange.checked = currentSettings.showRange !== false;
        toggleFeedback.checked = currentSettings.showFeedback !== false;
        
        if (currentSettings.speed === "fast") {
            speedFast.checked = true;
        } else {
            speedNormal.checked = true;
        }
    }

    // Modal Elements
    const modal = document.getElementById("settings-modal");
    const btn = document.getElementById("settings-btn");
    const span = document.getElementById("close-settings");
    const saveBtn = document.getElementById("save-settings-btn");

    // Open Modal
    btn.onclick = function() {
        initSettingsUI(); // refresh UI to match current settings
        modal.style.display = "block";
    }

    // Close Modal without saving specifically (though we'd usually save on change, here we save on Save button)
    span.onclick = function() {
        modal.style.display = "none";
    }

    // Close Modal on outside click
    window.onclick = function(event) {
        if (event.target == modal) {
            modal.style.display = "none";
        }
    }

    // Save Settings
    saveBtn.onclick = function() {
        currentSettings = {
            showRange: toggleRange.checked,
            showFeedback: toggleFeedback.checked,
            speed: speedNormal.checked ? "normal" : "fast"
        };
        
        localStorage.setItem("poker_settings", JSON.stringify(currentSettings));
        
        // Brief visual feedback on button
        const originalText = saveBtn.innerText;
        saveBtn.innerText = "保存しました！";
        saveBtn.style.backgroundColor = "var(--secondary)";
        
        setTimeout(() => {
            saveBtn.innerText = originalText;
            saveBtn.style.backgroundColor = "";
            modal.style.display = "none";
        }, 800);
    }
    
    // Initial UI Setup
    initSettingsUI();
});
