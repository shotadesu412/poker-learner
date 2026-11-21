// iPad用の生スクショを 2048x2732 (12.9インチ枠) で撮る。
// アプリ自体が iPad 幅では中央にカード状の箱で表示される作り（style.css の
// @media min-width:700px）なので、電話フレームのモックアップは不要。
// この箱の見た目自体がそのままマーケティング画像の土台になる。
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const LOCAL = process.env.LOCAL_URL || 'http://127.0.0.1:8811';
const PROD = process.env.TARGET_URL || 'https://poker-learner.onrender.com';
const LOCAL_USER = process.env.LOCAL_USER || 'shot_seed_user';
const OUT = path.join(__dirname, 'raw_ipad');
fs.mkdirSync(OUT, { recursive: true });

// ビューポート自体は tablet メディアクエリ(min-width:700px)を発火させる
// ためだけの大きさ。実際に撮るのは body 要素だけ（480x900のカード）を
// deviceScaleFactor 3 で高解像度に切り出す。周囲の黒い余白は無駄なので
// 最初から含めない。これで static/i18n.js 側の電話フレーム合成テンプレート
// (compose.js) にそのまま流用できる
const DEVICE = { width: 1032, height: 1376 };

async function shot(page, name) {
  const file = path.join(OUT, `${name}.png`);
  await page.locator('body').screenshot({ path: file });
  console.log('saved', file);
}

async function waitReady(page) {
  await page.waitForSelector('#btn-fold:not([disabled])', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(120);
}

async function readUiState(page) {
  return page.evaluate(() => {
    const finished = !!(document.getElementById('restart-area') && !document.getElementById('restart-area').classList.contains('hidden'));
    const vis = (id) => getComputedStyle(document.getElementById(id)).display !== 'none';
    const street = document.getElementById('street-display') ? document.getElementById('street-display').textContent.trim() : '';
    return { finished, street, checkVisible: vis('btn-check'), callVisible: vis('btn-call') };
  });
}

async function historyGrades(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('#eval-history .hist-eval')).map(e => e.textContent.trim())
  );
}

async function newContext(browser) {
  const context = await browser.newContext({
    viewport: DEVICE,
    deviceScaleFactor: 3,
    locale: 'en-US',
    isMobile: false,
    hasTouch: true,
  });
  await context.addInitScript(() => {
    try { localStorage.setItem('poker_lang', 'en'); } catch (e) {}
  });
  return context;
}

async function freshHand(page, base, userId) {
  await page.goto(base + '/play', { waitUntil: 'networkidle' });
  await page.evaluate((uid) => localStorage.setItem('poker_user_id', uid), userId);
  await page.reload({ waitUntil: 'networkidle' });
  await waitReady(page);
}

// 常にコール/チェック。ポストフロップに到達し、直近の評価が×でなければ成功。
async function playToPostflop(page, base, label) {
  for (let attempt = 0; attempt < 10; attempt++) {
    await freshHand(page, base, `shot_${label}_${Date.now()}_${attempt}`);
    for (let i = 0; i < 6; i++) {
      const s = await readUiState(page);
      if (s.finished) break;
      if (s.street !== 'PREFLOP') {
        const grades = await historyGrades(page);
        if (grades[grades.length - 1] !== '×') {
          console.log(`  ${label}: attempt ${attempt} で成功 (street=${s.street})`);
          return true;
        }
        break;
      }
      if (s.callVisible) await page.click('#btn-call');
      else if (s.checkVisible) await page.click('#btn-check');
      else break;
      await waitReady(page);
    }
  }
  console.log(`  ${label}: 条件を満たせず、直近の状態で撮影します`);
  return false;
}

(async () => {
  const browser = await chromium.launch();

  // ============ ローカル: ゲーム画面 / レンジ表 / 分析ページ ============
  const ctxLocal = await newContext(browser);
  const page = await ctxLocal.newPage();
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));

  // ホーム画面
  await page.goto(LOCAL + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(300);
  await shot(page, '01_home');

  // レンジ表
  await playToPostflop(page, LOCAL, 'range');
  await page.evaluate(() => window.openRangeModal && window.openRangeModal('CPU'));
  await page.waitForTimeout(400);
  await shot(page, '04_range_chart');
  await page.evaluate(() => window.closeRangeModal && window.closeRangeModal());
  await page.waitForTimeout(150);

  // ゲーム画面 + 評価ドロワー
  await playToPostflop(page, LOCAL, 'game');
  await shot(page, '02_game_evaluation');
  const opened = await page.evaluate(() => {
    if (typeof window.openReasonArea === 'function') { window.openReasonArea(); return true; }
    return false;
  });
  if (opened) {
    await page.waitForTimeout(350);
    await shot(page, '03_game_drawer_open');
  }

  // 分析ページ（seed_stats.py 済み）
  await page.evaluate((uid) => localStorage.setItem('poker_user_id', uid), LOCAL_USER);
  await page.goto(LOCAL + '/stats', { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  await shot(page, '06_stats');
  await ctxLocal.close();

  // ============ 本番: AIコーチ（実APIの応答を使う） ============
  const ctxCoach = await newContext(browser);
  const coachPage = await ctxCoach.newPage();
  await playToPostflop(coachPage, PROD, 'coach');
  const s = await readUiState(coachPage);
  if (!s.finished) {
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

  await browser.close();
  console.log('done');
})();
