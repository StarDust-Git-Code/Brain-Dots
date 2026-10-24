'use client';

import { useEffect, useState } from 'react';
import { api } from '../lib/client';
import type { Dot, Space } from '../lib/types';
import { Button, Input, Modal, Textarea } from './ui';

interface DotDialogProps {
  open: boolean;
  dot: Dot | null;
  spaces: Space[];
  onClose: () => void;
  onSaved: (dot: Dot) => void;
}

export function DotDialog({ open, dot, spaces, onClose, onSaved }: DotDialogProps) {
  const [name, setName] = useState('');
  const [instructions, setInstructions] = useState('');
  const [research, setResearch] = useState(true);
  const [memory, setMemory] = useState(true);
  const [selectedSpaceIds, setSelectedSpaceIds] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(dot?.name ?? '');
    setInstructions(dot?.instructions ?? '');
    setResearch(dot?.researchAllowed ?? true);
    setMemory(dot?.memoryAllowed ?? true);
    setSelectedSpaceIds(dot?.spaceIds ?? (spaces.length > 0 ? [spaces[0].id] : []));
    setError(null);
    setBusy(false);
  }, [open, dot, spaces]);

  const toggleSpace = (id: string) => {
    setSelectedSpaceIds((prev) =>
      prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id],
    );
  };

  const submit = async () => {
    if (busy) return;
    const trimmedName = name.trim();
    const trimmedInstructions = instructions.trim();
    if (!trimmedName) {
      setError('Give your dot a name.');
      return;
    }
    if (trimmedInstructions.length < 3) {
      setError('Instructions must be at least 3 characters.');
      return;
    }
    if (selectedSpaceIds.length === 0) {
      setError('Pick at least one space.');
      return;
    }
    setBusy(true);
    setError(null);
    const payload = {
      name: trimmedName,
      instructions: trimmedInstructions,
      researchAllowed: research,
      memoryAllowed: memory,
      spaceId: selectedSpaceIds[0],
      spaceIds: selectedSpaceIds,
    };
    try {
      const saved = dot
        ? await api<Dot>(`/dots/${dot.id}`, 'PUT', payload)
        : await api<Dot>('/dots', 'POST', payload);
      onSaved(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the dot.');
      setBusy(false);
    }
  };

  return (
    <Modal open={open} title={dot ? 'Edit dot' : 'New dot'} onClose={onClose}>
      <label className="form-field">
        <span className="form-label">Name</span>
        <Input
          value={name}
          maxLength={40}
          onChange={(event) => setName(event.target.value)}
          placeholder="e.g. Research buddy"
        />
      </label>

      <label className="form-field">
        <span className="form-label">Instructions</span>
        <Textarea
          value={instructions}
          maxLength={2000}
          rows={5}
          onChange={(event) => setInstructions(event.target.value)}
          placeholder="How should this dot behave?"
        />
      </label>

      <div className="switch-row">
        <label className="switch">
          <input
            type="checkbox"
            checked={research}
            onChange={(event) => setResearch(event.target.checked)}
          />
          <span className="switch-track">
            <span className="switch-thumb" />
          </span>
          <span>Web research</span>
        </label>
        <label className="switch">
          <input
            type="checkbox"
            checked={memory}
            onChange={(event) => setMemory(event.target.checked)}
          />
          <span className="switch-track">
            <span className="switch-thumb" />
          </span>
          <span>Use memories</span>
        </label>
      </div>

      <div className="form-field">
        <span className="form-label">Spaces (pick at least one)</span>
        {spaces.length === 0 ? (
          <p className="form-hint">No spaces available yet.</p>
        ) : (
          <div className="space-checks">
            {spaces.map((space) => (
              <label key={space.id} className="space-check">
                <input
                  type="checkbox"
                  checked={selectedSpaceIds.includes(space.id)}
                  onChange={() => toggleSpace(space.id)}
                />
                <span>{space.name}</span>
              </label>
            ))}
          </div>
        )}
      </div>

      {error ? <p className="form-error">{error}</p> : null}

      <div className="modal-actions">
        <Button variant="ghost" onClick={onClose} disabled={busy}>
          Cancel
        </Button>
        <Button onClick={() => void submit()} disabled={busy}>
          {busy ? 'Saving…' : dot ? 'Save changes' : 'Create dot'}
        </Button>
      </div>
    </Modal>
  );
}
