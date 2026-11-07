/**
 * 把录好的回放数据注入单文件回放页，得到可离线打开的 HTML。
 *   npx vite build --config tools/vite.replay.config.ts && node scripts/replay-bundle.mjs <out.html>
 */
import { readFileSync, writeFileSync } from 'node:fs';
const dir = 'test-results/replays';
const keys = JSON.parse(readFileSync(`${dir}/index.json`, 'utf8'));
const data = {};
for (const k of keys) data[k] = { base: JSON.parse(readFileSync(`${dir}/${k}.base.json`, 'utf8')), new: JSON.parse(readFileSync(`${dir}/${k}.new.json`, 'utf8')) };
const html = readFileSync('test-results/replay-build/replay.html', 'utf8');
const inject = `<script>window.__REPLAY_INDEX=${JSON.stringify(keys)};window.__REPLAYS=${JSON.stringify(data)};</script>`;
const out = html.replace('<head>', `<head>${inject}`);
writeFileSync(process.argv[2] ?? 'test-results/replay-offline.html', out);
console.log('written', (out.length / 1e6).toFixed(1), 'MB');
