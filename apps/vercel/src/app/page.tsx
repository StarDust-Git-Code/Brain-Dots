'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { ClientUserScope, isAbortError, signOutUser, useAuthState, useScopedApi } from '../lib/client';
import type { Conversation, Dot, Space, Task } from '../lib/types';
import { ChatView } from '../components/ChatView';
import { DotDialog } from '../components/DotDialog';
import { Login } from '../components/Login';
import { MemoriesView } from '../components/MemoriesView';
import { OnboardingView } from '../components/OnboardingView';
import { PagesView } from '../components/PagesView';
import { Sidebar } from '../components/Sidebar';
import { SpaceDialog } from '../components/SpaceDialog';
import { TasksView } from '../components/TasksView';
import { Button, EmptyState, Spinner, type AppView } from '../components/ui';
import type { LeaveGuard } from '../components/useLeaveGuard';

interface DotDialogState { open: boolean; dot: Dot | null; }

export default function App() {
  const { user, loading } = useAuthState();
  if (loading) return <div className="boot-screen"><Spinner label="Loading OpenDots…" /></div>;
  if (!user) return <Login />;
  return <ClientUserScope userId={user.uid}><Workspace key={user.uid} userId={user.uid} userEmail={user.email ?? ''} /></ClientUserScope>;
}

function Workspace({ userId, userEmail }: { userId: string; userEmail: string }) {
  const api = useScopedApi();
  const [bootLoading, setBootLoading] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  const [dots, setDots] = useState<Dot[]>([]);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selectedView, setSelectedView] = useState<AppView>('home');
  const [selectedDotId, setSelectedDotId] = useState<string | null>(null);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [selectedSpaceId, setSelectedSpaceId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DotDialogState>({ open: false, dot: null });
  const [spaceDialogOpen, setSpaceDialogOpen] = useState(false);
  const [navigating, setNavigating] = useState(false);
  const mountedRef = useRef(false);
  const initializedRef = useRef(false);
  const bootstrapRef = useRef<AbortController | null>(null);
  const leaveGuardRef = useRef<LeaveGuard | null>(null);
  const navigationLockRef = useRef(false);
  const selectedDotRef = useRef(selectedDotId);
  selectedDotRef.current = selectedDotId;

  const bootstrap = useCallback(async () => {
    bootstrapRef.current?.abort();
    const controller = new AbortController();
    bootstrapRef.current = controller;
    setBootLoading(true);
    setBootError(null);
    try {
      const options = { signal: controller.signal };
      const [spaceList, dotList, conversationList, taskList] = await Promise.all([
        api<Space[]>('/spaces', 'GET', undefined, options),
        api<Dot[]>('/dots', 'GET', undefined, options),
        api<Conversation[]>('/conversations', 'GET', undefined, options),
        api<Task[]>('/tasks', 'GET', undefined, options),
      ]);
      if (!mountedRef.current || controller.signal.aborted) return;
      setSpaces(spaceList);
      setDots(dotList);
      setConversations(conversationList);
      setTasks(taskList);
      if (!initializedRef.current) {
        initializedRef.current = true;
        const firstDot = dotList[0];
        if (firstDot) {
          selectedDotRef.current = firstDot.id;
          setSelectedDotId(firstDot.id);
          const latest = conversationList.filter((conversation) => conversation.dotId === firstDot.id).sort((a, b) => b.createdAt - a.createdAt)[0];
          setSelectedConversationId(latest?.id ?? null);
        }
        setSelectedSpaceId(spaceList[0]?.id ?? null);
        setSelectedView(firstDot && spaceList.length ? 'chat' : 'home');
      }
    } catch (err) {
      if (!isAbortError(err) && !controller.signal.aborted && mountedRef.current) setBootError(err instanceof Error ? err.message : 'Could not load your workspace.');
    } finally {
      if (!controller.signal.aborted && mountedRef.current) setBootLoading(false);
    }
  }, [api]);

  useEffect(() => {
    mountedRef.current = true;
    void bootstrap();
    return () => { mountedRef.current = false; bootstrapRef.current?.abort(); leaveGuardRef.current = null; };
  }, [bootstrap]);

  const registerLeaveGuard = useCallback((guard: LeaveGuard | null) => { leaveGuardRef.current = guard; }, []);
  const navigate = useCallback(async (action: () => void | Promise<void>) => {
    if (navigationLockRef.current) return;
    navigationLockRef.current = true;
    setNavigating(true);
    setWorkspaceError(null);
    try {
      const allowed = await (leaveGuardRef.current?.() ?? true);
      if (allowed && mountedRef.current) await action();
    } catch (err) {
      if (!isAbortError(err) && mountedRef.current) setWorkspaceError(err instanceof Error ? err.message : 'Could not finish this action. Your draft is still open.');
    } finally {
      navigationLockRef.current = false;
      if (mountedRef.current) setNavigating(false);
    }
  }, []);

  const handleSelectHome = () => { if (selectedView !== 'home') void navigate(() => setSelectedView('home')); };
  const handleSelectMemories = () => { if (selectedView !== 'memories') void navigate(() => setSelectedView('memories')); };
  const handleSelectTasks = () => { if (selectedView !== 'tasks') void navigate(() => setSelectedView('tasks')); };
  const handleNewSpace = () => { if (!bootLoading) void navigate(() => setSpaceDialogOpen(true)); };
  const handleNewDot = () => { if (!bootLoading) void navigate(() => setDialog({ open: true, dot: null })); };
  const handleEditDot = (dot: Dot) => { void navigate(() => setDialog({ open: true, dot })); };
  const handleSignOut = () => { void navigate(signOutUser); };

  const handleSelectDot = (id: string) => {
    if (selectedView === 'chat' && selectedDotId === id) return;
    if (!dots.some((dot) => dot.id === id)) return;
    void navigate(() => {
      selectedDotRef.current = id;
      setSelectedDotId(id);
      setSelectedView('chat');
      const current = conversations.find((conversation) => conversation.id === selectedConversationId && conversation.dotId === id);
      const latest = conversations.filter((conversation) => conversation.dotId === id).sort((a, b) => b.createdAt - a.createdAt)[0];
      setSelectedConversationId(current?.id ?? latest?.id ?? null);
    });
  };

  const handleSelectConversation = (id: string) => {
    if (id === selectedConversationId || !conversations.some((conversation) => conversation.id === id && conversation.dotId === selectedDotRef.current)) return;
    void navigate(() => setSelectedConversationId(id));
  };

  const handleSelectSpace = (id: string) => {
    if (selectedView === 'pages' && selectedSpaceId === id) return;
    if (!spaces.some((space) => space.id === id)) return;
    void navigate(() => { setSelectedSpaceId(id); setSelectedView('pages'); });
  };

  const handleConversationCreated = useCallback((conversation: Conversation) => {
    if (!mountedRef.current || conversation.userId !== userId || conversation.dotId !== selectedDotRef.current) return;
    setConversations((prev) => [conversation, ...prev.filter((item) => item.id !== conversation.id)]);
    setSelectedConversationId(conversation.id);
  }, [userId]);

  const addSpace = (space: Space) => {
    if (space.userId !== userId || !mountedRef.current) return;
    setSpaces((prev) => [space, ...prev.filter((item) => item.id !== space.id)]);
  };

  const handleSpaceSaved = (space: Space) => {
    if (space.userId !== userId || !mountedRef.current) return;
    addSpace(space);
    setSpaceDialogOpen(false);
    setSelectedSpaceId(space.id);
    if (selectedView !== 'home') setSelectedView('pages');
  };

  const handleDotSaved = (saved: Dot) => {
    if (saved.userId !== userId || !mountedRef.current) return;
    setDots((prev) => prev.some((dot) => dot.id === saved.id) ? prev.map((dot) => dot.id === saved.id ? saved : dot) : [...prev, saved]);
    setDialog({ open: false, dot: null });
    if (!dialog.dot) {
      selectedDotRef.current = saved.id;
      setSelectedDotId(saved.id);
      setSelectedConversationId(null);
      setSelectedView('chat');
    }
  };

  const activeDot = dots.find((dot) => dot.id === selectedDotId) ?? null;
  const activeTaskCount = tasks.filter((task) => task.status === 'queued' || task.status === 'running').length;
  const navValue = selectedView === 'pages' && selectedSpaceId ? `space:${selectedSpaceId}`
    : selectedView === 'chat' && selectedDotId ? `dot:${selectedDotId}` : selectedView;
  const handleNavSelect = (value: string) => {
    if (value === 'home') handleSelectHome();
    else if (value === 'memories') handleSelectMemories();
    else if (value === 'tasks') handleSelectTasks();
    else if (value === 'new-space') handleNewSpace();
    else if (value === 'new-dot') handleNewDot();
    else if (value === 'edit-dot' && activeDot) handleEditDot(activeDot);
    else if (value.startsWith('space:')) handleSelectSpace(value.slice(6));
    else if (value.startsWith('dot:')) handleSelectDot(value.slice(4));
  };

  return (
    <div className="app">
      <Sidebar userEmail={userEmail} dots={dots} spaces={spaces} activeTaskCount={activeTaskCount}
        selectedDotId={selectedDotId} selectedSpaceId={selectedSpaceId} selectedView={selectedView}
        onSelectHome={handleSelectHome} onSelectDot={handleSelectDot} onNewDot={handleNewDot} onEditDot={handleEditDot}
        onSelectSpace={handleSelectSpace} onNewSpace={handleNewSpace} onSelectMemories={handleSelectMemories}
        onSelectTasks={handleSelectTasks} onSignOut={handleSignOut} />
      <div className="main">
        <header className="topbar">
          <select className="topbar-select" aria-label="Navigate or create" value={navValue} disabled={navigating || bootLoading} onChange={(event) => handleNavSelect(event.target.value)}>
            <option value="home">Home</option><option value="memories">Memories</option><option value="tasks">Tasks</option>
            <optgroup label="Dots">{dots.map((dot) => <option key={dot.id} value={`dot:${dot.id}`}>{dot.name}</option>)}</optgroup>
            <optgroup label="Spaces">{spaces.map((space) => <option key={space.id} value={`space:${space.id}`}>{space.name}</option>)}</optgroup>
            <optgroup label="Create"><option value="new-space">+ Create Space</option><option value="new-dot">+ Create Dot</option></optgroup>
            {activeDot ? <option value="edit-dot">Edit current Dot</option> : null}
          </select>
          <span className="topbar-brand">OpenDots</span>
          {navigating ? <span className="topbar-status" role="status">Finishing changes…</span> : null}
          <div className="topbar-user"><span className="topbar-email">{userEmail}</span><Button variant="ghost" small disabled={navigating} onClick={handleSignOut}>Sign out</Button></div>
        </header>
        {workspaceError ? <div className="workspace-error" role="alert">{workspaceError}</div> : null}
        <main className="content">
          {bootLoading ? <div className="workspace-loading"><Spinner label="Loading your second brain…" /></div> : bootError ? (
            <div className="boot-error" role="alert"><p>{bootError}</p><Button onClick={() => void bootstrap()}>Retry</Button></div>
          ) : (
            <>
              {selectedView === 'home' ? <OnboardingView spaces={spaces} dots={dots} onCreateSpace={handleNewSpace} onCreateDot={handleNewDot} onSelectSpace={handleSelectSpace} onSelectDot={handleSelectDot} onSelectMemories={handleSelectMemories} /> : null}
              {selectedView === 'chat' ? <ChatView key={selectedDotId ?? 'empty'} dot={activeDot} conversationId={selectedConversationId}
                conversations={conversations.filter((conversation) => conversation.dotId === selectedDotId)} onConversationCreated={handleConversationCreated}
                onSelectConversation={handleSelectConversation} onCreateDot={handleNewDot} onEditDot={handleEditDot} registerLeaveGuard={registerLeaveGuard} /> : null}
              {selectedView === 'pages' ? selectedSpaceId ? <PagesView key={selectedSpaceId} spaceId={selectedSpaceId} spaces={spaces} registerLeaveGuard={registerLeaveGuard} />
                : <EmptyState title="Create your first Space" hint="Spaces hold the pages in your second brain." action={<Button onClick={handleNewSpace}>Create Space</Button>} /> : null}
              {selectedView === 'memories' ? <MemoriesView registerLeaveGuard={registerLeaveGuard} /> : null}
              {selectedView === 'tasks' ? <TasksView initialTasks={tasks} dots={dots} selectedDotId={selectedDotId} onTasksChange={setTasks} registerLeaveGuard={registerLeaveGuard} /> : null}
            </>
          )}
        </main>
      </div>
      {dialog.open ? <DotDialog key={dialog.dot?.id ?? 'new'} dot={dialog.dot} spaces={spaces} onClose={() => setDialog({ open: false, dot: null })} onSaved={handleDotSaved} onSpaceCreated={addSpace} /> : null}
      {spaceDialogOpen ? <SpaceDialog onClose={() => setSpaceDialogOpen(false)} onSaved={handleSpaceSaved} /> : null}
    </div>
  );
}
