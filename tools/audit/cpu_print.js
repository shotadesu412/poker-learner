// cpu_stats.js の出力（複数）を合算して表示。 node cpu_print.js a.json b.json ...
const fs = require('fs');
const C = {};
for (const f of process.argv.slice(2)) {
  const x = JSON.parse(fs.readFileSync(f, 'utf8'));
  for (const [k, v] of Object.entries(x)) { C[k] = C[k] || {}; for (const [o, n] of Object.entries(v)) C[k][o] = (C[k][o] || 0) + n; }
}
for (const k of Object.keys(C).sort()) {
  if (k === 'SUMMARY') continue;
  const n = Object.values(C[k]).reduce((a, b) => a + b, 0);
  console.log(k.padEnd(44), `n=${String(n).padStart(6)}  ` + Object.entries(C[k]).sort().map(([o, v]) => `${o} ${(v / n * 100).toFixed(1)}%`).join(' / '));
}
const s = C.SUMMARY;
console.log(`WTSD（フロップを見たハンドのショーダウン率） ${(s.WTSD / s.flopSeen * 100).toFixed(1)}% / ショーダウンでの CPU 勝率 ${(s.cpuWonSD / s.WTSD * 100).toFixed(1)}%`);
