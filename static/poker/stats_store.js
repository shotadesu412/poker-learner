// 統計の保存先（端末の IndexedDB）。stats_logger.py の保存部分の JS 版。
//
// 行の形は SQLite と同じ（stats_logger.export_user_data() の形）にしてあり、集計は stats_calc.js に
// loadAll() の結果を渡すだけ。端末には本人のデータしか無いので user_id は空文字のまま保存する。
//
// game.js のフック（startSession / logAction / finishHand）は同期で呼ばれるので、書き込みは
// キューに積んで順番どおりに実行する。読み出し（loadAll）はキューが空になるのを待ってから行う。
//
// 依存: stats_calc.js（時刻の書式）

(function (root) {
  const DB_NAME = 'poker_learner';
  const DB_VERSION = 1;
  const STORES = ['actions', 'sessions', 'saved_hands', 'meta'];

  let dbPromise = null;
  let queue = Promise.resolve();

  function open() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = root.indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          // actions / saved_hands の id は SQLite の AUTOINCREMENT と同じく保存順（集計はこの順番に依存する）
          db.createObjectStore('actions', { keyPath: 'id', autoIncrement: true });
          db.createObjectStore('sessions', { keyPath: 'session_id' });
          db.createObjectStore('saved_hands', { keyPath: 'id', autoIncrement: true });
          db.createObjectStore('meta', { keyPath: 'key' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      // 容量逼迫時に消されにくくする（対応していない環境では何もしない）
      try { root.navigator.storage.persist().catch(() => {}); } catch (e) { /* 非対応 */ }
    }
    return dbPromise;
  }

  // トランザクションを1つ実行し、完了（コミット）したら fn の戻り値で resolve する
  async function run(storeNames, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(storeNames, mode);
      let result;
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
      const stores = Object.fromEntries(storeNames.map((n) => [n, tx.objectStore(n)]));
      result = fn(stores, tx);
    });
  }

  const req2promise = (req) => new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

  // 書き込みは順番を保つためにキューへ。失敗しても次の書き込みは止めない
  function enqueue(fn) {
    queue = queue.then(fn).catch((e) => console.error('[StatsStore]', e));
    return queue;
  }

  const now = () => root.StatsCalc.nowIso();
  const withoutId = ({ id, ...rest }) => rest;

  const StatsStore = {
    open,

    // stats_logger.start_session（INSERT OR IGNORE）
    startSession(sessionId, heroPos, heroHand = '') {
      const row = {
        session_id: sessionId, started_at: now(), hero_pos: heroPos, hero_hand: heroHand, result: '',
        user_id: '', board: '', cpu_hand: '', final_pot: 0.0, winner: '', action_log: '',
      };
      return enqueue(() => run(['sessions'], 'readwrite', ({ sessions }) => {
        sessions.get(sessionId).onsuccess = (e) => { if (!e.target.result) sessions.add(row); };
      }));
    },

    // stats_logger.log_action
    logAction(fields) {
      const row = {
        session_id: fields.session_id, timestamp: now(), street: fields.street, actor: fields.actor,
        action: fields.action, amount: fields.amount ?? 0.0, equity: fields.equity ?? 0.0,
        pot_size: fields.pot_size ?? 0.0, hero_pos: fields.hero_pos ?? '', evaluation: fields.evaluation ?? '',
        ev_loss: fields.ev_loss ?? 0.0, user_id: '',
      };
      return enqueue(() => run(['actions'], 'readwrite', ({ actions }) => { actions.add(row); }));
    },

    // stats_logger.finish_hand
    finishHand({ session_id, winner, final_pot, board, cpu_hand, action_log }) {
      return enqueue(() => run(['sessions'], 'readwrite', ({ sessions }) => {
        sessions.get(session_id).onsuccess = (e) => {
          const s = e.target.result;
          if (!s) return;   // UPDATE ... WHERE session_id = ? と同じく、無ければ何もしない
          Object.assign(s, {
            winner, final_pot, board, cpu_hand, action_log: JSON.stringify(action_log), result: winner,
          });
          sessions.put(s);
        };
      }));
    },

    // stats_logger.save_ai_feedback
    saveAiFeedback(sessionId, handContext, aiFeedback) {
      const row = { user_id: '', session_id: sessionId, timestamp: now(), hand_context: handContext, ai_feedback: aiFeedback };
      return enqueue(() => run(['saved_hands'], 'readwrite', ({ saved_hands }) => { saved_hands.add(row); }));
    },

    // stats_calc.js に渡す形 { actions, sessions, saved_hands }（actions / saved_hands は id 順）
    async loadAll() {
      await queue;
      const out = {};
      await run(['actions', 'sessions', 'saved_hands'], 'readonly', (s) => {
        for (const name of ['actions', 'sessions', 'saved_hands']) {
          req2promise(s[name].getAll()).then((rows) => { out[name] = rows; });
        }
      });
      return out;
    },

    // 端末エンジンへ切り替えた初回だけ、サーバーの統計（/api/stats/export）を取り込む。
    // 取り込み済みの印と行を同じトランザクションで書くので、途中で失敗したら丸ごと無かったことになり次回やり直す
    async importFromServer(fetchExport) {
      await queue;
      const done = await run(['meta'], 'readonly', ({ meta }) => req2promise(meta.get('imported')));
      if (done) return { skipped: true };
      const data = await fetchExport();   // 失敗したら例外 → 呼び出し側でログだけ出して次回再試行
      const counts = {};
      await run(STORES, 'readwrite', (s) => {
        for (const name of ['actions', 'sessions', 'saved_hands']) {
          const rows = data[name] || [];
          counts[name] = rows.length;
          // id は振り直す（id 順に追加するので順番は保たれる）。sessions は session_id がキー
          for (const r of rows) s[name].put(name === 'sessions' ? r : withoutId(r));
        }
        s.meta.put({ key: 'imported', at: now(), counts });
      });
      return counts;
    },
  };

  root.StatsStore = StatsStore;
  if (typeof module !== 'undefined') module.exports = StatsStore;
})(typeof window !== 'undefined' ? window : globalThis);
