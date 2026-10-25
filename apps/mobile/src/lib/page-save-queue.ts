import type { Page } from '../types';
import { pageKey } from './cache';

export type DraftStatus = 'saved' | 'unsaved' | 'saving' | 'error' | 'conflict';

export interface PageDraft {
  base: Page;
  title: string;
  content: string;
  generation: number;
  status: DraftStatus;
  error: string;
  conflict: Page | null;
}

export interface QueueSnapshot {
  drafts: Readonly<Record<string, PageDraft>>;
  storageError: string;
}

interface DraftStore {
  load(): Promise<Record<string, PageDraft> | null>;
  save(drafts: Readonly<Record<string, PageDraft>>): Promise<void>;
  cachePage(page: Page): Promise<void>;
}

interface PageTransport {
  save(draft: PageDraft): Promise<Page>;
  load(spaceId: string, pageId: string): Promise<Page>;
  canSync(): boolean;
}

const message = (error: unknown) =>
  error instanceof Error ? error.message : 'Could not save. Your draft is retained.';

// One writer per signed-in user, owned by the provider rather than the editor.
// Each attempt captures a generation; acknowledgements advance the revision but
// never replace edits made while that attempt was in flight.
export class PageSaveQueue {
  private snapshot: QueueSnapshot = { drafts: {}, storageError: '' };
  private listeners = new Set<() => void>();
  private initialized: Promise<void> | null = null;
  private writes: Promise<void> = Promise.resolve();
  private flushing: Promise<void> | null = null;

  constructor(private store: DraftStore, private transport: PageTransport) {}

  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private publish(patch: Partial<QueueSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener());
  }

  private put(key: string, draft: PageDraft) {
    this.publish({ drafts: { ...this.snapshot.drafts, [key]: draft } });
  }

  ready(): Promise<void> {
    if (!this.initialized) {
      this.initialized = this.store.load().then((stored) => {
        const drafts = Object.fromEntries(Object.entries(stored ?? {}).map(([key, draft]) => [
          key,
          { ...draft, status: draft.status === 'saving' ? 'unsaved' : draft.status },
        ])) as Record<string, PageDraft>;
        this.publish({ drafts });
      }).catch((error: unknown) => {
        this.publish({ storageError: `Could not read local drafts: ${message(error)}` });
        throw error;
      });
    }
    return this.initialized;
  }

  private async persist() {
    const drafts = this.snapshot.drafts;
    const write = this.writes.catch(() => {}).then(() => this.store.save(drafts));
    this.writes = write;
    try {
      await write;
      if (this.snapshot.storageError) this.publish({ storageError: '' });
    } catch (error) {
      this.publish({ storageError: `Could not store drafts on this device: ${message(error)}` });
      throw error;
    }
  }

  async open(page: Page): Promise<void> {
    await this.ready();
    const key = pageKey(page.spaceId, page.id);
    const current = this.snapshot.drafts[key];
    if (current && (current.status !== 'saved' || current.base.revision > page.revision)) return;
    this.put(key, {
      base: page, title: page.title, content: page.content,
      generation: current?.generation ?? 0, status: 'saved', error: '', conflict: null,
    });
    await this.persist();
  }

  edit(key: string, patch: { title?: string; content?: string }): Promise<void> {
    const current = this.snapshot.drafts[key];
    if (!current) return Promise.reject(new Error('Load the page before editing.'));
    this.put(key, {
      ...current, ...patch, generation: current.generation + 1,
      status: current.status === 'saved' ? 'unsaved' : current.status,
    });
    return this.persist();
  }

  async storePending(): Promise<void> {
    await this.ready();
    await this.persist();
  }

  flush(): Promise<void> {
    if (!this.flushing) {
      this.flushing = this.drain().finally(() => { this.flushing = null; });
    }
    return this.flushing;
  }

  private async accept(key: string, attempt: PageDraft, remote: Page) {
    const current = this.snapshot.drafts[key];
    const unchanged = current.generation === attempt.generation;
    this.put(key, {
      ...current, base: remote,
      title: unchanged ? remote.title : current.title,
      content: unchanged ? remote.content : current.content,
      status: unchanged ? 'saved' : 'unsaved', error: '', conflict: null,
    });
    await this.persist();
    try {
      await this.store.cachePage(remote);
    } catch (error) {
      this.publish({ storageError: `Page saved; could not update local cache: ${message(error)}` });
    }
  }

  private async drain() {
    await this.ready();
    const failed = new Set<string>();
    while (this.transport.canSync()) {
      const entry = Object.entries(this.snapshot.drafts).find(([key, draft]) =>
        draft.status !== 'saved' && draft.status !== 'conflict' && !failed.has(key));
      if (!entry) return;
      const [key, attempt] = entry;
      this.put(key, { ...attempt, status: 'saving' });
      // Do not send a draft that could not first be written locally.
      try {
        await this.persist();
      } catch {
        this.put(key, { ...this.snapshot.drafts[key], status: 'error', error: 'Could not store the draft locally. Retry after freeing device storage.' });
        return;
      }
      if (!this.transport.canSync()) {
        this.put(key, { ...this.snapshot.drafts[key], status: 'unsaved' });
        await this.persist();
        return;
      }
      let remote: Page;
      try {
        remote = await this.transport.save(attempt);
      } catch (error) {
        const conflict = typeof error === 'object' && error !== null &&
          'status' in error && error.status === 409;
        let latest: Page | null = null;
        if (conflict && this.transport.canSync()) {
          try {
            latest = await this.transport.load(attempt.base.spaceId, attempt.base.id);
          } catch { /* Keep the conflict and the entire draft if review is offline. */ }
        }
        // A save can commit even when its response is lost. An identical remote
        // version is an acknowledgement, not a reason to overwrite newer edits.
        if (latest && latest.revision > attempt.base.revision &&
          latest.title === attempt.title && latest.content === attempt.content) {
          await this.accept(key, attempt, latest);
          continue;
        }
        this.put(key, {
          ...this.snapshot.drafts[key], status: conflict ? 'conflict' : 'error',
          error: conflict ? 'This page changed elsewhere. Review before saving your draft.' : message(error),
          conflict: latest,
        });
        await this.persist();
        failed.add(key);
        continue;
      }
      await this.accept(key, attempt, remote);
    }
  }

  async resolve(key: string, choice: 'keep-draft' | 'use-server'): Promise<void> {
    await this.ready();
    const before = this.snapshot.drafts[key];
    if (!before || before.status !== 'conflict') return;
    if (!this.transport.canSync()) throw new Error('Reconnect to review the server version.');
    const latest = await this.transport.load(before.base.spaceId, before.base.id);
    const current = this.snapshot.drafts[key];
    if (choice === 'use-server' && current.generation !== before.generation)
      throw new Error('Your draft changed during review. Please review again.');
    this.put(key, {
      ...current, base: latest, generation: current.generation + 1,
      title: choice === 'use-server' ? latest.title : current.title,
      content: choice === 'use-server' ? latest.content : current.content,
      status: choice === 'use-server' ? 'saved' : 'unsaved', error: '', conflict: null,
    });
    await this.persist();
    await this.store.cachePage(latest);
  }
}
