/**
 * 针尖僵持自适应滚动阻力 V1：固定种子对照（180 场）。
 *   AR_SCALE=1     STALL_ROLL.scale = 1（与 Stage A 逐步相同的对照组）
 *   AR_SCALE=0.5   正式值（默认）
 *   AR_OUT=文件     默认 test-results/adaptive-roll/scale<值>.json
 *
 * 每场记录逐步状态 hash；每台每步核对实际施加的滚动阻力冲量与公式
 * dv = min(速度, (rollBase + rollFriction·摩擦)·倍率·g·dt) 相符，倍率在非确认僵持 / 低转速比例时必须为 1。
 * 针尖对针尖场次另记运动指标（确认僵持起点后 10 s 窗口等）。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { test } from 'vitest';
import { STALL_ROLL } from '../../src/game/battle/stallRoll';
import { BEY_TUNING, type BeyPhysics } from '../../src/game/beys/BeyPhysics';
import { GRAVITY, loadRapier, PHYSICS_DT } from '../../src/game/physics/PhysicsWorld';
import { seeded } from '../motion/motionSim';
import { fingerprint, scenariosV2, setup } from './stallprobe2.shared';

const HZ = Math.round(1 / PHYSICS_DT);
type V = { x: number; y: number; z: number };

test('adaptive roll resistance fixed-seed comparison', async () => {
  const R = await loadRapier();
  const scale = Number(process.env.AR_SCALE ?? STALL_ROLL.scale);
  const out = process.env.AR_OUT ?? `test-results/adaptive-roll/scale${scale}.json`;
  mkdirSync(dirname(out), { recursive: true });
  const saved = STALL_ROLL.scale;
  STALL_ROLL.scale = scale;
  const runs: unknown[] = [];
  try {
    for (const sc of scenariosV2()) {
      const orig = Math.random;
      Math.random = seeded(sc.seed);
      try {
        const { pw, b, A, B } = setup(R, sc);
        const beys = [A, B];
        const nn = beys.every((x) => x.spec.tip.gearGrip < BEY_TUNING.driveMinGrip);
        const chk = { rollChecked: 0, rollMismatch: 0, scaledWhileNotConfirmed: 0, scaledWhileLowSpin: 0, scaledSteps: 0 };
        // 包住 preStep 与 applyImpulse：只记录，原样转发
        beys.forEach((x: BeyPhysics) => {
          const calls: { j: V; v: V }[] = [];
          let inPre = false;
          const body = x.body;
          const ai = body.applyImpulse.bind(body);
          (body as unknown as { applyImpulse: typeof body.applyImpulse }).applyImpulse = (j, w) => {
            if (inPre) calls.push({ j: { ...(j as V) }, v: { ...body.linvel() } });
            ai(j, w);
          };
          const pre = x.preStep.bind(x);
          x.preStep = (dt: number) => {
            calls.length = 0;
            inPre = true;
            const confirmed = b.stallRoll.confirmed;
            const sr = x.spinRatio;
            const rs = x.rollScale;
            try {
              pre(dt);
            } finally {
              inPre = false;
            }
            if (rs !== 1) {
              chk.scaledSteps++;
              if (!confirmed) chk.scaledWhileNotConfirmed++;
              if (sr < STALL_ROLL.spinRatio) chk.scaledWhileLowSpin++;
            }
            // 最后一笔水平冲量若是滚动阻力，核对大小与倍率
            const c = calls[calls.length - 1];
            if (!c || c.j.y !== 0) return;
            const sp = Math.hypot(c.v.x, c.v.z);
            if (sp <= 1e-3) return;
            const m = body.mass();
            const jm = Math.hypot(c.j.x, c.j.z);
            const along = -(c.j.x * c.v.x + c.j.z * c.v.z) / (sp * jm || 1);
            if (along < 1 - 1e-9) return; // 不是与速度反向的冲量（牵引 / 冲刺）
            let k = BEY_TUNING.rollBase + BEY_TUNING.rollFriction * x.spec.tip.friction;
            const want = confirmed ? STALL_ROLL.scale : 1;
            if (want !== 1) k *= want;
            const dv = Math.min(sp, k * -GRAVITY * dt);
            chk.rollChecked++;
            if (Math.abs(jm - dv * m) > 1e-9 * m) chk.rollMismatch++;
          };
        });
        const h = createHash('sha256');
        const max = (sc.maxSeconds ?? 60) / PHYSICS_DT;
        const N = max;
        const tr = nn
          ? { px: [new Float64Array(N), new Float64Array(N)], pz: [new Float64Array(N), new Float64Array(N)], sp: [new Float64Array(N), new Float64Array(N)], spin: [new Float64Array(N), new Float64Array(N)], tilt: [new Float64Array(N), new Float64Array(N)], ratio: [new Float64Array(N), new Float64Array(N)], brk: [new Float64Array(N), new Float64Array(N)], wob: new Float64Array(N), contact: new Uint8Array(N), conf: new Uint8Array(N), miss: new Int32Array(N) }
          : null;
        const segs: { start: number; end: number; exit: string }[] = [];
        let segStart = -1;
        let s = 0;
        for (; s < max && !b.result; s++) {
          pw.step();
          fingerprint(h, beys);
          if (!tr) continue;
          const g = b.stallRoll;
          tr.conf[s] = g.confirmed ? 1 : 0;
          const k = b.contactClass;
          tr.contact[s] = k.geometric || k.impulseResponse ? 1 : 0;
          tr.miss[s] = g.miss;
          beys.forEach((x, i) => {
            const p = x.body.translation();
            const v = x.body.linvel();
            tr.px[i][s] = p.x;
            tr.pz[i][s] = p.z;
            tr.sp[i][s] = Math.hypot(v.x, v.z);
            tr.spin[i][s] = x.spin;
            tr.tilt[i][s] = x.tilt;
            tr.ratio[i][s] = x.spinRatio;
            tr.brk[i][s] = x.breakout;
          });
          tr.wob[s] = b.wobbleFor;
          if (g.confirmed && segStart < 0) segStart = s;
          if (!g.confirmed && segStart >= 0) {
            // 退出原因：本步 preStep 用的是上一步结束时的状态（门控同式复核）
            const p = s - 1;
            const why: string[] = [];
            if (g.miss <= STALL_ROLL.miss) why.push('contact');
            for (const i of [0, 1]) {
              if (tr.sp[i][p] >= STALL_ROLL.speed) why.push('speed');
              if (tr.ratio[i][p] < STALL_ROLL.spinRatio) why.push('spinRatio');
              if (tr.brk[i][p] > 0) why.push('breakout');
            }
            if (tr.wob[p] !== 0) why.push('wobble');
            segs.push({ start: segStart, end: s, exit: [...new Set(why)].join('+') || 'other' });
            segStart = -1;
          }
        }
        if (segStart >= 0) segs.push({ start: segStart, end: s, exit: b.result ? 'matchEnd' : 'timeout' });
        let motion: unknown;
        if (tr && segs.length) {
          const n = s;
          const s0 = segs[0].start;
          const s1 = Math.min(n, s0 + 10 * HZ);
          const per = [0, 1].map((i) => {
            let path = 0;
            let low = 0;
            let maxSp = 0;
            for (let k = s0; k < s1; k++) {
              if (k > s0) path += Math.hypot(tr.px[i][k] - tr.px[i][k - 1], tr.pz[i][k] - tr.pz[i][k - 1]);
              maxSp = Math.max(maxSp, tr.sp[i][k]);
            }
            for (let k = s0; k < s1; k++) if (tr.miss[k] > 6 && tr.sp[0][k] < 0.4 && tr.sp[1][k] < 0.4 && tr.spin[0][k] > 10 && tr.spin[1][k] > 10) low++;
            const net = Math.hypot(tr.px[i][s1 - 1] - tr.px[i][s0], tr.pz[i][s1 - 1] - tr.pz[i][s0]);
            // 前 10 s 转速线性斜率
            let mt = 0;
            let my = 0;
            for (let k = s0; k < s1; k++) {
              mt += k;
              my += tr.spin[i][k];
            }
            mt /= s1 - s0;
            my /= s1 - s0;
            let a = 0;
            let c = 0;
            for (let k = s0; k < s1; k++) {
              a += (k - mt) * (tr.spin[i][k] - my);
              c += (k - mt) ** 2;
            }
            return { net, path, straight: path > 1e-9 ? net / path : 0, lowShare: low / (s1 - s0), maxSpeed: maxSp, spinSlope: c > 0 ? (a / c) * HZ : 0, spinLoss: (tr.spin[i][s0] - tr.spin[i][s1 - 1]) / tr.spin[i][s0] };
          });
          // 起点之后全场
          let lowAll = 0;
          let recontact = -1;
          let maxTilt = 0;
          let wallAccel = 0;
          let maxWallSpeed = 0;
          let maxJump = 0;
          for (let k = s0; k < n; k++) {
            if (tr.miss[k] > 6 && tr.sp[0][k] < 0.4 && tr.sp[1][k] < 0.4 && tr.spin[0][k] > 10 && tr.spin[1][k] > 10) lowAll++;
            if (recontact < 0 && k > s0 && tr.contact[k]) recontact = (k - s0) / HZ;
            for (const i of [0, 1]) {
              maxTilt = Math.max(maxTilt, tr.tilt[i][k]);
              const r = Math.hypot(tr.px[i][k], tr.pz[i][k]);
              if (r >= 4.32) {
                maxWallSpeed = Math.max(maxWallSpeed, tr.sp[i][k]);
                if (tr.sp[i][k] > 2 && tr.miss[k] > 120) wallAccel++;
              }
              if (k > s0 && !tr.contact[k] && tr.miss[k] > 2) maxJump = Math.max(maxJump, Math.abs(tr.sp[i][k] - tr.sp[i][k - 1]));
            }
          }
          motion = { s0, per, lowShareAfter: lowAll / Math.max(1, n - s0), recontact, maxTiltAfter: maxTilt, wallAccelSteps: wallAccel, maxWallSpeedAfter: maxWallSpeed, maxSpeedJumpNoContact: maxJump, dist0: Math.hypot(tr.px[1][s0] - tr.px[0][s0], tr.pz[1][s0] - tr.pz[0][s0]) };
        }
        runs.push({
          name: sc.name,
          group: sc.group,
          nn,
          hash: h.digest('hex'),
          steps: s,
          duration: s / HZ,
          result: b.result ? `${b.result.winner}:${b.result.finish}` : 'timeout',
          gate: { entries: b.stallRoll.entries, confirmedSteps: b.stallRoll.confirmedSteps },
          segments: segs,
          ...chk,
          breakouts: b.breakouts,
          wobbleBreaks: b.wobbleBreaks,
          hits: b.hits,
          motion,
        });
        pw.dispose();
      } finally {
        Math.random = orig;
      }
    }
  } finally {
    STALL_ROLL.scale = saved;
  }
  writeFileSync(out, JSON.stringify({ scale, runs }, null, 1));
}, 3_600_000);
