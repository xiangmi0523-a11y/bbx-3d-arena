import { mkdirSync, writeFileSync } from 'node:fs';
import { test } from 'vitest';
import { PLAYER_LOADOUT, RIVAL_LOADOUT } from '../../src/game/beys/parts/catalog';
import { feelRun } from '../feelSim';
import { simulateBattle } from '../sim';
import { Fingerprint } from '../helpers/hash';

/**
 * 物理轨迹指纹：固定种子跑完整对战，把每步的位置 / 转速 / 撞击结果做 FNV-1a 64 位指纹。
 * 在基线提交和当前分支各跑一次，指纹相同 = 物理完全没变（新接触反馈只读）。
 *   npx vitest run --config vitest.diag.config.ts tests/diag/determinism.diag.ts
 */
test('trajectory fingerprint', async () => {
  const out: Record<string, string> = {};
  const orig = Math.random;
  for (let seed = 1; seed <= 6; seed++) {
    let s = seed * 7919;
    Math.random = () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
    const h = new Fingerprint();
    const r = await simulateBattle({
      player: { power: 0.6 + seed * 0.06, aim: (seed % 3 - 1) * 0.3, tilt: 0 },
      rival: { power: 0.8, aim: 0, tilt: 0 },
      maxSeconds: 60,
      every: 1,
      trace: (t, b) => {
        for (const x of [b.beys.player!, b.beys.rival!]) {
          const p = x.body.translation();
          const v = x.body.linvel();
          h.update(`${p.x},${p.y},${p.z},${v.x},${v.z},${x.spin};`);
        }
        h.update(`${b.hits},${b.grinds},${b.breakouts}|`);
      },
    });
    Math.random = orig;
    out[`seed${seed}`] = `${h.digest()} steps=${r.steps} hits=${r.battle.hits} result=${r.battle.result?.winner}:${r.battle.result?.finish}:${r.battle.result?.duration.toFixed(4)}`;
    r.dispose();
  }
  const f = await feelRun({ player: PLAYER_LOADOUT, rival: RIVAL_LOADOUT }, 1000);
  out.feel1000 = JSON.stringify(f);
  mkdirSync('test-results/diag', { recursive: true });
  writeFileSync(`test-results/diag/fingerprint-${process.env.DIAG_LABEL ?? 'now'}.json`, JSON.stringify(out, null, 1));
});
