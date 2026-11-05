/**
 * Stage 0 性能诊断开关（仅诊断构建）。
 *
 * VITE_PERF_DIAG 在构建时由 Vite 静态替换：
 *  - 诊断分支的 .env.production 设为 '1' → 诊断 IPA 带诊断面板；
 *  - 其他构建（或 VITE_PERF_DIAG=0 npm run build）为 false，
 *    所有 `if (DIAG)` 分支和诊断模块会在打包时被整体删除，游戏代码与基线一致。
 */
export const DIAG: boolean = import.meta.env.VITE_PERF_DIAG === '1';

declare const __BUILD_SHA__: string;
declare const __BUILD_TIME__: string;

/** 构建信息（vite.config.ts 注入；单元测试环境下没有注入时给默认值） */
export const BUILD_INFO = {
  sha: typeof __BUILD_SHA__ === 'string' ? __BUILD_SHA__ : 'unknown',
  time: typeof __BUILD_TIME__ === 'string' ? __BUILD_TIME__ : 'unknown',
  label: 'stage0-perf-diag',
};
