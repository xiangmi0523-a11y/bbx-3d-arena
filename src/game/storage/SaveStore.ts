import type { BeyLoadout } from '../beys/parts/types';

/**
 * 本地存档（IndexedDB）。P1 只存战绩和上次使用的组装方案，
 * 结构按 key-value 设计，后续可以加入部件收藏、设置等。
 * IndexedDB 不可用时（隐私模式等）自动退回内存存储，不影响游戏运行。
 */

export interface SaveData {
  version: 1;
  wins: number;
  losses: number;
  points: number;
  lastLoadout: BeyLoadout | null;
}

export const DEFAULT_SAVE: SaveData = { version: 1, wins: 0, losses: 0, points: 0, lastLoadout: null };

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
  data: SaveData = { ...DEFAULT_SAVE };

  constructor(backend?: KeyValueBackend) {
    this.backend = backend ?? (typeof indexedDB !== 'undefined' ? new IndexedDbBackend() : new MemoryBackend());
  }

  async load(): Promise<SaveData> {
    try {
      const saved = await this.backend.get<SaveData>(KEY);
      if (saved && saved.version === 1) this.data = { ...DEFAULT_SAVE, ...saved };
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
