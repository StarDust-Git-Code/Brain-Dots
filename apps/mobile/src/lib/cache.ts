export interface StorageAdapter {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
}

// Public data and drafts are isolated by Firebase UID. Tokens are managed only
// by Firebase Auth's persistence adapter, never by this cache.
export class UserCache {
  private memory = new Map<string, unknown>();
  private writes = new Map<string, Promise<void>>();
  private listeners = new Map<string, Set<() => void>>();

  constructor(private storage: StorageAdapter, private uid: string) {}

  private key(resource: string) {
    return `brain-dots:v1:${encodeURIComponent(this.uid)}:${encodeURIComponent(resource)}`;
  }

  async read<T>(resource: string): Promise<T | null> {
    if (!this.memory.has(resource)) {
      const raw = await this.storage.getItem(this.key(resource));
      const value = raw === null ? null : JSON.parse(raw) as T;
      // An overlapping successful write takes precedence over this disk read.
      if (!this.memory.has(resource)) this.memory.set(resource, value);
    }
    return this.memory.get(resource) as T | null;
  }

  private enqueue(resource: string, operation: () => Promise<void>) {
    const write = (this.writes.get(resource) ?? Promise.resolve())
      .catch(() => {})
      .then(operation);
    this.writes.set(resource, write);
    return write;
  }

  write<T>(resource: string, value: T): Promise<void> {
    return this.enqueue(resource, async () => {
      await this.storage.setItem(this.key(resource), JSON.stringify(value));
      this.memory.set(resource, value);
      this.listeners.get(resource)?.forEach((listener) => listener());
    });
  }

  update<T>(resource: string, update: (previous: T | null) => T): Promise<void> {
    return this.enqueue(resource, async () => {
      const value = update(await this.read<T>(resource));
      await this.storage.setItem(this.key(resource), JSON.stringify(value));
      this.memory.set(resource, value);
      this.listeners.get(resource)?.forEach((listener) => listener());
    });
  }

  subscribe(resource: string, listener: () => void): () => void {
    const listeners = this.listeners.get(resource) ?? new Set();
    listeners.add(listener);
    this.listeners.set(resource, listeners);
    return () => { listeners.delete(listener); };
  }
}

export const pageKey = (spaceId: string, pageId: string) =>
  `page:${spaceId}:${pageId}`;
export const pagesKey = (spaceId: string) => `pages:${spaceId}`;
