import type RAPIER from '@dimforge/rapier3d-compat';
import { BeyPhysics } from '../../src/game/beys/BeyPhysics';
import type { AssembledBey } from '../../src/game/beys/parts/assemble';
import { PhysicsWorld, type Rapier } from '../../src/game/physics/PhysicsWorld';

/** 从真实的 Rapier 刚体上读出来的碰撞体形状（只读，不复制 BeyPhysics 的建形逻辑） */
export interface ColliderInfo {
  label: 'tip-ball' | 'tip-shaft' | 'disc' | 'blade';
  shape: 'ball' | 'cylinder';
  radius: number;
  /** 圆柱半高（球为 0） */
  halfHeight: number;
  /** 中心在陀螺本地坐标中的高度 */
  centerY: number;
  mass: number;
}

const LABELS: ColliderInfo['label'][] = ['tip-ball', 'tip-shaft', 'disc', 'blade'];

/**
 * 在一个临时物理世界里按游戏同样的方式构建 BeyPhysics（原点、零速度、零转速、无倾角），
 * 读出各碰撞体，然后销毁。碰撞体顺序与 BeyPhysics 构造函数一致：接地球、轴杆、Disc、Blade。
 */
export function readColliders(R: Rapier, spec: AssembledBey): ColliderInfo[] {
  const pw = new PhysicsWorld(R);
  try {
    const bp = new BeyPhysics(pw, spec, { position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, spin: 0 });
    return bp.colliders.map((c: RAPIER.Collider, i) => {
      const isBall = c.shapeType() === R.ShapeType.Ball;
      return {
        label: LABELS[i],
        shape: isBall ? 'ball' : 'cylinder',
        radius: c.radius(),
        halfHeight: isBall ? 0 : c.halfHeight(),
        centerY: c.translation().y,
        mass: c.mass(),
      };
    });
  } finally {
    pw.dispose();
  }
}
