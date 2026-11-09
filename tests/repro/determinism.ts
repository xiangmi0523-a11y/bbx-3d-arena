/**
 * 测试侧的随机源控制与非确定来源探测（只在测试进程里替换全局函数，正式游戏不受影响）。
 *
 * 物理与战斗链路里的随机源（2026-11-09 盘点，src/ 中 Math.random 的全部非表现层调用）：
 *  - BeyPhysics 构造：进动初相 `Math.random() * 2π`
 *  - BeyPhysics 构造：战术意图种子（launch.seed 缺省时 `Math.random() * 2^32`）
 *  - launcher/launch.ts `rivalCommand(rand = Math.random)`：对手发射力度与方向
 * MotionIntent 之后只用自己的确定性随机流；表现层（ImpactFX / AudioFX / GarageView）不在无头模拟中实例化。
 *
 * withDeterminism 在一段同步代码里：
 *  1. 用 mulberry32(seed) 替换 Math.random，并统计调用次数；
 *  2. 包装 performance.now / Date.now / crypto.getRandomValues / crypto.randomUUID，统计调用次数。
 *     物理链路若读取了这些时间或系统随机源，结果就不再只由种子决定，测试会断言计数为 0。
 * 结束后全部恢复原函数。
 */

export interface DeterminismReport {
  /** 被种子控制的 Math.random 调用次数 */
  seededRandomCalls: number;
  /** 游戏代码（Rapier 求解之外）绕过种子的时间 / 系统随机源调用次数（应为 0） */
  bypass: { performanceNow: number; dateNow: number; cryptoRandom: number };
  /**
   * Rapier WASM 在 world.step 内部读取 performance.now 的次数（它的性能计数器 Timer）。
   * 这些读数只进入 Rapier 的耗时统计，不参与求解；记录下来作为已知的“读取了时间、但不影响结果”的来源。
   */
  engineTimerReads: number;
  /** 由调用方置位：当前处于 Rapier world.step 内部 */
  inEngine?: boolean;
}

/** mulberry32：与 tests/motion/motionSim.ts 的 seeded() 相同算法，保证与 Stage A 的 180 场种子流逐位一致 */
export function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 字符串 → 32 位种子（FNV-1a），用于从场景参数派生默认种子 */
export function seedFromString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/**
 * 测试用的附加种子扰动：REPRO_SEED_SALT=n 时把所有派生种子与 n 混合，
 * 用来检查一个断言在其他种子下是否仍然成立（统计稳健性抽查），不改变默认结果。
 */
export function seedSalt(): number {
  const g = globalThis as { process?: { env?: Record<string, string | undefined> } };
  const v = g.process?.env?.REPRO_SEED_SALT;
  return v ? Number(v) >>> 0 : 0;
}

/**
 * 无显式种子时的默认种子：由发射参数、部件和时长派生（与调用顺序、测试执行顺序无关），再混入 REPRO_SEED_SALT。
 * 规则在看到任何测试结果之前确定，不按“能通过”挑选种子。
 */
export function defaultSeed(o: { player: unknown; rival: unknown; playerLoadout?: unknown; rivalLoadout?: unknown; maxSeconds?: number }): number {
  const key = JSON.stringify([o.player, o.rival, o.playerLoadout ?? null, o.rivalLoadout ?? null, o.maxSeconds ?? null]);
  return (seedFromString(key) ^ seedSalt()) >>> 0;
}

export function withDeterminism<T>(seed: number, fn: (live: DeterminismReport) => T): { value: T; report: DeterminismReport } {
  const report: DeterminismReport = { seededRandomCalls: 0, bypass: { performanceNow: 0, dateNow: 0, cryptoRandom: 0 }, engineTimerReads: 0 };
  const rnd = mulberry32(seed);
  const origRandom = Math.random;
  const perf = globalThis.performance;
  const origPerfNow = perf?.now;
  const origDateNow = Date.now;
  const cr = globalThis.crypto as Crypto | undefined;
  const origGRV = cr?.getRandomValues;
  const origUUID = cr?.randomUUID;
  Math.random = () => {
    report.seededRandomCalls++;
    return rnd();
  };
  if (perf && origPerfNow) {
    perf.now = () => {
      if (report.inEngine) report.engineTimerReads++;
      else report.bypass.performanceNow++;
      return origPerfNow.call(perf);
    };
  }
  Date.now = () => {
    report.bypass.dateNow++;
    return origDateNow();
  };
  if (cr && origGRV) {
    cr.getRandomValues = (<A extends ArrayBufferView | null>(a: A): A => {
      report.bypass.cryptoRandom++;
      return origGRV.call(cr, a as never) as A;
    }) as Crypto['getRandomValues'];
  }
  if (cr && origUUID) {
    cr.randomUUID = (() => {
      report.bypass.cryptoRandom++;
      return origUUID.call(cr);
    }) as Crypto['randomUUID'];
  }
  try {
    return { value: fn(report), report };
  } finally {
    Math.random = origRandom;
    if (perf && origPerfNow) perf.now = origPerfNow;
    Date.now = origDateNow;
    if (cr && origGRV) cr.getRandomValues = origGRV;
    if (cr && origUUID) cr.randomUUID = origUUID;
  }
}
