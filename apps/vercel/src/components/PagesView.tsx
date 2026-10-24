'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../lib/client';
import type { Page, Space } from '../lib/types';
import { Button, EmptyState, Spinner, relativeTime } from './ui';

type SaveStatus = 'saved' | 'saving' | 'unsaved' | 'conflict';

interface PagesViewProps {
  spaceId: string;
  spaces: Space[];
}

export function PagesView({ spaceId, spaces }: PagesViewProps) {
  const [pages, setPages] = useState<Page[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [pageId, setPageId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [status, setStatus] = useState<SaveStatus>('saved');
  const [actionError, setActionError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);

  const page = pages.find((p) => p.id === pageId) ?? null;
  const spaceName = spaces.find((s) => s.id === spaceId)?.name ?? 'Space';

  useEffect(() => {
    let cancelled = false;
    setListLoading(true);
    setListError(null);
    setPages([]);
    setPageId(null);
    setStatus('saved');
    setActionError(null);
    api<Page[]>(`/spaces/${spaceId}/pages`)
      .then((list) => {
        if (!cancelled) setPages(list);
      })
      .catch((err: unknown) => {
        if (!cancelled) setListError(err instanceof Error ? err.message : 'Could not load pages.');
      })
      .finally(() => {
        if (!cancelled) setListLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [spaceId]);

  const save = useCallback(async () => {
    if (!page || savingRef.current) return;
    const target = page;
    savingRef.current = true;
    setStatus('saving');
    try {
      const updated = await api<Page>(`/spaces/${spaceId}/pages/${target.id}`, 'PATCH', {
        title,
        content,
        expectedRevision: target.revision,
      });
      setPages((prev) => prev.map((p) => (p.id === updated.id ? updated : p)));
      setStatus('saved');
      setActionError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setStatus('conflict');
      } else {
        setStatus('unsaved');
        setActionError(err instanceof Error ? err.message : 'Could not save the page.');
      }
    } finally {
      savingRef.current = false;
    }
  }, [page, title, content, spaceId]);

  useEffect(() => {
    if (!page || status === 'conflict' || status === 'saving') return;
    if (title === page.title && content === page.content) return;
    if (title.trim().length === 0) {
      setStatus('unsaved');
      setActionError('Add a title to save this page.');
      return;
    }
    setStatus('unsaved');
    const timer = setTimeout(() => {
      void save();
    }, 800);
    return () => {
      clearTimeout(timer);
    };
  }, [title, content, page, status, save]);

  const selectPage = (next: Page) => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (status === 'unsaved' && title.trim().length > 0) {
      void save();
    }
    setPageId(next.id);
    setTitle(next.title);
    setContent(next.content);
    setStatus('saved');
    setActionError(null);
  };

  const reloadPage = async () => {
    if (!page) return;
    try {
      const fresh = await api<Page>(`/spaces/${spaceId}/pages/${page.id}`);
      setPages((prev) => prev.map((p) => (p.id === fresh.id ? fresh : p)));
      setTitle(fresh.title);
      setContent(fresh.content);
      setStatus('saved');
      setActionError(null);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not reload the page.');
    }
  };

  const createPage = async () => {
    setActionError(null);
    try {
      const created = await api<Page>(`/spaces/${spaceId}/pages`, 'POST', {
        title: 'Untitled page',
        content: '',
        parentId: null,
      });
      setPages((prev) => [created, ...prev]);
      selectPage(created);
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Could not create the page.');
    }
  };

  return (
    <div className="pages">
      <aside className="pages-list">
        <div className="pages-list-head">
          <h2 className="panel-title">{spaceName}</h2>
          <Button small variant="ghost" onClick={() => void createPage()}>
            + New page
          </Button>
        </div>
        {listLoading ? (
          <Spinner />
        ) : listError ? (
          <p className="view-error">{listError}</p>
        ) : pages.length === 0 ? (
          <EmptyState title="No pages yet" hint="Create the first page for this space." />
        ) : (
          <ul className="page-items">
            {pages.map((p) => (
              <li key={p.id}>
                <button
                  className={`page-item${p.id === pageId ? ' active' : ''}`}
                  onClick={() => selectPage(p)}
                >
                  <span className="page-item-title">{p.title}</span>
                  <span className="page-item-time">{relativeTime(p.updatedAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </aside>

      <section className="page-editor">
        {!page ? (
          <EmptyState
            title="Select a page"
            hint="Choose a page on the left, or create a new one."
          />
        ) : (
          <>
            {status === 'conflict' ? (
              <div className="conflict-banner">
                <span>This page changed elsewhere. Reload?</span>
                <Button small onClick={() => void reloadPage()}>
                  Reload
                </Button>
              </div>
            ) : null}
            <div className="editor-head">
              <input
                className="editor-title"
                value={title}
                maxLength={160}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Page title"
                aria-label="Page title"
              />
              <span className={`save-status save-status--${status}`}>
                {status === 'saved'
                  ? 'Saved'
                  : status === 'saving'
                    ? 'Saving…'
                    : status === 'unsaved'
                      ? 'Unsaved'
                      : 'Conflict'}
              </span>
            </div>
            <textarea
              className="editor-content"
              value={content}
              onChange={(event) => setContent(event.target.value)}
              placeholder="Write here…"
              aria-label="Page content"
              spellCheck={false}
            />
          </>
        )}
        {actionError ? <p className="view-error">{actionError}</p> : null}
      </section>
    </div>
  );
}
