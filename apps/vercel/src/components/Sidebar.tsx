'use client';

import type { Dot, Space } from '../lib/types';
import type { AppView } from './ui';
import { Button } from './ui';

interface SidebarProps {
  userEmail: string;
  dots: Dot[];
  spaces: Space[];
  activeTaskCount: number;
  selectedDotId: string | null;
  selectedSpaceId: string | null;
  selectedView: AppView;
  onSelectDot: (dotId: string) => void;
  onNewDot: () => void;
  onEditDot: (dot: Dot) => void;
  onSelectSpace: (spaceId: string) => void;
  onSelectTasks: () => void;
  onSignOut: () => void;
}

export function Sidebar({
  userEmail,
  dots,
  spaces,
  activeTaskCount,
  selectedDotId,
  selectedSpaceId,
  selectedView,
  onSelectDot,
  onNewDot,
  onEditDot,
  onSelectSpace,
  onSelectTasks,
  onSignOut,
}: SidebarProps) {
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">OpenDots</div>

      <section className="sidebar-section">
        <div className="sidebar-section-head">
          <span className="sidebar-label">Dots</span>
          <button className="sidebar-add" onClick={onNewDot}>
            + New Dot
          </button>
        </div>
        {dots.length === 0 ? (
          <p className="sidebar-empty">No dots yet.</p>
        ) : (
          <ul className="sidebar-list">
            {dots.map((dot) => (
              <li key={dot.id}>
                <div
                  className={`sidebar-item${
                    selectedView === 'chat' && selectedDotId === dot.id ? ' active' : ''
                  }`}
                >
                  <button className="sidebar-item-main" onClick={() => onSelectDot(dot.id)}>
                    <span className="sidebar-item-name">{dot.name}</span>
                    <span className="sidebar-item-sub">
                      {dot.spaceIds.length} {dot.spaceIds.length === 1 ? 'space' : 'spaces'}
                    </span>
                  </button>
                  <button
                    className="sidebar-item-edit"
                    onClick={() => onEditDot(dot)}
                    aria-label={`Edit ${dot.name}`}
                  >
                    Edit
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="sidebar-section">
        <div className="sidebar-section-head">
          <span className="sidebar-label">Spaces</span>
        </div>
        {spaces.length === 0 ? (
          <p className="sidebar-empty">No spaces yet.</p>
        ) : (
          <ul className="sidebar-list">
            {spaces.map((space) => (
              <li key={space.id}>
                <button
                  className={`sidebar-item sidebar-space${
                    selectedView === 'pages' && selectedSpaceId === space.id ? ' active' : ''
                  }`}
                  onClick={() => onSelectSpace(space.id)}
                >
                  <span className="sidebar-item-name">{space.name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="sidebar-section">
        <div className="sidebar-section-head">
          <span className="sidebar-label">Activity</span>
        </div>
        <button
          className={`sidebar-item sidebar-tasks${selectedView === 'tasks' ? ' active' : ''}`}
          onClick={onSelectTasks}
        >
          <span>Tasks</span>
          {activeTaskCount > 0 ? <span className="badge">{activeTaskCount}</span> : null}
        </button>
      </section>

      <div className="sidebar-footer">
        <span className="sidebar-email">{userEmail}</span>
        <Button variant="ghost" small onClick={onSignOut}>
          Sign out
        </Button>
      </div>
    </aside>
  );
}
