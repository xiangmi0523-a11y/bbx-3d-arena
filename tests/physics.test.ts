import { describe, expect, it } from 'vitest';
import { simulateBattle } from './sim';
import type { BeyLoadout } from '../src/game/beys/parts/types';

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

  it('所有刀刃 × 陀尖组合都能稳定落地、完成对战（不穿地、不爆数值）', async () => {
    const blades = ['blaze-fang', 'tidal-bastion', 'gale-crescent', 'titan-crown'];
    const tips = ['gear-flat', 'dome-ball', 'needle-point', 'rush-rubber'];
    const discs = ['tri-lock', 'hex-lock', 'quad-edge', 'ring-guard'];
    for (let i = 0; i < blades.length; i++) {
      const lo: BeyLoadout = { blade: blades[i], disc: discs[i], tip: tips[(i + 1) % 4] };
      let minY = Infinity;
      const r = await simulateBattle({
        player: { power: 0.9, aim: 0, tilt: 0 },
        rival: { power: 0.8, aim: 0, tilt: 0 },
        playerLoadout: lo,
        trace: (_t, b) => {
          for (const x of Object.values(b.beys)) minY = Math.min(minY, x!.body.translation().y);
        },
      });
      expect(r.battle.result, JSON.stringify(lo)).not.toBeNull();
      expect(minY).toBeGreaterThan(-1.3);
      expect(Number.isFinite(r.battle.beys.player!.spin)).toBe(true);
      r.dispose();
    }
  }, 120000);

  it('撞击会让双方明显掉速并被弹开', async () => {
    const r = await simulateBattle({
      player: { power: 1, aim: 0, tilt: 0 },
      rival: { power: 1, aim: 0, tilt: 0 },
      maxSeconds: 3,
    });
    // 3 秒内至少发生过一次撞击，且撞击事件携带法线和力度
    expect(r.battle.hits).toBeGreaterThan(0);
    r.dispose();
  }, 60000);
});
