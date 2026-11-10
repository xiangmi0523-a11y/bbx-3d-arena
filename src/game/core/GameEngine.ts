import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { createArenaPhysics } from '../arena/ArenaPhysics';
import { createArenaVisual } from '../arena/ArenaVisual';
import { ARENA_SCALE } from '../arena/arenaSpec';
import { AudioFX } from '../audio/AudioFX';
import { BattleSystem, type BattleResult, type ImpactEvent } from '../battle/BattleSystem';
import { impactTier } from '../battle/impactTiers';
import { describeOutcome, Match, type RoundOutcome } from '../battle/match';
import { floorHeight } from '../arena/arenaSpec';
import type { AiLevel } from '../beys/motionIntent';
import { createBeyVisual, type BeyVisual } from '../beys/BeyVisualFactory';
import { assembleBey, swapPart, type AssembledBey } from '../beys/parts/assemble';
import { buildName, listParts, PLAYER_LOADOUT, ROLE_INFO, sanitizeLoadout, signatureOf, SIGNATURE_LIST, SIGNATURES, type SignatureKey } from '../beys/parts/catalog';
import type { BeyLoadout, BeyRole, PartKind, PartSpec } from '../beys/parts/types';
import { BattleCamera } from '../camera/BattleCamera';
import { GarageView, renderThumbnails, type FocusRect } from '../garage/GarageView';
import { aiLaunchCommand, launchDirection, launchPoint, powerTier, type Side } from '../launcher/launch';
import { LauncherModel } from '../launcher/LauncherModel';
import { IDLE_PULL, PullStringGesture, type LaunchCommand, type PullState } from '../launcher/PullStringGesture';
import { loadRapier, PhysicsWorld, PHYSICS_DT, type Rapier } from '../physics/PhysicsWorld';
import { ImpactFX } from '../render/ImpactFX';
import { BattleFeedback } from './BattleFeedback';
import { initialQuality, QualityController, type QualityLevel, type QualityPreset } from '../render/Quality';
import { SaveStore, type SaveData } from '../storage/SaveStore';
import { Store } from './Store';

/**
 * 引擎阶段。title = 全部菜单页（具体哪一页由 screen 决定，3D 背景是竞技场概览）；
 * aim → battle → roundEnd 为一个回合；先到 4 分后进入 matchEnd（比赛结算）。
 */
export type GamePhase = 'loading' | 'title' | 'garage' | 'aim' | 'battle' | 'roundEnd' | 'matchEnd' | 'paused' | 'error';

/** 菜单页（v2.0 §10.2 最小 6 屏：主界面 / 陀螺库 / 组装 / 模式与对手 / 竞技场选择 / 战斗准备） */
export type MenuScreen = 'home' | 'library' | 'mode' | 'arena' | 'prep';
export type ArenaId = 'standard' | 'velocity' | 'sky';
export type ModeId = 'free' | 'challenge' | 'tournament' | 'survival';

export interface MatchSetup {
  mode: ModeId;
  arena: ArenaId;
  difficulty: AiLevel;
  /** 对手：签名构筑，或每场随机 */
  rival: SignatureKey | 'random';
}

export interface Settings {
  /** 减特效：关闭爆裂慢动作与镜头震动（v2.0 §10.3 无障碍） */
  reduceEffects: boolean;
  sound: boolean;
}

export interface BeyHud {
  name: string;
  code: string;
  role: BeyRole;
  color: number;
  spin: number; // 0..1
  rpm: number;
  dashing: boolean;
  /** 爆裂应力 0..1（v2.0 §6.3） */
  stress: number;
  burst: boolean;
}

export interface RoundStats {
  /** 两台之间的确认接触段数 */
  contacts: number;
  /** 最大单段实测法向冲量（N·s） */
  maxImpulse: number;
  dashes: Record<Side, number>;
  peakStress: Record<Side, number>;
  duration: number;
}

export interface RoundView {
  number: number;
  outcome: RoundOutcome;
  /** 胜负原因一句话 */
  text: string;
  stats: RoundStats;
}

export interface MatchView {
  target: number;
  score: Record<Side, number>;
  /** 当前（或下一个）回合序号 */
  round: number;
  /** 3–3 决胜轮 */
  decider: boolean;
  rounds: RoundView[];
  winner: Side | null;
}

export interface GarageState {
  /** 正在编辑的组装方案（确认前不影响战斗） */
  draft: BeyLoadout;
  exploded: boolean;
  /** 部件缩略图（由真实 3D 模型渲染），key = kind:id */
  thumbs: Record<string, string>;
}

export interface GameSnapshot {
  phase: GamePhase;
  error?: string;
  pull: PullState;
  player: BeyHud;
  rival: BeyHud;
  loadout: BeyLoadout;
  time: number;
  hits: number;
  /** 本回合的判定结果（回合结束后有值） */
  result: BattleResult | null;
  screen: MenuScreen;
  setup: MatchSetup;
  rivalLoadout: BeyLoadout;
  match: MatchView | null;
  lastRound: RoundView | null;
  settings: Settings;
  save: SaveData;
  fps: number;
  quality: QualityLevel;
  /** 慢动作中（UI 可做提示） */
  garage: GarageState;
}

const hudOf = (spec: AssembledBey): BeyHud => ({
  name: buildName(spec.loadout),
  code: `${spec.blade.code} · ${spec.ratchet.code} · ${spec.bit.code}`,
  role: spec.role,
  color: signatureOf(spec.loadout)?.color ?? ROLE_INFO[spec.role].color,
  spin: 0,
  rpm: 0,
  dashing: false,
  stress: 0,
  burst: false,
});

/** 回合结束后的休整时间（秒，v2.0 §6.5：显示比分，3 秒后进入下一回合） */
export const ROUND_REST = 3;
/** 爆裂表现：慢动作时长与时间缩放（只改表现时间流速，物理步长不变，v2.0 §6.3） */
const BURST_SLOWMO = { time: 0.4, scale: 0.35 };

/** 爆裂后飞出的 Blade（只是表现：物理上 Blade 碰撞体已移除） */
interface FlyingBlade {
  side: Side;
  obj: THREE.Object3D;
  vx: number;
  vy: number;
  vz: number;
  spin: number;
  tumble: number;
  landed: boolean;
}

const SIDES: Side[] = ['player', 'rival'];

/**
 * 游戏主引擎：把渲染（Three.js）、物理（Rapier）、对战规则、输入、摄像机、音效、组装界面串起来。
 * React 只通过 store 读取快照、通过公开方法发出指令，不直接接触 3D 对象。
 */
const _Y = new THREE.Vector3(0, 1, 0);
const _up = new THREE.Vector3();
const _rp = { x: 0, y: 0, z: 0 };
const _ru = { x: 0, y: 1, z: 0 };
const _tilt = new THREE.Quaternion();
const _yaw = new THREE.Quaternion();

export class GameEngine {
  readonly store: Store<GameSnapshot>;
  readonly gesture = new PullStringGesture();
  readonly audio = new AudioFX();
  private readonly container: HTMLElement;
  private renderer!: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private envTexture: THREE.Texture | null = null;
  private keyLight!: THREE.DirectionalLight;
  /** 氛围补光（低 / 中档关闭，见 QualityPreset.accentLights） */
  private accentLights: THREE.Light[] = [];
  private cam!: BattleCamera;
  private R!: Rapier;
  private pw: PhysicsWorld | null = null;
  private battle: BattleSystem | null = null;
  private specs: Record<Side, AssembledBey>;
  private visuals: Partial<Record<Side, BeyVisual>> = {};
  private launchers: Record<Side, LauncherModel>;
  private fx = new ImpactFX();
  private feedback!: BattleFeedback;
  private garage: GarageView | null = null;
  private garageFocus: FocusRect | null = null;
  private aimArrow!: THREE.Mesh;
  private raf = 0;
  private last = 0;
  private uiTimer = 0;
  private fpsAcc = { frames: 0, time: 0, fps: 0 };
  private previewSpin = 0;
  private resultRecorded = false;
  /**
   * P2.2.1：取消慢动作和 Hit-stop，所有碰撞都以正常时间流速进行。
   * 撞击力度只通过真实的物理结果（速度 / 方向变化）和火花、音效、镜头表现。
   */
  /** 最近一次撞击（调试 / 测试用） */
  /** 视觉转角：与物理转速解耦，避免 60fps 下高速旋转出现频闪 / 糊成一团 */
  private visualYaw: Record<Side, number> = { player: 0, rival: 0 };
  private dprQuery: MediaQueryList | null = null;
  private readonly save = new SaveStore();
  private quality: QualityController;
  private readonly initialQuality: QualityLevel;
  private resizeObserver: ResizeObserver | null = null;
  private disposed = false;
  private pausedFrom: GamePhase = 'battle';
  /** 进行中的比赛（先到 4 分） */
  private match: Match | null = null;
  private roundViews: RoundView[] = [];
  private restTimer = 0;
  private burstSeen = 0;
  private slowmo = 0;
  private flying: FlyingBlade[] = [];
  /** 组装界面关闭后回到哪个菜单页 */
  private garageReturn: MenuScreen = 'home';
  /** 本回合玩家实际使用的发射力度（三档之一，测试读取） */
  private lastLaunchPower: number | null = null;

  /** 默认对局 = v2.0 §3.5 的新手向默认组合：森衡（平衡）对 磐盾（防守）；存档里有上次的构筑时用存档 */
  constructor(container: HTMLElement, loadouts: Record<Side, BeyLoadout> = { player: SIGNATURES.senheng.loadout, rival: SIGNATURES.pandun.loadout }) {
    this.container = container;
    this.specs = { player: assembleBey(loadouts.player), rival: assembleBey(loadouts.rival) };
    this.launchers = { player: new LauncherModel(0xe8302a), rival: new LauncherModel(0x1f7cf0) };
    this.initialQuality = initialQuality(navigator.userAgent, window.devicePixelRatio || 1, navigator.hardwareConcurrency || 4);
    this.quality = new QualityController(this.initialQuality);
    this.store = new Store<GameSnapshot>({
      phase: 'loading',
      pull: IDLE_PULL,
      player: hudOf(this.specs.player),
      rival: hudOf(this.specs.rival),
      loadout: { ...loadouts.player },
      time: 0,
      hits: 0,
      result: null,
      screen: 'home',
      setup: { mode: 'free', arena: 'standard', difficulty: 'pro', rival: 'pandun' },
      rivalLoadout: { ...loadouts.rival },
      match: null,
      lastRound: null,
      settings: { reduceEffects: false, sound: true },
      save: this.save.data,
      fps: 0,
      quality: this.quality.level,
      garage: { draft: { ...loadouts.player }, exploded: false, thumbs: {} },
    });
  }

  async init(): Promise<void> {
    try {
      this.setupRenderer();
      this.setupScene();
      const [R, save] = await Promise.all([loadRapier(), withTimeout(this.save.load(), 1500, this.save.data)]);
      if (this.disposed) return;
      this.R = R;
      this.store.set({ save });
      // 读取上次的组装方案（校验每个部件，不认识的单独回退）
      if (save.lastLoadout) this.applyPlayerLoadout(sanitizeLoadout(save.lastLoadout, PLAYER_LOADOUT));
      this.resetRound();
      this.setPhase('title');
      this.cam.setMode('overview', true);
      // 预先编译撞击特效的着色器，第一次猛撞不再卡一帧
      try {
        this.fx.prewarm(this.renderer, this.scene, this.cam.camera);
      } catch (err) {
        console.warn('特效预热失败', err);
      }
      this.last = performance.now();
      this.raf = requestAnimationFrame(this.frame);
      document.addEventListener('visibilitychange', this.onVisibility);
      // iOS：首次触摸时解锁音频
      window.addEventListener('pointerdown', this.unlockAudio, { capture: true });
      window.addEventListener('touchend', this.unlockAudio, { capture: true });
    } catch (err) {
      console.error(err);
      this.store.set({ phase: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  }

  // ───────────────────────── 公开指令（UI 调用） ─────────────────────────

  // ── 菜单导航（title 阶段内切换页面，3D 背景不变） ──

  navigate(screen: MenuScreen): void {
    if (this.phase !== 'title') return;
    this.store.set({ screen });
  }

  /** 修改比赛设置；对手换成某个签名构筑时立即换上它的模型 */
  setSetup(patch: Partial<MatchSetup>): void {
    const setup = { ...this.store.get().setup, ...patch };
    this.store.set({ setup });
    if (patch.rival && patch.rival !== 'random') this.applyRivalLoadout(SIGNATURES[patch.rival].loadout);
  }

  /** 陀螺库：装备一个签名构筑（零件可再到组装界面自由替换） */
  equipSignature(key: SignatureKey): void {
    if (this.phase !== 'title') return;
    const loadout = SIGNATURES[key].loadout;
    this.applyPlayerLoadout(loadout);
    this.resetRound();
    void this.save.update({ lastLoadout: loadout }).then((save) => this.store.set({ save }));
  }

  setSettings(patch: Partial<Settings>): void {
    const settings = { ...this.store.get().settings, ...patch };
    this.store.set({ settings });
    this.audio.setMuted(!settings.sound);
  }

  /** 战斗准备 → 开始一场比赛（先到 4 分），进入第 1 回合的发射准备 */
  startMatch(): void {
    if (this.phase !== 'title' && this.phase !== 'matchEnd') return;
    const setup = this.store.get().setup;
    if (setup.rival === 'random') {
      const mine = signatureOf(this.specs.player.loadout)?.key;
      const pool = SIGNATURE_LIST.filter((x) => x.key !== mine);
      this.applyRivalLoadout(pool[Math.floor(Math.random() * pool.length)].loadout);
    }
    this.match = new Match();
    this.roundViews = [];
    this.publishMatch();
    this.store.set({ lastRound: null });
    this.resetRound();
    this.setPhase('aim');
    this.cam.setMode('aim');
  }

  /** 兼容旧入口（键盘 / 自动化测试）：标题直接开始一场比赛 */
  start(): void {
    if (this.phase !== 'title') return;
    this.startMatch();
  }

  pullStart(x: number, y: number, maxPull: number): void {
    if (this.phase !== 'aim') return;
    this.gesture.configure({ maxPull });
    this.store.set({ pull: this.gesture.start(x, y, performance.now()) });
  }

  pullMove(x: number, y: number): void {
    if (this.phase !== 'aim' || !this.gesture.active) return;
    this.store.set({ pull: this.gesture.move(x, y, performance.now()) });
  }

  pullEnd(): LaunchCommand | null {
    if (this.phase !== 'aim') return null;
    const cmd = this.gesture.end(performance.now());
    this.store.set({ pull: IDLE_PULL });
    if (cmd) this.launch(cmd);
    return cmd;
  }

  pullCancel(): void {
    this.gesture.cancel();
    this.store.set({ pull: IDLE_PULL });
  }

  /** 发射（拉绳松手、键盘、测试）。力度归到三档（轻 / 中 / 重），对手按难度决定自己的发射 */
  launch(cmd: LaunchCommand): void {
    if (this.phase !== 'aim' || !this.battle) return;
    const tier = powerTier(cmd.power);
    const playerCmd = { ...cmd, power: tier.power };
    this.lastLaunchPower = tier.power;
    this.battle.launch('player', playerCmd);
    this.battle.launch('rival', aiLaunchCommand(Math.random, this.store.get().setup.difficulty));
    for (const side of SIDES) {
      const v = this.visuals[side]!;
      this.scene.attach(v.root);
      this.launchers[side].root.visible = false;
    }
    this.aimArrow.visible = false;
    this.pw!.resetAccumulator();
    this.setPhase('battle');
    this.cam.setMode('battle');
    this.cam.impact(0.35, 0.2);
    this.audio.launch(playerCmd.power);
    navigator.vibrate?.(20);
  }

  pause(): void {
    if (this.phase === 'battle' || this.phase === 'aim' || this.phase === 'roundEnd') {
      this.pausedFrom = this.phase;
      this.gesture.cancel();
      this.audio.stopHum();
      this.audio.stopGrind();
      this.setPhase('paused');
    }
  }

  resume(): void {
    if (this.phase !== 'paused') return;
    this.setPhase(this.pausedFrom);
    this.pw?.resetAccumulator();
    this.last = performance.now();
  }

  /** 回合结算页：不等 3 秒，直接进入下一回合（或比赛结算） */
  continueRound(): void {
    if (this.phase !== 'roundEnd') return;
    this.advanceMatch();
  }

  /** 重赛：同样的设置再打一场 */
  rematch(): void {
    if (this.phase !== 'matchEnd' && this.phase !== 'paused') return;
    this.setPhase('title');
    this.startMatch();
  }

  /** 旧入口：重新开始 = 重赛 */
  restart(): void {
    if (this.match && (this.phase === 'paused' || this.phase === 'matchEnd' || this.phase === 'roundEnd')) {
      this.setPhase('title');
      this.startMatch();
    }
  }

  /** 战斗中切换镜头：跟随 ↔ 全场 */
  toggleCamera(): void {
    if (this.phase !== 'battle' && this.phase !== 'roundEnd') return;
    this.cam.setMode(this.cam.mode === 'battle' ? 'overview' : 'battle');
  }

  toTitle(screen: MenuScreen = 'home'): void {
    this.match = null;
    this.publishMatch();
    this.resetRound();
    this.store.set({ screen, lastRound: null });
    this.setPhase('title');
    this.cam.setMode('overview');
  }

  setQuality(level: QualityLevel | 'auto'): void {
    if (level === 'auto') {
      this.quality.locked = false;
      return;
    }
    this.quality.set(level, true);
  }

  // ── 组装界面 ──

  openGarage(): void {
    if (this.phase !== 'title' && this.phase !== 'matchEnd') return;
    // 关闭后回到打开它的那一页（比赛结算页 → 战斗准备）
    this.garageReturn = this.phase === 'matchEnd' ? 'prep' : this.store.get().screen;
    this.match = null;
    this.publishMatch();
    this.resetRound();
    const draft = { ...this.store.get().loadout };
    this.garage?.dispose();
    this.garage = new GarageView(assembleBey(draft));
    this.garage.scene.environment = this.envTexture;
    this.garage.onSnap = () => {
      this.audio.click();
      navigator.vibrate?.(8);
    };
    this.layoutGarage();
    this.applyQuality(this.quality.preset);
    this.store.set({ phase: 'garage', garage: { ...this.store.get().garage, draft, exploded: false } });
    // 缩略图生成放到下一帧，先让界面出来
    if (!Object.keys(this.store.get().garage.thumbs).length) {
      setTimeout(() => this.buildThumbnails(), 50);
    }
  }

  /** UI 告诉引擎：3D 模型应显示在屏幕的哪个区域（CSS 像素） */
  setGarageFocus(rect: FocusRect | null): void {
    this.garageFocus = rect;
    this.layoutGarage();
  }

  /** 只替换一个部件，另外两个部件保持不变 */
  garageSelect(kind: PartKind, id: string): void {
    if (this.phase !== 'garage' || !this.garage) return;
    const g = this.store.get().garage;
    if (g.draft[kind] === id) return;
    const draft = swapPart(g.draft, kind, id);
    const spec = assembleBey(draft);
    this.garage.swap(kind, spec[kind], spec);
    this.store.set({ garage: { ...g, draft } });
  }

  garageToggleExplode(): void {
    if (!this.garage) return;
    const g = this.store.get().garage;
    this.garage.explode = !g.exploded;
    // 分解时把放大倍数收回到 1 以内，保证三个部件都在画面里
    if (!g.exploded) this.garage.zoom(1 / Math.max(1, this.garage.zoomFactor));
    this.store.set({ garage: { ...g, exploded: !g.exploded } });
  }

  garageRotate(dx: number, dy: number): void {
    this.garage?.rotate(dx, dy);
  }

  garageZoom(factor: number): void {
    this.garage?.zoom(factor);
  }

  garageResetView(): void {
    this.garage?.resetView();
  }

  /** 确认组装：传入战斗系统并存档 */
  garageConfirm(): void {
    if (this.phase !== 'garage') return;
    const draft = this.store.get().garage.draft;
    this.applyPlayerLoadout(draft);
    void this.save.update({ lastLoadout: draft }).then((save) => this.store.set({ save }));
    this.closeGarage();
  }

  garageCancel(): void {
    if (this.phase !== 'garage') return;
    this.closeGarage();
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    document.removeEventListener('visibilitychange', this.onVisibility);
    window.removeEventListener('pointerdown', this.unlockAudio, { capture: true });
    window.removeEventListener('touchend', this.unlockAudio, { capture: true });
    this.resizeObserver?.disconnect();
    this.audio.stopGrind();
    this.fx.dispose();
    this.battle?.dispose();
    this.pw?.dispose();
    this.garage?.dispose();
    for (const v of Object.values(this.visuals)) v?.dispose();
    this.renderer?.dispose();
    this.renderer?.domElement.remove();
  }

  /** 调试 / 自动化测试用：不渲染直接推进物理（秒） */
  debugFastForward(seconds: number): void {
    if (!this.pw || !this.battle || this.phase !== 'battle') return;
    const steps = Math.round(seconds * 120);
    for (let i = 0; i < steps && !this.battle.result; i++) this.pw.step();
    this.battle.impacts.length = 0;
  }

  /** 调试 / 自动化测试用：读取物理状态 */
  debugState() {
    const b = this.battle;
    const read = (s: Side) => {
      const bey = b?.beys[s];
      if (!bey) return null;
      const p = bey.body.translation();
      return { x: p.x, y: p.y, z: p.z, spin: bey.spin, tilt: bey.tilt, loadout: bey.spec.loadout };
    };
    return {
      phase: this.phase,
      launchPower: this.lastLaunchPower,
      time: b?.time ?? 0,
      hits: b?.hits ?? 0,
      player: read('player'),
      rival: read('rival'),
      result: b?.result ?? null,
      pixelRatio: this.renderer.getPixelRatio(),
      devicePixelRatio: window.devicePixelRatio || 1,
      canvas: (() => {
        const c = this.renderer.domElement;
        const r = c.getBoundingClientRect();
        const gl = this.renderer.getContext();
        return {
          cssWidth: r.width,
          cssHeight: r.height,
          width: c.width,
          height: c.height,
          drawingBufferWidth: gl.drawingBufferWidth,
          drawingBufferHeight: gl.drawingBufferHeight,
          samples: gl.getParameter(gl.SAMPLES) as number,
        };
      })(),
      expectedPixelRatio: this.quality.pixelRatio(window.devicePixelRatio || 1),
      quality: this.quality.level,
      initialQuality: this.initialQuality,
      playerVisual: this.visuals.player
        ? {
            blade: this.visuals.player.blade.name,
            ratchet: this.visuals.player.ratchet.name,
            bit: this.visuals.player.bit.name,
          }
        : null,
    };
  }

  /** 调试：手动触发一次撞击特效（不影响物理） */
  debugImpact(strength: number): void {
    this.playImpact(
      {
        strength,
        tier: impactTier(strength),
        approach: 0,
        impulse: 0,
        dvRel: strength * 12,
        x: 0,
        y: 0.5,
        z: 0,
        nx: 1,
        nz: 0,
        episode: 0,
        feedback: 'play',
      },
    );
  }

  /** 调试：最近一次撞击的反馈参数 */
  debugLastImpact() {
    const l = this.feedback.lastImpact;
    return l ? { ...l } : null;
  }

  /** 调试：接触反馈状态（持续摩擦层、特效与音频的数量统计） */
  debugContact() {
    const c = this.battle?.contact;
    return {
      state: c ? { ...c.state } : null,
      episodes: c?.episodes ?? 0,
      grindEpisodes: c?.grindEpisodes ?? 0,
      merged: c?.merged ?? 0,
      absorbed: c?.absorbed ?? 0,
      mergedSkipped: this.feedback.mergedSkipped,
      fx: this.fx.stats(),
      audio: this.audio.stats(),
    };
  }

  private playImpact(imp: ImpactEvent): void {
    this.feedback.playImpact(imp);
  }

  // ───────────────────────── 内部 ─────────────────────────

  private get phase(): GamePhase {
    return this.store.get().phase;
  }

  private setPhase(phase: GamePhase): void {
    this.store.set({ phase });
  }

  private unlockAudio = (): void => {
    this.audio.unlock();
  };

  private applyPlayerLoadout(loadout: BeyLoadout): void {
    this.specs.player = assembleBey(loadout);
    this.visuals.player?.root.removeFromParent();
    this.visuals.player?.dispose();
    this.visuals.player = undefined;
    this.store.set({ loadout: { ...loadout }, player: hudOf(this.specs.player) });
  }

  private closeGarage(): void {
    this.garage?.dispose();
    this.garage = null;
    this.resetRound();
    this.store.set({ screen: this.garageReturn });
    this.setPhase('title');
    this.cam.setMode('overview', true);
  }

  private applyRivalLoadout(loadout: BeyLoadout): void {
    this.specs.rival = assembleBey(loadout);
    this.visuals.rival?.root.removeFromParent();
    this.visuals.rival?.dispose();
    this.visuals.rival = undefined;
    this.store.set({ rivalLoadout: { ...loadout }, rival: hudOf(this.specs.rival) });
    if (this.phase === 'title' && this.pw) this.resetRound();
  }

  /** 把比赛状态发布到 store（UI 只读） */
  private publishMatch(): void {
    const m = this.match;
    this.store.set({
      match: m
        ? { target: m.target, score: { ...m.score }, round: m.roundNumber, decider: m.decider, rounds: [...this.roundViews], winner: m.winner }
        : null,
    });
  }

  /** 回合结束：计分、生成结算数据，进入 3 秒休整 */
  private onRoundEnd(result: BattleResult): void {
    const battle = this.battle!;
    const m = this.match;
    const outcome = battle.judgeRound.outcome!;
    const number = m ? m.roundNumber : 1;
    if (m && !m.over) m.record(outcome);
    const names = { player: this.store.get().player.name, rival: this.store.get().rival.name };
    const meter = battle.burst?.meter;
    const view: RoundView = {
      number,
      outcome,
      text: describeOutcome(outcome, names),
      stats: {
        contacts: battle.burst?.episodeCount ?? 0,
        maxImpulse: battle.burst?.maxEpisodeImpulse ?? 0,
        dashes: { ...battle.dashStarts },
        peakStress: { player: meter?.stress[0] ?? 0, rival: meter?.stress[1] ?? 0 },
        duration: result.duration,
      },
    };
    this.roundViews.push(view);
    this.restTimer = 0;
    this.publishMatch();
    this.store.set({ result, lastRound: view });
    this.setPhase('roundEnd');
    this.cam.setMode('result');
    if (result.kind === 'win') this.audio.click();
  }

  /** 休整结束：比赛已分胜负 → 比赛结算；否则下一回合（平局重赛同一回合序号不增加） */
  private advanceMatch(): void {
    const m = this.match;
    if (!m || m.over) {
      this.finishMatch();
      return;
    }
    this.resetRound();
    this.setPhase('aim');
    this.cam.setMode('aim');
  }

  private finishMatch(): void {
    this.setPhase('matchEnd');
    this.cam.setMode('result');
    this.audio.stopHum();
    this.audio.stopGrind();
    const m = this.match;
    if (!m || this.resultRecorded) return;
    this.resultRecorded = true;
    const won = m.winner === 'player';
    const d = this.save.data;
    void this.save
      .update({
        wins: d.wins + (won ? 1 : 0),
        losses: d.losses + (won ? 0 : 1),
        points: d.points + (won ? m.score.player : 0),
        lastLoadout: this.specs.player.loadout,
      })
      .then((save) => this.store.set({ save }));
  }

  /** 爆裂表现：Blade 从陀螺上脱离，沿撞击方向带着自转飞出、落地（物理上 Blade 碰撞体已在 BattleSystem 移除） */
  private spawnBurst(side: Side, ev: { x: number; y: number; z: number; dx: number; dz: number }): void {
    const v = this.visuals[side];
    if (!v) return;
    const slot = v.slots.blade;
    this.scene.attach(slot);
    this.flying.push({ side, obj: slot, vx: ev.dx * 3.4, vy: 3.2, vz: ev.dz * 3.4, spin: 18, tumble: 5 + Math.random() * 3, landed: false });
    const reduce = this.store.get().settings.reduceEffects;
    this.feedback.playImpact({ strength: 1, tier: 'heavy', approach: 0, impulse: 0, dvRel: 12, x: ev.x, y: ev.y, z: ev.z, nx: ev.dx, nz: ev.dz, episode: 0, feedback: 'play' });
    if (!reduce) {
      this.slowmo = BURST_SLOWMO.time;
      this.cam.impact(0.9, 0.5);
    }
    navigator.vibrate?.([30, 40, 60]);
  }

  private updateFlying(dt: number): void {
    for (const f of this.flying) {
      if (f.landed) continue;
      f.vy -= 20 * dt;
      const o = f.obj;
      o.position.x += f.vx * dt;
      o.position.y += f.vy * dt;
      o.position.z += f.vz * dt;
      o.rotateY(-f.spin * dt);
      o.rotateX(f.tumble * dt * 0.3);
      const r = Math.hypot(o.position.x, o.position.z);
      const floor = r < 5.4 ? floorHeight(r) : -0.6;
      if (o.position.y < floor + 0.02 && f.vy < 0) {
        o.position.y = floor + 0.02;
        if (Math.abs(f.vy) > 1.2) {
          f.vy = -f.vy * 0.3;
          f.vx *= 0.5;
          f.vz *= 0.5;
          f.spin *= 0.5;
        } else {
          f.landed = true;
        }
      }
    }
  }

  /** 新回合前把飞出的 Blade 装回去 */
  private restoreFlying(): void {
    for (const f of this.flying) {
      const v = this.visuals[f.side];
      if (!v) continue;
      v.root.add(f.obj);
      f.obj.position.set(0, this.specs[f.side].layers.blade.bottom, 0);
      f.obj.quaternion.identity();
    }
    this.flying = [];
  }

  private buildThumbnails(): void {
    try {
      const parts: PartSpec[] = [...listParts('blade'), ...listParts('ratchet'), ...listParts('bit')];
      const thumbs = renderThumbnails(parts, (r) => this.makeEnv(r));
      this.store.set({ garage: { ...this.store.get().garage, thumbs } });
    } catch (err) {
      console.warn('缩略图生成失败', err);
    }
  }

  private makeEnv(renderer: THREE.WebGLRenderer): THREE.Texture {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    const tex = pmrem.fromScene(room, 0.04).texture;
    pmrem.dispose();
    return tex;
  }

  private setupRenderer(): void {
    // 始终开启 MSAA；清晰度由像素比（贴近 Retina 物理像素）+ 动态画质控制
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', stencil: false });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.container.appendChild(this.renderer.domElement);
    const rect = this.container.getBoundingClientRect();
    this.cam = new BattleCamera(Math.max(0.1, rect.width / Math.max(1, rect.height)));
    this.feedback = new BattleFeedback(this.fx, this.audio, this.cam);
    this.quality.onChange = (p) => this.applyQuality(p);
    this.resize();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);
    window.addEventListener('orientationchange', () => setTimeout(this.resize, 250));
  }

  private applyQuality(p: QualityPreset): void {
    this.renderer.setPixelRatio(this.quality.pixelRatio(window.devicePixelRatio || 1));
    this.resize();
    this.renderer.shadowMap.enabled = p.shadows;
    const shadowType = p.softShadows ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
    // 灯光数量、阴影类型、碗面材质变化都要重新编译着色器：只在真正变化时标记
    let relink = this.renderer.shadowMap.type !== shadowType;
    this.renderer.shadowMap.type = shadowType;
    for (const l of this.accentLights) {
      if (l.visible !== p.accentLights) relink = true;
      l.visible = p.accentLights;
    }
    const floor = this.scene.getObjectByName('arena-floor') as THREE.Mesh | undefined;
    const fm = floor && (p.floorClearcoat ? floor.userData.rich : floor.userData.cheap);
    if (floor && fm && floor.material !== fm) floor.material = fm;
    if (relink) this.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material;
      if (m) for (const x of Array.isArray(m) ? m : [m]) x.needsUpdate = true;
    });
    if (this.keyLight && this.keyLight.shadow.mapSize.x !== p.shadowMapSize) {
      this.keyLight.shadow.mapSize.set(p.shadowMapSize, p.shadowMapSize);
      this.keyLight.shadow.map?.dispose();
      this.keyLight.shadow.map = null;
    }
    this.fx.quality.sparkScale = p.sparkScale;
    this.scene.environmentIntensity = p.envIntensity;
    this.store.set({ quality: p.level });
  }

  private resize = (): void => {
    // 用带小数的 CSS 尺寸：clientWidth 会取整，画布缓冲区与实际显示尺寸会差 1~3 个物理像素而被拉伸
    const rect = this.container.getBoundingClientRect();
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);
    const pr = this.quality.pixelRatio(window.devicePixelRatio || 1);
    if (this.renderer.getPixelRatio() !== pr) this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.watchDpr();
    this.cam.setAspect(w / h);
    this.layoutGarage();
  };

  /** 设备像素比变化（缩放、外接屏）时重新按原生分辨率渲染 */
  private watchDpr(): void {
    const dpr = window.devicePixelRatio || 1;
    if (this.dprQuery && this.dprQuery.media === `(resolution: ${dpr}dppx)`) return;
    this.dprQuery?.removeEventListener('change', this.resize);
    this.dprQuery = window.matchMedia?.(`(resolution: ${dpr}dppx)`) ?? null;
    this.dprQuery?.addEventListener('change', this.resize);
  }

  private layoutGarage(): void {
    if (!this.garage) return;
    this.garage.setViewport(this.container.clientWidth, this.container.clientHeight, this.garageFocus);
  }

  private setupScene(): void {
    const s = this.scene;
    s.background = new THREE.Color(0x04060b);
    s.fog = new THREE.Fog(0x04060b, 16, 38);
    this.envTexture = this.makeEnv(this.renderer);
    s.environment = this.envTexture;
    s.environmentIntensity = 1;

    s.add(new THREE.HemisphereLight(0x9fc4ff, 0x1a1020, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 2.6);
    key.position.set(4, 12, 6);
    key.castShadow = true;
    key.shadow.mapSize.set(this.quality.preset.shadowMapSize, this.quality.preset.shadowMapSize);
    const sc = key.shadow.camera;
    sc.left = sc.bottom = -6.5 * ARENA_SCALE;
    sc.right = sc.top = 6.5 * ARENA_SCALE;
    sc.near = 2;
    sc.far = 26;
    key.shadow.bias = -0.0008;
    key.shadow.normalBias = 0.02;
    key.shadow.radius = 3;
    s.add(key);
    this.keyLight = key;
    // 场馆氛围：两侧彩色聚光 + 顶部补光，给金属和透明护墙留出高光
    const spotA = new THREE.SpotLight(0xff4a2a, 120, 22, 0.5, 0.7, 1.6);
    spotA.position.set(-7, 7, -5);
    s.add(spotA, spotA.target);
    const spotB = new THREE.SpotLight(0x2a8aff, 120, 22, 0.5, 0.7, 1.6);
    spotB.position.set(7, 7, -5);
    s.add(spotB, spotB.target);
    const top = new THREE.PointLight(0xfff1dd, 20, 14, 1.5);
    top.position.set(0, 6, 0);
    s.add(top);

    s.add(createArenaVisual());
    s.add(this.fx.root);
    // 撞击闪光点光（impact-light）是战斗反馈的一部分，不放进 accentLights，各画质档都保留（产品决定 2026-11-08）
    this.accentLights = [spotA, spotB, top];
    for (const l of Object.values(this.launchers)) s.add(l.root);

    // 瞄准指示箭头
    const arrowShape = new THREE.Shape();
    arrowShape.moveTo(0, -0.12);
    arrowShape.lineTo(1.2, -0.12);
    arrowShape.lineTo(1.2, -0.3);
    arrowShape.lineTo(1.7, 0);
    arrowShape.lineTo(1.2, 0.3);
    arrowShape.lineTo(1.2, 0.12);
    arrowShape.lineTo(0, 0.12);
    const arrowGeo = new THREE.ShapeGeometry(arrowShape);
    arrowGeo.rotateX(-Math.PI / 2);
    this.aimArrow = new THREE.Mesh(
      arrowGeo,
      new THREE.MeshBasicMaterial({ color: 0x39f0d8, transparent: true, opacity: 0.75, depthWrite: false }),
    );
    s.add(this.aimArrow);
    this.applyQuality(this.quality.preset);
  }

  /** 清空并重建一回合：新的物理世界、陀螺挂回发射器 */
  private resetRound(): void {
    this.restoreFlying();
    this.burstSeen = 0;
    this.slowmo = 0;
    this.battle?.dispose();
    this.pw?.dispose();
    this.fx.clear();
    this.audio.stopHum();
    this.audio.stopGrind();
    this.resultRecorded = false;
    this.previewSpin = 0;
    this.gesture.cancel();

    this.pw = new PhysicsWorld(this.R);
    createArenaPhysics(this.pw);
    this.battle = new BattleSystem(this.pw, this.specs, { ai: { rival: this.store.get().setup.difficulty } });
    const battle = this.battle;
    this.pw.beforeStep = (dt) => battle.preStep(dt);
    this.pw.afterStep = (dt) => battle.postStep(dt);

    for (const side of SIDES) {
      if (!this.visuals[side]) this.visuals[side] = createBeyVisual(this.specs[side]);
      const v = this.visuals[side]!;
      const l = this.launchers[side];
      l.root.visible = true;
      l.setPull(0);
      const p = launchPoint(side);
      l.root.position.set(p.x, p.y + 0.75, p.z);
      v.root.position.set(0, -this.specs[side].totalHeight - 0.05, 0);
      v.root.quaternion.identity();
      (v.blur.material as THREE.MeshBasicMaterial).opacity = 0;
      l.mount.add(v.root);
    }
    this.aimArrow.visible = true;
    this.updateLauncherPose(0);
    this.store.set({
      pull: IDLE_PULL,
      result: null,
      time: 0,
      hits: 0,
      player: hudOf(this.specs.player),
      rival: hudOf(this.specs.rival),
    });
  }

  private updateLauncherPose(aim: number): void {
    for (const side of SIDES) {
      const dir = launchDirection(side, side === 'player' ? aim : 0);
      this.launchers[side].root.rotation.y = Math.atan2(dir.x, dir.z) + Math.PI / 2;
    }
    const p = launchPoint('player');
    const dir = launchDirection('player', aim);
    this.aimArrow.position.set(p.x + dir.x * 0.6, p.y - 0.55, p.z + dir.z * 0.6);
    this.aimArrow.rotation.y = Math.atan2(-dir.z, dir.x);
  }

  private onVisibility = (): void => {
    if (document.hidden) this.pause();
  };

  private frame = (now: number): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
    const elapsed = now - this.last;
    // 帧率上限 60：120Hz 屏幕上隔帧渲染，降低发热。
    // 门槛留 3ms 余量：60Hz 屏幕的帧间隔有抖动，门槛太紧会随机跳帧、被误判为卡顿而自动降画质。
    if (elapsed < 1000 / 60 - 3) return;
    const dt = Math.min(0.05, elapsed / 1000);
    this.last = now;
    this.fpsAcc.frames++;
    this.fpsAcc.time += dt;
    if (this.fpsAcc.time >= 0.5) {
      this.fpsAcc.fps = Math.round(this.fpsAcc.frames / this.fpsAcc.time);
      this.fpsAcc.frames = 0;
      this.fpsAcc.time = 0;
    }
    // 只在对战相关画面测帧率（组装界面生成缩略图时的长帧不算）
    const ph = this.phase;
    if (ph === 'battle' || ph === 'aim' || ph === 'roundEnd') this.quality.sample(elapsed / 1000);
    if (this.phase === 'garage' && this.garage) {
      this.garage.update(dt);
      this.renderer.render(this.garage.scene, this.garage.camera);
      return;
    }
    const t0 = performance.now();
    this.tick(dt);
    const t1 = performance.now();
    this.renderer.render(this.scene, this.cam.camera);
    const t2 = performance.now();
    const pf = this.perf;
    pf.frames++;
    pf.tick += t1 - t0;
    pf.render += t2 - t1;
    pf.maxFrame = Math.max(pf.maxFrame, t2 - t0);
    pf.interval.push(elapsed);
    if (pf.interval.length > 600) pf.interval.shift();
  };

  /**
   * 主循环分段计时（CPU 侧，毫秒累计）：物理 / 同步 / 特效 / 镜头 / UI / 渲染提交。
   * 渲染一栏只是 CPU 提交 WebGL 指令的时间，GPU 实际耗时浏览器拿不到（iOS 也不支持计时查询）。
   */
  private readonly perf = {
    frames: 0, tick: 0, render: 0, physics: 0, physSteps: 0, sync: 0, fx: 0, grind: 0, cam: 0, ui: 0, maxFrame: 0, dtSum: 0,
    interval: [] as number[],
  };

  /** 调试：读取并清零分段计时 */
  debugPerf(reset = true) {
    const p = this.perf;
    const n = Math.max(1, p.frames);
    const iv = [...p.interval].sort((a, b) => a - b);
    const q = (k: number) => (iv.length ? iv[Math.min(iv.length - 1, Math.floor(iv.length * k))] : 0);
    const out = {
      frames: p.frames,
      tickMs: p.tick / n,
      physicsMs: p.physics / n,
      physStepsPerFrame: p.physSteps / n,
      /** 物理时间 / 帧时间：1 = 正常时间流速（P2.2.1 取消慢动作后应始终约为 1） */
      timeRatio: p.dtSum > 0 ? (p.physSteps * PHYSICS_DT) / p.dtSum : 1,
      syncMs: p.sync / n,
      fxMs: p.fx / n,
      grindMs: p.grind / n,
      sparks: this.fx.stats().live,
      camMs: p.cam / n,
      uiMs: p.ui / n,
      renderSubmitMs: p.render / n,
      maxFrameMs: p.maxFrame,
      intervalP50: q(0.5),
      intervalP95: q(0.95),
      intervalP99: q(0.99),
      /** 自动画质估算的刷新基准（次/秒）与相对它的漏帧率 */
      cadenceHz: 1000 / this.quality.cadence.baseMs,
      cadenceMeasured: this.quality.cadence.hasBase,
      missRatio: this.quality.missRatio,
      calls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      geometries: this.renderer.info.memory.geometries,
      textures: this.renderer.info.memory.textures,
      heapMB: ((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0) / 1048576,
    };
    if (reset) {
      p.frames = p.tick = p.render = p.physics = p.physSteps = p.sync = p.fx = p.grind = p.cam = p.ui = p.maxFrame = p.dtSum = 0;
      p.interval.length = 0;
    }
    return out;
  }

  private tick(realDt: number): void {
    const phase = this.phase;
    const battle = this.battle!;
    this.frameDt = realDt;
    const dt = realDt;

    if (phase === 'aim') {
      const pull = this.store.get().pull;
      this.launchers.player.setPull(pull.pull);
      this.updateLauncherPose(pull.aim);
      this.cam.aimBias = pull.aim;
      this.previewSpin += (pull.pull * 40 - this.previewSpin) * Math.min(1, dt * 6);
      this.visuals.player!.root.rotation.y -= this.previewSpin * dt;
      this.visuals.rival!.root.rotation.y -= 2 * dt;
    }

    if (phase === 'battle' || phase === 'roundEnd' || phase === 'matchEnd') {
      const a0 = performance.now();
      // 爆裂慢动作：只放慢表现时间（每帧推进的物理时间变少），物理步长不变
      let simDt = dt;
      if (this.slowmo > 0) {
        this.slowmo -= dt;
        simDt = dt * BURST_SLOWMO.scale;
      }
      this.perf.dtSum += simDt;
      this.perf.physSteps += this.pw!.advance(simDt);
      for (; this.burstSeen < battle.bursts.length; this.burstSeen++) {
        const ev = battle.bursts[this.burstSeen];
        this.spawnBurst(ev.side, ev);
      }
      this.updateFlying(simDt);
      const a1 = performance.now();
      // 撞击反馈 + 持续摩擦层（BattleFeedback：特效、音频、镜头）
      const g0 = performance.now();
      this.feedback.frame(battle, dt);
      this.perf.grind += performance.now() - g0;
      this.syncBeys();
      this.perf.physics += a1 - a0;
      this.perf.sync += performance.now() - a1;
      if (battle.result && phase === 'battle') this.onRoundEnd(battle.result);
      if (phase === 'roundEnd') {
        this.restTimer += dt;
        if (this.restTimer >= ROUND_REST) this.advanceMatch();
      }
      const a = battle.beys.player;
      const b = battle.beys.rival;
      if (a && b && phase === 'battle') this.audio.setHum((a.spinRatio + b.spinRatio) / 2);
    }

    if (phase !== 'paused') {
      // 特效跟随慢动作（火花也变慢），镜头用真实时间，保证操作手感
      const f0 = performance.now();
      this.fx.update(dt, this.cam.camera);
      const f1 = performance.now();
      this.perf.fx += f1 - f0;
      // 复用镜头目标对象（P2.1 每帧新建数组和 4 个 Vector3）
      const targets = this.camTargets;
      targets.length = 0;
      for (const s of SIDES) {
        const b = battle.beys[s];
        if (!b || ((phase === 'roundEnd' || phase === 'matchEnd') && battle.result?.winner && b !== battle.beys[battle.result.winner])) continue;
        const t = this.camTargetPool[targets.length];
        t.position.copy(this.visuals[s]?.root.position ?? (b.body.translation() as THREE.Vector3Like));
        const v = b.body.linvel();
        t.velocity.set(v.x, v.y, v.z);
        targets.push(t);
      }
      this.cam.update(realDt, targets);
      this.perf.cam += performance.now() - f1;
    }

    const u0 = performance.now();
    this.uiTimer += realDt;
    if (this.uiTimer > 1 / 15) {
      this.uiTimer = 0;
      if (phase === 'battle' || phase === 'roundEnd') {
        const meter = battle.burst?.meter;
        const hud = (s: Side): BeyHud => {
          const b = battle.beys[s];
          const base = hudOf(this.specs[s]);
          if (!b) return base;
          const i = s === 'player' ? 0 : 1;
          return {
            ...base,
            spin: b.spinRatio,
            rpm: Math.round((b.spin * 60) / (Math.PI * 2)) * 10,
            dashing: b.dashing,
            stress: meter?.stress[i] ?? 0,
            burst: b.bursted,
          };
        };
        this.store.set({ player: hud('player'), rival: hud('rival'), time: battle.time, hits: battle.hits, fps: this.fpsAcc.fps });
      } else if (this.store.get().fps !== this.fpsAcc.fps) {
        this.store.set({ fps: this.fpsAcc.fps });
      }
    }
    this.perf.ui += performance.now() - u0;
  }

  private frameDt = 1 / 60;
  private readonly camTargets: { position: THREE.Vector3; velocity: THREE.Vector3 }[] = [];
  private readonly camTargetPool = [0, 1].map(() => ({ position: new THREE.Vector3(), velocity: new THREE.Vector3() }));

  private syncBeys(): void {
    const battle = this.battle!;
    for (const side of SIDES) {
      const b = battle.beys[side];
      const v = this.visuals[side];
      if (!b || !v) continue;
      // 在上一个与当前物理步之间插值，慢动作 / 帧间隔抖动时移动依然连续
      b.renderState(this.pw!.alpha, _rp, _ru);
      v.root.position.set(_rp.x, _rp.y, _rp.z);
      // 倾斜姿态完全来自刚体；绕自身轴的转角用“视觉转速”：
      // 物理转速 100+ rad/s 在 60fps 下每帧转 2 弧度以上，三叶刀刃会频闪、糊成一片。
      // 视觉转速封顶在每帧约 0.4 弧度，能看清刀刃细节，同时仍能看出转得快慢。
      _up.set(_ru.x, _ru.y, _ru.z);
      _tilt.setFromUnitVectors(_Y, _up);
      const visualSpin = Math.min(b.spin, 10 + b.spin * 0.12);
      this.visualYaw[side] += b.spinDirection * visualSpin * this.frameDt;
      _yaw.setFromAxisAngle(_Y, this.visualYaw[side]);
      v.root.quaternion.copy(_tilt).multiply(_yaw);
      const mat = v.blur.material as THREE.MeshBasicMaterial;
      mat.opacity = Math.min(0.28, b.spinRatio * 0.32) * (b.spin > 20 ? 1 : b.spin / 20);
    }
  }

}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);
}
