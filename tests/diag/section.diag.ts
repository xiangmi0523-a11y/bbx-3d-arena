import { mkdirSync, writeFileSync } from 'node:fs';
import * as THREE from 'three';
import { it } from 'vitest';
import { buildPartModel } from '../../src/game/beys/BeyVisualFactory';
import { assembleBey } from '../../src/game/beys/parts/assemble';

/**
 * 装配截面数据：沿给定角度的竖直半平面，逐个半径向上打射线，记录每个零件实体所占的 y 区间。
 * 输出给 scratchpad 里的绘图脚本画截面图。DIAG_LOADOUT=blade,disc,tip 可换组合。
 */
it('装配截面', () => {
  const [blade, disc, tip] = (process.env.DIAG_LOADOUT ?? 'gale-crescent,hex-lock,dome-ball').split(',');
  const spec = assembleBey({ blade, ratchet: disc, bit: tip });
  const hit = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
  const parts = (['bit', 'ratchet', 'blade'] as const).map((k) => {
    const g = buildPartModel(spec[k]);
    g.position.y = spec.layers[k].bottom;
    g.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.material = hit;
    });
    g.updateMatrixWorld(true);
    return { k, g };
  });
  const ray = new THREE.Raycaster();
  const angles = (process.env.DIAG_ANGLES ?? '0,30').split(',').map(Number);
  const out: Record<string, unknown> = { layers: spec.layers, ratchet: { radius: spec.ratchet.radius, height: spec.ratchet.height }, blade: { radius: spec.blade.radius }, slices: {} };
  for (const deg of angles) {
    const a = (deg * Math.PI) / 180;
    const cols: { r: number; part: string; ys: number[] }[] = [];
    for (let r = 0.001; r <= 0.56; r += 0.0015) {
      for (const { k, g } of parts) {
        ray.set(new THREE.Vector3(Math.cos(a) * r, -1, Math.sin(a) * r), new THREE.Vector3(0, 1, 0));
        const ys = ray
          .intersectObject(g, true)
          .map((h) => h.point.y)
          .sort((x, y) => x - y);
        // 去掉重合的交点（同一位置的两个面）
        const uniq = ys.filter((y, i) => i === 0 || y - ys[i - 1] > 1e-6);
        if (uniq.length) cols.push({ r, part: k, ys: uniq });
      }
    }
    (out.slices as Record<string, unknown>)[deg] = cols;
  }
  mkdirSync('test-results', { recursive: true });
  writeFileSync(`test-results/section-${blade}-${disc}.json`, JSON.stringify(out));
});
