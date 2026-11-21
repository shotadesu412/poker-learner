// panels.js — 練習画面の中央を、左右スワイプで切り替える3枚にする（2026/11/19〜。2026/11/21 作り直し）
//   上に面の名前（レンジ / アクション履歴 / テーブル）を並べ、今の面を示す。押しても切り替わる
//   0. 推定レンジ（相手 / あなた をタブで切り替え）: 直前のアクションで消えた手を赤く、残っている手を緑の濃さで
//   1. アクション履歴（最初に出す面。#eval-history）
//   2. テーブル: 横長の楕円に 6席・カード・このストリートで出した額・ポット
// スワイプは自前で動かす（translateX）。以前はブラウザの横スクロール（scroll-snap）に任せていたが、iPhone で中身を
// 描き直すたびに位置が合わせ直され、アクションのたびにレンジの面へ戻っていた
// 描画は script.js の updateUI の最後に renderPanels() を呼ぶ
// 依存: script.js（currentState, displayCpuPos, parseCardStr, t, el, openRangeModal）

const PANEL_RANKS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'];
const PANEL_SEATS = ['UTG', 'HJ', 'CO', 'BTN', 'SB', 'BB'];   // 時計回り（次に動く人が左隣）

let panelIndex = 1;            // 今出している面（最初は履歴）。描き直しでは変えない
let rangeSide = 'CPU';         // 推定レンジの面で出す側（'CPU' | 'HERO'）

// 「直前のアクションでどれだけ消えたか」を出すための記録（相手・あなたそれぞれ）
function newTrack() { return { handKey: null, lastRange: null, lastCount: 0, before: null, actionLabel: '' }; }
const rangeTracks = { CPU: newTrack(), HERO: newTrack() };

function comboCount(name) { return name.length === 2 ? 6 : name.endsWith('s') ? 4 : 12; }

// レンジ（ハンド名 → 重み 0〜1）が全ハンドの何%か
function rangeWidth(range) {
    let n = 0;
    for (const k in range) n += comboCount(k) * Math.max(0, Math.min(1, range[k] || 0));
    return n / 1326 * 100;
}

function renderPanels() {
    if (!currentState) return;
    // どちらの面を出していても、両方の記録は毎回進める（切り替えたときに「直前」がずれないように）
    trackRange(currentState, 'CPU');
    trackRange(currentState, 'HERO');
    renderRangePanel(currentState);
    renderTablePanel(currentState);
    requestAnimationFrame(fitPanels);
}

// ---------- 0. 推定レンジ ----------
function trackRange(st, side) {
    const tr = rangeTracks[side];
    const range = (side === 'CPU' ? st.cpuRangeRaw : st.heroRangeRaw) || {};
    const acts = (st.history || []).filter(a => a.actor === side);
    const handKey = (st.heroHand || []).join('') + '|' + st.heroPos;
    if (tr.handKey !== handKey) Object.assign(tr, newTrack(), { handKey });
    // 新しく動いていたら、その前のレンジを「消えた手」の基準にする
    if (tr.lastRange && acts.length > tr.lastCount) {
        tr.before = tr.lastRange;
        const a = acts[acts.length - 1];
        tr.actionLabel = a.action + (a.amount > 0 ? ` ${Number(a.amount).toFixed(1)}bb` : '');
    }
    tr.lastRange = range;
    tr.lastCount = acts.length;
}

function setRangeSide(side) {
    rangeSide = side;
    if (currentState) renderRangePanel(currentState);
    requestAnimationFrame(fitPanels);
}

function renderRangePanel(st) {
    const box = el('panel-range');
    if (!box) return;
    const side = rangeSide;
    const tr = rangeTracks[side];
    const range = (side === 'CPU' ? st.cpuRangeRaw : st.heroRangeRaw) || {};
    const before = tr.before;
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
    if (before && Math.abs(rangeWidth(before) - nowW) >= 0.5) {
        caption = t('panel.range_after', { act: tr.actionLabel, from: rangeWidth(before).toFixed(0), to: nowW.toFixed(0) });
    } else if (before) {
        // 範囲が変わっていないときは「絞られた」と言わない（プリフロップのコールは、最初からその範囲の手が配られている）
        caption = t('panel.range_same', { act: tr.actionLabel, pct: nowW.toFixed(0) });
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
    const title = side === 'CPU'
        ? t('panel.range_title', { pos: displayCpuPos() })
        : t('panel.range_title_hero', { pos: st.heroPos });
    box.innerHTML = `<div class="pr-head">
            <div class="pr-seg">
                <button class="${side === 'CPU' ? 'on' : ''}" onclick="setRangeSide('CPU')">${t('panel.tab_cpu')}</button>
                <button class="${side === 'HERO' ? 'on' : ''}" onclick="setRangeSide('HERO')">${t('panel.tab_hero')}</button>
            </div>
            <div class="panel-title">${title}</div>
        </div>
        <div class="panel-caption">${caption}</div>
        <div class="pr-grid" onclick="openRangeModal('${side}')">${cells}</div>
        <div class="panel-legend"><span><i class="lg-in"></i>${t('panel.legend_in')}</span>${before ? `<span><i class="lg-gone"></i>${t('panel.legend_gone')}</span>` : ''}<span>${t('panel.tap_grid')}</span></div>`;
}

// 表とテーブルを、面の高さに収める（横幅いっぱいだと縦にはみ出す）
function fitPanels() {
    const page = document.querySelector('.swipe-page');
    if (!page) return;
    const H = page.clientHeight, W = page.clientWidth;
    if (!H || !W) return;
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
    if (table) {
        const w = Math.max(200, Math.min(W - 4, (H - 6) * 1.45));
        table.style.width = w + 'px';
        // 席の大きさをテーブルの大きさに合わせる（基準は幅 330px）
        table.style.fontSize = Math.max(8, Math.min(13, w / 330 * 11.5)) + 'px';
    }
}
window.addEventListener('resize', fitPanels);

// ---------- 2. テーブル ----------
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

// このストリートの最後の行動がベット・レイズか（チップの色）
function streetAggressive(st, actor) {
    const acts = (st.history || []).filter(a => a.street === st.street && a.actor === actor);
    const last = acts[acts.length - 1];
    return !!last && (last.action === 'BET' || last.action === 'RAISE' || last.action === 'ALLIN');
}

function tableCard(c) {
    const p = parseCardStr(c);
    return p ? `<span class="tb-card ${p.color}">${p.rank}<small>${p.symbol}</small></span>` : '';
}

function renderTablePanel(st) {
    const box = el('panel-table');
    if (!box) return;
    const heroPos = st.heroPos, cpuPos = displayCpuPos();
    const h = PANEL_SEATS.indexOf(heroPos);
    const heroFolded = (st.history || []).some(a => a.actor === 'HERO' && a.action === 'FOLD');
    const cpuFolded = (st.history || []).some(a => a.actor === 'CPU' && a.action === 'FOLD');
    let seats = '';
    PANEL_SEATS.forEach((pos, i) => {
        // あなたを一番下に置き、時計回りに並べる（横長の楕円。画面の座標は下向きが正）
        const k = ((i - h) % 6 + 6) % 6;
        const ang = (90 + 60 * k) * Math.PI / 180;
        const cx = Math.cos(ang), cy = Math.sin(ang);
        const x = 50 + 41 * cx, y = 50 + 37 * cy;
        const bx = 50 + 31 * cx, by = 50 + 23 * cy;   // ベット額は席とボードの間
        const isHero = pos === heroPos, isCpu = pos === cpuPos;
        const folded = isHero ? heroFolded : isCpu ? cpuFolded : true;
        let blind = 0;
        if (!isHero && !isCpu) blind = pos === 'SB' ? 0.5 : pos === 'BB' ? 1.0 : 0;
        const stack = isHero ? st.heroStack : isCpu ? st.cpuStack : 100 - blind;
        let cards = '';
        if (isHero && !heroFolded) cards = (st.heroHand || []).map(tableCard).join('');
        else if (isCpu && !cpuFolded) cards = (st.cpuHand && st.cpuHand.length) ? st.cpuHand.map(tableCard).join('') : '<span class="tb-back"></span><span class="tb-back"></span>';
        seats += `<div class="tb-seat ${isHero ? 'is-hero' : ''} ${folded ? 'is-out' : ''}" style="left:${x}%;top:${y}%">
                <div class="tb-cards">${cards}</div>
                <div class="tb-box"><div class="tb-pos">${pos}</div><div class="tb-stack">${Number(stack).toFixed(1)}</div></div>
                ${pos === 'BTN' ? '<span class="tb-d">D</span>' : ''}
            </div>`;
        const inv = isHero ? streetInvest(st, 'HERO') : isCpu ? streetInvest(st, 'CPU') : (st.street === 'PREFLOP' ? blind : 0);
        if (inv > 0) {
            const agg = (isHero || isCpu) && streetAggressive(st, isHero ? 'HERO' : 'CPU');
            seats += `<div class="tb-bet" style="left:${bx}%;top:${by}%"><i class="${agg ? 'agg' : ''}"></i>${Number(inv.toFixed(1))}</div>`;
        }
    });
    const board = (st.board || []).map(tableCard).join('');
    box.innerHTML = `<div class="tb-table">
            <div class="tb-felt">
                <div class="tb-center"><div class="tb-board">${board}</div><div class="tb-pot">${Number(Number(st.potSize).toFixed(1))} BB</div></div>
            </div>
            ${seats}
        </div>`;
}

// ---------- スワイプ ----------
function goPanel(i, animate) {
    const track = el('swipe-track');
    if (!track) return;
    panelIndex = Math.max(0, Math.min(2, i));
    track.style.transition = animate === false ? 'none' : 'transform 0.25s ease';
    track.style.transform = `translateX(${-panelIndex * 100 / 3}%)`;
    document.querySelectorAll('.swipe-dot').forEach((d, j) => d.classList.toggle('active', j === panelIndex));
    if (panelIndex !== 1) requestAnimationFrame(fitPanels);
}

function initSwipe() {
    const view = document.querySelector('.swipe-view');
    const track = el('swipe-track');
    if (!view || !track) return;
    document.querySelectorAll('.swipe-dot').forEach((d, j) => d.addEventListener('click', () => goPanel(j)));
    // 履歴が空のときの案内（CSS の ::before で出す）
    const hist = el('eval-history');
    if (hist) hist.dataset.empty = t('panel.history_empty');
    goPanel(panelIndex, false);

    // 横に動かしたときだけスワイプとして扱う（縦は各面の中のスクロール）。CSS の touch-action: pan-y で縦はブラウザに任せる
    let sx = 0, sy = 0, dx = 0, dragging = false, decided = false, pid = null, t0 = 0;
    view.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        sx = e.clientX; sy = e.clientY; dx = 0; dragging = false; decided = false; pid = e.pointerId; t0 = Date.now();
    });
    view.addEventListener('pointermove', (e) => {
        if (pid !== e.pointerId) return;
        const mx = e.clientX - sx, my = e.clientY - sy;
        if (!decided) {
            if (Math.abs(mx) < 8 && Math.abs(my) < 8) return;
            decided = true;
            dragging = Math.abs(mx) > Math.abs(my);
            if (dragging) { try { view.setPointerCapture(pid); } catch (err) { /* 古い環境 */ } track.style.transition = 'none'; }
        }
        if (!dragging) return;
        dx = mx;
        // 端では動きを鈍くする
        if ((panelIndex === 0 && dx > 0) || (panelIndex === 2 && dx < 0)) dx *= 0.3;
        const w = view.clientWidth || 1;
        track.style.transform = `translateX(calc(${-panelIndex * 100 / 3}% + ${dx}px))`;
        if (w) e.preventDefault();
    });
    const end = (e) => {
        if (pid !== e.pointerId) return;
        pid = null;
        if (!dragging) return;
        const w = view.clientWidth || 1;
        const fast = Math.abs(dx) > 30 && Date.now() - t0 < 300;
        let next = panelIndex;
        if (dx < -w * 0.2 || (fast && dx < 0)) next = panelIndex + 1;
        else if (dx > w * 0.2 || (fast && dx > 0)) next = panelIndex - 1;
        goPanel(next);
        // スワイプの後に表を押した扱いにしない
        if (Math.abs(dx) > 8) {
            const block = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
            view.addEventListener('click', block, { capture: true, once: true });
            setTimeout(() => view.removeEventListener('click', block, { capture: true }), 50);
        }
        dragging = false;
    };
    view.addEventListener('pointerup', end);
    view.addEventListener('pointercancel', end);
}

document.addEventListener('DOMContentLoaded', initSwipe);
