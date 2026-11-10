import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { test } from 'vitest';
import { recordReplay } from '../motion/recorder';
import { DEF_PLAYER, groups } from '../motion/scenarios';

/**
 * 接触 / 撞墙逐事件明细（固定种子矩阵，两个版本同一命令）：每次接触开始时的切入角分解、
 * 前后状态、接触期间连心线转角、每次撞墙前的状态序列。不录逐帧画面，只留事件。
 *   CM_VERSION=new CM_OUT=test-results/motion/cm-new.json CM_ONLY=AvD,BvB npx vitest run --config vitest.diag.config.ts tests/diag/contactmix.diag.ts
 * 新版本可用 DIAG_INTENT='{"cutCancel":0}' 做消融（只在诊断进程里改参数，不改代码）。
 */
test('contact mix', async () => {
  if (process.env.DIAG_INTENT || process.env.DIAG_TUNE) {
    const mi = await import('../../src/game/beys/motionIntent').catch(() => null);
    const bp = await import('../../src/game/beys/BeyPhysics');
    if (process.env.DIAG_INTENT && mi) Object.assign(mi.INTENT_TUNING, JSON.parse(process.env.DIAG_INTENT));
    if (process.env.DIAG_TUNE) Object.assign(bp.BEY_TUNING, JSON.parse(process.env.DIAG_TUNE));
  }
  // 消融（只在诊断进程里打补丁）：开局不再先“游走 0.5 秒、且间距 > 4 m 不选切入”，第一帧就按正常规则决策
  if (process.env.DIAG_OPENING) {
    const mi = await import('../../src/game/beys/motionIntent');
    type Hack = { hold: number; __opened?: boolean };
    const P = mi.MotionIntent.prototype as unknown as Record<string, (this: Hack, ...a: unknown[]) => unknown>;
    const up = P.update;
    const dec = P.decide;
    P.decide = function (inp, gap) {
      return dec.call(this, inp, this.__opened ? gap : Math.min(gap as number, 3.9));
    };
    P.update = function (inp) {
      if (!this.__opened) this.hold = 0;
      const r = up.call(this, inp);
      this.__opened = true;
      return r;
    };
  }
  const version = process.env.CM_VERSION ?? 'now';
  const out = process.env.CM_OUT ?? `test-results/motion/cm-${version}.json`;
  const only = process.env.CM_ONLY?.split(',') ?? null;
  const res: Record<string, unknown[]> = {};
  // WALLX：撞墙对阵（与 WALL 组同一配置和发射规律）扩到 60 场，种子 1100–1159，样本更大
  const gs = [
    ...groups(),
    {
      key: 'WALLX',
      scenarios: Array.from({ length: 60 }, (_, i) => {
        const aim = ((i % 3) - 1) * 0.3;
        return { name: `WALLX#${i}`, player: DEF_PLAYER, rival: { blade: 'gale-crescent', ratchet: 'tri-lock', bit: 'rush-rubber' }, pCmd: { power: 0.7 + (i % 3) * 0.15, aim, tilt: 0 }, rCmd: { power: 0.8, aim: -aim, tilt: 0 }, seed: 1100 + i, maxSeconds: 40 };
      }),
    },
  ];
  for (const g of gs) {
    if (only && !only.includes(g.key)) continue;
    res[g.key] = [];
    for (const sc of g.scenarios) {
      const r = await recordReplay(sc, version);
      // 死亡阶段：输家转速比例首次 < 20% 到对局结束，接触帧占比
      const loser = r.result.startsWith('player') ? 1 : r.result.startsWith('rival') ? 0 : -1;
      let death = NaN;
      if (loser >= 0) {
        const o = 3 + loser * 13 + 7;
        const i0 = r.frames.findIndex((f) => f[o] < 0.2);
        if (i0 >= 0) {
          const tail = r.frames.slice(i0);
          death = tail.filter((f) => f[2]).length / tail.length;
        }
      }
      res[g.key].push({ name: sc.name, result: r.result, duration: r.duration, hits: r.hits, strong: r.strong, contacts: r.contacts, walls: r.walls, impacts: r.impacts, death });
    }
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(res));
}, 1_800_000);
