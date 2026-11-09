/// <reference types="node" />
/**
 * ContactService 开销拆分（固定物理状态上重复调用）：observe 全量 vs 只枚举接触对 vs 只遍历 Rapier 流形，
 * 用来区分本服务自身逻辑与 Rapier JS/WASM 绑定（每个流形创建 RawContactManifold 包装对象）的开销。
 *   npx vitest run --config vitest.diag.config.ts --execArgv=--expose-gc tests/diag/contact-service-cost.diag.ts
 */
import { it } from 'vitest';
import { loadRapier } from '../../src/game/physics/PhysicsWorld';
import { seeded } from '../motion/motionSim';
import { scenariosV2, setup, type R as RT } from './stallprobe2.shared';
const log = (...a: unknown[]) => process.stderr.write(a.map((x) => (typeof x === 'object' ? JSON.stringify(x) : String(x))).join(' ') + '\n');
it('ContactService 开销拆分', async () => {
  const R = (await loadRapier()) as RT;
  const sc = scenariosV2().find((s) => s.name === 'AvD#1')!;
  Math.random = seeded(sc.seed);
  const { pw, A, B } = setup(R, sc, { observeContacts: true });
  const cs = pw.contacts!;
  while (cs.step < 600) pw.step();
  const np = pw.world.narrowPhase;
  const raw = (np as any).raw;
  const cols = [...A.colliders, ...B.colliders].map((c) => c.handle);
  const gc = (globalThis as any).gc as () => void;
  const T = (name: string, f: () => void) => { for (let i = 0; i < 100; i++) f(); gc(); const h0 = process.memoryUsage().heapUsed; for (let i = 0; i < 1000; i++) f(); log(name, 'bytes/call', Math.round((process.memoryUsage().heapUsed - h0) / 1000)); for (let i = 0; i < 300; i++) f(); const t = process.hrtime.bigint(); const K = 3000; for (let i = 0; i < K; i++) f(); log(name, (Number(process.hrtime.bigint() - t) / K / 1000).toFixed(2), 'us'); };
  T('observe', () => cs.observe());
  T('enum only', () => { for (const h of cols) np.contactPairsWith(h, () => {}); });
  let nm = 0;
  T('enum+contactPair numContacts', () => { nm = 0; for (const h of cols) np.contactPairsWith(h, (h2) => np.contactPair(h, h2, (m) => { nm++; m.numContacts(); })); });
  log('manifolds', nm);
  T('raw pair numManifolds only', () => { for (const h of cols) np.contactPairsWith(h, (h2) => { const p = raw.contact_pair(h, h2); if (p) { p.numContactManifolds(); p.free(); } }); });
  T('raw manifold loop', () => { for (const h of cols) np.contactPairsWith(h, (h2) => { const p = raw.contact_pair(h, h2); if (p) { const n = p.numContactManifolds(); for (let i = 0; i < n; i++) { const m = p.contactManifold(i); m.num_contacts(); m.free(); } p.free(); } }); });
});
