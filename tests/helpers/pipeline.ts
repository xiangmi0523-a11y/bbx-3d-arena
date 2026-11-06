import { createArenaPhysics } from '../../src/game/arena/ArenaPhysics';
import { BattleSystem } from '../../src/game/battle/BattleSystem';
import { assembleBey } from '../../src/game/beys/parts/assemble';
import type { BeyLoadout } from '../../src/game/beys/parts/types';
import { AudioFX } from '../../src/game/audio/AudioFX';
import { BattleFeedback } from '../../src/game/core/BattleFeedback';
import type { LaunchCommand } from '../../src/game/launcher/PullStringGesture';
import { loadRapier, PhysicsWorld } from '../../src/game/physics/PhysicsWorld';
import { ImpactFX } from '../../src/game/render/ImpactFX';
import { unlockWithMock } from './audioMock';
import { installDomStub } from './domStub';

/**
 * 整条反馈链路的无头模拟：真实 Rapier 物理 → BattleSystem（撞击 + 接触状态机）→ BattleFeedback
 * → 真实 ImpactFX（粒子池）+ 真实 AudioFX（Web Audio 桩）+ 镜头桩。按 60 fps 帧推进，每帧 2 个物理步。
 */
export interface PipelineFrame {
  t: number;
  phase: string;
  level: number;
  live: number;
  grindLive: number;
  audioSources: number;
  grindChain: boolean;
}

export async function makePipeline(advanceTimers: (ms: number) => void = () => {}) {
  installDomStub();
  const R = await loadRapier();
  const fx = new ImpactFX();
  const audio = new AudioFX();
  const ctx = unlockWithMock(audio);
  const camShakes: number[] = [];
  const feedback = new BattleFeedback(fx, audio, { impact: (s) => camShakes.push(s) });
  let pw: PhysicsWorld | null = null;
  let battle: BattleSystem | null = null;

  const startBattle = (lo: { player: BeyLoadout; rival: BeyLoadout }, cmd: { player: LaunchCommand; rival: LaunchCommand }) => {
    battle?.dispose();
    pw?.dispose();
    fx.clear();
    audio.stopGrind();
    pw = new PhysicsWorld(R);
    createArenaPhysics(pw);
    const b = new BattleSystem(pw, { player: assembleBey(lo.player), rival: assembleBey(lo.rival) });
    pw.beforeStep = (dt) => b.preStep(dt);
    pw.afterStep = (dt) => b.postStep(dt);
    b.launch('player', cmd.player);
    b.launch('rival', cmd.rival);
    battle = b;
    return b;
  };

  /** 推进一帧（1/60 s）：物理 2 步 + 反馈分发 + 粒子更新 + 音频时钟 */
  const frame = (opts: { beforeStep?: (b: BattleSystem) => void } = {}): PipelineFrame => {
    const dt = 1 / 60;
    if (pw && battle) {
      for (let i = 0; i < 2; i++) {
        opts.beforeStep?.(battle);
        pw.step();
      }
      feedback.frame(battle, dt);
    }
    fx.update(dt);
    ctx.advance(dt);
    advanceTimers(1000 / 60);
    const st = fx.stats();
    return {
      t: battle?.time ?? 0,
      phase: battle?.contact.state.phase ?? 'idle',
      level: battle?.contact.state.level ?? 0,
      live: st.live,
      grindLive: st.grindLive,
      audioSources: ctx.liveSources,
      grindChain: audio.stats().grind,
    };
  };

  /** 只推进时间（对战结束后 / 暂停时）：不跑物理，粒子和音频自然衰减 */
  const idleFrame = (): PipelineFrame => {
    const dt = 1 / 60;
    fx.grind({ level: 0, x: 0, y: 0, z: 0, nx: 1, nz: 0, tx: 0, tz: 1 }, dt, 0);
    audio.setGrind(0, 0, 0);
    fx.update(dt);
    ctx.advance(dt);
    advanceTimers(1000 / 60);
    const st = fx.stats();
    return { t: 0, phase: 'idle', level: 0, live: st.live, grindLive: st.grindLive, audioSources: ctx.liveSources, grindChain: audio.stats().grind };
  };

  return {
    fx,
    audio,
    ctx,
    feedback,
    camShakes,
    startBattle,
    frame,
    idleFrame,
    get battle() {
      return battle;
    },
    get pw() {
      return pw;
    },
    dispose() {
      battle?.dispose();
      pw?.dispose();
      audio.stopGrind();
    },
  };
}
