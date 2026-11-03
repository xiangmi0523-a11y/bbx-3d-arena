import * as THREE from 'three';

/**
 * 金属碰撞特效（全部按撞击力度 0..1 缩放）：
 *  - 闪光：极短的白热高光精灵 + 点光源脉冲，照亮周围金属；
 *  - 火花：多方向喷射的拖尾火花（线段尾迹 + 亮点头部），受重力下坠、颜色由白→橙→暗红逐渐消散；
 *  - 冲击波：贴地扩散的光环，外扩时变薄变淡。
 * 闪光很小且只持续约 0.1 秒、火花从接触点向外喷，不会长时间遮挡陀螺本体。
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

const SPARKS = 420;
const FLASHES = 4;
const WAVES = 5;

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
  private readonly trailPos = new Float32Array(SPARKS * 6);
  private readonly trailCol = new Float32Array(SPARKS * 6);
  private readonly headPos = new Float32Array(SPARKS * 3);
  private readonly headCol = new Float32Array(SPARKS * 3);
  private readonly trails: THREE.LineSegments;
  private readonly heads: THREE.Points;
  private nextSpark = 0;

  // 闪光
  private readonly flashes: { sprite: THREE.Sprite; life: number; max: number; size: number }[] = [];
  private readonly light: THREE.PointLight;
  private lightLife = 0;

  // 冲击波
  private readonly waves: { mesh: THREE.Mesh; life: number; max: number; size: number }[] = [];

  constructor() {
    this.sPos.fill(-999);
    const tGeo = new THREE.BufferGeometry();
    tGeo.setAttribute('position', new THREE.BufferAttribute(this.trailPos, 3).setUsage(THREE.DynamicDrawUsage));
    tGeo.setAttribute('color', new THREE.BufferAttribute(this.trailCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.trails = new THREE.LineSegments(
      tGeo,
      new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    this.trails.frustumCulled = false;
    this.trails.renderOrder = 5;

    const hGeo = new THREE.BufferGeometry();
    hGeo.setAttribute('position', new THREE.BufferAttribute(this.headPos, 3).setUsage(THREE.DynamicDrawUsage));
    hGeo.setAttribute('color', new THREE.BufferAttribute(this.headCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.heads = new THREE.Points(
      hGeo,
      new THREE.PointsMaterial({
        size: 0.06,
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
    for (let i = 0; i < WAVES; i++) {
      const mesh = new THREE.Mesh(
        new THREE.PlaneGeometry(2, 2),
        new THREE.MeshBasicMaterial({ map: ringTex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0 }),
      );
      mesh.rotation.x = -Math.PI / 2;
      mesh.visible = false;
      mesh.renderOrder = 4;
      this.root.add(mesh);
      this.waves.push({ mesh, life: 0, max: 1, size: 1 });
    }
  }

  /**
   * 触发一次撞击特效。
   * @param normal 撞击方向（水平），火花主要沿切向和法向两侧喷射
   * @param floorY 接触点下方的地面高度（冲击波贴地）
   */
  impact(x: number, y: number, z: number, strength: number, normal: { x: number; z: number }, floorY: number): void {
    const s = Math.max(0.05, Math.min(1, strength));

    // 闪光
    const f = this.flashes.find((fl) => fl.life <= 0) ?? this.flashes[0];
    f.sprite.position.set(x, y, z);
    f.max = f.life = 0.06 + 0.07 * s;
    f.size = 0.35 + 0.75 * s;
    f.sprite.visible = true;
    this.light.position.set(x, y + 0.15, z);
    this.light.intensity = 12 + 50 * s;
    this.lightLife = 0.12;

    // 火花：两束沿切向（刀刃擦过的方向）+ 少量向四周
    const n = Math.round((14 + 70 * s) * this.quality.sparkScale);
    const tx = -normal.z;
    const tz = normal.x;
    for (let i = 0; i < n; i++) {
      const k = this.nextSpark;
      this.nextSpark = (this.nextSpark + 1) % SPARKS;
      const r = Math.random();
      let dx: number;
      let dz: number;
      if (r < 0.7) {
        // 切向两束，带一点法向散开
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
      const sp = (3 + Math.random() * 7) * (0.55 + s * 0.9);
      this.sVel[k * 3] = (dx / len) * sp;
      this.sVel[k * 3 + 1] = 0.6 + Math.random() * (1.5 + 4 * s);
      this.sVel[k * 3 + 2] = (dz / len) * sp;
      this.sPos[k * 3] = x + (Math.random() - 0.5) * 0.05;
      this.sPos[k * 3 + 1] = y + (Math.random() - 0.5) * 0.05;
      this.sPos[k * 3 + 2] = z + (Math.random() - 0.5) * 0.05;
      this.sMax[k] = this.sLife[k] = 0.18 + Math.random() * (0.25 + 0.35 * s);
      this.sHeat[k] = 0.7 + Math.random() * 0.3;
    }

    // 冲击波（中等以上力度才有，力度越大越大越亮）
    if (s > 0.15) {
      const w = this.waves.find((wv) => wv.life <= 0) ?? this.waves[0];
      w.mesh.position.set(x, floorY + 0.02, z);
      w.max = w.life = 0.32 + 0.25 * s;
      w.size = 0.7 + 1.9 * s;
      w.mesh.visible = true;
    }
  }

  update(dt: number): void {
    // 火花
    for (let k = 0; k < SPARKS; k++) {
      const i3 = k * 3;
      const i6 = k * 6;
      if (this.sLife[k] <= 0) {
        this.trailPos[i6 + 1] = this.trailPos[i6 + 4] = -999;
        this.headPos[i3 + 1] = -999;
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
      // 落地弹一下
      if (this.sPos[i3 + 1] < -1.15) {
        this.sPos[i3 + 1] = -1.15;
        this.sVel[i3 + 1] *= -0.3;
      }
      const t = Math.max(0, this.sLife[k] / this.sMax[k]); // 1 → 0
      const heat = this.sHeat[k] * t;
      // 白 → 黄 → 橙 → 暗红
      const r = Math.min(1, 0.35 + heat * 1.2);
      const g = Math.min(1, heat * heat * 1.3 + 0.05);
      const b = Math.min(1, heat * heat * heat * 1.1);
      const trail = 0.018 + 0.02 * t;
      this.trailPos[i6] = this.sPos[i3];
      this.trailPos[i6 + 1] = this.sPos[i3 + 1];
      this.trailPos[i6 + 2] = this.sPos[i3 + 2];
      this.trailPos[i6 + 3] = this.sPos[i3] - this.sVel[i3] * trail;
      this.trailPos[i6 + 4] = this.sPos[i3 + 1] - this.sVel[i3 + 1] * trail;
      this.trailPos[i6 + 5] = this.sPos[i3 + 2] - this.sVel[i3 + 2] * trail;
      this.trailCol[i6] = r;
      this.trailCol[i6 + 1] = g;
      this.trailCol[i6 + 2] = b;
      this.trailCol[i6 + 3] = r * 0.15;
      this.trailCol[i6 + 4] = g * 0.1;
      this.trailCol[i6 + 5] = 0;
      this.headPos[i3] = this.sPos[i3];
      this.headPos[i3 + 1] = this.sPos[i3 + 1];
      this.headPos[i3 + 2] = this.sPos[i3 + 2];
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

    // 冲击波
    for (const w of this.waves) {
      if (w.life <= 0) continue;
      w.life -= dt;
      const t = 1 - Math.max(0, w.life / w.max); // 0 → 1
      const ease = 1 - (1 - t) * (1 - t) * (1 - t);
      const sc = 0.15 + w.size * ease;
      w.mesh.scale.set(sc, sc, sc);
      (w.mesh.material as THREE.MeshBasicMaterial).opacity = (1 - t) * (1 - t) * 0.9;
      if (w.life <= 0) w.mesh.visible = false;
    }
  }

  clear(): void {
    this.sLife.fill(0);
    for (const f of this.flashes) {
      f.life = 0;
      f.sprite.visible = false;
    }
    for (const w of this.waves) {
      w.life = 0;
      w.mesh.visible = false;
    }
    this.light.intensity = 0;
    this.update(0);
  }
}
