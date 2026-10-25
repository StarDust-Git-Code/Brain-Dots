'use client';

import { useEffect, useRef, useState } from 'react';
import { isAbortError, useScopedApi } from '../lib/client';
import type { Dot, Space } from '../lib/types';
import { Button, Input, Modal, Textarea } from './ui';
import { useBeforeUnload } from './useLeaveGuard';

const STARTER_INSTRUCTIONS = 'Help me organize my ideas, connect what I learn, and turn my notes into useful next steps. Ask questions when you need more context.';

interface DotDialogProps {
  dot: Dot | null;
  spaces: Space[];
  onClose: () => void;
  onSaved: (dot: Dot) => void;
  onSpaceCreated: (space: Space) => void;
}

// Mounted per dialog session so adding a Space never resets an in-progress Dot draft.
export function DotDialog({ dot, spaces, onClose, onSaved, onSpaceCreated }: DotDialogProps) {
  const api = useScopedApi();
  const initialSpaces = useRef(dot?.spaceIds ?? (spaces[0] ? [spaces[0].id] : [])).current;
  const [name, setName] = useState(dot?.name ?? 'My second brain');
  const [instructions, setInstructions] = useState(dot?.instructions ?? STARTER_INSTRUCTIONS);
  const [research, setResearch] = useState(dot?.researchAllowed ?? true);
  const [memory, setMemory] = useState(dot?.memoryAllowed ?? true);
  const [selectedSpaceIds, setSelectedSpaceIds] = useState<string[]>(initialSpaces);
  const [creatingSpace, setCreatingSpace] = useState(spaces.length === 0);
  const [spaceName, setSpaceName] = useState('Personal notes');
  const [spaceDescription, setSpaceDescription] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [spaceError, setSpaceError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'dot' | 'space' | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const dirty = name !== (dot?.name ?? 'My second brain')
    || instructions !== (dot?.instructions ?? STARTER_INSTRUCTIONS)
    || research !== (dot?.researchAllowed ?? true)
    || memory !== (dot?.memoryAllowed ?? true)
    || selectedSpaceIds.join(',') !== initialSpaces.join(',')
    || spaceName !== 'Personal notes' || spaceDescription !== '';
  useBeforeUnload(dirty || busy !== null);
  useEffect(() => () => requestRef.current?.abort(), []);

  const close = () => {
    if (requestRef.current) return;
    if (dirty && !window.confirm('Discard your unsaved Dot changes?')) return;
    onClose();
  };

  const toggleSpace = (id: string) => {
    setSelectedSpaceIds((prev) => prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]);
  };

  const createSpace = async () => {
    if (requestRef.current) return;
    if (!spaceName.trim()) {
      setSpaceError('Give your Space a name.');
      return;
    }
    const controller = new AbortController();
    requestRef.current = controller;
    setBusy('space');
    setSpaceError(null);
    try {
      const space = await api<Space>('/spaces', 'POST', {
        name: spaceName.trim(), description: spaceDescription.trim(),
      }, { signal: controller.signal });
      if (controller.signal.aborted) return;
      onSpaceCreated(space);
      setSelectedSpaceIds((prev) => [...prev, space.id]);
      setCreatingSpace(false);
      setSpaceName('Personal notes');
      setSpaceDescription('');
      setError(null);
    } catch (err) {
      if (!isAbortError(err) && !controller.signal.aborted) {
        setSpaceError(err instanceof Error ? err.message : 'Could not create the Space.');
      }
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
      if (!controller.signal.aborted) setBusy(null);
    }
  };

  const submit = async () => {
    if (requestRef.current) return;
    const selected = selectedSpaceIds.filter((id) => spaces.some((space) => space.id === id));
    if (!name.trim()) { setError('Give your Dot a name.'); return; }
    if (instructions.trim().length < 3) { setError('Instructions must be at least 3 characters.'); return; }
    if (!selected.length) { setError('Create or pick at least one Space.'); return; }
    const controller = new AbortController();
    requestRef.current = controller;
    setBusy('dot');
    setError(null);
    const payload = {
      name: name.trim(), instructions: instructions.trim(),
      researchAllowed: research, memoryAllowed: memory,
      spaceId: selected[0], spaceIds: selected,
    };
    try {
      const saved = await api<Dot>(dot ? `/dots/${encodeURIComponent(dot.id)}` : '/dots', dot ? 'PUT' : 'POST', payload, { signal: controller.signal });
      if (!controller.signal.aborted) onSaved(saved);
    } catch (err) {
      if (!isAbortError(err) && !controller.signal.aborted) setError(err instanceof Error ? err.message : 'Could not save the Dot.');
    } finally {
      if (requestRef.current === controller) requestRef.current = null;
      if (!controller.signal.aborted) setBusy(null);
    }
  };

  return (
    <Modal open title={dot ? 'Edit Dot' : 'Create Dot'} onClose={close}>
      <form className="dialog-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <p className="form-hint">Give your Dot a role and connect its Spaces. Enable memories to use the preferences saved in your account.</p>
        <label className="form-field">
          <span className="form-label">Name</span>
          <Input value={name} maxLength={40} required disabled={busy !== null}
            onChange={(event) => setName(event.target.value)} placeholder="e.g. Research buddy" />
        </label>
        <label className="form-field">
          <span className="form-label">Instructions</span>
          <Textarea value={instructions} aria-label="Instructions" maxLength={2000} minLength={3} required rows={5} disabled={busy !== null}
            onChange={(event) => setInstructions(event.target.value)} placeholder="How should this Dot behave?" />
        </label>
        <div className="switch-row">
          <label className="switch">
            <input type="checkbox" checked={research} disabled={busy !== null} onChange={(event) => setResearch(event.target.checked)} />
            <span className="switch-track"><span className="switch-thumb" /></span>
            <span>Allow research</span>
          </label>
          <label className="switch">
            <input type="checkbox" checked={memory} disabled={busy !== null} onChange={(event) => setMemory(event.target.checked)} />
            <span className="switch-track"><span className="switch-thumb" /></span>
            <span>Use memories</span>
          </label>
        </div>
        <div className="form-field">
          <div className="pages-list-head">
            <span className="form-label">Spaces (pick at least one)</span>
            {!creatingSpace ? <Button small variant="ghost" disabled={busy !== null} onClick={() => setCreatingSpace(true)}>+ Create Space</Button> : null}
          </div>
          {spaces.length > 0 ? (
            <div className="space-checks">
              {spaces.map((space) => (
                <label key={space.id} className="space-check">
                  <input type="checkbox" checked={selectedSpaceIds.includes(space.id)} disabled={busy !== null} onChange={() => toggleSpace(space.id)} />
                  <span>{space.name}</span>
                </label>
              ))}
            </div>
          ) : <p className="form-hint">Create your first Space below, then finish your Dot.</p>}
        </div>
        {creatingSpace ? (
          <fieldset className="inline-space-form" disabled={busy !== null}>
            <legend className="form-label">Create Space</legend>
            <label className="form-field">
              <span className="form-label">Space name</span>
              <Input value={spaceName} maxLength={60} onChange={(event) => setSpaceName(event.target.value)} />
            </label>
            <label className="form-field">
              <span className="form-label">Description (optional)</span>
              <Textarea value={spaceDescription} aria-label="Space description (optional)" maxLength={500} rows={2} onChange={(event) => setSpaceDescription(event.target.value)} />
            </label>
            {spaceError ? <p className="form-error" role="alert">{spaceError}</p> : null}
            <div className="inline-actions">
              <Button small onClick={() => void createSpace()} disabled={busy !== null || !spaceName.trim()}>{busy === 'space' ? 'Creating…' : 'Create Space'}</Button>
              {spaces.length > 0 ? <Button small variant="ghost" onClick={() => setCreatingSpace(false)}>Cancel</Button> : null}
            </div>
          </fieldset>
        ) : null}
        {error ? <p className="form-error" role="alert">{error}</p> : null}
        <div className="modal-actions">
          <Button variant="ghost" onClick={close} disabled={busy !== null}>Cancel</Button>
          <Button type="submit" disabled={busy !== null || selectedSpaceIds.length === 0}>
            {busy === 'dot' ? 'Saving…' : dot ? 'Save changes' : 'Create Dot'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
