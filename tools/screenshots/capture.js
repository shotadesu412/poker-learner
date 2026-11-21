// App Storeスクショの「素材」（キャプション無しの生スクリーンショット）を撮る。
// iPhone 6.9インチ相当 (論理430x932 @3x)。
//
// - ホーム / AIコーチ: 本番サイト (production)。AIコーチは実APIの応答が
//   良質なため本番を使う。ハンドの中身は何でもよく、良い評価は不要
// - ゲーム画面 / レンジ表: ローカルサーバー (同一コミットのコード) を使い、
//   currentState.equity から必要勝率を逆算する簡易ヒューリスティックで
//   「まあまあ筋の良いプレイ」を行い、良い評価(◎/◯)が並ぶハンドを高速に
//   何度も引き直す（本番相手だと1往復 ~1秒かかり大量リトライが遅いため）
// - 分析ページ: ローカルサーバー + seed_stats.py で仕込んだダミーデータ
//   （本番DBには一切触れない）
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const PROD = process.env.TARGET_URL || 'https://poker-learner.onrender.com';
const LOCAL = process.env.LOCAL_URL || 'http://127.0.0.1:8811';
const LOCAL_USER = process.env.LOCAL_USER || 'shot_seed_user';
const OUT = path.join(__dirname, 'raw');
fs.mkdirSync(OUT, { recursive: true });

const DEVICE = { width: 430, height: 932, deviceScaleFactor: 3 };

async function shot(page, name) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file });
  console.log('saved', file);
}

async function waitReady(page) {
  await page.waitForSelector('#btn-fold:not([disabled])', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(120);
}

async function readUiState(page) {
  return page.evaluate(() => {
    const finished = !!(document.getElementById('restart-area') && !document.getElementById('restart-area').classList.contains('hidden'));
    const checkVisible = getComputedStyle(document.getElementById('btn-check')).display !== 'none';
    const betVisible = getComputedStyle(document.getElementById('btn-bet')).display !== 'none';
    const street = document.getElementById('street-display') ? document.getElementById('street-display').textContent.trim() : '';
    const pot = window.currentState ? window.currentState.potSize : 0;
    const facing = window.currentState ? window.currentState.facingBet : 0;
    const equity = window.currentState ? window.currentState.equity : 50;
    return { finished, checkVisible, betVisible, street, pot, facing, equity };
  });
}

async function historyGrades(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('#eval-history .hist-eval')).map(e => e.textContent.trim())
  );
}

// currentState.equity (0-100, 生エクイティ) から必要勝率を逆算し、
// FOLD / CHECK / CALL / BET(RAISE) のどれかを選ぶ簡易ヒューリスティック。
// GTOそのものではないが、常CALL/CHECKよりずっと理にかなった判断になる。
function decideAction(s) {
  if (s.facing > 0) {
    const required = (s.facing / (s.pot + s.facing)) * 100;
    if (s.equity >= required + 20) return { action: 'RAISE', amount: Math.max(2, (s.pot + s.facing) * 0.7) };
    if (s.equity >= required - 3) return { action: 'CALL', amount: 0 };
    return { action: 'FOLD', amount: 0 };
  }
  if (s.equity >= 58 && s.betVisible) return { action: 'BET', amount: Math.max(2, s.pot * 0.66) };
  return { action: 'CHECK', amount: 0 };
}

async function newContext(browser) {
  const context = await browser.newContext({
    viewport: DEVICE,
    deviceScaleFactor: DEVICE.deviceScaleFactor,
    locale: 'en-US',
    isMobile: true,
    hasTouch: true,
  });
  await context.addInitScript(() => {
    try { localStorage.setItem('poker_lang', 'en'); } catch (e) {}
  });
  return context;
}

(async () => {
  const browser = await chromium.launch();

  // ============ 本番サイト: ホーム画面 ============
  const ctxHome = await newContext(browser);
  const homePage = await ctxHome.newPage();
  await homePage.goto(PROD + '/', { waitUntil: 'networkidle' });
  await homePage.waitForTimeout(300);
  await shot(homePage, '01_home');
  await ctxHome.close();

  // ============ ローカル: ゲーム画面 / レンジ表（高速リトライ） ============
  const ctxGame = await newContext(browser);
  const page = await ctxGame.newPage();
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));

  let good = false;
  let capturedRange = false;
  for (let attempt = 0; attempt < 25 && !good; attempt++) {
    const userId = 'shot_' + Date.now() + '_' + attempt;
    await page.goto(LOCAL + '/play', { waitUntil: 'networkidle' });
    await page.evaluate((uid) => localStorage.setItem('poker_user_id', uid), userId);
    await page.reload({ waitUntil: 'networkidle' });
    await waitReady(page);
    capturedRange = false;

    for (let i = 0; i < 8; i++) {
      const s = await readUiState(page);
      if (s.finished) break;
      if (s.street === 'PREFLOP' && s.pot > 30) break; // 荒れたハンドは見切る

      if (!capturedRange && s.street !== 'PREFLOP') {
        await page.evaluate(() => window.openRangeModal && window.openRangeModal('CPU'));
        await page.waitForTimeout(400);
        await shot(page, '04_range_chart');
        await page.evaluate(() => window.closeRangeModal && window.closeRangeModal());
        await page.waitForTimeout(150);
        capturedRange = true;
      }

      const decision = decideAction(s);
      await page.evaluate(({ action, amount }) => window.takeAction(action, amount), decision);
      await waitReady(page);

      const grades = await historyGrades(page);
      if (grades.includes('×') || grades.includes('△')) break;

      const s2 = await readUiState(page);
      if (!s2.finished && s2.street !== 'PREFLOP' && grades.length >= 2 && grades.every(g => g === '◎' || g === '◯')) {
        good = true;
        break;
      }
    }
    if (!good) console.log(`  attempt ${attempt}: 条件を満たさず次を試行`);
  }
  console.log(good ? '  良いハンドが見つかりました' : '  25回試して見つからず、直近の状態で撮影します');

  await shot(page, '02_game_evaluation');
  const opened = await page.evaluate(() => {
    if (typeof window.openReasonArea === 'function') { window.openReasonArea(); return true; }
    return false;
  });
  if (opened) {
    await page.waitForTimeout(350);
    await shot(page, '03_game_drawer_open');
  }
  if (!capturedRange) {
    await page.evaluate(() => window.openRangeModal && window.openRangeModal('CPU'));
    await page.waitForTimeout(400);
    await shot(page, '04_range_chart');
    await page.evaluate(() => window.closeRangeModal && window.closeRangeModal());
  }
  await ctxGame.close();

  // ============ 本番サイト: AIコーチ（実APIの応答を使う） ============
  const ctxCoach = await newContext(browser);
  const coachPage = await ctxCoach.newPage();
  const coachUser = 'shot_coach_' + Date.now();
  await coachPage.goto(PROD + '/play', { waitUntil: 'networkidle' });
  await coachPage.evaluate((uid) => localStorage.setItem('poker_user_id', uid), coachUser);
  await coachPage.reload({ waitUntil: 'networkidle' });
  await waitReady(coachPage);

  for (let i = 0; i < 8; i++) {
    const s = await readUiState(coachPage);
    if (s.finished) break;
    const decision = decideAction(s);
    await coachPage.evaluate(({ action, amount }) => window.takeAction(action, amount), decision);
    await waitReady(coachPage);
  }
  const sFin = await readUiState(coachPage);
  if (!sFin.finished) {
    await coachPage.evaluate(() => window.takeAction && window.takeAction('FOLD'));
    await waitReady(coachPage);
  }
  await coachPage.evaluate(() => window.requestCoachExplanation && window.requestCoachExplanation());
  await coachPage.waitForTimeout(4000);

  const hasReply = await coachPage.$('.chat-bubble.assistant');
  if (!hasReply) {
    await coachPage.evaluate(() => {
      const box = document.getElementById('coach-chat-history');
      if (!box) return;
      box.innerHTML = `
        <div class="chat-bubble user">Briefly explain what I should improve and what I did well across this hand.</div>
        <div class="chat-bubble assistant"><strong class="coach-heading">[Overview]</strong><br>
        <span class="coach-bullet">▸</span> You played well through the flop, but the turn line gets shaky.<br>
        <span class="coach-bullet">▸</span> Betting the flop and then checking back the turn is a hard story to tell.<br><br>
        <strong class="coach-heading">[What went well]</strong><br>
        <span class="coach-bullet">▸</span> The preflop open itself was standard and fine.<br>
        <span class="coach-bullet">▸</span> Raising a donk bet with top pair on a wet board was a reasonable, protective line.</div>`;
    });
  }
  await coachPage.waitForTimeout(200);
  await shot(coachPage, '05_ai_coach');
  await ctxCoach.close();

  // ============ ローカル: 分析ページ（seed_stats.py 済みのDBを見せる） ============
  const ctxStats = await newContext(browser);
  const statsPage = await ctxStats.newPage();
  await statsPage.goto(LOCAL, { waitUntil: 'networkidle' });
  await statsPage.evaluate((uid) => localStorage.setItem('poker_user_id', uid), LOCAL_USER);
  await statsPage.goto(LOCAL + '/stats', { waitUntil: 'networkidle' });
  await statsPage.waitForTimeout(700);
  await shot(statsPage, '06_stats');
  await ctxStats.close();

  await browser.close();
  console.log('done');
})();
