// game_api.js — ゲーム進行・統計の呼び出し口（JS 移植 フェーズ6）
//
// サーバー計算（/api/start_hand 等）と端末計算（static/poker/ の JS エンジン + IndexedDB）を
// フラグで切り替える。どちらでも戻り値はサーバーの JSON と同じ形なので、画面側は区別しなくてよい。
//
// ⚠️ 既定はサーバー計算。アプリのアップデートが審査を通るまでは既定を変えないこと（CLAUDE.md）。
//   端末計算を試す: URL に ?engine=local（localStorage に保存される）/ 戻す: ?engine=server
//
// 端末計算のモジュールは端末モードのときだけ読み込む（サーバーモードの通信量を増やさないため）。
// 依存: i18n.js（withLang）

const POKER_JS_VERSION = 1;   // static/poker/ 以下を変えたら上げる（キャッシュバスティング）

const ENGINE_MODE = (() => {
    try {
        const q = new URLSearchParams(location.search).get("engine");
        if (q === "local" || q === "server") localStorage.setItem("poker_engine", q);
        return localStorage.getItem("poker_engine") === "local" ? "local" : "server";
    } catch (e) {
        return "server";
    }
})();

// 読み込み順は依存順（MIGRATION_NOTES.md フェーズ5 参照）
const POKER_GAME_MODULES = [
    "rng", "hand_table", "hand_eval", "pyfmt", "messages", "ranges", "range_utils", "equity",
    "ev_calculator", "hand_classifier", "bet_sizing", "evaluator", "engine", "game",
    "stats_calc", "stats_store",
];
const POKER_STATS_MODULES = ["pyfmt", "messages", "stats_calc", "stats_store"];

// async=false の script は並行してダウンロードしつつ、追加した順に実行される
function loadPokerModules(names) {
    return Promise.all(names.map(name => new Promise((resolve, reject) => {
        const s = document.createElement("script");
        s.src = `/static/poker/${name}.js?v=${POKER_JS_VERSION}`;
        s.async = false;
        s.onload = resolve;
        s.onerror = () => reject(new Error(`${name}.js の読み込みに失敗`));
        document.head.appendChild(s);
    })));
}

// 端末モードに切り替えた初回だけ、サーバーの統計を端末へ取り込む。失敗しても次回やり直す
async function importServerStats(userId) {
    try {
        const r = await StatsStore.importFromServer(async () => {
            const res = await fetch(`/api/stats/export?user_id=${encodeURIComponent(userId)}`);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.json();
        });
        if (!r.skipped) console.log("[GameApi] サーバーの統計を取り込みました", r);
    } catch (e) {
        console.warn("[GameApi] 統計の取り込みに失敗（次回再試行）:", e);
    }
}

// サーバーの JSON と同じく、エンジン内部と参照を共有しない値にする
const detach = (v) => JSON.parse(JSON.stringify(v));

const GameApi = {
    mode: ENGINE_MODE,
    game: null,
    userId: "",

    // ゲーム画面の起動時に1回呼ぶ。端末モードの準備に失敗したらサーバーモードに戻す
    async init(userId) {
        this.userId = userId;
        if (this.mode !== "local") return;
        try {
            await loadPokerModules(POKER_GAME_MODULES);
            await Promise.all([Ranges.load(), Messages.load()]);
            await importServerStats(userId);
            this.game = new PokerGame({
                hooks: {
                    startSession: (sid, pos, hand) => StatsStore.startSession(sid, pos, hand),
                    logAction: (f) => StatsStore.logAction(f),
                    finishHand: (f) => StatsStore.finishHand(f),
                },
            });
            console.log("[GameApi] 端末エンジンで動作中");
        } catch (e) {
            console.error("[GameApi] 端末エンジンの準備に失敗 → サーバー計算に戻します:", e);
            this.mode = "server";
            this.game = null;
        }
    },

    async startHand(spot, position) {
        if (this.game) return detach(this.game.startHand({ spot, position }));
        const spotParam = spot ? `&spot=true&position=${encodeURIComponent(position)}` : "";
        const res = await fetch(withLang(`/api/start_hand?user_id=${encodeURIComponent(this.userId)}${spotParam}`));
        return res.json();
    },

    async action(action, amount) {
        if (this.game) return detach(this.game.action({ action, amount }));
        const res = await fetch(withLang("/api/action"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action, amount, user_id: this.userId }),
        });
        return res.json();
    },

    // リロード時の状態復元。端末モードではページを離れるとハンドは消える（新しいハンドから始まる）
    async state() {
        if (this.game) return detach(this.game.currentState());
        const res = await fetch(withLang(`/api/state?user_id=${encodeURIComponent(this.userId)}`));
        return res.json();
    },

    // AIコーチに送るハンド状態（app.py の CoachHandState）。サーバーモードでは null（サーバーが自分のエンジンを見る）
    coachState() {
        if (!this.game) return null;
        const eng = this.game.engine;
        return {
            street: eng.street,
            hero_pos: eng.heroPosition,
            cpu_pos: eng.cpuPosition,
            hero_stack: eng.heroStack,
            cpu_stack: eng.cpuStack,
            pot: eng.potSize,
            board: eng.board.map(Card.toStr),
            hero: eng.heroHand.map(Card.toStr),
            cpu: eng.cpuHand.map(Card.toStr),
            history: eng.actionHistory.map(a => ({
                street: a.street, actor: a.actor, action: a.action, amount: a.amount || 0,
            })),
        };
    },

    // AIコーチの最初の回答を相談履歴に残す（サーバーモードではサーバーが保存済み）
    saveCoachFeedback(handContext, reply) {
        if (!this.game || !handContext) return;
        StatsStore.saveAiFeedback(this.game.sessionId, handContext, reply);
    },
};

// 分析ページ用。端末モードでは IndexedDB の行を stats_calc.js で集計する
const StatsApi = {
    mode: ENGINE_MODE,
    ready: null,

    init(userId) {
        if (this.mode !== "local") return Promise.resolve();
        this.ready = this.ready || (async () => {
            try {
                await loadPokerModules(POKER_STATS_MODULES);
                await Messages.load();
                await importServerStats(userId);
            } catch (e) {
                console.error("[StatsApi] 端末の統計を読めません → サーバーの統計を表示します:", e);
                this.mode = "server";
            }
        })();
        return this.ready;
    },

    // 分析ページのデータ。サーバーモードでは従来どおり2段階（総合スコアを先に出し、残りが失敗しても消さない）
    async loadPrimary(userId, period) {
        await this.init(userId);
        if (this.mode === "local") {
            const d = await StatsStore.loadAll();
            return detach({ overview: StatsCalc.getOverview(d, period), streets: StatsCalc.getStreetEvalDist(d) });
        }
        const uid = encodeURIComponent(userId);
        const [overview, streets] = await Promise.all([
            getJson(`/api/stats/overview?period=${period}&user_id=${uid}`),
            getJson(`/api/stats/streets?user_id=${uid}`),
        ]);
        return { overview, streets };
    },

    async loadSecondary(userId, period) {
        await this.init(userId);
        if (this.mode === "local") {
            const d = await StatsStore.loadAll();
            return detach({
                position: StatsCalc.getPositionStats(d),
                leaks: StatsCalc.getLeaks(d),
                aiHistory: StatsCalc.getSavedHands(d),
                handHistory: StatsCalc.getHandHistory(d, 30),
                personalRange: StatsCalc.getPersonalRangeStats(d, period),
            });
        }
        const uid = encodeURIComponent(userId);
        const [position, leaks, aiHistory, handHistory, personalRange] = await Promise.all([
            getJson(`/api/stats/position?user_id=${uid}`),
            getJson(`/api/stats/leaks?user_id=${uid}`),
            getJson(`/api/stats/saved_hands?user_id=${uid}`),
            getJson(`/api/stats/hand_history?user_id=${uid}`),
            getJson(`/api/stats/personal_range?period=${period}&user_id=${uid}`),
        ]);
        return { position, leaks, aiHistory, handHistory, personalRange };
    },
};

const getJson = (path) => fetch(withLang(path)).then(r => r.json());
