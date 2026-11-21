"""新しい UI（static/v2/。開発者モードで開く画面）を、サーバー無しで触れる確認用ページにまとめる（2026/11/21〜）。

    python3 tools/preview/build_preview.py <出力フォルダ>

出力フォルダに page.html（確認用ページ本体）と static/ 一式を書き出す。Claude の Artifact として公開すると、
iPhone の Safari からそのまま触れる（ゲーム・判定・分析・スワイプはすべて端末の中で動く）。
- AIコーチだけはサーバーが要るので動かない
- 統計は確認用ページ専用の保存場所に溜まる（本番アプリの統計とは別）
- 公開先の決まり（Artifact）に合わせて、<html><head><body> を外し、/static/ への絶対パスを相対パスにする
"""
import os
import re
import shutil
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
STATIC = os.path.join(ROOT, 'static')

FILES = ['style.css', 'i18n.js', 'game_api.js']                                   # 今の画面と共通
V2_FILES = ['stats.css', 'tabs.css', 'stats.js', 'script.js', 'panels.js']          # 新しい画面の部品（static/v2/）


def main(out):
    os.makedirs(os.path.join(out, 'static', 'poker'), exist_ok=True)
    os.makedirs(os.path.join(out, 'static', 'v2'), exist_ok=True)
    for f in FILES:
        shutil.copy(os.path.join(STATIC, f), os.path.join(out, 'static', f))
    for f in V2_FILES:
        shutil.copy(os.path.join(STATIC, 'v2', f), os.path.join(out, 'static', 'v2', f))
    for f in os.listdir(os.path.join(STATIC, 'poker')):
        if f.endswith('.js') or f.endswith('.json'):
            shutil.copy(os.path.join(STATIC, 'poker', f), os.path.join(out, 'static', 'poker', f))

    # エンジンの読み込み先を相対パスに
    p = os.path.join(out, 'static', 'game_api.js')
    s = open(p, encoding='utf-8').read()
    s = s.replace('`/static/poker/', '`static/poker/')
    open(p, 'w', encoding='utf-8').write(s)

    html = open(os.path.join(STATIC, 'v2', 'index.html'), encoding='utf-8').read()
    head = html[html.index('<head>') + len('<head>'):html.index('</head>')]
    body = html[html.index('<body'):html.index('</body>')]
    body = body[body.index('>') + 1:]
    links = re.findall(r'<link rel="stylesheet"[^>]*>', head)
    scripts_head = re.findall(r'<script src="[^"]*"></script>', head)   # 開発者モードの振り分け（inline）は含めない
    # 確認用と分かるように上の見出しを差し替える（i18n で上書きされないよう data-i18n を外す）
    body = body.replace('<span class="top-nav-title" data-i18n="app.name">ポーカーラッシュ</span>',
                        '<span class="top-nav-title">新UI 確認用</span>')
    page = '\n'.join([
        '<title>ポーカーラッシュ 新UI</title>',
        '<style>',
        '  /* アプリは暗い配色だけ。公開先の枠（上下の余白）の中に画面の高さで収める */',
        '  :root { color-scheme: dark; background: #1a1e1b; }',
        '  html, body { height: 100%; }',
        '  body { height: 100% !important; min-height: 0 !important; }',
        '</style>',
        *links,
        *scripts_head,
        body.strip(),
    ])
    page = page.replace('"/static/', '"static/')
    open(os.path.join(out, 'page.html'), 'w', encoding='utf-8').write(page + '\n')
    print('書き出し:', out)


if __name__ == '__main__':
    main(sys.argv[1])
