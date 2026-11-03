/**
 * 开发用：陀螺模型检视页（P2.3 阶段 0，不进正式构建）。
 *
 *   npx vite  →  打开 /tools/bey-sheet.html
 *   参数：?set=balance|attack|defense|stamina（默认 balance）
 *         或 ?blade=<id>&disc=<id>&tip=<id> 指定任意组合
 *
 * 一屏 6 个视图：顶视 / 侧视 / 底视（正交）、爆炸图、侧视 + 碰撞体、透视 + 碰撞体。
 * 碰撞体直接读自真实的 Rapier 刚体（tools/inspect/colliders.ts），不是按参数另画一份，
 * 所以叠加图反映的就是游戏里实际参与碰撞的形状。右侧面板列出视觉外径 / 高度与碰撞体的比值。
 */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { buildPartModel, createBeyVisual } from '../src/game/beys/BeyVisualFactory';
import { assembleBey } from '../src/game/beys/parts/assemble';
import { getPart } from '../src/game/beys/parts/catalog';
import type { BeyLoadout, PartKind } from '../src/game/beys/parts/types';
import { loadRapier } from '../src/game/physics/PhysicsWorld';
import { readColliders, type ColliderInfo } from './inspect/colliders';
import { measureVisual } from './inspect/visualBounds';

const SETS: Record<string, BeyLoadout> = {
  balance: { blade: 'gale-crescent', disc: 'hex-lock', tip: 'dome-ball' },
  attack: { blade: 'blaze-fang', disc: 'tri-lock', tip: 'gear-flat' },
  defense: { blade: 'tidal-bastion', disc: 'hex-lock', tip: 'dome-ball' },
  stamina: { blade: 'titan-crown', disc: 'ring-guard', tip: 'needle-point' },
};
const q = new URLSearchParams(location.search);
const base = SETS[q.get('set') ?? 'balance'] ?? SETS.balance;
const loadout: BeyLoadout = { blade: q.get('blade') ?? base.blade, disc: q.get('disc') ?? base.disc, tip: q.get('tip') ?? base.tip };
const spec = assembleBey(loadout);

const COLORS: Record<ColliderInfo['label'], number> = {
  blade: 0xff8a1f,
  disc: 0xffd84a,
  'tip-shaft': 0x3fe0ff,
  'tip-ball': 0xff4fd8,
};
const LABEL_CN: Record<ColliderInfo['label'], string> = {
  blade: 'Blade 圆柱',
  disc: 'Disc 圆柱',
  'tip-shaft': 'Tip 轴杆圆柱',
  'tip-ball': 'Tip 接地球',
};

const INFO_W = 360;
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;
renderer.setScissorTest(true);
document.body.appendChild(renderer.domElement);
const pmrem = new THREE.PMREMGenerator(renderer);
const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

function makeScene(): THREE.Scene {
  const s = new THREE.Scene();
  s.background = new THREE.Color(0x0b111e);
  s.environment = envTex;
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(2, 4, 3);
  const rim = new THREE.DirectionalLight(0x6aa8ff, 1.0);
  rim.position.set(-3, 1, -2);
  const under = new THREE.DirectionalLight(0xffffff, 0.8);
  under.position.set(0, -3, 1);
  s.add(key, rim, under, new THREE.HemisphereLight(0xb8d0ff, 0x1a1d26, 0.6));
  return s;
}

// 场景 A：组装体 + 碰撞体（按视图切换碰撞体可见性）
const sceneA = makeScene();
const visual = createBeyVisual(spec);
visual.blur.visible = false;
sceneA.add(visual.root);
// 地面基准线（y = 0）与转轴
const axis = new THREE.Line(
  new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, -0.15, 0), new THREE.Vector3(0, spec.totalHeight + 0.25, 0)]),
  new THREE.LineDashedMaterial({ color: 0x6b7a99, dashSize: 0.03, gapSize: 0.02, depthTest: false }),
);
axis.computeLineDistances();
axis.renderOrder = 10;
const ground = new THREE.Line(
  new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-0.75, 0, 0), new THREE.Vector3(0.75, 0, 0)]),
  new THREE.LineBasicMaterial({ color: 0x3a4a66 }),
);
sceneA.add(axis, ground);

const colliderGroup = new THREE.Group();
sceneA.add(colliderGroup);

function colliderMesh(c: ColliderInfo): THREE.Object3D {
  const g = new THREE.Group();
  const color = COLORS[c.label];
  const line = new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.95 });
  const fill = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.1, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
  if (c.shape === 'ball') {
    const geo = new THREE.SphereGeometry(c.radius, 24, 12);
    g.add(new THREE.LineSegments(new THREE.WireframeGeometry(geo), line));
    g.add(new THREE.Mesh(geo, fill));
  } else {
    const pts: THREE.Vector3[] = [];
    const n = 64;
    for (const y of [-c.halfHeight, c.halfHeight]) {
      for (let i = 0; i < n; i++) {
        const a0 = (i / n) * Math.PI * 2;
        const a1 = ((i + 1) / n) * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(a0) * c.radius, y, Math.sin(a0) * c.radius), new THREE.Vector3(Math.cos(a1) * c.radius, y, Math.sin(a1) * c.radius));
      }
    }
    for (let i = 0; i < 16; i++) {
      const a = (i / 16) * Math.PI * 2;
      const x = Math.cos(a) * c.radius;
      const z = Math.sin(a) * c.radius;
      pts.push(new THREE.Vector3(x, -c.halfHeight, z), new THREE.Vector3(x, c.halfHeight, z));
    }
    g.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), line));
    g.add(new THREE.Mesh(new THREE.CylinderGeometry(c.radius, c.radius, c.halfHeight * 2, 48, 1, true), fill));
  }
  g.position.y = c.centerY;
  g.traverse((o) => (o.renderOrder = 20));
  return g;
}

// 场景 B：爆炸图（三个零件沿轴向分开）
const sceneB = makeScene();
const exploded = createBeyVisual(spec);
exploded.blur.visible = false;
exploded.slots.tip.position.y = spec.layers.tip.bottom - 0.12;
exploded.slots.disc.position.y = spec.layers.disc.bottom + 0.2;
exploded.slots.blade.position.y = spec.layers.blade.bottom + 0.55;
sceneB.add(exploded.root);

// ── 相机 ──
const S = 0.68; // 正交视图半宽
const ortho = (pos: THREE.Vector3, up: THREE.Vector3, target: THREE.Vector3) => {
  const c = new THREE.OrthographicCamera(-S, S, S, -S, 0.01, 20);
  c.position.copy(pos);
  c.up.copy(up);
  c.lookAt(target);
  return c;
};
const midY = spec.totalHeight / 2;
const camTop = ortho(new THREE.Vector3(0, 5, 0), new THREE.Vector3(0, 0, -1), new THREE.Vector3(0, 0, 0));
const camSide = ortho(new THREE.Vector3(0, midY, 5), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, midY, 0));
const camBottom = ortho(new THREE.Vector3(0, -5, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 0, 0));
const persp = (pos: THREE.Vector3, target: THREE.Vector3) => {
  const c = new THREE.PerspectiveCamera(30, 1, 0.01, 50);
  c.position.copy(pos);
  c.lookAt(target);
  return c;
};
const camExploded = persp(new THREE.Vector3(1.9, 1.7, 2.6), new THREE.Vector3(0, 0.5, 0));
const camOblique = persp(new THREE.Vector3(1.5, 1.4, 2.2), new THREE.Vector3(0, midY, 0));

interface View {
  title: string;
  note: string;
  scene: THREE.Scene;
  camera: THREE.Camera;
  colliders: boolean;
}
const views: View[] = [
  { title: '顶视', note: '正交，俯视（+Y）', scene: sceneA, camera: camTop, colliders: false },
  { title: '侧视', note: '正交，虚线为转轴，横线为 y=0 接地面', scene: sceneA, camera: camSide, colliders: false },
  { title: '底视', note: '正交，仰视（−Y）', scene: sceneA, camera: camBottom, colliders: false },
  { title: '爆炸图', note: 'Tip / Disc / Blade 沿转轴分开', scene: sceneB, camera: camExploded, colliders: false },
  { title: '侧视 + 碰撞体', note: '彩色线框为 Rapier 实际碰撞体', scene: sceneA, camera: camSide, colliders: true },
  { title: '透视 + 碰撞体', note: '与侧视同一份碰撞体数据', scene: sceneA, camera: camOblique, colliders: true },
];

const cells: HTMLDivElement[] = views.map((v) => {
  const d = document.createElement('div');
  d.className = 'cell';
  d.innerHTML = `<b>${v.title}</b><i>${v.note}</i>`;
  document.body.appendChild(d);
  return d;
});

function layout(): { x: number; y: number; w: number; h: number }[] {
  const W = innerWidth - INFO_W;
  const w = W / 3;
  const h = innerHeight / 2;
  return views.map((_, i) => ({ x: (i % 3) * w, y: Math.floor(i / 3) * h, w, h }));
}

function render(): void {
  renderer.setSize(innerWidth, innerHeight);
  const rects = layout();
  views.forEach((v, i) => {
    const r = rects[i];
    const c = cells[i];
    Object.assign(c.style, { left: `${r.x}px`, top: `${r.y}px`, width: `${r.w}px`, height: `${r.h}px` });
    const aspect = r.w / r.h;
    if (v.camera instanceof THREE.OrthographicCamera) {
      v.camera.left = -S * aspect;
      v.camera.right = S * aspect;
      v.camera.updateProjectionMatrix();
    } else if (v.camera instanceof THREE.PerspectiveCamera) {
      v.camera.aspect = aspect;
      v.camera.updateProjectionMatrix();
    }
    colliderGroup.visible = v.colliders;
    axis.visible = v.camera === camSide;
    ground.visible = v.camera === camSide;
    // WebGL 视口原点在左下角
    const y = innerHeight - r.y - r.h;
    renderer.setViewport(r.x, y, r.w, r.h);
    renderer.setScissor(r.x, y, r.w, r.h);
    renderer.render(v.scene, v.camera);
  });
}

// ── 数据面板 ──
function fmt(n: number, d = 3): string {
  return n.toFixed(d);
}
function ratioCell(ratio: number, limit: number): string {
  return `<td class="${ratio <= limit ? 'ok' : 'warn'}">${(ratio * 100).toFixed(1)}%</td>`;
}

async function main(): Promise<void> {
  const R = await loadRapier();
  const cols = readColliders(R, spec);
  for (const c of cols) colliderGroup.add(colliderMesh(c));

  const info = document.createElement('div');
  info.id = 'info';
  info.style.width = `${INFO_W}px`;
  const kinds: PartKind[] = ['blade', 'disc', 'tip'];
  const rows = kinds
    .map((k) => {
      const part = getPart(k, loadout[k]);
      const b = measureVisual(buildPartModel(part));
      if (k === 'tip') {
        return `<tr><td>Tip ${part.id}</td><td>${fmt(b.radial)}</td><td>${fmt(cols[1].radius)}（轴杆）</td><td>—</td><td>${fmt(b.yMax)}</td><td>${fmt(part.height)}</td>${ratioCell(b.yMax / part.height, 1.02)}</tr>`;
      }
      const p = part as { radius: number; height: number; id: string };
      return `<tr><td>${k === 'blade' ? 'Blade' : 'Disc'} ${p.id}</td><td>${fmt(b.radial)}</td><td>${fmt(p.radius)}</td>${ratioCell(b.radial / p.radius, 1.03)}<td>${fmt(b.yMax)}</td><td>${fmt(p.height)}</td>${ratioCell(b.yMax / p.height, k === 'blade' ? 1.25 : (p.height + 0.02) / p.height)}</tr>`;
    })
    .join('');
  const budget = kinds
    .map((k) => {
      const b = measureVisual(buildPartModel(getPart(k, loadout[k])));
      return `<tr><td>${k}</td><td>${b.meshes}</td><td>${b.triangles.toLocaleString()}</td><td>${b.materials}</td><td>${b.transparentMeshes}</td></tr>`;
    })
    .join('');
  const whole = measureVisual(visual.root);
  info.innerHTML = `
    <h1>陀螺模型检视页</h1>
    <div>${loadout.blade} · ${loadout.disc} · ${loadout.tip}</div>
    <div style="color:#8fa3c4">总高 ${fmt(spec.totalHeight)} · 碰撞外径 ${fmt(spec.outerRadius)} · 质量 ${spec.totalMass.toFixed(2)}</div>
    <h2>视觉 vs 碰撞体（游戏单位）</h2>
    <table><tr><th>零件</th><th>视觉外径</th><th>碰撞半径</th><th>比值</th><th>视觉顶</th><th>层厚</th><th>比值</th></tr>${rows}</table>
    <div style="color:#8fa3c4;margin-top:4px">目标：外径 ≤ 103%；Blade 顶 ≤ 125%；Disc 锁齿伸出 ≤ 0.02。<span class="warn">橙色</span> = 超出目标（现有模型，阶段 1、2 重制时修正）。</div>
    <h2>渲染开销（单台）</h2>
    <table><tr><th>零件</th><th>网格</th><th>三角形</th><th>材质</th><th>透明</th></tr>${budget}
    <tr><td><b>合计</b></td><td><b>${whole.meshes}</b></td><td><b>${whole.triangles.toLocaleString()}</b></td><td><b>${whole.materials}</b></td><td><b>${whole.transparentMeshes}</b></td></tr></table>
    <div style="color:#8fa3c4;margin-top:4px">合计含残影环 1 个网格。P2.3 预算：每台 ≤ 20 网格、≤ 2.5 万三角形、≤ 8 材质。</div>
    <h2>碰撞体图例</h2>
    ${cols
      .map(
        (c) =>
          `<div><span class="sw" style="background:#${COLORS[c.label].toString(16).padStart(6, '0')}"></span>${LABEL_CN[c.label]}：r ${fmt(c.radius)}${c.shape === 'cylinder' ? `，高 ${fmt(c.halfHeight * 2)}` : ''}，中心 y ${fmt(c.centerY)}，质量 ${c.mass.toFixed(2)}</div>`,
      )
      .join('')}
  `;
  document.body.appendChild(info);
  render();
  (window as unknown as { __ready: boolean }).__ready = true;
}

addEventListener('resize', render);
void main();
