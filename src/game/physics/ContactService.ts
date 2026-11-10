/**
 * ContactService：统一的、只读的接触观测层（阶段 1 第二项 A）。
 *
 * 只观察物理世界，不控制物理世界：只调用 Rapier 窄相位的只读查询（NarrowPhase.contactPairsWith / contactPair
 * 和 TempContactManifold 的读取方法），不修改刚体、碰撞体、材料、参数和步进顺序，不施加任何力或冲量。
 * 不读取墙上时钟和随机数；接触时长只按物理步数计算。
 *
 * ── 数据来源与时相（以 rapier3d-compat 0.19.3 = Rust rapier 0.30.1 源码为准）──
 * PhysicsPipeline::step 的顺序：先 detect_collisions（窄相位，用本步开始时、积分前的位姿生成接触流形与求解器接触点），
 * 再求解速度约束并把冲量写回流形接触点（writeback_impulses），最后积分位姿。max_ccd_substeps 默认 1，
 * 积分后不再重新做窄相位（只更新宽相位包围盒）。所以 world.step 之后读取到的：
 *  - 几何（接触点、法线、距离）= 本步求解前、积分前的位姿上的结果（geometryPhase = 'pre-solve'）；
 *  - 法向冲量 = 本步求解器的结果（impulsePhase = 'post-solve'），只对本步的求解器接触点有效。
 *
 * ── 已确认的 API 限制（源码证据见 docs）──
 *  1. 流形接触点的 data.impulse 只在它本步成为求解器接触点时才被写回；不是求解器接触点的流形点会保留上一次的旧冲量
 *     （窄相位用 `impulse == 0` 判断接触点是否新出现，说明该值跨步保留）。本服务只采用与求解器接触点匹配上的冲量，
 *     其余记为 staleImpulse 单独计数，不计入碰撞冲量。
 *  2. 求解器接触点与流形接触点的对应关系（SolverContact.contact_id）没有暴露给 JS。求解器接触点按流形接触点顺序生成，
 *     且 dist = 流形点 dist − 两个 contact skin（本项目 skin 均为 0），因此按顺序、按 dist 逐位相等匹配；
 *     匹配不完整时该碰撞体对标记 dataStatus = 'match-incomplete'，不使用它的冲量判断。
 *  3. 切向（摩擦）冲量：项目使用默认的 FrictionModel::Simplified（twist 摩擦），它的 writeback 不写 data.tangent_impulse，
 *     contactTangentImpulseX/Y 读到的不是本步摩擦冲量；切向基向量也不暴露。标记为不可用，不估算。
 *  4. Rapier 的 CollisionEvent started/stopped 以“是否有求解器接触点”为准，包含仅在预测距离内的点，不等于真实接触。
 *  5. 接触力事件（CONTACT_FORCE_EVENTS）需要修改碰撞体 ActiveEvents 才能取得，本阶段不改。
 *
 * ── 约定 ──
 *  - 身份：碰撞体由 (owner, part) 标识，例如 player:blade、arena:wall#12；不依赖 Rapier 句柄或遍历顺序。
 *  - 双方排序：动态主体（按注册顺序 player、rival）在前，arena 在后；同一主体内按部件名。A 为排序靠前的一方。
 *  - 法线：世界坐标单位向量，从 A 指向 B（Rapier 流形法线为 collider1 的外法线，flipped 时取反）。
 *  - 步号：本服务记录的 world.step 完成次数（第一次 observe 为 1），时长 = 步数 × dt。
 *  - physicalContact = penetration（求解器接触点求解前 dist ≤ 0）或 impulse（匹配到的法向冲量 > 0）；
 *    proximity = 有流形接触点但没有任何真实接触证据（只是在预测距离内）。生命周期只跟随 physicalContact。
 */
import type RAPIER from '@dimforge/rapier3d-compat';

export interface ContactTag {
  /** 主体：'player' / 'rival' / 'arena' / 'unknown' */
  readonly owner: string;
  /** 部件：bit / shaft / ratchet / blade / floor / wall#i / pocket#i.piece / table / h<handle> */
  readonly part: string;
  /** owner:part */
  readonly id: string;
  /** 排序键（主体优先级，部件名） */
  readonly rank: number;
  readonly dynamic: boolean;
  /** 碰撞体已被替换或移除（其碰撞体对结束后从列表中删除） */
  retired: boolean;
}

export interface ContactSubject {
  owner: string;
  colliders: readonly RAPIER.Collider[];
  parts: readonly string[];
}

export interface ContactPoint {
  /** 求解器接触点的世界坐标（求解前位姿上两表面最近点的中点） */
  x: number;
  y: number;
  z: number;
  /** 所属流形法线，A → B（单位向量）；normalValid = false 时为 0 */
  nx: number;
  ny: number;
  nz: number;
  /**
   * 法线是否有效。Rapier 在两表面恰好相切（dist = 0）时可能给出零向量法线（实测 7 万个流形中出现 1 次），
   * 此时不提供方向，也不自行推算。
   */
  normalValid: boolean;
  /** 求解前 signed distance（m）：≤ 0 为接触或穿透，> 0 为预测间隙 */
  dist: number;
  /** 本步求解后的法向冲量（N·s，≥ 0） */
  impulse: number;
  /** 所属流形序号（同一碰撞体对内） */
  manifold: number;
}

export type ContactPhase = 'none' | 'begin' | 'persist';
export type DataStatus = 'ok' | 'match-incomplete';

/** 一对碰撞体本步的观测 */
export interface ColliderPairContact {
  readonly a: ContactTag;
  readonly b: ContactTag;
  /** owner:part|owner:part */
  readonly key: string;
  /** 本步是否在窄相位接触图中（宽相位包围盒重叠） */
  present: boolean;
  dataStatus: DataStatus;
  manifolds: number;
  /** 流形接触点数（含预测间隙内的点） */
  points: number;
  /** 本步求解器接触点数（已与流形点匹配） */
  solverPoints: number;
  /** 全部流形接触点的最小 dist；没有点时 +Infinity */
  minDist: number;
  /** 求解器接触点的最小 dist；没有时 +Infinity */
  minSolverDist: number;
  /** 本步匹配到求解器接触点的法向冲量之和（post-solve） */
  normalImpulse: number;
  /** 不是本步求解器接触点、却带非零冲量的流形点（旧值，不计入 normalImpulse） */
  staleImpulsePoints: number;
  /** 法线无效（零向量）的求解器接触点数 */
  degenerateNormalPoints: number;
  /** 真实接触证据 */
  penetration: boolean;
  impulse: boolean;
  physicalContact: boolean;
  /** 只有预测间隙 / 接近信息 */
  proximity: boolean;
  /** 最深求解器接触点（没有时 null）与其法线 */
  deepest: ContactPoint | null;
  /** 本步全部求解器接触点（不合并；对象复用，需要保留请复制） */
  readonly contactPoints: ContactPoint[];
  /** 生命周期（只跟随 physicalContact） */
  phase: ContactPhase;
  /** 当前接触段开始的步号；未接触时为上一段的值或 -1 */
  startStep: number;
  /** 当前接触段已持续的步数（含本步） */
  durationSteps: number;
  /** 接触段计数 */
  episodes: number;
  /** 内部：本步是否已处理 */
  seenStep: number;
  /** 内部：deepest 的存储 */
  readonly deepestStore: ContactPoint;
  /** 内部：接触点对象池 */
  readonly pointPool: ContactPoint[];
}

/** 两个主体之间的汇总（多个碰撞体对合并为一个身体级接触） */
export interface BodyPairContact {
  readonly a: string;
  readonly b: string;
  /** owner|owner */
  readonly key: string;
  colliderPairs: number;
  physicalPairs: number;
  normalImpulse: number;
  penetration: boolean;
  impulse: boolean;
  physicalContact: boolean;
  proximity: boolean;
  /** 本步最深求解器接触点所在的碰撞体对 */
  deepestPair: ColliderPairContact | null;
  phase: ContactPhase;
  startStep: number;
  durationSteps: number;
  episodes: number;
  seenStep: number;
}

export interface ContactEvent {
  kind: 'begin' | 'end';
  level: 'collider' | 'body';
  /** owner:part|owner:part 或 owner|owner */
  key: string;
  step: number;
  /** end：该段开始的步号与持续步数；begin：等于 step 与 1 */
  startStep: number;
  durationSteps: number;
  /** end 的原因：'separated' = 真实接触证据消失；'vanished' = 碰撞体对不再出现在接触图中（含碰撞体移除） */
  reason: 'separated' | 'vanished' | null;
}

export interface ContactFrameStats {
  /** 接触图中的碰撞体对数（宽相位重叠） */
  pairsEnumerated: number;
  manifolds: number;
  points: number;
  solverPoints: number;
  physicalPairs: number;
  proximityPairs: number;
  staleImpulsePoints: number;
  degenerateNormalPoints: number;
  matchIncomplete: number;
}

/** 本服务对各项数据可用性的声明（不可用项不提供数值） */
export const CONTACT_CAPABILITIES = {
  rapier: '0.19.3 (rapier 0.30.1)',
  geometryPhase: 'pre-solve' as const,
  impulsePhase: 'post-solve' as const,
  normalImpulse: 'available: solver contacts of this step only',
  tangentImpulse: 'unavailable: FrictionModel::Simplified does not write per-contact tangent impulse; tangent basis not exposed',
  contactForceEvents: 'unavailable: requires changing collider ActiveEvents',
  postStepShapeDistance: 'not collected (would need an extra shape query; geometry here is pre-solve)',
} as const;

const DYNAMIC_RANK_BASE = 0;
const ARENA_RANK = 1000;
const UNKNOWN_RANK = 2000;

function makeTag(owner: string, part: string, rank: number, dynamic: boolean): ContactTag {
  return { owner, part, id: `${owner}:${part}`, rank, dynamic, retired: false };
}

/** 排序：主体优先级，再按部件名；保证同一对碰撞体无论遍历方向如何都得到同一个 A/B */
function before(x: ContactTag, y: ContactTag): boolean {
  if (x.rank !== y.rank) return x.rank < y.rank;
  return x.part < y.part;
}

function newPoint(): ContactPoint {
  return { x: 0, y: 0, z: 0, nx: 0, ny: 0, nz: 0, normalValid: false, dist: 0, impulse: 0, manifold: 0 };
}

export class ContactService {
  readonly capabilities = CONTACT_CAPABILITIES;
  /** 已完成观测的物理步数 */
  step = 0;
  /** 本步统计 */
  readonly stats: ContactFrameStats = { pairsEnumerated: 0, manifolds: 0, points: 0, solverPoints: 0, physicalPairs: 0, proximityPairs: 0, staleImpulsePoints: 0, degenerateNormalPoints: 0, matchIncomplete: 0 };
  /** 本步生命周期事件（每步重置，对象复用；需要保留请复制） */
  readonly events: ContactEvent[] = [];
  /** 测试用：反向遍历主体与碰撞体（验证结果与遍历顺序无关） */
  reverseEnumeration = false;

  private readonly world: RAPIER.World;
  private readonly staticTags = new Map<number, ContactTag>();
  private readonly dynamicTags = new Map<number, ContactTag>();
  private readonly unknownTags = new Map<number, ContactTag>();
  private subjectSource: (() => readonly (ContactSubject | null | undefined)[]) | null = null;
  private subjectCache: ({ owner: string; colliders: readonly RAPIER.Collider[]; handles: number[]; tags: ContactTag[] } | null)[] = [];
  private readonly ownerRank = new Map<string, number>();
  private readonly pairs = new Map<ContactTag, Map<ContactTag, ColliderPairContact>>();
  private readonly pairList: ColliderPairContact[] = [];
  private readonly bodies = new Map<string, Map<string, BodyPairContact>>();
  private readonly bodyList: BodyPairContact[] = [];
  private readonly eventPool: ContactEvent[] = [];
  private eventCount = 0;
  /** 遍历中的上下文（避免每步创建闭包） */
  private curA: ContactTag | null = null;
  private curHandleA = 0;
  private curPair: ColliderPairContact | null = null;
  private manifoldIndex = 0;
  private retiredPending = false;
  private readonly onPartner = (h2: number) => this.visit(h2);
  private readonly onManifold = (m: RAPIER.TempContactManifold, flipped: boolean) => this.readManifold(m, flipped);

  constructor(world: RAPIER.World) {
    this.world = world;
  }

  /** 注册静态碰撞体（场地）身份 */
  registerStatic(collider: RAPIER.Collider, owner: string, part: string): void {
    this.staticTags.set(collider.handle, makeTag(owner, part, owner === 'arena' ? ARENA_RANK : UNKNOWN_RANK - 1, false));
  }

  /** 动态主体来源：每步读取一次，主体或碰撞体变化（重新发射）时自动更新身份表 */
  setSubjects(source: () => readonly (ContactSubject | null | undefined)[]): void {
    this.subjectSource = source;
  }

  /** 全部碰撞体对（含本步不在接触图中的历史对象，present = false） */
  get colliderPairs(): readonly ColliderPairContact[] {
    return this.pairList;
  }

  get bodyPairs(): readonly BodyPairContact[] {
    return this.bodyList;
  }

  /** 两个主体之间的身体级接触（顺序无关）；从未出现过时为 null */
  bodyPair(o1: string, o2: string): BodyPairContact | null {
    const [a, b] = this.orderOwners(o1, o2);
    return this.bodies.get(a)?.get(b) ?? null;
  }

  /** 两个碰撞体之间的接触（顺序无关）；id 形如 'player:blade' */
  colliderPair(id1: string, id2: string): ColliderPairContact | null {
    for (const p of this.pairList) if ((p.a.id === id1 && p.b.id === id2) || (p.a.id === id2 && p.b.id === id1)) return p;
    return null;
  }

  /** 物理步之后调用（PhysicsWorld.step 在 world.step 之后、afterStep 之前调用）。只读 */
  observe(): void {
    this.step++;
    const st = this.stats;
    st.pairsEnumerated = st.manifolds = st.points = st.solverPoints = st.physicalPairs = st.proximityPairs = st.staleImpulsePoints = st.degenerateNormalPoints = st.matchIncomplete = 0;
    this.eventCount = 0;
    this.syncSubjects();
    const np = this.world.narrowPhase;
    const subs = this.subjectCache;
    const n = subs.length;
    for (let si = 0; si < n; si++) {
      const s = subs[this.reverseEnumeration ? n - 1 - si : si];
      if (!s) continue;
      const m = s.colliders.length;
      for (let ci = 0; ci < m; ci++) {
        const k = this.reverseEnumeration ? m - 1 - ci : ci;
        this.curA = s.tags[k];
        this.curHandleA = s.colliders[k].handle;
        np.contactPairsWith(this.curHandleA, this.onPartner);
      }
    }
    this.finishStep();
    this.events.length = this.eventCount;
  }

  // ───────────────────────── 内部 ─────────────────────────

  private syncSubjects(): void {
    const list = this.subjectSource?.() ?? [];
    const cache = this.subjectCache;
    let changed = list.length !== cache.length;
    for (let i = 0; !changed && i < list.length; i++) {
      const s = list[i];
      const c = cache[i];
      if (!s || !c) changed = s !== c && !(s == null && c == null);
      else changed = s.owner !== c.owner || s.colliders !== c.colliders || s.colliders.length !== c.handles.length || s.colliders.some((x, j) => x.handle !== c.handles[j]);
    }
    if (!changed) return;
    // 主体或碰撞体变化（重新发射等）：旧身份退役，涉及它们的碰撞体对在本步以 vanished 结束后移除，不残留
    for (const t of this.dynamicTags.values()) t.retired = true;
    this.retiredPending = this.dynamicTags.size > 0;
    this.dynamicTags.clear();
    this.subjectCache = list.map((s, si) => {
      if (!s) return null;
      // 排序优先级 = 主体在来源列表中的槽位（player 槽 0、rival 槽 1），与发射先后无关
      const rank = DYNAMIC_RANK_BASE + si;
      this.ownerRank.set(s.owner, rank);
      const tags = s.colliders.map((c, i) => {
        const t = makeTag(s.owner, s.parts[i] ?? `c${i}`, rank, true);
        this.dynamicTags.set(c.handle, t);
        return t;
      });
      return { owner: s.owner, colliders: s.colliders, handles: s.colliders.map((c) => c.handle), tags };
    });
  }

  private orderOwners(o1: string, o2: string): [string, string] {
    const r = (o: string) => this.ownerRank.get(o) ?? (o === 'arena' ? ARENA_RANK : UNKNOWN_RANK);
    const r1 = r(o1);
    const r2 = r(o2);
    return r1 < r2 || (r1 === r2 && o1 <= o2) ? [o1, o2] : [o2, o1];
  }

  private tagOf(handle: number): ContactTag {
    const t = this.dynamicTags.get(handle) ?? this.staticTags.get(handle);
    if (t) return t;
    let u = this.unknownTags.get(handle);
    if (!u) {
      u = makeTag('unknown', `h${handle}`, UNKNOWN_RANK, false);
      this.unknownTags.set(handle, u);
    }
    return u;
  }

  private getPair(a: ContactTag, b: ContactTag): ColliderPairContact {
    let row = this.pairs.get(a);
    if (!row) {
      row = new Map();
      this.pairs.set(a, row);
    }
    let p = row.get(b);
    if (!p) {
      const deepestStore = newPoint();
      p = {
        a,
        b,
        key: `${a.id}|${b.id}`,
        present: false,
        dataStatus: 'ok',
        manifolds: 0,
        points: 0,
        solverPoints: 0,
        minDist: Infinity,
        minSolverDist: Infinity,
        normalImpulse: 0,
        staleImpulsePoints: 0,
        degenerateNormalPoints: 0,
        penetration: false,
        impulse: false,
        physicalContact: false,
        proximity: false,
        deepest: null,
        contactPoints: [],
        phase: 'none',
        startStep: -1,
        durationSteps: 0,
        episodes: 0,
        seenStep: 0,
        deepestStore,
        pointPool: [],
      };
      row.set(b, p);
      this.pairList.push(p);
    }
    return p;
  }

  private visit(h2: number): void {
    const t1 = this.curA!;
    const t2 = this.tagOf(h2);
    // 同一主体内部不会产生接触；防御性跳过
    if (t1.owner === t2.owner && t1.dynamic && t2.dynamic) return;
    const aFirst = before(t1, t2);
    const a = aFirst ? t1 : t2;
    const b = aFirst ? t2 : t1;
    const p = this.getPair(a, b);
    if (p.seenStep === this.step) return; // 两个动态主体之间的对会从两侧各遍历到一次
    p.seenStep = this.step;
    this.stats.pairsEnumerated++;
    // 重置本步观测
    p.present = true;
    p.dataStatus = 'ok';
    p.manifolds = p.points = p.solverPoints = p.staleImpulsePoints = p.degenerateNormalPoints = 0;
    p.minDist = p.minSolverDist = Infinity;
    p.normalImpulse = 0;
    p.deepest = null;
    p.contactPoints.length = 0;
    this.curPair = p;
    this.manifoldIndex = 0;
    const hA = aFirst ? this.curHandleA : h2;
    const hB = aFirst ? h2 : this.curHandleA;
    this.world.narrowPhase.contactPair(hA, hB, this.onManifold);
    this.classify(p);
  }

  private readManifold(m: RAPIER.TempContactManifold, flipped: boolean): void {
    const p = this.curPair!;
    const st = this.stats;
    const mi = this.manifoldIndex++;
    p.manifolds++;
    st.manifolds++;
    const np = m.numContacts();
    const ns = m.numSolverContacts();
    p.points += np;
    st.points += np;
    if (np === 0 && ns === 0) return;
    const n = m.normal();
    const nlen = Math.hypot(n.x, n.y, n.z);
    const normalValid = nlen > 0.5;
    const sgn = normalValid ? (flipped ? -1 : 1) / nlen : 0;
    const nx = n.x * sgn;
    const ny = n.y * sgn;
    const nz = n.z * sgn;
    let k = 0;
    for (let i = 0; i < np; i++) {
      const d = m.contactDist(i);
      if (d < p.minDist) p.minDist = d;
      if (k < ns && m.solverContactDist(k) === d) {
        const imp = m.contactImpulse(i);
        const sp = m.solverContactPoint(k);
        const idx = p.contactPoints.length;
        let pt = p.pointPool[idx];
        if (!pt) {
          pt = newPoint();
          p.pointPool.push(pt);
        }
        p.contactPoints.push(pt);
        pt.x = sp.x;
        pt.y = sp.y;
        pt.z = sp.z;
        pt.nx = nx;
        pt.ny = ny;
        pt.nz = nz;
        pt.normalValid = normalValid;
        if (!normalValid) {
          p.degenerateNormalPoints++;
          st.degenerateNormalPoints++;
        }
        pt.dist = d;
        pt.impulse = imp;
        pt.manifold = mi;
        p.normalImpulse += imp;
        if (d < p.minSolverDist) {
          p.minSolverDist = d;
          Object.assign(p.deepestStore, pt);
          p.deepest = p.deepestStore;
        }
        k++;
      } else if (m.contactImpulse(i) !== 0) {
        p.staleImpulsePoints++;
        st.staleImpulsePoints++;
      }
    }
    p.solverPoints += k;
    st.solverPoints += k;
    if (k !== ns) p.dataStatus = 'match-incomplete';
  }

  private classify(p: ColliderPairContact): void {
    const ok = p.dataStatus === 'ok';
    if (!ok) this.stats.matchIncomplete++;
    p.penetration = p.solverPoints > 0 && p.minSolverDist <= 0;
    p.impulse = ok && p.normalImpulse > 0;
    p.physicalContact = p.penetration || p.impulse;
    p.proximity = !p.physicalContact && p.points > 0;
    if (p.physicalContact) this.stats.physicalPairs++;
    else if (p.proximity) this.stats.proximityPairs++;
  }

  private finishStep(): void {
    const step = this.step;
    // 碰撞体对：本步未出现的对视为无接触（vanished），清空残留观测
    for (const p of this.pairList) {
      if (p.seenStep !== step) {
        p.present = false;
        p.dataStatus = 'ok';
        p.manifolds = p.points = p.solverPoints = p.staleImpulsePoints = p.degenerateNormalPoints = 0;
        p.contactPoints.length = 0;
        p.minDist = p.minSolverDist = Infinity;
        p.normalImpulse = 0;
        p.penetration = p.impulse = p.physicalContact = p.proximity = false;
        p.deepest = null;
      }
      this.advance(p, p.physicalContact, p.present ? 'separated' : 'vanished', 'collider', p.key);
    }
    if (this.retiredPending) {
      let left = false;
      for (let i = this.pairList.length - 1; i >= 0; i--) {
        const p = this.pairList[i];
        if (!(p.a.retired || p.b.retired)) continue;
        if (p.present || p.phase !== 'none') {
          left = true;
          continue;
        }
        this.pairList.splice(i, 1);
        this.pairs.get(p.a)?.delete(p.b);
        if (this.pairs.get(p.a)?.size === 0) this.pairs.delete(p.a);
      }
      this.retiredPending = left;
    }
    // 身体级汇总
    for (const bp of this.bodyList) {
      bp.colliderPairs = bp.physicalPairs = 0;
      bp.normalImpulse = 0;
      bp.penetration = bp.impulse = bp.physicalContact = bp.proximity = false;
      bp.deepestPair = null;
    }
    for (const p of this.pairList) {
      if (!p.present) continue;
      const bp = this.getBody(p.a.owner, p.b.owner);
      bp.seenStep = step;
      bp.colliderPairs++;
      bp.normalImpulse += p.normalImpulse;
      bp.penetration ||= p.penetration;
      bp.impulse ||= p.impulse;
      if (p.physicalContact) bp.physicalPairs++;
      bp.physicalContact ||= p.physicalContact;
      bp.proximity ||= p.proximity;
      if (p.deepest && (!bp.deepestPair || p.minSolverDist < bp.deepestPair.minSolverDist)) bp.deepestPair = p;
    }
    for (const bp of this.bodyList) {
      if (bp.physicalContact) bp.proximity = false;
      this.advance(bp, bp.physicalContact, bp.seenStep === step ? 'separated' : 'vanished', 'body', bp.key);
    }
  }

  private getBody(o1: string, o2: string): BodyPairContact {
    const [a, b] = this.orderOwners(o1, o2);
    let row = this.bodies.get(a);
    if (!row) {
      row = new Map();
      this.bodies.set(a, row);
    }
    let bp = row.get(b);
    if (!bp) {
      bp = { a, b, key: `${a}|${b}`, colliderPairs: 0, physicalPairs: 0, normalImpulse: 0, penetration: false, impulse: false, physicalContact: false, proximity: false, deepestPair: null, phase: 'none', startStep: -1, durationSteps: 0, episodes: 0, seenStep: 0 };
      row.set(b, bp);
      this.bodyList.push(bp);
    }
    return bp;
  }

  /** 生命周期推进：只跟随 physicalContact，时长按步数 */
  private advance(
    x: { phase: ContactPhase; startStep: number; durationSteps: number; episodes: number },
    on: boolean,
    reason: 'separated' | 'vanished',
    level: 'collider' | 'body',
    key: string,
  ): void {
    const step = this.step;
    if (on) {
      if (x.phase === 'none') {
        x.phase = 'begin';
        x.startStep = step;
        x.durationSteps = 1;
        x.episodes++;
        this.emit('begin', level, key, step, step, 1, null);
      } else {
        x.phase = 'persist';
        x.durationSteps = step - x.startStep + 1;
      }
    } else if (x.phase !== 'none') {
      this.emit('end', level, key, step, x.startStep, x.durationSteps, reason);
      x.phase = 'none';
      x.durationSteps = 0;
    }
  }

  private emit(kind: 'begin' | 'end', level: 'collider' | 'body', key: string, step: number, startStep: number, durationSteps: number, reason: 'separated' | 'vanished' | null): void {
    let e = this.eventPool[this.eventCount];
    if (!e) {
      e = { kind, level, key, step, startStep, durationSteps, reason };
      this.eventPool.push(e);
    } else {
      e.kind = kind;
      e.level = level;
      e.key = key;
      e.step = step;
      e.startStep = startStep;
      e.durationSteps = durationSteps;
      e.reason = reason;
    }
    this.events[this.eventCount++] = e;
  }
}

/** 陀螺碰撞体的部件名（与 BeyPhysics 构造顺序一致：接地球 Bit、轴杆、Ratchet、Blade） */
export const BEY_COLLIDER_PARTS = ['bit', 'shaft', 'ratchet', 'blade'] as const;
