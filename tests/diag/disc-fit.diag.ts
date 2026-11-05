import { writeFileSync, mkdirSync } from 'node:fs';
import * as THREE from 'three';
import { it } from 'vitest';
import { buildPartModel } from '../../src/game/beys/BeyVisualFactory';
import type { AssembledBey } from '../../src/game/beys/parts/assemble';
import { assembleBey } from '../../src/game/beys/parts/assemble';
import { listParts } from '../../src/game/beys/parts/catalog';
import { findCoplanar, measureSeat } from '../../tools/inspect/fit';

/** 与 createBeyVisual 相同的装配（不含需要 Canvas 的残影环） */
function assembled(spec: AssembledBey): THREE.Group {
  const root = new THREE.Group();
  for (const k of ['tip', 'disc', 'blade'] as const) {
    const slot = new THREE.Group();
    slot.name = k;
    slot.add(buildPartModel(spec[k]));
    slot.position.y = spec.layers[k].bottom;
    root.add(slot);
  }
  return root;
}

/** P2.3 阶段 2 装配诊断：npx vitest run --config vitest.diag.config.ts tests/diag/disc-fit.diag.ts */
it('Disc 装配关系与共面检查', () => {
  const label = process.env.DIAG_LABEL ?? 'now';
  const out: Record<string, unknown> = {};
  for (const blade of listParts('blade')) {
    for (const disc of ['hex-lock', 'tri-lock']) {
      const spec = assembleBey({ blade: blade.id, disc, tip: 'dome-ball' });
      const seat = measureSeat(spec);
      const cop = findCoplanar(assembled(spec));
      out[`${blade.id}+${disc}`] = { seat, coplanar: cop };
    }
  }
  // 单个 Disc 自身的共面
  for (const disc of listParts('disc')) {
    const spec = assembleBey({ blade: 'gale-crescent', disc: disc.id, tip: 'dome-ball' });
    const g = new THREE.Group();
    g.add(buildPartModel(spec.disc));
    out[`disc-only:${disc.id}`] = findCoplanar(g);
  }
  mkdirSync('test-results', { recursive: true });
  writeFileSync(`test-results/disc-fit-${label}.json`, JSON.stringify(out, null, 2));
});
