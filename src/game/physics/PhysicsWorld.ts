import RAPIER from '@dimforge/rapier3d-compat';
import { ContactService } from './ContactService';

export type Rapier = typeof RAPIER;

let initPromise: Promise<Rapier> | null = null;

/** 初始化 Rapier WASM（全局只做一次）。compat 版本把 wasm 内联在 JS 里，iOS WKWebView 也能直接加载。 */
export function loadRapier(): Promise<Rapier> {
  if (!initPromise) {
    initPromise = RAPIER.init().then(() => RAPIER);
  }
  return initPromise;
}

export const PHYSICS_HZ = 120;
export const PHYSICS_DT = 1 / PHYSICS_HZ;
export const GRAVITY = -20;

/**
 * M4 物理尺度实验开关（docs/engineering/m4-experiment-plan.md §4.2 A1；默认 = 现有行为，逐位不变）。构造 PhysicsWorld 时读取：
 *  - substeps：每个 1/120 s 固定步里的物理子步数 k。每个子步完整执行一次 beforeStep(dt/k) → world.step → 接触事件与观测 → afterStep(dt/k)，
 *    陀螺、战斗结算、爆裂观测、终结判定都在子步上运行；对外仍是“一次 step() 前进 1/120 s”（实时推进、渲染插值、计时不变）；
 *  - gravity：重力加速度的大小（默认 20 = −GRAVITY）；
 *  - floorFriction：场地地面摩擦系数的倍数（createArenaPhysics 读取 PhysicsWorld.floorFriction，默认 1）。
 */
export const PHYSICS_EXPERIMENT = { substeps: 1, gravity: -GRAVITY, floorFriction: 1 };

export interface CollisionPair {
  a: number; // collider handle
  b: number;
}

/**
 * 物理世界封装：固定步长推进、碰撞事件收集。
 * 游戏逻辑只通过这里访问 Rapier，方便以后替换或做确定性回放。
 */
export class PhysicsWorld {
  readonly R: Rapier;
  readonly world: RAPIER.World;
  private readonly events: RAPIER.EventQueue;
  private accumulator = 0;
  /** 上一步开始接触的碰撞体对 */
  readonly startedContacts: CollisionPair[] = [];
  /** 每个固定步之前调用（施加自定义力） */
  beforeStep: ((dt: number) => void) | null = null;
  /** 每个固定步之后调用（读取碰撞） */
  afterStep: ((dt: number) => void) | null = null;
  /**
   * 只读接触观测（阶段 1 第二项 A）：默认开启（M2 起爆裂与自灭判定读取它的实测法向冲量）；
   * observeContacts = false 只用于“无观测”的对照测试。
   * 在 world.step 之后、afterStep 之前观测一次；只读取窄相位数据，不改变物理（见 ContactService.ts，golden 逐位验证）。
   */
  readonly contacts: ContactService | null;
  /** 每个 1/120 s 固定步里的物理子步数（PHYSICS_EXPERIMENT.substeps，构造时读取） */
  readonly substeps: number;
  /** 每个物理子步的时长 = PHYSICS_DT / substeps（beforeStep / afterStep 收到的 dt） */
  readonly stepDt: number;
  /** 重力加速度的大小（PHYSICS_EXPERIMENT.gravity，构造时读取） */
  readonly g: number;
  /** 场地地面摩擦系数的倍数（PHYSICS_EXPERIMENT.floorFriction，构造时读取） */
  readonly floorFriction: number;

  constructor(R: Rapier, opts: { observeContacts?: boolean } = {}) {
    this.R = R;
    const X = PHYSICS_EXPERIMENT;
    this.substeps = Math.max(1, Math.round(X.substeps));
    this.stepDt = PHYSICS_DT / this.substeps;
    this.g = X.gravity;
    this.floorFriction = X.floorFriction;
    this.world = new R.World({ x: 0, y: -this.g, z: 0 });
    this.world.timestep = this.stepDt;
    this.world.integrationParameters.numSolverIterations = 8;
    this.events = new R.EventQueue(true);
    this.contacts = opts.observeContacts !== false ? new ContactService(this.world) : null;
  }

  /**
   * 以真实时间推进。最多补 6 个子步，防止掉帧时“死亡螺旋”。
   * 返回本帧实际执行的步数。
   */
  advance(realDt: number): number {
    this.accumulator = Math.min(this.accumulator + realDt, PHYSICS_DT * 6);
    let steps = 0;
    while (this.accumulator >= PHYSICS_DT) {
      this.step();
      this.accumulator -= PHYSICS_DT;
      steps++;
    }
    return steps;
  }

  /** 前进一个固定步（1/120 s）：依次执行 substeps 个物理子步，每个子步都完整调用 beforeStep / afterStep */
  step(): void {
    const h = this.stepDt;
    for (let i = 0; i < this.substeps; i++) {
      this.beforeStep?.(h);
      this.world.step(this.events);
      this.startedContacts.length = 0;
      this.events.drainCollisionEvents((h1, h2, started) => {
        if (started) this.startedContacts.push({ a: h1, b: h2 });
      });
      this.contacts?.observe();
      this.afterStep?.(h);
    }
  }

  /**
   * 渲染插值系数 0..1：距离下一个物理步还剩多少。
   * 物理固定 120Hz，屏幕帧间隔有抖动、慢动作时每帧只有 0/1 步，
   * 直接显示最新物理状态会一顿一顿（看起来像掉帧），按这个系数在上一步与当前步之间插值。
   */
  get alpha(): number {
    return Math.min(1, this.accumulator / PHYSICS_DT);
  }

  resetAccumulator(): void {
    this.accumulator = 0;
  }

  dispose(): void {
    this.events.free();
    this.world.free();
  }
}
