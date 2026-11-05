/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { execSync } from 'node:child_process';

// Stage 0：构建 SHA（CI 用 GITHUB_SHA，本地用 git），诊断面板和导出数据里显示
function buildSha(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    const sha = execSync('git rev-parse HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    const dirty = execSync('git status --porcelain --untracked-files=no', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    return dirty ? `${sha}-dirty` : sha;
  } catch {
    return 'unknown';
  }
}

// SINGLE_FILE=1 时把全部资源内联成一个 HTML，便于离线预览或临时分享
const singleFile = process.env.SINGLE_FILE === '1';

export default defineConfig({
  // 相对路径，Capacitor 的 WKWebView 通过 capacitor:// 加载本地文件时需要
  base: './',
  plugins: [react(), ...(singleFile ? [viteSingleFile()] : [])],
  define: {
    __BUILD_SHA__: JSON.stringify(buildSha()),
    __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
  },
  build: {
    target: 'es2020', // iOS Safari 14+
    outDir: singleFile ? 'dist-preview' : 'dist',
    chunkSizeWarningLimit: 4000,
  },
  server: { host: true },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
