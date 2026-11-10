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

  constructor(R: Rapier, opts: { observeContacts?: boolean } = {}) {
    this.R = R;
    this.world = new R.World({ x: 0, y: GRAVITY, z: 0 });
    this.world.timestep = PHYSICS_DT;
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

  step(): void {
    this.beforeStep?.(PHYSICS_DT);
    this.world.step(this.events);
    this.startedContacts.length = 0;
    this.events.drainCollisionEvents((h1, h2, started) => {
      if (started) this.startedContacts.push({ a: h1, b: h2 });
    });
    this.contacts?.observe();
    this.afterStep?.(PHYSICS_DT);
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
