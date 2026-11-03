/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

// SINGLE_FILE=1 时把全部资源内联成一个 HTML，便于离线预览或临时分享
const singleFile = process.env.SINGLE_FILE === '1';

export default defineConfig({
  // 相对路径，Capacitor 的 WKWebView 通过 capacitor:// 加载本地文件时需要
  base: './',
  plugins: [react(), ...(singleFile ? [viteSingleFile()] : [])],
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
