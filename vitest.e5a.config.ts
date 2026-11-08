import { readFileSync } from 'node:fs';
import { defineConfig, type Plugin } from 'vitest/config';

/**
 * E5-A 独立诊断构建（不改 src/ 文件）：测试运行时在 BeyPhysics.preStep 自然进动转速算完、
 * 原 steering 调制块之后、launch 分支之前插入一个只读钩子调用：
 *   const __h = globalThis.__E5A_RATE; if (__h) rate = __h(this, rate, mag, steering);
 * 钩子不存在时这行不改变任何值；钩子返回原 rate 时（b = 0 或门控关闭）浮点结果逐位相同。
 * 锚点必须在源码中恰好出现一次，否则构建失败（防止源码变动后钩子插错位置）。
 *
 *   npx vitest run --config vitest.e5a.config.ts
 */
export const E5A_ANCHOR = "      if (this.intent.state === 'launch' && T.launchHold > 0) {";
export const E5A_HOOK = '      { const __h = (globalThis as any).__E5A_RATE; if (__h) rate = __h(this, rate, mag, steering); }\n';

function e5aHook(): Plugin {
  return {
    name: 'e5a-precession-hook',
    enforce: 'pre',
    transform(code, id) {
      if (!id.replace(/\\/g, '/').endsWith('/src/game/beys/BeyPhysics.ts')) return null;
      const n = code.split(E5A_ANCHOR).length - 1;
      if (n !== 1) throw new Error(`E5-A 钩子锚点出现 ${n} 次（应为 1）`);
      // 核对锚点前一段确实是自然进动 + 原 steering 调制（行号见报告）
      const before = code.slice(0, code.indexOf(E5A_ANCHOR));
      if (!/let rate = this\.spinSign \* -\(T\.precessBase \+ T\.precessSpin \/ Math\.max\(20, mag\)\);[\s\S]*rate \*= 1 - steering \* Math\.cos\(d\);\s*\}\s*$/.test(before))
        throw new Error('E5-A 钩子锚点之前不是自然进动 + steering 调制块');
      return { code: code.replace(E5A_ANCHOR, E5A_HOOK + E5A_ANCHOR), map: null };
    },
  };
}

// 构建期自检：源文件存在且锚点唯一
void readFileSync(new URL('./src/game/beys/BeyPhysics.ts', import.meta.url), 'utf8');

export default defineConfig({
  plugins: [e5aHook()],
  test: { environment: 'node', include: ['tests/diag/e5a.diag.ts'], testTimeout: 7_200_000 },
});
