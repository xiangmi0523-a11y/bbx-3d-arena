import * as THREE from 'three';

export interface CameraTarget {
  position: THREE.Vector3;
  velocity: THREE.Vector3;
}

export type CameraMode = 'overview' | 'aim' | 'battle' | 'result';

/**
 * 动态跟随战斗摄像机：
 *  - 准备阶段：从玩家身后俯视整个场地；
 *  - 战斗阶段：焦点跟随两台陀螺的中点（略向场地中心收敛），
 *    距离随两者间距伸缩，镜头缓慢环绕并朝运动方向偏转，低角度更有冲击感；
 *  - 撞击时镜头震动 + 短暂拉近（FOV 收缩）；
 *  - 结算阶段：环绕胜者特写。
 * 所有运动都用指数平滑，掉帧时也不会抖动。
 */
export class BattleCamera {
  readonly camera: THREE.PerspectiveCamera;
  mode: CameraMode = 'overview';
  private readonly focus = new THREE.Vector3();
  private readonly desiredPos = new THREE.Vector3();
  private readonly desiredFocus = new THREE.Vector3();
  private orbit = Math.PI / 2;
  private orbitVel = 0;
  private shake = 0;
  private fovKick = 0;
  private time = 0;
  private baseFov = 50;
  /** 准备阶段的瞄准方向偏移（-1..1），让镜头随瞄准轻微转动 */
  aimBias = 0;
  /** 竖屏时拉远 */
  private aspect = 16 / 9;

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(this.baseFov, aspect, 0.05, 200);
    this.camera.position.set(0, 7, 10);
    this.camera.lookAt(0, 0, 0);
    this.setAspect(aspect);
  }

  setAspect(aspect: number): void {
    this.aspect = aspect;
    this.camera.aspect = aspect;
    // 竖屏时加大视野，保证场地能完整看到
    this.baseFov = aspect < 1 ? 58 : 50;
    this.camera.updateProjectionMatrix();
  }

  setMode(mode: CameraMode, snap = false): void {
    this.mode = mode;
    if (mode === 'aim' || mode === 'overview') this.orbit = Math.PI / 2;
    if (snap) this.update(1, [], true);
  }

  /** 撞击反馈，strength 0..1 */
  impact(strength: number): void {
    this.shake = Math.min(1, this.shake + strength * 0.9);
    this.fovKick = Math.min(1, this.fovKick + strength * 0.7);
  }

  update(dt: number, targets: CameraTarget[], snap = false): void {
    this.time += dt;
    // 竖屏时水平视野变窄，按宽高比拉远镜头保证场地横向完整
    const portrait = this.aspect < 1 ? Math.min(2.2, 0.8 / this.aspect) : 1;

    if (this.mode === 'overview') {
      this.orbit += dt * 0.12;
      const d = 10.5 * portrait;
      this.desiredFocus.set(0, 0.4, 0);
      this.desiredPos.set(Math.cos(this.orbit) * d, 6.2 * portrait, Math.sin(this.orbit) * d);
    } else if (this.mode === 'aim') {
      const a = Math.PI / 2 + this.aimBias * 0.18;
      const d = 8.6 * portrait;
      this.desiredFocus.set(0, 0.3, -0.4);
      this.desiredPos.set(Math.cos(a) * d, 5.6 * portrait, Math.sin(a) * d);
    } else {
      // 战斗 / 结算：跟随
      const center = new THREE.Vector3();
      const vel = new THREE.Vector3();
      for (const t of targets) {
        center.add(t.position);
        vel.add(t.velocity);
      }
      if (targets.length) {
        center.multiplyScalar(1 / targets.length);
        vel.multiplyScalar(1 / targets.length);
      }
      let spread = 0;
      if (targets.length >= 2) spread = targets[0].position.distanceTo(targets[1].position);

      if (this.mode === 'battle') {
        // 焦点：两者中点向场地中心收敛 30%
        this.desiredFocus.copy(center).multiplyScalar(0.7);
        this.desiredFocus.y = Math.max(0.2, center.y * 0.6 + 0.2);
        // 环绕：缓慢自转 + 朝合速度方向偏转，让陀螺“迎面而来”
        const speed = Math.hypot(vel.x, vel.z);
        let pull = 0;
        if (speed > 0.5) {
          const velAngle = Math.atan2(vel.z, vel.x) + Math.PI; // 站在运动方向的反侧
          pull = wrap(velAngle - this.orbit) * Math.min(1, speed / 6) * 0.35;
        }
        this.orbitVel += (0.1 + pull - this.orbitVel) * (1 - Math.exp(-dt * 1.5));
        this.orbit += this.orbitVel * dt;
        const dist = THREE.MathUtils.clamp(4.2 + spread * 0.85, 5, 10.5) * portrait;
        const height = dist * 0.48;
        this.desiredPos.set(
          this.desiredFocus.x + Math.cos(this.orbit) * dist,
          this.desiredFocus.y + height,
          this.desiredFocus.z + Math.sin(this.orbit) * dist,
        );
      } else {
        // 结算：环绕特写
        this.orbit += dt * 0.35;
        this.desiredFocus.copy(center);
        this.desiredFocus.y += 0.2;
        const dist = 3.4 * portrait;
        this.desiredPos.set(
          center.x + Math.cos(this.orbit) * dist,
          center.y + 1.6,
          center.z + Math.sin(this.orbit) * dist,
        );
      }
    }

    const kPos = snap ? 1 : 1 - Math.exp(-dt * (this.mode === 'battle' ? 3.2 : 2.2));
    const kFocus = snap ? 1 : 1 - Math.exp(-dt * 5);
    this.camera.position.lerp(this.desiredPos, kPos);
    this.focus.lerp(this.desiredFocus, kFocus);

    // 震动
    this.shake = Math.max(0, this.shake - dt * 2.8);
    this.fovKick = Math.max(0, this.fovKick - dt * 2.2);
    const s = this.shake * this.shake * 0.18;
    const shakeOffset = new THREE.Vector3(
      Math.sin(this.time * 71) * s,
      Math.sin(this.time * 53 + 1) * s,
      Math.sin(this.time * 61 + 2) * s,
    );
    this.camera.lookAt(this.focus.clone().add(shakeOffset));
    const fov = this.baseFov - this.fovKick * 7;
    if (Math.abs(this.camera.fov - fov) > 0.01) {
      this.camera.fov = fov;
      this.camera.updateProjectionMatrix();
    }
  }
}

function wrap(a: number): number {
  let x = a;
  while (x > Math.PI) x -= Math.PI * 2;
  while (x < -Math.PI) x += Math.PI * 2;
  return x;
}
