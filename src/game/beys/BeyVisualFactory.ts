import * as THREE from 'three';
import { createSpinBlurTexture } from '../render/textures';
import type { AssembledBey } from './parts/assemble';
import type { BladeSpec, DiscSpec, PartKind, PartSpec, TipSpec } from './parts/types';

/**
 * 陀螺视觉模型工厂：根据部件的 visual 参数程序化生成真 3D 网格（全部原创造型）。
 *
 * 每个部件都是独立的 Group（底面在本地 y=0），有自己的几何与材质：
 *  - Blade：金属刃 + 彩色涂层 + 透明塑料护盖 + 装甲片 / 铆钉 / 刻线等细节；
 *  - Disc：齿轮锁盘，按锁齿数 / 尖锐度生成；
 *  - Tip：外壳 + 接地部分（齿轮平底 / 球 / 针尖 / 橡胶）。
 * 组装界面和战斗共用这里的构建函数，保证两处模型完全一致。
 */

export interface BeyVisual {
  root: THREE.Group;
  /** 三个部件槽，位置为该部件在组装体中的底部高度 */
  slots: Record<PartKind, THREE.Group>;
  blade: THREE.Group;
  disc: THREE.Group;
  tip: THREE.Group;
  /** 高速旋转时显示的残影盘 */
  blur: THREE.Mesh;
  dispose(): void;
}

// ───────────────────────── 材质库 ─────────────────────────

/** 彩色涂层：清漆层带来锐利高光 */
export function paint(color: number, rough = 0.32): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color,
    roughness: rough,
    metalness: 0.05,
    clearcoat: 1,
    clearcoatRoughness: 0.06,
  });
}

/** 抛光金属：完全金属 + 低粗糙度，依赖环境贴图反射 */
export function metal(color: number, rough = 0.18): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, metalness: 1, roughness: rough, envMapIntensity: 1.25 });
}

/** 透明塑料：半透明 + 清漆，不用 transmission（iPhone 上开销太大） */
export function clearPlastic(tint: number, opacity = 0.32): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color: tint,
    transparent: true,
    opacity,
    roughness: 0.04,
    metalness: 0,
    clearcoat: 1,
    clearcoatRoughness: 0.02,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
}

function satin(color: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.2 });
}

function glow(color: number, intensity = 0.6): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: intensity, roughness: 0.3 });
}

// ───────────────────────── 几何工具 ─────────────────────────

function polarShape(r: (t: number) => number, segments: number, holeRadius = 0): THREE.Shape {
  const shape = new THREE.Shape();
  for (let i = 0; i <= segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    const rr = r(t);
    // 放平后 shape 的 y 对应 -z，取负号让角度方向与世界坐标一致
    const x = Math.cos(t) * rr;
    const y = -Math.sin(t) * rr;
    if (i === 0) shape.moveTo(x, y);
    else shape.lineTo(x, y);
  }
  if (holeRadius > 0) {
    const hole = new THREE.Path();
    hole.absarc(0, 0, holeRadius, 0, Math.PI * 2, true);
    shape.holes.push(hole);
  }
  return shape;
}

/** 把 Shape 挤出成水平厚片，底面在 y=0，带倒角 */
function extrudeFlat(shape: THREE.Shape, depth: number, bevel = 0.02, bevelSegments = 3): THREE.BufferGeometry {
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(0.001, depth - bevel * 2),
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments,
    curveSegments: 12,
  });
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, bevel, 0);
  geo.computeVertexNormals();
  return geo;
}

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

const frac = (t: number, n: number) => (((t * n) / (Math.PI * 2)) % 1 + 1) % 1;

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, y = 0): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.position.y = y;
  return m;
}

/** 环形排布若干个小零件 */
function ring(group: THREE.Group, count: number, r: number, y: number, make: (a: number) => THREE.Object3D, phase = 0) {
  for (let i = 0; i < count; i++) {
    const a = (i / count) * Math.PI * 2 + phase;
    const o = make(a);
    o.position.set(Math.cos(a) * r, y, Math.sin(a) * r);
    group.add(o);
  }
}

function rivet(material: THREE.Material, r = 0.022, h = 0.02): THREE.Mesh {
  return new THREE.Mesh(new THREE.CylinderGeometry(r, r * 1.15, h, 12), material);
}

// ───────────────────────── Blade ─────────────────────────

export function buildBladeModel(spec: BladeSpec): THREE.Group {
  const g = new THREE.Group();
  g.name = `blade:${spec.id}`;
  const v = spec.visual;
  const R = spec.radius;
  const H = spec.height;
  const mMetal = metal(v.metal);
  const mPaint = paint(v.primary);
  const mSecond = paint(v.secondary, 0.45);
  const mAccent = glow(v.accent, 0.45);
  const mClear = clearPlastic(v.primary, 0.28);
  const mDark = satin(0x14161b);
  const N = v.lobes;

  if (v.style === 'fang') {
    // 獠牙：每瓣缓慢升起，在 70% 处达到尖端后急剧回落形成弯钩
    const fang = (t: number) => {
      const u = frac(t, N);
      return R * (0.64 + 0.36 * smooth(0.04, 0.7, u) * (1 - smooth(0.7, 0.8, u)));
    };
    g.add(mesh(extrudeFlat(polarShape(fang, 300, R * 0.3), H * 0.42, 0.012), mMetal));
    g.add(mesh(extrudeFlat(polarShape((t) => fang(t + 0.07) * 0.88, 300, R * 0.3), H * 0.38, 0.02), mPaint, H * 0.38));
    // 透明外壳（略大于涂层，露出下方金属刃口）
    g.add(mesh(extrudeFlat(polarShape((t) => fang(t + 0.04) * 0.93, 200, R * 0.28), H * 0.22, 0.015), mClear, H * 0.72));
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2 + 1.15;
      const plate = new THREE.Mesh(new THREE.BoxGeometry(R * 0.34, H * 0.2, R * 0.13), mSecond);
      plate.position.set(Math.cos(a) * R * 0.6, H * 0.86, Math.sin(a) * R * 0.6);
      plate.rotation.y = -a + 0.5;
      g.add(plate);
      const flame = new THREE.Mesh(new THREE.ConeGeometry(R * 0.055, R * 0.24, 6), mAccent);
      flame.rotation.z = Math.PI / 2;
      flame.rotation.y = -a + Math.PI / 2;
      flame.position.set(Math.cos(a) * R * 0.79, H * 0.83, Math.sin(a) * R * 0.79);
      g.add(flame);
      // 刃尖高光刻线
      const edge = new THREE.Mesh(new THREE.BoxGeometry(R * 0.2, H * 0.06, 0.012), mMetal);
      const ae = (i / N) * Math.PI * 2 + 0.7 * ((Math.PI * 2) / N) * 0.95;
      edge.position.set(Math.cos(ae) * R * 0.9, H * 0.42, -Math.sin(ae) * R * 0.9);
      edge.rotation.y = ae + Math.PI / 2;
      g.add(edge);
    }
    ring(g, N * 2, R * 0.42, H * 0.77, () => rivet(mMetal), 0.4);
  } else if (v.style === 'bastion') {
    const shell = (t: number) => R * (0.9 + 0.1 * Math.sin(frac(t, N) * Math.PI));
    g.add(mesh(extrudeFlat(polarShape(shell, 288, R * 0.3), H * 0.48, 0.022), mPaint));
    const outer = new THREE.Mesh(new THREE.TorusGeometry(R * 0.92, H * 0.2, 16, 120), mMetal);
    outer.rotation.x = Math.PI / 2;
    outer.position.y = H * 0.3;
    g.add(outer);
    ring(g, N, R * 0.92, H * 0.36, () => new THREE.Mesh(new THREE.CylinderGeometry(R * 0.085, R * 0.11, H * 0.62, 20), mMetal));
    g.add(mesh(extrudeFlat(polarShape((t) => R * (0.66 + 0.05 * Math.sin(t * N * 2)), 288, R * 0.3), H * 0.36, 0.02), mSecond, H * 0.46));
    g.add(mesh(extrudeFlat(polarShape((t) => R * (0.7 + 0.04 * Math.sin(t * N)), 200, R * 0.28), H * 0.16, 0.012), mClear, H * 0.8));
    ring(
      g,
      N,
      R * 0.52,
      H * 0.84,
      (a) => {
        const fin = new THREE.Mesh(new THREE.BoxGeometry(R * 0.28, H * 0.16, R * 0.05), mAccent);
        fin.rotation.y = -a;
        return fin;
      },
      Math.PI / N,
    );
  } else if (v.style === 'crescent') {
    // 新月：两片大翼，翼尖加金属配重
    const wing = (t: number) => {
      const u = frac(t, N);
      const body = Math.sin(Math.min(1, u / 0.85) * Math.PI);
      return R * (0.55 + 0.45 * Math.pow(Math.max(0, body), 0.6) * (u < 0.85 ? 1 : 0.6));
    };
    g.add(mesh(extrudeFlat(polarShape(wing, 300, R * 0.3), H * 0.45, 0.015), mPaint));
    g.add(mesh(extrudeFlat(polarShape((t) => wing(t) * 0.78, 300, R * 0.3), H * 0.32, 0.02), mSecond, H * 0.45));
    g.add(mesh(extrudeFlat(polarShape((t) => wing(t + 0.05) * 0.9, 200, R * 0.28), H * 0.2, 0.012), mClear, H * 0.72));
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2 + Math.PI * 0.42 * 2 / N * 2;
      const tipW = new THREE.Mesh(new THREE.SphereGeometry(R * 0.13, 24, 16), mMetal);
      tipW.scale.set(1.3, 0.6, 0.8);
      tipW.position.set(Math.cos(a) * R * 0.86, H * 0.35, -Math.sin(a) * R * 0.86);
      tipW.rotation.y = a;
      g.add(tipW);
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(R * 0.5, H * 0.05, R * 0.04), mAccent);
      stripe.position.set(Math.cos(a) * R * 0.55, H * 0.8, -Math.sin(a) * R * 0.55);
      stripe.rotation.y = a;
      g.add(stripe);
    }
    ring(g, 6, R * 0.38, H * 0.78, () => rivet(mMetal));
  } else {
    // 王冠：四瓣厚重外壳 + 金色金属配重环 + 冠刺
    const lobe = (t: number) => R * (0.84 + 0.16 * Math.pow(Math.abs(Math.sin(frac(t, N) * Math.PI)), 0.5));
    g.add(mesh(extrudeFlat(polarShape(lobe, 288, R * 0.3), H * 0.5, 0.02), mPaint));
    const weight = new THREE.Mesh(new THREE.TorusGeometry(R * 0.88, H * 0.17, 16, 120), mMetal);
    weight.rotation.x = Math.PI / 2;
    weight.position.y = H * 0.22;
    g.add(weight);
    g.add(mesh(extrudeFlat(polarShape((t) => lobe(t) * 0.72, 288, R * 0.3), H * 0.3, 0.02), mSecond, H * 0.48));
    g.add(mesh(extrudeFlat(polarShape((t) => lobe(t) * 0.8, 200, R * 0.28), H * 0.18, 0.012), clearPlastic(0xffe7a0, 0.25), H * 0.76));
    ring(
      g,
      N * 2,
      R * 0.62,
      H * 0.84,
      (a) => {
        const spike = new THREE.Mesh(new THREE.ConeGeometry(R * 0.05, H * 0.5, 6), mMetal);
        spike.position.y = 0;
        spike.rotation.y = -a;
        return spike;
      },
      Math.PI / (N * 2),
    );
    ring(g, N, R * 0.62, H * 0.8, () => new THREE.Mesh(new THREE.OctahedronGeometry(R * 0.06), mAccent));
  }

  // 中央：透明护盖 + 徽记芯片（每个刀刃的徽记形状不同）
  const cap = new THREE.Mesh(new THREE.SphereGeometry(R * 0.3, 40, 20, 0, Math.PI * 2, 0, Math.PI / 2), clearPlastic(0xffffff, 0.3));
  cap.scale.y = 0.5;
  cap.position.y = H;
  g.add(cap);
  g.add(mesh(new THREE.CylinderGeometry(R * 0.23, R * 0.25, H * 0.22, 32), mDark, H * 0.96));
  const emblemSides = { fang: 3, bastion: 6, crescent: 2, crown: 4 }[v.style];
  const emblem =
    emblemSides === 2
      ? new THREE.Mesh(new THREE.TorusGeometry(R * 0.11, R * 0.03, 10, 32, Math.PI * 1.3), mAccent)
      : new THREE.Mesh(new THREE.CylinderGeometry(R * 0.14, R * 0.14, H * 0.12, emblemSides), mAccent);
  if (emblemSides === 2) emblem.rotation.x = -Math.PI / 2;
  emblem.position.y = H * 1.12;
  g.add(emblem);
  const ringTrim = new THREE.Mesh(new THREE.TorusGeometry(R * 0.24, 0.012, 8, 48), mMetal);
  ringTrim.rotation.x = Math.PI / 2;
  ringTrim.position.y = H * 1.07;
  g.add(ringTrim);
  return g;
}

// ───────────────────────── Disc ─────────────────────────

export function buildDiscModel(spec: DiscSpec): THREE.Group {
  const g = new THREE.Group();
  g.name = `disc:${spec.id}`;
  const v = spec.visual;
  const R = spec.radius;
  const N = v.points;
  const sharp = v.sharpness;
  const profile =
    N === 0
      ? (t: number) => R * (0.97 + 0.03 * Math.cos(t * 24))
      : (t: number) => {
          const u = frac(t, N);
          const rise = smooth(0.08, 0.08 + 0.25 * (1 - sharp * 0.6), u);
          const fall = 1 - smooth(0.5, 0.5 + 0.3 * (1 - sharp), u);
          return R * (0.76 + 0.24 * rise * fall);
        };
  g.add(mesh(extrudeFlat(polarShape(profile, 240, R * 0.25), spec.height * 0.62, 0.012), metal(0x9aa3b1, 0.3)));
  g.add(mesh(extrudeFlat(polarShape((t) => profile(t) * 0.94, 240, R * 0.25), spec.height * 0.4, 0.01), paint(v.color, 0.4), spec.height * 0.6));
  const stripe = new THREE.Mesh(new THREE.TorusGeometry(R * 0.58, spec.height * 0.1, 8, 64), glow(v.accent, 0.5));
  stripe.rotation.x = Math.PI / 2;
  stripe.position.y = spec.height * 0.98;
  g.add(stripe);
  // 锁齿（与刀刃咬合的凸块）
  ring(g, Math.max(3, N), R * 0.36, spec.height * 1.0, () => new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.035, 0.07), metal(0xc9ced8)));
  // 刻度
  ring(g, 24, R * 0.86, spec.height * 0.61, (a) => {
    const tick = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.008, 0.006), satin(0x0f1116));
    tick.rotation.y = -a;
    return tick;
  });
  return g;
}

// ───────────────────────── Tip ─────────────────────────

export function buildTipModel(spec: TipSpec): THREE.Group {
  const g = new THREE.Group();
  g.name = `tip:${spec.id}`;
  const v = spec.visual;
  const r = spec.contactRadius;
  const H = spec.height;
  const housing = paint(0x1d2028, 0.4);
  const col = paint(v.color, 0.3);
  // 外壳：倒圆锥 + 色环 + 卡扣
  g.add(mesh(new THREE.CylinderGeometry(0.22, 0.12, H * 0.55, 40), housing, H - H * 0.275));
  g.add(mesh(new THREE.CylinderGeometry(0.226, 0.226, H * 0.12, 40), col, H - H * 0.06 - 0.004));
  ring(g, 3, 0.2, H * 0.86, (a) => {
    const clip = new THREE.Mesh(new THREE.BoxGeometry(0.05, H * 0.18, 0.04), metal(0xc9ced8));
    clip.rotation.y = -a;
    return clip;
  });
  if (v.shape === 'gear-flat') {
    const gear = mesh(
      extrudeFlat(
        polarShape((t) => (Math.sin(t * 12) > 0 ? r * 1.14 : r * 0.92), 192),
        H * 0.3,
        0.006,
        2,
      ),
      metal(v.accent, 0.3),
      r * 0.7,
    );
    g.add(gear);
    g.add(mesh(new THREE.CylinderGeometry(r * 0.86, r, r * 0.7, 40), col, r * 0.35));
  } else if (v.shape === 'ball') {
    g.add(mesh(new THREE.CylinderGeometry(0.1, r * 0.9, H * 0.5, 32), col, r + H * 0.2));
    g.add(mesh(new THREE.SphereGeometry(r, 32, 20), new THREE.MeshPhysicalMaterial({ color: v.accent, roughness: 0.08, clearcoat: 1 }), r));
  } else if (v.shape === 'point') {
    g.add(mesh(new THREE.CylinderGeometry(0.1, 0.05, H * 0.45, 32), col, H * 0.45));
    const needle = mesh(new THREE.ConeGeometry(0.06, H * 0.42, 32), metal(0xe6eaf0, 0.12), H * 0.21);
    needle.rotation.x = Math.PI;
    g.add(needle);
    g.add(mesh(new THREE.SphereGeometry(r, 16, 12), metal(0xe6eaf0, 0.1), r));
  } else {
    // 橡胶平底：哑光宽底 + 防滑纹
    g.add(mesh(new THREE.CylinderGeometry(r * 0.9, r * 1.02, r * 0.85, 40), new THREE.MeshStandardMaterial({ color: v.color, roughness: 0.92 }), r * 0.42));
    ring(g, 10, r * 0.98, r * 0.42, (a) => {
      const groove = new THREE.Mesh(new THREE.BoxGeometry(0.015, r * 0.7, 0.03), satin(0x0b0c0f));
      groove.rotation.y = -a;
      return groove;
    });
    g.add(mesh(new THREE.CylinderGeometry(0.13, r * 0.95, H * 0.3, 32), col, r * 0.85 + H * 0.12));
  }
  return g;
}

export function buildPartModel(part: PartSpec): THREE.Group {
  const g = part.kind === 'blade' ? buildBladeModel(part) : part.kind === 'disc' ? buildDiscModel(part) : buildTipModel(part);
  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  return g;
}

export function disposeObject(root: THREE.Object3D): void {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh || (m as unknown as THREE.Points).isPoints) {
      m.geometry.dispose();
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of mats) {
        (mat as THREE.MeshStandardMaterial).map?.dispose();
        mat.dispose();
      }
    }
  });
}

export function createBeyVisual(spec: AssembledBey): BeyVisual {
  const root = new THREE.Group();
  root.name = `bey:${spec.blade.id}`;
  const slots = {
    tip: new THREE.Group(),
    disc: new THREE.Group(),
    blade: new THREE.Group(),
  } as Record<PartKind, THREE.Group>;
  const tip = buildPartModel(spec.tip);
  const disc = buildPartModel(spec.disc);
  const blade = buildPartModel(spec.blade);
  slots.tip.add(tip);
  slots.disc.add(disc);
  slots.blade.add(blade);
  slots.tip.position.y = spec.layers.tip.bottom;
  slots.disc.position.y = spec.layers.disc.bottom;
  slots.blade.position.y = spec.layers.blade.bottom;
  root.add(slots.tip, slots.disc, slots.blade);

  const blurMat = new THREE.MeshBasicMaterial({
    map: createSpinBlurTexture(spec.blade.visual.primary),
    transparent: true,
    opacity: 0,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  // 只在刀刃外缘显示一圈残影，不覆盖刀刃、徽标等细节（之前整盘覆盖会让高速旋转的陀螺看起来发糊）
  const blur = new THREE.Mesh(new THREE.RingGeometry(spec.blade.radius * 0.8, spec.blade.radius * 1.06, 64, 1), blurMat);
  blur.rotation.x = -Math.PI / 2;
  blur.position.y = spec.layers.blade.top + 0.012;
  blur.renderOrder = 3;
  root.add(blur);

  return {
    root,
    slots,
    blade,
    disc,
    tip,
    blur,
    dispose() {
      disposeObject(root);
    },
  };
}
