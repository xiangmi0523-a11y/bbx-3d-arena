/**
 * physics.test「三种类型的差异」用例本身不固定随机数（进动初相用 Math.random），结果每次不同。
 * 这里用 16 组固定种子重复该用例的三条断言，统计通过率（不改原用例）。TF_OUT 输出。
 */
import { writeFileSync } from 'node:fs';
import { test } from 'vitest';
import { seeded } from '../motion/motionSim';
import { INTENT_TUNING } from '../../src/game/beys/motionIntent';
import { BEY_TUNING } from '../../src/game/beys/BeyPhysics';
if (process.env.DIAG_INTENT) Object.assign(INTENT_TUNING, JSON.parse(process.env.DIAG_INTENT));
if (process.env.DIAG_TUNE) Object.assign(BEY_TUNING, JSON.parse(process.env.DIAG_TUNE));
test('type flaky', async () => {
  const { diagnoseBattle } = await import('./harness');
  const ATK = { blade: 'blaze-fang', ratchet: 'tri-lock', bit: 'rush-rubber' };
  const DEF = { blade: 'tidal-bastion', ratchet: 'ring-guard', bit: 'dome-ball' };
  const STA = { blade: 'titan-crown', ratchet: 'hex-lock', bit: 'needle-point' };
  const avg = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const lines: string[] = [];
  let pass = 0;
  const N = Number(process.env.TF_N ?? 16);
  for (let s = 1; s <= N; s++) {
    const orig = Math.random;
    Math.random = seeded(7000 + s);
    const runs = async (a: typeof ATK, b: typeof ATK) => {
      const out = [];
      for (let i = 0; i < 4; i++) {
        const aim = ((i % 2) * 2 - 1) * 0.2;
        out.push(await diagnoseBattle({ player: { power: 0.85, aim, tilt: 0 }, rival: { power: 0.85, aim: -aim, tilt: 0 }, playerLoadout: a, rivalLoadout: b, maxSeconds: 40, seed: null }));
      }
      return out;
    };
    const ad = await runs(ATK, DEF);
    const as = process.env.TF_DEFONLY ? ad : await runs(ATK, STA);
    Math.random = orig;
    const mA = avg(ad.map((r) => r.meanR.player));
    const mD = avg(ad.map((r) => r.meanR.rival));
    const eff = (ad.reduce((t, r) => t + r.episodes.filter((e) => e.tier === 'medium' || e.tier === 'heavy').length, 0) / ad.reduce((t, r) => t + r.duration, 0)) * 10;
    const half = avg(as.map((r) => r.spinHalf.rival)) / avg(as.map((r) => r.spinHalf.player));
    const ok = mA > mD * 0.95 && mD < 1.4 && eff > 0.6 && half > 1.3;
    if (ok) pass++;
    lines.push(`seed ${7000 + s} mR atk ${mA.toFixed(2)} def ${mD.toFixed(2)} eff ${eff.toFixed(2)} halfRatio ${half.toFixed(2)} ${ok ? 'PASS' : 'FAIL'}`);
  }
  lines.push(`PASS ${pass}/${N}`);
  writeFileSync(process.env.TF_OUT ?? '/tmp/claude-0/tf.txt', lines.join('\n'));
}, 1200000);
