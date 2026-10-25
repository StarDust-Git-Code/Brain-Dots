'use client';

import { useEffect, useRef, useState } from 'react';
import { isAbortError, useScopedApi } from '../lib/client';
import type { Space } from '../lib/types';
import { Button, Input, Modal, Textarea } from './ui';
import { useBeforeUnload } from './useLeaveGuard';

interface SpaceDialogProps {
  onClose: () => void;
  onSaved: (space: Space) => void;
}

export function SpaceDialog({ onClose, onSaved }: SpaceDialogProps) {
  const api = useScopedApi();
  const [name, setName] = useState('Personal notes');
  const [description, setDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const requestRef = useRef<AbortController | null>(null);
  const dirty = name !== 'Personal notes' || description !== '';
  useBeforeUnload(dirty || busy);

  useEffect(() => () => requestRef.current?.abort(), []);

  const close = () => {
    if (requestRef.current) return;
    if (dirty && !window.confirm('Discard this new Space draft?')) return;
    onClose();
  };

  const submit = async () => {
    if (requestRef.current) return;
    if (!name.trim()) {
      setError('Give your Space a name.');
      return;
    }
    const controller = new AbortController();
    requestRef.current = controller;
    setBusy(true);
    setError(null);
    try {
      const space = await api<Space>('/spaces', 'POST', {
        name: name.trim(),
        description: description.trim(),
      }, { signal: controller.signal });
      if (!controller.signal.aborted) onSaved(space);
    } catch (err) {
      if (!isAbortError(err) && !controller.signal.aborted) {
        setError(err instanceof Error ? err.message : 'Could not create the Space.');
      }
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  };

  return (
    <Modal open title="Create Space" onClose={close}>
      <form className="dialog-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <p className="form-hint">A Space holds pages for a project, topic, or part of your life. Connect it to a Dot next.</p>
        <label className="form-field">
          <span className="form-label">Name</span>
          <Input value={name} maxLength={60} required disabled={busy}
            onChange={(event) => setName(event.target.value)} placeholder="e.g. Personal notes" />
        </label>
        <label className="form-field">
          <span className="form-label">Description (optional)</span>
          <Textarea value={description} aria-label="Description (optional)" maxLength={500} rows={3} disabled={busy}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="What will you collect here?" />
        </label>
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="modal-actions">
          <Button variant="ghost" onClick={close} disabled={busy}>Cancel</Button>
          <Button type="submit" disabled={busy || !name.trim()}>{busy ? 'Creating…' : 'Create Space'}</Button>
        </div>
      </form>
    </Modal>
  );
}
