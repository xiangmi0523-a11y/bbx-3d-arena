/**
 * 开发用：基线 / 新版本对局回放对比页（自主运动可视化验收，不进正式构建）。
 *
 *   1. 录制：tests/diag/replay.diag.ts（两个版本各跑一遍，同一组固定种子）→ test-results/replays/*.json
 *      ?pair=new,v2 选择左右两个槽位的版本（默认 base,new；录像文件 <场景>.<版本>.json）
 *   2. npx vite → 打开 /tools/replay.html?s=AvD_1
 *
 * 回放只读录下来的逐帧物理状态（位置、自转轴、转速），不在浏览器里重新模拟，所以两边看到的就是
 * 无头统计用的那一局。陀螺模型、场地模型、灯光与游戏一致（GameEngine.setupScene 同参数），
 * 视觉自转角按游戏同一公式（min(spin, 10 + 0.12·spin)）由录下的转速积分得到。
 *
 * 画面：上半两路 3D 并排（左基线 / 右新版本，同一时间点）；下半两路俯视轨迹 + 时间轴
 *（双方中心距、接触段、运动状态条、撞击 / 撞墙标记）。
 * 键盘：空格 播放 / 暂停，← → 逐帧，[ ] 上 / 下一次接触，V 切换 并排 ↔ 单屏，单屏时 Tab 在基线 / 新版本间切换（时间不变）。
 * ?record=1：隐藏控制条，暴露 window.renderAt(t) 供 Playwright 逐帧截图。
 */
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { createArenaVisual } from '../src/game/arena/ArenaVisual';
import { ARENA, ARENA_SCALE, floorHeight } from '../src/game/arena/arenaSpec';
import { createBeyVisual, type BeyVisual } from '../src/game/beys/BeyVisualFactory';
import { assembleBey } from '../src/game/beys/parts/assemble';
import { getPart } from '../src/game/beys/parts/catalog';
import type { Replay } from '../tests/motion/recorder';
import { STATES } from '../tests/motion/recorder';

/** 左 / 右两个画面槽位 */
type Ver = 'base' | 'new';
const VERS: Ver[] = ['base', 'new'];
/** 每个槽位放哪个版本的录像：?pair=new,v2 = 左第一轮、右第二轮（默认 base,new） */
const FILE_LABEL: Record<string, string> = { base: '基线 0dac2ad', new: '第一轮 b3d0b1d', v2: '第二轮 v2' };
const FILE_SHORT: Record<string, string> = { base: '基线', new: '第一轮', v2: '第二轮' };
const PAIR = (new URLSearchParams(location.search).get('pair') ?? 'base,new').split(',');
const SLOT_FILE: Record<Ver, string> = { base: PAIR[0] ?? 'base', new: PAIR[1] ?? 'new' };
const VER_LABEL: Record<Ver, string> = { base: FILE_LABEL[SLOT_FILE.base] ?? SLOT_FILE.base, new: FILE_LABEL[SLOT_FILE.new] ?? SLOT_FILE.new };
const VER_SHORT: Record<Ver, string> = { base: FILE_SHORT[SLOT_FILE.base] ?? SLOT_FILE.base, new: FILE_SHORT[SLOT_FILE.new] ?? SLOT_FILE.new };
const STATE_CN: Record<string, string> = {
  cut: '斜切',
  orbit: '绕行',
  contact: '接触',
  disengage: '脱离',
  guard: '守中',
  roam: '游走',
  evade: '闪避',
  breakout: '脱困',
  charge: '冲撞',
  backoff: '后退',
  recoil: '回弹',
  launch: '发射',
};
const STATE_COLOR: Record<string, string> = {
  cut: '#ff9a3c',
  orbit: '#ffd84a',
  contact: '#ff4d6a',
  disengage: '#8f7bff',
  guard: '#4ab0ff',
  roam: '#5fd39a',
  evade: '#c06bff',
  breakout: '#ffffff',
  charge: '#ff6b3c',
  backoff: '#6f86ad',
  recoil: '#b04dff',
  launch: '#999',
};
const TIER_COLOR: Record<string, string> = { light: '#cfd8e6', medium: '#ffd84a', heavy: '#ff4d4d' };
const BEY_COLOR = ['#3fe0ff', '#ff6bd8'];

const W = 1600;
const H = 900;
const HEAD = 40;
const VIEW_H = 520;
const BOT = H - HEAD - VIEW_H; // 340

const q = new URLSearchParams(location.search);
const RECORD = q.get('record') === '1';
/** 录制时可关掉 MSAA / 阴影换速度（无 GPU 的软件渲染下每帧 1 秒以上） */
const AA = q.get('aa') !== '0';
const SHADOW = q.get('shadow') !== '0';

interface Track {
  rep: Replay;
  yaw: Float32Array[];
}

// ---------- 数据 ----------
declare global {
  interface Window {
    __REPLAYS?: Record<string, Record<string, Replay>>;
    __REPLAY_INDEX?: string[];
    renderAt?: (t: number) => void;
    replayReady?: Promise<{ duration: number }>;
  }
}

async function loadIndex(): Promise<string[]> {
  if (window.__REPLAY_INDEX) return window.__REPLAY_INDEX;
  const r = await fetch('/test-results/replays/index.json');
  return r.json();
}
async function loadPair(key: string): Promise<Record<Ver, Replay>> {
  const pre = window.__REPLAYS?.[key];
  if (pre) return { base: pre[SLOT_FILE.base], new: pre[SLOT_FILE.new] };
  const [b, n] = await Promise.all(VERS.map((v) => fetch(`/test-results/replays/${key}.${SLOT_FILE[v]}.json`).then((r) => r.json())));
  return { base: b, new: n };
}

function makeTrack(rep: Replay): Track {
  const n = rep.frames.length;
  const yaw = [new Float32Array(n), new Float32Array(n)];
  for (let s = 0; s < 2; s++) {
    let a = 0;
    for (let i = 0; i < n; i++) {
      const spin = rep.frames[i][3 + s * 13 + 6];
      a += rep.spinSign[s] * Math.min(spin, 10 + spin * 0.12) * rep.dt;
      yaw[s][i] = a;
    }
  }
  return { rep, yaw };
}

const fi = (rep: Replay, t: number) => Math.max(0, Math.min(rep.frames.length - 1, Math.round(t / rep.dt) - 1));
const bey = (f: number[], s: number) => {
  const o = 3 + s * 13;
  return { x: f[o], y: f[o + 1], z: f[o + 2], ux: f[o + 3], uy: f[o + 4], uz: f[o + 5], spin: f[o + 6], ratio: f[o + 7], vx: f[o + 8], vz: f[o + 9], prec: f[o + 10], state: STATES[f[o + 11]] ?? '?', dash: (f[o + 12] & 1) > 0, wall: (f[o + 12] & 2) > 0 };
};

// ---------- 3D ----------
const renderer = new THREE.WebGLRenderer({ antialias: AA, preserveDrawingBuffer: RECORD });
renderer.setPixelRatio(q.get('rs') ? Number(q.get('rs')) : RECORD ? 1 : Math.min(2, devicePixelRatio));
renderer.setSize(W, H);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.shadowMap.enabled = SHADOW;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.setScissorTest(true);
const pmrem = new THREE.PMREMGenerator(renderer);
const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

interface Panel {
  scene: THREE.Scene;
  cam: THREE.PerspectiveCamera;
  vis: BeyVisual[];
  trails: THREE.Line[];
  link: THREE.Line;
  rings: THREE.Mesh[];
  track: Track | null;
}

function makeScene(): THREE.Scene {
  // 与 GameEngine.setupScene 相同的灯光 / 雾 / 环境参数
  const s = new THREE.Scene();
  s.background = new THREE.Color(0x04060b);
  s.fog = new THREE.Fog(0x04060b, 16, 38);
  s.environment = envTex;
  s.add(new THREE.HemisphereLight(0x9fc4ff, 0x1a1020, 0.55));
  const key = new THREE.DirectionalLight(0xffffff, 2.6);
  key.position.set(4, 12, 6);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  const sc = key.shadow.camera;
  sc.left = sc.bottom = -6.5 * ARENA_SCALE;
  sc.right = sc.top = 6.5 * ARENA_SCALE;
  sc.near = 2;
  sc.far = 26;
  key.shadow.bias = -0.0008;
  key.shadow.normalBias = 0.02;
  key.shadow.radius = 3;
  s.add(key);
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
  return s;
}

const TRAIL_N = 180; // 3 秒（60 Hz）
function makePanel(): Panel {
  const scene = makeScene();
  const cam = new THREE.PerspectiveCamera(40, 800 / VIEW_H, 0.1, 80);
  const trails = [0, 1].map((s) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL_N * 3), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(TRAIL_N * 3), 3));
    const l = new THREE.Line(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.95, depthTest: false }));
    l.renderOrder = 5;
    l.frustumCulled = false;
    void s;
    scene.add(l);
    return l;
  });
  const lg = new THREE.BufferGeometry();
  lg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(6), 3));
  const link = new THREE.Line(lg, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.5, depthTest: false }));
  link.renderOrder = 6;
  link.frustumCulled = false;
  scene.add(link);
  const rings = Array.from({ length: 4 }, () => {
    const m = new THREE.Mesh(new THREE.RingGeometry(0.9, 1, 48), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthTest: false, side: THREE.DoubleSide }));
    m.rotation.x = -Math.PI / 2;
    m.renderOrder = 7;
    m.visible = false;
    scene.add(m);
    return m;
  });
  return { scene, cam, vis: [], trails, link, rings, track: null };
}

const panels: Record<Ver, Panel> = { base: makePanel(), new: makePanel() };

function setTrack(p: Panel, tr: Track) {
  for (const v of p.vis) {
    p.scene.remove(v.root);
    v.dispose();
  }
  const sc = tr.rep.scenario;
  p.vis = [sc.player, sc.rival].map((l) => {
    const v = createBeyVisual(assembleBey(l));
    v.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).castShadow = true;
    });
    p.scene.add(v.root);
    return v;
  });
  p.track = tr;
}

const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _Y = new THREE.Vector3(0, 1, 0);
const _u = new THREE.Vector3();
const cA = [new THREE.Color(BEY_COLOR[0]), new THREE.Color(BEY_COLOR[1])];

function camTarget(rep: Replay, i: number) {
  // ±0.5 s 窗口内双方中点与间距的平均：镜头平滑、且对同一时间点结果唯一（可逐帧录制 / 任意拖动）
  let mx = 0;
  let mz = 0;
  let sep = 0;
  let n = 0;
  for (let k = Math.max(0, i - 30); k <= Math.min(rep.frames.length - 1, i + 30); k += 3) {
    const f = rep.frames[k];
    const a = bey(f, 0);
    const b = bey(f, 1);
    mx += (a.x + b.x) / 2;
    mz += (a.z + b.z) / 2;
    sep += Math.hypot(a.x - b.x, a.z - b.z);
    n++;
  }
  return { x: (mx / n) * 0.6, z: (mz / n) * 0.6, sep: sep / n };
}

function updatePanel(p: Panel, t: number) {
  const tr = p.track!;
  const rep = tr.rep;
  const i = fi(rep, t);
  const f = rep.frames[i];
  for (let s = 0; s < 2; s++) {
    const b = bey(f, s);
    const v = p.vis[s];
    v.root.position.set(b.x, b.y, b.z);
    _u.set(b.ux, b.uy, b.uz).normalize();
    _q1.setFromUnitVectors(_Y, _u);
    _q2.setFromAxisAngle(_Y, tr.yaw[s][i]);
    v.root.quaternion.copy(_q1).multiply(_q2);
    (v.blur.material as THREE.MeshBasicMaterial).opacity = Math.min(0.28, b.ratio * 0.32) * (b.spin > 20 ? 1 : b.spin / 20);
    // 轨迹：最近 3 秒，越新越亮
    const pos = p.trails[s].geometry.getAttribute('position') as THREE.BufferAttribute;
    const col = p.trails[s].geometry.getAttribute('color') as THREE.BufferAttribute;
    for (let k = 0; k < TRAIL_N; k++) {
      const j = Math.max(0, i - (TRAIL_N - 1 - k));
      const g = bey(rep.frames[j], s);
      pos.setXYZ(k, g.x, floorHeight(Math.hypot(g.x, g.z)) + 0.03, g.z);
      const a = k / (TRAIL_N - 1);
      col.setXYZ(k, cA[s].r * a, cA[s].g * a, cA[s].b * a);
    }
    pos.needsUpdate = true;
    col.needsUpdate = true;
  }
  const a = bey(f, 0);
  const b = bey(f, 1);
  const lp = p.link.geometry.getAttribute('position') as THREE.BufferAttribute;
  lp.setXYZ(0, a.x, a.y + 0.25, a.z);
  lp.setXYZ(1, b.x, b.y + 0.25, b.z);
  lp.needsUpdate = true;
  const lm = p.link.material as THREE.LineBasicMaterial;
  lm.color.set(f[2] ? 0xff3355 : 0xffffff);
  lm.opacity = f[2] ? 1 : 0.35;
  // 撞击：0.35 秒扩散环
  const tNow = f[0];
  const recent = rep.impacts.filter((e) => e.t <= tNow && e.t > tNow - 0.35).slice(-p.rings.length);
  p.rings.forEach((r, k) => {
    const e = recent[k];
    r.visible = !!e;
    if (!e) return;
    const age = (tNow - e.t) / 0.35;
    const sz = 0.3 + age * (0.6 + e.strength);
    r.scale.setScalar(sz);
    r.position.set(e.x, floorHeight(Math.hypot(e.x, e.z)) + 0.05, e.z);
    const m = r.material as THREE.MeshBasicMaterial;
    m.color.set(TIER_COLOR[e.tier] ?? '#fff');
    m.opacity = 1 - age;
  });
  const c = camTarget(rep, i);
  const dist = Math.max(6.5, Math.min(10.5, 5.2 + c.sep * 1.1));
  const el = (54 * Math.PI) / 180;
  p.cam.position.set(c.x, floorHeight(0) + dist * Math.sin(el), c.z + dist * Math.cos(el));
  p.cam.lookAt(c.x, 0, c.z);
}

// ---------- 2D 叠加层 ----------
const overlay = document.createElement('canvas');
overlay.width = W;
overlay.height = H;
const ctx = overlay.getContext('2d')!;
const wrap = document.createElement('div');
wrap.id = 'stage';
wrap.style.cssText = `position:relative;width:${W}px;height:${H}px`;
renderer.domElement.style.cssText = `position:absolute;left:0;top:0;width:${W}px;height:${H}px`;
overlay.style.cssText = 'position:absolute;left:0;top:0';
wrap.append(renderer.domElement, overlay);
document.body.appendChild(wrap);

let mode: 'split' | 'single' = (q.get('view') as 'split' | 'single') ?? 'split';
if (mode !== 'single') mode = 'split';
let single: Ver = (q.get('ver') as Ver) === 'base' ? 'base' : 'new';
let duration = 0;
let pairKey = '';

const loadoutName = (l: Replay['scenario']['player']) => `${getPart('blade', l.blade).name}·${getPart('disc', l.disc).name}·${getPart('tip', l.tip).name}`;

function chip(x: number, y: number, text: string, bg: string, fg = '#081018') {
  ctx.font = '600 13px -apple-system, "PingFang SC", "Noto Sans SC", sans-serif';
  const w = ctx.measureText(text).width + 12;
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.roundRect(x, y, w, 20, 4);
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.fillText(text, x + 6, y + 14.5);
  return w;
}

function drawViewHud(v: Ver, x0: number, w: number, t: number) {
  const rep = panels[v].track!.rep;
  const i = fi(rep, t);
  const f = rep.frames[i];
  const ended = t > rep.duration + 1e-6;
  ctx.fillStyle = 'rgba(4,6,11,0.72)';
  ctx.fillRect(x0, HEAD, w, 30);
  ctx.font = '700 15px -apple-system, "PingFang SC", "Noto Sans SC", sans-serif';
  ctx.fillStyle = v === 'base' ? '#9fc4ff' : '#ffb04a';
  ctx.fillText(VER_LABEL[v], x0 + 12, HEAD + 20);
  ctx.font = '13px -apple-system, "PingFang SC", "Noto Sans SC", sans-serif';
  ctx.fillStyle = '#d8e2f2';
  const dGap = f[1] - rep.contactR;
  ctx.fillText(`中心距 ${f[1].toFixed(2)} m   刀刃间隙 ${dGap > 0 ? dGap.toFixed(2) : '0.00'} m`, x0 + 150, HEAD + 20);
  let cx = x0 + 420;
  cx += chip(cx, HEAD + 5, f[2] ? '接触中' : '未接触', f[2] ? '#ff3355' : '#2a3448', f[2] ? '#fff' : '#9fb0c8') + 6;
  if (ended) chip(cx, HEAD + 5, `已结束 ${rep.result}`, '#ffffff');
  for (let s = 0; s < 2; s++) {
    const b = bey(f, s);
    const y = HEAD + VIEW_H - 54 + s * 26;
    ctx.fillStyle = 'rgba(4,6,11,0.72)';
    ctx.fillRect(x0 + 8, y - 2, 380, 24);
    ctx.fillStyle = BEY_COLOR[s];
    ctx.beginPath();
    ctx.arc(x0 + 20, y + 10, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#d8e2f2';
    ctx.font = '13px -apple-system, "PingFang SC", "Noto Sans SC", sans-serif';
    ctx.fillText(s === 0 ? '玩家' : '对手', x0 + 32, y + 15);
    let xx = x0 + 70;
    xx += chip(xx, y, STATE_CN[b.state] ?? b.state, STATE_COLOR[b.state] ?? '#888') + 6;
    if (b.dash) xx += chip(xx, y, '轨道冲刺', '#ff9a3c') + 6;
    if (b.wall) xx += chip(xx, y, '贴墙', '#ffffff') + 6;
    // 转速条
    ctx.fillStyle = '#1b2538';
    ctx.fillRect(x0 + 250, y + 5, 90, 10);
    ctx.fillStyle = BEY_COLOR[s];
    ctx.fillRect(x0 + 250, y + 5, 90 * b.ratio, 10);
    ctx.fillStyle = '#d8e2f2';
    ctx.fillText(`${Math.round(b.ratio * 100)}%`, x0 + 346, y + 15);
    void xx;
  }
}

function drawTopDown(v: Ver, x0: number, y0: number, size: number, t: number) {
  const rep = panels[v].track!.rep;
  const i = fi(rep, t);
  const R = ARENA.radius + 0.4;
  const k = (size / 2 - 8) / R;
  const cx = x0 + size / 2;
  const cy = y0 + size / 2;
  const P = (x: number, z: number) => [cx + x * k, cy + z * k] as const;
  ctx.fillStyle = '#070b14';
  ctx.fillRect(x0, y0, size, size);
  ctx.strokeStyle = '#2a3c5c';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, ARENA.radius * k, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = '#3a2a1c';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, ARENA.railInner * k, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = '#18233a';
  ctx.beginPath();
  ctx.arc(cx, cy, ARENA.edgeStart * k, 0, Math.PI * 2);
  ctx.stroke();
  // 全程轨迹（淡）+ 最近 3 秒（亮）
  for (let s = 0; s < 2; s++) {
    ctx.strokeStyle = BEY_COLOR[s] + '30';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let j = 0; j <= i; j += 2) {
      const b = bey(rep.frames[j], s);
      const [px, py] = P(b.x, b.z);
      if (j === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
    ctx.strokeStyle = BEY_COLOR[s];
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let j = Math.max(0, i - TRAIL_N); j <= i; j++) {
      const b = bey(rep.frames[j], s);
      const [px, py] = P(b.x, b.z);
      if (j === Math.max(0, i - TRAIL_N)) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.stroke();
  }
  // 撞击点 / 撞墙点（已发生的）
  for (const e of rep.impacts) {
    if (e.t > t) break;
    const [px, py] = P(e.x, e.z);
    ctx.fillStyle = TIER_COLOR[e.tier];
    ctx.beginPath();
    ctx.arc(px, py, e.tier === 'light' ? 2 : 3.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  for (const w of rep.walls) {
    if (w.t > t) break;
    const j = fi(rep, w.t);
    const b = bey(rep.frames[j], w.side);
    const [px, py] = P(b.x, b.z);
    ctx.beginPath();
    ctx.moveTo(px - 4, py - 4);
    ctx.lineTo(px + 4, py + 4);
    ctx.moveTo(px + 4, py - 4);
    ctx.lineTo(px - 4, py + 4);
    ctx.stroke();
  }
  // 当前位置：刀刃半径圆 + 速度箭头（0.25 s 位移）
  const f = rep.frames[i];
  const a = bey(f, 0);
  const b = bey(f, 1);
  {
    const [ax, ay] = P(a.x, a.z);
    const [bx, by] = P(b.x, b.z);
    ctx.strokeStyle = f[2] ? '#ff3355' : '#ffffff40';
    ctx.lineWidth = f[2] ? 3 : 1;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
  }
  for (let s = 0; s < 2; s++) {
    const g = s ? b : a;
    const [px, py] = P(g.x, g.z);
    ctx.fillStyle = BEY_COLOR[s];
    ctx.beginPath();
    ctx.arc(px, py, rep.bladeR[s] * k, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(px + g.vx * 0.25 * k, py + g.vz * 0.25 * k);
    ctx.stroke();
  }
  ctx.font = '600 12px -apple-system, "PingFang SC", "Noto Sans SC", sans-serif';
  ctx.fillStyle = v === 'base' ? '#9fc4ff' : '#ffb04a';
  ctx.fillText(`俯视 · ${VER_SHORT[v]}`, x0 + 8, y0 + 16);
  ctx.fillStyle = '#8fa3c4';
  ctx.font = '11px -apple-system, "PingFang SC", "Noto Sans SC", sans-serif';
  ctx.fillText('白箭头 = 0.25 s 位移  ✕ = 撞墙', x0 + 8, y0 + size - 8);
}

function drawTimeline(x0: number, y0: number, w: number, h: number, t: number) {
  ctx.fillStyle = '#0a1020';
  ctx.fillRect(x0, y0, w, h);
  const L = x0 + 64;
  const Rr = x0 + w - 12;
  const T = Math.max(1, duration);
  const X = (tt: number) => L + ((Rr - L) * tt) / T;
  const reps = VERS.map((v) => panels[v].track!.rep);
  // 距离曲线
  const gy0 = y0 + 14;
  const gh = 120;
  const dMax = 6;
  const Y = (d: number) => gy0 + gh - (gh * Math.min(d, dMax)) / dMax;
  ctx.strokeStyle = '#1b2538';
  ctx.lineWidth = 1;
  ctx.font = '11px -apple-system, "PingFang SC", "Noto Sans SC", sans-serif';
  ctx.fillStyle = '#8fa3c4';
  for (let d = 0; d <= dMax; d += 2) {
    ctx.beginPath();
    ctx.moveTo(L, Y(d));
    ctx.lineTo(Rr, Y(d));
    ctx.stroke();
    ctx.fillText(`${d} m`, x0 + 30, Y(d) + 4);
  }
  ctx.fillText('中心距', x0 + 6, gy0 + 4);
  for (let tt = 0; tt <= T; tt += 5) {
    ctx.fillText(`${tt}s`, X(tt) - 6, y0 + h - 6);
  }
  ctx.setLineDash([4, 4]);
  ctx.strokeStyle = '#ff335580';
  ctx.beginPath();
  ctx.moveTo(L, Y(reps[0].contactR));
  ctx.lineTo(Rr, Y(reps[0].contactR));
  ctx.stroke();
  ctx.setLineDash([]);
  reps.forEach((rep, k) => {
    ctx.strokeStyle = k === 0 ? '#9fc4ff' : '#ffb04a';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    rep.frames.forEach((f, j) => {
      if (j % 2) return;
      if (j === 0) ctx.moveTo(X(f[0]), Y(f[1]));
      else ctx.lineTo(X(f[0]), Y(f[1]));
    });
    ctx.stroke();
  });
  // 条带：每版 接触 / 玩家状态 / 对手状态 / 撞击
  let yy = gy0 + gh + 10;
  const strip = (label: string, color: string) => {
    ctx.fillStyle = color;
    ctx.font = '11px -apple-system, "PingFang SC", "Noto Sans SC", sans-serif';
    ctx.fillText(label, x0 + 6, yy + 9);
  };
  reps.forEach((rep, k) => {
    const vc = k === 0 ? '#9fc4ff' : '#ffb04a';
    const tag = VER_SHORT[VERS[k]];
    // 接触
    strip(`${tag} 接触`, vc);
    for (const c of rep.contacts) {
      ctx.fillStyle = '#ff3355';
      ctx.fillRect(X(c.t0), yy, Math.max(1.5, X(c.t1) - X(c.t0)), 10);
    }
    for (const e of rep.impacts) {
      if (e.tier === 'light') continue;
      ctx.fillStyle = TIER_COLOR[e.tier];
      ctx.fillRect(X(e.t) - 1, yy - 2, 2, 14);
    }
    yy += 13;
    for (let s = 0; s < 2; s++) {
      strip(`${tag} ${s ? '对手' : '玩家'}`, BEY_COLOR[s]);
      let last = -1;
      let start = 0;
      const flush = (end: number) => {
        if (last < 0) return;
        ctx.fillStyle = STATE_COLOR[STATES[last]] ?? '#888';
        ctx.fillRect(X(start), yy, Math.max(1, X(end) - X(start)), 10);
      };
      for (const f of rep.frames) {
        const st = f[3 + s * 13 + 11];
        if (st !== last) {
          flush(f[0]);
          last = st;
          start = f[0];
        }
      }
      flush(rep.duration);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      for (const wv of rep.walls) {
        if (wv.side !== s) continue;
        const px = X(wv.t);
        ctx.beginPath();
        ctx.moveTo(px - 3, yy - 1);
        ctx.lineTo(px + 3, yy + 11);
        ctx.moveTo(px + 3, yy - 1);
        ctx.lineTo(px - 3, yy + 11);
        ctx.stroke();
      }
      yy += 13;
    }
    if (rep.duration < T) {
      ctx.fillStyle = 'rgba(10,16,32,0.8)';
      ctx.fillRect(X(rep.duration), yy - 39, Rr - X(rep.duration), 38);
      ctx.fillStyle = vc;
      ctx.fillText(`结束 ${rep.result}`, X(rep.duration) + 4, yy - 16);
    }
    yy += 6;
  });
  // 图例
  let lx = L;
  ctx.font = '11px -apple-system, "PingFang SC", "Noto Sans SC", sans-serif';
  const used = new Set<string>();
  for (const rep of reps) for (const f of rep.frames) for (let s = 0; s < 2; s++) used.add(STATES[f[3 + s * 13 + 11]]);
  for (const st of STATES) {
    if (!used.has(st)) continue;
    ctx.fillStyle = STATE_COLOR[st];
    ctx.fillRect(lx, yy, 10, 10);
    ctx.fillStyle = '#d8e2f2';
    ctx.fillText(STATE_CN[st], lx + 13, yy + 9);
    lx += ctx.measureText(STATE_CN[st]).width + 24;
  }
  for (const [tier, cn] of [
    ['medium', '中等撞击'],
    ['heavy', '猛撞'],
  ]) {
    ctx.fillStyle = TIER_COLOR[tier];
    ctx.fillRect(lx, yy - 1, 3, 12);
    ctx.fillStyle = '#d8e2f2';
    ctx.fillText(cn, lx + 6, yy + 9);
    lx += ctx.measureText(cn).width + 18;
  }
  ctx.fillStyle = '#d8e2f2';
  ctx.fillText('✕ 撞墙', lx, yy + 9);
  // 光标
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(X(t), y0 + 4);
  ctx.lineTo(X(t), y0 + h - 16);
  ctx.stroke();
}

function drawHeader(t: number) {
  const rep = panels.new.track!.rep;
  const sc = rep.scenario;
  ctx.fillStyle = '#0a1020';
  ctx.fillRect(0, 0, W, HEAD);
  ctx.font = '700 16px -apple-system, "PingFang SC", "Noto Sans SC", sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(sc.name, 12, 25);
  ctx.font = '13px -apple-system, "PingFang SC", "Noto Sans SC", sans-serif';
  ctx.fillStyle = BEY_COLOR[0];
  const x1 = 12 + ctx.measureText(sc.name).width + 30;
  ctx.fillText(`玩家 ${loadoutName(sc.player)}  力度 ${sc.pCmd.power} 方向 ${sc.pCmd.aim}`, x1, 25);
  ctx.fillStyle = BEY_COLOR[1];
  ctx.fillText(`对手 ${loadoutName(sc.rival)}  力度 ${sc.rCmd.power} 方向 ${sc.rCmd.aim}`, x1 + 430, 25);
  ctx.fillStyle = '#8fa3c4';
  ctx.fillText(`种子 ${sc.seed}${sc.phase ? `  初相 ${sc.phase.map((p) => p.toFixed(2)).join('/')}` : ''}`, x1 + 860, 25);
  ctx.font = '700 18px ui-monospace, Menlo, monospace';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(`t = ${t.toFixed(2)} s`, W - 140, 27);
}

function renderAt(t: number) {
  ctx.clearRect(0, 0, W, H);
  renderer.setScissorTest(true);
  renderer.setClearColor(0x04060b, 1);
  renderer.setViewport(0, 0, W, H);
  renderer.setScissor(0, 0, W, H);
  renderer.clear();
  const views: [Ver, number, number][] = mode === 'split' ? [['base', 0, 800], ['new', 800, 800]] : [[single, 0, W]];
  for (const [v, x, w] of views) {
    const p = panels[v];
    updatePanel(p, t);
    p.cam.aspect = w / VIEW_H;
    if (mode === 'single') p.cam.fov = 34;
    else p.cam.fov = 40;
    p.cam.updateProjectionMatrix();
    // WebGL 视口原点在左下
    renderer.setViewport(x, BOT, w, VIEW_H);
    renderer.setScissor(x, BOT, w, VIEW_H);
    renderer.render(p.scene, p.cam);
  }
  drawHeader(t);
  for (const [v, x, w] of views) drawViewHud(v, x, w, t);
  if (mode === 'split') {
    ctx.fillStyle = '#1b2538';
    ctx.fillRect(799, HEAD, 2, VIEW_H);
  } else {
    ctx.font = '600 13px -apple-system, "PingFang SC", "Noto Sans SC", sans-serif';
    ctx.fillStyle = '#8fa3c4';
    ctx.fillText('单屏切换模式：Tab 在左右两个版本之间切换，时间不变', W - 400, HEAD + 50);
  }
  const by = HEAD + VIEW_H;
  drawTopDown('base', 0, by, BOT, t);
  drawTopDown('new', BOT, by, BOT, t);
  drawTimeline(BOT * 2, by, W - BOT * 2, BOT, t);
}

// ---------- 控制 ----------
let t = 0;
let playing = !RECORD;
let speed = 1;
let lastNow = 0;

async function loadKey(key: string) {
  const pair = await loadPair(key);
  pairKey = key;
  for (const v of VERS) setTrack(panels[v], makeTrack(pair[v]));
  duration = Math.max(pair.base.duration, pair.new.duration);
  t = Math.min(t, duration);
  if (slider) slider.max = String(duration);
  renderAt(t);
}

let slider: HTMLInputElement | null = null;
async function main() {
  const index = await loadIndex();
  const key = q.get('s') ?? index[0];
  if (!RECORD) {
    const bar = document.createElement('div');
    bar.id = 'bar';
    const sel = document.createElement('select');
    for (const k of index) sel.append(new Option(k.replace('_', '#'), k));
    sel.value = key;
    sel.onchange = () => {
      t = 0;
      void loadKey(sel.value);
      history.replaceState(null, '', `?s=${sel.value}${q.get('pair') ? `&pair=${q.get('pair')}` : ''}`);
    };
    const btn = (txt: string, fn: () => void) => {
      const b = document.createElement('button');
      b.textContent = txt;
      b.onclick = fn;
      bar.append(b);
      return b;
    };
    bar.append(sel);
    const play = btn('暂停', () => togglePlay());
    const togglePlay = () => {
      playing = !playing;
      play.textContent = playing ? '暂停' : '播放';
    };
    btn('上一次接触', () => jumpContact(-1));
    btn('下一次接触', () => jumpContact(1));
    const sp = document.createElement('select');
    for (const s of [0.1, 0.25, 0.5, 1, 2]) sp.append(new Option(`${s}×`, String(s)));
    sp.value = '1';
    sp.onchange = () => (speed = Number(sp.value));
    bar.append(sp);
    const modeBtn = btn('单屏切换', () => {
      mode = mode === 'split' ? 'single' : 'split';
      modeBtn.textContent = mode === 'split' ? '单屏切换' : '并排';
      verBtn.style.display = mode === 'single' ? '' : 'none';
      renderAt(t);
    });
    const verBtn = btn('', () => {
      single = single === 'base' ? 'new' : 'base';
      verBtn.textContent = `当前：${VER_SHORT[single]}（Tab 切换）`;
      renderAt(t);
    });
    verBtn.textContent = `当前：${VER_SHORT[single]}（Tab 切换）`;
    verBtn.style.display = mode === 'single' ? '' : 'none';
    slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.step = String(1 / 60);
    slider.style.flex = '1';
    slider.oninput = () => {
      t = Number(slider!.value);
      renderAt(t);
    };
    bar.append(slider);
    document.body.append(bar);
    addEventListener('keydown', (e) => {
      if (e.key === ' ') {
        togglePlay();
        e.preventDefault();
      } else if (e.key === 'ArrowRight') t = Math.min(duration, t + 1 / 60);
      else if (e.key === 'ArrowLeft') t = Math.max(0, t - 1 / 60);
      else if (e.key === ']') jumpContact(1);
      else if (e.key === '[') jumpContact(-1);
      else if (e.key === 'v' || e.key === 'V') modeBtn.click();
      else if (e.key === 'Tab') {
        if (mode === 'split') modeBtn.click();
        verBtn.click();
        e.preventDefault();
      } else return;
      renderAt(t);
    });
  }
  await loadKey(key);
  if (!RECORD) requestAnimationFrame(loop);
  return { duration };
}

function jumpContact(dir: number) {
  const all = VERS.flatMap((v) => panels[v].track!.rep.contacts.map((c) => c.t0)).sort((a, b) => a - b);
  const nx = dir > 0 ? all.find((c) => c > t + 0.02) : [...all].reverse().find((c) => c < t - 0.02);
  if (nx !== undefined) t = Math.max(0, nx - 0.5);
  renderAt(t);
}

function loop(now: number) {
  const dt = lastNow ? Math.min(0.1, (now - lastNow) / 1000) : 0;
  lastNow = now;
  if (playing) {
    t += dt * speed;
    if (t > duration + 1) t = 0;
    if (slider) slider.value = String(t);
    renderAt(t);
  }
  requestAnimationFrame(loop);
}

window.renderAt = renderAt;
window.replayReady = main();
void pairKey;
