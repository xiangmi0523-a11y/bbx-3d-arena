import { defineConfig } from 'vitest/config';

// 诊断报告（不是回归测试）：npx vitest run --config vitest.diag.config.ts
export default defineConfig({
  test: { environment: 'node', include: ['tests/diag/**/*.diag.ts'], testTimeout: 900000 },
});
