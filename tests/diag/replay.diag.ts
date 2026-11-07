import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'vitest';
import { recordReplay } from '../motion/recorder';
import { groups } from '../motion/scenarios';

/**
 * 录制回放（无头真实物理，固定种子）。不依赖新版本独有的模块，可原样拷到基线工作树运行。
 *   REPLAY_VERSION=new REPLAY_OUT=public-replays REPLAY_ONLY='AvD#1,BvB#2' npx vitest run --config vitest.diag.config.ts tests/diag/replay.diag.ts
 * 每场输出 <out>/<场景名>.<version>.json
 */
test('record replays', async () => {
  // DIAG_TUNE：只在诊断进程里覆盖 BEY_TUNING（第三轮 A 配置用 {"stallBreak":1}）
  if (process.env.DIAG_TUNE) Object.assign((await import('../../src/game/beys/BeyPhysics')).BEY_TUNING, JSON.parse(process.env.DIAG_TUNE));
  const version = process.env.REPLAY_VERSION ?? 'now';
  const out = process.env.REPLAY_OUT ?? 'test-results/replays';
  const only = (process.env.REPLAY_ONLY ?? '').split(',').filter(Boolean);
  const all = groups().flatMap((g) => g.scenarios);
  mkdirSync(out, { recursive: true });
  const summary: Record<string, unknown> = {};
  for (const name of only) {
    const sc = all.find((s) => s.name === name);
    if (!sc) throw new Error(`no scenario ${name}`);
    const rep = await recordReplay(sc, version);
    writeFileSync(join(out, `${name.replace(/[^\w.#-]+/g, '_').replace('#', '_')}.${version}.json`), JSON.stringify(rep));
    summary[name] = { result: rep.result, duration: rep.duration, hits: rep.hits, contacts: rep.contacts.length, walls: rep.walls.length };
  }
  writeFileSync(join(out, `_summary.${version}.json`), JSON.stringify(summary, null, 1));
}, 600_000);
