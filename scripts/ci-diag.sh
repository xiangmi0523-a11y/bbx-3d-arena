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
run "M2 实验（A golden 归因 / B 针尖探针 / C 签名矩阵与 k 扫描）" npx vitest run --config vitest.diag.config.ts tests/diag/m2-experiment.diag.ts
