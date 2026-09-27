// 端末エンジン（?engine=local）の通し確認。WKWebView と同じ WebKit で実際の画面を動かす。
//
// 準備（リポジトリには入れない。scratchpad 等の作業用フォルダで）:
//   npm install playwright@1 && npx playwright install webkit
// 実行:
//   OPENAI_API_KEY=dummy POKER_DB_PATH=/tmp/x.db python3 -m uvicorn app:app --port 8765 &
//   NODE_PATH=<作業用フォルダ>/node_modules node tools/e2e/local_engine.js
//
// 確認内容: サーバーモードで遊ぶ → 端末モードへ切替（初回の統計取り込み）→ ゲーム進行がサーバーを
// 呼ばない → AIコーチに state が送られる → 分析ページが IndexedDB から集計 → サーバーモードに戻せる
const { webkit } = require('playwright');
const BASE = 'http://localhost:8765';
const UID = 'user_e2etest' + Date.now().toString(36);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0; const ok = (c, m) => { console.log((c ? '  OK ' : '  NG ') + m); if (!c) fails++; };

async function playActions(page, n) {
  for (let i = 0; i < n; i++) {
    await page.waitForFunction(() => currentState && !document.querySelector('.action-btn:disabled') || (currentState && currentState.finished), null, { timeout: 15000 }).catch(() => {});
    const done = await page.evaluate(async () => {
      if (!currentState || currentState.finished) { await startHand(); return 'new'; }
      const f = currentState.facingBet;
      const acts = f > 0 ? ['CALL', 'CALL', 'RAISE', 'FOLD'] : ['CHECK', 'BET'];
      const a = acts[Math.floor(Math.random() * acts.length)];
      const amt = a === 'RAISE' ? Math.round(f * 3 * 10) / 10 : a === 'BET' ? Math.max(2.5, Math.round(currentState.potSize * 5) / 10) : 0;
      await takeAction(a, amt);
      return a;
    });
    await sleep(900);
  }
}

(async () => {
  const browser = await webkit.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  await ctx.addInitScript((uid) => {
    localStorage.setItem('poker_user_id', uid);
    localStorage.setItem('poker_settings', JSON.stringify({ showRange: true, showFeedback: true, speed: 'fast' }));
    localStorage.setItem('poker_lang', 'ja');
  }, UID);
  const page = await ctx.newPage();
  const errors = [], logs = [], reqs = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => logs.push(m.type() + ': ' + m.text()));
  page.on('request', (r) => reqs.push(new URL(r.url()).pathname));

  console.log('1. サーバーモードでプレイ（既存ユーザーのデータを作る）');
  await page.goto(BASE + '/play?engine=server');
  await sleep(1500);
  await playActions(page, 12);
  ok(reqs.some((p) => p === '/api/action'), 'サーバーの /api/action が呼ばれている');
  ok(!reqs.some((p) => p.startsWith('/static/poker/')), '端末エンジンのモジュールを読み込んでいない');
  const serverExport = await (await page.request.get(`${BASE}/api/stats/export?user_id=${UID}`)).json();
  console.log(`   サーバーの統計: actions=${serverExport.actions.length} sessions=${serverExport.sessions.length}`);

  console.log('2. 端末モードに切り替え');
  reqs.length = 0; logs.length = 0;
  await page.goto(BASE + '/play?engine=local');
  await page.waitForFunction(() => GameApi.game && currentState, null, { timeout: 15000 });
  ok(logs.some((l) => l.includes('サーバーの統計を取り込みました')), '初回の取り込みが走った');
  ok(logs.some((l) => l.includes('端末エンジンで動作中')), '端末エンジンで動作中');
  await playActions(page, 25);
  const apiCalls = reqs.filter((p) => p.startsWith('/api/'));
  ok(!apiCalls.some((p) => ['/api/start_hand', '/api/action', '/api/state'].includes(p)), `ゲーム進行でサーバーを呼んでいない（呼んだAPI: ${[...new Set(apiCalls)].join(', ')}）`);
  const st = await page.evaluate(() => ({ street: currentState.street, pot: currentState.potSize, hand: currentState.heroHand, eq: currentState.equity }));
  console.log('   現在の状態', JSON.stringify(st));

  console.log('3. AIコーチ（ハンド状態を送る）');
  let coachBody = null;
  await page.route('**/api/ai_coach*', async (route) => {
    coachBody = JSON.parse(route.request().postData());
    // 本物のサーバーにも投げて、state 付きリクエストが 422 にならないことを確認
    const res = await route.fetch();
    ok(res.status() === 200, `サーバーが state 付きリクエストを受け付ける (HTTP ${res.status()})`);
    await route.fulfill({ json: { reply: 'テスト回答。', hand_context: 'TEST_CONTEXT' } });
  });
  await page.evaluate(() => { if (!currentState || currentState.finished) return startHand(); });
  await sleep(500);
  await page.evaluate(() => requestCoachExplanation());
  await sleep(1500);
  ok(coachBody && coachBody.state && coachBody.state.hero.length === 2 && coachBody.state.hero_pos, 'state にハンド情報が入っている: ' + JSON.stringify(coachBody && coachBody.state).slice(0, 160));

  console.log('4. リロード（2回目は取り込みをスキップ）');
  logs.length = 0;
  await page.goto(BASE + '/play');
  await page.waitForFunction(() => GameApi.game && currentState, null, { timeout: 15000 });
  ok(!logs.some((l) => l.includes('取り込みました')), '2回目は取り込まない');
  ok(await page.evaluate(() => GameApi.mode === 'local'), 'フラグが localStorage に残っている');

  console.log('5. 分析ページ（端末の IndexedDB から集計）');
  reqs.length = 0;
  await page.goto(BASE + '/stats');
  await sleep(2500);
  const shown = await page.evaluate(() => ({
    actions: document.getElementById('stat-actions').textContent,
    gto: document.getElementById('gto-score').textContent,
    hist: document.querySelectorAll('#hand-history-list > *, .hand-history-item').length,
    ai: document.getElementById('ai-history-list').textContent.includes('テスト回答'),
    invalid: document.body.textContent.includes('Invalid Date') || document.body.textContent.includes('NaN'),
  }));
  const local = await page.evaluate(async () => { const d = await StatsStore.loadAll(); return { n: d.actions.filter((a) => a.actor === 'HERO').length, ov: StatsCalc.getOverview(d, 'all') }; });
  console.log('   表示', JSON.stringify(shown), '集計', JSON.stringify(local.ov));
  ok(String(local.ov.total_actions) === shown.actions && local.n > serverExport.actions.filter((a) => a.actor === 'HERO').length, '総アクション数 = 取り込み分 + 端末で遊んだ分');
  ok(shown.ai, 'AIコーチの相談履歴が表示されている');
  ok(!shown.invalid, '日時・数値の表示崩れ（Invalid Date / NaN）なし');
  ok(!reqs.some((p) => p.startsWith('/api/stats/') && p !== '/api/stats/export'), `統計APIを呼んでいない（${[...new Set(reqs.filter((p) => p.startsWith('/api/')))].join(', ')}）`);
  for (const period of ['30d', '7d', 'last']) {
    await page.click(`.period-btn[data-period="${period}"]`); await sleep(700);
  }
  ok(true, '期間切り替え（直近1セッション含む）');

  console.log('6. サーバーモードに戻す');
  reqs.length = 0;
  await page.goto(BASE + '/stats?engine=server'); await sleep(1500);
  ok(reqs.includes('/api/stats/overview') && !reqs.some((p) => p.startsWith('/static/poker/')), 'サーバーの統計を表示');

  ok(errors.length === 0, 'ページ内の例外なし ' + errors.join(' | '));
  const errLogs = logs.filter((l) => l.startsWith('error'));
  if (errLogs.length) console.log('   console.error:', errLogs.slice(0, 5));
  await browser.close();
  console.log(fails ? `NG ${fails}件` : 'すべてOK');
  process.exit(fails ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
