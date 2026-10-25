'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { isAbortError, useScopedApi } from '../lib/client';
import type { Memory } from '../lib/types';
import { Button, EmptyState, Input, Modal, Spinner, Textarea, relativeTime } from './ui';
import { useBeforeUnload, type RegisterLeaveGuard } from './useLeaveGuard';

interface MemoriesViewProps {
  registerLeaveGuard: RegisterLeaveGuard;
}

export function MemoriesView({ registerLeaveGuard }: MemoriesViewProps) {
  const api = useScopedApi();
  const [memories, setMemories] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [newText, setNewText] = useState('');
  const [query, setQuery] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [deleteTarget, setDeleteTarget] = useState<Memory | null>(null);
  const [busy, setBusy] = useState<'create' | 'edit' | 'delete' | null>(null);
  const mountedRef = useRef(false);
  const listRequestRef = useRef<AbortController | null>(null);
  const mutationRef = useRef<AbortController | null>(null);
  const newTextRef = useRef(newText);
  const editRef = useRef({ id: null as string | null, text: '', original: '' });
  newTextRef.current = newText;
  editRef.current.id = editingId;
  editRef.current.text = editText;

  const refresh = useCallback(async () => {
    if (mutationRef.current) return;
    listRequestRef.current?.abort();
    const controller = new AbortController();
    listRequestRef.current = controller;
    setLoading(true);
    setListError(null);
    try {
      const list = await api<Memory[]>('/memories', 'GET', undefined, { signal: controller.signal });
      if (mountedRef.current && !controller.signal.aborted) setMemories(list);
    } catch (err) {
      if (mountedRef.current && !controller.signal.aborted && !isAbortError(err)) setListError(err instanceof Error ? err.message : 'Could not load memories.');
    } finally {
      if (mountedRef.current && !controller.signal.aborted) setLoading(false);
    }
  }, [api]);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    return () => {
      mountedRef.current = false;
      listRequestRef.current?.abort();
      mutationRef.current?.abort();
    };
  }, [refresh]);

  useEffect(() => {
    registerLeaveGuard(() => {
      if (mutationRef.current) {
        setActionError('Wait for your memory changes to finish before leaving.');
        return false;
      }
      const dirty = newTextRef.current !== '' || editRef.current.text !== editRef.current.original;
      return !dirty || window.confirm('Leave Memories and discard your unsaved memory changes?');
    });
    return () => registerLeaveGuard(null);
  }, [registerLeaveGuard]);

  useBeforeUnload(newText !== '' || editText !== editRef.current.original || busy !== null);

  const mutate = async <T,>(kind: 'create' | 'edit' | 'delete', request: (signal: AbortSignal) => Promise<T>, commit: (result: T) => void) => {
    if (mutationRef.current) return;
    const controller = new AbortController();
    mutationRef.current = controller;
    listRequestRef.current?.abort();
    setLoading(false);
    setBusy(kind);
    setActionError(null);
    setNotice(null);
    try {
      const result = await request(controller.signal);
      if (mountedRef.current && !controller.signal.aborted) commit(result);
    } catch (err) {
      if (mountedRef.current && !controller.signal.aborted && !isAbortError(err)) setActionError(err instanceof Error ? err.message : 'Could not save your memory changes. Your draft is preserved.');
    } finally {
      if (mutationRef.current === controller) mutationRef.current = null;
      if (mountedRef.current && !controller.signal.aborted) setBusy(null);
    }
  };

  const createMemory = async () => {
    const raw = newTextRef.current;
    if (!raw.trim()) return;
    await mutate('create', (signal) => api<Memory>('/memories', 'POST', { text: raw.trim() }, { signal }), (saved) => {
      setMemories((prev) => [saved, ...prev.filter((memory) => memory.id !== saved.id)]);
      setNewText((current) => current === raw ? '' : current);
      setNotice('Memory saved.');
    });
  };

  const startEdit = (memory: Memory) => {
    if (mutationRef.current) return;
    if (editRef.current.id === memory.id) return;
    if (editRef.current.text !== editRef.current.original && !window.confirm('Discard your unsaved changes to the other memory?')) return;
    editRef.current = { id: memory.id, text: memory.text, original: memory.text };
    setEditingId(memory.id);
    setEditText(memory.text);
    setActionError(null);
    setNotice(null);
  };

  const cancelEdit = () => {
    if (mutationRef.current) return;
    if (editRef.current.text !== editRef.current.original && !window.confirm('Discard your unsaved memory changes?')) return;
    editRef.current = { id: null, text: '', original: '' };
    setEditingId(null);
    setEditText('');
    setActionError(null);
  };

  const saveMemory = async () => {
    const { id, text } = editRef.current;
    if (!id || !text.trim()) return;
    await mutate('edit', (signal) => api<Memory>(`/memories/${encodeURIComponent(id)}`, 'PUT', { text: text.trim() }, { signal }), (saved) => {
      setMemories((prev) => prev.map((memory) => memory.id === saved.id ? saved : memory));
      if (editRef.current.id === id && editRef.current.text === text) {
        editRef.current = { id: null, text: '', original: '' };
        setEditingId(null);
        setEditText('');
      } else if (editRef.current.id === id) {
        editRef.current.original = saved.text;
      }
      setNotice('Memory updated.');
    });
  };

  const deleteMemory = async () => {
    if (!deleteTarget) return;
    const target = deleteTarget;
    await mutate('delete', (signal) => api<{ ok: boolean }>(`/memories/${encodeURIComponent(target.id)}`, 'DELETE', undefined, { signal }), () => {
      setMemories((prev) => prev.filter((memory) => memory.id !== target.id));
      if (editRef.current.id === target.id) {
        editRef.current = { id: null, text: '', original: '' };
        setEditingId(null);
        setEditText('');
      }
      setDeleteTarget(null);
      setNotice('Memory deleted.');
    });
  };

  const visible = memories.filter((memory) => memory.text.toLowerCase().includes(query.trim().toLowerCase()));
  return (
    <div className="memories">
      <header className="view-head view-head--actions">
        <div>
          <h1 className="view-title">Memories</h1>
          <p className="view-sub">Preferences and context for Dots with “Use memories” enabled. Memories belong to your account.</p>
        </div>
        <Button small variant="ghost" disabled={busy !== null || loading} onClick={() => void refresh()}>Refresh</Button>
      </header>
      <div className="memories-body">
        <form className="memory-create" onSubmit={(event) => { event.preventDefault(); void createMemory(); }}>
          <label className="form-field">
            <span className="form-label">What should your Dots remember?</span>
            <Textarea value={newText} aria-label="What should your Dots remember?" maxLength={2000} rows={3}
              placeholder="e.g. I prefer concise answers with concrete examples."
              onChange={(event) => { newTextRef.current = event.target.value; setNewText(event.target.value); }} />
          </label>
          <div className="composer-foot">
            <span className="form-hint">{newText.length}/2000 characters</span>
            <Button type="submit" small disabled={!newText.trim() || busy !== null}>{busy === 'create' ? 'Saving…' : 'Save memory'}</Button>
          </div>
        </form>
        {actionError ? <p className="form-error" role="alert">{actionError}</p> : null}
        {notice ? <p className="view-notice" role="status">{notice}</p> : null}
        <div className="memory-list-head">
          <h2 className="panel-title">Saved memories{loading ? '' : ` (${memories.length})`}</h2>
          <Input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a memory…" aria-label="Find a memory" />
        </div>
        {listError ? <div className="inline-error"><p className="form-error" role="alert">{listError}</p><Button small variant="ghost" onClick={() => void refresh()} disabled={busy !== null}>Retry</Button></div> : null}
        {loading ? <div className="tasks-loading"><Spinner label="Loading memories…" /></div> : memories.length === 0 && !listError ? (
          <EmptyState title="A little context goes a long way" hint="Save a preference, a goal, or something about yourself above. You can edit or remove it at any time." />
        ) : visible.length === 0 && !listError ? <EmptyState title="No matching memories" hint="Try another search." /> : (
          <ul className="memory-list">
            {visible.map((memory) => (
              <li key={memory.id} className="memory-item">
                {editingId === memory.id ? (
                  <form className="memory-edit" onSubmit={(event) => { event.preventDefault(); void saveMemory(); }}>
                    <label className="form-field">
                      <span className="form-label">Edit memory</span>
                      <Textarea value={editText} aria-label="Edit memory" maxLength={2000} rows={4} disabled={busy === 'edit'}
                        onChange={(event) => { editRef.current.text = event.target.value; setEditText(event.target.value); }} />
                    </label>
                    <div className="inline-actions">
                      <Button type="submit" small disabled={busy !== null || !editText.trim()}>{busy === 'edit' ? 'Saving…' : 'Save changes'}</Button>
                      <Button small variant="ghost" onClick={cancelEdit} disabled={busy !== null}>Cancel</Button>
                    </div>
                  </form>
                ) : <p className="memory-text">{memory.text}</p>}
                <div className="memory-item-foot">
                  <span className="form-hint">Saved {relativeTime(memory.createdAt)}</span>
                  <div className="inline-actions">
                    {editingId !== memory.id ? <Button small variant="ghost" onClick={() => startEdit(memory)} disabled={busy !== null}>Edit</Button> : null}
                    <Button small variant="danger" onClick={() => setDeleteTarget(memory)} disabled={busy !== null}>Delete</Button>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <Modal open={deleteTarget !== null} title="Delete memory?" onClose={() => { if (!mutationRef.current) setDeleteTarget(null); }}>
        <p>This removes the saved memory from your account.{editingId === deleteTarget?.id ? ' Any unsaved edits to it will also be discarded.' : ''}</p>
        <p className="memory-text memory-delete-preview">{deleteTarget?.text}</p>
        {actionError ? <p className="form-error" role="alert">{actionError}</p> : null}
        <div className="modal-actions">
          <Button variant="ghost" disabled={busy !== null} onClick={() => setDeleteTarget(null)}>Keep memory</Button>
          <Button variant="danger" disabled={busy !== null} onClick={() => void deleteMemory()}>{busy === 'delete' ? 'Deleting…' : 'Delete memory'}</Button>
        </div>
      </Modal>
    </div>
  );
}
