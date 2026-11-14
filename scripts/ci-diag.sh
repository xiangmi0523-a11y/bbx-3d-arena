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
# C1 加入只读探针后的 C0 第 5 项复核已完成（CI 43133093239）；重跑：npx vitest run --config vitest.diag.config.ts tests/diag/m4c0.diag.ts
#
# M4-C · C2-P 姿态刚度预算（Huang 2026-11-14 正式实施授权；预注册冻结于 1aab164 的 docs/engineering/m4c-c2-preregistration.md）。
# 本阶段：S1 筛选（四臂 P0 / Pa / Pb / Pc）。顺序：
#   1. 耗时（单独运行，不与其他诊断并行；§10 停止条件 3）
#   2. S3 的 Δp 标定（P0，§6.1）
#   3. 四个臂并行（各自同种子运行两次检验确定性）
#   4. bootstrap 覆盖率模拟 c = 0–19（四个进程并行，用例 / 种子 / N_sim / B 不变）
#   5. 判定（§8）
mkdir -p test-results
run "C2-P 耗时（候选臂 vs P0，同机交替）" npx vitest run --config vitest.diag.config.ts tests/diag/m4c-c2p-timing.diag.ts
run "C2-P S3 Δp 标定" npx vitest run --config vitest.diag.config.ts tests/diag/m4c-c2p-calib.diag.ts

# 并行运行：每个进程的输出写入单独的日志文件，结束后按顺序打印（日志不交错）
par() {
  local label="$1"
  shift
  local pids=()
  local names=()
  local spec
  for spec in "$@"; do
    local name="${spec%%:*}"
    local envs="${spec#*:}"
    names+=("$name")
    (env $envs npx vitest run --config vitest.diag.config.ts "$PAR_FILE" > "test-results/log-$name.txt" 2>&1) &
    pids+=($!)
  done
  local fail=0
  local i
  for i in "${!pids[@]}"; do
    if ! wait "${pids[$i]}"; then
      echo "进程 ${names[$i]} 失败"
      fail=1
    fi
  done
  for i in "${!names[@]}"; do
    echo "::group::$label ${names[$i]}"
    cat "test-results/log-${names[$i]}.txt"
    echo "::endgroup::"
  done
  return $fail
}

PAR_FILE=tests/diag/m4c-c2p.diag.ts par "C2-P S1" \
  "S1-P0:C2P_SET=S1 C2P_ARM=P0" "S1-Pa:C2P_SET=S1 C2P_ARM=Pa" "S1-Pb:C2P_SET=S1 C2P_ARM=Pb" "S1-Pc:C2P_SET=S1 C2P_ARM=Pc" || ARM_FAIL=1
PAR_FILE=tests/diag/m4c-c2p-coverage.diag.ts par "C2-P 覆盖率" \
  "cov-678:C2P_COV_CASES=6,7,8" "cov-91011:C2P_COV_CASES=9,10,11" "cov-345:C2P_COV_CASES=3,4,5" "cov-rest:C2P_COV_CASES=0,1,2,12,13,14,15,16,17,18,19" || COV_FAIL=1
run "C2-P S1 判定" env C2P_SET=S1 npx vitest run --config vitest.diag.config.ts tests/diag/m4c-c2p-analysis.diag.ts
if [ "${ARM_FAIL:-0}" = 1 ] || [ "${COV_FAIL:-0}" = 1 ]; then
  echo "有并行进程失败（见上面的日志）"
  exit 1
fi
