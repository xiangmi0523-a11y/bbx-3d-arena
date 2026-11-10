#!/usr/bin/env bash
# CI 诊断入口（.github/workflows/ci.yml 的“诊断与实验”任务调用）。
# 列出当前分支需要复核的诊断 / 实验；全部固定种子，结果写入 test-results/ 并作为 Actions Artifact 上传。
# 本地同样可以运行：bash scripts/ci-diag.sh
set -euo pipefail

run() {
  local name="$1"
  shift
  echo "::group::$name"
  "$@"
  echo "::endgroup::"
}

# 阶段 S1：只读观测基线（不改物理 / AI / 规则）
run "惯量契约（64 组合，游戏层标量 vs Rapier 主惯量）" npx vitest run --config vitest.diag.config.ts tests/diag/inertia.diag.ts
run "爆裂标定基线（接触段冲量分布 + k 扫描，自然对局场景）" npx vitest run --config vitest.diag.config.ts tests/diag/burst-calib.diag.ts
