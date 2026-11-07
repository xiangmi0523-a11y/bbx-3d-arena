import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// 回放对比页打成单个离线 HTML（数据由 scripts/replay-bundle.mjs 之后注入）：
//   npx vite build --config tools/vite.replay.config.ts
export default defineConfig({
  base: './',
  root: resolve(__dirname),
  plugins: [viteSingleFile()],
  build: {
    target: 'es2020',
    outDir: resolve(__dirname, '../test-results/replay-build'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 8000,
    rollupOptions: { input: resolve(__dirname, 'replay.html') },
  },
});
