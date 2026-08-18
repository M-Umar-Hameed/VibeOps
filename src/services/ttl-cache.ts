// Tiny per-key TTL cache. Map + expiry stamp, no dependency. get() memoizes a
// loader's result for ttlMs; a rejected loader is never cached. invalidate()
// drops one key, or all keys when called with no argument.
export type TtlCache<T> = {
  get(key: string, load: () => Promise<T>): Promise<T>;
  invalidate(key?: string): void;
};

export function ttlCache<T>(ttlMs: number): TtlCache<T> {
  const store = new Map<string, { value: T; exp: number }>();
  return {
    async get(key, load) {
      const now = Date.now();
      const hit = store.get(key);
      if (hit && hit.exp > now) return hit.value;
      const value = await load();
      store.set(key, { value, exp: now + ttlMs });
      return value;
    },
    invalidate(key) {
      if (key === undefined) store.clear();
      else store.delete(key);
    },
  };
}
