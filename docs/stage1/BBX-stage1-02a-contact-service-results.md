# BBX 阶段 1 · 第二项 A：ContactService 只读接触观测 — 交付说明

- 分支：`stage1/contact-observation-readonly`，父提交 `b08ce99`（树 `eef38af`，与远端一致后才开分支）
- 提交：`69d7b6e`（父 `b08ce99`），已推送
- 环境：Linux x64，Intel Xeon 2.1 GHz × 4，Node 22.23.4，Vitest 4.1.12，`@dimforge/rapier3d-compat` 0.19.3（= Rust rapier 0.30.1）

## 1. 接口与接入位置

**新文件 `src/game/physics/ContactService.ts`**

- 开启方式：`new PhysicsWorld(R, { observeContacts: true })`，之后可通过 `pw.contacts` 访问；默认关闭，此时 `pw.contacts === null`。
- 接入点：在 `PhysicsWorld.step()` 中，`world.step` 和碰撞事件读取完成之后、`afterStep`（BattleSystem.postStep）之前，调用一次 `contacts.observe()`。
- 身份登记：
  - `createArenaPhysics` 登记场地碰撞体：`arena:floor`、`arena:wall#i`、`arena:pocket#j.base/back/side0/side1`、`arena:table`。
  - `BattleSystem` 构造时登记 player/rival 槽位，部件为 `tip / shaft / disc / blade`。
  - 两者都只读不写。重新发射时旧身份退役，相关接触对以 `vanished` 结束后移除，不会残留。
- 查询接口：
  - `bodyPair('player','rival')` 返回身体级汇总。
  - `colliderPair('player:blade','rival:blade')` 返回碰撞体级记录。
  - `colliderPairs` / `bodyPairs` 返回全部记录。
  - `events` 是本步的开始/结束事件。
  - `stats` 是本步的数量统计。
  - `capabilities` 声明各项数据的可用性。

| 语义 | 字段 | 定义 |
|---|---|---|
| physicalContact | `penetration \|\| impulse` | 满足任一即为真实接触证据：求解器接触点的求解前 dist ≤ 0，或本步匹配到的法向冲量 > 0 |
| proximity | `proximity` | 有流形点（在预测距离内），但没有任何真实接触证据 |
| collisionImpulse | `normalImpulse`、每点 `impulse` | 只取本步求解器接触点的求解后法向冲量。旧的残留冲量另计到 `staleImpulsePoints` |
| contactLifecycle | `phase`（none/begin/persist）、`startStep`、`durationSteps`、`episodes`，事件 begin/end（end 附原因 separated/vanished） | 只跟随 physicalContact，按物理步计数 |

约定：
- 双方排序固定：player 在 rival 前，动态物体在 arena 前，同一方内按部件名排序。
- 法线是世界坐标单位向量，方向 A → B；Rapier 返回 flipped 时取反。
- 接触点用求解器接触点的世界坐标，同一碰撞体对的多个点、多个流形分别列出，不做合并。
- 步号是 observe 的次数；时长按步数计算，不读时钟。

## 2. 修改的文件

| 文件 | 职责 |
|---|---|
| `src/game/physics/ContactService.ts`（新） | 只读采集、身份、排序、分类、生命周期、对象池 |
| `src/game/physics/PhysicsWorld.ts` | 构造选项 `observeContacts`；step 中加 `this.contacts?.observe()` 一行 |
| `src/game/arena/ArenaPhysics.ts` | 开启观测时登记场地碰撞体身份 |
| `src/game/battle/BattleSystem.ts` | 开启观测时提供 player/rival 碰撞体来源（只读 `beys`） |
| `tests/contactService.test.ts`（新） | 8 类接触场景 + 真实对局不变量 + 遍历顺序无关 + 不读时间 |
| `tests/repro.test.ts` | 新增：开启观测时与 golden 逐场一致 |
| `tests/repro/recorder.ts`、`tests/diag/repro.diag.ts`、`tests/diag/stallprobe2.shared.ts` | `observeContacts` 选项 / `REPRO_CONTACTS=1`；新服务输出单独哈希，不进 golden |
| `tests/diag/contact-service.diag.ts`、`contact-service-cost.diag.ts`（新） | 新旧通道对照、性能、内存分配、开销拆分 |

没有改动 sampleContact、AI、自主运动、碰撞规则、物理参数、iOS 和 Actions；golden 也没有重新生成。

## 3. 数据来源核查（以安装版本的源码为准）

- **步进顺序**（rapier 0.30.1 `PhysicsPipeline::step`）：
  - 先做窄相位 `detect_collisions`，用的是本步开始、积分前的位姿。
  - 然后求解，用 `writeback_impulses` 把冲量写回流形点，再积分位姿。
  - `max_ccd_substeps` 默认为 1，积分后不再做窄相位。
  - 因此几何量属于**求解前**，法向冲量属于**求解后**。服务在 `capabilities` 中分别标注了这两个时相。【已证实：源码】
- **残留冲量**：流形点的 `data.impulse` 只在该点本步是求解器接触点时才会被写回。窄相位用 `impulse == 0` 判断点是否为新点，说明这个值会跨步保留。【已证实：源码；实测 180 场中有 1,408 个这样的点】
- **求解器点 ↔ 流形点**：JS 没有暴露两者的对应关系。服务按顺序、按 dist 逐位相等来匹配（contact skin 均为 0，已实测）。180 场共 507,403 步，匹配不完整的次数为 0。【已证实】
- **切向冲量：不可用**。
  - 项目使用默认的 `FrictionModel::Simplified`（JS 没有暴露设置项）。
  - 这种模型的 twist writeback 不写 `tangent_impulse`，实测读到的 4,952 个值全部为 0。
  - 切向基向量也没有暴露。
  - 服务不提供这个值，也不做估算。【已证实：源码与实测】
- **零法线**：两个表面恰好相切（dist = 0）时，Rapier 可能给出零向量法线（180 场中出现 6 个点）。服务把这种点标记为 `normalValid=false`，不推算方向。【已证实：实测】
- **CONTACT_FORCE_EVENTS**：需要修改碰撞体的 ActiveEvents，本阶段不改。

## 4. 关键接触场景测试（`tests/contactService.test.ts`，10/10 通过）

每一步都会检查以下不变量：
- 同一步没有重复的对或事件；A/B 排序正确，不存在未知身份。
- 证据和分类一致；proximity 永远不是 physical。
- 法线为单位长度（无效法线时全为零，且 dist = 0）。
- 冲量非负，各点之和等于总冲量。
- 接触对消失后所有字段清零。
- 生命周期与证据一致，时长等于步数。
- 身体级汇总与碰撞体级记录一致。

| 场景 | 结果 |
|---|---|
| 1 无接触（中心距始终 > 外径和 + 1 m） | player\|rival 没有事件、没有 physical；地面接触照常被观测到 |
| 2 正面接触 | 开始事件对应 blade/disc 层；法线水平分量与 player→rival 同向（> 0.5）；有冲量 > 0 |
| 3 倾斜边缘接触 | 能检测到；法线 nx > 0；接触点相对高度与竖直时相差 > 5 mm |
| 4 多点 / 持续接触 | 同一对内出现多点、多流形；同一流形内的点互不重合；身体级持续 > 120 步，只有一段 |
| 5、6 分离与再次接触 | 1,200 步内出现 begin/end 交替多次；end 时长 = 结束步号 − 开始步号；两段之间没有 physical |
| 7 墙壁与地面 | `arena:wall#i` 的法线朝外（> 0.5）；`tip\|floor` 的法线向下（ny < −0.5） |
| 8 同一陀螺的多个碰撞体 | tip 与 blade 同时触地；身体级段数少于碰撞体级段数之和 |
| 真实对局（每组第一场，最多 15 s） | 不变量全部成立；遍历顺序反转后逐步输出相同；推进中读取时间 / 系统随机的次数为 0 |

## 5. 180 场行为回归

- b08ce99（独立 worktree）、本分支观测关闭、本分支观测开启，三份完整记录在 physics/intent/contact/battle 四个通道的全程哈希、步数、终局、计数和事件上逐场一致。用对照工具复核的结果见第 8 节。
- `repro.test` 新增的“开启观测与 golden 一致”用例，在 REPRO_FULL=1 下覆盖全部 180 场。

**新服务与旧接触通道的差异**（player|rival，507,403 步）：

| 对照项 | 结果 | 解释 |
|---|---|---|
| 旧 geometric vs 新 penetration | 4,588 步同为真，差异 0 | 两者定义相同（求解器 dist ≤ 0）。旧包围球门槛跳过的步里，新服务也从未看到陀螺之间的接触对（0） |
| 旧 impulseResponse vs 新 impulse | 2,931 步同为真；215 步只有旧的为真，新的独有 0 | 215 步全部来自非求解器流形点的**残留冲量**：旧代码对全部流形点求和，新服务排除了这些点 |
| 旧反馈 touching vs 新 physical | 4,746 同为真；旧独有 42 | 同样是残留冲量造成的。旧通道在这 42 步报告了实际不存在的接触 |
| Rapier CollisionEvent started（旧撞击结算的触发器） | 1,704 次；1,222 次当步有真实接触，482 次（28%）**只是预测间隙** | started 以“有求解器接触点”为准，包含预测点 |
| 新服务独有信息 | proximity-only 2,191 步；地面 / 墙接触；生命周期 | 旧通道只看两台陀螺之间 |

以上差异只做记录，没有修改旧系统。这些差异说明旧的冲量求和（sampleContact 与 resolveSmash 的 contactImpulse）和 started 触发里混入了残留冲量与预测接触，留待以后迁移消费者时处理。

## 6. 性能（实测，上述环境，单进程，无渲染）

| 指标 | 数值 |
|---|---|
| 180 场总耗时（关 / 开，交替各 2 轮） | 38.6 / 38.4 s vs 58.9 / 62.1 s，开销 **+57%** |
| 每步 observe 耗时 | 平均 41 µs，p50 27 µs，p99 277 µs，最大 17 ms（单次离群，可能是 GC） |
| 每步（world.step + 游戏逻辑 + observe） | 平均 121 µs，p50 86 µs |
| 两台陀螺接触的步 | observe 平均 94 µs，p99 562 µs |
| 接触点最多的 5%（≥ 16 点） | 平均 158 µs，p99 776 µs |
| 每步数量 | 接触对 8.5（最大 15）；流形 86（p99 990，最大 2,308）；流形点 8.3（最大 222）；求解器点 7.6（最大 171） |
| 每次 observe 的内存分配 | 4.2–14.7 KB（3 个场景 × 2 个时刻，测量期间无 GC） |

**开销拆分**（同一固定状态下重复调用，AvD#1 第 600 步，86 个流形）：

| 内容 | 耗时 | 分配 |
|---|---|---|
| observe 全量 | 33 µs | 14.0 KB |
| 只枚举接触对 | 2.7 µs | 1.0 KB |
| 只遍历 Rapier 流形，不做任何处理 | 29–35 µs | 13.5–15.2 KB |

结论：
- 约 85–90% 的耗时和几乎全部内存分配来自 Rapier JS/WASM 绑定：每个流形都要创建一个包装对象，而碗面三角网格每步会产生几十到上千个空流形。服务自身的逻辑和对象池只占很小一部分。【已证实】
- 要明显降低这部分开销，只能另外构建 Rapier WASM，或者在 Rust 侧批量导出，本阶段不做。
- 游戏中默认关闭，对正式游戏没有开销。iPhone 上开启后的开销**没有测量**。

## 7. 已知限制与未解决问题

1. 切向摩擦冲量与接触力事件不可用，原因见第 3 节。
2. 几何是求解前、积分前的结果；需要“步后实际间距”时，只能另做形状查询，本阶段没有采集。
3. 球压在三角网格顶点上时，每个相邻三角形各产生一个流形，接触点几乎重合（最多 96 个）。服务原样保留这些点，消费者不能直接把点数当作“接触面积”。
4. 针尖 / 球头在碗面上会频繁离地又接触（这是物理上真实的，曾观察到连续 3 步完全没有流形）。身体级 player|arena 在 180 场中开始了 17,994 次。滞回、去抖应该由消费者决定，服务不做。
5. 按 dist 匹配求解器点的方法有理论上的歧义：同一流形里两个点的 dist 完全相等，且其中一个没有成为求解器点。180 场实测匹配不完整的次数为 0；一旦出现会标记为 `match-incomplete`，并且不采用它的冲量。
6. 只在 Node 下验证过，跨平台（iOS WebKit）和真机都未验证。
7. 观测开启时的开销较高（+57%），见第 6 节。是否在游戏里常开，需要等有了消费者之后再定。
