// game_api.js — ゲーム進行・統計の呼び出し口。計算と保存はすべて端末で行う（static/poker/ + IndexedDB）
//
// 依存: なし（static/poker/ のモジュールをページごとに読み込む）

const POKER_JS_VERSION = 4;   // static/poker/ 以下を変えたら上げる（キャッシュバスティング）

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

    // このハンドでのあなたのアクションの判定（◎◯△×）。AIコーチに渡す
    heroEvaluations: [],

    async startHand(spot, position) {
        this.heroEvaluations = [];
        return detach(this.game.startHand({ spot, position }));
    },

    async action(action, amount) {
        const result = detach(this.game.action({ action, amount }));
        this.heroEvaluations.push(result.evaluation || "");
        return result;
    },

    // このアクションであなたが追加で出せる上限（自分のスタックと、相手がコールできる額の小さい方）
    heroMaxBet() {
        return this.game.engine.maxAdditionalBet("HERO");
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
            // あなたのアクションにはアプリの判定と、その時点の勝率（実現率込み）を添える。
            // コーチがアプリの判定と食い違う講評や、ハンドの強さを取り違えた講評をしないため
            history: (() => {
                let heroIndex = 0;
                return eng.actionHistory.map(a => {
                    const row = { street: a.street, actor: a.actor, action: a.action, amount: a.amount || 0 };
                    if (a.actor === "HERO") {
                        row.evaluation = this.heroEvaluations[heroIndex++] || "";
                        if (typeof a.equity === "number") row.equity = Math.round(a.equity * 1000) / 10;
                    }
                    return row;
                });
            })(),
        };
    },

    // AIコーチの最初の回答を相談履歴に残す
    saveCoachFeedback(handContext, reply, handState) {
        if (!handContext) return;
        StatsStore.saveAiFeedback(this.game.sessionId, handContext, reply, handState || null);
    },

    // レンジ表示用（/api/preflop_ranges の置き換え）。{ ポジション: { コンボ: 重み } }
    preflopRanges() {
        const toObject = (v) => (v instanceof Map
            ? Object.fromEntries([...v].map(([k, x]) => [k, toObject(x)]))
            : v);
        const ranges = toObject(Ranges.positionRanges);
        // 6-max では UTG と LJ は同じ席。画面は UTG 表記、データは LJ キーなので両方で引けるようにする
        if (ranges.LJ && !ranges.UTG) ranges.UTG = ranges.LJ;
        return ranges;
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
