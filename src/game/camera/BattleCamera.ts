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
  // 每帧复用的临时向量（避免每帧分配，减少 GC 抖动）
  private readonly basePos = new THREE.Vector3();
  private readonly _center = new THREE.Vector3();
  private readonly _vel = new THREE.Vector3();
  private readonly _look = new THREE.Vector3();
  /** 方向性冲击：沿撞击法线把镜头“推”一下，随后弹回 */
  private readonly punch = new THREE.Vector3();
  private readonly punchVel = new THREE.Vector3();
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
    this.basePos.set(0, 7, 10);
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
  /**
   * 撞击反馈。shake / fovKick 由撞击等级给出（见 impactTiers）：
   * 取最大值而不是累加，连续轻擦不会叠成剧烈晃动，强撞也不会被弱撞覆盖。
   */
  impact(shake: number, fovKick = shake * 0.8, dir?: { x: number; z: number }): void {
    this.shake = Math.min(1, Math.max(this.shake, shake));
    this.fovKick = Math.min(1, Math.max(this.fovKick, fovKick));
    if (dir && shake > 0.3) {
      // 沿撞击方向的冲击：只给中等以上，强度随震动量非线性增长
      const k = Math.pow(shake, 1.5) * 2.2;
      this.punchVel.x += dir.x * k;
      this.punchVel.y -= k * 0.35;
      this.punchVel.z += dir.z * k;
    }
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
      const center = this._center.set(0, 0, 0);
      const vel = this._vel.set(0, 0, 0);
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
    this.basePos.lerp(this.desiredPos, kPos);
    this.focus.lerp(this.desiredFocus, kFocus);

    // 震动
    this.shake = Math.max(0, this.shake - dt * 4);
    this.fovKick = Math.max(0, this.fovKick - dt * 3.5);
    // 幅度随力度非线性增长（轻擦几乎不动、猛撞明显），衰减快（≤0.25 秒），不影响观察和操作
    const s = Math.pow(this.shake, 1.6) * 0.16;
    // 方向冲击：阻尼弹簧，约 0.2 秒回到原位
    const pdt = Math.min(dt, 1 / 30);
    this.punchVel.addScaledVector(this.punch, -220 * pdt).multiplyScalar(Math.exp(-pdt * 16));
    this.punch.addScaledVector(this.punchVel, pdt);
    this.camera.position.copy(this.basePos).add(this.punch);
    this._look.set(
      this.focus.x + Math.sin(this.time * 71) * s + this.punch.x * 0.5,
      this.focus.y + Math.sin(this.time * 53 + 1) * s + this.punch.y * 0.5,
      this.focus.z + Math.sin(this.time * 61 + 2) * s + this.punch.z * 0.5,
    );
    this.camera.lookAt(this._look);
    // 冲击缩放：FOV 瞬间收紧再回弹
    const fov = this.baseFov - this.fovKick * 6;
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
