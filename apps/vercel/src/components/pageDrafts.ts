import type { Page } from '../lib/types';

export type PageSaveStatus = 'saved' | 'saving' | 'unsaved' | 'conflict' | 'error';

export interface PageDraftState {
  page: Page;
  title: string;
  content: string;
  status: PageSaveStatus;
  error: string | null;
}

type WritePage = (
  page: Page,
  changes: { title: string; content: string; expectedRevision: number },
) => Promise<Page>;

/** One writer per page. Acknowledgements advance the revision, never the newer draft. */
export class PageDraftSession {
  private state: PageDraftState;
  private listeners = new Set<() => void>();
  private pending: Promise<boolean> | null = null;
  private disposed = false;

  constructor(page: Page, private write: WritePage) {
    this.state = {
      page,
      title: page.title,
      content: page.content,
      status: 'saved',
      error: null,
    };
  }

  getSnapshot = (): PageDraftState => this.state;

  get dirty(): boolean {
    return this.state.status === 'conflict' || this.hasChanges || this.pending !== null;
  }

  private get hasChanges(): boolean {
    return this.state.title !== this.state.page.title || this.state.content !== this.state.page.content;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  private publish(state: PageDraftState) {
    if (this.disposed) return;
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }

  edit(changes: Partial<Pick<PageDraftState, 'title' | 'content'>>) {
    if (this.disposed) return;
    const next = { ...this.state, ...changes };
    const changed = next.title !== next.page.title || next.content !== next.page.content;
    const blocked = this.state.status === 'conflict' || this.state.status === 'error';
    this.publish({
      ...next,
      status: blocked ? this.state.status : this.pending ? 'saving' : changed ? 'unsaved' : 'saved',
      error: blocked ? this.state.error : null,
    });
  }

  save(): Promise<boolean> {
    if (this.disposed || this.state.status === 'conflict') return Promise.resolve(false);
    if (this.pending) return this.pending;
    if (!this.hasChanges) {
      this.publish({ ...this.state, status: 'saved', error: null });
      return Promise.resolve(true);
    }
    this.pending = Promise.resolve().then(() => this.flush()).finally(() => {
      this.pending = null;
      // Notify dirty-draft guards once the last request has actually settled.
      this.publish({ ...this.state });
    });
    return this.pending;
  }

  private async flush(): Promise<boolean> {
    while (!this.disposed && this.hasChanges) {
      const sent = this.state;
      if (!sent.title.trim()) {
        this.publish({ ...this.state, status: 'error', error: 'Add a title to save this page.' });
        return false;
      }
      if (sent.content.length > 100_000) {
        this.publish({ ...this.state, status: 'error', error: 'Pages can contain up to 100,000 characters.' });
        return false;
      }
      this.publish({ ...this.state, status: 'saving', error: null });
      try {
        const updated = await this.write(sent.page, {
          title: sent.title,
          content: sent.content,
          expectedRevision: sent.page.revision,
        });
        if (this.disposed) return false;
        const title = this.state.title === sent.title ? updated.title : this.state.title;
        const content = this.state.content === sent.content ? updated.content : this.state.content;
        const stillChanged = title !== updated.title || content !== updated.content;
        this.publish({
          ...this.state,
          page: updated,
          title,
          content,
          status: stillChanged ? 'saving' : 'saved',
          error: null,
        });
      } catch (error) {
        if (this.disposed) return false;
        const conflict = typeof error === 'object' && error !== null && 'status' in error && error.status === 409;
        this.publish({
          ...this.state,
          status: conflict ? 'conflict' : 'error',
          error: conflict
            ? 'This page changed elsewhere. Your draft is preserved. Review the server version before saving.'
            : error instanceof Error ? error.message : 'Could not save the page. Your draft is preserved.',
        });
        return false;
      }
    }
    if (!this.disposed) this.publish({ ...this.state, status: 'saved', error: null });
    return !this.disposed;
  }

  /** Explicit conflict resolution: keep local edits, using the reviewed server revision. */
  rebase(page: Page) {
    if (this.pending || this.disposed) return;
    this.publish({ ...this.state, page, status: 'unsaved', error: null });
  }

  /** Called only after the user confirms discarding their local version. */
  useServerVersion(page: Page) {
    if (this.pending || this.disposed) return;
    this.publish({ page, title: page.title, content: page.content, status: 'saved', error: null });
  }

  dispose() {
    this.disposed = true;
    this.listeners.clear();
  }
}
