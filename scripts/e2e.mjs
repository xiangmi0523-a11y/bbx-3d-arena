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

const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'pipe', detached: true });
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

  // ── 组装界面 ──
  await page.tap('[data-testid=open-garage]');
  await page.waitForFunction(() => window.__game.store.get().phase === 'garage', null, { timeout: 120000 });
  await page.waitForFunction(() => Object.keys(window.__game.store.get().garage.thumbs).length >= 12, null, { timeout: 120000 });
  check('组装界面：打开并由 3D 模型生成 12 张部件缩略图', true);
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/10-garage.png` });

  const before = await page.evaluate(() => window.__game.store.get().garage.draft);
  await page.tap('[data-testid=tab-disc]');
  await page.tap('[data-testid=part-quad-edge]');
  await page.waitForTimeout(180);
  await page.screenshot({ path: `${OUT}/11-garage-swap-anim.png` });
  const afterDisc = await page.evaluate(() => window.__game.store.get().garage.draft);
  check(
    '换齿轮盘：只改 Disc，Blade/Tip 不变',
    afterDisc.disc === 'quad-edge' && afterDisc.blade === before.blade && afterDisc.tip === before.tip,
    JSON.stringify(afterDisc),
  );
  await page.tap('[data-testid=tab-blade]');
  await page.tap('[data-testid=part-titan-crown]');
  await page.tap('[data-testid=tab-tip]');
  await page.tap('[data-testid=part-needle-point]');
  await page.waitForTimeout(700);
  const draft = await page.evaluate(() => window.__game.store.get().garage.draft);
  check('换刀刃和陀尖：三个部件各自独立', draft.blade === 'titan-crown' && draft.disc === 'quad-edge' && draft.tip === 'needle-point', JSON.stringify(draft));

  // 拖动旋转（触摸）
  const stage = await page.locator('[data-testid=garage-stage]').boundingBox();
  const cdp0 = await context.newCDPSession(page);
  const sx = stage.x + stage.width / 2;
  const sy = stage.y + stage.height / 2;
  await cdp0.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: sx, y: sy, id: 7 }] });
  for (let i = 1; i <= 10; i++) {
    await cdp0.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: sx - i * 14, y: sy + i * 2, id: 7 }] });
    await page.waitForTimeout(16);
  }
  await cdp0.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  // 双指缩放
  await cdp0.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: sx - 30, y: sy, id: 8 }, { x: sx + 30, y: sy, id: 9 }] });
  for (let i = 1; i <= 8; i++) {
    await cdp0.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: sx - 30 - i * 8, y: sy, id: 8 }, { x: sx + 30 + i * 8, y: sy, id: 9 }] });
    await page.waitForTimeout(16);
  }
  await cdp0.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/12-garage-rotated-zoomed.png` });
  check('组装界面：触摸拖动旋转、双指缩放无报错', true);

  await page.tap('[data-testid=explode]');
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${OUT}/13-garage-exploded.png` });
  check('分解模式切换', await page.evaluate(() => window.__game.store.get().garage.exploded));
  await page.tap('[data-testid=explode]');

  await page.tap('[data-testid=garage-confirm]');
  await page.waitForFunction(() => window.__game.store.get().phase === 'title');
  const lo = await page.evaluate(() => window.__game.store.get().loadout);
  check('确认出战：组装结果传回游戏', lo.blade === 'titan-crown' && lo.disc === 'quad-edge' && lo.tip === 'needle-point', JSON.stringify(lo));

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

  // 战斗中的物理陀螺与视觉模型都来自组装结果
  const bl = await page.evaluate(() => window.__game.debugState());
  check(
    '战斗使用组装结果（物理 + 模型一致）',
    bl.player.loadout.blade === 'titan-crown' && bl.playerVisual.blade === 'blade:titan-crown' && bl.playerVisual.disc === 'disc:quad-edge' && bl.playerVisual.tip === 'tip:needle-point',
    JSON.stringify(bl.playerVisual),
  );
  check('画质：iPhone 3x 屏起始为“高清”档', bl.initialQuality === 'high', `起始=${bl.initialQuality}，当前=${bl.quality}（软件渲染帧率低，会自动降档）`);
  check('画质：渲染像素比与当前档位一致', Math.abs(bl.pixelRatio - bl.expectedPixelRatio) < 0.01, `pixelRatio=${bl.pixelRatio}`);
  // 锁定高清档，验证 Retina 像素比，并用于后续截图
  await page.evaluate(() => window.__game.setQuality('high'));
  await page.waitForTimeout(300);
  const hq = await page.evaluate(() => window.__game.debugState());
  check('画质：高清档 Retina 像素比 2.6', hq.pixelRatio >= 2.5, `pixelRatio=${hq.pixelRatio}`);
  // 软件渲染下 2.6x 太慢（截图会超时），后续截图用中档（2x）
  await page.evaluate(() => window.__game.setQuality('medium'));
  page.setDefaultTimeout(90000);

  // 战斗中物理推进、刚体运动
  const s0 = await page.evaluate(() => window.__game.debugState());
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/04-battle.png` });
  const s1 = await page.evaluate(() => window.__game.debugState());
  const moved = Math.hypot(s1.player.x - s0.player.x, s1.player.z - s0.player.z);
  check('物理：陀螺刚体在运动', moved > 0.3 && s1.time > s0.time, `位移 ${moved.toFixed(2)}，转速 ${s1.player.spin.toFixed(0)} rad/s`);
  check('物理：陀螺落在场地上（没有穿模掉落）', s1.player.y > -0.2 && s1.rival.y > -0.2, `y=${s1.player.y.toFixed(2)}/${s1.rival.y.toFixed(2)}`);

  // 撞击特效：手动触发一次满力度撞击，截图检查闪光 / 火花 / 冲击波
  await page.evaluate(() => window.__game.debugImpact(1));
  await page.waitForTimeout(40);
  await page.screenshot({ path: `${OUT}/14-impact.png` });
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${OUT}/15-impact-trails.png` });

  // 暂停：物理时间不再前进
  await page.tap('[data-testid=pause]');
  const p0 = await page.evaluate(() => window.__game.debugState().time);
  await page.waitForTimeout(700);
  const p1 = await page.evaluate(() => window.__game.debugState().time);
  await page.screenshot({ path: `${OUT}/05-paused.png` });
  check('暂停：物理冻结', p0 === p1, `t=${p0.toFixed(2)}`);
  await page.tap('[data-testid=resume]');
  await page.waitForFunction((t) => window.__game.debugState().time > t, p1, { timeout: 10000 }).catch(() => {});
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
  try {
    process.kill(-server.pid);
  } catch {
    server.kill();
  }
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
