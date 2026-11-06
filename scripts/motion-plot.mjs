// 轨迹对比图：node scripts/motion-plot.mjs out.png base.json new.json AvD#1 BvB#0 ...
// 每个场景一列：上 = 基线，下 = 新版本。红 = 玩家，蓝 = 对手，黄点 = 接触，颜色由浅到深表示时间。
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const [outPng, baseF, newF, ...names] = process.argv.slice(2);
const load = (f) => Object.values(JSON.parse(readFileSync(f, 'utf8'))).flat();
const sets = [
  ['基线 0dac2ad', load(baseF)],
  ['新版本', load(newF)],
];
const R = 5.4;
const S = 300;
const sc = (v) => ((v + R) / (2 * R)) * (S - 20) + 10;
const SECONDS = Number(process.env.PLOT_SECONDS ?? 12);

function panel(run, label) {
  if (!run?.trace) return `<text x="10" y="20">无轨迹</text>`;
  const tr = run.trace.filter((p) => p[0] <= SECONDS);
  let s = `<circle cx="${S / 2}" cy="${S / 2}" r="${S / 2 - 10}" fill="#f4f6fa" stroke="#9aa3b2"/>`;
  s += `<circle cx="${S / 2}" cy="${S / 2}" r="${((S - 20) / 2) * (4.75 / R)}" fill="none" stroke="#d5dae3" stroke-dasharray="3 3"/>`;
  for (const [ix, iz, col] of [
    [1, 2, '220,40,40'],
    [3, 4, '30,90,230'],
  ]) {
    for (let k = 1; k < tr.length; k++) {
      const a = 0.25 + 0.75 * (k / tr.length);
      s += `<line x1="${sc(tr[k - 1][ix]).toFixed(1)}" y1="${sc(tr[k - 1][iz]).toFixed(1)}" x2="${sc(tr[k][ix]).toFixed(1)}" y2="${sc(tr[k][iz]).toFixed(1)}" stroke="rgba(${col},${a.toFixed(2)})" stroke-width="1.6"/>`;
    }
  }
  for (const p of tr) if (p[7]) s += `<circle cx="${sc((p[1] + p[3]) / 2).toFixed(1)}" cy="${sc((p[2] + p[4]) / 2).toFixed(1)}" r="2.2" fill="#f0b400"/>`;
  s += `<text x="8" y="16" font-size="12" font-family="sans-serif">${label}｜${run.name}｜前 ${SECONDS} 秒｜${run.result}</text>`;
  return s;
}

let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${names.length * S}" height="${2 * S}" style="background:#fff">`;
names.forEach((n, i) => {
  sets.forEach(([label, runs], j) => {
    svg += `<g transform="translate(${i * S},${j * S})">${panel(runs.find((r) => r.name === n), label)}</g>`;
  });
});
svg += '</svg>';
writeFileSync(outPng.replace(/\.png$/, '.svg'), svg);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: names.length * S, height: 2 * S }, deviceScaleFactor: 2 });
await page.setContent(`<html><body style="margin:0">${svg}</body></html>`);
await page.screenshot({ path: outPng });
await browser.close();
