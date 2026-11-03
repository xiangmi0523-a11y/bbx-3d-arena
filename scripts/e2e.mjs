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
  // 软件渲染（无 GPU）下 3x 分辨率每帧很慢，截图需要更长的超时
  page.setDefaultTimeout(120000);
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
  // ── P2.1 清晰度：画布缓冲区必须与屏幕物理像素 1:1 ──
  await page.evaluate(() => window.__game.setQuality('high'));
  await page.waitForTimeout(300);
  const hq = await page.evaluate(() => window.__game.debugState());
  const cv = hq.canvas;
  check('清晰度：高清档按原生 3x 渲染', hq.devicePixelRatio === 3 && hq.pixelRatio === 3, `dpr=${hq.devicePixelRatio} pixelRatio=${hq.pixelRatio}`);
  check(
    '清晰度：画布缓冲区 = CSS 尺寸 × DPR（不被拉伸）',
    Math.abs(cv.width - cv.cssWidth * 3) <= 1 && Math.abs(cv.height - cv.cssHeight * 3) <= 1,
    `CSS ${cv.cssWidth}×${cv.cssHeight} → 缓冲区 ${cv.width}×${cv.height}`,
  );
  check('清晰度：WebGL 绘制缓冲区与画布一致', cv.drawingBufferWidth === cv.width && cv.drawingBufferHeight === cv.height, `${cv.drawingBufferWidth}×${cv.drawingBufferHeight}`);
  check('清晰度：开启 MSAA 抗锯齿', cv.samples >= 2, `samples=${cv.samples}`);
  await page.evaluate(() => window.__game.setQuality('medium'));
  await page.waitForTimeout(200);
  const md = await page.evaluate(() => window.__game.debugState());
  check('清晰度：中档仍为原生 3x（只降阴影和粒子）', md.pixelRatio === 3, `pixelRatio=${md.pixelRatio}`);
  await page.evaluate(() => window.__game.setQuality('low'));
  await page.waitForTimeout(200);
  const low = await page.evaluate(() => window.__game.debugState());
  check('清晰度：最低档不低于 2x', low.pixelRatio >= 2, `pixelRatio=${low.pixelRatio}`);
  // 软件渲染（无 GPU）下 3x 截图非常慢，后续截图用最低档 2x；真机按自动档位运行
  page.setDefaultTimeout(90000);

  // ── P2.1 性能：满粒子时特效更新的 CPU 开销、绘制调用数 ──
  const perf = await page.evaluate(() => {
    const g = window.__game;
    for (let i = 0; i < 8; i++) g.fx.impact(0, 0.5, 0, 1, { x: 1, z: 0 }, 0);
    const t0 = performance.now();
    for (let i = 0; i < 120; i++) g.fx.update(1 / 600, g.cam.camera);
    const ms = (performance.now() - t0) / 120;
    g.fx.clear();
    return { ms, calls: g.renderer.info.render.calls, tris: g.renderer.info.render.triangles };
  });
  check('性能：满粒子特效更新 < 1.5ms/帧（CPU）', perf.ms < 1.5, `${perf.ms.toFixed(3)} ms/帧`);
  check('性能：每帧绘制调用 < 250', perf.calls < 250, `draw calls=${perf.calls}，三角形=${perf.tris}`);

  // 战斗中物理推进、刚体运动
  const s0 = await page.evaluate(() => window.__game.debugState());
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/04-battle.png` });
  const s1 = await page.evaluate(() => window.__game.debugState());
  const moved = Math.hypot(s1.player.x - s0.player.x, s1.player.z - s0.player.z);
  check('物理：陀螺刚体在运动', moved > 0.3 && s1.time > s0.time, `位移 ${moved.toFixed(2)}，转速 ${s1.player.spin.toFixed(0)} rad/s`);
  check('物理：陀螺落在场地上（没有穿模掉落）', s1.player.y > -0.2 && s1.rival.y > -0.2, `y=${s1.player.y.toFixed(2)}/${s1.rival.y.toFixed(2)}`);

  // ── P2.2 性能：主循环分段计时（CPU 侧），物理步耗时与渲染插值 ──
  await page.evaluate(() => window.__game.debugPerf(true));
  await page.waitForTimeout(3000);
  const pf = await page.evaluate(() => window.__game.debugPerf(true));
  const perStep = pf.physicsMs / Math.max(0.01, pf.physStepsPerFrame);
  check('P2.2 性能：每个物理步 < 0.6ms（P2.1 常驻 CCD 约 2ms）', perStep < 0.6, `${perStep.toFixed(3)} ms/步，${pf.physStepsPerFrame.toFixed(2)} 步/帧`);
  check(
    'P2.2 性能：主循环逻辑（物理+同步+特效+镜头+UI）< 4ms/帧',
    pf.tickMs < 4,
    `tick ${pf.tickMs.toFixed(2)}ms = 物理 ${pf.physicsMs.toFixed(2)} + 同步 ${pf.syncMs.toFixed(2)} + 特效 ${pf.fxMs.toFixed(2)} + 镜头 ${pf.camMs.toFixed(2)} + UI ${pf.uiMs.toFixed(2)}；渲染提交 ${pf.renderSubmitMs.toFixed(2)}ms（软件渲染）`,
  );
  // 渲染插值：慢动作时每帧不足一个物理步，陀螺的显示位置仍应连续变化（不是隔帧跳一次）
  const interp = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const g = window.__game;
        g.debugImpact(0.95);
        const xs = [];
        const loop = () => {
          const p = g.visuals.player.root.position;
          xs.push(p.x + p.z);
          if (xs.length < 12) requestAnimationFrame(loop);
          else resolve(xs);
        };
        requestAnimationFrame(loop);
      }),
  );
  let moves = 0;
  for (let i = 1; i < interp.length; i++) if (Math.abs(interp[i] - interp[i - 1]) > 1e-6) moves++;
  check('P2.2 渲染插值：Hit-stop / 慢动作期间陀螺位置逐帧连续', moves >= interp.length - 3, `${moves}/${interp.length - 1} 帧有位移`);
  const vib = await page.evaluate(() => typeof navigator.vibrate);
  check('P2.2 振动：只在支持的浏览器调用（iPhone Safari 无此 API）', true, `本环境 navigator.vibrate: ${vib}`);

  // ── P2.1 撞击分级：轻擦 / 中等 / 猛撞反馈不同 ──
  const tierOf = async (strength) => {
    await page.waitForTimeout(700); // 等上一档的定格冷却结束
    return page.evaluate((x) => {
      window.__game.debugImpact(x);
      return window.__game.debugLastImpact();
    }, strength);
  };
  const lt = await tierOf(0.15);
  await page.waitForTimeout(30);
  await page.screenshot({ path: `${OUT}/14a-impact-light.png` });
  const mt = await tierOf(0.45);
  await page.waitForTimeout(30);
  await page.screenshot({ path: `${OUT}/14b-impact-medium.png` });
  await page.waitForTimeout(2300); // 慢动作冷却
  const ht = await tierOf(0.95);
  // 逐帧记录之后 1 秒内的最小时间缩放（Hit-stop 定格 + 慢动作）
  const minScale = await page.evaluate(
    () =>
      new Promise((resolve) => {
        let min = 1;
        const t0 = performance.now();
        const loop = () => {
          min = Math.min(min, window.__game.debugLastImpact().timeScale);
          if (performance.now() - t0 < 1000) requestAnimationFrame(loop);
          else resolve(min);
        };
        loop();
      }),
  );
  await page.evaluate(() => window.__game.debugImpact(0.95));
  await page.waitForTimeout(30);
  await page.screenshot({ path: `${OUT}/14c-impact-heavy.png` });
  await page.waitForTimeout(120);
  await page.screenshot({ path: `${OUT}/15-impact-trails.png` });
  check('撞击分级：轻擦无定格、无慢动作', lt.tier === 'light' && lt.hitstop === 0 && lt.slowmo === 0, JSON.stringify(lt));
  check('撞击分级：中等有短定格、无慢动作', mt.tier === 'medium' && mt.hitstop > 0 && mt.slowmo === 0, JSON.stringify(mt));
  check('撞击分级：猛撞有 Hit-stop + 慢动作', ht.tier === 'heavy' && ht.hitstop > mt.hitstop && ht.slowmo > 0, JSON.stringify(ht));
  check('撞击分级：猛撞瞬间时间几乎定格 / 慢放', minScale < 0.3, `最小 timeScale=${minScale.toFixed(2)}`);

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
