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

# M5b（docs/engineering/m5b-experiment-plan.md）：E-CF 结果见提交 474cee7 的 CI 运行；本次运行 E-A1 重击模型筛选（探索性，D1）
run "E-A1 重击模型筛选" npx vitest run --config vitest.diag.config.ts tests/diag/m5b-claw.diag.ts -t "E-A1"
