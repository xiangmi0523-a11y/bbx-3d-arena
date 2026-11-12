#!/usr/bin/env bash
# CI 诊断入口（.github/workflows/ci.yml 的“诊断与实验”任务调用）。
# 列出当前分支需要复核的诊断 / 实验；全部固定种子，结论打印在日志里（行首 M4B-…），明细写入 test-results/。
# 本地同样可以运行：bash scripts/ci-diag.sh
set -euo pipefail

run() {
  local name="$1"
  shift
  echo "::group::$name"
  "$@"
  echo "::endgroup::"
}

# M4-A 基准已完成（docs/engineering/m4a-baseline.md，CI 43029289458）；重跑：npx vitest run --config vitest.diag.config.ts tests/diag/m4a-baseline.diag.ts
# M4-B（docs/engineering/m4-experiment-plan.md §4，预注册）：B1、B2 未通过（m4-results.md）；重跑某个臂：M4B_ARM=B2 npx vitest run --config vitest.diag.config.ts tests/diag/m4b.diag.ts
# B2 根因探针（只读）已完成：Q1–Q3（CI 43037223927）、Q4（43038195551）、Q5（43038817940），结果见 m4-results.md。
# Huang 选择 A 物理尺度路线（m4-experiment-plan.md §4.2）：A1 耗时 / 一致性与 A2 单台标定网格已完成（CI 43046986070，12 组都未通过，见 m4-results.md）
# 最后一轮定向实验（m4-final-round-plan.md）已完成并触发停止条件（m4-results.md）。
# M4-C（Huang 2026-11-12 授权 C0 + 扩充版 C1）：C0 已通过验收（m4c-c0-acceptance.md；同机耗时对比 CI 43118644656，重跑：
#   npx vitest run --config vitest.diag.config.ts tests/diag/m4c0.diag.ts）
# C1 预算诊断（只读，m4c-c1-plan.md）已完成：CI 43128806877 / 43129443527，结果见 m4c-c1-results.md；重跑：
#   npx vitest run --config vitest.diag.config.ts tests/diag/m4c-c1.diag.ts
# C1 加入只读探针（关闭时只多 null 判断）后复核 C0 第 5 项：执行层 vs 旧路径同机耗时（旧路径没有探针判断）
run "M4-C C0 耗时对比（含 C1 探针代码）" npx vitest run --config vitest.diag.config.ts tests/diag/m4c0.diag.ts
