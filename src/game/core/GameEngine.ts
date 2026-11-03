import * as THREE from 'three';
import { createArenaPhysics } from '../arena/ArenaPhysics';
import { createArenaVisual } from '../arena/ArenaVisual';
import { BattleSystem, type BattleResult } from '../battle/BattleSystem';
import { createBeyVisual, type BeyVisual } from '../beys/BeyVisualFactory';
import { assembleBey, type AssembledBey } from '../beys/parts/assemble';
import { PLAYER_LOADOUT, RIVAL_LOADOUT } from '../beys/parts/catalog';
import type { BeyLoadout } from '../beys/parts/types';
import { BattleCamera } from '../camera/BattleCamera';
import { launchDirection, launchPoint, rivalCommand, type Side } from '../launcher/launch';
import { LauncherModel } from '../launcher/LauncherModel';
import { IDLE_PULL, PullStringGesture, type LaunchCommand, type PullState } from '../launcher/PullStringGesture';
import { loadRapier, PhysicsWorld, type Rapier } from '../physics/PhysicsWorld';
import { Sparks } from '../render/Sparks';
import { SaveStore, type SaveData } from '../storage/SaveStore';
import { Store } from './Store';

export type GamePhase = 'loading' | 'title' | 'aim' | 'battle' | 'paused' | 'result' | 'error';

export interface BeyHud {
  name: string;
  code: string;
  spin: number; // 0..1
  rpm: number;
  dashing: boolean;
}

export interface GameSnapshot {
  phase: GamePhase;
  error?: string;
  pull: PullState;
  player: BeyHud;
  rival: BeyHud;
  time: number;
  hits: number;
  result: BattleResult | null;
  save: SaveData;
  fps: number;
}

const emptyHud = (spec: AssembledBey): BeyHud => ({
  name: spec.blade.name,
  code: `${spec.blade.code} ${spec.disc.code} ${spec.tip.code}`,
  spin: 0,
  rpm: 0,
  dashing: false,
});

/**
 * 游戏主引擎：把渲染（Three.js）、物理（Rapier）、对战规则、输入、摄像机串起来。
 * React 只通过 store 读取快照、通过公开方法发出指令，不直接接触 3D 对象。
 */
export class GameEngine {
  readonly store: Store<GameSnapshot>;
  readonly gesture = new PullStringGesture();
  private readonly container: HTMLElement;
  private renderer!: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private cam!: BattleCamera;
  private R!: Rapier;
  private pw: PhysicsWorld | null = null;
  private battle: BattleSystem | null = null;
  private specs: Record<Side, AssembledBey>;
  private visuals: Partial<Record<Side, BeyVisual>> = {};
  private launchers: Record<Side, LauncherModel>;
  private sparks = new Sparks();
  private aimArrow!: THREE.Mesh;
  private raf = 0;
  private last = 0;
  private uiTimer = 0;
  private fpsAcc = { frames: 0, time: 0, fps: 0 };
  private previewSpin = 0;
  private resultRecorded = false;
  private readonly save = new SaveStore();
  private resizeObserver: ResizeObserver | null = null;
  private disposed = false;

  constructor(container: HTMLElement, loadouts: Record<Side, BeyLoadout> = { player: PLAYER_LOADOUT, rival: RIVAL_LOADOUT }) {
    this.container = container;
    this.specs = { player: assembleBey(loadouts.player), rival: assembleBey(loadouts.rival) };
    this.launchers = { player: new LauncherModel(0xe8302a), rival: new LauncherModel(0x1f7cf0) };
    this.store = new Store<GameSnapshot>({
      phase: 'loading',
      pull: IDLE_PULL,
      player: emptyHud(this.specs.player),
      rival: emptyHud(this.specs.rival),
      time: 0,
      hits: 0,
      result: null,
      save: this.save.data,
      fps: 0,
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
      this.resetRound();
      this.setPhase('title');
      this.cam.setMode('overview', true);
      this.last = performance.now();
      this.raf = requestAnimationFrame(this.frame);
      document.addEventListener('visibilitychange', this.onVisibility);
    } catch (err) {
      console.error(err);
      this.store.set({ phase: 'error', error: err instanceof Error ? err.message : String(err) });
    }
  }

  // ───────────────────────── 公开指令（UI 调用） ─────────────────────────

  /** 标题 → 准备发射 */
  start(): void {
    if (this.phase !== 'title') return;
    this.resetRound();
    this.setPhase('aim');
    this.cam.setMode('aim');
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

  /** 直接用指令发射（键盘、测试、以后的 AI 对战回放） */
  launch(cmd: LaunchCommand): void {
    if (this.phase !== 'aim' || !this.battle) return;
    this.battle.launch('player', cmd);
    this.battle.launch('rival', rivalCommand());
    for (const side of ['player', 'rival'] as Side[]) {
      const v = this.visuals[side]!;
      this.scene.attach(v.root);
      this.launchers[side].root.visible = false;
    }
    this.aimArrow.visible = false;
    this.pw!.resetAccumulator();
    this.setPhase('battle');
    this.cam.setMode('battle');
    this.cam.impact(0.4);
  }

  pause(): void {
    if (this.phase === 'battle' || this.phase === 'aim') {
      this.pausedFrom = this.phase;
      this.gesture.cancel();
      this.setPhase('paused');
    }
  }

  resume(): void {
    if (this.phase !== 'paused') return;
    this.setPhase(this.pausedFrom);
    this.pw?.resetAccumulator();
    this.last = performance.now();
  }

  /** 重新开始：回到发射准备 */
  restart(): void {
    this.resetRound();
    this.setPhase('aim');
    this.cam.setMode('aim');
  }

  toTitle(): void {
    this.resetRound();
    this.setPhase('title');
    this.cam.setMode('overview');
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.resizeObserver?.disconnect();
    this.battle?.dispose();
    this.pw?.dispose();
    for (const v of Object.values(this.visuals)) v?.dispose();
    this.renderer?.dispose();
    this.renderer?.domElement.remove();
  }

  /** 调试 / 自动化测试用：不渲染直接推进物理（秒），用于在慢速环境里快速跑完一局 */
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
      return { x: p.x, y: p.y, z: p.z, spin: bey.spin, tilt: bey.tilt };
    };
    return { phase: this.phase, time: b?.time ?? 0, hits: b?.hits ?? 0, player: read('player'), rival: read('rival'), result: b?.result ?? null };
  }

  // ───────────────────────── 内部 ─────────────────────────

  private pausedFrom: GamePhase = 'battle';

  private get phase(): GamePhase {
    return this.store.get().phase;
  }

  private setPhase(phase: GamePhase): void {
    this.store.set({ phase });
  }

  private setupRenderer(): void {
    const isMobile = /iPhone|iPad|Android/i.test(navigator.userAgent);
    this.renderer = new THREE.WebGLRenderer({ antialias: !isMobile || devicePixelRatio < 2, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.1;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.width = '100%';
    this.renderer.domElement.style.height = '100%';
    this.container.appendChild(this.renderer.domElement);
    const rect = this.container.getBoundingClientRect();
    this.cam = new BattleCamera(Math.max(0.1, rect.width / Math.max(1, rect.height)));
    this.resize();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);
  }

  private resize = (): void => {
    const w = Math.max(1, this.container.clientWidth);
    const h = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(w, h, false);
    this.cam.setAspect(w / h);
  };

  private setupScene(): void {
    const s = this.scene;
    s.background = new THREE.Color(0x05070d);
    s.fog = new THREE.Fog(0x05070d, 18, 40);
    s.add(new THREE.HemisphereLight(0x9fc4ff, 0x1a1020, 0.9));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(4, 12, 6);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    const sc = key.shadow.camera;
    sc.left = sc.bottom = -7;
    sc.right = sc.top = 7;
    sc.near = 1;
    sc.far = 30;
    key.shadow.bias = -0.0015;
    s.add(key);
    const rimA = new THREE.PointLight(0xff4a2a, 30, 18);
    rimA.position.set(-6, 4, -5);
    s.add(rimA);
    const rimB = new THREE.PointLight(0x2a8aff, 30, 18);
    rimB.position.set(6, 4, -5);
    s.add(rimB);

    s.add(createArenaVisual());
    s.add(this.sparks.points);
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
  }

  /** 清空并重建一回合：新的物理世界、陀螺挂回发射器 */
  private resetRound(): void {
    this.battle?.dispose();
    this.pw?.dispose();
    this.sparks.clear();
    this.resultRecorded = false;
    this.previewSpin = 0;
    this.gesture.cancel();

    this.pw = new PhysicsWorld(this.R);
    createArenaPhysics(this.pw);
    this.battle = new BattleSystem(this.pw, this.specs);
    const battle = this.battle;
    this.pw.beforeStep = (dt) => battle.preStep(dt);
    this.pw.afterStep = (dt) => battle.postStep(dt);

    for (const side of ['player', 'rival'] as Side[]) {
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
      player: emptyHud(this.specs.player),
      rival: emptyHud(this.specs.rival),
    });
  }

  private updateLauncherPose(aim: number): void {
    for (const side of ['player', 'rival'] as Side[]) {
      const dir = launchDirection(side, side === 'player' ? aim : 0);
      // 发射器长轴垂直于发射方向，拉绳朝外侧
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
    const dt = Math.min(0.05, (now - this.last) / 1000);
    this.last = now;
    this.fpsAcc.frames++;
    this.fpsAcc.time += dt;
    if (this.fpsAcc.time >= 0.5) {
      this.fpsAcc.fps = Math.round(this.fpsAcc.frames / this.fpsAcc.time);
      this.fpsAcc.frames = 0;
      this.fpsAcc.time = 0;
    }
    this.tick(dt);
    this.renderer.render(this.scene, this.cam.camera);
  };

  private tick(dt: number): void {
    const phase = this.phase;
    const battle = this.battle!;

    if (phase === 'aim') {
      const pull = this.store.get().pull;
      this.launchers.player.setPull(pull.pull);
      this.updateLauncherPose(pull.aim);
      this.cam.aimBias = pull.aim;
      // 拉绳时陀螺预转（视觉反馈）
      this.previewSpin += (pull.pull * 40 - this.previewSpin) * Math.min(1, dt * 6);
      const v = this.visuals.player!;
      v.root.rotation.y -= this.previewSpin * dt;
      this.visuals.rival!.root.rotation.y -= 2 * dt;
    }

    if (phase === 'battle' || phase === 'result') {
      this.pw!.advance(dt);
      for (const imp of battle.impacts) {
        this.sparks.burst(imp.x, imp.y, imp.z, imp.strength);
        this.cam.impact(imp.strength);
        navigator.vibrate?.(Math.round(10 + imp.strength * 30));
      }
      battle.impacts.length = 0;
      this.syncBeys();
      if (battle.result && phase === 'battle') this.onResult(battle.result);
    }

    if (phase !== 'paused') {
      this.sparks.update(dt);
      const targets = (['player', 'rival'] as Side[])
        .map((s) => battle.beys[s])
        .filter((b): b is NonNullable<typeof b> => !!b)
        .filter((b) => phase !== 'result' || b === battle.beys[battle.result!.winner])
        .map((b) => {
          const p = b.body.translation();
          const v = b.body.linvel();
          return { position: new THREE.Vector3(p.x, p.y, p.z), velocity: new THREE.Vector3(v.x, v.y, v.z) };
        });
      this.cam.update(dt, targets);
    }

    // UI 快照节流到 ~15Hz
    this.uiTimer += dt;
    if (this.uiTimer > 1 / 15 && (phase === 'battle' || phase === 'result')) {
      this.uiTimer = 0;
      const hud = (s: Side): BeyHud => {
        const b = battle.beys[s];
        const base = emptyHud(this.specs[s]);
        if (!b) return base;
        return { ...base, spin: b.spinRatio, rpm: Math.round((b.spin * 60) / (Math.PI * 2)) * 10, dashing: b.dashing };
      };
      this.store.set({ player: hud('player'), rival: hud('rival'), time: battle.time, hits: battle.hits, fps: this.fpsAcc.fps });
    }
  }

  private syncBeys(): void {
    const battle = this.battle!;
    for (const side of ['player', 'rival'] as Side[]) {
      const b = battle.beys[side];
      const v = this.visuals[side];
      if (!b || !v) continue;
      const p = b.body.translation();
      const q = b.body.rotation();
      v.root.position.set(p.x, p.y, p.z);
      v.root.quaternion.set(q.x, q.y, q.z, q.w);
      const mat = v.blur.material as THREE.MeshBasicMaterial;
      mat.opacity = Math.min(0.75, b.spinRatio * 0.9) * (b.spin > 20 ? 1 : b.spin / 20);
    }
  }

  private onResult(result: BattleResult): void {
    this.setPhase('result');
    this.cam.setMode('result');
    this.store.set({ result });
    if (!this.resultRecorded) {
      this.resultRecorded = true;
      const d = this.save.data;
      const won = result.winner === 'player';
      void this.save
        .update({
          wins: d.wins + (won ? 1 : 0),
          losses: d.losses + (won ? 0 : 1),
          points: d.points + (won ? result.points : 0),
          lastLoadout: this.specs.player.loadout,
        })
        .then((save) => this.store.set({ save }));
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([p, new Promise<T>((r) => setTimeout(() => r(fallback), ms))]);
}
