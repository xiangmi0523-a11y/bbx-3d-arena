import * as THREE from 'three';
import { getMetalRoughnessMap, getStudioEnv } from '../../render/studioEnv';
import { createGaleEmblemTexture, createTypeEmblemTexture } from '../../render/textures';
import type { BeyRole } from '../parts/types';

/**
 * 陀螺零件共用的材质库（P2.3）。
 *
 * 同一种材质在所有零件、所有陀螺之间只创建一个实例：
 *  - 整台陀螺的材质数按实例计（预算 ≤ 8），共用后 Blade 与 Disc 的同类塑料 / 金属只算一次；
 *  - 两台陀螺同屏时共用着色器程序和材质状态，少一些状态切换。
 * 共用实例带 userData.shared，disposeObject 不会释放它们（换零件时不必重新编译着色器）。
 * 参数与阶段 1.1 验收时的疾风新月 Blade 完全相同，只是把创建位置移到这里。
 */

const cache = new Map<string, THREE.Material>();
function shared<T extends THREE.Material>(key: string, make: () => T): () => T {
  return () => {
    let m = cache.get(key) as T | undefined;
    if (!m) {
      m = make();
      m.userData.shared = true;
      cache.set(key, m);
    }
    return m;
  };
}

// ───────────────────────── 材质（银色金属 / 蓝色透明塑料 / 深色塑料 三类明确区分） ─────────────────────────

function make_polishedMetal(): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color: 0xe9edf2,
    metalness: 1,
    roughness: 0.3,
    roughnessMap: getMetalRoughnessMap(),
    envMap: getStudioEnv(),
    envMapIntensity: 1.15,
  });
}

function make_satinMetal(): THREE.MeshPhysicalMaterial {
  return new THREE.MeshPhysicalMaterial({
    color: 0xc9d0da,
    metalness: 1,
    roughness: 0.38,
    envMap: getStudioEnv(),
    envMapIntensity: 1,
  });
}

/**
 * 透明塑料：普通的半透明混合会把反射也一起按不透明度减弱，看起来像一层蓝色薄膜。
 * 这里在着色器末尾按菲涅尔（掠射角）和高光亮度提高不透明度：
 * 正对视线的部分透出下面的结构，边缘和高光处更实，读起来像有厚度的透明件。
 * 没有使用 transmission（需要额外渲染一遍整个场景，iPhone 上开销太大）。
 */
function clearPlastic(params: THREE.MeshPhysicalMaterialParameters, edge: number, highlight: number): THREE.MeshPhysicalMaterial {
  const m = new THREE.MeshPhysicalMaterial({
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    // 单遍绘制：双面透明默认拆成两遍，每帧都会改 material.side 触发着色器参数重算（P2.2 性能问题）
    forceSinglePass: true,
    envMap: getStudioEnv(),
    ...params,
  });
  m.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <opaque_fragment>',
      `float gNV = abs( dot( geometryNormal, geometryViewDir ) );
float gFres = pow( 1.0 - gNV, 2.5 );
vec3 gSpec = reflectedLight.directSpecular + reflectedLight.indirectSpecular;
float gHi = dot( gSpec, vec3( 0.2126, 0.7152, 0.0722 ) );
diffuseColor.a = clamp( diffuseColor.a + gFres * ${edge.toFixed(3)} + gHi * ${highlight.toFixed(3)}, 0.0, 1.0 );
#include <opaque_fragment>`,
    );
  };
  m.customProgramCacheKey = () => `gale-clear-${edge}-${highlight}`;
  return m;
}

function make_bluePlastic(): THREE.MeshPhysicalMaterial {
  return clearPlastic(
    {
      // ACES 色调映射会把高亮的纯蓝推向紫色：底色压暗，主要颜色来自自发光，渲染出来是深宝蓝
      color: 0x062590,
      emissive: 0x0a3ccc,
      emissiveIntensity: 0.5,
      metalness: 0,
      roughness: 0.1,
      ior: 1.49,
      specularIntensity: 1,
      envMapIntensity: 0.32,
      opacity: 0.62,
    },
    0.45,
    0.9,
  );
}

function make_clearDome(): THREE.MeshPhysicalMaterial {
  return clearPlastic(
    { color: 0xffffff, opacity: 0.04, roughness: 0.02, metalness: 0, ior: 1.5, specularIntensity: 1, envMapIntensity: 0.25 },
    0.05,
    0.25,
  );
}

function make_darkPlastic(): THREE.MeshPhysicalMaterial {
  // 深色注塑件：带一层清漆，反射里能看到柔光箱
  return new THREE.MeshPhysicalMaterial({
    color: 0x0b0f19,
    metalness: 0,
    roughness: 0.45,
    clearcoat: 0.6,
    clearcoatRoughness: 0.25,
    envMap: getStudioEnv(),
    envMapIntensity: 0.8,
  });
}


export const polishedMetal = shared('polished-metal', make_polishedMetal);
export const satinMetal = shared('satin-metal', make_satinMetal);
export const bluePlastic = shared('blue-clear-plastic', make_bluePlastic);
export const clearDome = shared('clear-dome', make_clearDome);
export const darkPlastic = shared('dark-plastic', make_darkPlastic);

/** 疾风新月的原创徽标（带清漆的印刷贴片） */
export const galeEmblem = shared('gale-emblem', () => {
  const m = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.45, metalness: 0, clearcoat: 0.35, clearcoatRoughness: 0.2, envMap: getStudioEnv(), envMapIntensity: 0.3 });
  // 单元测试在 Node 里构建模型，没有 Canvas 时只用纯色
  if (typeof document !== 'undefined') m.map = createGaleEmblemTexture();
  else m.color.set(0x16233f);
  return m;
});

/**
 * 深蓝注塑塑料（不透明）：Disc 主体。半哑光表面加一层很薄的清漆，
 * 和 Blade 的透明蓝、深色塑料同一色系，但明显更深、不透光。
 */
export const navyPlastic = shared('navy-plastic', () =>
  new THREE.MeshPhysicalMaterial({
    // 掠射角的环境反射会把深色塑料冲成灰银色：反射压低，底色略提亮，侧面也读得出是深蓝
    color: 0x12307e,
    metalness: 0,
    roughness: 0.5,
    clearcoat: 0.15,
    clearcoatRoughness: 0.35,
    specularIntensity: 0.6,
    envMap: getStudioEnv(),
    envMapIntensity: 0.4,
  }),
);

// ───────────────────────── M6：四种类型色（任务书概念板的视觉语言：银色金属刃 + 类型色骨架 + 中心徽章） ─────────────────────────

/**
 * 各类型的透明塑料与不透明注塑色。ACES 色调映射会把高亮纯色推偏，所以底色压暗、主要颜色来自自发光
 * （与已验收的疾风新月蓝色透明件同一做法）：攻击 红 / 防守 蓝 / 平衡 绿 / 耐力 紫。
 */
const TYPE_PLASTIC: Record<BeyRole, { color: number; emissive: number; k: number; solid: number }> = {
  attack: { color: 0x5a0707, emissive: 0xc8170e, k: 0.5, solid: 0x7a1410 },
  defense: { color: 0x062590, emissive: 0x0a3ccc, k: 0.5, solid: 0x12307e },
  balance: { color: 0x04401b, emissive: 0x13a34a, k: 0.45, solid: 0x0f5c2c },
  stamina: { color: 0x26085e, emissive: 0x6b2be2, k: 0.5, solid: 0x3b1a7c },
};

const typeClear: Partial<Record<BeyRole, () => THREE.MeshPhysicalMaterial>> = {};
const typeSolidM: Partial<Record<BeyRole, () => THREE.MeshPhysicalMaterial>> = {};
const typeEmblemM: Partial<Record<BeyRole, () => THREE.MeshPhysicalMaterial>> = {};

/** 类型色透明塑料（骨架、底盘、Ratchet 罩层）。防守型与疾风新月原来的蓝色透明件是同一个实例 */
export function typePlastic(role: BeyRole): THREE.MeshPhysicalMaterial {
  if (role === 'defense') return bluePlastic();
  const make = (typeClear[role] ??= shared(`clear-plastic-${role}`, () => {
    const t = TYPE_PLASTIC[role];
    return clearPlastic(
      { color: t.color, emissive: t.emissive, emissiveIntensity: t.k, metalness: 0, roughness: 0.1, ior: 1.49, specularIntensity: 1, envMapIntensity: 0.32, opacity: 0.62 },
      0.45,
      0.9,
    );
  }));
  return make();
}

/** 类型色不透明注塑件（Ratchet 裙边、Bit 外壳）。防守型与原来的深蓝注塑件是同一个实例 */
export function typeSolid(role: BeyRole): THREE.MeshPhysicalMaterial {
  if (role === 'defense') return navyPlastic();
  const make = (typeSolidM[role] ??= shared(`solid-plastic-${role}`, () =>
    new THREE.MeshPhysicalMaterial({
      color: TYPE_PLASTIC[role].solid,
      metalness: 0,
      roughness: 0.5,
      clearcoat: 0.15,
      clearcoatRoughness: 0.35,
      specularIntensity: 0.6,
      envMap: getStudioEnv(),
      envMapIntensity: 0.4,
    }),
  ));
  return make();
}

/** 类型徽标（原创图形，带清漆的印刷贴片）；平衡型沿用疾风新月的风刃徽标结构，只换颜色 */
export function typeEmblem(role: BeyRole): THREE.MeshPhysicalMaterial {
  const make = (typeEmblemM[role] ??= shared(`emblem-${role}`, () => {
    const m = new THREE.MeshPhysicalMaterial({ color: 0xffffff, roughness: 0.45, metalness: 0, clearcoat: 0.35, clearcoatRoughness: 0.2, envMap: getStudioEnv(), envMapIntensity: 0.3 });
    if (typeof document !== 'undefined') m.map = createTypeEmblemTexture(role);
    else m.color.set(TYPE_PLASTIC[role].solid);
    return m;
  }));
  return make();
}
