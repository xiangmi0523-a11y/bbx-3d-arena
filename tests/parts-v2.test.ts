import { describe, expect, it } from 'vitest';
import { assembleBey, computeStats, REF_INERTIA } from '../src/game/beys/parts/assemble';
import { BITS, BLADES, listParts, RATCHETS, sanitizeLoadout, SIGNATURE_LIST, SIGNATURES } from '../src/game/beys/parts/catalog';
import { STARTER_PARTS } from '../src/game/modes/challenge';
import { DEFAULT_SETTINGS, migrateSave } from '../src/game/storage/SaveStore';
import params from './fixtures/params-v2.json';

/**
 * v2.0 零件数据契约（§4.2 / §4.3）：目录与唯一参数源 params-v2.json 逐项一致；
 * Disc → Ratchet、Tip → Bit 改名后的存档迁移。纯数据测试。
 */
const P = params as unknown as {
  blades: Record<string, Record<string, unknown>>;
  ratchets: Record<string, Record<string, unknown>>;
  bits: Record<string, Record<string, unknown>>;
  signature_builds: Record<string, { blade: string; ratchet: string; bit: string; role: string; name: string }>;
};

describe('v2.0 零件数据契约', () => {
  it('Blade 物理字段与 params-v2.json 一致', () => {
    for (const [id, p] of Object.entries(P.blades)) {
      const b = BLADES[id];
      for (const k of ['mass', 'rimWeight', 'radius', 'height', 'friction', 'restitution', 'attack', 'defense', 'spin', 'role'] as const) expect(b[k], `${id}.${k}`).toBe(p[k]);
      expect(b.visual.lobes, `${id}.lobes`).toBe(p.lobes);
    }
  });

  it('Ratchet：lock（数值继承原 burstResistance）与 teeth 与参数源一致', () => {
    for (const [id, p] of Object.entries(P.ratchets)) {
      const r = RATCHETS[id];
      for (const k of ['mass', 'rimWeight', 'radius', 'height', 'lock', 'teeth', 'name'] as const) expect(r[k], `${id}.${k}`).toBe(p[k]);
      expect(r.kind).toBe('ratchet');
    }
  });

  it('Bit：burstGuard / gear 新字段与参数源一致；只有平齿轴带齿轮；类型由 Bit 决定', () => {
    for (const [id, p] of Object.entries(P.bits)) {
      const b = BITS[id];
      for (const k of ['mass', 'contactRadius', 'height', 'friction', 'spinDecay', 'gearGrip', 'drift', 'gear', 'burstGuard', 'name'] as const) expect(b[k], `${id}.${k}`).toBe(p[k]);
      expect(b.kind).toBe('bit');
    }
    expect(listParts('bit').filter((b) => b.gear).map((b) => b.id)).toEqual(['gear-flat']);
    expect(Object.fromEntries(listParts('bit').map((b) => [b.id, b.role]))).toEqual({ 'gear-flat': 'balance', 'dome-ball': 'stamina', 'needle-point': 'defense', 'rush-rubber': 'attack' });
  });

  it('签名构筑与参数源一致（R2 换位：磐盾 = 针尖轴、紫曜 = 圆球轴），类型 = Bit 的类型', () => {
    for (const [key, s] of Object.entries(P.signature_builds)) {
      const sig = SIGNATURES[key as keyof typeof SIGNATURES];
      expect(sig.loadout, key).toEqual({ blade: s.blade, ratchet: s.ratchet, bit: s.bit });
      expect(sig.role).toBe(s.role);
      expect(sig.name).toBe(s.name);
      expect(assembleBey(sig.loadout).role).toBe(s.role);
    }
    expect(SIGNATURE_LIST.map((s) => s.key)).toEqual(['lieren', 'pandun', 'senheng', 'ziyao']);
  });

  it('总高度 = 三件相加（无嵌套系数）；签名构筑的生效衰减率与 v2.0 §3.3 表一致', () => {
    const want: Record<string, { mass: number; inertia: number; decay: number; height: number }> = {
      lieren: { mass: 4.4, inertia: 0.463, decay: 2.38, height: 0.59 },
      pandun: { mass: 5.1, inertia: 0.5973, decay: 0.78, height: 0.56 },
      senheng: { mass: 4.55, inertia: 0.5382, decay: 2.04, height: 0.55 },
      ziyao: { mass: 4.95, inertia: 0.7308, decay: 0.9, height: 0.58 },
    };
    for (const sig of SIGNATURE_LIST) {
      const a = assembleBey(sig.loadout);
      const w = want[sig.key];
      expect(a.totalMass).toBeCloseTo(w.mass, 6);
      expect(a.totalHeight).toBeCloseTo(a.blade.height + a.ratchet.height + a.bit.height, 12);
      expect(a.totalHeight).toBeCloseTo(w.height, 6);
      expect(a.spinInertia).toBeCloseTo(w.inertia, 3);
      expect((a.bit.spinDecay * REF_INERTIA) / a.spinInertia).toBeCloseTo(w.decay, 2);
    }
  });

  it('展示属性（§4.4 公式）：烈刃攻击最高、磐盾防御最高、森衡 / 烈刃机动最高、磐盾机动最低', () => {
    const st = Object.fromEntries(SIGNATURE_LIST.map((s) => [s.key, computeStats(assembleBey(s.loadout))]));
    const top = (k: keyof (typeof st)['lieren']) => Object.entries(st).sort((a, b) => b[1][k] - a[1][k]).map(([n]) => n);
    expect(top('attack')[0]).toBe('lieren');
    expect(top('defense')[0]).toBe('pandun');
    expect(top('mobility').slice(0, 2).sort()).toEqual(['lieren', 'senheng']);
    expect(top('mobility')[3]).toBe('pandun');
    // 记录：换位后持久排序为 磐盾 > 紫曜（与生效衰减 0.78 < 0.90 一致；v2.0 文字写“紫曜最高”，属 S3 调参事项，见报告）
    expect(top('stamina').slice(0, 2)).toEqual(['pandun', 'ziyao']);
    for (const s of Object.values(st)) for (const v of Object.values(s)) expect(v).toBeGreaterThan(0), expect(v).toBeLessThanOrEqual(1);
  });
});

describe('存档迁移（v1 → v2 → v3）', () => {
  const fresh = { parts: [...STARTER_PARTS], arenas: ['standard'], cleared: [], titles: [], settings: DEFAULT_SETTINGS };
  it('v1 的 disc / tip 槽位迁移为 ratchet / bit，战绩保留；收集按新玩家初始化（6 个初始零件 + 标准竞技场）', () => {
    const v1 = { version: 1, wins: 3, losses: 2, points: 7, lastLoadout: { blade: 'titan-crown', disc: 'ring-guard', tip: 'needle-point' } };
    expect(migrateSave(v1)).toEqual({ version: 3, wins: 3, losses: 2, points: 7, lastLoadout: { blade: 'titan-crown', ratchet: 'ring-guard', bit: 'needle-point' }, ...fresh });
  });

  it('v2 → v3；缺字段 / 坏数据不抛错：认不出的存档返回 null，坏的组装方案为 null，数字字段回退 0', () => {
    const v2 = { version: 2, wins: 1, losses: 0, points: 2, lastLoadout: { blade: 'blaze-fang', ratchet: 'tri-lock', bit: 'gear-flat' } };
    expect(migrateSave(v2)).toEqual({ ...v2, version: 3, ...fresh });
    expect(migrateSave(null)).toBeNull();
    expect(migrateSave('x')).toBeNull();
    expect(migrateSave({ version: 9 })).toBeNull();
    expect(migrateSave({ version: 1, wins: 'a', lastLoadout: { blade: 'x' } })).toEqual({ version: 3, wins: 0, losses: 0, points: 0, lastLoadout: null, ...fresh });
  });

  it('v3 原样读取并校验：初始零件永远拥有、不认识的零件 / 竞技场 / 关卡丢弃、设置字段逐项回退默认', () => {
    const v3 = {
      version: 3,
      wins: 5,
      losses: 1,
      points: 900,
      lastLoadout: { blade: 'titan-crown', ratchet: 'tri-lock', bit: 'dome-ball' },
      parts: ['blade:titan-crown', 'bit:nope', 'blade:titan-crown'],
      arenas: ['velocity', 'moon'],
      cleared: [2, 1, 1, 99, 1.5],
      titles: ['持久猎手', 3],
      settings: { reduceEffects: true, sound: 'no', camera: 'overview', quality: 'high', showFps: false },
    };
    const m = migrateSave(v3)!;
    expect(m.parts).toEqual([...STARTER_PARTS, 'blade:titan-crown']);
    expect(m.arenas).toEqual(['standard', 'velocity']);
    expect(m.cleared).toEqual([1, 2]);
    expect(m.titles).toEqual(['持久猎手']);
    expect(m.settings).toEqual({ reduceEffects: true, sound: true, camera: 'overview', quality: 'high', showFps: false });
    expect(m.lastLoadout).toEqual(v3.lastLoadout);
  });

  it('迁移后的部件 id 仍由 sanitizeLoadout 校验：不认识的部件单独回退', () => {
    const m = migrateSave({ version: 1, wins: 0, losses: 0, points: 0, lastLoadout: { blade: 'nope', disc: 'hex-lock', tip: 'dome-ball' } })!;
    const fb = SIGNATURES.senheng.loadout;
    expect(sanitizeLoadout(m.lastLoadout, fb)).toEqual({ blade: fb.blade, ratchet: 'hex-lock', bit: 'dome-ball' });
  });
});
