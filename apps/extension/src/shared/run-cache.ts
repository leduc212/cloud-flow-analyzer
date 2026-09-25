// Finished runs never change, so what was read about them is kept in the browser (IndexedDB,
// this extension only) and not fetched again. Only timings, statuses and error codes are kept:
// never inputs, outputs or the token.
import type { RunSample } from '@cfa/core';

export interface CachedRun {
  /** The loop actions whose repetitions were read (`|`-joined), so a changed flow refetches. */
  targets: string;
  sample: RunSample;
  savedAt: number;
}

export interface RunCache {
  get(key: string): Promise<CachedRun | undefined>;
  set(key: string, value: CachedRun): Promise<void>;
  clear(): Promise<void>;
}

/** Entries older than this are removed when the cache opens. */
export const RUN_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function memoryRunCache(): RunCache {
  const entries = new Map<string, CachedRun>();
  return {
    get: async (key) => entries.get(key),
    set: async (key, value) => void entries.set(key, value),
    clear: async () => entries.clear(),
  };
}

const DB_NAME = 'cloud-flow-analyzer';
const STORE = 'runs';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

function open(now: () => number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onerror = () => reject(req.error ?? new Error("Couldn't open the run cache"));
    req.onsuccess = () => {
      const db = req.result;
      // Drop old entries; runs older than a month are rarely sampled again.
      const cursor = db.transaction(STORE, 'readwrite').objectStore(STORE).openCursor();
      cursor.onsuccess = () => {
        const entry = cursor.result;
        if (!entry) return;
        const value = entry.value as CachedRun | undefined;
        if (!value || now() - value.savedAt > RUN_CACHE_MAX_AGE_MS) entry.delete();
        entry.continue();
      };
      resolve(db);
    };
  });
}

/** The IndexedDB cache. Any failure just means a cache miss: the runs are fetched again. */
export function indexedDbRunCache(now: () => number = Date.now): RunCache {
  let db: Promise<IDBDatabase> | undefined;
  const store = async (mode: IDBTransactionMode) => {
    db ??= open(now);
    return (await db).transaction(STORE, mode).objectStore(STORE);
  };
  return {
    async get(key) {
      try {
        return (await request((await store('readonly')).get(key))) as CachedRun | undefined;
      } catch {
        return undefined;
      }
    },
    async set(key, value) {
      try {
        await request((await store('readwrite')).put(value, key));
      } catch {
        // Not cached: fetched again next time.
      }
    },
    async clear() {
      await request((await store('readwrite')).clear());
    },
  };
}
