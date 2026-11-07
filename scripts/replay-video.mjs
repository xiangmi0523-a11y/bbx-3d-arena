/**
 * 把回放对比页逐帧截图编码成 MP4（需要 npx vite 已在 PORT 上运行、ffmpeg）。
 *   node scripts/replay-video.mjs <outDir> <key> [key...]
 * 环境变量：PORT（默认 5199）FPS（默认 30）SPEED（播放倍速，默认 1；0.25 = 慢放）T0 / T1（截取时段）QUERY（附加页面参数）
 * 每帧先 renderAt(t)，再 readPixels 强制等 GPU 画完，然后截图，所以帧与时间严格对应（与录制机器快慢无关）。
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const [outDir, ...keys] = process.argv.slice(2);
const PORT = process.env.PORT ?? '5199';
const FPS = Number(process.env.FPS ?? 30);
const SPEED = Number(process.env.SPEED ?? 1);
const QUERY = process.env.QUERY ?? 'aa=0';
const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
for (const key of keys) {
  const page = await browser.newPage({ viewport: { width: 1600, height: 960 } });
  page.on('pageerror', (e) => console.log('pageerror', e.message));
  await page.goto(`http://localhost:${PORT}/tools/replay.html?record=1&${QUERY}&s=${encodeURIComponent(key)}`);
  const { duration } = await page.evaluate(() => window.replayReady);
  const t0 = Number(process.env.T0 ?? 0);
  const t1 = Math.min(duration + 1, Number(process.env.T1 ?? duration + 1));
  const suffix = process.env.SUFFIX ?? '';
  const out = join(outDir, `${key}${suffix}.mp4`);
  const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(FPS), '-c:v', 'mjpeg', '-i', '-', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-preset', 'medium', '-movflags', '+faststart', out], { stdio: ['pipe', 'inherit', 'inherit'] });
  const n = Math.ceil(((t1 - t0) / SPEED) * FPS);
  const started = Date.now();
  for (let k = 0; k <= n; k++) {
    const t = t0 + (k / FPS) * SPEED;
    await page.evaluate((tt) => {
      window.renderAt(tt);
      const gl = document.querySelector('canvas').getContext('webgl2');
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    }, t);
    const buf = await page.screenshot({ type: 'jpeg', quality: 92, clip: { x: 0, y: 0, width: 1600, height: 900 } });
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
    if (k % 60 === 0) console.log(key, `${k}/${n}`, `${((Date.now() - started) / Math.max(1, k)).toFixed(0)} ms/帧`);
  }
  ff.stdin.end();
  await new Promise((r) => ff.on('close', r));
  console.log('done', out);
  await page.close();
}
await browser.close();
