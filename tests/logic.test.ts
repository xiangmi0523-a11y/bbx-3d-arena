import { describe, expect, it } from 'vitest';
import { ARENA, floorHeight, pocketAtAngle } from '../src/game/arena/arenaSpec';
import { assembleBey, swapPart } from '../src/game/beys/parts/assemble';
import { PLAYER_LOADOUT, RIVAL_LOADOUT, listParts } from '../src/game/beys/parts/catalog';
import { computeLaunch, launchPoint } from '../src/game/launcher/launch';
import { computePower, PullStringGesture } from '../src/game/launcher/PullStringGesture';

describe('部件组装', () => {
  it('Blade/Disc/Tip 从下到上堆叠', () => {
    const b = assembleBey(PLAYER_LOADOUT);
    expect(b.layers.tip.bottom).toBe(0);
    expect(b.layers.disc.bottom).toBeCloseTo(b.layers.tip.top);
    expect(b.layers.blade.bottom).toBeCloseTo(b.layers.disc.top);
    expect(b.totalMass).toBeCloseTo(b.blade.mass + b.disc.mass + b.tip.mass);
  });
  it('可以单独替换任意部件', () => {
    const swapped = assembleBey(swapPart(PLAYER_LOADOUT, 'tip', RIVAL_LOADOUT.tip));
    expect(swapped.blade.id).toBe(PLAYER_LOADOUT.blade);
    expect(swapped.tip.id).toBe(RIVAL_LOADOUT.tip);
  });
  it('未知部件抛错', () => {
    expect(() => assembleBey({ ...PLAYER_LOADOUT, blade: 'nope' })).toThrow();
  });
  it('目录里每类至少两个部件', () => {
    for (const k of ['blade', 'disc', 'tip'] as const) expect(listParts(k).length).toBeGreaterThanOrEqual(2);
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
    const discs = listParts('disc');
    const tips = listParts('tip');
    expect(blades.length).toBe(4);
    expect(discs.length).toBe(4);
    expect(tips.length).toBe(4);
    for (const b of blades) for (const d of discs) for (const t of tips) {
      const a = assembleBey({ blade: b.id, disc: d.id, tip: t.id });
      expect(a.totalHeight).toBeGreaterThan(0.4);
      expect(a.maxSpin).toBeGreaterThan(100);
    }
  });
  it('连续换部件互不影响', () => {
    let l = { ...PLAYER_LOADOUT };
    l = swapPart(l, 'disc', 'quad-edge');
    l = swapPart(l, 'tip', 'needle-point');
    expect(l.blade).toBe(PLAYER_LOADOUT.blade);
    l = swapPart(l, 'blade', 'titan-crown');
    expect(l).toEqual({ blade: 'titan-crown', disc: 'quad-edge', tip: 'needle-point' });
  });
  it('换齿轮盘会改变刀刃高度（物理堆叠跟着变）', () => {
    const a = assembleBey(PLAYER_LOADOUT);
    const b = assembleBey(swapPart(PLAYER_LOADOUT, 'disc', 'quad-edge'));
    expect(b.layers.blade.bottom).toBeGreaterThan(a.layers.blade.bottom);
    expect(b.layers.tip).toEqual(a.layers.tip);
  });
  it('存档里的坏部件只回退那一个', async () => {
    const { sanitizeLoadout } = await import('../src/game/beys/parts/catalog');
    expect(sanitizeLoadout({ blade: 'titan-crown', disc: 'deleted', tip: 'needle-point' }, PLAYER_LOADOUT)).toEqual({
      blade: 'titan-crown',
      disc: PLAYER_LOADOUT.disc,
      tip: 'needle-point',
    });
  });
  it('属性值都在 0..1', async () => {
    const { computeStats } = await import('../src/game/beys/parts/assemble');
    const s = computeStats(assembleBey({ blade: 'titan-crown', disc: 'ring-guard', tip: 'needle-point' }));
    for (const v of Object.values(s)) {
      expect(v).toBeGreaterThan(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});

describe('P2：画质分级', () => {
  it('iPhone 3x 屏从高清档起步，像素比 ≥ 2.5', async () => {
    const { initialQuality, QualityController } = await import('../src/game/render/Quality');
    const lvl = initialQuality('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X)', 3, 6);
    expect(lvl).toBe('high');
    expect(new QualityController(lvl).pixelRatio(3)).toBeGreaterThanOrEqual(2.5);
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
