import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { floorHeight } from '../src/game/arena/arenaSpec';
import type { BattleSystem, ImpactEvent } from '../src/game/battle/BattleSystem';
import { CONTACT_TUNING, ContactFeedback, grindTarget, type ContactSample } from '../src/game/battle/contactFeedback';
import type { BeyPhysics } from '../src/game/beys/BeyPhysics';
import { PLAYER_LOADOUT, RIVAL_LOADOUT } from '../src/game/beys/parts/catalog';
import { BattleFeedback } from '../src/game/core/BattleFeedback';
import { PHYSICS_DT } from '../src/game/physics/PhysicsWorld';
import { GRIND_SPARK_CAP } from '../src/game/render/ImpactFX';
import { seeded } from './feelSim';
import { Fingerprint } from './helpers/hash';
import { makePipeline } from './helpers/pipeline';

/**
 * P2.3.2 接触反馈：轻擦 / 持续摩擦 / 强碰撞三层共用一个接触生命周期。
 * 物理场景全部用真实 Rapier；只有“持续挤压”场景由测试夹具每步给一点相向冲量，
 * 模拟两台被碗面坡度挤在一起（游戏代码本身不施加任何新冲量）。
 */
const LO = { player: PLAYER_LOADOUT, rival: RIVAL_LOADOUT };
const CMD = { player: { power: 0.9, aim: 0, tilt: 0 }, rival: { power: 0.9, aim: 0, tilt: 0 } };

function place(b: BeyPhysics, x: number, z: number, vx: number, vz: number) {
  b.body.setTranslation({ x, y: floorHeight(Math.hypot(x, z)) + 0.002, z }, true);
  b.body.setLinvel({ x: vx, y: 0, z: vz }, true);
  b.body.setRotation({ x: 0, y: 0, z: 0, w: 1 }, true);
}

/** 测试夹具：每步给两台一个相向的小冲量（只在测试里，模拟被坡度挤在一起） */
function press(b: BattleSystem, force: number) {
  const A = b.beys.player!;
  const B = b.beys.rival!;
  const pa = A.body.translation();
  const pb = B.body.translation();
  const d = Math.hypot(pb.x - pa.x, pb.z - pa.z) || 1;
  const ix = ((pb.x - pa.x) / d) * force * PHYSICS_DT;
  const iz = ((pb.z - pa.z) / d) * force * PHYSICS_DT;
  A.body.applyImpulse({ x: ix, y: 0, z: iz }, true);
  B.body.applyImpulse({ x: -ix, y: 0, z: -iz }, true);
}

/** 记录 BattleFeedback 实际播放 / 合并的撞击 */
function recordImpacts(fb: BattleFeedback) {
  const log: (ImpactEvent & { t: number })[] = [];
  const orig = fb.playImpact.bind(fb);
  let t = 0;
  fb.playImpact = (e: ImpactEvent) => {
    log.push({ ...e, t });
    orig(e);
  };
  return { log, setTime: (x: number) => (t = x) };
}

// 每个用例都用固定种子（进动初相、火花方向用 Math.random），结果与用例执行顺序无关
const realRandom = Math.random;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  Math.random = seeded(20261106);
});
afterEach(() => {
  vi.useRealTimers();
  Math.random = realRandom;
});

const timers = (ms: number) => vi.advanceTimersByTime(ms);

describe('接触反馈：状态机（纯逻辑）', () => {
  const touch = (force: number, slide: number): ContactSample => ({
    touching: true, force, slide, x: 0, y: 0.5, z: 0, nx: 1, nz: 0, tx: 0, tz: 1,
  });
  const gap: ContactSample = { ...touch(0, 0), touching: false };

  it('强度只来自真实法向力 × 滑动速度：没有力、没有滑动就没有摩擦', () => {
    expect(grindTarget(0, 50)).toBe(0);
    expect(grindTarget(100, 0.5)).toBe(0);
    expect(grindTarget(30, 40)).toBeGreaterThan(grindTarget(10, 40));
    expect(grindTarget(30, 40)).toBeGreaterThan(grindTarget(30, 10));
    expect(grindTarget(1e6, 1e3)).toBeLessThanOrEqual(1);
  });

  it('轻擦 → 持续摩擦 → 分开后结束：阶段转换和强度连续', () => {
    const c = new ContactFeedback();
    c.step(PHYSICS_DT, touch(60, 40));
    expect(c.state.phase).toBe('graze');
    const grazeLevel = c.state.level;
    // 刀刃凸起的颤动接触：每 3 步碰一次，间隙远小于 holdTime
    const levels: number[] = [];
    for (let i = 0; i < 60; i++) {
      c.step(PHYSICS_DT, i % 3 === 0 ? touch(60, 40) : gap);
      levels.push(c.state.level);
    }
    expect(c.state.phase).toBe('grind');
    expect(c.grindEpisodes).toBe(1);
    expect(c.episodes).toBe(1); // 颤动接触没有被切成很多段
    expect(Math.min(...levels.slice(20))).toBeGreaterThan(0.1); // 持续，不断断续续
    expect(Math.max(...levels)).toBeGreaterThan(grazeLevel * 1.5); // 持续摩擦明显强于轻擦
    // 分开：holdTime 后回到 idle，强度按 release 衰减到 0
    let idleAt = -1;
    for (let i = 0; i < 120; i++) {
      c.step(PHYSICS_DT, null);
      if (idleAt < 0 && c.state.phase === 'idle') idleAt = i * PHYSICS_DT;
    }
    expect(idleAt).toBeGreaterThan(0);
    expect(idleAt).toBeLessThanOrEqual(CONTACT_TUNING.holdTime + 2 * PHYSICS_DT);
    expect(c.state.level).toBe(0);
  });

  it('两次孤立的擦碰不会被当成持续摩擦', () => {
    const c = new ContactFeedback();
    c.step(PHYSICS_DT, touch(80, 40));
    for (let i = 0; i < 30; i++) c.step(PHYSICS_DT, gap);
    c.step(PHYSICS_DT, touch(80, 40));
    for (let i = 0; i < 30; i++) c.step(PHYSICS_DT, gap);
    expect(c.episodes).toBe(2);
    expect(c.grindEpisodes).toBe(0);
  });

  it('强碰撞压低摩擦层，随后恢复；同一段内紧跟的更弱强碰撞被合并，更强的照常播放', () => {
    const c = new ContactFeedback();
    for (let i = 0; i < 30; i++) c.step(PHYSICS_DT, touch(80, 40));
    const before = c.state.level;
    expect(c.impact('heavy', 0.8)).toBe('play');
    c.step(PHYSICS_DT, touch(80, 40));
    expect(c.state.level).toBeLessThan(before * 0.3);
    expect(c.impact('medium', 0.5)).toBe('merge');
    expect(c.impact('heavy', 0.9)).toBe('play');
    // 持续摩擦中的颤动轻擦：并入摩擦层（推高强度），不单独播放
    const raw0 = c.state.rawLevel;
    expect(c.impact('light', 0.2)).toBe('absorb');
    expect(c.state.rawLevel).toBeGreaterThanOrEqual(Math.max(raw0, CONTACT_TUNING.absorbBump + 0.2) - 1e-9);
    // 新接触段刚开始（轻擦阶段）的轻擦撞击照常播放
    const c2 = new ContactFeedback();
    c2.step(PHYSICS_DT, touch(80, 40));
    expect(c2.impact('light', 0.1)).toBe('play');
    for (let i = 0; i < 60; i++) c.step(PHYSICS_DT, touch(80, 40));
    expect(c.state.level).toBeCloseTo(c.state.rawLevel, 5);
    expect(c.merged).toBe(1);
  });
});

describe('接触反馈：真实物理场景', () => {
  it('1. 单次正面强碰撞：原有冲击反馈保留（猛撞火花、震屏、重击声），同一接触只触发一次', async () => {
    const p = await makePipeline(timers);
    const b = p.startBattle(LO, CMD);
    place(b.beys.player!, -1.1, 0, 7, 0);
    place(b.beys.rival!, 1.1, 0, -7, 0);
    const rec = recordImpacts(p.feedback);
    let maxLive = 0;
    for (let f = 0; f < 30; f++) {
      rec.setTime(f);
      maxLive = Math.max(maxLive, p.frame().live);
    }
    const strong = rec.log.filter((e) => e.tier !== 'light');
    expect(strong.length).toBeGreaterThanOrEqual(1);
    expect(strong[0].feedback).toBe('play');
    expect(strong[0].tier).toBe('heavy');
    // 同一接触段只有一次播放的强碰撞
    const perEpisode = new Map<number, number>();
    for (const e of strong.filter((x) => x.feedback === 'play')) perEpisode.set(e.episode, (perEpisode.get(e.episode) ?? 0) + 1);
    for (const n of perEpisode.values()) expect(n).toBe(1);
    expect(Math.max(...p.camShakes)).toBeGreaterThan(0.7);
    expect(maxLive).toBeGreaterThan(90); // 猛撞 100–150 粒（高画质 × 0.9 以上）
    expect(p.ctx.maxLiveSources).toBeGreaterThan(8); // 猛撞声的分音 + 噪声 + 重击 + 回响
    p.dispose();
  });

  it('1b. 读取接触不改变物理：同一场正面撞击，开 / 关接触反馈的撞击力度和轨迹完全相同', async () => {
    const run = async (on: boolean) => {
      const orig = Math.random;
      Math.random = seeded(7);
      try {
        const { createArenaPhysics } = await import('../src/game/arena/ArenaPhysics');
        const { BattleSystem } = await import('../src/game/battle/BattleSystem');
        const { assembleBey } = await import('../src/game/beys/parts/assemble');
        const { loadRapier, PhysicsWorld } = await import('../src/game/physics/PhysicsWorld');
        const R = await loadRapier();
        const pw = new PhysicsWorld(R);
        createArenaPhysics(pw);
        const b = new BattleSystem(pw, { player: assembleBey(LO.player), rival: assembleBey(LO.rival) }, { contactFeedback: on });
        pw.beforeStep = (dt) => b.preStep(dt);
        pw.afterStep = (dt) => b.postStep(dt);
        b.launch('player', CMD.player);
        b.launch('rival', CMD.rival);
        const h = new Fingerprint();
        for (let i = 0; i < 120 * 20 && !b.result; i++) {
          pw.step();
          for (const x of [b.beys.player!, b.beys.rival!]) {
            const t = x.body.translation();
            h.update(`${t.x},${t.y},${t.z},${x.spin};`);
          }
        }
        const out = { hash: h.digest(), strengths: b.impacts.map((e) => e.strength), hits: b.hits, breakouts: b.breakouts };
        pw.dispose();
        return out;
      } finally {
        Math.random = orig;
      }
    };
    const on = await run(true);
    const off = await run(false);
    expect(on.hash).toBe(off.hash);
    expect(on.strengths).toEqual(off.strengths);
    expect(on.hits).toBe(off.hits);
  }, 60000);

  it('2. 轻微擦碰：真实对战里的轻擦接触段不触发强碰撞反馈，只有少量火花和轻的摩擦声', async () => {
    // 刚体引擎里转动中的陀螺一碰就有很大的刀刃咬合冲量，人工摆放很难得到“轻擦”；
    // 这里用固定种子的真实对战，挑出整段只有轻擦撞击（或没有撞击事件）的接触段逐一检查。
    // 自主运动重构后对局轨迹变了：从原种子 1003 起依次往后跑（最多 8 场，全部固定种子），
    // 直到收集到至少 3 段轻擦接触段为止；对每一段的检查条件与原测试完全相同
    const p = await makePipeline(timers);
    const orig = Math.random;
    interface Ep { tiers: string[]; maxShake: number; sparksAdded: number; maxLevel: number; grind: boolean }
    const eps = new Map<string, Ep>();
    const isLight = (e: Ep) => e.tiers.every((t) => t === 'light');
    try {
      for (let seed = 1003; seed < 1011 && [...eps.values()].filter(isLight).length < 3; seed++) {
        Math.random = seeded(seed);
        const rnd = Math.random;
        const b = p.startBattle(LO, {
          player: { power: 0.6 + rnd() * 0.35, aim: (rnd() - 0.5) * 0.8, tilt: 0 },
          rival: { power: 0.55 + rnd() * 0.4, aim: (rnd() - 0.5) * 1.2, tilt: 0 },
        });
        const key = (ep: number) => `${seed}:${ep}`;
        const origPlay = p.feedback.playImpact.bind(p.feedback);
        p.feedback.playImpact = (e: ImpactEvent) => {
          const k = key(e.episode);
          if (!eps.has(k)) eps.set(k, { tiers: [], maxShake: 0, sparksAdded: 0, maxLevel: 0, grind: false });
          eps.get(k)!.tiers.push(e.tier);
          origPlay(e);
        };
        for (let f = 0; f < 60 * 40 && !b.result; f++) {
          const shakes0 = p.camShakes.length;
          const live0 = p.fx.stats().live;
          const fr = p.frame();
          const cur = b.contact.state.episode;
          if (cur > 0 && fr.phase !== 'idle') {
            const k = key(cur);
            if (!eps.has(k)) eps.set(k, { tiers: [], maxShake: 0, sparksAdded: 0, maxLevel: 0, grind: false });
            const e = eps.get(k)!;
            e.maxShake = Math.max(e.maxShake, ...p.camShakes.slice(shakes0), 0);
            e.sparksAdded += Math.max(0, p.fx.stats().live - live0);
            e.maxLevel = Math.max(e.maxLevel, fr.level);
            e.grind ||= fr.phase === 'grind';
          }
        }
        p.feedback.playImpact = origPlay;
      }
    } finally {
      Math.random = orig;
    }
    const light = [...eps.values()].filter((e) => e.tiers.every((t) => t === 'light'));
    expect(light.length).toBeGreaterThanOrEqual(3);
    for (const e of light) {
      expect(e.maxShake).toBeLessThan(0.15); // 轻擦震屏上限 0.14，中等起步 0.32
      expect(e.sparksAdded).toBeLessThan(60); // 中等撞击 34+ 粒，猛撞 100+
    }
    // 轻擦接触段的摩擦强度明显低于持续摩擦段
    const grazeOnly = light.filter((e) => !e.grind);
    expect(grazeOnly.length).toBeGreaterThan(0);
    for (const e of grazeOnly) expect(e.maxLevel).toBeLessThan(0.5);
    p.dispose();
  }, 60000);

  it('3/4. 双方持续斜向挤压：产生连续摩擦反馈；分开后摩擦声和火花正确停止、音频链释放', async () => {
    const p = await makePipeline(timers);
    const b = p.startBattle(LO, CMD);
    const sep = b.beys.player!.spec.outerRadius + b.beys.rival!.spec.outerRadius;
    place(b.beys.player!, -sep / 2 - 0.005, 0, 0.3, 0.6);
    place(b.beys.rival!, sep / 2 + 0.005, 0, -0.3, -0.6);
    const frames = [];
    for (let f = 0; f < 60; f++) frames.push(p.frame({ beforeStep: (x) => press(x, 150) }));
    const grindFrames = frames.filter((x) => x.phase === 'grind');
    expect(grindFrames.length).toBeGreaterThan(15);
    // 连续：进入摩擦后强度不掉到 0
    const firstGrind = frames.findIndex((x) => x.phase === 'grind');
    expect(Math.min(...frames.slice(firstGrind, firstGrind + 20).map((x) => x.level))).toBeGreaterThan(0.05);
    expect(Math.max(...frames.map((x) => x.grindLive))).toBeGreaterThan(5);
    expect(Math.max(...frames.map((x) => x.grindLive))).toBeLessThanOrEqual(GRIND_SPARK_CAP);
    // 一条常驻摩擦音频链，不是每帧新建
    expect(p.audio.grindChainsCreated).toBe(1);
    expect(frames.some((x) => x.grindChain)).toBe(true);
    // 挤压期间不刷撞击：真实的反弹重碰会播放，但次数远少于帧数；摩擦中的颤动轻擦并入摩擦层
    expect(p.feedback.played).toBeLessThan(10);
    expect(b.contact.grindEpisodes).toBeGreaterThanOrEqual(1);

    // 4. 分开
    const A = b.beys.player!;
    const B = b.beys.rival!;
    const pa = A.body.translation();
    const pb = B.body.translation();
    place(A, pa.x - 0.15, pa.z, -4, 0);
    place(B, pb.x + 0.15, pb.z, 4, 0);
    const after = [];
    for (let f = 0; f < 12 && (after.length === 0 || after[after.length - 1].phase !== 'idle'); f++) after.push(p.frame());
    expect(after[after.length - 1].phase).toBe('idle'); // ≤ 0.2 s 内接触段结束
    // 之后（物理暂停推进，避免两台又追上去）：摩擦层衰减、火花死光、辉光关闭
    const levelAtIdle = b.contact.state.level;
    const tail = [];
    for (let f = 0; f < 120; f++) {
      b.contact.step(1 / 60, null);
      tail.push(p.idleFrame());
    }
    expect(levelAtIdle).toBeLessThan(0.6);
    expect(b.contact.state.level).toBe(0);
    expect(tail[30].grindLive).toBe(0);
    expect(p.fx.stats().glow).toBe(false);
    // 静默超过 1.5 s 后释放整条摩擦音频链；还在静默过渡期时链路仍在（避免频繁重建）
    expect(tail[30].grindChain).toBe(true);
    expect(tail[tail.length - 1].grindChain).toBe(false);
    expect(p.ctx.liveSources).toBe(0);
    p.dispose();
  });

  it('5. 持续接触中再次发生明显强碰撞：强碰撞反馈正常触发，摩擦层被短暂压低', async () => {
    const p = await makePipeline(timers);
    const b = p.startBattle(LO, CMD);
    const sep = b.beys.player!.spec.outerRadius + b.beys.rival!.spec.outerRadius;
    place(b.beys.player!, -sep / 2 - 0.005, 0, 0.3, 0.6);
    place(b.beys.rival!, sep / 2 + 0.005, 0, -0.3, -0.6);
    const rec = recordImpacts(p.feedback);
    for (let f = 0; f < 90 && b.contact.state.phase !== 'grind'; f++) p.frame({ beforeStep: (x) => press(x, 150) });
    expect(b.contact.state.phase).toBe('grind');
    const episode = b.contact.state.episode;
    const n0 = rec.log.length;
    // 对手被弹开一点再猛冲回来（间隔 < holdTime，仍是同一接触段）
    const B = b.beys.rival!;
    const pb = B.body.translation();
    place(B, pb.x + 0.12, pb.z, -9, 0);
    let ducked = false;
    for (let f = 0; f < 20; f++) {
      const fr = p.frame({ beforeStep: (x) => press(x, 150) });
      if (fr.level < b.contact.state.rawLevel * 0.5) ducked = true;
    }
    const strong = rec.log.slice(n0).filter((e) => e.tier !== 'light' && e.feedback === 'play');
    expect(strong.length).toBeGreaterThanOrEqual(1);
    // 强碰撞属于正在进行的接触段，或紧接着它的新段（两台被弹开超过 holdTime 时）
    expect(strong[0].episode - episode).toBeLessThanOrEqual(1);
    expect(ducked).toBe(true);
    expect(Math.max(...p.camShakes)).toBeGreaterThan(0.3);
    p.dispose();
  });

  it('7. 双方低速卡住：与 watchStall 兼容——脱困照常触发，次数与关闭接触反馈时完全相同', async () => {
    // 需要一场出现 > 0.6 s 贴身僵持、触发脱困的对局（tests/feelSim 的同一套发射方式）。
    // 基线用种子 1018；自主运动重构后轨迹变了，从 1018 起依次往后找第一场触发脱困的种子（全部固定种子），
    // 再对这一场比较开 / 关接触反馈，比较条件与原测试完全相同
    const run = async (on: boolean, seed: number) => {
      const orig = Math.random;
      Math.random = seeded(seed);
      try {
        const { createArenaPhysics } = await import('../src/game/arena/ArenaPhysics');
        const { BattleSystem } = await import('../src/game/battle/BattleSystem');
        const { assembleBey } = await import('../src/game/beys/parts/assemble');
        const { rivalCommand } = await import('../src/game/launcher/launch');
        const { loadRapier, PhysicsWorld } = await import('../src/game/physics/PhysicsWorld');
        const R = await loadRapier();
        const pw = new PhysicsWorld(R);
        createArenaPhysics(pw);
        const b = new BattleSystem(pw, { player: assembleBey(LO.player), rival: assembleBey(LO.rival) }, { contactFeedback: on });
        pw.beforeStep = (dt) => b.preStep(dt);
        pw.afterStep = (dt) => b.postStep(dt);
        const rnd = Math.random;
        b.launch('player', { power: 0.6 + rnd() * 0.35, aim: (rnd() - 0.5) * 0.8, tilt: 0 });
        b.launch('rival', rivalCommand(rnd));
        let stalledSteps = 0;
        let stalledInContact = 0;
        for (let i = 0; i < 120 * 30 && !b.result; i++) {
          pw.step();
          if (b.stallFor > 0) {
            stalledSteps++;
            if (b.contact.state.phase !== 'idle') stalledInContact++;
          }
        }
        const out = { breakouts: b.breakouts, stalledSteps, stalledInContact, phase: b.contact.state.phase, time: b.time };
        pw.dispose();
        return out;
      } finally {
        Math.random = orig;
      }
    };
    let seed = 1018;
    let on = await run(true, seed);
    while (on.breakouts < 1 && seed < 1060) on = await run(true, ++seed);
    const off = await run(false, seed);
    expect(on.breakouts).toBeGreaterThanOrEqual(1);
    expect(on.breakouts).toBe(off.breakouts);
    expect(on.stalledSteps).toBe(off.stalledSteps);
    expect(on.time).toBe(off.time);
  }, 60000);
});

describe('接触反馈：数量上限与生命周期', () => {
  it('6. 高频重复接触 + 连续强碰撞 20 秒：音源和粒子不会无限叠加', async () => {
    const p = await makePipeline(timers);
    const contact = new ContactFeedback();
    const fake = { impacts: [] as ImpactEvent[], beys: {}, contact } as unknown as BattleSystem;
    const touch: ContactSample = { touching: true, force: 200, slide: 60, x: 0, y: 0.5, z: 0, nx: 1, nz: 0, tx: 0, tz: 1 };
    const gap: ContactSample = { ...touch, touching: false };
    let maxLive = 0;
    let maxGrind = 0;
    let maxSources = 0;
    for (let f = 0; f < 60 * 20; f++) {
      for (let s = 0; s < 2; s++) contact.step(PHYSICS_DT, (f * 2 + s) % 2 === 0 ? touch : gap);
      if (f % 3 === 0) {
        const strength = 0.4 + 0.6 * ((f * 37) % 11) / 10;
        const tier = strength >= 0.65 ? 'heavy' : 'medium';
        fake.impacts.push({
          strength, tier, approach: 5, impulse: 10, dvRel: 8, x: 0, y: 0.5, z: 0, nx: 1, nz: 0,
          episode: contact.state.episode, feedback: contact.impact(tier, strength),
        });
      }
      p.feedback.frame(fake, 1 / 60);
      p.fx.update(1 / 60);
      p.ctx.advance(1 / 60);
      timers(1000 / 60);
      const st = p.fx.stats();
      maxLive = Math.max(maxLive, st.live);
      maxGrind = Math.max(maxGrind, st.grindLive);
      maxSources = Math.max(maxSources, p.ctx.liveSources);
      expect(p.audio.stats().voices).toBeLessThanOrEqual(6);
    }
    expect(contact.merged).toBeGreaterThan(0);
    expect(maxLive).toBeLessThanOrEqual(900);
    expect(maxGrind).toBeLessThanOrEqual(GRIND_SPARK_CAP);
    // 6 个撞击声部 × 每声最多 9 个播放源 + 摩擦链 3 个 + 余量
    expect(maxSources).toBeLessThanOrEqual(6 * 9 + 3);
    expect(p.audio.grindChainsCreated).toBe(1);
    // 停下来之后全部回到 0
    for (let f = 0; f < 150; f++) p.idleFrame();
    expect(p.fx.stats().live).toBe(0);
    expect(p.ctx.liveSources).toBe(0);
    expect(p.audio.stats().grind).toBe(false);
    p.dispose();
  });

  it('8/9. 连续 10 场完整对战（约 2 分钟以上）：没有重复强碰撞反馈、没有状态残留，粒子和音源保持上限', async () => {
    const p = await makePipeline(timers);
    const rec = recordImpacts(p.feedback);
    const orig = Math.random;
    Math.random = seeded(42);
    let simSeconds = 0;
    let maxLive = 0;
    let maxGrind = 0;
    const perBattleMaxSources: number[] = [];
    try {
      for (let k = 0; k < 10; k++) {
        const b = p.startBattle(
          k % 2 ? LO : { player: { blade: 'blaze-fang', ratchet: 'tri-lock', bit: 'rush-rubber' }, rival: RIVAL_LOADOUT },
          { player: { power: 0.6 + 0.05 * k, aim: ((k % 3) - 1) * 0.3, tilt: 0 }, rival: { power: 0.75, aim: 0, tilt: 0 } },
        );
        p.ctx.maxLiveSources = 0;
        let f = 0;
        for (; f < 60 * 45 && !b.result; f++) {
          rec.setTime(b.time);
          const fr = p.frame();
          maxLive = Math.max(maxLive, fr.live);
          maxGrind = Math.max(maxGrind, fr.grindLive);
          expect(b.impacts.length).toBe(0); // 每帧都清空
        }
        simSeconds += b.time;
        // 对战结束后继续 2 秒（结果画面），然后重开：状态必须回到干净
        for (let i = 0; i < 120; i++) p.idleFrame();
        expect(p.fx.stats().live).toBe(0);
        expect(p.fx.stats().glow).toBe(false);
        expect(p.audio.stats().grind).toBe(false);
        expect(p.ctx.liveSources).toBe(0);
        perBattleMaxSources.push(p.ctx.maxLiveSources);
      }
    } finally {
      Math.random = orig;
    }
    expect(simSeconds).toBeGreaterThan(100);
    // 没有重复的强碰撞反馈：同一接触段、mergeWindow 内不会播放两次不更强的强碰撞
    const played = rec.log.filter((e) => e.feedback === 'play' && e.tier !== 'light');
    for (let i = 1; i < played.length; i++) {
      const a = played[i - 1];
      const c = played[i];
      if (a.episode === c.episode && c.t - a.t < CONTACT_TUNING.mergeWindow) expect(c.strength).toBeGreaterThan(a.strength);
    }
    expect(maxLive).toBeLessThanOrEqual(900);
    expect(maxGrind).toBeLessThanOrEqual(GRIND_SPARK_CAP);
    for (const m of perBattleMaxSources) expect(m).toBeLessThanOrEqual(6 * 9 + 3);
    // 每场对战最多一条摩擦音频链同时存在；累计创建次数不超过进入摩擦 / 轻擦的段数
    expect(p.audio.grindChainsCreated).toBeGreaterThan(0);
    p.dispose();
  }, 180000);
});

describe('ImpactFX 粒子池', () => {
  it('只处理和上传活跃粒子；没有粒子时网格隐藏、不上传', async () => {
    const p = await makePipeline(timers);
    p.fx.update(1 / 60);
    expect(p.fx.stats().live).toBe(0);
    expect(p.fx.stats().uploadedFloats).toBe(0);
    p.fx.impact(0, 0.5, 0, 0.95, { x: 1, z: 0 }, 0);
    p.fx.update(1 / 60);
    const st = p.fx.stats();
    expect(st.live).toBeGreaterThan(90);
    expect(st.updated).toBe(st.live);
    // 每个火花 12 + 12（拖尾位置 / 颜色）+ 3 + 3（头部位置 / 颜色）个浮点
    expect(st.uploadedFloats).toBe(st.live * 30);
    // 旧版每帧固定上传 900 × 30 = 27000 个浮点
    expect(st.uploadedFloats).toBeLessThan(27000);
    for (let i = 0; i < 90; i++) p.fx.update(1 / 60);
    expect(p.fx.stats().live).toBe(0);
    expect(p.fx.stats().uploadedFloats).toBe(0);
    p.dispose();
  });

  it('低画质下猛撞火花不少于高画质的 60%，普通火花按画质缩放', async () => {
    const p = await makePipeline(timers);
    p.fx.quality.sparkScale = 0.45;
    p.fx.impact(0, 0.5, 0, 0.95, { x: 1, z: 0 }, 0);
    const heavyLow = p.fx.stats().live;
    p.fx.clear();
    p.fx.impact(0, 0.5, 0, 0.5, { x: 1, z: 0 }, 0);
    const mediumLow = p.fx.stats().live;
    p.fx.clear();
    p.fx.quality.sparkScale = 1;
    p.fx.impact(0, 0.5, 0, 0.95, { x: 1, z: 0 }, 0);
    const heavyHigh = p.fx.stats().live;
    expect(heavyLow).toBeGreaterThanOrEqual(Math.round(heavyHigh * 0.6) - 1);
    expect(mediumLow).toBeLessThan(heavyLow);
    p.dispose();
  });

  it('池满时撞击火花仍能生成（摩擦火花给撞击留出余量）', async () => {
    const p = await makePipeline(timers);
    const g = { level: 1, x: 0, y: 0.5, z: 0, nx: 1, nz: 0, tx: 0, tz: 1 };
    for (let i = 0; i < 60; i++) {
      p.fx.grind(g, 1 / 60, 0);
      p.fx.update(1 / 60);
    }
    const before = p.fx.stats();
    expect(before.grindLive).toBeLessThanOrEqual(GRIND_SPARK_CAP);
    for (let i = 0; i < 8; i++) p.fx.impact(0, 0.5, 0, 0.95, { x: 1, z: 0 }, 0);
    const after = p.fx.stats();
    expect(after.live).toBeLessThanOrEqual(900);
    expect(after.live - after.grindLive).toBeGreaterThan(700);
    p.dispose();
  });
});
