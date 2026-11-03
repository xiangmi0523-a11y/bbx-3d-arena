import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { test } from 'vitest';
import { BEY_TUNING } from '../../src/game/beys/BeyPhysics';
import { SMASH_TUNING } from '../../src/game/battle/BattleSystem';
if (process.env.DIAG_TUNE) Object.assign(BEY_TUNING, JSON.parse(process.env.DIAG_TUNE));
if (process.env.DIAG_SMASH) Object.assign(SMASH_TUNING, JSON.parse(process.env.DIAG_SMASH));

import { diagnoseBattle, summarize, type DiagResult } from './harness';

const OUT = process.env.DIAG_OUT ?? 'test-results/diag/collision.md';
const LABEL = process.env.DIAG_LABEL ?? 'current';

const MATCHUPS = [
  { name: '默认：攻击型 vs 防御型', player: undefined, rival: undefined },
  { name: '重攻：泰坦王冠 + 针尖 vs 防御型', player: { blade: 'titan-crown', disc: 'quad-edge', tip: 'needle-point' }, rival: undefined },
  { name: '同为攻击型', player: undefined, rival: { blade: 'gale-crescent', disc: 'tri-lock', tip: 'rush-rubber' } },
];

test('collision diagnostics', async () => {
  mkdirSync('test-results/diag', { recursive: true });
  const sections: string[] = [`## ${LABEL}`, ''];
  const all: DiagResult[] = [];
  for (const m of MATCHUPS) {
    const runs: DiagResult[] = [];
    for (let i = 0; i < Number(process.env.DIAG_N ?? 6); i++) {
      const aim = ((i % 3) - 1) * 0.3;
      runs.push(
        await diagnoseBattle({
          player: { power: 0.7 + (i % 3) * 0.15, aim, tilt: 0 },
          rival: { power: 0.8, aim: -aim, tilt: 0 },
          playerLoadout: m.player,
          rivalLoadout: m.rival,
          maxSeconds: 60,
        }),
      );
    }
    all.push(...runs);
    sections.push(summarize(m.name, runs), '');
  }
  sections.push(summarize('全部', all), '');
  appendFileSync(OUT, sections.join('\n') + '\n');
  writeFileSync(OUT.replace('.md', `-${LABEL}.json`), JSON.stringify(all.map((r) => ({ ...r, episodes: r.episodes.slice(0, 40) })), null, 1));
});
