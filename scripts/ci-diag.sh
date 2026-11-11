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

# M7 体验分支（v2/s3-experience）：只改界面、存档与挑战逻辑，不涉及物理；物理实验在 v2/s3-balance 分支运行
echo "M7 分支：没有需要运行的物理诊断"
