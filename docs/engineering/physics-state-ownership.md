# 物理状态所有权清单（v2.0 S1.4）

依据：`main 2d6131f` + Stage 1 代码逐行核对（`BeyPhysics.ts`、`BattleSystem.ts`、`PhysicsWorld.ts`、`ContactService.ts`）。
目的：明确每个状态由谁积分、谁写、谁只读，后续任何改动都按此表判断是否越界。

## 1. 陀螺刚体

| 状态 | 所有者 | 写入点（全部） | 说明 |
|---|---|---|---|
| 位置、姿态 | Rapier 积分 | 仅 `BeyPhysics` 构造时设定发射位姿 | 发射后游戏代码**从不**直接写位置 / 姿态（`motion.test` 守护） |
| 线速度 | Rapier 积分 | 构造时 `setLinvel`（发射速度）；之后只有有上限的冲量：轴心牵引、轨道冲刺、滚动阻力（`BeyPhysics.preStep`）、刀刃咬合冲量（`BattleSystem.resolveSmash`，成对施加） | 冲量都按真实质量换算速度变化；无速度覆盖 |
| 角速度 · 倾斜分量 | Rapier 积分 + 游戏层陀螺自稳 PD | `preStep` 末尾 `setAngvel`：在 Rapier 结果上叠加 PD 修正（`uprightStiffness`/`uprightDamping`） | 刚体引擎不模拟陀螺效应，自稳由此补充 |
| 角速度 · 自转分量 | **游戏层**（`BeyPhysics.spin`） | 每步 `setAngvel` 写回：读取上一步结束时的 ω·up（含 Rapier 接触对自转的改变）→ 减去游戏层衰减 → 写回；`loseSpin`（撞击掉速） | 衰减、掉速按游戏层惯量标量；Rapier 接触对自转的改变按 Rapier 张量。两套惯量的口径差见 `tests/diag/inertia.diag.ts`（R12：游戏层为准） |
| 进动相位 | 游戏层（`BeyPhysics.precession`） | `preStep`：自然进动 + 意图调制 + 被撞歪后跟随实际倾斜 | 决定牵引方向；不施力本身 |
| 发射初相 | 游戏层 | `alignLaunch`（第一步之前一次） | 只改一个本来就是随机数的初始条件 |
| CCD 开关 | 游戏层 | `preStep` 按速度临时开启 | 只影响积分方式，不注入能量 |

## 2. 战术与规则（不写物理状态）

| 状态 | 所有者 | 读取 | 写入物理？ |
|---|---|---|---|
| 意图状态、heading、authority、edgeW | `MotionIntent` | 位置、速度、对手状态 | 否：只调制进动转速（authority < 1） |
| 死亡摇摆脱离计时（wobbleBreak） | `BattleSystem.watchStall` | 位置、转速、倾斜 | 间接：只让较健康一方的牵引按脱困参数计算 0.7 s（v2.0 保留） |
| 通用僵持脱困（stallBreak） | — | — | **已关闭**（`stallBreak = 0`），禁止恢复 |
| 接触观测 | `ContactService`（只读）、`contactSampling`（只读） | 窄相位、求解器冲量 | 否 |
| 接触反馈（轻擦 / 摩擦 / 强碰撞） | `ContactFeedback` | 接触观测 | 否 |
| 爆裂应力 | `burst.ts`（M2 接入） | ContactService 身体级法向冲量 | 否 |
| 终结判定 / 比分 | `BattleSystem.judge`（M2 起为回合裁判 + `match.ts`） | 位置、转速、倾斜、爆裂 | 否 |

## 3. 场地

全部为固定刚体，只在 `createArenaPhysics` 创建；运行中没有任何代码修改场地碰撞体或材料参数（Rapier 0.19.3 也没有逐接触修改摩擦的钩子，v2.0 §11.2 列为“排除”）。
