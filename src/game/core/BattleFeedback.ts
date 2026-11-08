import { floorHeight } from '../arena/arenaSpec';
import type { BattleSystem, ImpactEvent } from '../battle/BattleSystem';
import { impactFeedback, type ImpactTier } from '../battle/impactTiers';
import type { GrindInput } from '../render/ImpactFX';

/** 反馈输出端口（真实游戏里是 ImpactFX / AudioFX / BattleCamera；测试里可替换为桩） */
export interface FeedbackFx {
  impact(x: number, y: number, z: number, strength: number, normal: { x: number; z: number }, floorY: number): void;
  grind(g: GrindInput, dt: number, floorY: number): void;
}
export interface FeedbackAudio {
  clash(strength: number): void;
  setGrind(level: number, slide: number, spin: number): void;
  stopGrind(): void;
}
export interface FeedbackCamera {
  impact(shake: number, fovKick?: number, dir?: { x: number; z: number }): void;
}

/**
 * 每帧把战斗系统的接触结果分发给特效、音频、镜头（P2.3.2 从 GameEngine 拆出，便于整条链路做无头测试）。
 *  - 强碰撞 / 轻擦撞击：BattleSystem.impacts（每次 Rapier 开始接触结算一次，物理不变）。
 *    feedback = 'merge' 的事件（同一接触段内紧跟着的更弱强碰撞）不重复播放；
 *  - 持续摩擦：BattleSystem.contact.state，强度连续，特效和音频各自限频、限量。
 * 镜头只对撞击事件做出反应（与原来相同），摩擦层不动镜头。
 */
export class BattleFeedback {
  /** 最近一次播放的撞击（调试 / 测试用） */
  lastImpact: { strength: number; tier: ImpactTier } | null = null;
  played = 0;
  mergedSkipped = 0;

  constructor(
    private readonly fx: FeedbackFx,
    private readonly audio: FeedbackAudio,
    private readonly cam: FeedbackCamera | null,
  ) {}

  /** 一次撞击的全部反馈：特效、镜头、音效、振动（按等级区分） */
  playImpact(imp: ImpactEvent): void {
    if (imp.feedback !== 'play') {
      // merge：反馈由同一接触段里前一次更强的撞击代表；absorb：已并入持续摩擦层。物理冲量都已施加
      this.mergedSkipped++;
      return;
    }
    const fb = impactFeedback(imp.strength);
    this.fx.impact(imp.x, imp.y, imp.z, imp.strength, { x: imp.nx, z: imp.nz }, floorHeight(Math.hypot(imp.x, imp.z)));
    this.cam?.impact(fb.shake, fb.fovKick, { x: imp.nx, z: imp.nz });
    this.audio.clash(imp.strength);
    // 振动：iPhone Safari 没有实现 Vibration API（navigator.vibrate 不存在），这里只在 Android 浏览器生效。
    // iPhone 上的触感反馈要等 Capacitor 打包后用原生 Haptics 插件实现。
    if (fb.vibrate > 0 && typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') navigator.vibrate(fb.vibrate);
    this.lastImpact = { strength: imp.strength, tier: fb.tier };
    this.played++;
  }

  /** 物理推进之后、每帧调用：播放本帧的撞击，并更新持续摩擦层 */
  frame(battle: BattleSystem, dt: number): void {
    for (const imp of battle.impacts) this.playImpact(imp);
    battle.impacts.length = 0;
    const a = battle.beys.player;
    const b = battle.beys.rival;
    const cs = battle.contact.state;
    this.fx.grind(cs, dt, floorHeight(Math.hypot(cs.x, cs.z)));
    this.audio.setGrind(cs.level, cs.slide, a && b ? a.spin + b.spin : 0);
  }
}
