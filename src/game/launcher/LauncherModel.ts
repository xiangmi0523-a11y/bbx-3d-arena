import * as THREE from 'three';

/**
 * 发射器 3D 模型（原创造型）：横向机身 + 握把 + 拉绳把手。
 * 准备阶段悬停在发射点上方，陀螺挂在下面；拉绳越长，把手被拉得越远、陀螺预转越快。
 */
export class LauncherModel {
  readonly root = new THREE.Group();
  /** 陀螺挂载点 */
  readonly mount = new THREE.Group();
  private readonly handle: THREE.Group;
  private readonly cord: THREE.Mesh;
  private readonly gauge: THREE.Mesh;
  private readonly gaugeMat: THREE.MeshBasicMaterial;

  constructor(color = 0xe8302a) {
    const body = new THREE.MeshStandardMaterial({ color: 0x1b1f28, metalness: 0.4, roughness: 0.45 });
    const trim = new THREE.MeshStandardMaterial({ color, metalness: 0.3, roughness: 0.35 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x0c0e13, roughness: 0.7 });

    // 机身（圆角长条）
    const shape = new THREE.Shape();
    const w = 1.5;
    const h = 0.5;
    const r = 0.2;
    shape.moveTo(-w / 2 + r, -h / 2);
    shape.lineTo(w / 2 - r, -h / 2);
    shape.quadraticCurveTo(w / 2, -h / 2, w / 2, -h / 2 + r);
    shape.lineTo(w / 2, h / 2 - r);
    shape.quadraticCurveTo(w / 2, h / 2, w / 2 - r, h / 2);
    shape.lineTo(-w / 2 + r, h / 2);
    shape.quadraticCurveTo(-w / 2, h / 2, -w / 2, h / 2 - r);
    shape.lineTo(-w / 2, -h / 2 + r);
    shape.quadraticCurveTo(-w / 2, -h / 2, -w / 2 + r, -h / 2);
    const bodyGeo = new THREE.ExtrudeGeometry(shape, { depth: 0.22, bevelEnabled: true, bevelSize: 0.04, bevelThickness: 0.04, bevelSegments: 2 });
    bodyGeo.rotateX(-Math.PI / 2);
    bodyGeo.translate(0, 0, 0);
    const shell = new THREE.Mesh(bodyGeo, body);
    this.root.add(shell);
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(w * 0.9, 0.03, 0.08), trim);
    stripe.position.set(0, 0.27, 0.12);
    this.root.add(stripe);

    // 握把
    const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 0.55, 16), dark);
    grip.position.set(-0.45, 0.45, 0);
    grip.rotation.z = 0.25;
    this.root.add(grip);

    // 陀螺挂载环
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.34, 0.05, 8, 32), trim);
    ring.rotation.x = Math.PI / 2;
    ring.position.set(0.15, -0.02, 0);
    this.root.add(ring);
    this.mount.position.set(0.15, -0.1, 0);
    this.root.add(this.mount);

    // 拉绳把手（从机身右端拉出）
    this.handle = new THREE.Group();
    const t = new THREE.Mesh(new THREE.TorusGeometry(0.13, 0.04, 8, 20), trim);
    this.handle.add(t);
    this.root.add(this.handle);
    this.cord = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 1, 6), new THREE.MeshBasicMaterial({ color: 0xffffff }));
    this.cord.rotation.z = Math.PI / 2;
    this.root.add(this.cord);

    // 力度光条
    this.gaugeMat = new THREE.MeshBasicMaterial({ color: 0x39f0d8 });
    this.gauge = new THREE.Mesh(new THREE.BoxGeometry(1, 0.05, 0.05), this.gaugeMat);
    this.gauge.position.set(-0.6, 0.3, -0.12);
    this.root.add(this.gauge);

    this.root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = true;
    });
    this.setPull(0);
  }

  /** 拉绳长度 0..1 */
  setPull(pull: number): void {
    const x = 0.8 + pull * 1.6;
    this.handle.position.set(x + 0.13, 0.05, 0);
    this.cord.scale.y = x - 0.7;
    this.cord.position.set((0.7 + x) / 2, 0.05, 0);
    const len = Math.max(0.001, pull * 1.2);
    this.gauge.scale.x = len;
    this.gauge.position.x = -0.6 + len / 2;
    this.gaugeMat.color.setHSL(0.5 - pull * 0.5, 0.9, 0.55);
  }
}
