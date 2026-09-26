// 評価コメント等の多言語文言（i18n.py の t() の JS 移植）。
// データは messages.json を Python と共有する（AIコーチ用などサーバー専用の文言は含まない）。
//
// 書式は Python の str.format と同じ意味で解釈する:
//   {name}      … 文字列をそのまま。数値を渡すとエラー（Python の 5 と 5.0 を JS では区別できないため）
//   {name:.1f}  … Python と同じ偶数丸めで小数1桁
// 未定義キーはキー名を返し、引数が足りなければ書式化せずに原文を返す（Python と同じ）。
//
// 読み込み: ブラウザは await Messages.load()、Node は require した時点で読み込み済み。
// 依存: pyfmt.js

(function (root) {
  if (typeof module !== 'undefined') require('./pyfmt.js');

  const DEFAULT_LANG = 'ja';
  const SUPPORTED = ['ja', 'en'];

  const Messages = {
    table: null,
    lang: null,

    _init(obj) { this.table = obj; return this; },

    async load(url = '/static/poker/messages.json') {
      if (this.table) return this;
      const res = await fetch(url);
      if (!res.ok) throw new Error('messages.json の読み込みに失敗: ' + res.status);
      return this._init(await res.json());
    },

    // 言語はフロントの i18n.js（getLang）に合わせる。テスト等では setLang で固定できる
    setLang(lang) {
      const l = String(lang || DEFAULT_LANG).toLowerCase().split('-')[0];
      this.lang = SUPPORTED.includes(l) ? l : DEFAULT_LANG;
      return this.lang;
    },
    getLang() {
      if (this.lang) return this.lang;
      if (typeof root.getLang === 'function') return this.setLang(root.getLang());
      return DEFAULT_LANG;
    },

    t(key, kwargs) {
      const entry = this.table[key];
      if (entry === undefined) return key;
      const text = entry[this.getLang()] || entry[DEFAULT_LANG];
      if (!kwargs || Object.keys(kwargs).length === 0) return text;
      let missing = false;
      const out = text.replace(/\{(\w+)(?::([^{}]*))?\}/g, (m, name, spec) => {
        if (!(name in kwargs)) { missing = true; return m; }
        const v = kwargs[name];
        if (spec === undefined || spec === '') {
          if (typeof v !== 'string') throw new Error(`t(${key}): {${name}} に文字列以外が渡された`);
          return v;
        }
        const f = /^\.(\d+)f$/.exec(spec);
        if (!f) throw new Error(`t(${key}): 未対応の書式 {${name}:${spec}}`);
        return root.Py.formatFixed(v, Number(f[1]));
      });
      return missing ? text : out;
    },
  };

  if (typeof module !== 'undefined') {
    Messages._init(JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'messages.json'), 'utf8')));
    module.exports = Messages;
  }
  root.Messages = Messages;
})(typeof window !== 'undefined' ? window : globalThis);
