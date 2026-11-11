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
# 最后一轮定向实验（m4-final-round-plan.md，预注册）：第一阶段接触几何 C1（C1-0 对照、C1-a / C1-b 微凸球冠）
run "M4 最后一轮 C1 接触几何" npx vitest run --config vitest.diag.config.ts tests/diag/m4c1.diag.ts
