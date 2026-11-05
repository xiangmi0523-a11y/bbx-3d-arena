// Stage 0：诊断开销对比（桌面 Chromium，软件渲染）。
// 同一台机器、同一脚本、交替运行三种变体，比较游戏自带分段计时（两个构建都有的 debugPerf）
// 与 CDP 主线程耗时（Performance.getMetrics：TaskDuration / ScriptDuration，按渲染帧折算）：
//   base      = 基线构建（d8fece1，无诊断代码）
//   diag-idle = 诊断构建，未开始记录
//   diag-rec  = 诊断构建，正在记录
// 用法：node scripts/diag-overhead.mjs <基线dist> <诊断dist> [输出json]
// 环境变量：OVH_W / OVH_H（视口，默认 844×390）、OVH_SECONDS（每轮秒数，默认 30）、OVH_REPS（轮数，默认 3）、OVH_DPR（默认 1）、OVH_QUALITY（默认 low，锁定档位避免自动降档干扰对比）
// 注意：本机无 GPU，帧率远低于 iPhone，只能看“相对差异”，不能当真机性能。
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const [baseDir = 'dist-base', diagDir = 'dist-diag', out = 'test-results/diag-overhead.json'] = process.argv.slice(2);
const SECONDS = Number(process.env.OVH_SECONDS ?? 30);
const REPS = Number(process.env.OVH_REPS ?? 3);
const DPR = Number(process.env.OVH_DPR ?? 1);
const QUALITY = process.env.OVH_QUALITY ?? 'low';

async function serve(dir, port) {
  const p = spawn('npx', ['vite', 'preview', '--outDir', dir, '--port', String(port), '--strictPort'], { stdio: 'pipe', detached: true });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('preview timeout ' + dir)), 20000);
    p.stdout.on('data', (d) => String(d).includes(String(port)) && (clearTimeout(t), resolve()));
  });
  return p;
}

const servers = [await serve(baseDir, 4191), await serve(diagDir, 4192)];
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });

async function run(variant) {
  const port = variant === 'base' ? 4191 : 4192;
  const context = await browser.newContext({ viewport: { width: Number(process.env.OVH_W ?? 844), height: Number(process.env.OVH_H ?? 390) }, deviceScaleFactor: DPR, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  page.setDefaultTimeout(120000);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://localhost:${port}/`);
  await page.waitForFunction(() => window.__game?.store.get().phase === 'title', null, { timeout: 60000 });
  await page.evaluate((q) => {
    const g = window.__game;
    g.setQuality(q);
    // 与诊断面板“自动对战”相同的公开指令序列；三种变体都用这段脚本驱动，保证负载一致
    let since = 0;
    window.__auto = setInterval(() => {
      const ph = g.store.get().phase;
      if (ph === 'title') g.start();
      else if (ph === 'aim') g.launch({ power: 0.85, aim: 0, tilt: 0 });
      else if (ph === 'result') {
        if (!since) since = performance.now();
        else if (performance.now() - since > 2500) (since = 0), g.restart();
      }
      if (ph !== 'result') since = 0;
    }, 300);
  }, QUALITY);
  await page.waitForFunction(() => window.__game.store.get().phase === 'battle');
  if (variant === 'diag-rec') {
    await page.click('[data-testid=diag-open]');
    await page.click('[data-testid=diag-start]');
    await page.waitForSelector('[data-testid=diag-rec]');
  }
  await page.waitForTimeout(1500);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  const m = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]));
  await page.evaluate(() => window.__game.debugPerf(true));
  const m0 = await m();
  await page.waitForTimeout(SECONDS * 1000);
  const m1 = await m();
  const perf = await page.evaluate(() => window.__game.debugPerf(true));
  let diag = null;
  if (variant === 'diag-rec') {
    await page.click('[data-testid=diag-rec]');
    await page.click('[data-testid=diag-stop]');
    await page.waitForSelector('[data-testid=diag-summary]');
    diag = await page.evaluate(() => document.querySelector('[data-testid=diag-summary]').textContent);
  }
  await context.close();
  const frames = Math.max(1, perf.frames);
  return {
    variant,
    frames: perf.frames,
    fps: perf.frames / SECONDS,
    intervalP50: perf.intervalP50,
    intervalP95: perf.intervalP95,
    tickMs: perf.tickMs,
    physicsMs: perf.physicsMs,
    renderSubmitMs: perf.renderSubmitMs,
    maxFrameMs: perf.maxFrameMs,
    mainThreadTaskMsPerFrame: ((m1.TaskDuration - m0.TaskDuration) * 1000) / frames,
    scriptMsPerFrame: ((m1.ScriptDuration - m0.ScriptDuration) * 1000) / frames,
    jsHeapMB: m1.JSHeapUsedSize / 1048576,
    errors,
    diagSummaryText: diag,
  };
}

const rows = [];
try {
  for (let r = 0; r < REPS; r++) {
    for (const v of ['base', 'diag-idle', 'diag-rec']) {
      const res = await run(v);
      rows.push({ rep: r, ...res });
      console.log(JSON.stringify({ rep: r, ...res, diagSummaryText: res.diagSummaryText ? '[…]' : null }));
    }
  }
} finally {
  await browser.close();
  for (const s of servers) {
    try {
      process.kill(-s.pid);
    } catch {
      s.kill();
    }
  }
}

const keys = ['fps', 'intervalP50', 'intervalP95', 'tickMs', 'physicsMs', 'renderSubmitMs', 'mainThreadTaskMsPerFrame', 'scriptMsPerFrame', 'jsHeapMB'];
const mean = (v, k) => rows.filter((r) => r.variant === v).reduce((a, r) => a + r[k], 0) / REPS;
const summary = {};
for (const v of ['base', 'diag-idle', 'diag-rec']) summary[v] = Object.fromEntries(keys.map((k) => [k, mean(v, k)]));
console.table(summary);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify({ seconds: SECONDS, reps: REPS, dpr: DPR, quality: QUALITY, summary, rows }, null, 1));
