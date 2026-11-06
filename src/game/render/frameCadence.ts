/**
 * 帧节奏（刷新基准）估算与帧交付质量统计。
 *
 * ── 为什么不能只看 FPS ──
 * 浏览器只给我们 requestAnimationFrame 的回调时间戳。回调节奏由系统决定：
 * 60Hz 屏是 16.67 ms；iPhone 在发热/省电等情况下会把节奏切到 48Hz（20.83 ms）；
 * 120Hz 屏经过主循环的 60 FPS 上限（间隔 < 1000/60−3 ms 的回调直接跳过）后是 16.67 ms；
 * 90Hz → 22.2 ms（45 次/秒）、144Hz → 13.9 ms（72 次/秒）、75Hz → 26.7 ms（37.5 次/秒）。
 * 用固定的 “< 50 fps 就降档” 会把稳定的 48Hz 当成性能不足。这里改为两步：
 *   1. 估算“当前系统给的正常帧间隔” B（刷新基准）；
 *   2. 按 B 统计“错过了多少次刷新机会”，持续漏帧才算性能问题。
 *
 * ── 刷新基准估算方法 ──
 * 最近 BASE_WINDOW 帧的间隔放进 0.5 ms 一格的直方图（定长环形缓冲 + 增量计数，每帧零分配、不排序）。
 *  - 候选 = 直方图中位数附近的簇：取 [0.84·中位数, 1.16·中位数] 内样本的精确平均值，再以它为中心重取一次，
 *    得到簇平均 C 和落在簇内的样本比例 S。iOS WKWebView 的 performance.now 精度只有 1 ms，
 *    真机 48Hz 段的间隔散布在 18–24 ms（P50 21 ms），这个簇宽能盖住约 94% 的样本；
 *    60Hz（16.67）与 48Hz（20.83）相差 25%，不会落进同一个簇。平均值能把抖动抵消掉，
 *    真机 48Hz 段每 10 秒恰好 479–481 帧，簇平均就是 20.8 ms 左右。
 *  - 只有“干净”的候选才可能成为基准：MIN_BASE_MS ≤ C ≤ MAX_BASE_MS，且满足其一：
 *      窄簇 S ≥ 75%；或宽簇（±24%）≥ 90% 且 ≥1.5·C 的晚到帧 ≤ 5%（抖动大但单峰）。
 *    容差：48Hz 下间隔标准差约 2.5 ms（真机实测约 1.3 ms）以内都能识别；再大就会退回旧基准，
 *    按旧基准算漏帧（偏保守，宁可降档）。
 *  - 不对称采纳：
 *      更快的候选：持续 ADOPT_FASTER_S 即采纳（系统不可能比真实刷新更快地给回调，出现更快的稳定节奏
 *        说明旧基准偏慢）。
 *      更慢的候选：必须持续 ADOPT_SLOWER_S，且不在“升档观察期”内（见 freezeSlower），才采纳。
 *      ±SAME_TOL 内视为同一节奏，只做微调，且微调幅度被锁在采纳时锚点的 ±3% 以内，防止一点点“爬升”。
 *
 * ── 防止把真实变慢当成新基准 ──
 *  - MAX_BASE_MS = 27 ms：小于任何 ≥72 次/秒节奏的两倍周期（60→33.3、72→27.8），
 *    所以“每帧都错过一次刷新”的半速节奏永远不会被当成正常基准；48Hz 漏帧的 41.7 ms 也一样。
 *    代价：系统真的给 30Hz（如 Safari 低电量模式）时会被当成持续漏帧而降到最低档（偏保守，可接受）。
 *  - 在固定刷新率屏上，GPU 跟不上时回调间隔是刷新周期的整数倍（16.7/33.3 混合），中位数簇不干净，不会被采纳。
 *  - 自动升档后有一段观察期冻结“变慢采纳”：升档后节奏变慢，一律算作这次升档造成的漏帧。
 *
 * ── 局限（无法仅凭时间戳解决）──
 *  - 在可变刷新率屏（ProMotion 等）上，如果 GPU 受限导致系统把整个节奏降到一个稳定的 40–60 次/秒，
 *    它和“系统主动选择 48Hz”在 rAF 时间戳上看起来完全一样，这里会把它当成正常基准。
 *    缓解手段只有：升档观察期（升档引发的变慢会被识别）+ 失败档位的重试冷却。
 *    Stage 0 真机数据里 48Hz 段的抖动（间隔标准差约 1.3 ms）明显大于 60Hz 段（约 0.5 ms），
 *    每 10 秒帧数却恰好 480 左右——既像系统 48Hz 时钟，也不能排除是 GPU/合成节流，时间戳本身无法定论。
 *  - 刚启动时没有历史，第一个干净候选直接作为基准；若一开局就处在 GPU 受限的稳定慢节奏，也无法区分。
 */

export const CADENCE = {
  /** 直方图格宽（ms） */
  BIN_MS: 0.5,
  /** 直方图格数：覆盖 0–64 ms，更长的帧计入最后一格 */
  BINS: 128,
  /** 基准估算窗口（帧）：约 1.5–2 秒 */
  BASE_WINDOW: 90,
  /** 至少这么多帧才开始估算 */
  MIN_FRAMES: 30,
  /** 没有可靠基准时的默认值：主循环上限 60 FPS */
  DEFAULT_BASE_MS: 1000 / 60,
  /** 主循环跳过 < 1000/60−3 ms 的回调，基准不可能更短 */
  MIN_BASE_MS: 1000 / 60 - 3,
  /** 能被当作“正常节奏”的最长间隔（≈37 次/秒），理由见文件头 */
  MAX_BASE_MS: 27,
  /** 簇范围（相对簇中心）：±16%。60 与 48 相差 25%，1 ms 取整后 48Hz 簇是 18–24 ms、60Hz 簇是 14–19 ms，互不重叠 */
  CLUSTER_LO: 0.84,
  CLUSTER_HI: 1.16,
  CLEAN_SHARE: 0.75,
  /** 宽簇（±24%）：抖动较大的单峰节奏的第二道判定 */
  WIDE_LO: 0.76,
  WIDE_HI: 1.24,
  WIDE_SHARE: 0.9,
  /** 宽簇判定时，≥1.5 个周期的晚到帧最多占 5% */
  MAX_LATE_SHARE: 0.05,
  /** 与锚点相差 ±6% 以内视为同一节奏 */
  SAME_TOL: 0.06,
  /** 同一节奏内的微调幅度上限（相对锚点） */
  REFINE_TOL: 0.03,
  ADOPT_FASTER_S: 0.25,
  ADOPT_SLOWER_S: 0.75,
} as const;

/**
 * 单帧“错过的刷新机会”数（连续值）：d/B − 1，限制在 [−0.5, 3]。
 * - 连续值而不是四舍五入：在可变刷新率屏上 GPU 受限可能表现为 25 ms（120Hz 的 3 格）而不是 33 ms，
 *   取整会把它当成 0 或 1；连续值让抖动在平均里互相抵消（短一点的帧抵掉长一点的帧）。
 * - 上限 3：单次卡顿（GC、着色器编译）最多只算 3 次漏帧，一次长帧不足以主导窗口，
 *   降画质也治不了这种一次性卡顿；持续漏帧才是画质能解决的问题。
 */
export function missedRefreshes(intervalMs: number, baseMs: number): number {
  const m = intervalMs / baseMs - 1;
  return m < -0.5 ? -0.5 : m > 3 ? 3 : m;
}

/** 刷新基准估算器（纯逻辑，无 DOM 依赖，可单测） */
export class FrameCadenceEstimator {
  /** 当前刷新基准（ms） */
  baseMs: number = CADENCE.DEFAULT_BASE_MS;
  /** 是否已从实际数据中采纳过基准 */
  hasBase = false;
  /** 基准被重新采纳的次数（诊断用） */
  adoptions = 0;
  private anchorMs: number = CADENCE.DEFAULT_BASE_MS;
  private readonly ring = new Float64Array(CADENCE.BASE_WINDOW);
  private readonly counts = new Uint16Array(CADENCE.BINS);
  private readonly sums = new Float64Array(CADENCE.BINS);
  private head = 0;
  private n = 0;
  private pendingFaster = 0;
  private pendingSlower = 0;
  private freezeSlowerS = 0;
  /** 诊断：最近一次候选 */
  lastCandidateMs = 0;
  lastCleanShare = 0;

  /** 在接下来 seconds 秒内不采纳更慢的基准（自动升档后的观察期） */
  freezeSlower(seconds: number): void {
    this.freezeSlowerS = Math.max(this.freezeSlowerS, seconds);
    this.pendingSlower = 0;
  }

  /** 结束观察期（升档已被撤回时调用） */
  unfreeze(): void {
    this.freezeSlowerS = 0;
  }

  get slowerFrozen(): boolean {
    return this.freezeSlowerS > 0;
  }

  /**
   * 推入一帧间隔（ms）。返回 true 表示基准发生了“采纳”级别的变化（换了节奏），
   * 调用方应据此重新评估漏帧窗口。微调不返回 true。
   */
  push(intervalMs: number): boolean {
    const dt = intervalMs / 1000;
    if (this.freezeSlowerS > 0) this.freezeSlowerS = Math.max(0, this.freezeSlowerS - dt);
    if (this.n === CADENCE.BASE_WINDOW) {
      const old = this.ring[this.head];
      const ob = binOf(old);
      this.counts[ob]--;
      this.sums[ob] -= old;
    } else this.n++;
    this.ring[this.head] = intervalMs;
    this.head = (this.head + 1) % CADENCE.BASE_WINDOW;
    const b = binOf(intervalMs);
    this.counts[b]++;
    this.sums[b] += intervalMs;
    if (this.n < CADENCE.MIN_FRAMES) return false;
    return this.evaluate(dt);
  }

  private evaluate(dt: number): boolean {
    // 中位数所在格
    const half = this.n / 2;
    let cum = 0;
    let mb = 0;
    for (; mb < CADENCE.BINS; mb++) {
      cum += this.counts[mb];
      if (cum >= half) break;
    }
    // 先以中位数为中心取簇，再以簇平均为中心重取一次（消除中位数落在格中心带来的偏差，
    // 并让簇对称地覆盖抖动的两侧）
    let c = (mb + 0.5) * CADENCE.BIN_MS;
    let share = 0;
    for (let pass = 0; pass < 2; pass++) {
      const lo = Math.max(0, Math.ceil((c * CADENCE.CLUSTER_LO) / CADENCE.BIN_MS));
      const hi = Math.min(CADENCE.BINS - 1, Math.floor((c * CADENCE.CLUSTER_HI) / CADENCE.BIN_MS));
      let cc = 0;
      let cs = 0;
      for (let i = lo; i <= hi; i++) {
        cc += this.counts[i];
        cs += this.sums[i];
      }
      share = cc / this.n;
      if (cc > 0) c = cs / cc;
    }
    // 宽簇（±24%）与“明显晚到”（≥1.5·C）比例：抖动大但仍是单峰的节奏也算干净；
    // 两种节奏混在一起（如 16.7/25 ms 交替）在宽簇里也凑不够 90%，不算。
    const wlo = Math.max(0, Math.ceil((c * CADENCE.WIDE_LO) / CADENCE.BIN_MS));
    const whi = Math.min(CADENCE.BINS - 1, Math.floor((c * CADENCE.WIDE_HI) / CADENCE.BIN_MS));
    const late = Math.min(CADENCE.BINS, Math.ceil((c * 1.5) / CADENCE.BIN_MS));
    let wc = 0;
    let ws = 0;
    let lc = 0;
    for (let i = wlo; i <= whi; i++) {
      wc += this.counts[i];
      ws += this.sums[i];
    }
    for (let i = late; i < CADENCE.BINS; i++) lc += this.counts[i];
    const wideShare = wc / this.n;
    const lateShare = lc / this.n;
    const narrowOk = share >= CADENCE.CLEAN_SHARE;
    const wideOk = wideShare >= CADENCE.WIDE_SHARE && lateShare <= CADENCE.MAX_LATE_SHARE;
    // 只靠宽簇通过时，用宽簇平均：抖动大时窄簇会被 1 ms 取整切得不对称，平均值偏高
    if (!narrowOk && wideOk && wc > 0) c = ws / wc;
    this.lastCandidateMs = c;
    this.lastCleanShare = narrowOk ? share : wideShare;
    const shaped = narrowOk || wideOk;
    const clean = shaped && c >= CADENCE.MIN_BASE_MS && c <= CADENCE.MAX_BASE_MS;
    if (!clean) {
      this.pendingFaster = this.pendingSlower = 0;
      return false;
    }
    if (!this.hasBase) return this.adopt(c);
    const rel = c / this.anchorMs;
    if (Math.abs(rel - 1) <= CADENCE.SAME_TOL) {
      const a = this.anchorMs;
      this.baseMs = Math.min(a * (1 + CADENCE.REFINE_TOL), Math.max(a * (1 - CADENCE.REFINE_TOL), c));
      this.pendingFaster = this.pendingSlower = 0;
      return false;
    }
    if (rel < 1) {
      this.pendingSlower = 0;
      this.pendingFaster += dt;
      if (this.pendingFaster >= CADENCE.ADOPT_FASTER_S) return this.adopt(c);
      return false;
    }
    this.pendingFaster = 0;
    if (this.freezeSlowerS > 0) {
      this.pendingSlower = 0;
      return false;
    }
    this.pendingSlower += dt;
    if (this.pendingSlower >= CADENCE.ADOPT_SLOWER_S) return this.adopt(c);
    return false;
  }

  private adopt(c: number): boolean {
    this.baseMs = this.anchorMs = c;
    this.hasBase = true;
    this.adoptions++;
    this.pendingFaster = this.pendingSlower = 0;
    return true;
  }
}

function binOf(ms: number): number {
  const b = Math.floor(ms / CADENCE.BIN_MS);
  return b < 0 ? 0 : b >= CADENCE.BINS ? CADENCE.BINS - 1 : b;
}

/**
 * 滚动漏帧窗口：最近 size 帧里“错过的刷新机会 / 总刷新机会”。
 * 保存原始间隔，基准换了之后可以按新基准整体重算（O(size)，只在采纳时发生）。
 */
export class DeliveryWindow {
  private readonly raw: Float64Array;
  /** 每帧入窗时记下的贡献值，出窗时原样减掉（基准微调不会造成累计漂移） */
  private readonly contrib: Float64Array;
  private head = 0;
  n = 0;
  private missed = 0;

  constructor(readonly size = 60) {
    this.raw = new Float64Array(size);
    this.contrib = new Float64Array(size);
  }

  push(intervalMs: number, baseMs: number): void {
    if (this.n === this.size) this.missed -= this.contrib[this.head];
    else this.n++;
    const m = missedRefreshes(intervalMs, baseMs);
    this.raw[this.head] = intervalMs;
    this.contrib[this.head] = m;
    this.head = (this.head + 1) % this.size;
    this.missed += m;
  }

  /** 基准变化后按新基准重算 */
  rebase(baseMs: number): void {
    let m = 0;
    for (let i = 0; i < this.n; i++) m += this.contrib[i] = missedRefreshes(this.raw[i], baseMs);
    this.missed = m;
  }

  clear(): void {
    this.n = 0;
    this.head = 0;
    this.missed = 0;
  }

  /** 漏帧率 = 错过的机会 / (交付帧数 + 错过的机会)，≤ 0 时记为 0 */
  get missRatio(): number {
    if (this.n === 0) return 0;
    const m = this.missed;
    return m <= 0 ? 0 : m / (this.n + m);
  }
}
