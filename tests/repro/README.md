# 可重复物理测试基线（阶段 1 第一项）

只在测试侧工作，不修改 `src/` 中的任何物理、AI、碰撞或规则代码。

## 组成

| 文件 | 作用 |
|---|---|
| `determinism.ts` | `withDeterminism(seed, fn)`：用 mulberry32 种子替换 `Math.random`，并统计 `performance.now` / `Date.now` / `crypto` 随机源的调用。Rapier 求解内部读取的计时单独计数（`engineTimerReads`）。`defaultSeed()` 从发射参数、部件和时长派生默认种子。 |
| `recorder.ts` | `recordRun(R, 场景)`：逐步记录 physics / intent / contact / battle 四个通道的全程哈希，每 120 步（1 秒）一个块哈希，并保存关键帧、事件表（撞击、意图切换、终局，带步号）、初始状态、参数指纹和随机源报告。`detail: [起, 止]` 会逐步展开完整状态。 |
| `config.ts` | 关键物理参数指纹：部件物理字段、BEY/INTENT/SMASH/CONTACT 调参、撞击分档、接触采样常量、步长、重力、求解器参数、场地和 Rapier 版本。 |
| `compare.ts` | 两份记录逐场对照。先比全程哈希；不一致时给出第一个不同的块、该块关键帧的最大偏差、第一处不同的事件和终局。 |
| `../repro.test.ts` | 常规测试，比对每组第一场与 golden；`REPRO_FULL=1` 时比对全部 180 场。 |
| `../fixtures/repro-golden.json` | 180 场摘要，在 B1（main 2d6131f）上生成。 |
| `../diag/repro.diag.ts`、`../diag/repro-compare.diag.ts` | 完整记录与对照的命令行入口。 |

场景集沿用 Stage A 的 180 个固定种子场景（`tests/diag/stallprobe2.shared.ts`）。physics 通道与 Stage A 的指纹算法相同，可以直接和历史结果对照。

## 常用命令

```bash
# 完整记录 180 场（约 50 秒）
REPRO_OUT=test-results/repro/a.json npx vitest run --config vitest.diag.config.ts tests/diag/repro.diag.ts
# 对照两份记录
REPRO_A=test-results/repro/a.json REPRO_B=test-results/repro/b.json REPRO_REPORT=test-results/repro/cmp.json \
  npx vitest run --config vitest.diag.config.ts tests/diag/repro-compare.diag.ts
# 定位到具体步：只跑一个场景，在第一个不同的块内逐步展开
REPRO_ONLY="NNPOW 0.3#1" REPRO_DETAIL=0-120 REPRO_OUT=test-results/repro/drill.json npx vitest run --config vitest.diag.config.ts tests/diag/repro.diag.ts
# 行为有意变化并获批准后，重新生成 golden
REPRO_OUT=test-results/repro/new.json REPRO_GOLDEN_WRITE=tests/fixtures/repro-golden.json npx vitest run --config vitest.diag.config.ts tests/diag/repro.diag.ts
```

其他环境变量：`REPRO_ORDER=reverse` 逆序运行；`REPRO_GROUPS=...` 只跑指定分组；`REPRO_TUNE='{"键":值}'` 在本进程内临时覆盖 BEY_TUNING，用来验证对照工具确实能发现变化；`REPRO_SEED_SALT=n` 整体换一组派生种子，用来抽查统计断言是否稳健。

## 测试辅助的种子

`tests/sim.ts` 的 `simulateBattle` 和 `tests/diag/harness.ts` 的 `diagnoseBattle` 新增 `seed` 选项。省略时用 `defaultSeed(参数)`；传 `seed: null` 时沿用调用方自己替换的 `Math.random`，旧诊断脚本用的就是这种方式。无头模拟只在构造陀螺时消耗随机数，逐步推进时不消耗，由 `repro.test.ts` 断言。
