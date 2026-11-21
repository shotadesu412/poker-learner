// iPad用の完成画像を作る。
// - game/range/coach: 電話カード状の箱(raw_ipad, ~1440x2700)を
//   電話フレームのモックアップに載せる（compose.jsと同じ考え方）
// - stats: iPad幅で元から綺麗に収まるページなので、フレーム無しでそのまま
//   角丸のスクリーンショットとして貼る
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const RAW = path.join(__dirname, 'raw_ipad');
const OUT = path.join(__dirname, 'final');

const DESIGN_W = 2048, DESIGN_H = 2732; // 12.9インチを基準デザインにする

const TARGETS = [
  { w: 2048, h: 2732 },
  { w: 2064, h: 2752 },
];

const PHONE_SLIDES = [
  { img: '03_game_drawer_open.png', caption: 'Decide. Get graded.\nNext hand.', out: '01_decide_graded.png' },
  { img: '04_range_chart.png', caption: "Check their range\nwithout leaving the hand", out: '02_range_chart.png' },
  { img: '05_ai_coach.png', caption: 'Review tough hands\nwith the AI coach', out: '03_ai_coach.png' },
];

const FLAT_SLIDE = { img: '06_stats.png', caption: 'See which spots\nyour reps should go to', out: '04_stats.png' };

function toDataUri(file) {
  const buf = fs.readFileSync(path.join(RAW, file));
  return 'data:image/png;base64,' + buf.toString('base64');
}

function phoneHtml(dataUri, captionLines, targetW, targetH) {
  const captionHtml = captionLines.split('\n').map(l => `<div>${l}</div>`).join('');
  const sx = targetW / DESIGN_W, sy = targetH / DESIGN_H;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { width:${targetW}px; height:${targetH}px; overflow:hidden; background:#060b1f; }
  .canvas {
    width: ${DESIGN_W}px; height: ${DESIGN_H}px;
    transform: scale(${sx}, ${sy}); transform-origin: top left;
    background: radial-gradient(120% 90% at 50% 0%, #1e40af 0%, #0d1f4d 45%, #060b1f 100%);
    display:flex; flex-direction:column; align-items:center;
    font-family: -apple-system, "SF Pro Display", "Helvetica Neue", Arial, sans-serif;
  }
  .caption {
    margin-top: 190px; width: 90%; text-align:center; color: #ff9a2e;
    font-weight: 800; font-size: 88px; line-height: 1.18; letter-spacing: -1px;
    text-shadow: 0 4px 24px rgba(0,0,0,0.35);
  }
  .phone-wrap {
    margin-top: 130px; position: relative; width: 900px;
    filter: drop-shadow(0 40px 70px rgba(0,0,0,0.55));
  }
  .phone-frame {
    position: relative; width: 900px; border-radius: 86px;
    background: #0a0a0c; padding: 18px; border: 2px solid rgba(255,255,255,0.08);
  }
  .phone-screen { position: relative; width: 100%; border-radius: 70px; overflow: hidden; background: #000; }
  .phone-screen img { display: block; width: 100%; height: auto; }
  .notch {
    position: absolute; top: 30px; left: 50%; transform: translateX(-50%);
    width: 196px; height: 56px; background: #0a0a0c; border-radius: 36px; z-index: 5;
  }
</style></head><body>
  <div class="canvas">
    <div class="caption">${captionHtml}</div>
    <div class="phone-wrap">
      <div class="phone-frame"><div class="notch"></div>
        <div class="phone-screen"><img src="${dataUri}"></div>
      </div>
    </div>
  </div>
</body></html>`;
}

function flatHtml(dataUri, captionLines, targetW, targetH) {
  const captionHtml = captionLines.split('\n').map(l => `<div>${l}</div>`).join('');
  const sx = targetW / DESIGN_W, sy = targetH / DESIGN_H;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { width:${targetW}px; height:${targetH}px; overflow:hidden; background:#060b1f; }
  .canvas {
    width: ${DESIGN_W}px; height: ${DESIGN_H}px;
    transform: scale(${sx}, ${sy}); transform-origin: top left;
    background: radial-gradient(120% 90% at 50% 0%, #1e40af 0%, #0d1f4d 45%, #060b1f 100%);
    display:flex; flex-direction:column; align-items:center;
    font-family: -apple-system, "SF Pro Display", "Helvetica Neue", Arial, sans-serif;
  }
  .caption {
    margin-top: 170px; width: 90%; text-align:center; color: #ff9a2e;
    font-weight: 800; font-size: 88px; line-height: 1.18; letter-spacing: -1px;
    text-shadow: 0 4px 24px rgba(0,0,0,0.35);
  }
  .frame-wrap {
    margin-top: 110px; width: 1760px;
    filter: drop-shadow(0 40px 70px rgba(0,0,0,0.55));
  }
  .frame {
    width: 100%; border-radius: 46px; overflow: hidden;
    background: #0a0a0c; padding: 16px; border: 2px solid rgba(255,255,255,0.08);
  }
  .screen { border-radius: 32px; overflow: hidden; background:#000; }
  .screen img { display:block; width: 100%; height: auto; }
</style></head><body>
  <div class="canvas">
    <div class="caption">${captionHtml}</div>
    <div class="frame-wrap">
      <div class="frame"><div class="screen"><img src="${dataUri}"></div></div>
    </div>
  </div>
</body></html>`;
}

(async () => {
  const browser = await chromium.launch();

  for (const target of TARGETS) {
    const outDir = path.join(OUT, `ipad_${target.w}x${target.h}`);
    fs.mkdirSync(outDir, { recursive: true });
    const page = await browser.newPage({ viewport: { width: target.w, height: target.h }, deviceScaleFactor: 1 });

    for (const slide of PHONE_SLIDES) {
      const html = phoneHtml(toDataUri(slide.img), slide.caption, target.w, target.h);
      await page.setContent(html, { waitUntil: 'load' });
      await page.waitForTimeout(100);
      const outPath = path.join(outDir, slide.out);
      await page.screenshot({ path: outPath });
      console.log('composed', outPath);
    }

    const html = flatHtml(toDataUri(FLAT_SLIDE.img), FLAT_SLIDE.caption, target.w, target.h);
    await page.setContent(html, { waitUntil: 'load' });
    await page.waitForTimeout(100);
    const outPath = path.join(outDir, FLAT_SLIDE.out);
    await page.screenshot({ path: outPath });
    console.log('composed', outPath);

    await page.close();
  }

  await browser.close();
})();
