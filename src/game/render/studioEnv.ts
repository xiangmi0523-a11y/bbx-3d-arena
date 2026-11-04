import * as THREE from 'three';

/**
 * 程序生成的「产品摄影棚」环境贴图（HDR，半精度浮点，等距柱状投影）。
 *
 * 真实的金属 / 透明塑料玩具产品图，质感主要来自反射里的柔光箱：暗背景上的几块高亮灯箱
 * 在金属切面上形成清晰的亮条，在透明件边缘形成高光。RoomEnvironment 是均匀的灰色房间，
 * 反射里没有明暗对比，金属看起来发灰、像塑料。
 *
 * 这张贴图只给陀螺零件的材质用（material.envMap），不替换场景环境光，竞技场外观不变。
 * three.js 会在第一次使用时把它预过滤成 PMREM（每个渲染器一次，约 1 ms），之后与普通环境贴图开销相同。
 * 用 HalfFloat 而不是 Float：iPhone Safari 的 WebGL2 不支持 32 位浮点纹理的线性过滤。
 */

const W = 512;
const Hh = 256;

interface AreaLight {
  /** 中心经度 / 纬度（弧度） */
  lon: number;
  lat: number;
  /** 半宽（经度方向，弧度，按纬度余弦缩放前）/ 半高（纬度方向） */
  hw: number;
  hh: number;
  /** 线性亮度 */
  power: number;
  color: [number, number, number];
}

const LIGHTS: AreaLight[] = [
  // 顶部大柔光箱：金属上表面的主高光
  { lon: 0.4, lat: 1.3, hw: 0.9, hh: 0.3, power: 4, color: [1, 1, 1] },
  // 左前竖条灯：切面上的锐利亮线
  { lon: -2.2, lat: 0.35, hw: 0.08, hh: 0.55, power: 7, color: [1, 0.98, 0.95] },
  // 右侧冷色竖条：反方向切面的冷色边光
  { lon: 0.9, lat: 0.3, hw: 0.07, hh: 0.5, power: 4, color: [0.8, 0.88, 1] },
  // 后方横条：沿地平线的一道亮带，侧壁上形成水平高光
  { lon: Math.PI, lat: 0.12, hw: 1.1, hh: 0.035, power: 3.2, color: [0.95, 0.97, 1] },
  // 前下方小反光板：给底部倒角一点提亮
  { lon: -0.6, lat: -0.15, hw: 0.4, hh: 0.06, power: 1.2, color: [1, 1, 1] },
];

const smoothBox = (d: number, half: number, soft: number) => {
  const x = (Math.abs(d) - half) / soft;
  if (x <= 0) return 1;
  if (x >= 1) return 0;
  return 1 - x * x * (3 - 2 * x);
};

const wrap = (a: number) => {
  let x = a;
  while (x > Math.PI) x -= Math.PI * 2;
  while (x < -Math.PI) x += Math.PI * 2;
  return x;
};

let cached: THREE.DataTexture | null = null;

export function getStudioEnv(): THREE.DataTexture {
  if (cached) return cached;
  const data = new Uint16Array(W * Hh * 4);
  for (let y = 0; y < Hh; y++) {
    // DataTexture 第 0 行 = v 0 = 正下方
    const lat = ((y + 0.5) / Hh - 0.5) * Math.PI;
    const cl = Math.cos(lat);
    // 背景：上方深蓝灰，地平线附近略亮，下方近黑（像深色反光台面）
    let br: number, bg: number, bb: number;
    if (lat >= 0) {
      const k = Math.exp(-lat * 3);
      // 上半球是一层均匀的柔光（摄影棚的白色反光罩），金属整体读作银色而不是发黑的镜面
      br = 0.16 + 0.12 * k;
      bg = 0.17 + 0.125 * k;
      bb = 0.19 + 0.13 * k;
    } else {
      const k = Math.exp(lat * 9);
      // 下半球：中灰色台面，地平线附近更亮（侧壁和前壁反射这里，不会发黑）
      br = 0.07 + 0.2 * k;
      bg = 0.075 + 0.21 * k;
      bb = 0.09 + 0.23 * k;
    }
    for (let x = 0; x < W; x++) {
      const lon = ((x + 0.5) / W - 0.5) * Math.PI * 2;
      let r = br;
      let g = bg;
      let b = bb;
      for (const L of LIGHTS) {
        const dl = wrap(lon - L.lon) * Math.max(cl, 0.05);
        const w = smoothBox(dl, L.hw * Math.cos(L.lat), 0.03) * smoothBox(lat - L.lat, L.hh, 0.03);
        if (w > 0) {
          r += w * L.power * L.color[0];
          g += w * L.power * L.color[1];
          b += w * L.power * L.color[2];
        }
      }
      const i = (y * W + x) * 4;
      data[i] = THREE.DataUtils.toHalfFloat(r);
      data[i + 1] = THREE.DataUtils.toHalfFloat(g);
      data[i + 2] = THREE.DataUtils.toHalfFloat(b);
      data[i + 3] = THREE.DataUtils.toHalfFloat(1);
    }
  }
  const tex = new THREE.DataTexture(data, W, Hh, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.mapping = THREE.EquirectangularReflectionMapping;
  tex.colorSpace = THREE.LinearSRGBColorSpace;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  tex.name = 'studio-env';
  cached = tex;
  return tex;
}

let roughCached: THREE.DataTexture | null = null;

/**
 * 金属粗糙度变化贴图（绿色通道）：低频的抛光不均 + 沿 u 方向的细拉丝。
 * 变化幅度小、频率低，高速旋转时不会产生闪烁的细碎噪点（贴图带 mipmap）。
 */
export function getMetalRoughnessMap(): THREE.DataTexture {
  if (roughCached) return roughCached;
  const N = 128;
  const data = new Uint8Array(N * N * 4);
  // 简单的可平铺值噪声
  const rnd = (i: number, j: number) => {
    const s = Math.sin(((i % 16) + 16) % 16 * 127.1 + (((j % 16) + 16) % 16) * 311.7) * 43758.5453;
    return s - Math.floor(s);
  };
  const noise = (u: number, v: number) => {
    const i = Math.floor(u);
    const j = Math.floor(v);
    const fu = u - i;
    const fv = v - j;
    const su = fu * fu * (3 - 2 * fu);
    const sv = fv * fv * (3 - 2 * fv);
    const a = rnd(i, j);
    const b = rnd(i + 1, j);
    const c = rnd(i, j + 1);
    const d = rnd(i + 1, j + 1);
    return a + (b - a) * su + (c - a) * sv + (a - b - c + d) * su * sv;
  };
  // 拉丝：每行一个随机偏移（沿 u 方向连续）
  const streak = new Float32Array(N);
  for (let y = 0; y < N; y++) streak[y] = rnd(y * 7, 3) - 0.5;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const low = noise((x / N) * 4, (y / N) * 4) * 0.6 + noise((x / N) * 8, (y / N) * 8) * 0.4;
      const v = 0.72 + (low - 0.5) * 0.35 + streak[y] * 0.12;
      const c = Math.round(Math.min(1, Math.max(0, v)) * 255);
      const i = (y * N + x) * 4;
      data[i] = c;
      data[i + 1] = c;
      data[i + 2] = c;
      data[i + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  tex.name = 'metal-roughness';
  roughCached = tex;
  return tex;
}
