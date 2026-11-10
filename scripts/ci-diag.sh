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

# D3（同爆裁决改为比较绝对转速）可能改变 golden 中同一步双方爆裂的场次：重跑 golden 归因并导出新 golden（行首 GOLDEN-B64）
run "golden 归因与导出（M2 A 部分）" env M2_PARTS=A M2_GOLDEN_DUMP=1 npx vitest run --config vitest.diag.config.ts tests/diag/m2-experiment.diag.ts
