import { mkdirSync, writeFileSync } from 'node:fs';
import { it } from 'vitest';
import { buildPartModel } from '../../src/game/beys/BeyVisualFactory';
import { listParts } from '../../src/game/beys/parts/catalog';
import type { PartSpec } from '../../src/game/beys/parts/types';
import { measureVisual } from '../../tools/inspect/visualBounds';

/**
 * 视觉模型基线报告：每个零件的视觉外径 / 高度与碰撞体的比值、网格 / 三角形 / 材质数。
 * 输出 test-results/visual-bounds.json（DIAG_LABEL 可改文件名后缀），P2.3 各阶段前后对比用。
 *   npx vitest run --config vitest.diag.config.ts tests/diag/visual-report.diag.ts
 */
it('visual report', () => {
  const parts: PartSpec[] = [...listParts('blade'), ...listParts('disc'), ...listParts('tip')];
  const rows = parts.map((p) => {
    const b = measureVisual(buildPartModel(p));
    const physR = p.kind === 'tip' ? p.contactRadius : p.radius;
    return {
      part: `${p.kind}:${p.id}`,
      physRadius: physR,
      physHeight: p.height,
      visualRadial: +b.radial.toFixed(4),
      radialRatio: p.kind === 'tip' ? null : +(b.radial / physR).toFixed(4),
      visualTop: +b.yMax.toFixed(4),
      topRatio: +(b.yMax / p.height).toFixed(4),
      visualBottom: +b.yMin.toFixed(5),
      centroidOffset: +b.centroidOffset.toFixed(5),
      meshes: b.meshes,
      triangles: b.triangles,
      materials: b.materials,
      transparentMeshes: b.transparentMeshes,
    };
  });
  mkdirSync('test-results', { recursive: true });
  const label = process.env.DIAG_LABEL ? `-${process.env.DIAG_LABEL}` : '';
  writeFileSync(`test-results/visual-bounds${label}.json`, JSON.stringify(rows, null, 1));
});
