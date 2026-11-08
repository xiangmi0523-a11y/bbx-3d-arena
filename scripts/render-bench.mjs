// 渲染开销相对对比（软件 GPU：SwiftShader）。不代表 iPhone 绝对帧率，只用来比较各渲染选项的相对像素开销。
// 用法：npm run build && node scripts/render-bench.mjs [变体...]
// 每个变体：进入对战 → 快进到中局 → 在同一画面上逐帧 render + gl.finish，取中位耗时。
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const PORT = 4181;
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { stdio: 'pipe', detached: true });
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('preview timeout')), 20000);
  server.stdout.on('data', (d) => String(d).includes(String(PORT)) && (clearTimeout(t), res()));
});
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const variants = process.argv.slice(2).length ? process.argv.slice(2) : ['base'];
try {
  for (const v of variants) {
    const ctx = await browser.newContext({ viewport: { width: 874, height: 402 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148' });
    const page = await ctx.newPage();
    page.setDefaultTimeout(300000);
    await page.goto(`http://localhost:${PORT}/?bench=${v}`);
    await page.waitForFunction(() => window.__game?.store.get().phase === 'title', null, { timeout: 60000 });
    const r = await page.evaluate(async (variant) => {
      const g = window.__game;
      const q = variant.match(/^q=(\w+)/); g.setQuality(q ? q[1] : 'low');
      g.start();
      await new Promise((r) => setTimeout(r, 300));
      g.launch({ power: 0.8, aim: 0, tilt: 0 });
      g.debugFastForward(8);
      for (let i = 0; i < 90; i++) g.tick(1 / 60); // 让镜头跟到对战视角
      g.pause();
      document.querySelectorAll('.overlay, .modal, .pause, [class*=pause]').forEach((e) => (e.style.display = 'none'));
      const ren = g.renderer;
      const gl = ren.getContext();
      const parts = variant.split('+');
      const all = [];
      g.scene.traverse((o) => all.push(o));
      const mats = new Set();
      all.forEach((o) => o.material && [].concat(o.material).forEach((m) => mats.add(m)));
      const Std = [...mats].find((m) => m.type === 'MeshStandardMaterial')?.constructor;
      for (const p of parts) {
        if (p === 'pcf') ren.shadowMap.type = 1;
        if (p === 'noshadow') ren.shadowMap.enabled = false;
        if (p === 'nospots') all.forEach((o) => (o.isSpotLight || o.isPointLight) && (o.visible = false));
        if (p === 'nopoint') all.forEach((o) => o.isPointLight && (o.visible = false));
        if (p === 'pr15') ren.setPixelRatio(1.5);
        if (p === 'pr3') ren.setPixelRatio(3);
        if (p === 'floorstd') all.forEach((o) => { if (o.isMesh && o.material?.type === 'MeshPhysicalMaterial' && o.material.map && o.receiveShadow) { const m = o.material; o.material = new Std({ map: m.map, roughness: m.roughness, metalness: m.metalness }); } });
        if (p === 'allstd') all.forEach((o) => { if (o.isMesh && o.material?.type === 'MeshPhysicalMaterial') { const m = o.material; o.material = new Std({ map: m.map, color: m.color, roughness: m.roughness, metalness: m.metalness, transparent: m.transparent, opacity: m.opacity, envMap: m.envMap, envMapIntensity: m.envMapIntensity, side: m.side, depthWrite: m.depthWrite }); } });
        if (p === 'nofog') g.scene.fog = null;
      }
      if (parts.includes('pr15') || parts.includes('pr3')) { const c = ren.domElement; ren.setSize(c.clientWidth, c.clientHeight, false); }
      mats.forEach((m) => (m.needsUpdate = true));
      const px = new Uint8Array(4);
      const frame = () => {
        const t = performance.now();
        ren.render(g.scene, g.cam.camera);
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        return performance.now() - t;
      };
      for (let i = 0; i < 3; i++) frame();
      const ts = [];
      for (let i = 0; i < 12; i++) ts.push(frame());
      ts.sort((a, b) => a - b);
      const info = ren.info.render;
      return { variant, ms: ts[6], min: ts[0], pr: ren.getPixelRatio(), w: gl.drawingBufferWidth, h: gl.drawingBufferHeight, calls: info.calls, tris: info.triangles, shadowType: ren.shadowMap.type };
    }, v);
    console.log(JSON.stringify(r));
    if (process.env.SHOT) await page.screenshot({ path: `${process.env.SHOT}/${v.replace(/[^\w=+-]/g, '_')}.png` });
    await ctx.close();
  }
} finally {
  await browser.close();
  process.kill(-server.pid);
}
