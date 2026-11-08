import { mkdirSync, writeFileSync } from 'node:fs';
import { test } from 'vitest';
import { createArenaPhysics } from '../../src/game/arena/ArenaPhysics';
import { floorHeight } from '../../src/game/arena/arenaSpec';
import { BattleSystem, type ImpactEvent } from '../../src/game/battle/BattleSystem';
import { assembleBey } from '../../src/game/beys/parts/assemble';
import { PLAYER_LOADOUT, RIVAL_LOADOUT } from '../../src/game/beys/parts/catalog';
import { rivalCommand } from '../../src/game/launcher/launch';
import { loadRapier, PhysicsWorld } from '../../src/game/physics/PhysicsWorld';
import { ImpactFX } from '../../src/game/render/ImpactFX';
import { seeded } from '../feelSim';
import { installDomStub } from '../helpers/domStub';
import { ImpactFX as LegacyFX } from './legacy/ImpactFX.1f1f38c';

/**
 * 战斗 CPU 分段计时（Node / V8，同一台机器上对照）：
 *  A. 物理步：world.step / preStep / postStep（含新增的接触读取与状态机），接触反馈开 / 关对照，含 P50 / P99 / 最大值；
 *  B. 粒子：把真实对战录下的撞击事件和摩擦状态按 60 fps 回放给旧版（1f1f38c）与新版 ImpactFX，
 *     比较每帧 update() 耗时、遍历的粒子数、上传到 GPU 的浮点数。
 * 只有 CPU 时间；GPU / 合成耗时在这里测不到。
 *   npx vitest run --config vitest.diag.config.ts tests/diag/battleperf.diag.ts
 */
const q = (a: number[], k: number) => {
  const s = [...a].sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * k))] : NaN;
};
const r3 = (x: number) => +x.toFixed(4);

interface Frame { impacts: ImpactEvent[]; grind: { level: number; x: number; y: number; z: number; nx: number; nz: number; tx: number; tz: number } }

test('battle perf', async () => {
  installDomStub();
  const R = await loadRapier();
  const SEEDS = Number(process.env.DIAG_N ?? 8);
  const out: Record<string, unknown> = {};
  const recorded: Frame[] = [];
  for (const on of [false, true, false, true]) {
    const world: number[] = [], pre: number[] = [], post: number[] = [];
    const worldContact: number[] = [], worldFree: number[] = [];
    let ccdSteps = 0;
    const worldCcd: number[] = [];
    for (let seed = 0; seed < SEEDS; seed++) {
      const orig = Math.random;
      Math.random = seeded(2000 + seed);
      const pw = new PhysicsWorld(R);
      createArenaPhysics(pw);
      const b = new BattleSystem(pw, { player: assembleBey(PLAYER_LOADOUT), rival: assembleBey(RIVAL_LOADOUT) }, { contactFeedback: on });
      let tPre = 0, tPost = 0;
      pw.beforeStep = (dt) => { const t = performance.now(); b.preStep(dt); tPre = performance.now() - t; };
      pw.afterStep = (dt) => { const t = performance.now(); b.postStep(dt); tPost = performance.now() - t; };
      const rnd = Math.random;
      b.launch('player', { power: 0.6 + rnd() * 0.35, aim: (rnd() - 0.5) * 0.8, tilt: 0 });
      b.launch('rival', rivalCommand(rnd));
      for (let i = 0; i < 120 * 60 && !b.result; i++) {
        const t = performance.now();
        pw.step();
        const tot = performance.now() - t;
        world.push(tot - tPre - tPost);
        if (on) (b.contact.state.phase !== 'idle' ? worldContact : worldFree).push(tot - tPre - tPost);
        if (b.beys.player!.body.isCcdEnabled() || b.beys.rival!.body.isCcdEnabled()) {
          ccdSteps++;
          worldCcd.push(tot - tPre - tPost);
        }
        pre.push(tPre);
        post.push(tPost);
        if (on && recorded.length < 60 * 400 && i % 2 === 1) {
          const c = b.contact.state;
          recorded.push({ impacts: b.impacts.splice(0), grind: { level: c.level, x: c.x, y: c.y, z: c.z, nx: c.nx, nz: c.nz, tx: c.tx, tz: c.tz } });
        }
      }
      pw.dispose();
      Math.random = orig;
    }
    const m = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
    out[`steps_${on ? 'on' : 'off'}`] = {
      steps: world.length,
      worldMean: r3(m(world)), worldP99: r3(q(world, 0.99)), worldMax: r3(q(world, 1)),
      ...(on ? { worldInContactMean: r3(m(worldContact)), worldInContactP99: r3(q(worldContact, 0.99)), worldFreeMean: r3(m(worldFree)), worldFreeP99: r3(q(worldFree, 0.99)), contactStepShare: r3(worldContact.length / world.length) } : {}),
      ccdStepShare: r3(ccdSteps / world.length),
      worldCcdMean: r3(worldCcd.reduce((x, y) => x + y, 0) / Math.max(1, worldCcd.length)),
      over1msInCcd: worldCcd.filter((x) => x > 1).length,
      first2sOver1ms: world.slice(0, 240).filter((x) => x > 1).length,
      stepsOver1ms: world.filter((x) => x > 1).length,
      preMean: r3(m(pre)), postMean: r3(m(post)), postP99: r3(q(post, 0.99)), postMax: r3(q(post, 1)),
    };
  }

  // B. 粒子回放
  const replay = (fx: { impact: ImpactFX['impact']; update(dt: number): void }, grind: ((g: Frame['grind']) => void) | null, stress: boolean) => {
    const times: number[] = [];
    for (let f = 0; f < recorded.length; f++) {
      const fr = recorded[f];
      for (const e of fr.impacts) if (e.feedback === 'play') fx.impact(e.x, e.y, e.z, e.strength, { x: e.nx, z: e.nz }, floorHeight(Math.hypot(e.x, e.z)));
      if (stress && f % 30 === 0) fx.impact(0, 0.5, 0, 0.95, { x: 1, z: 0 }, 0);
      grind?.(fr.grind);
      const t = performance.now();
      fx.update(1 / 60);
      times.push(performance.now() - t);
    }
    return times;
  };
  for (const stress of [false, true]) {
    for (let rep = 0; rep < 2; rep++) {
      const legacy = new LegacyFX();
      const newNoGrind = new ImpactFX();
      const newFx = new ImpactFX();
      const tl = replay(legacy as unknown as ImpactFX, null, stress);
      const tn = replay(newNoGrind, null, stress);
      let live = 0, maxLive = 0, upl = 0, idle = 0;
      const tg: number[] = [];
      for (let f = 0; f < recorded.length; f++) {
        const fr = recorded[f];
        for (const e of fr.impacts) if (e.feedback === 'play') newFx.impact(e.x, e.y, e.z, e.strength, { x: e.nx, z: e.nz }, floorHeight(Math.hypot(e.x, e.z)));
        if (stress && f % 30 === 0) newFx.impact(0, 0.5, 0, 0.95, { x: 1, z: 0 }, 0);
        const t = performance.now();
        newFx.grind(fr.grind, 1 / 60, 0);
        newFx.update(1 / 60);
        tg.push(performance.now() - t);
        const st = newFx.stats();
        live += st.live;
        maxLive = Math.max(maxLive, st.live);
        upl += st.uploadedFloats;
        if (st.live === 0) idle++;
      }
      const m = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
      if (rep === 1)
        out[`fx_${stress ? 'stress' : 'battle'}`] = {
          frames: recorded.length,
          legacyMeanMs: r3(m(tl)), legacyP99: r3(q(tl, 0.99)),
          newImpactOnlyMeanMs: r3(m(tn)), newImpactOnlyP99: r3(q(tn, 0.99)),
          newWithGrindMeanMs: r3(m(tg)), newWithGrindP99: r3(q(tg, 0.99)),
          legacyFloatsPerFrame: 900 * 30,
          newFloatsPerFrame: Math.round(upl / recorded.length),
          legacySparksIteratedPerFrame: 900,
          newSparksIteratedPerFrame: +(live / recorded.length).toFixed(1),
          newMaxLive: maxLive,
          framesWithNoSparks: +(idle / recorded.length).toFixed(3),
        };
    }
  }
  mkdirSync('test-results/diag', { recursive: true });
  writeFileSync(`test-results/diag/battleperf-${process.env.DIAG_LABEL ?? 'now'}.json`, JSON.stringify(out, null, 1));
});
