import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { ARENA, rimHeight } from '../src/game/arena/arenaSpec';
import { BattleCamera } from '../src/game/camera/BattleCamera';
import { simulateBattle } from './sim';

/**
 * P2.3.1 镜头：用真实对战轨迹驱动战斗镜头（iPhone 横屏宽高比），逐帧检查
 *  - 遮挡：镜头到每台陀螺的视线是否穿过护墙（墙顶 = 碗边高度 + 墙高）；
 *  - 构图：两台陀螺是否都在画面中央 85% 区域内。
 */
export async function cameraStats(aspect = 844 / 390, runs = 4) {
  const wallTop = rimHeight(ARENA) + ARENA.wallHeight;
  let frames = 0;
  let occluded = 0;
  let outOfFrame = 0;
  let minElev = Infinity;
  let maxElev = -Infinity;
  let sumElev = 0;
  for (let i = 0; i < runs; i++) {
    const aim = ((i % 3) - 1) * 0.3;
    const cam = new BattleCamera(aspect);
    cam.setMode('battle', true);
    const targets = [0, 1].map(() => ({ position: new THREE.Vector3(), velocity: new THREE.Vector3() }));
    let first = true;
    const r = await simulateBattle({
      player: { power: 0.6 + (i % 3) * 0.15, aim, tilt: 0 },
      rival: { power: 0.8, aim: -aim, tilt: 0 },
      maxSeconds: 30,
      every: 4,
      trace: (_t, b) => {
        const beys = [b.beys.player!, b.beys.rival!];
        beys.forEach((bey, k) => {
          const p = bey.body.translation();
          const v = bey.body.linvel();
          targets[k].position.set(p.x, p.y, p.z);
          targets[k].velocity.set(v.x, v.y, v.z);
        });
        cam.update(1 / 30, targets, first);
        first = false;
        if (_t < 1.5) return; // 发射落地阶段不计
        const c = cam.camera.position;
        cam.camera.updateMatrixWorld(true);
        for (const t of targets) {
          frames++;
          // 视线采样：从镜头到陀螺顶部
          const top = t.position.clone().setY(t.position.y + 0.25);
          let hit = false;
          for (let s = 0; s <= 1; s += 0.02) {
            const x = c.x + (top.x - c.x) * s;
            const z = c.z + (top.z - c.z) * s;
            const y = c.y + (top.y - c.y) * s;
            const rr = Math.hypot(x, z);
            if (rr > ARENA.radius - 0.02 && rr < ARENA.radius + 0.45 && y < wallTop) hit = true;
          }
          if (hit) occluded++;
          const ndc = top.clone().project(cam.camera);
          if (Math.abs(ndc.x) > 0.85 || Math.abs(ndc.y) > 0.85) outOfFrame++;
          const dx = Math.hypot(top.x - c.x, top.z - c.z);
          const el = Math.atan2(c.y - top.y, dx);
          minElev = Math.min(minElev, el);
          maxElev = Math.max(maxElev, el);
          sumElev += el;
        }
      },
    });
    r.dispose();
  }
  return { frames, occluded: occluded / frames, outOfFrame: outOfFrame / frames, minElevDeg: (minElev * 180) / Math.PI, maxElevDeg: (maxElev * 180) / Math.PI, meanElevDeg: (sumElev / frames * 180) / Math.PI };
}

describe('战斗镜头（P2.3.1）', () => {
  it('真实对战轨迹下，护墙不遮挡陀螺，两台都在画面中央区域', async () => {
    const s = await cameraStats();
    // P2.3.1 之前（俯角 25.6°、不考虑墙高）：约 35–37% 的帧视线穿过护墙
    expect(s.occluded, JSON.stringify(s)).toBeLessThan(0.01);
    expect(s.outOfFrame, JSON.stringify(s)).toBeLessThan(0.02);
    // 不是靠变成正俯视解决的：平均俯角仍在 35° 以内
    expect(s.meanElevDeg, JSON.stringify(s)).toBeLessThan(35);
  }, 120000);
});
