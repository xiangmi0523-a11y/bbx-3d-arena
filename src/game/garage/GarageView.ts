import * as THREE from 'three';
import { buildPartModel, disposeObject } from '../beys/BeyVisualFactory';
import type { AssembledBey } from '../beys/parts/assemble';
import type { PartKind, PartSpec } from '../beys/parts/types';

const KINDS: PartKind[] = ['bit', 'ratchet', 'blade'];

/** 分解模式下各部件相对组装位置的偏移 */
const EXPLODE: Record<PartKind, { y: number; tilt: number }> = {
  blade: { y: 0.55, tilt: 0.35 },
  ratchet: { y: 0.22, tilt: 0.2 },
  bit: { y: -0.18, tilt: 0.1 },
};

interface Slot {
  kind: PartKind;
  holder: THREE.Group;
  model: THREE.Group;
  /** 组装状态下的底部高度 */
  baseY: number;
  /** 当前偏移（动画用） */
  offset: number;
  tilt: number;
  /** 正在退场的旧模型 */
  leaving: { model: THREE.Group; t: number; dir: THREE.Vector3 } | null;
  /** 新模型入场进度 0..1（1 = 已到位） */
  enter: number;
}

export interface FocusRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 组装界面的 3D 场景：展示台 + 可交互的完整陀螺。
 * - 手指拖动旋转、双指 / 滚轮缩放，闲置 2.5 秒后缓慢自转；
 * - 换部件时旧部件弹出飞走，新部件从上方落下咔哒装入，其余两个部件保持不变，只按新的高度平滑调整；
 * - 分解模式：三个部件沿轴向分开并略微倾斜，展示真实结构。
 */
export class GarageView {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(36, 1, 0.05, 50);
  private readonly bey = new THREE.Group();
  private readonly spinner = new THREE.Group();
  private slots = {} as Record<PartKind, Slot>;
  private yaw = 0.6;
  private pitch = 0.32;
  private dist = 2.6;
  /** 让模型正好放进 focus 区域的基准距离 */
  private fitDist = 2.6;
  private zoomLevel = 1;
  get zoomFactor(): number {
    return this.zoomLevel;
  }
  private idle = 10;
  private exploded = 0;
  explode = false;
  private focus: FocusRect | null = null;
  private viewW = 1;
  private viewH = 1;
  private pedestalRing!: THREE.Mesh;
  private time = 0;
  /** 部件落位时回调（播放音效） */
  onSnap: (() => void) | null = null;

  constructor(spec: AssembledBey) {
    const s = this.scene;
    s.background = new THREE.Color(0x070a12);
    s.fog = new THREE.Fog(0x070a12, 6, 14);
    s.add(new THREE.HemisphereLight(0xbcd4ff, 0x20141a, 0.7));
    const key = new THREE.DirectionalLight(0xffffff, 2.6);
    key.position.set(2.5, 5, 3);
    key.castShadow = true;
    key.shadow.mapSize.set(1024, 1024);
    key.shadow.camera.left = key.shadow.camera.bottom = -2;
    key.shadow.camera.right = key.shadow.camera.top = 2;
    key.shadow.bias = -0.0008;
    s.add(key);
    const rimL = new THREE.SpotLight(0xff5a3a, 18, 10, 0.5, 0.7);
    rimL.position.set(-3, 2.5, -2);
    s.add(rimL);
    const rimR = new THREE.SpotLight(0x3a9aff, 22, 10, 0.5, 0.7);
    rimR.position.set(3, 2.2, -2.5);
    s.add(rimR);

    // 展示台：六边形底座 + 发光环 + 地面网格
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(0.72, 0.82, 0.14, 6),
      new THREE.MeshPhysicalMaterial({ color: 0x151a26, metalness: 0.6, roughness: 0.35, clearcoat: 1, clearcoatRoughness: 0.1 }),
    );
    base.position.y = -0.07;
    base.receiveShadow = true;
    s.add(base);
    this.pedestalRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.62, 0.01, 8, 96),
      new THREE.MeshBasicMaterial({ color: 0x39f0d8 }),
    );
    this.pedestalRing.rotation.x = Math.PI / 2;
    this.pedestalRing.position.y = 0.005;
    s.add(this.pedestalRing);
    const grid = new THREE.PolarGridHelper(6, 12, 8, 64, 0x1c2638, 0x111827);
    grid.position.y = -0.18;
    s.add(grid);

    this.spinner.add(this.bey);
    s.add(this.spinner);
    for (const kind of KINDS) {
      const holder = new THREE.Group();
      this.bey.add(holder);
      const model = buildPartModel(spec[kind]);
      holder.add(model);
      this.slots[kind] = { kind, holder, model, baseY: spec.layers[kind].bottom, offset: 0, tilt: 0, leaving: null, enter: 1 };
      holder.position.y = this.slots[kind].baseY;
    }
    this.camera.position.set(0, 1, 2.6);
  }

  /** 设置画布尺寸与模型应居中的屏幕区域（CSS 像素） */
  setViewport(w: number, h: number, focus: FocusRect | null): void {
    this.viewW = Math.max(1, w);
    this.viewH = Math.max(1, h);
    this.focus = focus;
    this.camera.aspect = this.viewW / this.viewH;
    // 模型（含展示台约 1.3 单位）占 focus 区域高度 / 宽度的 75%
    const fh = focus ? focus.h : this.viewH;
    const fw = focus ? focus.w : this.viewW;
    const tan = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
    const byH = (1.3 * this.viewH) / (0.75 * fh * 2 * tan);
    const byW = (1.5 * this.viewH) / (0.8 * fw * 2 * tan);
    this.fitDist = THREE.MathUtils.clamp(Math.max(byH, byW), 1.8, 9);
    this.applyViewOffset();
  }

  private applyViewOffset(): void {
    const f = this.focus;
    if (!f) {
      this.camera.clearViewOffset();
    } else {
      // 把视锥窗口反向平移，让画面中心落在 focus 区域中心
      const dx = f.x + f.w / 2 - this.viewW / 2;
      const dy = f.y + f.h / 2 - this.viewH / 2;
      this.camera.setViewOffset(this.viewW, this.viewH, -dx, -dy, this.viewW, this.viewH);
    }
    this.camera.updateProjectionMatrix();
  }

  /** 更换一个部件，其他两个部件保持不动（只按新高度平移） */
  swap(kind: PartKind, part: PartSpec, spec: AssembledBey): void {
    const slot = this.slots[kind];
    if (slot.leaving) {
      slot.holder.remove(slot.leaving.model);
      disposeObject(slot.leaving.model);
    }
    const a = Math.random() * Math.PI * 2;
    slot.leaving = {
      model: slot.model,
      t: 0,
      dir: new THREE.Vector3(Math.cos(a), kind === 'bit' ? -0.6 : 1.2, Math.sin(a)),
    };
    const model = buildPartModel(part);
    slot.holder.add(model);
    slot.model = model;
    slot.enter = 0;
    for (const k of KINDS) this.slots[k].baseY = spec.layers[k].bottom;
    this.idle = 0;
  }

  rotate(dx: number, dy: number): void {
    this.yaw -= dx * 0.009;
    this.pitch = THREE.MathUtils.clamp(this.pitch + dy * 0.006, -0.25, 1.25);
    this.idle = 0;
  }

  zoom(factor: number): void {
    this.zoomLevel = THREE.MathUtils.clamp(this.zoomLevel * factor, 0.6, 2.4);
    this.idle = 0;
  }

  resetView(): void {
    this.yaw = 0.6;
    this.pitch = 0.32;
    this.zoomLevel = 1;
  }

  update(dt: number): void {
    this.time += dt;
    this.idle += dt;
    if (this.idle > 2.5) this.yaw += dt * 0.35;
    const targetDist = (this.fitDist * (1 + this.exploded * 0.35)) / this.zoomLevel;
    this.dist += (targetDist - this.dist) * (1 - Math.exp(-dt * 10));
    this.exploded += ((this.explode ? 1 : 0) - this.exploded) * (1 - Math.exp(-dt * 7));

    const center = new THREE.Vector3(0, 0.25 + this.exploded * 0.18, 0);
    this.camera.position.set(
      center.x + Math.sin(this.yaw) * Math.cos(this.pitch) * this.dist,
      center.y + Math.sin(this.pitch) * this.dist,
      center.z + Math.cos(this.yaw) * Math.cos(this.pitch) * this.dist,
    );
    this.camera.lookAt(center);

    // 展示时陀螺本体缓慢转动，像放在转台上
    this.spinner.rotation.y += dt * 0.25;

    for (const kind of KINDS) {
      const slot = this.slots[kind];
      const ex = EXPLODE[kind];
      slot.offset += (ex.y * this.exploded - slot.offset) * (1 - Math.exp(-dt * 10));
      slot.tilt = ex.tilt * this.exploded;
      // 入场：从上方 0.9 落下，带一点回弹
      let enterY = 0;
      let enterScale = 1;
      if (slot.enter < 1) {
        const prev = slot.enter;
        slot.enter = Math.min(1, slot.enter + dt / 0.42);
        const t = slot.enter;
        const ease = 1 - Math.pow(1 - t, 3);
        const bounce = t > 0.75 ? Math.sin(((t - 0.75) / 0.25) * Math.PI) * 0.04 : 0;
        enterY = (1 - ease) * (kind === 'bit' ? -0.7 : 0.9) + bounce;
        enterScale = 0.7 + 0.3 * ease;
        slot.model.rotation.y = (1 - ease) * 3;
        if (prev < 0.75 && t >= 0.75) this.onSnap?.();
      }
      slot.model.position.y = enterY;
      slot.model.scale.setScalar(enterScale);
      const targetY = slot.baseY + slot.offset;
      slot.holder.position.y += (targetY - slot.holder.position.y) * (1 - Math.exp(-dt * 12));
      slot.holder.rotation.x = slot.tilt * 0.5;
      slot.holder.rotation.z = slot.tilt * 0.3 * Math.sin(this.time * 0.8);
      // 退场：弹出飞走并缩小
      if (slot.leaving) {
        const l = slot.leaving;
        l.t += dt / 0.35;
        const e = l.t * l.t;
        l.model.position.set(l.dir.x * e * 1.6, l.dir.y * e * 1.2, l.dir.z * e * 1.6);
        l.model.rotation.y += dt * 12;
        l.model.scale.setScalar(Math.max(0.01, 1 - l.t));
        if (l.t >= 1) {
          slot.holder.remove(l.model);
          disposeObject(l.model);
          slot.leaving = null;
        }
      }
    }
    const mat = this.pedestalRing.material as THREE.MeshBasicMaterial;
    mat.color.setHSL(0.48, 0.9, 0.45 + 0.1 * Math.sin(this.time * 2));
  }

  dispose(): void {
    disposeObject(this.scene);
  }
}

/**
 * 部件缩略图：用一个独立的小渲染器把真实 3D 部件模型渲染成图片（不是预制图片）。
 * 生成完就释放渲染器，避免长期占用第二个 WebGL 上下文。
 */
export function renderThumbnails(parts: PartSpec[], env: (r: THREE.WebGLRenderer) => THREE.Texture, size = 192): Record<string, string> {
  const out: Record<string, string> = {};
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(size, size, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  const scene = new THREE.Scene();
  const envTex = env(renderer);
  scene.environment = envTex;
  scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x302020, 1));
  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(2, 4, 3);
  scene.add(key);
  const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 20);
  for (const part of parts) {
    const model = buildPartModel(part);
    const box = new THREE.Box3().setFromObject(model);
    const c = box.getCenter(new THREE.Vector3());
    const sz = box.getSize(new THREE.Vector3()).length();
    model.position.sub(c);
    model.rotation.y = 0.5;
    scene.add(model);
    const d = sz * 1.7;
    // 陀尖从侧下方看（接地形状才是重点），其他部件从斜上方看
    if (part.kind === 'bit') camera.position.set(0, -d * 0.18, d);
    else camera.position.set(0, d * 0.62, d * 0.8);
    camera.lookAt(0, 0, 0);
    renderer.render(scene, camera);
    out[`${part.kind}:${part.id}`] = renderer.domElement.toDataURL('image/png');
    scene.remove(model);
    disposeObject(model);
  }
  envTex.dispose();
  renderer.dispose();
  renderer.forceContextLoss();
  return out;
}
