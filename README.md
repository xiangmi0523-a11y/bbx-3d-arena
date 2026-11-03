# BBX 3D 陀螺竞技场

受 Beyblade X 结构启发的**原创**离线单人 3D 陀螺对战游戏。所有模型、竞技场、命名均为原创设计。

- 渲染：Three.js
- 物理：Rapier 3D（`@dimforge/rapier3d-compat`，WASM 内联，iOS WKWebView 可直接加载）
- 逻辑：TypeScript
- 界面 / 构建：React + Vite
- 存档：IndexedDB（不可用时自动退回内存）
- 目标平台：iPhone Safari → 后续 Capacitor 打包 iOS

## 运行

```bash
npm install
npm run dev          # 开发服务器（--host，可用手机在同一 Wi-Fi 下访问 http://<电脑IP>:5173）
npm run build        # 类型检查 + 生产构建 → dist/
npm run build:preview  # 单文件离线预览 → dist-preview/index.html（双击即可打开）
npm test             # 单元测试 + Rapier 无头对战模拟
npm run test:e2e     # 模拟 iPhone 横屏 + 真实触摸事件的端到端测试（需 Playwright）
```

操作：按住右侧拉绳把手向下拉，拉得越长、松手越快转速越高；拉动时左右偏移调整方向；松手发射。
桌面调试：空格 = 标准力度发射，P = 暂停，R = 重新开始。

## 目录结构

```
src/
  main.tsx                 入口
  ui/                      React 界面（HUD、菜单、拉绳操作区）
  game/
    core/                  GameEngine（主循环、阶段状态机）、Store
    physics/               Rapier 初始化、固定步长推进、碰撞事件
    arena/                 arenaSpec（纯数据）/ ArenaPhysics（碰撞体）/ ArenaVisual（视觉）
    beys/
      parts/               部件类型、部件目录、组装（Blade / Disc / Tip）
      BeyPhysics.ts        陀螺刚体与碰撞体
      BeyVisualFactory.ts  陀螺 3D 模型
    battle/                对战规则：撞击结算、胜负判定（不依赖 Three.js）
    launcher/              拉绳手势（纯逻辑）、发射换算、发射器模型
    camera/                动态跟随战斗摄像机
    render/                程序化贴图、火花特效
    storage/               IndexedDB 存档
tests/                     Vitest：逻辑测试 + 物理模拟测试
scripts/e2e.mjs            Playwright 端到端测试
```

## 设计要点

- **视觉与物理分离**：部件数据里 `visual` 只给渲染用，尺寸/质量/摩擦只给物理用；
  `ArenaVisual` 与 `ArenaPhysics`、`BeyVisualFactory` 与 `BeyPhysics` 各自生成，互不引用。
- **模块化部件**：新增部件只需在 `beys/parts/catalog.ts` 注册；`swapPart()` 可单独替换任一部件。
- **物理真实参与**：碰撞、摩擦、重力、碗面回中、轴心摩擦带来的移动都由 Rapier 计算。
  额外施加的只有陀螺仪自稳（刚体引擎不模拟陀螺效应）、齿轮咬合轨道冲刺、按转速差补充的撞击冲量，
  三者都由实时物理状态（转速、位置、速度）驱动，参数集中在 `BEY_TUNING` / `SMASH_TUNING`。
- **iOS 准备**：`base: './'`、`capacitor.config.json`（webDir = dist）、安全区适配、禁止缩放和回弹。

## Capacitor（后续阶段）

```bash
npm i @capacitor/core @capacitor/ios && npm i -D @capacitor/cli
npm run build && npx cap add ios && npx cap sync ios && npx cap open ios
```
