// 分析ページの集計（stats_logger.py の get_* の JS 移植）。
//
// 保存先（IndexedDB）には依存しない純関数にしてある。入力は stats_logger.export_user_data() と
// 同じ形の行の配列で、1ユーザー分だけが入っている前提（端末の DB には本人のデータしか無い）:
//   data = { actions: [...], sessions: [...], saved_hands: [...] }
//   actions は id の昇順（= 保存順）に並んでいること
//
// SQL の細かい挙動も再現している:
//   - 時刻は Python の isoformat() と同じ書式の文字列で持ち、期間の比較は文字列比較（SQLite と同じ）
//   - AVG は SQLite 3.43+ と同じ補償付き加算（Kahan-Babuska-Neumaier）。ビット単位で一致させるため
//   - 丸めは Python の round（偶数丸め, pyfmt.js）
//
// 依存: pyfmt.js, messages.js（リークの説明文）

(function (root) {
  if (typeof module !== 'undefined') {
    require('./pyfmt.js');
    require('./messages.js');
  }
  const Py = root.Py;
  const Messages = root.Messages;

  const HERO = 'HERO';
  const pad = (n, w) => String(n).padStart(w, '0');

  // ---------- 時刻（Python の datetime.isoformat() と同じ書式） ----------

  // epochMs + マイクロ秒（0〜999）→ "2026-09-27T04:30:00.123456+00:00"。
  // 小数部が 0 のときは Python と同じく省略する
  function formatIso(epochMs, extraMicro = 0) {
    const d = new Date(epochMs);
    const micro = d.getUTCMilliseconds() * 1000 + extraMicro;
    const base = `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1, 2)}-${pad(d.getUTCDate(), 2)}` +
      `T${pad(d.getUTCHours(), 2)}:${pad(d.getUTCMinutes(), 2)}:${pad(d.getUTCSeconds(), 2)}`;
    return base + (micro ? '.' + pad(micro, 6) : '') + '+00:00';
  }

  // "…T04:30:00.123456+00:00" → { ms, micro }（UTC のみ対応。保存しているのは UTC だけ）
  function parseIso(s) {
    const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(?:\.(\d{1,6}))?\+00:00$/.exec(s);
    if (!m) throw new Error('parseIso: 対応していない書式: ' + s);
    const us = Number((m[7] || '').padEnd(6, '0'));
    const ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], Math.floor(us / 1000));
    return { ms, micro: us % 1000 };
  }

  function nowIso() { return formatIso(Date.now()); }

  function minusDays(iso, days) {
    const { ms, micro } = parseIso(iso);
    return formatIso(ms - days * 86400000, micro);
  }

  // ---------- SQL の再現 ----------

  // SQLite の AVG（REAL 列）。0件なら null
  function sqlAvg(values) {
    if (values.length === 0) return null;
    let sum = 0, err = 0;
    for (const r of values) {
      const t = sum + r;
      if (Math.abs(sum) > Math.abs(r)) err += (sum - t) + r;
      else err += (r - t) + sum;
      sum = t;
    }
    return (sum + err) / values.length;
  }

  const countDistinctSessions = (rows) => new Set(rows.map((a) => a.session_id)).size;

  // _period_filter と同じ。actions の行に対する述語を返す
  function periodPredicate(actions, period, now) {
    if (period === '7d' || period === '30d') {
      const cutoff = minusDays(now, period === '7d' ? 7 : 30);
      return (a) => a.timestamp >= cutoff;
    }
    if (period === 'last') {
      // SELECT session_id FROM actions WHERE actor='HERO' ORDER BY timestamp DESC LIMIT 1
      let best = null;
      for (const a of actions) {
        if (a.actor === HERO && (best === null || a.timestamp > best.timestamp)) best = a;
      }
      const sid = best ? best.session_id : null;
      return (a) => sid !== null && a.session_id === sid;
    }
    return () => true;
  }

  const heroActions = (data) => data.actions.filter((a) => a.actor === HERO);

  // ---------- 集計（stats_logger.py と同じ名前・同じ戻り値） ----------

  function getOverview(data, period = 'all', now = nowIso()) {
    const inPeriod = periodPredicate(data.actions, period, now);
    const rows = heroActions(data).filter(inPeriod);
    const total = rows.length;
    if (total === 0) {
      return { total_actions: 0, gto_match_rate: 0.0, vpip: 0.0, pfr: 0.0, three_bet_rate: 0.0, avg_ev_loss: 0.0 };
    }
    const gtoMatch = rows.filter((a) => a.evaluation === '◎' || a.evaluation === '◯').length;
    const pf = rows.filter((a) => a.street === 'PREFLOP');
    const pfHands = countDistinctSessions(pf);
    const vpipHands = countDistinctSessions(pf.filter((a) => ['CALL', 'BET', 'RAISE'].includes(a.action)));
    const pfrHands = countDistinctSessions(pf.filter((a) => a.action === 'RAISE' || a.action === 'BET'));
    const threeBet = pf.filter((a) => a.action === 'RAISE' && a.amount > 3.5).length;
    const avgEvLoss = sqlAvg(rows.filter((a) => a.ev_loss > 0).map((a) => a.ev_loss)) || 0.0;
    const hands = Math.max(pfHands, 1);
    return {
      total_actions: total,
      gto_match_rate: Py.round(gtoMatch / total * 100, 1),
      vpip: Py.round(vpipHands / hands * 100, 1),
      pfr: Py.round(pfrHands / hands * 100, 1),
      three_bet_rate: Py.round(threeBet / hands * 100, 1),
      avg_ev_loss: Py.round(avgEvLoss, 3),
    };
  }

  // プレイの傾向を4タイプに分ける（2026/11/19〜。分析ページの「参加率・レイズ率」の置き換え）。
  // 軸は理論（推奨）との差: 6人卓の理論より広く参加しているか（ルース/タイト）、多く攻めているか（アグレッシブ/パッシブ）。
  //   参加の差 = 降りる選択肢があった場面で「参加した割合 − 推奨の参加確率」
  //   攻めの差 = レイズできた場面で「攻めた割合 − 推奨の攻める確率」
  // 推奨はプリフロップがレンジ表の頻度、ポストフロップが最善手。判定が ◎ の手は推奨どおりとして数える（game.js の _tendency）
  const STYLE_MIN = 30;   // 各軸でこれだけの判断が溜まったらタイプを出す
  function getPlayStyle(data, period = 'all', now = nowIso()) {
    const inPeriod = periodPredicate(data.actions, period, now);
    const rows = heroActions(data).filter(inPeriod).filter((a) => a.tendency);
    let nf = 0, dp = 0, nc = 0, da = 0;
    for (const a of rows) {
      const t = a.tendency;
      if (t.f) { nf++; dp += t.p - t.rp; }
      if (t.c) { nc++; da += t.a - t.ra; }
    }
    const loose = nf ? dp / nf * 100 : 0;
    const aggr = nc ? da / nc * 100 : 0;
    const ready = nf >= STYLE_MIN && nc >= STYLE_MIN;
    const type = !ready ? null : (loose > 0 ? 'loose' : 'tight') + '_' + (aggr > 0 ? 'aggressive' : 'passive');
    return {
      ready, type, need: Math.max(0, STYLE_MIN - Math.min(nf, nc)),
      loose_diff: Py.round(loose, 1), aggr_diff: Py.round(aggr, 1), n_fold_spots: nf, n_raise_spots: nc,
    };
  }

  function getPositionStats(data) {
    const hero = heroActions(data);
    // ゲームは UTG と記録する（6-max では LJ と同じ席）。以前は 'LJ' で集計していたため UTG のハンドが常に0件だった
    return ['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB'].map((pos) => {
      const mine = hero.filter((a) => a.hero_pos === pos || (pos === 'UTG' && a.hero_pos === 'LJ'));
      const pf = mine.filter((a) => a.street === 'PREFLOP');
      const hands = countDistinctSessions(pf);
      if (hands === 0) return { pos, hands: 0, vpip: 0.0, pfr: 0.0, gto_rate: 0.0 };
      const vpip = countDistinctSessions(pf.filter((a) => ['CALL', 'BET', 'RAISE'].includes(a.action)));
      const pfr = countDistinctSessions(pf.filter((a) => a.action === 'RAISE' || a.action === 'BET'));
      const totalEval = mine.filter((a) => a.evaluation !== '').length;
      const goodEval = mine.filter((a) => a.evaluation === '◎' || a.evaluation === '◯').length;
      return {
        pos,
        hands,
        vpip: Py.round(vpip / hands * 100, 1),
        pfr: Py.round(pfr / hands * 100, 1),
        gto_rate: Py.round(goodEval / Math.max(totalEval, 1) * 100, 1),
      };
    });
  }

  function getStreetEvalDist(data) {
    const hero = heroActions(data);
    const result = {};
    for (const st of ['PREFLOP', 'FLOP', 'TURN', 'RIVER']) {
      const row = {};
      for (const ev of ['◎', '◯', '△', '×']) {
        row[ev] = hero.filter((a) => a.street === st && a.evaluation === ev).length;
      }
      result[st] = row;
    }
    return result;
  }

  function leakDescription(street, action, pos, evaluation) {
    const severityKey = { '△': 'leak.severity.marginal', '×': 'leak.severity.bad' }[evaluation];
    const severity = severityKey ? Messages.t(severityKey) : '';
    const actionLabel = ['FOLD', 'CALL', 'RAISE', 'BET', 'CHECK'].includes(action)
      ? Messages.t(`leak.action.${action}`) : action;
    return Messages.t('leak.message', { severity, pos, street, action: actionLabel });
  }

  function getLeaks(data) {
    // GROUP BY street, action, hero_pos。SELECT している evaluation は集計していない列なので
    // SQLite（3.51 で確認）はグループ内の最初の行の値を返す（テーブルの走査順 = id 順）。
    // △ と × が混ざったグループでは「やや問題」「大きな問題」のどちらになるかがこれで決まる
    const groups = new Map();
    for (const a of heroActions(data)) {
      if (!(a.ev_loss > 0.01 && (a.evaluation === '△' || a.evaluation === '×'))) continue;
      const key = JSON.stringify([a.street, a.action, a.hero_pos]);
      if (!groups.has(key)) {
        groups.set(key, { street: a.street, action: a.action, pos: a.hero_pos, evaluation: a.evaluation, losses: [] });
      }
      groups.get(key).losses.push(a.ev_loss);
    }
    const rows = [...groups.values()].map((g) => ({ ...g, avg: sqlAvg(g.losses) }));
    rows.sort((x, y) => y.avg - x.avg);
    return rows.slice(0, 5).map((g) => ({
      street: g.street,
      action: g.action,
      pos: g.pos,
      evaluation: g.evaluation,
      avg_ev_loss: Py.round(g.avg, 3),
      count: g.losses.length,
      description: leakDescription(g.street, g.action, g.pos, g.evaluation),
    }));
  }

  // 新しい画面のホームに出す成績（2026/11/23〜）: 直近7日の ◎◯ の割合と、その前の7日。いちばん損している場面（3回以上）
  function getHomeSummary(data, now = nowIso()) {
    const d7 = minusDays(now, 7), d14 = minusDays(now, 14);
    const rows = heroActions(data);
    const rate = (xs) => (xs.length ? Py.round(xs.filter((a) => a.evaluation === '◎' || a.evaluation === '◯').length / xs.length * 100, 1) : 0);
    const cur = rows.filter((a) => a.timestamp >= d7 && a.evaluation);
    const prev = rows.filter((a) => a.timestamp >= d14 && a.timestamp < d7 && a.evaluation);
    const leak = getLeaks(data).find((l) => l.count >= 3) || null;
    return {
      n7: cur.length, rate7: rate(cur), nPrev: prev.length, ratePrev: rate(prev),
      leak: leak && { street: leak.street, action: leak.action, pos: leak.pos, avg_ev_loss: leak.avg_ev_loss, count: leak.count },
    };
  }

  // ホームの「今週のカード」（2026/11/24 shota 案）: 1日に DAILY_CARD_HANDS ハンド打つとカードが1枚もらえ、
  // 月曜〜日曜の7枚で役を作る。カードは「端末の ID + 週の初日」で決まる並びから曜日の順に配るので、
  // 開き直しても変わらず、同じ週で重複しない。打たなかった日の分は無し（その日のカードは配られない）
  const DAILY_CARD_HANDS = 10;
  // 同じ日にさらに10ハンド（合計20）打つと、1日1回だけ追加の1枚を引き、今週のどれか1枚と入れ替えられる（2026/11/24 shota 案）。
  // 追加の1枚は同じ並びの8枚目以降（曜日ごとに1枚）なので、引き直しても変わらず、今週のカードとも重ならない
  const DRAW_HANDS = 20;
  const CARD_RANKS = '23456789TJQKA', CARD_SUITS = 'shdc';

  function seededDeck(seedText) {
    let h = 2166136261;   // FNV-1a → mulberry32
    for (let i = 0; i < seedText.length; i++) { h ^= seedText.charCodeAt(i); h = Math.imul(h, 16777619); }
    let st = h >>> 0;
    const rnd = () => {
      st = (st + 0x6D2B79F5) >>> 0;
      let t = st;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const deck = [];
    for (const r of CARD_RANKS) for (const su of CARD_SUITS) deck.push(r + su);
    for (let i = deck.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [deck[i], deck[j]] = [deck[j], deck[i]]; }
    return deck;
  }

  // 0〜7枚から作れるいちばん強い役の名前（キー）。5枚未満ならペア系だけ
  function bestHandCategory(cards) {
    if (!cards.length) return null;
    const rv = (c) => CARD_RANKS.indexOf(c[0]);
    const cnt = new Map(), bySuit = new Map();
    for (const c of cards) {
      cnt.set(rv(c), (cnt.get(rv(c)) || 0) + 1);
      if (!bySuit.has(c[1])) bySuit.set(c[1], []);
      bySuit.get(c[1]).push(rv(c));
    }
    const straightHigh = (vals) => {
      const set = new Set(vals);
      if (set.has(12)) set.add(-1);   // A は 1 としても使う
      for (let hi = 12; hi >= 3; hi--) {
        let ok = true;
        for (let k = 0; k < 5; k++) if (!set.has(hi - k)) { ok = false; break; }
        if (ok) return hi;
      }
      return -2;
    };
    for (const vals of bySuit.values()) {
      if (vals.length >= 5) {
        const hi = straightHigh(vals);
        if (hi === 12) return 'royal';
        if (hi >= 3) return 'straight_flush';
      }
    }
    const counts = [...cnt.values()].sort((x, y) => y - x);
    if (counts[0] >= 4) return 'quads';
    if (counts[0] >= 3 && counts[1] >= 2) return 'full_house';
    if ([...bySuit.values()].some((v) => v.length >= 5)) return 'flush';
    if (straightHigh([...cnt.keys()]) >= 3) return 'straight';
    if (counts[0] >= 3) return 'trips';
    if (counts[0] >= 2 && counts[1] >= 2) return 'two_pair';
    if (counts[0] >= 2) return 'pair';
    return 'high_card';
  }

  const dayKeyOf = (ms) => { const d = new Date(ms); return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate(); };

  function handsPerDay(data) {
    const perDay = new Map();
    for (const s of data.sessions || []) {
      const ms = Date.parse(s.started_at);
      if (!Number.isFinite(ms)) continue;
      const k = dayKeyOf(ms);
      perDay.set(k, (perDay.get(k) || 0) + 1);
    }
    return perDay;
  }

  // 週の初日（月曜の正午）。日付は正午を基準に動かす（夏時間の切り替わりでずれないように）
  function mondayNoon(ms) {
    const noon = new Date(ms); noon.setHours(12, 0, 0, 0);
    const monday = new Date(noon); monday.setDate(monday.getDate() - ((noon.getDay() + 6) % 7));
    return monday;
  }

  // 1週間分のカード。upToIdx より後の曜日はまだ来ていない（今週だけ。過ぎた週は 6）。
  // swaps は { 引いた曜日: 入れ替えた曜日（-1 = 入れ替えない） }（端末に保存した選択）
  function weekCards(perDay, userId, monday, upToIdx, swaps = {}) {
    const deck = seededDeck(String(userId || '') + ':' + dayKeyOf(monday.getTime()));
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(monday); d.setDate(d.getDate() + i);
      const key = dayKeyOf(d.getTime());
      const hands = perDay.get(key) || 0;
      const got = hands >= DAILY_CARD_HANDS && i <= upToIdx;
      const status = got ? 'got' : i < upToIdx ? 'missed' : i === upToIdx ? 'today' : 'future';
      days.push({ status, hands, key, card: got ? deck[i] : null, draw: got && hands >= DRAW_HANDS ? deck[7 + i] : null, swapped: false });
    }
    for (let i = 0; i <= Math.min(upToIdx, 6); i++) {
      const to = swaps[i];
      if (!days[i].draw || typeof to !== 'number' || to < 0 || to > 6 || !days[to].card) continue;
      days[to].card = days[i].draw;
      days[to].swapped = true;
    }
    return days;
  }

  // 今週。best は今日の分も含めた役、bestBeforeToday は今日の1枚を除いた役（めくる前に見せる用）。
  // drawReady: 今日の追加の1枚を引ける（20ハンド打って、まだ選んでいない）
  function getWeekCards(data, userId, nowMs = Date.now(), swaps = {}) {
    const monday = mondayNoon(nowMs);
    const todayIdx = Math.round((new Date(nowMs).setHours(12, 0, 0, 0) - monday.getTime()) / 86400000);
    const days = weekCards(handsPerDay(data), userId, monday, todayIdx, swaps);
    const cards = days.filter((x) => x.card).map((x) => x.card);
    const before = days.filter((x, i) => x.card && i !== todayIdx).map((x) => x.card);
    const today = days[todayIdx];
    return {
      days, todayIdx, weekKey: days[0].key, need: DAILY_CARD_HANDS, drawNeed: DRAW_HANDS, count: cards.length,
      best: bestHandCategory(cards), bestBeforeToday: bestHandCategory(before),
      drawReady: !!today.draw && swaps[todayIdx] === undefined, drawDone: swaps[todayIdx] !== undefined,
    };
  }

  // 役のコレクション（2026/11/24）: 終わった週ごとの7枚と役（新しい順）、役ごとの回数。1枚ももらえなかった週は入れない
  const HAND_CATEGORIES = ['royal', 'straight_flush', 'quads', 'full_house', 'flush', 'straight', 'trips', 'two_pair', 'pair', 'high_card'];
  // allSwaps は { 週の初日のキー: swaps }
  function getCardCollection(data, userId, nowMs = Date.now(), allSwaps = {}) {
    const perDay = handsPerDay(data);
    const counts = Object.fromEntries(HAND_CATEGORIES.map((c) => [c, 0]));
    const weeks = [];
    let first = Infinity;
    for (const s of data.sessions || []) { const ms = Date.parse(s.started_at); if (ms < first) first = ms; }
    if (!Number.isFinite(first)) return { weeks, counts, categories: HAND_CATEGORIES };
    const thisMonday = mondayNoon(nowMs);
    for (const m = mondayNoon(first); m < thisMonday; m.setDate(m.getDate() + 7)) {
      const mk = dayKeyOf(m.getTime());
      const days = weekCards(perDay, userId, new Date(m), 6, allSwaps[mk] || {});
      const cards = days.filter((x) => x.card).map((x) => x.card);
      if (!cards.length) continue;
      const best = bestHandCategory(cards);
      counts[best]++;
      weeks.push({ start: days[0].key, cards: days.map((x) => x.card), best });
    }
    weeks.reverse();
    return { weeks, counts, categories: HAND_CATEGORIES };
  }

  function getSavedHands(data) {
    return [...data.saved_hands]
      .sort((x, y) => (x.timestamp < y.timestamp ? 1 : x.timestamp > y.timestamp ? -1 : 0))
      .slice(0, 50)
      .map((r) => ({
        session_id: r.session_id,
        timestamp: r.timestamp,
        hand_context: r.hand_context,
        ai_feedback: r.ai_feedback,
        // 2026/11/16〜 保存しているハンド状態（それより前の行には無い）
        ...(r.hand_state ? { hand_state: r.hand_state } : {}),
      }));
  }

  function getHandHistory(data, limit = 30) {
    const sessions = [...data.sessions]
      .sort((x, y) => (x.started_at < y.started_at ? 1 : x.started_at > y.started_at ? -1 : 0))
      .slice(0, limit);
    const coachBySession = new Map();
    for (const r of (data.saved_hands || [])) {
      if (!r.session_id || !r.ai_feedback) continue;
      if (!coachBySession.has(r.session_id)) coachBySession.set(r.session_id, []);
      coachBySession.get(r.session_id).push(r.ai_feedback);
    }
    const heroBySession = new Map();
    for (const a of data.actions) {
      if (a.actor !== HERO) continue;
      if (!heroBySession.has(a.session_id)) heroBySession.set(a.session_id, []);
      heroBySession.get(a.session_id).push(a);
    }
    return sessions.map((s) => {
      const heroRows = heroBySession.get(s.session_id) || [];
      let actionLog = [];
      if (s.action_log) {
        try { actionLog = JSON.parse(s.action_log); } catch (e) { actionLog = []; }
      }
      let actions;
      if (actionLog.length) {
        // 全アクション（HERO/CPU）の時系列。HERO には評価を出現順で対応付ける
        let heroI = 0;
        actions = actionLog.map((a) => {
          let ev = '', reason = '';
          if (a.actor === HERO && heroI < heroRows.length) { const h = heroRows[heroI++]; ev = h.evaluation; reason = h.reason || ''; }
          return {
            street: a.street ?? '',
            actor: a.actor ?? '',
            action: a.action ?? '',
            amount: a.amount ?? 0,
            evaluation: ev,
            // 画面に出した判定の解説（2026/11/21〜の記録だけ。開発者モードで表示）
            ...(reason ? { reason } : {}),
          };
        });
      } else {
        // 旧データ（action_log 保存前）は HERO のアクションのみ
        actions = heroRows.map((a) => ({
          street: a.street, actor: HERO, action: a.action, amount: a.amount, evaluation: a.evaluation,
          ...(a.reason ? { reason: a.reason } : {}),
        }));
      }
      return {
        session_id: s.session_id,
        date: s.started_at,
        position: s.hero_pos,
        hole_cards: s.hero_hand,
        result: s.result,
        board: s.board || '',
        cpu_hand: s.cpu_hand || '',
        final_pot: s.final_pot || 0,
        winner: s.winner || '',
        actions,
        // 2026/11/21〜の記録だけ: 相手のポジションと、このハンドの AIコーチの回答
        ...(s.cpu_pos ? { cpu_pos: s.cpu_pos } : {}),
        ...(coachBySession.has(s.session_id) ? { coach: coachBySession.get(s.session_id) } : {}),
      };
    });
  }

  function parseHandToCombo(handStr) {
    if (!handStr || !handStr.includes(',')) return '';
    const cards = handStr.split(',');
    if (cards.length !== 2) return '';
    let r1 = cards[0][0].toUpperCase(), s1 = cards[0][1].toLowerCase();
    let r2 = cards[1][0].toUpperCase(), s2 = cards[1][1].toLowerCase();
    const order = 'AKQJT98765432';
    const i1 = order.indexOf(r1), i2 = order.indexOf(r2);
    if (i1 === -1 || i2 === -1) return '';
    if (i1 > i2) [r1, r2] = [r2, r1];
    const combo = r1 + r2;
    if (r1 === r2) return combo;
    return combo + (s1 === s2 ? 's' : 'o');
  }

  function getPersonalRangeStats(data, period = 'all', now = nowIso()) {
    const inPeriod = periodPredicate(data.actions, period, now);
    const sessionById = new Map(data.sessions.map((s) => [s.session_id, s]));
    // sessions JOIN actions ... ORDER BY s.session_id, a.id
    const rows = data.actions
      .filter((a) => a.actor === HERO && a.street === 'PREFLOP' && inPeriod(a))
      .map((a) => ({ a, s: sessionById.get(a.session_id) }))
      .filter(({ s }) => s && s.hero_hand !== '')
      .sort((x, y) => (x.a.session_id < y.a.session_id ? -1 : x.a.session_id > y.a.session_id ? 1 : x.a.id - y.a.id));

    const sessionActions = new Map();
    for (const { a, s } of rows) {
      const cur = sessionActions.get(a.session_id);
      if (!cur) {
        sessionActions.set(a.session_id, { hand: s.hero_hand, action: a.action, amount: a.amount });
      } else if (a.action === 'RAISE' || a.action === 'BET') {
        sessionActions.set(a.session_id, { hand: s.hero_hand, action: a.action, amount: Math.max(a.amount, cur.amount) });
      } else if (a.action === 'CALL' && !['RAISE', 'BET'].includes(cur.action)) {
        sessionActions.set(a.session_id, { hand: s.hero_hand, action: a.action, amount: a.amount });
      } else if (a.action === 'FOLD' && !['RAISE', 'BET', 'CALL'].includes(cur.action)) {
        sessionActions.set(a.session_id, { hand: s.hero_hand, action: a.action, amount: a.amount });
      }
    }

    const stats = {};
    for (const d of sessionActions.values()) {
      const combo = parseHandToCombo(d.hand);
      if (!combo) continue;
      if (!stats[combo]) stats[combo] = { OPEN: 0, CALL: 0, '3BET': 0, FOLD: 0 };
      if (d.action === 'FOLD') stats[combo].FOLD += 1;
      else if (d.action === 'CALL') stats[combo].CALL += 1;
      else if (d.action === 'RAISE' || d.action === 'BET') {
        if (d.amount >= 4.0) stats[combo]['3BET'] += 1;
        else stats[combo].OPEN += 1;
      }
    }
    return stats;
  }

  const StatsCalc = {
    formatIso, parseIso, nowIso, sqlAvg,
    getOverview, getPositionStats, getStreetEvalDist, getLeaks,
    getSavedHands, getHandHistory, getPersonalRangeStats, getPlayStyle, getHomeSummary, getWeekCards, getCardCollection, bestHandCategory,
  };
  root.StatsCalc = StatsCalc;
  if (typeof module !== 'undefined') module.exports = StatsCalc;
})(typeof window !== 'undefined' ? window : globalThis);
