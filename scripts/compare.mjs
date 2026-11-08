// 修改前后对比截图：同一场景、同一 iPhone 横屏 3x 视口，分别对两个构建产物截图。
// 用法：node scripts/compare.mjs <构建目录> <输出前缀>
//   例：node scripts/compare.mjs dist-before before && node scripts/compare.mjs dist after
// 输出到 test-results/compare/
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const [dir = 'dist', prefix = 'after'] = process.argv.slice(2);
const PORT = 4181;
const OUT = 'test-results/compare';
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

const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const context = await browser.newContext({
    viewport: { width: 844, height: 390 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(120000);
  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForFunction(() => window.__game?.store.get().phase === 'title', null, { timeout: 60000 });
  // 两个版本都锁定在“高清”档（真机默认档位）对比
  await page.evaluate(() => window.__game.setQuality('high'));
  await page.evaluate(() => window.__game.start());
  await page.waitForFunction(() => window.__game.store.get().phase === 'aim');
  await page.waitForTimeout(2500);
  await page.addStyleTag({ content: '.modal{display:none!important}' });

  // 陀螺在屏幕上的位置（用于裁剪特写）
  const beyClip = (side, half = 70) =>
    page.evaluate(
      ({ side, half }) => {
        const g = window.__game;
        const root = g.visuals[side].root;
        const p = root.getWorldPosition(root.position.clone());
        p.project(g.cam.camera);
        const x = ((p.x + 1) / 2) * innerWidth;
        const y = ((1 - p.y) / 2) * innerHeight;
        return {
          x: Math.max(0, Math.min(innerWidth - half * 2, x - half)),
          y: Math.max(0, Math.min(innerHeight - half * 2, y - half * 1.2)),
          width: half * 2,
          height: half * 2,
        };
      },
      { side, half },
    );

  const info = await page.evaluate(() => {
    const d = window.__game.debugState();
    const c = window.__game.renderer.domElement;
    return { pixelRatio: d.pixelRatio, w: c.width, h: c.height, css: c.getBoundingClientRect().width };
  });
  console.log(prefix, JSON.stringify(info));

  await page.screenshot({ path: `${OUT}/${prefix}-1-aim.png` });
  await page.screenshot({ path: `${OUT}/${prefix}-2-aim-bey-closeup.png`, clip: await beyClip('player', 60) });

  await page.evaluate(() => window.__game.launch({ power: 0.85, aim: 0, tilt: 0 }));
  await page.waitForFunction(() => window.__game.store.get().phase === 'battle');
  await page.waitForTimeout(1500);
  await page.evaluate(() => window.__game.pause());
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/${prefix}-3-battle-spinning.png` });
  await page.screenshot({ path: `${OUT}/${prefix}-4-battle-bey-closeup.png`, clip: await beyClip('player', 55) });
  await page.evaluate(() => window.__game.resume());

  // 三种力度的撞击（相同位置）：0.15 / 0.45 / 0.95
  for (const [name, s] of [
    ['light', 0.15],
    ['medium', 0.45],
    ['heavy', 0.95],
  ]) {
    await page.waitForTimeout(2600);
    await page.evaluate((x) => window.__game.debugImpact(x), s);
    await page.waitForTimeout(140);
    await page.evaluate(() => window.__game.pause());
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/${prefix}-5-impact-${name}.png` });
    // 稍后再截一张，看火花喷射距离和拖尾
    await page.evaluate(() => window.__game.resume());
    await page.waitForTimeout(260);
    await page.evaluate(() => window.__game.pause());
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/${prefix}-6-impact-${name}-later.png` });
    await page.evaluate(() => window.__game.resume());
  }
} finally {
  await browser.close();
  try {
    process.kill(-server.pid);
  } catch {
    server.kill();
  }
}
