// panels.js — 練習画面のアクション履歴の部分を、左右スワイプで切り替える3枚にする（2026/11/19〜。ブランチ ui-v2）
//   1. アクション履歴（今までと同じ #eval-history）
//   2. 相手のレンジ: 直前の相手のアクションで消えた手を赤く薄く、残っている手を緑の濃さで
//   3. 楕円のテーブル: 6席・ボタン・このストリートで出した額・ポット
// スワイプはブラウザの横スクロール（scroll-snap）に任せる。描画は script.js の updateUI の最後に renderPanels() を呼ぶ
// 依存: script.js（currentState, displayCpuPos, parseCardStr, t）

const PANEL_RANKS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];
const PANEL_SEATS = ['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB'];   // 時計回り（次に動く人が左隣）

// 相手のレンジの「直前のアクションでどれだけ消えたか」を出すための記録
const rangeTrack = {
    handKey: null,          // ハンドが変わったら記録を捨てる
    lastRange: null,        // 前回描いたときの相手のレンジ
    lastCpuCount: 0,        // 前回描いたときの相手のアクション数
    before: null,           // 直前の相手のアクションの前のレンジ
    actionLabel: '',        // 直前の相手のアクション
};

function comboCount(name) { return name.length === 2 ? 6 : name.endsWith('s') ? 4 : 12; }

// レンジ（ハンド名 → 重み 0〜1）が全ハンドの何%か
function rangeWidth(range) {
    let n = 0;
    for (const k in range) n += comboCount(k) * Math.max(0, Math.min(1, range[k] || 0));
    return n / 1326 * 100;
}

function renderPanels() {
    if (!currentState) return;
    renderRangePanel(currentState);
    renderTablePanel(currentState);
    requestAnimationFrame(fitPanels);
}

// ---------- 2. 相手のレンジ ----------
function renderRangePanel(st) {
    const box = el('panel-range');
    if (!box) return;
    const range = st.cpuRangeRaw || {};
    const hist = st.history || [];
    const cpuActs = hist.filter(a => a.actor === 'CPU');
    const handKey = (st.heroHand || []).join('') + '|' + st.heroPos;
    if (rangeTrack.handKey !== handKey) {
        Object.assign(rangeTrack, { handKey, lastRange: null, lastCpuCount: 0, before: null, actionLabel: '' });
    }
    // 相手が新しく動いていたら、その前のレンジを「消えた手」の基準にする
    if (rangeTrack.lastRange && cpuActs.length > rangeTrack.lastCpuCount) {
        rangeTrack.before = rangeTrack.lastRange;
        const a = cpuActs[cpuActs.length - 1];
        rangeTrack.actionLabel = (a.action + (a.amount > 0 ? ` ${Number(a.amount).toFixed(1)}bb` : ''));
    }
    rangeTrack.lastRange = range;
    rangeTrack.lastCpuCount = cpuActs.length;

    const before = rangeTrack.before;
    const nowW = rangeWidth(range);
    // 「消えた手」: 直前のアクションで、その手の可能性が何倍になったか（後 ÷ 前）を、一番残った手と比べる。
    // 表示用のレンジは毎回「一番可能性の高い手 = 1」に揃えてあるので、前後の値をそのまま引き算すると
    // 強い手まで消えたように見える（全体の縮め方が変わるため）。比なら揃え方に左右されない
    let maxRatio = 0;
    const ratio = {};
    if (before) {
        for (const k in before) {
            const b = before[k] || 0;
            if (b > 0.02) { ratio[k] = (range[k] || 0) / b; maxRatio = Math.max(maxRatio, ratio[k]); }
        }
    }
    let caption;
    if (before) {
        caption = t('panel.range_after', { act: rangeTrack.actionLabel, from: rangeWidth(before).toFixed(0), to: nowW.toFixed(0) });
    } else {
        caption = t('panel.range_now', { pct: nowW.toFixed(0) });
    }

    let cells = '';
    for (let r1 = 0; r1 < 13; r1++) {
        for (let r2 = 0; r2 < 13; r2++) {
            const name = r1 === r2 ? PANEL_RANKS[r1] + PANEL_RANKS[r2]
                : r1 < r2 ? PANEL_RANKS[r1] + PANEL_RANKS[r2] + 's' : PANEL_RANKS[r2] + PANEL_RANKS[r1] + 'o';
            const w = Math.max(0, Math.min(1, range[name] || 0));
            let cls = 'pr-c', style = '';
            if (before && name in ratio && maxRatio > 0 && ratio[name] / maxRatio < 0.4) {
                cls += ' pr-gone';   // 直前のアクションで消えた（減った）手
            } else if (w > 0.02) {
                style = `background:rgba(16,185,129,${(0.25 + 0.75 * w).toFixed(2)})`;
                cls += ' pr-in';
            }
            cells += `<div class="${cls}" style="${style}">${name}</div>`;
        }
    }
    box.innerHTML = `<div class="panel-title">${t('panel.range_title', { pos: displayCpuPos() })}</div>
        <div class="panel-caption">${caption}</div>
        <div class="pr-grid" onclick="openRangeModal('CPU')">${cells}</div>
        <div class="panel-legend"><span><i class="lg-in"></i>${t('panel.legend_in')}</span>${before ? `<span><i class="lg-gone"></i>${t('panel.legend_gone')}</span>` : ''}<span>${t('panel.tap_grid')}</span></div>`;
}

// 表とテーブルを、スワイプの面の高さに収める（横幅いっぱいだと縦にはみ出す）
function fitPanels() {
    const page = document.querySelector('.swipe-page');
    if (!page) return;
    const H = page.clientHeight, W = page.clientWidth;
    const grid = document.querySelector('#panel-range .pr-grid');
    if (grid) {
        const used = grid.offsetTop - grid.parentElement.offsetTop;
        const legend = document.querySelector('#panel-range .panel-legend');
        const side = Math.max(120, Math.min(W - 4, H - used - (legend ? legend.offsetHeight + 10 : 0) - 8));
        grid.style.width = side + 'px';
        grid.style.margin = '0 auto';
        // マスの大きさに合わせて文字を縮める（小さいときは読める範囲で）
        grid.style.fontSize = Math.max(6, Math.min(11, side / 13 * 0.32)) + 'px';
    }
    const table = document.querySelector('#panel-table .tb-table');
    if (table) table.style.width = Math.max(160, Math.min(W, (H - 16) * 1.25)) + 'px';
}
window.addEventListener('resize', fitPanels);

// ---------- 3. 楕円のテーブル ----------
function streetInvest(st, actor) {
    // このストリートで出した額（プリフロップはブラインドを含む）
    let sum = 0;
    for (const a of (st.history || [])) {
        if (a.street === st.street && a.actor === actor && a.amount > 0) sum += a.amount;
    }
    if (st.street === 'PREFLOP') {
        const pos = actor === 'HERO' ? st.heroPos : displayCpuPos();
        if (pos === 'SB') sum += 0.5;
        if (pos === 'BB') sum += 1.0;
    }
    return sum;
}

function renderTablePanel(st) {
    const box = el('panel-table');
    if (!box) return;
    const heroPos = st.heroPos, cpuPos = displayCpuPos();
    const h = PANEL_SEATS.indexOf(heroPos);
    let seats = '';
    PANEL_SEATS.forEach((pos, i) => {
        // あなたを一番下に置き、時計回りに並べる（楕円上の角度。画面の座標は下向きが正）
        const k = ((i - h) % 6 + 6) % 6;
        const ang = (90 + 60 * k) * Math.PI / 180;
        const x = 50 + 42 * Math.cos(ang), y = 50 + 38 * Math.sin(ang);
        const bx = 50 + 24 * Math.cos(ang), by = 50 + 22 * Math.sin(ang);   // ベット額はテーブルの内側
        const isHero = pos === heroPos, isCpu = pos === cpuPos;
        const who = isHero ? 'You' : isCpu ? 'CPU' : '';
        const stack = isHero ? st.heroStack : isCpu ? st.cpuStack : null;
        let blind = 0;
        if (!isHero && !isCpu && st.street === 'PREFLOP') blind = pos === 'SB' ? 0.5 : pos === 'BB' ? 1.0 : 0;
        const inv = isHero ? streetInvest(st, 'HERO') : isCpu ? streetInvest(st, 'CPU') : blind;
        seats += `<div class="tb-seat ${isHero ? 'is-hero' : isCpu ? 'is-cpu' : 'is-out'}" style="left:${x}%;top:${y}%">
                <div class="tb-pos">${pos}${pos === 'BTN' ? ' <span class="tb-d">D</span>' : ''}</div>
                ${who ? `<div class="tb-who">${who} ${stack !== null ? Number(stack).toFixed(1) : ''}</div>` : ''}
            </div>`;
        if (inv > 0) seats += `<div class="tb-bet" style="left:${bx}%;top:${by}%">${inv.toFixed(1)}</div>`;
    });
    const board = (st.board || []).map(c => {
        const p = parseCardStr(c);
        return p ? `<span class="tb-card ${p.color}">${p.rank}${p.symbol}</span>` : '';
    }).join('');
    box.innerHTML = `<div class="tb-table">
            <div class="tb-felt">
                <div class="tb-center"><div class="tb-board">${board}</div><div class="tb-pot">Pot ${Number(st.potSize).toFixed(1)}bb</div></div>
            </div>
            ${seats}
        </div>`;
}

// ---------- スワイプの目印（●○○） ----------
function initSwipe() {
    const track = el('swipe-track');
    const dots = document.querySelectorAll('.swipe-dot');
    if (!track || !dots.length) return;
    let saved = 0;
    try { saved = Number(localStorage.getItem('poker_panel') || 0); } catch (e) { /* 保存できない環境では最初の面 */ }
    const go = (i, smooth) => track.scrollTo({ left: i * track.clientWidth, behavior: smooth ? 'smooth' : 'auto' });
    let current = 0;
    const mark = () => {
        const i = Math.round(track.scrollLeft / Math.max(1, track.clientWidth));
        if (i === current) return;
        current = i;
        dots.forEach((d, j) => d.classList.toggle('active', j === i));
        try { localStorage.setItem('poker_panel', String(i)); } catch (e) { /* 無視 */ }
    };
    track.addEventListener('scroll', () => requestAnimationFrame(mark), { passive: true });
    dots.forEach((d, j) => d.addEventListener('click', () => go(j, true)));
    // 最後に見た面を開く（描画が終わってから）
    requestAnimationFrame(() => { go(saved, false); current = -1; mark(); });
}

document.addEventListener('DOMContentLoaded', initSwipe);
