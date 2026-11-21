// ゲーム画面 / レンジ表 の生スクショだけを撮る（ホーム・AIコーチ・分析は capture.js 側）。
//
// 方針: 複雑なエクイティ・ヒューリスティックは再現性が低かったため、
// 「常にコール/チェックでポストフロップまで進める」だけのシンプルな方式に統一。
// ×（明確なミス）が出たハンドだけ引き直す。◎/◯/△が混ざるのは実際のアプリの
// 挙動としてむしろ自然なので許容する。
//
// アクションは必ず「実際に表示されているボタン」をクリックする
// （window.currentState を直接読んでJS越しにtakeAction()を呼ぶと、UIが
//   許可しないはずのCHECK等をサーバーが受理し、CPUが延々ベットし続ける
//   壊れたプリフロップ戦争になることが分かったため）。
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const LOCAL = process.env.LOCAL_URL || 'http://127.0.0.1:8811';
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

async function freshHand(page, userId) {
  await page.goto(LOCAL + '/play', { waitUntil: 'networkidle' });
  await page.evaluate((uid) => localStorage.setItem('poker_user_id', uid), userId);
  await page.reload({ waitUntil: 'networkidle' });
  await waitReady(page);
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

// 常にコール/チェック。ポストフロップに到達し、かつ直近の評価が×でなければ成功。
async function playToPostflop(page, label) {
  for (let attempt = 0; attempt < 10; attempt++) {
    await freshHand(page, `shot_${label}_${Date.now()}_${attempt}`);
    for (let i = 0; i < 6; i++) {
      const s = await readUiState(page);
      if (s.finished) break;

      if (s.street !== 'PREFLOP') {
        const grades = await historyGrades(page);
        if (grades[grades.length - 1] !== '×') {
          console.log(`  ${label}: attempt ${attempt} で成功 (street=${s.street})`);
          return true;
        }
        break; // ×だったので次のハンドへ
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
  const ctx = await newContext(browser);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('  [pageerror]', e.message));

  // 1. レンジ表
  await playToPostflop(page, 'range');
  await page.evaluate(() => window.openRangeModal && window.openRangeModal('CPU'));
  await page.waitForTimeout(400);
  await shot(page, '04_range_chart');
  await page.evaluate(() => window.closeRangeModal && window.closeRangeModal());
  await page.waitForTimeout(150);

  // 2. ゲーム画面 + 評価ドロワー（別のハンドで撮り直す）
  await playToPostflop(page, 'game');
  await shot(page, '02_game_evaluation');
  const opened = await page.evaluate(() => {
    if (typeof window.openReasonArea === 'function') { window.openReasonArea(); return true; }
    return false;
  });
  if (opened) {
    await page.waitForTimeout(350);
    await shot(page, '03_game_drawer_open');
  }

  await browser.close();
  console.log('done');
})();
