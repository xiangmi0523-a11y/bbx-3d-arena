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

# 阶段 M2：回合裁判的 golden 变化归因 + 针尖探针（R3）+ 签名矩阵与爆裂 k 标定（R8 / §6.3）
run "M2 最终参数实测（签名矩阵 4×4×20，爆裂实时判定）" env M2_PARTS=D npx vitest run --config vitest.diag.config.ts tests/diag/m2-experiment.diag.ts
run "M5a 掉速账本（E7，签名矩阵按来源分解掉速）" npx vitest run --config vitest.diag.config.ts tests/diag/m5-balance.diag.ts
