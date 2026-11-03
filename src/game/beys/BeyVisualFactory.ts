import * as THREE from 'three';
import { createSpinBlurTexture } from '../render/textures';
import type { AssembledBey } from './parts/assemble';
import type { BladeSpec, DiscSpec, TipSpec } from './parts/types';

/**
 * 陀螺视觉模型工厂：根据部件的 visual 参数程序化生成真 3D 网格。
 * 每个部件生成独立的 Group（blade / disc / tip），挂在同一个根节点下，
 * 以后替换部件只需重新生成对应的子 Group；也可以换成美术制作的 glTF 模型。
 *
 * 所有造型均为原创：
 *  - 烈焰獠牙：三片弯钩獠牙刃 + 金属刃口 + 火焰色徽记；
 *  - 潮汐堡垒：六段圆弧护甲 + 厚重金属外环 + 波纹徽记。
 */

export interface BeyVisual {
  root: THREE.Group;
  blade: THREE.Group;
  disc: THREE.Group;
  tip: THREE.Group;
  /** 高速旋转时显示的残影盘 */
  blur: THREE.Mesh;
  dispose(): void;
}

const SEG = 96;

function polarShape(r: (t: number) => number, segments = SEG, holeRadius = 0): THREE.Shape {
  const shape = new THREE.Shape();
  for (let i = 0; i <= segments; i++) {
    const t = (i / segments) * Math.PI * 2;
    const rr = r(t);
    // Shape 的 y 在旋转放平后对应 -z，这里取负号让角度方向与世界坐标一致
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

/** 把 Shape 挤出成水平放置的厚片，底面在 y=0 */
function extrudeFlat(shape: THREE.Shape, depth: number, bevel = 0.02): THREE.BufferGeometry {
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth: Math.max(0.001, depth - bevel * 2),
    bevelEnabled: bevel > 0,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 2,
    curveSegments: 8,
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

function material(color: number, opts: Partial<THREE.MeshStandardMaterialParameters> = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.38, metalness: 0.15, ...opts });
}

function buildBlade(spec: BladeSpec): THREE.Group {
  const g = new THREE.Group();
  g.name = `blade:${spec.id}`;
  const v = spec.visual;
  const R = spec.radius;
  const H = spec.height;
  const metal = material(v.metal, { metalness: 0.95, roughness: 0.22 });
  const primary = material(v.primary, { roughness: 0.32 });
  const secondary = material(v.secondary, { roughness: 0.5 });
  const accent = material(v.accent, { emissive: v.accent, emissiveIntensity: 0.35 });

  if (v.style === 'fang') {
    const N = v.lobes;
    // 獠牙外形：每瓣先缓慢升起，在 70% 处达到尖端，然后急剧回落形成弯钩
    const fang = (t: number) => {
      const u = ((t * N) / (Math.PI * 2)) % 1;
      const rise = smooth(0.05, 0.7, u);
      const drop = 1 - smooth(0.7, 0.82, u);
      return R * (0.66 + 0.34 * rise * drop);
    };
    // 金属主体（下层，最外沿）
    g.add(new THREE.Mesh(extrudeFlat(polarShape(fang, 180, R * 0.32), H * 0.55, 0.015), metal));
    // 彩色上层（略小，错开相位，露出金属刃口）
    const top = new THREE.Mesh(
      extrudeFlat(polarShape((t) => fang(t + 0.08) * 0.86, 180, R * 0.3), H * 0.5, 0.02),
      primary,
    );
    top.position.y = H * 0.5;
    g.add(top);
    // 每个獠牙上的黑色装甲片
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2 + 1.1;
      const plate = new THREE.Mesh(new THREE.BoxGeometry(R * 0.32, H * 0.25, R * 0.12), secondary);
      plate.position.set(Math.cos(a) * R * 0.62, H * 0.95, Math.sin(a) * R * 0.62);
      plate.rotation.y = -a + 0.5;
      g.add(plate);
      const flame = new THREE.Mesh(new THREE.ConeGeometry(R * 0.06, R * 0.22, 4), accent);
      flame.rotation.z = Math.PI / 2;
      flame.rotation.y = -a + Math.PI / 2;
      flame.position.set(Math.cos(a) * R * 0.78, H * 0.92, Math.sin(a) * R * 0.78);
      g.add(flame);
    }
  } else {
    const N = v.lobes;
    // 堡垒外形：六段圆弧护甲，凹槽较浅，接近圆形，利于防御
    const shell = (t: number) => {
      const u = ((t * N) / (Math.PI * 2)) % 1;
      return R * (0.9 + 0.1 * Math.sin(u * Math.PI));
    };
    g.add(new THREE.Mesh(extrudeFlat(polarShape(shell, 192, R * 0.32), H * 0.5, 0.02), primary));
    // 厚重金属外环
    const ring = new THREE.Mesh(new THREE.TorusGeometry(R * 0.93, H * 0.22, 12, 72), metal);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = H * 0.32;
    g.add(ring);
    // 外环上的护甲块
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2;
      const knob = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.09, R * 0.11, H * 0.6, 12), metal);
      knob.position.set(Math.cos(a) * R * 0.92, H * 0.38, Math.sin(a) * R * 0.92);
      g.add(knob);
    }
    // 白色上层波纹
    const wave = new THREE.Mesh(
      extrudeFlat(polarShape((t) => R * (0.66 + 0.06 * Math.sin(t * N * 2)), 192, R * 0.3), H * 0.4, 0.02),
      secondary,
    );
    wave.position.y = H * 0.48;
    g.add(wave);
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2 + Math.PI / N;
      const fin = new THREE.Mesh(new THREE.BoxGeometry(R * 0.28, H * 0.18, R * 0.05), accent);
      fin.position.set(Math.cos(a) * R * 0.52, H * 0.92, Math.sin(a) * R * 0.52);
      fin.rotation.y = -a;
      g.add(fin);
    }
  }

  // 中央透明护盖 + 徽记芯片
  const cap = new THREE.Mesh(
    new THREE.SphereGeometry(R * 0.3, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshPhysicalMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, roughness: 0.05 }),
  );
  cap.scale.y = 0.55;
  cap.position.y = H;
  g.add(cap);
  const chip = new THREE.Mesh(new THREE.CylinderGeometry(R * 0.22, R * 0.24, H * 0.25, 6), accent);
  chip.position.y = H + H * 0.05;
  g.add(chip);
  const mark = new THREE.Mesh(new THREE.ConeGeometry(R * 0.12, H * 0.25, 3), secondary);
  mark.position.y = H + H * 0.25;
  g.add(mark);
  return g;
}

function buildDisc(spec: DiscSpec): THREE.Group {
  const g = new THREE.Group();
  g.name = `disc:${spec.id}`;
  const v = spec.visual;
  const R = spec.radius;
  const N = v.points;
  const body = new THREE.Mesh(
    extrudeFlat(
      polarShape((t) => {
        const u = ((t * N) / (Math.PI * 2)) % 1;
        return R * (0.78 + 0.22 * smooth(0.1, 0.3, u) * (1 - smooth(0.55, 0.75, u)));
      }, 120, R * 0.25),
      spec.height,
      0.012,
    ),
    material(v.color, { metalness: 0.4, roughness: 0.45 }),
  );
  g.add(body);
  const stripe = new THREE.Mesh(
    new THREE.TorusGeometry(R * 0.6, spec.height * 0.12, 6, 48),
    material(v.accent, { emissive: v.accent, emissiveIntensity: 0.4 }),
  );
  stripe.rotation.x = Math.PI / 2;
  stripe.position.y = spec.height * 0.98;
  g.add(stripe);
  return g;
}

function buildTip(spec: TipSpec): THREE.Group {
  const g = new THREE.Group();
  g.name = `tip:${spec.id}`;
  const v = spec.visual;
  const r = spec.contactRadius;
  const H = spec.height;
  const housing = material(0x23272f, { metalness: 0.3 });
  const col = material(v.color, { roughness: 0.3 });
  // 外壳：倒圆锥
  const cone = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.13, H * 0.55, 24), housing);
  cone.position.y = H - H * 0.275;
  g.add(cone);
  const band = new THREE.Mesh(new THREE.CylinderGeometry(0.225, 0.225, H * 0.12, 24), col);
  band.position.y = H - H * 0.06;
  g.add(band);
  if (v.shape === 'gear-flat') {
    // 齿轮平轴：底部平面 + 一圈齿（用于咬合极限轨道）
    const gear = new THREE.Mesh(
      extrudeFlat(
        polarShape((t) => (Math.sin(t * 12) > 0 ? r * 1.12 : r * 0.92), 96),
        H * 0.32,
        0.008,
      ),
      material(v.accent, { metalness: 0.5 }),
    );
    gear.position.y = r * 0.7;
    g.add(gear);
    const flat = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.85, r, r * 0.7, 24), col);
    flat.position.y = r * 0.35;
    g.add(flat);
  } else {
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.1, r * 0.9, H * 0.5, 20), col);
    shaft.position.y = r + H * 0.2;
    g.add(shaft);
    const ball = new THREE.Mesh(new THREE.SphereGeometry(r, 20, 14), material(v.accent, { roughness: 0.15, metalness: 0.2 }));
    ball.position.y = r;
    g.add(ball);
  }
  return g;
}

export function createBeyVisual(spec: AssembledBey): BeyVisual {
  const root = new THREE.Group();
  root.name = `bey:${spec.blade.id}`;
  const tip = buildTip(spec.tip);
  tip.position.y = spec.layers.tip.bottom;
  const disc = buildDisc(spec.disc);
  disc.position.y = spec.layers.disc.bottom;
  const blade = buildBlade(spec.blade);
  blade.position.y = spec.layers.blade.bottom;
  root.add(tip, disc, blade);
  root.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = true;
    }
  });

  const blurMat = new THREE.MeshBasicMaterial({
    map: createSpinBlurTexture(spec.blade.visual.primary),
    transparent: true,
    opacity: 0,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const blur = new THREE.Mesh(new THREE.CircleGeometry(spec.blade.radius * 1.06, 48), blurMat);
  blur.rotation.x = -Math.PI / 2;
  blur.position.y = spec.layers.blade.top + 0.01;
  blur.renderOrder = 3;
  root.add(blur);

  return {
    root,
    blade,
    disc,
    tip,
    blur,
    dispose() {
      root.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.geometry.dispose();
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
          for (const m of mats) {
            (m as THREE.MeshStandardMaterial).map?.dispose();
            m.dispose();
          }
        }
      });
    },
  };
}
