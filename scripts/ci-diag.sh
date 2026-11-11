#!/usr/bin/env bash
# CI 诊断入口（.github/workflows/ci.yml 的“诊断与实验”任务调用）。
# 列出当前分支需要复核的诊断 / 实验；全部固定种子，结论打印在日志里（行首 M4A-…），明细写入 test-results/。
# 本地同样可以运行：bash scripts/ci-diag.sh
set -euo pipefail

run() {
  local name="$1"
  shift
  echo "::group::$name"
  "$@"
  echo "::endgroup::"
}

# M4-A 基准（docs/engineering/m4-experiment-plan.md §1，口径 tests/diag/m4.metrics.ts）：不改游戏代码，测量当前版本的陀螺生命周期
run "M4-A 基准" npx vitest run --config vitest.diag.config.ts tests/diag/m4a-baseline.diag.ts
