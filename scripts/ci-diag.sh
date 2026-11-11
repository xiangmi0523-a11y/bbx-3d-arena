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
# 本次运行 B2 根因探针（只读，不采用任何开关）：物理子步 120 / 240 / 480 Hz 对照、接地运动学、平底静稳定
run "M4-B B2 根因探针" npx vitest run --config vitest.diag.config.ts tests/diag/m4b-probe.diag.ts
