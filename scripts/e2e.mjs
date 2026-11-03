// 端到端冒烟测试：在模拟 iPhone 横屏（触摸、DPR 3）的 Chromium 中运行构建产物。
// 用法：npm run build && npm run test:e2e   （需要本机有 Playwright + Chromium）
// 截图输出到 test-results/
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const PORT = 4179;
const OUT = 'test-results';
mkdirSync(OUT, { recursive: true });

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'pipe' });
await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('preview server timeout')), 20000);
  server.stdout.on('data', (d) => {
    if (String(d).includes(String(PORT))) {
      clearTimeout(t);
      resolve();
    }
  });
});

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ' — ' + detail : ''}`);
};

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
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  await page.goto(`http://localhost:${PORT}/`);
  await page.waitForFunction(() => window.__game?.store.get().phase === 'title', null, { timeout: 30000 });
  check('加载：Rapier 初始化完成并进入标题', true);
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/01-title.png` });

  await page.tap('[data-testid=start]');
  await page.waitForFunction(() => window.__game.store.get().phase === 'aim');
  check('开始：进入发射准备', true);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/02-aim.png` });

  // 用 CDP 发送真实的触摸事件：按住拉绳 → 向下拉 + 右偏 → 松手
  const cdp = await context.newCDPSession(page);
  const pad = await page.locator('[data-testid=launcher-pad]').boundingBox();
  const x0 = pad.x + pad.width / 2;
  const y0 = pad.y + 30;
  const touch = (type, x, y) =>
    cdp.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }] });
  await touch('touchStart', x0, y0);
  for (let i = 1; i <= 8; i++) {
    await touch('touchMove', x0 + i * 4, y0 + i * 8);
    await page.waitForTimeout(30);
  }
  const midPull = await page.evaluate(() => window.__game.store.get().pull);
  await page.screenshot({ path: `${OUT}/03-pulling.png` });
  check('拉绳：触摸拖动被识别', midPull.active && midPull.pull > 0.2, `pull=${midPull.pull.toFixed(2)} aim=${midPull.aim.toFixed(2)}`);
  for (let i = 9; i <= 14; i++) {
    await touch('touchMove', x0 + i * 4, y0 + i * 18);
    await page.waitForTimeout(16);
  }
  await touch('touchEnd', 0, 0);
  await page.waitForFunction(() => window.__game.store.get().phase === 'battle', null, { timeout: 3000 });
  check('松手发射：进入战斗', true);

  // 战斗中物理推进、刚体运动
  const s0 = await page.evaluate(() => window.__game.debugState());
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/04-battle.png` });
  const s1 = await page.evaluate(() => window.__game.debugState());
  const moved = Math.hypot(s1.player.x - s0.player.x, s1.player.z - s0.player.z);
  check('物理：陀螺刚体在运动', moved > 0.3 && s1.time > s0.time, `位移 ${moved.toFixed(2)}，转速 ${s1.player.spin.toFixed(0)} rad/s`);
  check('物理：陀螺落在场地上（没有穿模掉落）', s1.player.y > -0.2 && s1.rival.y > -0.2, `y=${s1.player.y.toFixed(2)}/${s1.rival.y.toFixed(2)}`);

  // 暂停：物理时间不再前进
  await page.tap('[data-testid=pause]');
  const p0 = await page.evaluate(() => window.__game.debugState().time);
  await page.waitForTimeout(700);
  const p1 = await page.evaluate(() => window.__game.debugState().time);
  await page.screenshot({ path: `${OUT}/05-paused.png` });
  check('暂停：物理冻结', p0 === p1, `t=${p0.toFixed(2)}`);
  await page.tap('[data-testid=resume]');
  await page.waitForTimeout(600);
  const p2 = await page.evaluate(() => window.__game.debugState().time);
  check('继续：物理恢复', p2 > p1, `t=${p2.toFixed(2)}`);

  // 快进物理直到胜负（无头 Chromium 用软件 GPU，实时跑太慢）
  await page.evaluate(() => window.__game.debugFastForward(150));
  await page.waitForFunction(() => window.__game.store.get().phase === 'result', null, { timeout: 10000 }).catch(() => {});
  const end = await page.evaluate(() => window.__game.debugState());
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/06-result.png` });
  check('胜负判定：出现结算', !!end.result, end.result ? `${end.result.winner} ${end.result.finish} ${end.result.duration.toFixed(1)}s 撞击 ${end.hits}` : '超时');

  // 重新开始
  await page.tap('[data-testid=again]').catch(() => page.evaluate(() => window.__game.restart()));
  await page.waitForFunction(() => window.__game.store.get().phase === 'aim');
  const r = await page.evaluate(() => window.__game.debugState());
  check('重新开始：回到发射准备，物理世界已重置', r.player === null && r.time === 0);

  // 竖屏布局
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}/07-portrait.png` });
  check('竖屏：显示横屏提示', await page.locator('.rotate-hint').isVisible());

  check('控制台无报错', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  server.kill();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
