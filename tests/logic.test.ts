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
