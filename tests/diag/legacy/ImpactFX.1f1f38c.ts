import * as THREE from 'three';
import { impactFeedback } from '../../../src/game/battle/impactTiers';

/**
 * 金属碰撞特效，按撞击等级（轻擦 / 中等 / 猛撞，见 impactTiers）给出明显不同的反馈：
 *  - 闪光：极短的白热十字星 + 点光源脉冲，猛撞时多一层白色内核；
 *  - 火花：多方向喷射的拖尾火花。拖尾是朝向镜头的细长条带（有真实宽度），
 *    不再是 1 像素的 GL 线段——在 3x Retina 屏上 1 像素线只有 1/3 个点宽，几乎看不见；
 *  - 冲击波：贴地扩散，中等 1 层，猛撞 2~3 层（亮环 + 延迟的宽环 + 柔和气浪）。
 * 每次撞击各自占用独立的粒子 / 闪光 / 冲击波槽位，连续撞击不会互相覆盖。
 * 粒子池固定容量，不在运行时分配内存，避免 iPhone 上 GC 卡顿。
 */

function radialTexture(stops: [number, string][], size = 128): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  for (const [o, col] of stops) g.addColorStop(o, col);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const SPARKS = 900;
const FLASHES = 8;
const WAVES = 12;

export interface ImpactQuality {
  /** 火花数量倍率 */
  sparkScale: number;
}

export class ImpactFX {
  readonly root = new THREE.Group();
  quality: ImpactQuality = { sparkScale: 1 };

  // 火花
  private readonly sPos = new Float32Array(SPARKS * 3);
  private readonly sVel = new Float32Array(SPARKS * 3);
  private readonly sLife = new Float32Array(SPARKS);
  private readonly sMax = new Float32Array(SPARKS);
  private readonly sHeat = new Float32Array(SPARKS);
  private readonly sWidth = new Float32Array(SPARKS);
  private readonly sFloor = new Float32Array(SPARKS);
  private readonly sTrail = new Float32Array(SPARKS);
  /** 每个火花 4 个顶点（头左、头右、尾左、尾右） */
  private readonly trailPos = new Float32Array(SPARKS * 12);
  private readonly trailCol = new Float32Array(SPARKS * 12);
  private readonly headPos = new Float32Array(SPARKS * 3);
  private readonly headCol = new Float32Array(SPARKS * 3);
  private readonly trails: THREE.Mesh;
  private readonly camPos = new THREE.Vector3();
  private readonly heads: THREE.Points;
  private nextSpark = 0;

  // 闪光
  private readonly flashes: { sprite: THREE.Sprite; life: number; max: number; size: number }[] = [];
  private readonly light: THREE.PointLight;
  private lightLife = 0;

  // 冲击波
  private readonly waves: { mesh: THREE.Mesh; life: number; max: number; size: number; delay: number; alpha: number }[] = [];
  private readonly softWaves: { mesh: THREE.Mesh; life: number; max: number; size: number; delay: number; alpha: number }[] = [];

  constructor() {
    this.sPos.fill(-999);
    const tGeo = new THREE.BufferGeometry();
    tGeo.setAttribute('position', new THREE.BufferAttribute(this.trailPos, 3).setUsage(THREE.DynamicDrawUsage));
    tGeo.setAttribute('color', new THREE.BufferAttribute(this.trailCol, 3).setUsage(THREE.DynamicDrawUsage));
    const idx = new Uint32Array(SPARKS * 6);
    for (let k = 0; k < SPARKS; k++) {
      const v = k * 4;
      idx.set([v, v + 2, v + 1, v + 1, v + 2, v + 3], k * 6);
    }
    tGeo.setIndex(new THREE.BufferAttribute(idx, 1));
    this.trails = new THREE.Mesh(
      tGeo,
      new THREE.MeshBasicMaterial({
        vertexColors: true,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        // P2.2 性能：透明 + 双面材质默认会被 three.js 拆成“先背面、再正面”两遍绘制，
        // 每遍都改 material.side 并标记 needsUpdate，导致每帧重新计算着色器参数（实测每帧 20 多次）。
        // 单遍绘制：同一颜色的两层半透明叠加结果相同，外观不变。
        forceSinglePass: true,
      }),
    );
    this.trails.frustumCulled = false;
    this.trails.renderOrder = 5;

    const hGeo = new THREE.BufferGeometry();
    hGeo.setAttribute('position', new THREE.BufferAttribute(this.headPos, 3).setUsage(THREE.DynamicDrawUsage));
    hGeo.setAttribute('color', new THREE.BufferAttribute(this.headCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.heads = new THREE.Points(
      hGeo,
      new THREE.PointsMaterial({
        size: 0.07,
        map: radialTexture([
          [0, 'rgba(255,255,255,1)'],
          [0.35, 'rgba(255,230,180,0.9)'],
          [1, 'rgba(255,120,30,0)'],
        ], 64),
        vertexColors: true,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    this.heads.frustumCulled = false;
    this.heads.renderOrder = 5;
    this.root.add(this.trails, this.heads);

    const flashTex = radialTexture([
      [0, 'rgba(255,255,255,1)'],
      [0.12, 'rgba(255,250,235,0.95)'],
      [0.3, 'rgba(255,200,120,0.45)'],
      [0.6, 'rgba(255,120,40,0.12)'],
      [1, 'rgba(255,80,20,0)'],
    ]);
    // 十字星芒：金属反光的“刺眼”感
    const starCanvas = document.createElement('canvas');
    starCanvas.width = starCanvas.height = 128;
    const sctx = starCanvas.getContext('2d')!;
    sctx.drawImage(flashTex.image as HTMLCanvasElement, 0, 0);
    sctx.globalCompositeOperation = 'lighter';
    for (const [w, h] of [
      [128, 6],
      [6, 128],
    ]) {
      const g = sctx.createLinearGradient(64 - w / 2, 64 - h / 2, 64 + w / 2, 64 + h / 2);
      g.addColorStop(0, 'rgba(255,255,255,0)');
      g.addColorStop(0.5, 'rgba(255,255,255,0.9)');
      g.addColorStop(1, 'rgba(255,255,255,0)');
      sctx.fillStyle = g;
      sctx.fillRect(64 - w / 2, 64 - h / 2, w, h);
    }
    const starTex = new THREE.CanvasTexture(starCanvas);
    starTex.colorSpace = THREE.SRGBColorSpace;
    for (let i = 0; i < FLASHES; i++) {
      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: starTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0 }),
      );
      sprite.visible = false;
      sprite.renderOrder = 6;
      this.root.add(sprite);
      this.flashes.push({ sprite, life: 0, max: 1, size: 1 });
    }

    this.light = new THREE.PointLight(0xffd9a0, 0, 4, 2);
    this.root.add(this.light);

    const ringTex = radialTexture([
      [0, 'rgba(255,255,255,0)'],
      [0.62, 'rgba(255,255,255,0)'],
      [0.8, 'rgba(160,230,255,0.85)'],
      [0.9, 'rgba(255,255,255,1)'],
      [1, 'rgba(255,255,255,0)'],
    ], 256);
    const softTex = radialTexture([
      [0, 'rgba(255,255,255,0)'],
      [0.45, 'rgba(200,225,255,0.10)'],
      [0.82, 'rgba(220,240,255,0.45)'],
      [1, 'rgba(255,255,255,0)'],
    ], 256);
    const makeWave = (tex: THREE.Texture) => {
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(2, 2),
        new THREE.MeshBasicMaterial({ map: tex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0 }),
      );
      mesh.rotation.x = -Math.PI / 2;
      mesh.visible = false;
      mesh.renderOrder = 4;
      this.root.add(mesh);
      return { mesh, life: 0, max: 1, size: 1, delay: 0, alpha: 1 };
    };
    for (let i = 0; i < WAVES; i++) this.waves.push(makeWave(ringTex));
    for (let i = 0; i < 4; i++) this.softWaves.push(makeWave(softTex));
  }

  /**
   * 触发一次撞击特效。
   * @param normal 撞击方向（水平），火花主要沿切向和法向两侧喷射
   * @param floorY 接触点下方的地面高度（冲击波贴地）
   */
  impact(x: number, y: number, z: number, strength: number, normal: { x: number; z: number }, floorY: number): void {
    const fb = impactFeedback(strength);
    const heavy = fb.tier === 'heavy';

    // 闪光：取一个空闲槽位（都在用时取剩余寿命最短的），不打断正在播放的闪光
    const pickFlash = () => this.flashes.reduce((a, b) => (b.life < a.life ? b : a));
    const f = pickFlash();
    f.sprite.position.set(x, y, z);
    f.max = f.life = fb.tier === 'light' ? 0.05 : 0.07 + 0.05 * fb.local + (heavy ? 0.03 : 0);
    f.size = fb.flash;
    f.sprite.visible = true;
    if (heavy) {
      // 猛撞：额外一层更小、更白的内核，强调“金属咬合”的瞬间
      const core = pickFlash();
      core.sprite.position.set(x, y, z);
      core.max = core.life = 0.05;
      core.size = fb.flash * 0.45;
      core.sprite.visible = true;
    }
    // 点光源：多次撞击取更亮的一次，不会被弱撞击压暗
    if (fb.light >= this.light.intensity * 0.6) {
      this.light.position.set(x, y + 0.15, z);
      this.light.intensity = Math.max(this.light.intensity, fb.light);
      this.lightLife = heavy ? 0.16 : 0.1;
    }

    // 火花：两束沿切向（刀刃擦过的方向）+ 一部分向四周
    const n = Math.max(3, Math.round(fb.sparks * this.quality.sparkScale));
    const tx = -normal.z;
    const tz = normal.x;
    const width = fb.tier === 'light' ? 0.012 : heavy ? 0.024 : 0.018;
    for (let i = 0; i < n; i++) {
      const k = this.nextSpark;
      this.nextSpark = (this.nextSpark + 1) % SPARKS;
      const r = Math.random();
      let dx: number;
      let dz: number;
      if (r < 0.65) {
        const side = Math.random() < 0.5 ? 1 : -1;
        const spread = (Math.random() - 0.5) * 1.1;
        dx = tx * side + normal.x * spread;
        dz = tz * side + normal.z * spread;
      } else {
        const a = Math.random() * Math.PI * 2;
        dx = Math.cos(a);
        dz = Math.sin(a);
      }
      const len = Math.hypot(dx, dz) || 1;
      const sp = (3 + Math.random() * 7) * fb.sparkSpeed;
      this.sVel[k * 3] = (dx / len) * sp;
      this.sVel[k * 3 + 1] = 0.5 + Math.random() * (1.2 + 3.5 * fb.sparkSpeed);
      this.sVel[k * 3 + 2] = (dz / len) * sp;
      this.sPos[k * 3] = x + (Math.random() - 0.5) * 0.05;
      this.sPos[k * 3 + 1] = y + (Math.random() - 0.5) * 0.05;
      this.sPos[k * 3 + 2] = z + (Math.random() - 0.5) * 0.05;
      this.sMax[k] = this.sLife[k] = (0.16 + Math.random() * 0.4) * fb.sparkLife;
      this.sHeat[k] = 0.7 + Math.random() * 0.3;
      this.sWidth[k] = width * (0.6 + Math.random() * 0.6);
      this.sFloor[k] = floorY;
      this.sTrail[k] = (heavy ? 0.045 : 0.03) * (0.7 + Math.random() * 0.6);
    }

    // 冲击波：中等 1 层；猛撞 2~3 层（亮环 + 延迟的宽环 + 柔和气浪）
    const pickWave = (pool: typeof this.waves) => pool.reduce((a, b) => (b.life + b.delay < a.life + a.delay ? b : a));
    const spawn = (pool: typeof this.waves, size: number, life: number, delay: number, alpha: number) => {
      const w = pickWave(pool);
      w.mesh.position.set(x, floorY + 0.02 + delay * 0.02, z);
      w.max = w.life = life;
      w.size = size;
      w.delay = delay;
      w.alpha = alpha;
      w.mesh.visible = false;
    };
    if (fb.waves >= 1) spawn(this.waves, heavy ? 1.6 + 0.8 * fb.local : 0.9 + 0.5 * fb.local, heavy ? 0.42 : 0.32, 0, heavy ? 1 : 0.7);
    if (fb.waves >= 2) spawn(this.waves, 2.6 + 1.0 * fb.local, 0.6, 0.06, 0.6);
    if (fb.waves >= 3) spawn(this.softWaves, 3.2 + 0.8 * fb.local, 0.7, 0.02, 0.8);
  }

  /** 每帧更新；camera 用于让火花拖尾条带始终朝向镜头 */
  update(dt: number, camera?: THREE.Camera): void {
    if (camera) this.camPos.setFromMatrixPosition(camera.matrixWorld);
    // 火花
    const cp = this.camPos;
    for (let k = 0; k < SPARKS; k++) {
      const i3 = k * 3;
      const i12 = k * 12;
      if (this.sLife[k] <= 0) {
        if (this.trailPos[i12 + 1] !== -999) {
          for (let v = 0; v < 4; v++) this.trailPos[i12 + v * 3 + 1] = -999;
          this.headPos[i3 + 1] = -999;
        }
        continue;
      }
      this.sLife[k] -= dt;
      this.sVel[i3 + 1] -= 16 * dt;
      // 空气阻力
      const drag = Math.exp(-dt * 2.2);
      this.sVel[i3] *= drag;
      this.sVel[i3 + 2] *= drag;
      this.sPos[i3] += this.sVel[i3] * dt;
      this.sPos[i3 + 1] += this.sVel[i3 + 1] * dt;
      this.sPos[i3 + 2] += this.sVel[i3 + 2] * dt;
      // 落在撞击点下方的地面上弹一下
      if (this.sPos[i3 + 1] < this.sFloor[k]) {
        this.sPos[i3 + 1] = this.sFloor[k];
        this.sVel[i3 + 1] *= -0.3;
      }
      const t = Math.max(0, this.sLife[k] / this.sMax[k]); // 1 → 0
      const heat = this.sHeat[k] * t;
      // 白 → 黄 → 橙 → 暗红
      const r = Math.min(1, 0.35 + heat * 1.2);
      const g = Math.min(1, heat * heat * 1.3 + 0.05);
      const b = Math.min(1, heat * heat * heat * 1.1);
      const px = this.sPos[i3];
      const py = this.sPos[i3 + 1];
      const pz = this.sPos[i3 + 2];
      const trail = this.sTrail[k] * (0.4 + 0.6 * t);
      const qx = px - this.sVel[i3] * trail;
      const qy = py - this.sVel[i3 + 1] * trail;
      const qz = pz - this.sVel[i3 + 2] * trail;
      // 条带宽度方向 = 速度方向 × 视线方向
      const ax = px - qx;
      const ay = py - qy;
      const az = pz - qz;
      const vx = cp.x - px;
      const vy = cp.y - py;
      const vz = cp.z - pz;
      let wx = ay * vz - az * vy;
      let wy = az * vx - ax * vz;
      let wz = ax * vy - ay * vx;
      const wl = Math.hypot(wx, wy, wz) || 1;
      const hw = this.sWidth[k] * (0.5 + 0.5 * t);
      wx = (wx / wl) * hw;
      wy = (wy / wl) * hw;
      wz = (wz / wl) * hw;
      const P = this.trailPos;
      P[i12] = px + wx;
      P[i12 + 1] = py + wy;
      P[i12 + 2] = pz + wz;
      P[i12 + 3] = px - wx;
      P[i12 + 4] = py - wy;
      P[i12 + 5] = pz - wz;
      // 尾部收窄成尖
      P[i12 + 6] = qx + wx * 0.15;
      P[i12 + 7] = qy + wy * 0.15;
      P[i12 + 8] = qz + wz * 0.15;
      P[i12 + 9] = qx - wx * 0.15;
      P[i12 + 10] = qy - wy * 0.15;
      P[i12 + 11] = qz - wz * 0.15;
      const C = this.trailCol;
      C[i12] = C[i12 + 3] = r;
      C[i12 + 1] = C[i12 + 4] = g;
      C[i12 + 2] = C[i12 + 5] = b;
      C[i12 + 6] = C[i12 + 9] = r * 0.12;
      C[i12 + 7] = C[i12 + 10] = g * 0.06;
      C[i12 + 8] = C[i12 + 11] = 0;
      this.headPos[i3] = px;
      this.headPos[i3 + 1] = py;
      this.headPos[i3 + 2] = pz;
      this.headCol[i3] = r;
      this.headCol[i3 + 1] = g;
      this.headCol[i3 + 2] = b;
    }
    this.trails.geometry.attributes.position.needsUpdate = true;
    this.trails.geometry.attributes.color.needsUpdate = true;
    this.heads.geometry.attributes.position.needsUpdate = true;
    this.heads.geometry.attributes.color.needsUpdate = true;

    // 闪光
    for (const f of this.flashes) {
      if (f.life <= 0) continue;
      f.life -= dt;
      const t = Math.max(0, f.life / f.max);
      const mat = f.sprite.material as THREE.SpriteMaterial;
      mat.opacity = t;
      const sc = f.size * (0.6 + 0.6 * (1 - t));
      f.sprite.scale.set(sc, sc, 1);
      mat.rotation += dt * 3;
      if (f.life <= 0) f.sprite.visible = false;
    }
    if (this.lightLife > 0) {
      this.lightLife -= dt;
      this.light.intensity *= Math.exp(-dt * 30);
      if (this.lightLife <= 0) this.light.intensity = 0;
    }

    // 冲击波（两组分别遍历，不再每帧拼接新数组）
    this.updateWaves(this.waves, dt);
    this.updateWaves(this.softWaves, dt);
  }

  private updateWaves(list: typeof this.waves, dt: number): void {
    for (const w of list) {
      if (w.life <= 0) continue;
      if (w.delay > 0) {
        w.delay -= dt;
        continue;
      }
      w.mesh.visible = true;
      w.life -= dt;
      const t = 1 - Math.max(0, w.life / w.max); // 0 → 1
      const ease = 1 - (1 - t) * (1 - t) * (1 - t);
      const sc = 0.15 + w.size * ease;
      w.mesh.scale.set(sc, sc, sc);
      (w.mesh.material as THREE.MeshBasicMaterial).opacity = (1 - t) * (1 - t) * 0.9 * w.alpha;
      if (w.life <= 0) w.mesh.visible = false;
    }
  }

  /**
   * 预热：把所有闪光 / 冲击波临时设为可见并编译一次着色器，
   * 避免第一次猛撞时才初始化这些材质（真机上会表现为第一下撞击卡一帧）。
   */
  prewarm(renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.Camera): void {
    for (const f of this.flashes) f.sprite.visible = true;
    for (const w of this.waves) w.mesh.visible = true;
    for (const w of this.softWaves) w.mesh.visible = true;
    renderer.compile(scene, camera);
    for (const f of this.flashes) f.sprite.visible = false;
    for (const w of this.waves) w.mesh.visible = false;
    for (const w of this.softWaves) w.mesh.visible = false;
  }

  clear(): void {
    this.sLife.fill(0);
    for (const f of this.flashes) {
      f.life = 0;
      f.sprite.visible = false;
    }
    for (const w of [...this.waves, ...this.softWaves]) {
      w.life = 0;
      w.delay = 0;
      w.mesh.visible = false;
    }
    this.light.intensity = 0;
    this.update(0);
  }
}
