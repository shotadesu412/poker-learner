// game_api.js — ゲーム進行・統計の呼び出し口。計算と保存はすべて端末で行う（static/poker/ + IndexedDB）
//
// 依存: なし（static/poker/ のモジュールをページごとに読み込む）

const POKER_JS_VERSION = 12;   // static/poker/ 以下を変えたら上げる（キャッシュバスティング）

// 読み込み順は依存順（MIGRATION_NOTES.md フェーズ5 参照）
const POKER_GAME_MODULES = [
    "rng", "hand_table", "hand_eval", "pyfmt", "messages", "ranges", "range_utils", "equity",
    "ev_calculator", "hand_classifier", "bet_sizing", "range_model", "postflop_ev", "evaluator", "engine", "game",
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
            // JSON もキャッシュに古いものが残らないよう、JS と同じ版番号を付ける
            const v = `?v=${POKER_JS_VERSION}`;
            await Promise.all([Ranges.load(`/static/poker/ranges.json${v}`), Messages.load(`/static/poker/messages.json${v}`)]);
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

    // プリフロップのレイズは場面ごとに1サイズ（2026/11/19 shota 指定。判定のレンジ表はこの標準サイズが前提）
    //   オープン: UTG〜BTN 2.5bb / SB 3bb（合計）  BB で SB のリンプに: 4bb
    //   3ベット: オープン額の 3倍（IP）/ 4倍（OOP）  4ベット: 3ベット額の 2.2倍（IP）/ 2.5倍（OOP）  それ以上: オールイン
    // 戻り値 { kind: "open"|"iso"|"3bet"|"4bet"|"allin", total: レイズ後の合計, add: 追加で出す額, mult }
    preflopRaise() {
        const e = this.game.engine;
        const raises = e.preflopRaiseCount;
        const ip = e.isHeroIp;
        let kind, total, mult = null;
        if (raises === 0) {
            if (e.heroPosition === "BB") { kind = "iso"; total = 4.0; }
            else { kind = "open"; total = e.heroPosition === "SB" ? 3.0 : 2.5; }
        } else if (raises === 1) { kind = "3bet"; mult = ip ? 3 : 4; total = e.currentBet * mult; }
        else if (raises === 2) { kind = "4bet"; mult = ip ? 2.2 : 2.5; total = e.currentBet * mult; }
        else { kind = "allin"; total = Infinity; }
        const max = e.maxAdditionalBet("HERO");
        let add = Math.min(max, Math.max(0, total - e.heroInvested));
        add = Math.round(add * 10) / 10;
        if (add >= max - 0.05) return { kind: "allin", total: e.heroInvested + max, add: max, mult };
        return { kind, total: Math.round(total * 10) / 10, add, mult };
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
            // CPU は配られた時点で手札を持つので、見せていない手札（ハンド中・CPU のフォールド）はコーチに渡さない
            cpu: (eng.handFinished && !eng.actionHistory.some(a => a.actor === "CPU" && a.action === "FOLD"))
                ? eng.cpuHand.map(Card.toStr) : [],
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
            await Messages.load(`/static/poker/messages.json?v=${POKER_JS_VERSION}`);
        })();
        return this.ready;
    },

    async loadPrimary(period) {
        await this.init();
        const d = await StatsStore.loadAll();
        return detach({ overview: StatsCalc.getOverview(d, period), streets: StatsCalc.getStreetEvalDist(d), style: StatsCalc.getPlayStyle(d, period) });
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
