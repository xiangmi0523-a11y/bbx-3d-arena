# Stage A：接触观测层修复说明

- 分支：`feat/low-speed-stall-contact-sampling`，从干净的 `cb4c2c4` 建立。没有 PR，没有合并，也没有构建 IPA。
- 范围：只修改接触的观测与分类。物理参数、碰撞体、求解参数、运动控制、WATCH / DEADLOCK / wobble / 脱困都没有动，也没有引入 R1c。
- 标记：**[实测]** 是本轮数据或测试直接得出的；**[推断]** 是由数据推理得出、没有单独验证的。

## 1. 调用链（cb4c2c4）

`PhysicsWorld.step()` → `afterStep` → `BattleSystem.postStep()` → `this.contact.step(dt, this.sampleContact(a, b, dt))`

- `sampleContact()` 的返回值只交给 `ContactFeedback.step()`。它是接触反馈状态机，只驱动视听反馈（`GameEngine` / `BattleFeedback` / `ImpactFX` 读 `contact.state`），不施加力或冲量。
- 撞击结算 `resolveSmash()` 由 Rapier 的 `startedContacts` 事件触发，用的是它自己的 `contactImpulse()`。**本次没有改这条链路**，`contactImpulse()` 原样保留。
- `isDeathWobble` 的 `touching` 用的是 XZ 中心距（旧口径），和 `sampleContact()` 无关，本次没有改。

## 2. 修改清单

| 文件 | 修改 | 原因 |
|---|---|---|
| `src/game/battle/contactSampling.ts`（新） | 新增两个结构：`ContactEvidence` 记录原始证据，字段包括采样状态 queried / skipped / valid、流形数、接触点数、求解器点数、最小 signed solver distance、法向冲量和、正冲量点数、形状距离；`ContactClass` 记录分类，分 geometric / predictive / impulseResponse 三维，彼此不互相推导。还新增包围球半径计算、包围球门槛 `canSkip()` 和查询函数 `queryContact()` | 把几何接触、冲量响应、几何间距、采样状态分开记录 |
| `src/game/battle/BattleSystem.ts` | 1）旧的 early-out 是「XZ 中心距 > outerRadius 之和 + 0.12 就不查询」，换成与姿态无关的包围球门槛：两台刚体原点（步后）的三维距离 > 两个包围球半径 + 本步两台位移上界（\|v\|·dt）+ 预测距离 + 0.02 余量时，才跳过查询。2）每步的证据和分类写进 `contactEvidence` / `contactClass`，计数写进 `contactStats`。3）交给反馈层的 `touching` 由「冲量 > 0」改为「几何接触（solver distance ≤ 0）或冲量 > 0」；力仍是冲量 / 步长，零冲量穿透时为 0 | 问题 1：倾斜刀刃边缘漏采。问题 2：零冲量穿透被当成无接触 |
| `src/game/battle/contactFeedback.ts` | 只改注释：`touching` / `force` 的含义 | 与新分类一致 |
| `tests/contactSampling.test.ts`（新） | 5 个测试，见第 4 节 | 验证要求 |
| `tests/diag/contactsampling.diag.ts`（新） | 在 180 场矩阵上每步同时算三样：新版采样、旧版规则复算、门槛跳过时的无条件查询 | 量化观测变化，并检查门槛会不会漏查 |
| `tests/diag/stallprobe2.shared.ts`、`stallprobe2-plain.diag.ts`、`scripts/stallprobe2-verify.mjs` | 从探针 V2 分支原样带入，内容未改 | 固定种子的跨树物理对照 |

**Rapier 语义**（rapier3d-compat 0.19.3 类型定义，与已核实的一致）：

- `solverContactDist ≤ 0`：几何接触或穿透。
- `> 0`：预测接触间隙；预测距离运行时读出为 0.002 m。
- `contactImpulse > 0`：求解器给出了冲量响应。
- 形状距离来自 `contactCollider`，查询范围 5 cm，超出记为 +∞。它是步后位置的距离，和流形数据不是同一时刻。

**为什么包围球门槛不会漏查** [推断，并有实测验证]：

- 每个碰撞体（球或圆柱）的外接球都包含在「刚体原点为心、包围球半径为半径」的球里，而且与刚体姿态无关。
- 本步 Rapier 用积分前的位置做碰撞检测。积分前到积分后，原点位移不超过 \|v\|·dt，因为 Rapier 用求解后的速度积分位置。
- 所以当步后距离超过上式时，积分前两台的碰撞体相距大于预测距离，不可能有接触流形。
- 遇到不认识的形状时，包围球半径返回 +∞，此时永远查询。

## 3. 物理是否变化

**没有改任何物理参数或物理行为。**

- [实测] 使用与探针 V2 相同的 180 场固定种子矩阵，每场记录逐步状态指纹（每台 15 个 float64，取 SHA-256），与干净 `cb4c2c4` 工作树的无探针运行逐场比对：

| 配置 | 一致 | 证明 |
|---|---|---|
| B（默认） | **180/180**（hash、步数、结果全同） | `data/verify-B.json` |
| A（DIAG_TUNE stallBreak 1） | **180/180** | `data/verify-A.json` |

- 基线 hash 在 `data/baseline-cb4-plain-{B,A}.json`，本分支 hash 在 `data/plain-{B,A}.json`。
- `tests/contact.test.ts` 里原有的「读取接触不改变物理」对照测试也通过，那个测试比较的是 `contactFeedback: true / false` 两种情况。

## 4. 测试

`tests/contactSampling.test.ts`，5/5 通过 [实测]：

1. **倾斜刀刃边缘接触**
   - 场景：两台平衡套装各向对方倾斜 0.55 rad，用二分法摆放到刀刃形状距离为 −1 mm。
   - 结果：XZ 中心距 1.477 m，大于旧 early-out 门槛 1.06 + 0.12 = 1.18 m，旧版会在查询前返回。新版执行了查询：求解器点 1 个，signed distance −0.00114 m，`geometric = true`，反馈进入接触段。
2. **零冲量穿透**
   - 分类函数：signed distance −0.0008 m（或 0），冲量为 0，结果为 `geometric = true`、`impulseResponse = false`。
   - 真实对局（固定种子 40 s）：出现 20 步「几何接触、冲量为 0」，这 20 步全部被反馈层按接触处理。
3. **正间隙**
   - 场景：两台直立静止，刀刃间隙 1 mm。
   - 结果：求解器点 3 个，最小 signed distance +0.001 m，冲量 0。分类为 `predictive = true`、`geometric = false`，反馈层保持 idle。
4. **无接触**
   - 场景：间隙 10 cm 时会执行查询，但流形数为 0；间隙 4 m 时由门槛跳过（`skipped = 'bound'`、`valid = false`）。
   - 结果：两种情况分类都是全 false，反馈层保持 idle。
5. **门槛不漏查**
   - 场景：固定种子整场。
   - 结果：门槛跳过了 899 步，每一步再做无条件查询，流形数都是 0。

全矩阵观测统计（`data/obs.json`，B 配置 180 场，507,403 步）[实测]：

| 项 | 数值 |
|---|---|
| 门槛跳过的步中，无条件查询仍有流形的 | **0** |
| 新版跳过、旧版却会查询的步 | 0（新门槛不比旧门槛更激进） |
| 旧 early-out 会漏掉的步：几何接触 / 冲量响应 / 预测间隙 | 317 / 231 / 203，分布在 39 场；漏采时最大倾角 0.84 rad，最大外缘间隙 0.29 m |
| 几何接触步 | 4,588，其中零冲量 1,642 |
| 有冲量响应、没有几何接触的步 | 200 |
| 预测间隙步 | 2,345 |
| 交给反馈层的 touching 步：旧规则 → 新版 | 2,915 → 4,788（新增 1,873；旧有新无 0） |
| 反馈接触段 / 进入持续摩擦的段（旧规则复算 → 新版） | 1,270 → 1,379 / 121 → 198 |

注：「旧规则」由同一次运行复算得到，即旧 early-out 加「冲量 > 0」，再喂给一个独立的 `ContactFeedback` 实例。滑动速度借用了新版的值，但它只影响强度，不影响段的计数。

**全量测试与类型检查** [实测]：

- `npm run typecheck`：通过。
- `npx vitest run`：8 个文件、132 个测试，1 个失败。
  - 失败用例：`tests/physics.test.ts`「P2.3.1：不会长时间原地互转——平衡套装对默认对手（都是球头轴心）最长僵持 < 1.6 秒」，断言 `expected 15.483333333333094 to be less than 1.6`。
  - 这是**基线本身已有的失败**：在干净的 `cb4c2c4` 上同样失败，数值完全相同（同一次运行：7 个文件、127 个测试、1 个失败）。它来自第三轮关闭通用僵持脱困，与本次修改无关。阈值没有改。

## 5. 三类变化的区分

- **观测逻辑变化（本次有意改的）**：
  - 采样范围变大：查询步从 174,087 增加到 385,500。
  - 倾斜边缘接触能被采到。
  - 零冲量穿透计为接触。
  - 结果是反馈层的接触段和持续摩擦段变多，即视听反馈的触发会变多。这一点只能在游戏里看到，物理不受影响。
- **物理模拟结果变化**：无。跨树 hash 360/360 一致。
- **测试工具或基线已有的问题**：
  - physics.test P2.3.1 球头用例，基线本身就失败。
  - 跨树对照用的 plain 运行与探针 V2 是同一套工具；基线 hash 在 V2 阶段生成，本轮在干净的 cb4c2c4 上复跑，结果逐字节相同。

## 6. 性能与已知限制

- [实测] 180 场整矩阵的无头模拟总耗时：cb4c2c4 为 32.37 / 32.45 s，本分支为 34.59 / 34.12 s，约 +6%，折合每个物理步约 +3.8 µs（Node，桌面 CPU）。
  - 原因有两个：包围球门槛比旧门槛宽（陀螺倾倒时最远可伸出的距离都要覆盖），所以查询步多了约 2.2 倍；每次查询还多做了 16 次形状距离查询。
  - iPhone 上的开销没有实测。
- 包围球门槛偏保守，因为要覆盖任意姿态。在两台中心相距约 1.1–1.4 m 时，它会查询一些实际不可能接触的步。这是用性能换不漏查。
- 形状距离是步后位置的距离，流形和求解器数据来自本步积分前的碰撞检测，两者不同时刻，所以分开保存、不合并。
- 反馈层的接触段变多，听感和视觉上的变化尚未在真机上验收。

## 7. 复现

```bash
git checkout feat/low-speed-stall-contact-sampling
npm run typecheck && npx vitest run
npx vitest run tests/contactSampling.test.ts
# 观测统计
npx vitest run --config vitest.diag.config.ts tests/diag/contactsampling.diag.ts        # → test-results/contactsampling/obs.json
# 跨树物理对照
SP2_PLAIN_OUT=test-results/contactsampling/plain-B.json npx vitest run --config vitest.diag.config.ts tests/diag/stallprobe2-plain.diag.ts
git worktree add --detach ../wt-cb4 cb4c2c4 && ln -s "$PWD/node_modules" ../wt-cb4/node_modules
cp tests/diag/stallprobe2.shared.ts tests/diag/stallprobe2-plain.diag.ts ../wt-cb4/tests/diag/
(cd ../wt-cb4 && SP2_PLAIN_OUT=$OLDPWD/base-B.json npx vitest run --config vitest.diag.config.ts tests/diag/stallprobe2-plain.diag.ts)
node scripts/stallprobe2-verify.mjs test-results/contactsampling/plain-B.json base-B.json verify-B.json
# A 配置在两边都加 DIAG_TUNE='{"stallBreak":1}'
```
