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

  function getPositionStats(data) {
    const hero = heroActions(data);
    return ['LJ', 'HJ', 'CO', 'BTN', 'SB', 'BB'].map((pos) => {
      const mine = hero.filter((a) => a.hero_pos === pos);
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

  function getSavedHands(data) {
    return [...data.saved_hands]
      .sort((x, y) => (x.timestamp < y.timestamp ? 1 : x.timestamp > y.timestamp ? -1 : 0))
      .slice(0, 50)
      .map((r) => ({
        session_id: r.session_id,
        timestamp: r.timestamp,
        hand_context: r.hand_context,
        ai_feedback: r.ai_feedback,
      }));
  }

  function getHandHistory(data, limit = 30) {
    const sessions = [...data.sessions]
      .sort((x, y) => (x.started_at < y.started_at ? 1 : x.started_at > y.started_at ? -1 : 0))
      .slice(0, limit);
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
          let ev = '';
          if (a.actor === HERO && heroI < heroRows.length) ev = heroRows[heroI++].evaluation;
          return {
            street: a.street ?? '',
            actor: a.actor ?? '',
            action: a.action ?? '',
            amount: a.amount ?? 0,
            evaluation: ev,
          };
        });
      } else {
        // 旧データ（action_log 保存前）は HERO のアクションのみ
        actions = heroRows.map((a) => ({
          street: a.street, actor: HERO, action: a.action, amount: a.amount, evaluation: a.evaluation,
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
    getSavedHands, getHandHistory, getPersonalRangeStats,
  };
  root.StatsCalc = StatsCalc;
  if (typeof module !== 'undefined') module.exports = StatsCalc;
})(typeof window !== 'undefined' ? window : globalThis);
