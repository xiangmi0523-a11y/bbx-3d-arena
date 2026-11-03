import * as THREE from 'three';

/** 撞击火花：固定容量的粒子池，CPU 更新，加法混合 */
export class Sparks {
  readonly points: THREE.Points;
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly life: Float32Array;
  private readonly col: Float32Array;
  private next = 0;
  private readonly count: number;

  constructor(count = 256) {
    this.count = count;
    this.pos = new Float32Array(count * 3).fill(-999);
    this.vel = new Float32Array(count * 3);
    this.life = new Float32Array(count);
    this.col = new Float32Array(count * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3));
    const mat = new THREE.PointsMaterial({
      size: 0.09,
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    this.points = new THREE.Points(geo, mat);
    this.points.frustumCulled = false;
  }

  burst(x: number, y: number, z: number, strength: number): void {
    const n = Math.round(10 + strength * 40);
    for (let i = 0; i < n; i++) {
      const k = this.next;
      this.next = (this.next + 1) % this.count;
      this.pos[k * 3] = x;
      this.pos[k * 3 + 1] = y;
      this.pos[k * 3 + 2] = z;
      const a = Math.random() * Math.PI * 2;
      const sp = (2 + Math.random() * 6) * (0.5 + strength);
      this.vel[k * 3] = Math.cos(a) * sp;
      this.vel[k * 3 + 1] = 1 + Math.random() * 4 * strength;
      this.vel[k * 3 + 2] = Math.sin(a) * sp;
      this.life[k] = 0.25 + Math.random() * 0.35;
    }
  }

  update(dt: number): void {
    for (let k = 0; k < this.count; k++) {
      if (this.life[k] <= 0) continue;
      this.life[k] -= dt;
      const i = k * 3;
      this.vel[i + 1] -= 18 * dt;
      this.pos[i] += this.vel[i] * dt;
      this.pos[i + 1] += this.vel[i + 1] * dt;
      this.pos[i + 2] += this.vel[i + 2] * dt;
      const t = Math.max(0, this.life[k] / 0.6);
      this.col[i] = 1 * t + 0.2;
      this.col[i + 1] = 0.75 * t;
      this.col[i + 2] = 0.3 * t * t;
      if (this.life[k] <= 0) this.pos[i + 1] = -999;
    }
    this.points.geometry.attributes.position.needsUpdate = true;
    this.points.geometry.attributes.color.needsUpdate = true;
  }

  clear(): void {
    this.life.fill(0);
    for (let k = 0; k < this.count; k++) this.pos[k * 3 + 1] = -999;
  }
}
