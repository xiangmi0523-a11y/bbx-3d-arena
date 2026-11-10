import type RAPIER from '@dimforge/rapier3d-compat';
import type { PhysicsWorld } from '../physics/PhysicsWorld';
import { ARENA, type ArenaSpec, floorHeight, pocketAtAngle, rimHeight } from './arenaSpec';

/**
 * 竞技场碰撞体（与视觉模型完全分离）：
 *  - 碗形地面：三角网格（trimesh），由 floorHeight 剖面旋转生成；
 *  - 外墙：一圈长方体分段，口袋处留空；
 *  - 口袋：底板 + 三面挡墙；
 *  - 台面：场地外的大平面，接住飞出场外的陀螺。
 */
export interface ArenaColliders {
  floor: RAPIER.Collider;
  walls: RAPIER.Collider[];
  pockets: RAPIER.Collider[];
  table: RAPIER.Collider;
  /** 所有属于场地的碰撞体句柄 */
  handles: Set<number>;
}

export const TABLE_Y = -1.2;

export function buildFloorMesh(spec: ArenaSpec, rings: number, segments: number) {
  const vertices: number[] = [0, floorHeight(0, spec), 0];
  const indices: number[] = [];
  for (let i = 1; i <= rings; i++) {
    const r = (spec.radius + 0.25) * (i / rings);
    const y = floorHeight(r, spec);
    for (let j = 0; j < segments; j++) {
      const a = (j / segments) * Math.PI * 2;
      vertices.push(Math.cos(a) * r, y, Math.sin(a) * r);
    }
  }
  const idx = (ring: number, seg: number) => 1 + (ring - 1) * segments + (seg % segments);
  for (let j = 0; j < segments; j++) {
    // 中心扇形（逆时针朝上）
    indices.push(0, idx(1, j + 1), idx(1, j));
  }
  for (let i = 1; i < rings; i++) {
    for (let j = 0; j < segments; j++) {
      const a = idx(i, j);
      const b = idx(i, j + 1);
      const c = idx(i + 1, j);
      const d = idx(i + 1, j + 1);
      indices.push(a, b, c, b, d, c);
    }
  }
  return { vertices: new Float32Array(vertices), indices: new Uint32Array(indices) };
}

export function createArenaPhysics(pw: PhysicsWorld, spec: ArenaSpec = ARENA): ArenaColliders {
  const { R, world } = pw;
  const handles = new Set<number>();
  const fixed = world.createRigidBody(R.RigidBodyDesc.fixed());

  // 1) 碗形地面
  const mesh = buildFloorMesh(spec, 36, 96);
  const floor = world.createCollider(
    R.ColliderDesc.trimesh(mesh.vertices, mesh.indices).setFriction(0.5).setRestitution(0.15),
    fixed,
  );
  handles.add(floor.handle);

  // 2) 外墙（口袋处断开）
  const rim = rimHeight(spec);
  const walls: RAPIER.Collider[] = [];
  const segs = 72;
  const segArc = (Math.PI * 2 * (spec.radius + spec.wallThickness / 2)) / segs;
  const wallBottom = rim - 0.4;
  const wallTop = rim + spec.wallHeight;
  for (let i = 0; i < segs; i++) {
    const a = ((i + 0.5) / segs) * Math.PI * 2;
    if (pocketAtAngle(a, spec)) continue;
    const rc = spec.radius + spec.wallThickness / 2;
    const half = (wallTop - wallBottom) / 2;
    const desc = R.ColliderDesc.cuboid(spec.wallThickness / 2, half, segArc / 2 + 0.02)
      .setTranslation(Math.cos(a) * rc, wallBottom + half, Math.sin(a) * rc)
      .setRotation(yawQuat(-a))
      .setFriction(0.25)
      .setRestitution(0.5);
    const c = world.createCollider(desc, fixed);
    walls.push(c);
    handles.add(c.handle);
  }

  // 3) 口袋
  const pockets: RAPIER.Collider[] = [];
  for (const p of spec.pockets) {
    const floorY = rim - p.drop;
    const rMid = spec.radius + p.depth / 2;
    const cx = Math.cos(p.angle);
    const cz = Math.sin(p.angle);
    const q = yawQuat(-p.angle);
    const add = (desc: RAPIER.ColliderDesc) => {
      const c = world.createCollider(desc.setRotation(q), fixed);
      pockets.push(c);
      handles.add(c.handle);
    };
    // 底板（略微向内伸进墙下，避免缝隙）
    add(
      R.ColliderDesc.cuboid(p.depth / 2 + 0.2, 0.1, p.width / 2 + 0.1)
        .setTranslation(cx * (rMid - 0.1), floorY - 0.1, cz * (rMid - 0.1))
        .setFriction(0.9)
        .setRestitution(0.05),
    );
    const h = (wallTop - floorY) / 2;
    // 后墙
    const rBack = spec.radius + p.depth + 0.1;
    add(
      R.ColliderDesc.cuboid(0.1, h, p.width / 2 + 0.2)
        .setTranslation(cx * rBack, floorY + h, cz * rBack)
        .setRestitution(0.2),
    );
    // 两侧墙
    const tx = -cz;
    const tz = cx;
    for (const s of [-1, 1]) {
      const off = s * (p.width / 2 + 0.1);
      add(
        R.ColliderDesc.cuboid(p.depth / 2 + 0.1, h, 0.1)
          .setTranslation(cx * rMid + tx * off, floorY + h, cz * rMid + tz * off)
          .setRestitution(0.2),
      );
    }
  }

  // 4) 台面
  const table = world.createCollider(
    R.ColliderDesc.cuboid(30, 0.2, 30).setTranslation(0, TABLE_Y - 0.2, 0).setFriction(0.9),
    fixed,
  );
  handles.add(table.handle);

  // 只读接触观测的身份表（未开启观测时为空操作）
  const cs = pw.contacts;
  if (cs) {
    cs.registerStatic(floor, 'arena', 'floor');
    walls.forEach((c, i) => cs.registerStatic(c, 'arena', `wall#${i}`));
    pockets.forEach((c, i) => cs.registerStatic(c, 'arena', `pocket#${Math.floor(i / 4)}.${['base', 'back', 'side0', 'side1'][i % 4]}`));
    cs.registerStatic(table, 'arena', 'table');
  }

  return { floor, walls, pockets, table, handles };
}

/** 绕 Y 轴旋转的四元数 */
export function yawQuat(angle: number) {
  return { x: 0, y: Math.sin(angle / 2), z: 0, w: Math.cos(angle / 2) };
}
