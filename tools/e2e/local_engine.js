// サーバーに計算系 API が無い状態の通し確認。実際の画面を動かす。
//
// 準備（リポジトリには入れない。作業用フォルダで）: npm install playwright@1 && npx playwright install chromium
// 実行:
//   OPENAI_API_KEY=dummy python3 -m uvicorn app:app --port 8765 &
//   NODE_PATH=<作業用フォルダ>/node_modules node tools/e2e/local_engine.js
//
// 確認内容: ゲームが進む / 通信が静的ファイルと AIコーチだけ / コーチに state が届く / 分析ページが IndexedDB から集計 /
// プレミアムが localStorage と onEntitlementStatus で決まる / エンジンを読めないときに再読み込みを案内する
const { chromium } = require('playwright');
const BASE = 'http://localhost:8765';
let fails = 0; const ok = (c, m) => { console.log((c ? '  OK ' : '  NG ') + m); if (!c) fails++; };

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => {
    localStorage.setItem('poker_lang', 'ja');
    localStorage.setItem('poker_settings', JSON.stringify({ showRange: true, showFeedback: true, speed: 'fast' }));
  });
  const page = await ctx.newPage();
  const errors = []; const api = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname.startsWith('/api/')) api.push(u.pathname); });

  await page.goto(BASE + '/play');
  await page.waitForFunction(() => typeof currentState !== 'undefined' && currentState && GameApi.game);
  ok(await page.evaluate(() => !document.getElementById('engine-error') || getComputedStyle(document.getElementById('engine-error')).display === 'none'), 'エラー画面は出ない');

  for (let i = 0; i < 40; i++) {
    await page.evaluate(async () => {
      if (!currentState || currentState.finished) { await startHand(); return; }
      await takeAction(currentState.facingBet > 0 ? 'CALL' : 'CHECK', 0);
    });
    await page.waitForTimeout(150);
  }
  ok(await page.evaluate(() => GameApi.game.engine.handCount > 1), 'ハンドが進む');
  ok(api.length === 0, `ゲーム中の API 通信なし (${api.join(',')})`);
  ok(await page.evaluate(() => { fetchPreflopRanges(); return Object.keys(cachedPreflopRanges.BTN || {}).length > 0; }), 'プリフロップレンジを表示できる');

  const beforeCoach = api.length;   // ここからはテスト自身のコーチ呼び出しを除外する
  await page.route('**/api/ai_coach', (route) => {
    const body = route.request().postDataJSON();
    ok(!!(body.state && body.state.hero_pos), 'AIコーチに state が届く');
    route.fulfill({ json: { reply: 'テスト', hand_context: 'ctx' } });
  });
  await page.evaluate(() => fetch('/api/ai_coach', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [], user_id: 'x', state: GameApi.coachState() }) }));

  await page.evaluate(() => { localStorage.setItem('poker_is_premium', 'true'); });
  await page.goto(BASE + '/stats');
  await page.waitForTimeout(1500);
  ok(await page.evaluate(() => isPremium === true), '分析ページのプレミアムは localStorage から');
  ok(await page.evaluate(async () => (await StatsApi.loadPrimary('all')).overview !== undefined), '統計を端末から集計');

  await page.goto(BASE + '/');
  await page.evaluate(() => window.onEntitlementStatus(false));
  ok(await page.evaluate(() => localStorage.getItem('poker_is_premium') === 'false'), '権利なしで解除される');
  ok(api.filter((x) => x !== '/api/ai_coach').length === 0 && beforeCoach === 0, `画面全体でも API 通信なし (${api.join(',')})`);
  ok(errors.length === 0, `ページの例外なし ${errors.join(' / ')}`);

  const bad = await ctx.newPage();
  await bad.route('**/static/poker/engine.js*', (r) => r.abort());
  await bad.goto(BASE + '/play');
  await bad.waitForFunction(() => !document.getElementById('engine-error').classList.contains('hidden'));
  ok(await bad.evaluate(() => getComputedStyle(document.getElementById('engine-error')).display !== 'none'), 'エンジンを読めないと再読み込みを案内');

  await browser.close();
  console.log(fails ? `${fails} 件失敗` : '全件OK');
  process.exit(fails ? 1 : 0);
})();
