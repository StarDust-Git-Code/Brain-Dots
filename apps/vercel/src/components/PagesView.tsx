'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { isAbortError, useScopedApi } from '../lib/client';
import type { Page, Space } from '../lib/types';
import { PageDraftSession, type PageDraftState } from './pageDrafts';
import { Button, EmptyState, Spinner, relativeTime } from './ui';
import { useBeforeUnload, type RegisterLeaveGuard } from './useLeaveGuard';

interface PagesViewProps {
  spaceId: string;
  spaces: Space[];
  registerLeaveGuard: RegisterLeaveGuard;
}

export function PagesView({ spaceId, spaces, registerLeaveGuard }: PagesViewProps) {
  const api = useScopedApi();
  const [pages, setPages] = useState<Page[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [pageId, setPageId] = useState<string | null>(null);
  const [draft, setDraft] = useState<PageDraftState | null>(null);
  const [serverPage, setServerPage] = useState<Page | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const sessionsRef = useRef(new Map<string, PageDraftSession>());
  const selectedRef = useRef<PageDraftSession | null>(null);
  const mountedRef = useRef(false);
  const lifetimeRef = useRef<AbortController | null>(null);
  const listRequestRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leavingRef = useRef(false);
  const actionLockRef = useRef(false);
  const spaceName = spaces.find((space) => space.id === spaceId)?.name ?? 'Space';

  const clearAutosave = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const activatePage = useCallback((page: Page) => {
    let session = sessionsRef.current.get(page.id);
    if (!session) {
      session = new PageDraftSession(page, async (target, changes) => {
        const updated = await api<Page>(`/spaces/${encodeURIComponent(spaceId)}/pages/${encodeURIComponent(target.id)}`, 'PATCH', changes, { signal: lifetimeRef.current?.signal });
        if (updated.id !== target.id || updated.spaceId !== spaceId) throw new Error('The server returned a different page. Your draft is preserved.');
        if (mountedRef.current) setPages((prev) => prev.map((item) => item.id === updated.id ? updated : item));
        return updated;
      });
      sessionsRef.current.set(page.id, session);
    }
    selectedRef.current = session;
    setPageId(page.id);
    setDraft(session.getSnapshot());
    setServerPage(null);
    setActionError(null);
  }, [spaceId, api]);

  const loadPages = useCallback(async () => {
    listRequestRef.current?.abort();
    const controller = new AbortController();
    listRequestRef.current = controller;
    setListLoading(true);
    setListError(null);
    try {
      const list = await api<Page[]>(`/spaces/${encodeURIComponent(spaceId)}/pages`, 'GET', undefined, { signal: controller.signal });
      if (controller.signal.aborted || !mountedRef.current) return;
      setPages(list);
      if (!selectedRef.current && list[0]) activatePage(list[0]);
    } catch (err) {
      if (!isAbortError(err) && !controller.signal.aborted && mountedRef.current) setListError(err instanceof Error ? err.message : 'Could not load pages.');
    } finally {
      if (!controller.signal.aborted && mountedRef.current) setListLoading(false);
    }
  }, [spaceId, activatePage, api]);

  useEffect(() => {
    mountedRef.current = true;
    lifetimeRef.current = new AbortController();
    setPages([]);
    setPageId(null);
    setDraft(null);
    selectedRef.current = null;
    void loadPages();
    return () => {
      mountedRef.current = false;
      lifetimeRef.current?.abort();
      listRequestRef.current?.abort();
      clearAutosave();
      sessionsRef.current.forEach((session) => session.dispose());
      sessionsRef.current.clear();
    };
  }, [loadPages, clearAutosave]);

  useEffect(() => {
    const session = pageId ? sessionsRef.current.get(pageId) : null;
    if (!session) return;
    setDraft(session.getSnapshot());
    return session.subscribe(() => {
      if (mountedRef.current && selectedRef.current === session) setDraft(session.getSnapshot());
    });
  }, [pageId]);

  useEffect(() => {
    clearAutosave();
    if (draft?.status !== 'unsaved' || leaving || actionBusy) return;
    const session = selectedRef.current;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void session?.save();
    }, 800);
    return clearAutosave;
  }, [draft, leaving, actionBusy, clearAutosave]);

  const saveBeforeLeave = useCallback(async (): Promise<boolean> => {
    if (leavingRef.current) return false;
    if (actionLockRef.current) {
      setActionError('Wait for the current page action to finish before leaving.');
      return false;
    }
    clearAutosave();
    leavingRef.current = true;
    setLeaving(true);
    try {
      for (const session of Array.from(sessionsRef.current.values())) {
        if (session.dirty && !await session.save()) return false;
      }
      return mountedRef.current && !Array.from(sessionsRef.current.values()).some((session) => session.dirty);
    } finally {
      leavingRef.current = false;
      if (mountedRef.current) setLeaving(false);
    }
  }, [clearAutosave]);

  useEffect(() => {
    registerLeaveGuard(saveBeforeLeave);
    return () => registerLeaveGuard(null);
  }, [registerLeaveGuard, saveBeforeLeave]);

  useBeforeUnload(Array.from(sessionsRef.current.values()).some((session) => session.dirty) || actionBusy);

  const selectPage = async (page: Page) => {
    if (page.id === pageId || actionLockRef.current) return;
    if (await saveBeforeLeave()) activatePage(page);
  };

  const createPage = async () => {
    if (actionLockRef.current || !await saveBeforeLeave()) return;
    actionLockRef.current = true;
    setActionBusy(true);
    setActionError(null);
    try {
      const created = await api<Page>(`/spaces/${encodeURIComponent(spaceId)}/pages`, 'POST', {
        title: 'Untitled page', content: '', parentId: null,
      }, { signal: lifetimeRef.current?.signal });
      if (!mountedRef.current) return;
      setPages((prev) => [created, ...prev]);
      activatePage(created);
    } catch (err) {
      if (!isAbortError(err) && mountedRef.current) setActionError(err instanceof Error ? err.message : 'Could not create the page.');
    } finally {
      actionLockRef.current = false;
      if (mountedRef.current) setActionBusy(false);
    }
  };

  const reviewServerVersion = async () => {
    const session = selectedRef.current;
    if (!session || actionLockRef.current) return;
    actionLockRef.current = true;
    setActionBusy(true);
    setActionError(null);
    try {
      const fresh = await api<Page>(`/spaces/${encodeURIComponent(spaceId)}/pages/${encodeURIComponent(session.getSnapshot().page.id)}`, 'GET', undefined, { signal: lifetimeRef.current?.signal });
      if (fresh.id !== session.getSnapshot().page.id || fresh.spaceId !== spaceId) throw new Error('The server returned a different page. Your draft is preserved.');
      if (mountedRef.current && selectedRef.current === session) setServerPage(fresh);
    } catch (err) {
      if (!isAbortError(err) && mountedRef.current) setActionError(err instanceof Error ? err.message : 'Could not load the server version. Your draft is preserved.');
    } finally {
      actionLockRef.current = false;
      if (mountedRef.current) setActionBusy(false);
    }
  };

  const saveMyVersion = async () => {
    const session = selectedRef.current;
    if (!session || !serverPage || serverPage.id !== session.getSnapshot().page.id) return;
    session.rebase(serverPage);
    setServerPage(null);
    clearAutosave();
    await session.save();
  };

  const useServerVersion = () => {
    const session = selectedRef.current;
    if (!session || !serverPage || serverPage.id !== session.getSnapshot().page.id) return;
    if (!window.confirm('Replace your draft with the reviewed server version? Your unsaved edits will be discarded.')) return;
    session.useServerVersion(serverPage);
    setPages((prev) => prev.map((page) => page.id === serverPage.id ? serverPage : page));
    setServerPage(null);
  };

  const locked = leaving || actionBusy;
  return (
    <div className="pages">
      <aside className="pages-list" aria-label="Pages in this Space">
        <div className="pages-list-head">
          <h2 className="panel-title">{spaceName}</h2>
          <Button small variant="ghost" onClick={() => void createPage()} disabled={locked || listLoading}>+ New page</Button>
        </div>
        {listLoading ? <Spinner label="Loading pages…" /> : listError ? (
          <div className="inline-error"><p className="form-error" role="alert">{listError}</p><Button small variant="ghost" onClick={() => void loadPages()}>Retry</Button></div>
        ) : pages.length === 0 ? (
          <EmptyState title="No pages yet" hint="Capture your first idea in this Space." action={<Button small onClick={() => void createPage()} disabled={locked}>Create a page</Button>} />
        ) : (
          <ul className="page-items">
            {pages.map((page) => (
              <li key={page.id}>
                <button className={`page-item${page.id === pageId ? ' active' : ''}`} disabled={locked}
                  aria-current={page.id === pageId ? 'page' : undefined} onClick={() => void selectPage(page)}>
                  <span className="page-item-title">{page.id === pageId ? draft?.title || 'Untitled page' : page.title}</span>
                  <span className="page-item-time">{relativeTime(page.updatedAt)}{sessionsRef.current.get(page.id)?.dirty ? ' · Unsaved' : ''}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>
      <section className="page-editor" aria-label="Page editor">
        {!draft ? <EmptyState title="Select a page" hint="Choose a page, or create one to start writing." /> : (
          <>
            {draft.status === 'conflict' ? (
              <div className="conflict-banner" role="alert">
                <span>{draft.error}</span>
                <Button small variant="ghost" disabled={locked} onClick={() => void reviewServerVersion()}>{actionBusy ? 'Loading…' : 'Review server version'}</Button>
              </div>
            ) : null}
            {serverPage ? (
              <div className="conflict-review">
                <details open>
                  <summary>Server version · revision {serverPage.revision}</summary>
                  <h3>{serverPage.title}</h3><pre>{serverPage.content || '(Empty page)'}</pre>
                </details>
                <p className="form-hint">Your draft stays in the editor below. Saving your version replaces the reviewed server content; a newer server change will trigger another conflict.</p>
                <div className="inline-actions">
                  <Button small disabled={locked} onClick={() => void saveMyVersion()}>Save my version</Button>
                  <Button small variant="ghost" disabled={locked} onClick={useServerVersion}>Use server version</Button>
                </div>
              </div>
            ) : null}
            <div className="editor-head">
              <input className="editor-title" value={draft.title} maxLength={160} disabled={locked}
                onChange={(event) => selectedRef.current?.edit({ title: event.target.value })}
                placeholder="Page title" aria-label="Page title" />
              <span className={`save-status save-status--${draft.status}`} role="status">
                {leaving ? 'Saving before leaving…' : draft.status === 'saved' ? 'Saved' : draft.status === 'saving' ? 'Saving…' : draft.status === 'conflict' ? 'Conflict' : 'Unsaved'}
              </span>
              <Button small variant="ghost" disabled={locked || draft.status === 'saved' || draft.status === 'conflict'}
                onClick={() => { clearAutosave(); void selectedRef.current?.save(); }}>
                {draft.status === 'error' ? 'Retry save' : 'Save now'}
              </Button>
            </div>
            <textarea className="editor-content" value={draft.content} maxLength={100_000} disabled={locked}
              onChange={(event) => selectedRef.current?.edit({ content: event.target.value })}
              placeholder="Write an idea, a question, or something you learned…" aria-label="Page content" spellCheck={false} />
            <p className="form-hint">Changes save automatically. Switching pages or views waits for your draft to save.</p>
            {draft.error && draft.status !== 'conflict' ? <p className="form-error" role="alert">{draft.error} Your draft is still here.</p> : null}
          </>
        )}
        {actionError ? <p className="form-error" role="alert">{actionError}</p> : null}
      </section>
    </div>
  );
}
