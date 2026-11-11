#!/usr/bin/env bash
# CI 诊断入口（.github/workflows/ci.yml 的“诊断与实验”任务调用）。
# 列出当前分支需要复核的诊断 / 实验；全部固定种子，结论打印在日志里（行首 M2-…），明细写入 test-results/。
# 本地同样可以运行：bash scripts/ci-diag.sh
set -euo pipefail

run() {
  local name="$1"
  shift
  echo "::group::$name"
  "$@"
  echo "::endgroup::"
}

# M5b（docs/engineering/m5b-experiment-plan.md）：E-CF / E-A1 / E-A1b 结果见 docs/engineering/m5b-results.md。
# E-A2 只在选出臂后运行（需要 M4 的 AI 瞄准口袋，见结果文档）；这里运行一次空跑确认脚本可加载（未设 M5B_KAPPA 时立即跳过）
run "E-A2（未选臂：跳过）" npx vitest run --config vitest.diag.config.ts tests/diag/m5b-claw.diag.ts -t "E-A2"
