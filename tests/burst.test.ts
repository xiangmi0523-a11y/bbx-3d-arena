import { describe, expect, it } from 'vitest';
import { BurstMeter, BurstObserver, EpisodeTracker } from '../src/game/battle/burst';

const DT = 1 / 120;

describe('爆裂系统：接触段（纯逻辑）', () => {
  it('确认接触 = 法向冲量 > 0；间隔 ≤ 0.1 s（12 步）属于同一段，超过即结束', () => {
    const t = new EpisodeTracker(DT);
    expect(t.holdSteps).toBe(12);
    const closed = [];
    const imp = new Map<number, number>([
      [10, 2],
      [11, 1],
      [23, 0.5], // 距上一次 12 步：同一段
      [40, 3], // 距上一次 17 步：新的一段
    ]);
    for (let s = 0; s < 80; s++) {
      const c = t.step(s, imp.get(s) ?? 0);
      if (c) closed.push({ ...c });
    }
    expect(closed.length).toBe(2);
    expect(closed[0]).toMatchObject({ index: 1, startStep: 10, lastStep: 23, touchSteps: 3, sumImpulse: 3.5, peakImpulse: 2 });
    expect(closed[1]).toMatchObject({ index: 2, startStep: 40, lastStep: 40, touchSteps: 1, sumImpulse: 3 });
    // 段在最后一次接触 12 步之后的那一步结束
    expect(t.current).toBeNull();
  });

  it('中途漏调用的步也按步号判断间隔；flush 收尾进行中的段', () => {
    const t = new EpisodeTracker(DT);
    t.step(0, 1);
    const c = t.step(30, 2); // 间隔 30 步：先结束上一段，再开新段
    expect(c?.sumImpulse).toBe(1);
    expect(t.current?.startStep).toBe(30);
    expect(t.flush()?.sumImpulse).toBe(2);
    expect(t.flush()).toBeNull();
  });
});

describe('爆裂系统：应力（纯逻辑）', () => {
  it('Δstress = k × 冲量 / (lock × burstGuard)：抗爆组合越弱积累越快，回合内不衰减', () => {
    const m = new BurstMeter([{ lock: 0.5, burstGuard: 0.5 }, { lock: 0.85, burstGuard: 0.9 }], 0.01);
    m.add(0, 5);
    expect(m.stress[0]).toBeCloseTo((0.01 * 5) / 0.25, 9);
    expect(m.stress[1]).toBeCloseTo((0.01 * 5) / (0.85 * 0.9), 9);
    for (let s = 1; s < 100; s++) m.add(s, 0); // 没有接触：不变
    expect(m.stress[0]).toBeCloseTo(0.2, 9);
  });

  it('达到阈值即爆裂、只记录一次；同一步双方都达到阈值时两者都记录（同时爆裂）', () => {
    const a = new BurstMeter([{ lock: 0.5, burstGuard: 0.5 }, { lock: 1, burstGuard: 1 }], 0.05);
    let hit: number[] = [];
    for (let s = 0; s < 10 && !hit.length; s++) hit = a.add(s, 1);
    expect(hit).toEqual([0]);
    expect(a.burstStep).toBe(4); // 5 × 0.05 / 0.25 = 1
    expect(a.add(5, 100)).toEqual([]); // 爆裂后不再累积
    expect(a.stress[0]).toBe(1);

    const b = new BurstMeter([{ lock: 1, burstGuard: 1 }, { lock: 1, burstGuard: 1 }], 0.5);
    expect(b.add(0, 2)).toEqual([0, 1]);
  });

  it('未标定（k = null）：只观测，永不爆裂', () => {
    const m = new BurstMeter([{ lock: 0.5, burstGuard: 0.35 }, { lock: 0.5, burstGuard: 0.35 }], null);
    expect(m.active).toBe(false);
    for (let s = 0; s < 1000; s++) expect(m.add(s, 1e6)).toEqual([]);
    expect(m.stress).toEqual([0, 0]);
  });

  it('组合：段结束时的累计增量 = k × Σ段冲量 / (lock × burstGuard)；单段最大增量用于结算', () => {
    const o = new BurstObserver(DT, [{ lock: 0.5, burstGuard: 0.5 }, { lock: 0.75, burstGuard: 0.85 }], 0.002);
    const pulses: [number, number][] = [
      [5, 3],
      [6, 4],
      [7, 1],
      [60, 10],
    ];
    const at = new Map(pulses);
    for (let s = 0; s < 100; s++) o.step(s, at.get(s) ?? 0);
    o.finish();
    expect(o.closed.map((e) => e.sumImpulse)).toEqual([8, 10]);
    expect(o.meter.stress[0]).toBeCloseTo((0.002 * 18) / 0.25, 9);
    expect(o.meter.peakEpisodeDelta[0]).toBeCloseTo((0.002 * 10) / 0.25, 9);
    expect(o.maxEpisodeImpulse).toBe(10);
    expect(o.episodeCount).toBe(2);
  });
});
