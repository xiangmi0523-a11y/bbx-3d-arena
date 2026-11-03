import { describe, expect, it } from 'vitest';
import { simulateBattle } from './sim';

// 真实 Rapier 无头模拟：验证刚体落地、碰撞、胜负判定都由物理驱动
describe('物理对战模拟', () => {
  it('两台陀螺发射后能完成一整场对战', async () => {
    const r = await simulateBattle({
      player: { power: 1, aim: 0, tilt: 0 },
      rival: { power: 0.8, aim: 0, tilt: 0 },
    });
    expect(r.battle.result).not.toBeNull();
    expect(r.battle.hits).toBeGreaterThan(0);
    expect(r.battle.result!.duration).toBeGreaterThan(5);
    r.dispose();
  }, 60000);

  it('陀螺不会穿透地面', async () => {
    let minY = Infinity;
    const r = await simulateBattle({
      player: { power: 0.6, aim: 0.3, tilt: 0 },
      rival: { power: 0.6, aim: -0.3, tilt: 0 },
      maxSeconds: 8,
      trace: (_t, b) => {
        for (const x of Object.values(b.beys)) minY = Math.min(minY, x!.body.translation().y);
      },
    });
    expect(minY).toBeGreaterThan(-0.1);
    r.dispose();
  }, 60000);

  it('转速越高越稳定：同样条件下低力度先停转', async () => {
    const r = await simulateBattle({
      player: { power: 0.15, aim: -1, tilt: 0 },
      rival: { power: 1, aim: 1, tilt: 0 },
    });
    expect(r.battle.result!.loser).toBe('player');
    r.dispose();
  }, 60000);
});
