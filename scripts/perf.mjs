// 主循环性能剖析：同一场景下分别测各画质档的分段 CPU 耗时、绘制调用、内存分配和 GC。
// 用法：node scripts/perf.mjs <构建目录> <标签>    例：node scripts/perf.mjs dist-before before
// 计时用页面内包装函数实现（不依赖新版本的调试接口），新旧两个构建用完全相同的方法测量。
// 输出 test-results/perf/<标签>.json
//
// 注意：本机没有 GPU，Chromium 用 SwiftShader 软件渲染，“渲染提交”与帧间隔远慢于 iPhone；
// 物理 / 特效 / 镜头 / 同步这些 CPU 段落与分配量才有参考意义。
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const [dir = 'dist', label = 'after'] = process.argv.slice(2);
const PORT = 4182;
const OUT = 'test-results/perf';
const DPR = Number(process.env.PERF_DPR ?? 3);
const SECONDS = Number(process.env.PERF_SECONDS ?? 6);
mkdirSync(OUT, { recursive: true });

const server = spawn('npx', ['vite', 'preview', '--outDir', dir, '--port', String(PORT), '--strictPort'], {
  stdio: 'pipe',
  detached: true,
});
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('preview server timeout')), 20000);
  server.stdout.on('data', (d) => {
    if (String(d).includes(String(PORT))) {
      clearTimeout(t);
      resolve();
    }
  });
});

const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-precise-memory-info'],
});
const report = { label, dpr: DPR, seconds: SECONDS, tiers: {} };
try {
  for (const tier of (process.env.PERF_TIERS ?? 'low,medium,high,ultra').split(',')) {
    const context = await browser.newContext({
      viewport: { width: Number(process.env.PERF_W ?? 844), height: Number(process.env.PERF_H ?? 390) },
      deviceScaleFactor: DPR,
      isMobile: true,
      hasTouch: true,
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
    });
    const page = await context.newPage();
    page.setDefaultTimeout(180000);
    await page.goto(`http://localhost:${PORT}/`);
    await page.waitForFunction(() => window.__game?.store.get().phase === 'title', null, { timeout: 60000 });
    await page.evaluate((t) => window.__game.setQuality(t), tier);
    await page.evaluate(() => window.__game.start());
    await page.waitForFunction(() => window.__game.store.get().phase === 'aim');
    await page.evaluate(() => window.__game.launch({ power: 0.85, aim: 0, tilt: 0 }));
    await page.waitForFunction(() => window.__game.store.get().phase === 'battle');
    await page.waitForTimeout(1500);

    // 包装主循环各段落计时（新旧版本通用）
    await page.evaluate(() => {
      const g = window.__game;
      const acc = { frames: 0, physics: 0, steps: 0, fx: 0, cam: 0, render: 0, frame: 0, intervals: [], impacts: 0 };
      window.__perfAcc = acc;
      const wrap = (obj, name, key, onRet) => {
        const orig = obj[name].bind(obj);
        obj[name] = (...a) => {
          const t = performance.now();
          const r = orig(...a);
          acc[key] += performance.now() - t;
          onRet?.(r);
          return r;
        };
      };
      wrap(g.pw, 'advance', 'physics', (n) => (acc.steps += n || 0));
      wrap(g.fx, 'update', 'fx');
      wrap(g.cam, 'update', 'cam');
      wrap(g.renderer, 'render', 'render');
      let last = 0;
      const raf = (t) => {
        if (last) acc.intervals.push(t - last);
        last = t;
        if (!window.__perfStop) requestAnimationFrame(raf);
      };
      requestAnimationFrame(raf);
      const origRender = g.renderer.render;
      g.renderer.render = (...a) => {
        acc.frames++;
        return origRender(...a);
      };
    });

    // 内存分配采样（包括已被回收的对象 → 近似为分配总量）
    const cdp = await context.newCDPSession(page);
    await cdp.send('HeapProfiler.enable');
    await cdp.send('HeapProfiler.collectGarbage');
    const HEAP = process.env.PERF_HEAP !== '0';
    if (HEAP) await cdp.send('HeapProfiler.startSampling', {
      samplingInterval: 4096,
      includeObjectsCollectedByMajorGC: true,
      includeObjectsCollectedByMinorGC: true,
    });
    const heap0 = await page.evaluate(() => performance.memory?.usedJSHeapSize ?? 0);

    // 测量窗口：前半段自由对战，后半段每 0.5 秒触发一次猛撞特效（满粒子负载）
    const t0 = Date.now();
    await page.waitForTimeout((SECONDS * 1000) / 2);
    // PERF_FX=0：不触发猛撞特效（P2.2 的猛撞带慢动作，会让每帧物理步数大幅减少，和无慢动作版本不可直接比）
    const fxTimer = await page.evaluate((on) => {
      return on ? setInterval(() => window.__game.debugImpact(0.95), 500) : 0;
    }, process.env.PERF_FX !== '0');
    await page.waitForTimeout((SECONDS * 1000) / 2);
    await page.evaluate((id) => clearInterval(id), fxTimer);
    const wall = (Date.now() - t0) / 1000;

    let allocated = 0;
    if (HEAP) {
      const profile = await cdp.send('HeapProfiler.stopSampling');
      const walk = (n) => {
        allocated += n.selfSize;
        n.children.forEach(walk);
      };
      walk(profile.profile.head);
      if (process.env.PERF_TOP) {
        // 按函数汇总分配量，找出主要分配来源
        const by = new Map();
        const walk2 = (n, stack) => {
          const name = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber}`;
          if (n.selfSize) by.set(name, (by.get(name) ?? 0) + n.selfSize);
          n.children.forEach((c) => walk2(c, stack));
        };
        walk2(profile.profile.head);
        const top = [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
        for (const [k, v] of top) console.log('  alloc', (v / 1024).toFixed(0).padStart(7), 'KB', k);
      }
    }

    const res = await page.evaluate(() => {
      window.__perfStop = true;
      const a = window.__perfAcc;
      const g = window.__game;
      const iv = a.intervals.slice().sort((x, y) => x - y);
      const q = (k) => iv[Math.min(iv.length - 1, Math.floor(iv.length * k))] ?? 0;
      const n = Math.max(1, a.frames);
      const d = g.debugState();
      return {
        frames: a.frames,
        physicsMs: a.physics / n,
        physStepsPerFrame: a.steps / n,
        fxMs: a.fx / n,
        camMs: a.cam / n,
        renderSubmitMs: a.render / n,
        intervalP50: q(0.5),
        intervalP95: q(0.95),
        calls: g.renderer.info.render.calls,
        triangles: g.renderer.info.render.triangles,
        pixelRatio: d.pixelRatio,
        quality: d.quality,
        heapMB: (performance.memory?.usedJSHeapSize ?? 0) / 1048576,
      };
    });
    const heap1 = res.heapMB * 1048576;
    report.tiers[tier] = {
      ...res,
      wallSeconds: wall,
      allocatedKBPerSecond: allocated / 1024 / wall,
      allocatedKBPerFrame: allocated / 1024 / Math.max(1, res.frames),
      heapGrowthKB: (heap1 - heap0) / 1024,
    };
    console.log(label, tier, JSON.stringify(report.tiers[tier]));
    await context.close();
  }
} finally {
  await browser.close();
  try {
    process.kill(-server.pid);
  } catch {
    server.kill();
  }
}
writeFileSync(`${OUT}/${label}.json`, JSON.stringify(report, null, 1));
