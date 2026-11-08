import * as THREE from 'three';
import { createFloorTexture } from '../render/textures';
import { buildFloorMesh } from './ArenaPhysics';
import { ARENA, type ArenaSpec, floorHeight, pocketAtAngle, rimHeight } from './arenaSpec';

/**
 * 竞技场视觉模型（与碰撞体分离，只负责好看）。
 * 原创造型：深蓝六边形碗面 + 外圈橙色齿轮轨道 + 半透明护墙 + 红色极限口袋 / 黄色出界口袋。
 */
export function createArenaVisual(spec: ArenaSpec = ARENA): THREE.Group {
  const group = new THREE.Group();
  group.name = 'arena';
  const rim = rimHeight(spec);
  const outer = spec.radius + 0.25;

  // 1) 碗面
  const mesh = buildFloorMesh(spec, 56, 160);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(mesh.vertices, 3));
  geo.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
  const uv = new Float32Array((mesh.vertices.length / 3) * 2);
  for (let i = 0; i < mesh.vertices.length / 3; i++) {
    uv[i * 2] = (mesh.vertices[i * 3] / outer + 1) / 2;
    uv[i * 2 + 1] = 1 - (mesh.vertices[i * 3 + 2] / outer + 1) / 2;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.computeVertexNormals();
  const floor = new THREE.Mesh(
    geo,
    // 碗面：高光漆面 + 清漆层，能映出环境和灯光，陀螺下方有清晰阴影
    new THREE.MeshPhysicalMaterial({
      map: createFloorTexture(),
      roughness: 0.38,
      metalness: 0.15,
      clearcoat: 0.8,
      clearcoatRoughness: 0.12,
    }),
  );
  floor.receiveShadow = true;
  // 低 / 中档用的无清漆碗面（同一贴图与粗糙度），由 GameEngine.applyQuality 切换
  floor.name = 'arena-floor';
  const rich = floor.material as THREE.MeshPhysicalMaterial;
  floor.userData.rich = rich;
  floor.userData.cheap = new THREE.MeshStandardMaterial({ map: rich.map, roughness: rich.roughness, metalness: rich.metalness });
  group.add(floor);

  // 2) 极限轨道：沿外缘一圈齿条（实例化网格），口袋处断开
  const toothGeo = new THREE.BoxGeometry(0.16, 0.12, 0.07, 1, 1, 1);
  const toothMat = new THREE.MeshStandardMaterial({ color: 0xff8a2a, metalness: 0.85, roughness: 0.28, emissive: 0x2a0e00 });
  // 齿距保持不变：齿数随周长增加
  const teethCount = Math.round(180 * (spec.radius / 4.6));
  const teeth = new THREE.InstancedMesh(toothGeo, toothMat, teethCount);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3(1, 1, 1);
  let n = 0;
  const railR = spec.radius - 0.1;
  for (let i = 0; i < teethCount; i++) {
    const a = (i / teethCount) * Math.PI * 2;
    if (pocketAtAngle(a, spec)) continue;
    q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -a);
    m.compose(new THREE.Vector3(Math.cos(a) * railR, floorHeight(railR, spec) + 0.04, Math.sin(a) * railR), q, s);
    teeth.setMatrixAt(n++, m);
  }
  teeth.count = n;
  teeth.castShadow = true;
  // P2.2 性能：实例化网格与普通网格共用 three.js 默认的阴影深度材质时，每帧要来回切换着色器参数两次；
  // 单独给齿条一个深度材质（参数相同，阴影外观不变）
  teeth.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  group.add(teeth);

  // 轨道内沿发光线
  const railLine = new THREE.Mesh(
    new THREE.TorusGeometry(spec.railInner, 0.025, 6, 160),
    new THREE.MeshBasicMaterial({ color: 0xffa040 }),
  );
  railLine.rotation.x = Math.PI / 2;
  railLine.position.y = floorHeight(spec.railInner, spec) + 0.015;
  group.add(railLine);

  // 3) 护墙（按口袋把圆周切成几段弧）
  const wallMat = new THREE.MeshPhysicalMaterial({
    color: 0x7fc4ff,
    transparent: true,
    opacity: 0.28,
    roughness: 0.1,
    metalness: 0,
    side: THREE.DoubleSide,
    // P2.2 性能：透明 + 双面材质默认会被 three.js 拆成“先背面、再正面”两遍绘制，
    // 每遍都改 material.side 并标记 needsUpdate，导致每帧重新计算着色器参数（实测每帧 20 多次）。
    // 单遍绘制：同一颜色的两层半透明叠加结果相同，外观不变。
    forceSinglePass: true,
    depthWrite: false,
  });
  const rimMat = new THREE.MeshPhysicalMaterial({ color: 0x232a3a, metalness: 0.6, roughness: 0.3, clearcoat: 0.6 });
  const glowMat = new THREE.MeshBasicMaterial({ color: 0x46c8ff });
  const wallH = spec.wallHeight + 0.4;
  for (const [a0, a1] of wallArcs(spec)) {
    const len = a1 - a0;
    const thetaStart = Math.PI / 2 - a1; // three.js 圆柱的角度从 +Z 起算
    const wall = new THREE.Mesh(
      new THREE.CylinderGeometry(spec.radius + 0.02, spec.radius + 0.02, wallH, 48, 1, true, thetaStart, len),
      wallMat,
    );
    wall.position.y = rim - 0.4 + wallH / 2;
    wall.renderOrder = 2;
    group.add(wall);
    // 墙外侧实体底座
    const base = new THREE.Mesh(
      new THREE.CylinderGeometry(spec.radius + 0.32, spec.radius + 0.4, rim + 1.5, 48, 1, true, thetaStart, len),
      rimMat,
    );
    base.position.y = (rim - 0.25) / 2 - 0.7 + 0.1;
    group.add(base);
    // 墙顶发光边
    const top = new THREE.Mesh(new THREE.TorusGeometry(spec.radius + 0.05, 0.05, 6, 64, len), glowMat);
    // TorusGeometry 在 XY 平面从 +X 起算；先绕 Z 转到起始角，再绕 X 转 90° 放平，角度方向与 atan2(z,x) 一致
    top.rotation.x = Math.PI / 2;
    top.rotation.z = a0;
    top.position.y = rim - 0.4 + wallH;
    group.add(top);
  }

  // 4) 口袋
  for (const p of spec.pockets) {
    const color = p.kind === 'xtreme' ? 0xff3b2f : 0xffc832;
    const pocket = new THREE.Group();
    const floorY = rim - p.drop;
    const pocketFloor = new THREE.Mesh(
      new THREE.BoxGeometry(p.depth + 0.3, 0.12, p.width + 0.2),
      new THREE.MeshStandardMaterial({ color: 0x141a26, emissive: color, emissiveIntensity: 0.18, roughness: 0.6 }),
    );
    pocketFloor.position.set(spec.radius + p.depth / 2 - 0.05, floorY - 0.06, 0);
    pocketFloor.receiveShadow = true;
    pocket.add(pocketFloor);
    // 斜坡状警示条纹
    for (let i = 0; i < 5; i++) {
      const stripe = new THREE.Mesh(
        new THREE.BoxGeometry(0.08, 0.01, p.width * 0.85),
        new THREE.MeshBasicMaterial({ color }),
      );
      stripe.position.set(spec.radius + 0.25 + i * (p.depth / 5), floorY + 0.005, 0);
      pocket.add(stripe);
    }
    const sideMat = new THREE.MeshStandardMaterial({ color: 0x1d2433, metalness: 0.5, roughness: 0.4 });
    const h = rim + spec.wallHeight - floorY;
    const back = new THREE.Mesh(new THREE.BoxGeometry(0.18, h, p.width + 0.4), sideMat);
    back.position.set(spec.radius + p.depth + 0.1, floorY + h / 2, 0);
    pocket.add(back);
    for (const sgn of [-1, 1]) {
      const side = new THREE.Mesh(new THREE.BoxGeometry(p.depth + 0.2, h, 0.18), sideMat);
      side.position.set(spec.radius + p.depth / 2, floorY + h / 2, sgn * (p.width / 2 + 0.1));
      pocket.add(side);
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.22, h + 0.1, 0.22), new THREE.MeshBasicMaterial({ color }));
      post.position.set(spec.radius + 0.05, floorY + h / 2, sgn * (p.width / 2 + 0.1));
      pocket.add(post);
    }
    // 口袋入口发光条
    const lip = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.04, p.width), new THREE.MeshBasicMaterial({ color }));
    lip.position.set(spec.radius, rim + 0.02, 0);
    pocket.add(lip);
    pocket.rotation.y = -p.angle;
    group.add(pocket);
  }

  // 5) 底座与台面
  const pedestal = new THREE.Mesh(
    new THREE.CylinderGeometry(spec.radius + 1.0, spec.radius + 1.4, 0.6, 8),
    new THREE.MeshStandardMaterial({ color: 0x10141e, metalness: 0.4, roughness: 0.6 }),
  );
  pedestal.position.y = -0.95;
  pedestal.receiveShadow = true;
  group.add(pedestal);
  const table = new THREE.Mesh(
    new THREE.CircleGeometry(40, 48),
    new THREE.MeshStandardMaterial({ color: 0x080a10, roughness: 0.9 }),
  );
  table.rotation.x = -Math.PI / 2;
  table.position.y = -1.2;
  table.receiveShadow = true;
  group.add(table);

  return group;
}

/** 护墙弧段（不含口袋开口），返回 [起始角, 结束角]，角度递增 */
export function wallArcs(spec: ArenaSpec): [number, number][] {
  const gaps = spec.pockets
    .map((p) => {
      const half = p.width / spec.radius / 2;
      let c = p.angle % (Math.PI * 2);
      if (c < 0) c += Math.PI * 2;
      return [c - half, c + half] as [number, number];
    })
    .sort((a, b) => a[0] - b[0]);
  const arcs: [number, number][] = [];
  for (let i = 0; i < gaps.length; i++) {
    const end = gaps[i][1];
    const nextStart = i + 1 < gaps.length ? gaps[i + 1][0] : gaps[0][0] + Math.PI * 2;
    arcs.push([end, nextStart]);
  }
  return arcs;
}
