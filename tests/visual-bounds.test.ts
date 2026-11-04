import { beforeAll, describe, expect, it } from 'vitest';
import { ARENA } from '../src/game/arena/arenaSpec';
import { BEY_TUNING } from '../src/game/beys/BeyPhysics';
import { buildPartModel } from '../src/game/beys/BeyVisualFactory';
import { assembleBey } from '../src/game/beys/parts/assemble';
import { listParts } from '../src/game/beys/parts/catalog';
import type { PartSpec } from '../src/game/beys/parts/types';
import { loadRapier, type Rapier } from '../src/game/physics/PhysicsWorld';
import { readColliders } from '../tools/inspect/colliders';
import { measureVisual, type VisualBounds } from '../tools/inspect/visualBounds';
import snapshot from './fixtures/physics-snapshot.json';

/**
 * P2.3 阶段 0：视觉模型与碰撞体的对齐检查（视觉重制的护栏）。
 *
 * 目标值（重制后的零件必须满足）：
 *  - Blade / Disc 视觉外径 ≤ 碰撞半径 × 1.03（刃尖与碰撞外沿对齐，火花出现在刃尖上）；
 *  - Blade 视觉顶部 ≤ 碰撞厚度 × 1.25（中心护罩允许略高出碰撞体）；
 *  - Disc 顶部的锁齿最多伸进 Blade 层 0.02（装配咬合）；
 *  - Tip 视觉外径 ≤ 最小的 Disc 碰撞半径（藏在 Disc 下方），顶部不超过自身高度；
 *  - 所有零件底面在本地 y = 0（±0.002），表面形心偏离转轴 ≤ 外径的 1%。
 *
 * 现有（P2.2.1）模型有几项超出目标，记在 LEGACY 里作为当前上限，避免现状变得更差；
 * 阶段 1、2 每重制一个零件，就从 LEGACY 里删掉它，让它按目标值检查。
 */

const TARGET = { radial: 1.03, bladeTop: 1.25, discLockRise: 0.02, centroid: 0.01, floor: 0.002 };

/** 现有模型的当前上限（测量值向上取整，单位与 TARGET 相同） */
const LEGACY: Record<string, { radial?: number; bladeTop?: number }> = {
  'blade:blaze-fang': { bladeTop: 1.395 },
  'blade:tidal-bastion': { radial: 1.045, bladeTop: 1.38 },
  'blade:titan-crown': { radial: 1.045, bladeTop: 1.355 },
  'disc:tri-lock': { radial: 1.045 },
  'disc:hex-lock': { radial: 1.04 },
  'disc:quad-edge': { radial: 1.04 },
  'disc:ring-guard': { radial: 1.04 },
};

const parts: PartSpec[] = [...listParts('blade'), ...listParts('disc'), ...listParts('tip')];
const bounds = new Map<string, VisualBounds>();
const key = (p: PartSpec) => `${p.kind}:${p.id}`;
const limit = (p: PartSpec, k: 'radial' | 'bladeTop') => LEGACY[key(p)]?.[k] ?? TARGET[k];
const minDiscRadius = Math.min(...listParts('disc').map((d) => d.radius));

beforeAll(() => {
  for (const p of parts) bounds.set(key(p), measureVisual(buildPartModel(p)));
});

describe('视觉模型包围盒（相对碰撞体）', () => {
  for (const p of parts) {
    it(`${key(p)} 底面在 y=0、形心在转轴上`, () => {
      const b = bounds.get(key(p))!;
      expect(Math.abs(b.yMin)).toBeLessThanOrEqual(TARGET.floor);
      expect(b.centroidOffset).toBeLessThanOrEqual(b.radial * TARGET.centroid);
      expect(b.meshes).toBeGreaterThan(0);
    });
  }

  for (const p of listParts('blade')) {
    it(`blade:${p.id} 外径与高度在碰撞体范围内`, () => {
      const b = bounds.get(key(p))!;
      expect(b.radial / p.radius).toBeLessThanOrEqual(limit(p, 'radial'));
      expect(b.yMax / p.height).toBeLessThanOrEqual(limit(p, 'bladeTop'));
    });
  }

  for (const p of listParts('disc')) {
    it(`disc:${p.id} 外径在碰撞体范围内，锁齿只略伸进 Blade 层`, () => {
      const b = bounds.get(key(p))!;
      expect(b.radial / p.radius).toBeLessThanOrEqual(limit(p, 'radial'));
      expect(b.yMax - p.height).toBeLessThanOrEqual(TARGET.discLockRise + 1e-6);
    });
  }

  for (const p of listParts('tip')) {
    it(`tip:${p.id} 藏在 Disc 下方、不高出自身层`, () => {
      const b = bounds.get(key(p))!;
      expect(b.radial).toBeLessThanOrEqual(minDiscRadius);
      expect(b.yMax).toBeLessThanOrEqual(p.height + 0.005);
    });
  }

  it('LEGACY 里只有真实存在的部件', () => {
    const ids = new Set(parts.map(key));
    for (const k of Object.keys(LEGACY)) expect(ids.has(k)).toBe(true);
  });
});

describe('碰撞体与装配层（读自真实 Rapier 刚体）', () => {
  let R: Rapier;
  beforeAll(async () => {
    R = await loadRapier();
  });

  it('全部 64 种组合：碰撞体尺寸 = 部件参数，位置 = 装配层', () => {
    for (const blade of listParts('blade'))
      for (const disc of listParts('disc'))
        for (const tip of listParts('tip')) {
          const spec = assembleBey({ blade: blade.id, disc: disc.id, tip: tip.id });
          const [ball, shaft, d, bl] = readColliders(R, spec);
          const L = spec.layers;
          expect(ball.shape).toBe('ball');
          expect(ball.radius).toBeCloseTo(tip.contactRadius, 5);
          expect(ball.centerY - ball.radius).toBeCloseTo(0, 5); // 接地点 = 本地原点
          expect(shaft.centerY + shaft.halfHeight).toBeCloseTo(L.tip.top, 5);
          expect(d.radius).toBeCloseTo(disc.radius, 5);
          expect(d.centerY - d.halfHeight).toBeCloseTo(L.disc.bottom, 5);
          expect(d.centerY + d.halfHeight).toBeCloseTo(L.disc.top, 5);
          expect(bl.radius).toBeCloseTo(blade.radius, 5);
          expect(bl.centerY - bl.halfHeight).toBeCloseTo(L.blade.bottom, 5);
          expect(bl.centerY + bl.halfHeight).toBeCloseTo(L.blade.top, 5);
        }
  });
});

describe('物理参数冻结（视觉重制不得修改）', () => {
  // 快照生成于 P2.2.1（cc7863f）。确需调物理时，必须在单独的阶段里经用户批准后再更新快照。
  /** 部件里除 visual / 名称 / 描述 以外的全部字段 */
  const physicsOf = (p: PartSpec) =>
    Object.fromEntries(Object.entries(p).filter(([k]) => !['visual', 'name', 'desc', 'code'].includes(k)));

  it('与 tests/fixtures/physics-snapshot.json 完全一致', () => {
    const now = {
      parts: Object.fromEntries(parts.map((p) => [key(p), physicsOf(p)])),
      tuning: BEY_TUNING,
      arena: ARENA,
    };
    // JSON 往返一次，去掉 undefined 字段等差异
    expect(JSON.parse(JSON.stringify(now))).toEqual(snapshot);
  });
});
