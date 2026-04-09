class MemoryCache {
  constructor(maxEntries = 200) {
    this.store = new Map();
    this.maxEntries = Number.isFinite(Number(maxEntries)) && Number(maxEntries) > 0
      ? Number(maxEntries)
      : 200;
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  prune() {
    const now = Date.now();
    for (const [key, entry] of this.store.entries()) {
      if (entry.expiresAt <= now) {
        this.store.delete(key);
      }
    }

    while (this.store.size > this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey === undefined) break;
      this.store.delete(oldestKey);
    }
  }

  set(key, value, ttlMs) {
    const ttl = Number(ttlMs);
    const expiresAt = Date.now() + (Number.isFinite(ttl) && ttl > 0 ? ttl : 60 * 1000);
    this.store.set(key, { value, expiresAt });
    this.prune();
    return value;
  }

  delete(key) {
    this.store.delete(key);
  }

  deleteByPrefix(prefix) {
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
      }
    }
  }

  clear() {
    this.store.clear();
  }
}

module.exports = { MemoryCache };
