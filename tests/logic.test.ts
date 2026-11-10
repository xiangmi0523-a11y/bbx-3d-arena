import { describe, expect, it } from 'vitest';
import { ARENA, floorHeight, pocketAtAngle } from '../src/game/arena/arenaSpec';
import { assembleBey, swapPart } from '../src/game/beys/parts/assemble';
import { PLAYER_LOADOUT, RIVAL_LOADOUT, listParts } from '../src/game/beys/parts/catalog';
import { computeLaunch, launchPoint } from '../src/game/launcher/launch';
import { computePower, PullStringGesture } from '../src/game/launcher/PullStringGesture';

describe('部件组装', () => {
  it('Blade/Disc/Tip 从下到上堆叠', () => {
    const b = assembleBey(PLAYER_LOADOUT);
    expect(b.layers.bit.bottom).toBe(0);
    expect(b.layers.ratchet.bottom).toBeCloseTo(b.layers.bit.top);
    expect(b.layers.blade.bottom).toBeCloseTo(b.layers.ratchet.top);
    expect(b.totalMass).toBeCloseTo(b.blade.mass + b.ratchet.mass + b.bit.mass);
  });
  it('可以单独替换任意部件', () => {
    const swapped = assembleBey(swapPart(PLAYER_LOADOUT, 'bit', RIVAL_LOADOUT.bit));
    expect(swapped.blade.id).toBe(PLAYER_LOADOUT.blade);
    expect(swapped.bit.id).toBe(RIVAL_LOADOUT.bit);
  });
  it('未知部件抛错', () => {
    expect(() => assembleBey({ ...PLAYER_LOADOUT, blade: 'nope' })).toThrow();
  });
  it('目录里每类至少两个部件', () => {
    for (const k of ['blade', 'ratchet', 'bit'] as const) expect(listParts(k).length).toBeGreaterThanOrEqual(2);
  });
});

describe('竞技场', () => {
  it('碗面中心最低、向外单调升高', () => {
    let prev = -1;
    for (let r = 0; r <= ARENA.radius; r += 0.1) {
      const h = floorHeight(r);
      expect(h).toBeGreaterThanOrEqual(prev);
      prev = h;
    }
  });
  it('口袋识别：极限口袋在远端，两侧为出界口袋', () => {
    expect(pocketAtAngle(-Math.PI / 2)?.kind).toBe('xtreme');
    expect(pocketAtAngle(Math.PI / 6)?.kind).toBe('over');
    expect(pocketAtAngle(0)).toBeUndefined();
  });
});

describe('拉绳发射手势', () => {
  it('拉得太短视为取消', () => {
    const g = new PullStringGesture({ maxPull: 200 });
    g.start(0, 0, 0);
    g.move(0, 20, 50);
    expect(g.end(60)).toBeNull();
  });
  it('拉得越长越快，力度越大', () => {
    const slow = new PullStringGesture({ maxPull: 200 });
    slow.start(0, 0, 0);
    for (let t = 1; t <= 20; t++) slow.move(0, t * 5, t * 50);
    const a = slow.end(1001)!;
    const fast = new PullStringGesture({ maxPull: 200 });
    fast.start(0, 0, 0);
    for (let t = 1; t <= 10; t++) fast.move(0, t * 20, t * 10);
    const b = fast.end(101)!;
    expect(a.power).toBeGreaterThan(0.3);
    expect(b.power).toBeGreaterThan(a.power);
  });
  it('左右偏移控制方向', () => {
    const g = new PullStringGesture({ maxPull: 200 });
    g.start(0, 0, 0);
    g.move(-100, 150, 50);
    expect(g.end(60)!.aim).toBeLessThan(-0.5);
  });
  it('力度范围 0..1', () => {
    expect(computePower(1, 1)).toBeLessThanOrEqual(1);
    expect(computePower(0, 0)).toBe(0);
  });
  it('发射参数：力度越大转速和速度越大', () => {
    const spec = assembleBey(PLAYER_LOADOUT);
    const lo = computeLaunch(spec, 'player', { power: 0.2, aim: 0, tilt: 0 });
    const hi = computeLaunch(spec, 'player', { power: 1, aim: 0, tilt: 0 });
    expect(hi.spin).toBeGreaterThan(lo.spin);
    expect(Math.hypot(hi.velocity.x, hi.velocity.z)).toBeGreaterThan(Math.hypot(lo.velocity.x, lo.velocity.z));
    expect(launchPoint('player').z).toBeGreaterThan(0);
    expect(launchPoint('rival').z).toBeLessThan(0);
  });
});

describe('P2：部件系统', () => {
  it('每类 4 个部件，id 唯一，全部可组装', async () => {
    const { listParts } = await import('../src/game/beys/parts/catalog');
    const blades = listParts('blade');
    const discs = listParts('ratchet');
    const tips = listParts('bit');
    expect(blades.length).toBe(4);
    expect(discs.length).toBe(4);
    expect(tips.length).toBe(4);
    for (const b of blades) for (const d of discs) for (const t of tips) {
      const a = assembleBey({ blade: b.id, ratchet: d.id, bit: t.id });
      expect(a.totalHeight).toBeGreaterThan(0.4);
      expect(a.maxSpin).toBeGreaterThan(100);
    }
  });
  it('连续换部件互不影响', () => {
    let l = { ...PLAYER_LOADOUT };
    l = swapPart(l, 'ratchet', 'quad-edge');
    l = swapPart(l, 'bit', 'needle-point');
    expect(l.blade).toBe(PLAYER_LOADOUT.blade);
    l = swapPart(l, 'blade', 'titan-crown');
    expect(l).toEqual({ blade: 'titan-crown', ratchet: 'quad-edge', bit: 'needle-point' });
  });
  it('换齿轮盘会改变刀刃高度（物理堆叠跟着变）', () => {
    const a = assembleBey(PLAYER_LOADOUT);
    const b = assembleBey(swapPart(PLAYER_LOADOUT, 'ratchet', 'quad-edge'));
    expect(b.layers.blade.bottom).toBeGreaterThan(a.layers.blade.bottom);
    expect(b.layers.bit).toEqual(a.layers.bit);
  });
  it('存档里的坏部件只回退那一个', async () => {
    const { sanitizeLoadout } = await import('../src/game/beys/parts/catalog');
    expect(sanitizeLoadout({ blade: 'titan-crown', ratchet: 'deleted', bit: 'needle-point' }, PLAYER_LOADOUT)).toEqual({
      blade: 'titan-crown',
      ratchet: PLAYER_LOADOUT.ratchet,
      bit: 'needle-point',
    });
  });
  it('属性值都在 0..1', async () => {
    const { computeStats } = await import('../src/game/beys/parts/assemble');
    const s = computeStats(assembleBey({ blade: 'titan-crown', ratchet: 'ring-guard', bit: 'needle-point' }));
    for (const v of Object.values(s)) {
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe('P2：画质分级', () => {
  it('iPhone 从均衡档起步（2x、省开销光照），高清档仍按原生 3x 渲染', async () => {
    const { initialQuality, QualityController, PRESETS } = await import('../src/game/render/Quality');
    const lvl = initialQuality('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)', 3, 6);
    expect(lvl).toBe('medium');
    expect(new QualityController(lvl).pixelRatio(3)).toBe(2);
    expect(PRESETS.medium.accentLights).toBe(false);
    expect(new QualityController('high').pixelRatio(3)).toBe(3);
  });
  it('流畅优先（2026-11-08）：高/超档原生分辨率；均衡 2x；流畅 1.5x，且低 / 中档关闭补光、软阴影与碗面清漆', async () => {
    const { QualityController, PRESETS } = await import('../src/game/render/Quality');
    for (const lvl of ['high', 'ultra'] as const) {
      expect(new QualityController(lvl).pixelRatio(3)).toBe(3);
      expect(new QualityController(lvl).pixelRatio(2)).toBe(2);
      expect(PRESETS[lvl].accentLights && PRESETS[lvl].softShadows && PRESETS[lvl].floorClearcoat).toBe(true);
    }
    expect(new QualityController('medium').pixelRatio(3)).toBe(2);
    expect(new QualityController('low').pixelRatio(3)).toBe(1.5);
    for (const lvl of ['low', 'medium'] as const) expect(PRESETS[lvl].accentLights || PRESETS[lvl].softShadows || PRESETS[lvl].floorClearcoat).toBe(false);
    // 1x 屏不会被放大渲染
    expect(new QualityController('low').pixelRatio(1)).toBe(1);
    // 降档时先降粒子和阴影
    expect(PRESETS.low.sparkScale).toBeLessThan(PRESETS.high.sparkScale);
    expect(PRESETS.low.shadowMapSize).toBeLessThanOrEqual(PRESETS.high.shadowMapSize);
  });
  it('P2.1：组装界面生成缩略图之类的超长单帧不会触发降档', async () => {
    const { QualityController } = await import('../src/game/render/Quality');
    const q = new QualityController('high');
    for (let i = 0; i < 40; i++) q.sample(1 / 60);
    for (let i = 0; i < 10; i++) q.sample(0.4);
    for (let i = 0; i < 200; i++) q.sample(1 / 60);
    expect(q.level).toBe('high');
  });
  it('持续掉帧自动降档，最多升回一档', async () => {
    const { QualityController } = await import('../src/game/render/Quality');
    const q = new QualityController('high');
    for (let i = 0; i < 100; i++) q.sample(1 / 30); // 约 3.3 秒
    expect(q.level).toBe('medium');
    for (let i = 0; i < 600; i++) q.sample(1 / 60);
    expect(['medium', 'high']).toContain(q.level);
  });
});

describe('P2.1：撞击力度分级', () => {
  it('轻擦 / 中等 / 猛撞三档阈值', async () => {
    const { impactTier } = await import('../src/game/battle/impactTiers');
    expect(impactTier(0.05)).toBe('light');
    expect(impactTier(0.29)).toBe('light');
    expect(impactTier(0.3)).toBe('medium');
    expect(impactTier(0.6)).toBe('medium');
    expect(impactTier(0.65)).toBe('heavy');
    expect(impactTier(1)).toBe('heavy');
  });
  it('三档反馈明显不同，且不是所有碰撞都打满', async () => {
    const { impactFeedback } = await import('../src/game/battle/impactTiers');
    const light = impactFeedback(0.15);
    const medium = impactFeedback(0.45);
    const heavy = impactFeedback(0.85);
    // P2.2.1：任何等级都不再改变时间流速（没有定格 / 慢动作字段）
    for (const f of [light, medium, heavy]) {
      expect('hitstop' in f).toBe(false);
      expect('slowmo' in f).toBe(false);
    }
    // 轻擦：无冲击波、几乎不震屏
    expect(light.waves).toBe(0);
    expect(light.shake).toBeLessThan(0.2);
    expect(light.sparks).toBeLessThan(20);
    // 中等：单层冲击波
    expect(medium.waves).toBe(1);
    // 猛撞：多层冲击波、明显的镜头冲击
    expect(heavy.waves).toBeGreaterThanOrEqual(2);
    expect(heavy.fovKick).toBeGreaterThan(medium.fovKick * 1.5);
    // 各项随等级递增，且相邻两档差距明显（至少 1.5 倍）
    for (const k of ['shake', 'sparks', 'sparkSpeed', 'flash', 'light'] as const) {
      expect(medium[k], k).toBeGreaterThan(light[k] * 1.5);
      expect(heavy[k], k).toBeGreaterThan(medium[k] * 1.2);
    }
  });
  it('力度单调：越强反馈越大（同档内也连续变化）', async () => {
    const { impactFeedback } = await import('../src/game/battle/impactTiers');
    let prev = impactFeedback(0);
    for (let s = 0.02; s <= 1.0001; s += 0.02) {
      const f = impactFeedback(s);
      expect(f.shake).toBeGreaterThanOrEqual(prev.shake);
      expect(f.sparks).toBeGreaterThanOrEqual(prev.sparks);
      expect(f.flash).toBeGreaterThanOrEqual(prev.flash);
      prev = f;
    }
  });
});
