'use client';

import type { Dot, Space } from '../lib/types';
import { Button } from './ui';

interface OnboardingViewProps {
  spaces: Space[];
  dots: Dot[];
  onCreateSpace: () => void;
  onCreateDot: () => void;
  onSelectSpace: (id: string) => void;
  onSelectDot: (id: string) => void;
  onSelectMemories: () => void;
}

export function OnboardingView({ spaces, dots, onCreateSpace, onCreateDot, onSelectSpace, onSelectDot, onSelectMemories }: OnboardingViewProps) {
  const ready = spaces.length > 0 && dots.length > 0;
  return (
    <div className="onboarding">
      <header className="view-head">
        <h1 className="view-title">{ready ? 'Your second brain' : 'Start your second brain'}</h1>
        <p className="view-sub">Collect ideas in Spaces, think them through with Dots, and keep your preferences in Memories.</p>
      </header>
      <div className="onboarding-body">
        <ol className="setup-steps" aria-label="Workspace setup">
          <li className={`setup-step${spaces.length ? ' setup-step--done' : ''}`}>
            <span className="setup-step-number" aria-hidden="true">{spaces.length ? '✓' : '1'}</span>
            <div className="setup-step-copy">
              <h2>Create a Space</h2>
              <p>{spaces.length ? `${spaces[0].name} is ready for your notes.` : 'Choose a home for your pages: personal notes, a project, or a topic you’re learning.'}</p>
            </div>
            <Button variant={spaces.length ? 'ghost' : 'primary'} onClick={spaces[0] ? () => onSelectSpace(spaces[0].id) : onCreateSpace}>
              {spaces.length ? 'Open Space' : 'Create Space'}
            </Button>
          </li>
          <li className={`setup-step${dots.length ? ' setup-step--done' : ''}`}>
            <span className="setup-step-number" aria-hidden="true">{dots.length ? '✓' : '2'}</span>
            <div className="setup-step-copy">
              <h2>Create a Dot</h2>
              <p>{dots.length ? `${dots[0].name} is ready to talk.` : 'Give your assistant a role, connect a Space, and choose whether it can use your memories.'}</p>
            </div>
            <Button variant={dots.length || !spaces.length ? 'ghost' : 'primary'} onClick={dots[0] ? () => onSelectDot(dots[0].id) : onCreateDot}>
              {dots.length ? 'Chat with Dot' : 'Create Dot'}
            </Button>
          </li>
        </ol>
        <section className="first-thought">
          <h2>Start with something worth remembering</h2>
          <p>A question you’re exploring, a note from today, or a preference like “I learn best from concrete examples.”</p>
          <div className="inline-actions">
            {spaces[0] ? <Button variant="ghost" onClick={() => onSelectSpace(spaces[0].id)}>Write a page</Button> : null}
            <Button variant="ghost" onClick={onSelectMemories}>Add a memory</Button>
          </div>
        </section>
      </div>
    </div>
  );
}
