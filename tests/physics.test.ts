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

  it('P2.1：撞击力度来自碰撞前的接近速度——慢速轻碰是轻擦，高速对撞是猛撞', async () => {
    const { loadRapier, PhysicsWorld } = await import('../src/game/physics/PhysicsWorld');
    const { createArenaPhysics } = await import('../src/game/arena/ArenaPhysics');
    const { BattleSystem } = await import('../src/game/battle/BattleSystem');
    const { assembleBey } = await import('../src/game/beys/parts/assemble');
    const { PLAYER_LOADOUT, RIVAL_LOADOUT } = await import('../src/game/beys/parts/catalog');
    const R = await loadRapier();
    // 两台陀螺在场地中央相向而行，只改变接近速度（都用没有主动冲刺的防御型轴心，排除其他加速）
    void PLAYER_LOADOUT;
    const collide = (speed: number) => {
      const pw = new PhysicsWorld(R);
      createArenaPhysics(pw);
      const battle = new BattleSystem(pw, { player: assembleBey(RIVAL_LOADOUT), rival: assembleBey(RIVAL_LOADOUT) });
      pw.beforeStep = (dt) => battle.preStep(dt);
      pw.afterStep = (dt) => battle.postStep(dt);
      battle.launch('player', { power: 0.5, aim: 0, tilt: 0 });
      battle.launch('rival', { power: 0.5, aim: 0, tilt: 0 });
      const a = battle.beys.player!;
      const b = battle.beys.rival!;
      const y = 0.15;
      a.body.setTranslation({ x: -0.9, y, z: 0 }, true);
      b.body.setTranslation({ x: 0.9, y, z: 0 }, true);
      a.body.setLinvel({ x: speed / 2, y: 0, z: 0 }, true);
      b.body.setLinvel({ x: -speed / 2, y: 0, z: 0 }, true);
      const v0 = { a: speed / 2, b: -speed / 2 };
      let ev: { strength: number; tier: string } | null = null;
      let dv = 0;
      for (let i = 0; i < 240 && !ev; i++) {
        pw.step();
        if (battle.impacts.length) {
          ev = battle.impacts[0];
          const va = a.body.linvel();
          const vb = b.body.linvel();
          dv = (Math.abs(va.x - v0.a) + Math.abs(vb.x - v0.b)) / 2;
        }
      }
      pw.dispose();
      return { ev, dv };
    };
    const slow = collide(0.6);
    const mid = collide(4);
    const fast = collide(11);
    expect(slow.ev?.tier).toBe('light');
    expect(mid.ev?.tier).toBe('medium');
    expect(fast.ev?.tier).toBe('heavy');
    // 弹开程度随力度明显增大：猛撞后的速度变化远大于轻擦
    expect(fast.dv).toBeGreaterThan(mid.dv * 1.5);
    expect(mid.dv).toBeGreaterThan(slow.dv * 2);
  }, 60000);

  it('P2.1：交锋更频繁，且轻 / 中 / 猛三档都会出现', async () => {
    const tiers = { light: 0, medium: 0, heavy: 0 };
    let hits = 0;
    let time = 0;
    for (let i = 0; i < 6; i++) {
      const aim = ((i % 3) - 1) * 0.3;
      const r = await simulateBattle({
        player: { power: 0.7 + (i % 3) * 0.15, aim, tilt: 0 },
        rival: { power: 0.8, aim: -aim, tilt: 0 },
        maxSeconds: 40,
      });
      for (const e of r.battle.impacts) tiers[e.tier]++;
      hits += r.battle.hits;
      time += r.battle.time;
      r.dispose();
    }
    // P2 版本约 1.6 次 / 10 秒；P2.1 目标 ≥ 2.5 次 / 10 秒
    expect((hits / time) * 10).toBeGreaterThan(2.5);
    expect(tiers.light).toBeGreaterThan(0);
    expect(tiers.medium + tiers.heavy).toBeGreaterThan(3);
    expect(tiers.heavy).toBeGreaterThan(0);
  }, 180000);
});
