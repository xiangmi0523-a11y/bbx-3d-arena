import type { BeyLoadout } from '../beys/parts/types';
import { ALL_ARENAS, ALL_PART_KEYS, STARTER_ARENAS, STARTER_PARTS, CHALLENGES } from '../modes/challenge';

/**
 * 本地存档（IndexedDB）。存战绩、上次使用的组装方案、收集与挑战进度、设置。
 * IndexedDB 不可用时（隐私模式等）自动退回内存存储，不影响游戏运行。
 *
 * 版本：
 *  - v1 → v2（v2.0 §4.3）：组装方案的槽位名 disc → ratchet、tip → bit，部件 id 不变；
 *  - v2 → v3（v2.0 §9.1 / S6）：新增收集（拥有的零件、解锁的竞技场）、挑战进度、称号、设置。
 *    旧存档按“新玩家”的收集状态迁移（初始 6 个零件 + 标准竞技场），战绩与积分保留；
 *    上次的组装方案若用到未拥有的零件，由引擎在读档时逐个换回已拥有的零件。
 * 读到旧存档时一次性迁移；迁移不了的字段回退默认（不丢战绩）。
 */

export type CameraPref = 'follow' | 'overview';
export type QualityPref = 'auto' | 'low' | 'medium' | 'high' | 'ultra';

export interface SaveSettings {
  /** 减特效：关闭爆裂慢动作与镜头震动（v2.0 §10.3 无障碍） */
  reduceEffects: boolean;
  sound: boolean;
  /** 战斗镜头：跟随 / 全场（v2.0 §10.2 设置面板） */
  camera: CameraPref;
  /** 画质：自动或固定档位 */
  quality: QualityPref;
  /** 显示帧率角标 */
  showFps: boolean;
}

export interface SaveData {
  version: 3;
  wins: number;
  losses: number;
  points: number;
  lastLoadout: BeyLoadout | null;
  /** 拥有的零件（kind:id） */
  parts: string[];
  /** 解锁的竞技场 */
  arenas: string[];
  /** 已通关的挑战关卡序号 */
  cleared: number[];
  titles: string[];
  settings: SaveSettings;
}

export const SAVE_VERSION = 3;
export const DEFAULT_SETTINGS: SaveSettings = { reduceEffects: false, sound: true, camera: 'follow', quality: 'auto', showFps: true };
export const DEFAULT_SAVE: SaveData = {
  version: 3,
  wins: 0,
  losses: 0,
  points: 0,
  lastLoadout: null,
  parts: [...STARTER_PARTS],
  arenas: [...STARTER_ARENAS],
  cleared: [],
  titles: [],
  settings: { ...DEFAULT_SETTINGS },
};

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const uniq = <T,>(a: T[]) => [...new Set(a)];

function loadoutOf(lo: Record<string, unknown> | null, slots: [string, string, string]): BeyLoadout | null {
  const blade = str(lo?.[slots[0]]);
  const ratchet = str(lo?.[slots[1]]);
  const bit = str(lo?.[slots[2]]);
  return blade && ratchet && bit ? { blade, ratchet, bit } : null;
}

function settingsOf(v: unknown): SaveSettings {
  const r = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  const camera = r.camera === 'overview' ? 'overview' : 'follow';
  const q = r.quality;
  const quality: QualityPref = q === 'low' || q === 'medium' || q === 'high' || q === 'ultra' ? q : 'auto';
  return {
    reduceEffects: bool(r.reduceEffects, DEFAULT_SETTINGS.reduceEffects),
    sound: bool(r.sound, DEFAULT_SETTINGS.sound),
    camera,
    quality,
    showFps: bool(r.showFps, DEFAULT_SETTINGS.showFps),
  };
}

/**
 * 把任意版本的存档迁移到当前版本（纯函数，可单独测试）。
 * 认不出的存档返回 null（调用方使用默认存档）；部件 id 是否存在由 sanitizeLoadout 另行校验，是否拥有由 ownedLoadout 校验。
 */
export function migrateSave(raw: unknown): SaveData | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const base = { wins: num(r.wins), losses: num(r.losses), points: num(r.points) };
  const lo = r.lastLoadout && typeof r.lastLoadout === 'object' ? (r.lastLoadout as Record<string, unknown>) : null;
  const fresh = { parts: [...STARTER_PARTS], arenas: [...STARTER_ARENAS], cleared: [] as number[], titles: [] as string[], settings: { ...DEFAULT_SETTINGS } };
  if (r.version === 1) return { version: 3, ...base, lastLoadout: loadoutOf(lo, ['blade', 'disc', 'tip']), ...fresh };
  if (r.version === 2) return { version: 3, ...base, lastLoadout: loadoutOf(lo, ['blade', 'ratchet', 'bit']), ...fresh };
  if (r.version === 3) {
    const strs = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
    const levels = Array.isArray(r.cleared) ? r.cleared.filter((x): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 1 && x <= CHALLENGES.length) : [];
    return {
      version: 3,
      ...base,
      lastLoadout: loadoutOf(lo, ['blade', 'ratchet', 'bit']),
      // 初始零件永远拥有；不认识的 id 丢弃
      parts: uniq([...STARTER_PARTS, ...strs(r.parts).filter((k) => ALL_PART_KEYS.includes(k))]),
      arenas: uniq([...STARTER_ARENAS, ...strs(r.arenas).filter((k) => (ALL_ARENAS as string[]).includes(k))]),
      cleared: uniq(levels).sort((a, b) => a - b),
      titles: uniq(strs(r.titles)),
      settings: settingsOf(r.settings),
    };
  }
  return null;
}

const DB_NAME = 'bbx-arena';
const STORE = 'kv';
const KEY = 'save';

export interface KeyValueBackend {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
}

class MemoryBackend implements KeyValueBackend {
  private map = new Map<string, unknown>();
  async get<T>(key: string) {
    return this.map.get(key) as T | undefined;
  }
  async set<T>(key: string, value: T) {
    this.map.set(key, value);
  }
}

class IndexedDbBackend implements KeyValueBackend {
  private dbPromise: Promise<IDBDatabase>;

  constructor() {
    this.dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  private async tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
    const db = await this.dbPromise;
    return new Promise((resolve, reject) => {
      const req = fn(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error);
    });
  }

  get<T>(key: string) {
    return this.tx<T | undefined>('readonly', (s) => s.get(key));
  }

  async set<T>(key: string, value: T) {
    await this.tx('readwrite', (s) => s.put(value, key));
  }
}

export class SaveStore {
  private backend: KeyValueBackend;
  data: SaveData = { ...DEFAULT_SAVE, parts: [...DEFAULT_SAVE.parts], arenas: [...DEFAULT_SAVE.arenas], settings: { ...DEFAULT_SETTINGS } };

  constructor(backend?: KeyValueBackend) {
    this.backend = backend ?? (typeof indexedDB !== 'undefined' ? new IndexedDbBackend() : new MemoryBackend());
  }

  async load(): Promise<SaveData> {
    try {
      const saved = migrateSave(await this.backend.get<unknown>(KEY));
      if (saved) this.data = saved;
    } catch (err) {
      console.warn('读取存档失败，使用内存存储', err);
      this.backend = new MemoryBackend();
    }
    return this.data;
  }

  async update(patch: Partial<SaveData>): Promise<SaveData> {
    this.data = { ...this.data, ...patch };
    try {
      await this.backend.set(KEY, this.data);
    } catch (err) {
      console.warn('写入存档失败', err);
    }
    return this.data;
  }
}
