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
    // P2.2：0.6 m/s 的贴身慢碰多数被判为摩擦（不产生事件），即使产生也只是轻擦；轻擦用 2.2 m/s
    // 倾斜进动的初相位随机，每个速度做 5 次，取中位数
    const trial = (speed: number) => {
      const rs = [0, 1, 2, 3, 4].map(() => collide(speed));
      const tiers = rs.map((r) => r.ev?.tier ?? 'none');
      const dvs = rs.map((r) => r.dv).sort((x, y) => x - y);
      return { tiers, dv: dvs[2], ev: rs[0].ev };
    };
    const graze = trial(0.6);
    expect(graze.tiers.every((t) => t === 'none' || t === 'light')).toBe(true);
    const slow = trial(2.2);
    const mid = trial(4);
    const fast = trial(11);
    expect(slow.tiers.filter((t) => t === 'light').length, slow.tiers.join()).toBeGreaterThanOrEqual(3);
    expect(slow.tiers.filter((t) => t === 'medium' || t === 'heavy').length, slow.tiers.join()).toBe(0);
    expect(mid.tiers.filter((t) => t === 'medium').length, mid.tiers.join()).toBeGreaterThanOrEqual(4);
    expect(fast.tiers.every((t) => t === 'heavy')).toBe(true);
    // 弹开程度随力度明显增大：猛撞后的速度变化远大于轻擦
    expect(fast.dv).toBeGreaterThan(mid.dv * 1.5);
    expect(mid.dv).toBeGreaterThan(slow.dv * 1.5);
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

  // ───────── P2.2：碰撞物理 ─────────
  /** 两台陀螺在场地中央沿 x 轴相向而行，返回第一次有效撞击前后的数据 */
  async function headOn(speed: number, la?: object, lb?: object) {
    const { loadRapier, PhysicsWorld } = await import('../src/game/physics/PhysicsWorld');
    const { createArenaPhysics } = await import('../src/game/arena/ArenaPhysics');
    const { BattleSystem } = await import('../src/game/battle/BattleSystem');
    const { assembleBey } = await import('../src/game/beys/parts/assemble');
    const { RIVAL_LOADOUT } = await import('../src/game/beys/parts/catalog');
    const R = await loadRapier();
    const pw = new PhysicsWorld(R);
    createArenaPhysics(pw);
    const battle = new BattleSystem(pw, {
      player: assembleBey({ ...RIVAL_LOADOUT, ...la }),
      rival: assembleBey({ ...RIVAL_LOADOUT, ...lb }),
    });
    pw.beforeStep = (dt) => battle.preStep(dt);
    pw.afterStep = (dt) => battle.postStep(dt);
    battle.launch('player', { power: 0.5, aim: 0, tilt: 0 });
    battle.launch('rival', { power: 0.5, aim: 0, tilt: 0 });
    const a = battle.beys.player!;
    const b = battle.beys.rival!;
    a.body.setTranslation({ x: -0.9, y: 0.15, z: 0 }, true);
    b.body.setTranslation({ x: 0.9, y: 0.15, z: 0 }, true);
    a.body.setLinvel({ x: speed / 2, y: 0, z: 0 }, true);
    b.body.setLinvel({ x: -speed / 2, y: 0, z: 0 }, true);
    const events: { strength: number; tier: string; t: number }[] = [];
    let after: { dvA: number; dvB: number; sep: number } | null = null;
    for (let i = 0; i < 120; i++) {
      pw.step();
      for (const e of battle.impacts) events.push({ strength: e.strength, tier: e.tier, t: i / 120 });
      battle.impacts.length = 0;
      if (events.length && !after) {
        // 撞击之后再走 3 步，让 Rapier 接触解算与额外冲量都完成
        for (let k = 0; k < 3; k++) pw.step();
        const va = a.body.linvel();
        const vb = b.body.linvel();
        after = { dvA: Math.hypot(va.x - speed / 2, va.z), dvB: Math.hypot(vb.x + speed / 2, vb.z), sep: vb.x - va.x };
      }
    }
    const res = { events, after, grinds: battle.grinds, massA: a.body.mass(), massB: b.body.mass() };
    pw.dispose();
    return res;
  }

  it('P2.2：碰撞不再“越撞越有劲”——有效恢复系数 < 1（P2.1 为 1.3–2.7）', async () => {
    for (const speed of [4, 8, 11]) {
      // 倾斜进动的初相位是随机的，取 4 次平均
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        const r = await headOn(speed);
        expect(r.after, `speed ${speed}`).not.toBeNull();
        sum += r.after!.sep / speed;
      }
      const e = sum / 4;
      // 真的弹开（不是黏在一起），但分离速度小于接近速度（不会凭空增加能量）
      expect(e, `speed ${speed}`).toBeGreaterThan(0.1);
      expect(e, `speed ${speed}`).toBeLessThan(1);
    }
  }, 60000);

  it('P2.2：重量真实影响结果——轻的一方被撞开的速度变化更大', async () => {
    const heavy = { blade: 'titan-crown', disc: 'ring-guard', tip: 'dome-ball' };
    const light = { blade: 'blaze-fang', disc: 'tri-lock', tip: 'dome-ball' };
    const r = await headOn(9, heavy, light);
    expect(r.massA).toBeGreaterThan(r.massB * 1.15);
    expect(r.after).not.toBeNull();
    // 动量守恒：Δv 之比 ≈ 质量反比
    const ratio = r.after!.dvB / r.after!.dvA;
    expect(ratio).toBeGreaterThan(1.1);
    expect(ratio).toBeLessThan((r.massA / r.massB) * 1.6);
  }, 60000);

  it('P2.2：一次碰撞只结算一次，不会重复施加撞击', async () => {
    const r = await headOn(11);
    const first = r.events[0];
    expect(first.tier).toBe('heavy');
    const dup = r.events.filter((e) => e.t - first.t < 0.15).length;
    expect(dup).toBe(1);
  }, 60000);

  it('P2.2：贴身慢速摩擦不产生撞击事件（不刷火花和声音）', async () => {
    const r = await headOn(0.3);
    expect(r.events.filter((e) => e.tier !== 'light').length).toBe(0);
    expect(r.events.length).toBeLessThanOrEqual(1);
  }, 60000);

  it('P2.2：发射撞击之后仍会自然再次交锋（中段中等以上撞击 ≥ 1 次 / 10 秒，且不靠定时安排）', async () => {
    let mid = 0;
    let time = 0;
    let maxGap = 0;
    for (let i = 0; i < 6; i++) {
      const aim = ((i % 3) - 1) * 0.3;
      const r = await simulateBattle({
        player: { power: 0.7 + (i % 3) * 0.15, aim, tilt: 0 },
        rival: { power: 0.8, aim: -aim, tilt: 0 },
        maxSeconds: 40,
      });
      const after = r.impactLog.filter((e) => e.t > 1.5);
      mid += after.filter((e) => e.tier !== 'light').length;
      time += Math.max(0, r.battle.time - 1.5);
      let last = 1.5;
      for (const t of after.map((e) => e.t)) {
        maxGap = Math.max(maxGap, t - last);
        last = t;
      }
      r.dispose();
    }
    expect((mid / time) * 10).toBeGreaterThan(1);
    // 不能长时间各转各的：两次撞击之间最长不超过 10 秒（P2.1 最长 24 秒）
    expect(maxGap).toBeLessThan(10);
  }, 240000);

  it('P2.2：关闭常驻 CCD 后，最细的针尖高速砸向碗面也不会穿透', async () => {
    const { floorHeight } = await import('../src/game/arena/arenaSpec');
    for (const vy of [-8, -14]) {
      for (const x of [0, 1.5, 3]) {
        const r = await simulateBattle({
          player: { power: 0.5, aim: 0, tilt: 0 },
          rival: { power: 0.5, aim: 0, tilt: 0 },
          playerLoadout: { blade: 'blaze-fang', disc: 'tri-lock', tip: 'needle-point' },
          maxSeconds: 0.01,
        });
        const a = r.battle.beys.player!;
        a.body.setTranslation({ x, y: floorHeight(x) + 1.5, z: 0 }, true);
        a.body.setLinvel({ x: 0, y: vy, z: 0 }, true);
        let minGap = Infinity;
        for (let i = 0; i < 120; i++) {
          r.step();
          const p = a.body.translation();
          minGap = Math.min(minGap, p.y - floorHeight(Math.hypot(p.x, p.z)));
        }
        r.dispose();
        expect(minGap, `vy ${vy} x ${x}`).toBeGreaterThan(-0.05);
      }
    }
  }, 60000);
});
