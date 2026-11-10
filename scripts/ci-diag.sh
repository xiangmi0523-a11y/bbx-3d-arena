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
# （M2 最终参数实测与 M5a 账本、竞技场 A/B 已有结论，见 docs/engineering/m5-ledger-report.md）
run "M5 接触掉速来源分解（只读：对撞 / 倾角分桶 + 刀刃摩擦 0 / Bit 摩擦减半）" npx vitest run --config vitest.diag.config.ts tests/diag/m5-balance.diag.ts -t "I："
