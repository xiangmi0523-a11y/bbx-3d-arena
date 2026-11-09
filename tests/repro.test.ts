/// <reference types="node" />
/**
 * 阶段 1 · 可重复物理测试基线（确定性回归）。
 *
 * golden（tests/fixtures/repro-golden.json）由 tests/diag/repro.diag.ts 在 B1 正式基线（main 2d6131f）上生成，
 * 记录 180 个固定种子场景每个通道的全程哈希、步数、终局与计数。任何物理 / AI / 接触 / 战斗规则或参数的变化
 * 都会让对应场景不一致；这是预期的“行为变化报警”，需要在提交说明里解释并经批准后再重新生成 golden。
 *
 * 常规运行只抽每个分组的第一个场景（约 2 秒），REPRO_FULL=1 时比对全部 180 场（约 50 秒）。
 */
import { beforeAll, describe, expect, it } from 'vitest';
import golden from './fixtures/repro-golden.json';
import { scenariosV2 } from './diag/stallprobe2.shared';
import { compareTraces, summarize, type TraceSummary } from './repro/compare';
import { configFingerprint } from './repro/config';
import { rapier, recordRun } from './repro/recorder';
import { simulateBattle } from './sim';

type R = Awaited<ReturnType<typeof rapier>>;
let R: R;
const G = golden as unknown as { generatedFrom: string; config: string; runs: TraceSummary[] };
const all = scenariosV2();
const sample = all.filter((s, i) => all.findIndex((x) => x.group === s.group) === i);
const full = !!process.env.REPRO_FULL;

beforeAll(async () => {
  R = await rapier();
});

describe('阶段 1：可重复物理测试基线', () => {
  it('场景集固定：180 场、名称唯一、种子与 golden 一致', () => {
    expect(all.length).toBe(180);
    expect(new Set(all.map((s) => s.name)).size).toBe(180);
    const g = new Map(G.runs.map((r) => [r.name, r.seed]));
    for (const s of all) expect(g.get(s.name), s.name).toBe(s.seed);
  });

  it('关键物理参数指纹与 golden 一致（参数、求解器设置、Rapier 版本未变）', () => {
    expect(configFingerprint(R)).toBe(G.config);
  });

  it('同一进程内重复运行逐位一致；推进过程不消耗随机数、不读取时间或系统随机源', () => {
    for (const sc of sample) {
      const a = recordRun(R, sc, { keyframes: true });
      const b = recordRun(R, sc, { keyframes: true });
      expect(JSON.stringify(b), sc.name).toBe(JSON.stringify(a));
      const rr = a.random.run;
      expect(rr.seededRandomCalls, `${sc.name} 推进中 Math.random`).toBe(0);
      expect(rr.bypass, `${sc.name} 推进中时间/系统随机`).toEqual({ performanceNow: 0, dateNow: 0, cryptoRandom: 0 });
      expect(a.random.setup.bypass, `${sc.name} 搭建中时间/系统随机`).toEqual({ performanceNow: 0, dateNow: 0, cryptoRandom: 0 });
      expect(a.random.setup.seededRandomCalls, `${sc.name} 搭建中的随机调用全部经过种子`).toBeGreaterThan(0);
    }
  }, 120000);

  it(`与 golden 逐场一致（${full ? '全部 180 场' : `每组第一场，共 ${sample.length} 场；REPRO_FULL=1 比对全部`}）`, () => {
    const list = full ? all : sample;
    const runs = list.map((sc) => summarize(recordRun(R, sc, { keyframes: false })));
    const want = G.runs.filter((g) => list.some((s) => s.name === g.name));
    const rep = compareTraces(runs, want);
    expect(rep.missing).toEqual([]);
    expect(rep.diffs, JSON.stringify(rep.diffs.slice(0, 3), null, 1)).toEqual([]);
    expect(rep.identical).toBe(list.length);
  }, 600000);

  it(`开启只读 ContactService 时与 golden 逐场一致（${full ? '全部 180 场' : `每组第一场，共 ${sample.length} 场`}）：观测不改变物理、AI、接触与战斗`, () => {
    const list = full ? all : sample;
    const runs = list.map((sc) => recordRun(R, sc, { keyframes: false, observeContacts: true }));
    for (const r of runs) expect(r.contactService, r.name).toBeDefined();
    const want = G.runs.filter((g) => list.some((s) => s.name === g.name));
    const rep = compareTraces(runs.map(summarize), want);
    expect(rep.missing).toEqual([]);
    expect(rep.diffs, JSON.stringify(rep.diffs.slice(0, 3), null, 1)).toEqual([]);
    expect(rep.identical).toBe(list.length);
    for (const r of runs) expect(r.random.run.bypass, `${r.name} 开启观测后推进中读取时间/系统随机`).toEqual({ performanceNow: 0, dateNow: 0, cryptoRandom: 0 });
  }, 600000);

  it('测试辅助 simulateBattle 不再依赖全局随机：同一组参数两次运行结果相同', async () => {
    const opts = { player: { power: 0.8, aim: 0.2, tilt: 0 }, rival: { power: 0.8, aim: -0.1, tilt: 0 }, maxSeconds: 20 };
    const a = await simulateBattle(opts);
    const b = await simulateBattle(opts);
    const sig = (r: typeof a) => JSON.stringify({ steps: r.steps, impacts: r.impactLog, result: r.battle.result, spin: [r.battle.beys.player!.spin, r.battle.beys.rival!.spin] });
    expect(sig(b)).toBe(sig(a));
    a.dispose();
    b.dispose();
  }, 60000);
});
