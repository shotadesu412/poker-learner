// 生スクショ + キャプションを合成し、App Store提出サイズの完成画像を作る。
// デバイス枠はCSSで簡易描画（実機ベゼル画像は使わない）。
//
// レイアウトは固定デザイン幅 DESIGN_W x DESIGN_H で組み、CSS transform:scale で
// 各ターゲットサイズにぴったり収まるよう引き伸ばす（縦横independentにスケール
// するため、アスペクト比が微妙に違うターゲットでも歪みは目視でわからないレベル
// に収まる。iPhoneの画面アスペクト比はどの世代もほぼ同じなため）。
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const RAW = path.join(__dirname, 'raw');
const OUT = path.join(__dirname, 'final');

const DESIGN_W = 1290, DESIGN_H = 2796;

// App Store Connect が要求する正しいサイズ（縦向き）
const TARGETS = [
  { label: '6.5in', w: 1242, h: 2688 },
  { label: '6.7in', w: 1284, h: 2778 },
];

const SLIDES = [
  { img: '03_game_drawer_open.png', caption: 'Decide. Get graded.\nNext hand.', out: '01_decide_graded.png' },
  { img: '04_range_chart.png', caption: "Check their range\nwithout leaving the hand", out: '02_range_chart.png' },
  { img: '05_ai_coach.png', caption: 'Review tough hands\nwith the AI coach', out: '03_ai_coach.png' },
  { img: '06_stats.png', caption: 'See which spots\nyour reps should go to', out: '04_stats.png' },
];

function toDataUri(file) {
  const buf = fs.readFileSync(path.join(RAW, file));
  return 'data:image/png;base64,' + buf.toString('base64');
}

function pageHtml(dataUri, captionLines, targetW, targetH) {
  const captionHtml = captionLines
    .split('\n')
    .map(line => `<div>${line}</div>`)
    .join('');
  const sx = targetW / DESIGN_W;
  const sy = targetH / DESIGN_H;
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  * { margin:0; padding:0; box-sizing:border-box; }
  html, body { width:${targetW}px; height:${targetH}px; overflow:hidden; background:#060b1f; }
  .canvas {
    width: ${DESIGN_W}px;
    height: ${DESIGN_H}px;
    transform: scale(${sx}, ${sy});
    transform-origin: top left;
    background: radial-gradient(120% 90% at 50% 0%, #1e40af 0%, #0d1f4d 45%, #060b1f 100%);
    display:flex; flex-direction:column; align-items:center;
    font-family: -apple-system, "SF Pro Display", "Helvetica Neue", Arial, sans-serif;
  }
  .caption {
    margin-top: 130px;
    width: 92%;
    text-align:center;
    color: #ff9a2e;
    font-weight: 800;
    font-size: 78px;
    line-height: 1.18;
    letter-spacing: -1px;
    text-shadow: 0 4px 24px rgba(0,0,0,0.35);
  }
  .phone-wrap {
    margin-top: 90px;
    position: relative;
    width: 960px;
    filter: drop-shadow(0 40px 70px rgba(0,0,0,0.55));
  }
  .phone-frame {
    position: relative;
    width: 960px;
    border-radius: 92px;
    background: #0a0a0c;
    padding: 20px;
    border: 2px solid rgba(255,255,255,0.08);
  }
  .phone-screen {
    position: relative;
    width: 100%;
    border-radius: 74px;
    overflow: hidden;
    background: #000;
  }
  .phone-screen img {
    display: block;
    width: 100%;
    height: auto;
  }
  .notch {
    position: absolute;
    top: 34px;
    left: 50%;
    transform: translateX(-50%);
    width: 210px;
    height: 62px;
    background: #0a0a0c;
    border-radius: 40px;
    z-index: 5;
  }
</style></head>
<body>
  <div class="canvas">
    <div class="caption">${captionHtml}</div>
    <div class="phone-wrap">
      <div class="phone-frame">
        <div class="notch"></div>
        <div class="phone-screen"><img src="${dataUri}"></div>
      </div>
    </div>
  </div>
</body></html>`;
}

(async () => {
  const browser = await chromium.launch();

  for (const target of TARGETS) {
    const outDir = path.join(OUT, `${target.w}x${target.h}`);
    fs.mkdirSync(outDir, { recursive: true });
    const page = await browser.newPage({
      viewport: { width: target.w, height: target.h },
      deviceScaleFactor: 1,
    });

    for (const slide of SLIDES) {
      const dataUri = toDataUri(slide.img);
      const html = pageHtml(dataUri, slide.caption, target.w, target.h);
      await page.setContent(html, { waitUntil: 'load' });
      await page.waitForTimeout(100);
      const outPath = path.join(outDir, slide.out);
      await page.screenshot({ path: outPath });
      console.log('composed', outPath);
    }
    await page.close();
  }

  await browser.close();
})();
