'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { api, signOutUser, useAuthState } from '../lib/client';
import type { Conversation, Dot, Space, Task } from '../lib/types';
import { ChatView } from '../components/ChatView';
import { DotDialog } from '../components/DotDialog';
import { Login } from '../components/Login';
import { PagesView } from '../components/PagesView';
import { Sidebar } from '../components/Sidebar';
import { TasksView } from '../components/TasksView';
import { Button, EmptyState, Spinner, type AppView } from '../components/ui';

interface StateResponse {
  settings: { name: string };
  memories: unknown[];
  tasks: Task[];
  setup: { model: boolean; missing: string[] };
  configured: boolean;
}

interface DotDialogState {
  open: boolean;
  dot: Dot | null;
}

export default function App() {
  const { user, loading } = useAuthState();

  if (loading) {
    return (
      <div className="boot-screen">
        <Spinner label="Loading OpenDots…" />
      </div>
    );
  }

  if (!user) {
    return <Login />;
  }

  return <Workspace userEmail={user.email ?? ''} />;
}

function Workspace({ userEmail }: { userEmail: string }) {
  const [bootLoading, setBootLoading] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);
  const [dots, setDots] = useState<Dot[]>([]);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedView, setSelectedView] = useState<AppView>('chat');
  const [selectedDotId, setSelectedDotId] = useState<string | null>(null);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [selectedSpaceId, setSelectedSpaceId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DotDialogState>({ open: false, dot: null });
  const initializedRef = useRef(false);

  const bootstrap = useCallback(async () => {
    setBootLoading(true);
    setBootError(null);
    try {
      const [state, spaceList, dotList, conversationList] = await Promise.all([
        api<StateResponse>('/state'),
        api<Space[]>('/spaces'),
        api<Dot[]>('/dots'),
        api<Conversation[]>('/conversations'),
      ]);
      setTasks(state.tasks);
      setSpaces(spaceList);
      setDots(dotList);
      setConversations(conversationList);
      if (!initializedRef.current) {
        initializedRef.current = true;
        const firstDot = dotList[0];
        if (firstDot) {
          setSelectedDotId(firstDot.id);
          const latest = conversationList
            .filter((c) => c.dotId === firstDot.id)
            .sort((a, b) => b.createdAt - a.createdAt)[0];
          if (latest) setSelectedConversationId(latest.id);
        }
        const firstSpace = spaceList[0];
        if (firstSpace) setSelectedSpaceId(firstSpace.id);
      }
    } catch (err) {
      setBootError(err instanceof Error ? err.message : 'Could not load your workspace.');
    } finally {
      setBootLoading(false);
    }
  }, []);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  const handleSelectDot = useCallback(
    (dotId: string) => {
      setSelectedDotId(dotId);
      setSelectedView('chat');
      if (
        selectedConversationId &&
        conversations.some((c) => c.id === selectedConversationId && c.dotId === dotId)
      ) {
        return;
      }
      const latest = conversations
        .filter((c) => c.dotId === dotId)
        .sort((a, b) => b.createdAt - a.createdAt)[0];
      setSelectedConversationId(latest ? latest.id : null);
    },
    [conversations, selectedConversationId],
  );

  const handleSelectSpace = useCallback((spaceId: string) => {
    setSelectedSpaceId(spaceId);
    setSelectedView('pages');
  }, []);

  const handleSelectTasks = useCallback(() => {
    setSelectedView('tasks');
  }, []);

  const handleConversationCreated = useCallback((conversation: Conversation) => {
    setConversations((prev) => [conversation, ...prev]);
    setSelectedConversationId(conversation.id);
  }, []);

  const handleDotSaved = useCallback(
    (saved: Dot) => {
      const wasCreate = dialog.dot === null;
      setDots((prev) => {
        const exists = prev.some((d) => d.id === saved.id);
        return exists ? prev.map((d) => (d.id === saved.id ? saved : d)) : [...prev, saved];
      });
      setDialog({ open: false, dot: null });
      if (wasCreate) handleSelectDot(saved.id);
    },
    [dialog.dot, handleSelectDot],
  );

  const handleSignOut = useCallback(() => {
    void signOutUser();
  }, []);

  const activeTaskCount = tasks.filter(
    (t) => t.status === 'queued' || t.status === 'running',
  ).length;

  const navValue =
    selectedView === 'tasks'
      ? 'tasks'
      : selectedView === 'pages' && selectedSpaceId
        ? `space:${selectedSpaceId}`
        : selectedDotId
          ? `dot:${selectedDotId}`
          : '';

  const handleNavSelect = (value: string) => {
    if (value === 'tasks') {
      handleSelectTasks();
    } else if (value.startsWith('space:')) {
      handleSelectSpace(value.slice(6));
    } else if (value.startsWith('dot:')) {
      handleSelectDot(value.slice(4));
    }
  };

  return (
    <div className="app">
      <Sidebar
        userEmail={userEmail}
        dots={dots}
        spaces={spaces}
        activeTaskCount={activeTaskCount}
        selectedDotId={selectedDotId}
        selectedSpaceId={selectedSpaceId}
        selectedView={selectedView}
        onSelectDot={handleSelectDot}
        onNewDot={() => setDialog({ open: true, dot: null })}
        onEditDot={(dot) => setDialog({ open: true, dot })}
        onSelectSpace={handleSelectSpace}
        onSelectTasks={handleSelectTasks}
        onSignOut={handleSignOut}
      />

      <div className="main">
        <header className="topbar">
          <select
            className="topbar-select"
            aria-label="Navigate"
            value={navValue}
            onChange={(event) => handleNavSelect(event.target.value)}
          >
            <option value="" disabled>
              Go to…
            </option>
            {dots.map((dot) => (
              <option key={dot.id} value={`dot:${dot.id}`}>
                Dot — {dot.name}
              </option>
            ))}
            {spaces.map((space) => (
              <option key={space.id} value={`space:${space.id}`}>
                Space — {space.name}
              </option>
            ))}
            <option value="tasks">Activity — Tasks</option>
          </select>
          <span className="topbar-brand">OpenDots</span>
          <div className="topbar-user">
            <span className="topbar-email">{userEmail}</span>
            <Button variant="ghost" small onClick={handleSignOut}>
              Sign out
            </Button>
          </div>
        </header>

        <main className="content">
          {bootLoading ? (
            <div className="boot-screen">
              <Spinner label="Loading your second brain…" />
            </div>
          ) : bootError ? (
            <div className="boot-error">
              <p>{bootError}</p>
              <Button onClick={() => void bootstrap()}>Retry</Button>
            </div>
          ) : (
            <>
              {selectedView === 'chat' ? (
                <ChatView
                  dot={dots.find((d) => d.id === selectedDotId) ?? null}
                  conversationId={selectedConversationId}
                  onConversationCreated={handleConversationCreated}
                />
              ) : null}
              {selectedView === 'pages' ? (
                selectedSpaceId ? (
                  <PagesView spaceId={selectedSpaceId} spaces={spaces} />
                ) : (
                  <EmptyState
                    title="No spaces yet"
                    hint="Spaces hold your pages. Create one to get started."
                  />
                )
              ) : null}
              {selectedView === 'tasks' ? (
                <TasksView initialTasks={tasks} onTasksChange={setTasks} />
              ) : null}
            </>
          )}
        </main>
      </div>

      <DotDialog
        open={dialog.open}
        dot={dialog.dot}
        spaces={spaces}
        onClose={() => setDialog((prev) => ({ ...prev, open: false }))}
        onSaved={handleDotSaved}
      />
    </div>
  );
}
