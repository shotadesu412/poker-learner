// game_api.js — ゲーム進行・統計の呼び出し口。計算と保存はすべて端末で行う（static/poker/ + IndexedDB）
//
// 依存: なし（static/poker/ のモジュールをページごとに読み込む）

const POKER_JS_VERSION = 3;   // static/poker/ 以下を変えたら上げる（キャッシュバスティング）

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

// 画面側の変更がエンジン内部へ届かないように複製する
const detach = (v) => JSON.parse(JSON.stringify(v));

const GameApi = {
    game: null,

    // ゲーム画面の起動時に1回呼ぶ。失敗したら game は null のまま（画面側が再読み込みを案内する）
    async init() {
        try {
            await loadPokerModules(POKER_GAME_MODULES);
            await Promise.all([Ranges.load(), Messages.load()]);
            this.game = new PokerGame({
                hooks: {
                    startSession: (sid, pos, hand) => StatsStore.startSession(sid, pos, hand),
                    logAction: (f) => StatsStore.logAction(f),
                    finishHand: (f) => StatsStore.finishHand(f),
                },
            });
        } catch (e) {
            console.error("[GameApi] 端末エンジンの準備に失敗:", e);
        }
    },

    async startHand(spot, position) {
        return detach(this.game.startHand({ spot, position }));
    },

    async action(action, amount) {
        return detach(this.game.action({ action, amount }));
    },

    // ページを離れるとハンドは消える（新しいハンドから始まる）
    async state() {
        return detach(this.game.currentState());
    },

    // AIコーチに送るハンド状態（app.py の CoachHandState）
    coachState() {
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

    // AIコーチの最初の回答を相談履歴に残す
    saveCoachFeedback(handContext, reply) {
        if (!handContext) return;
        StatsStore.saveAiFeedback(this.game.sessionId, handContext, reply);
    },

    // レンジ表示用（/api/preflop_ranges の置き換え）。{ ポジション: { コンボ: 重み } }
    preflopRanges() {
        const toObject = (v) => (v instanceof Map
            ? Object.fromEntries([...v].map(([k, x]) => [k, toObject(x)]))
            : v);
        return toObject(Ranges.positionRanges);
    },
};

// 分析ページ用。IndexedDB の行を stats_calc.js で集計する
const StatsApi = {
    ready: null,

    init() {
        this.ready = this.ready || (async () => {
            await loadPokerModules(POKER_STATS_MODULES);
            await Messages.load();
        })();
        return this.ready;
    },

    async loadPrimary(period) {
        await this.init();
        const d = await StatsStore.loadAll();
        return detach({ overview: StatsCalc.getOverview(d, period), streets: StatsCalc.getStreetEvalDist(d) });
    },

    async loadSecondary(period) {
        await this.init();
        const d = await StatsStore.loadAll();
        return detach({
            position: StatsCalc.getPositionStats(d),
            leaks: StatsCalc.getLeaks(d),
            aiHistory: StatsCalc.getSavedHands(d),
            handHistory: StatsCalc.getHandHistory(d, 30),
            personalRange: StatsCalc.getPersonalRangeStats(d, period),
        });
    },
};
