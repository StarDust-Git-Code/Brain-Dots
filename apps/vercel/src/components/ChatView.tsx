'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { isAbortError, useScopedApi } from '../lib/client';
import type { Conversation, Dot, Message } from '../lib/types';
import { Button, EmptyState, Spinner } from './ui';
import { useBeforeUnload, type RegisterLeaveGuard } from './useLeaveGuard';

interface ChatViewProps {
  dot: Dot | null;
  conversationId: string | null;
  conversations: Conversation[];
  onConversationCreated: (conversation: Conversation) => void;
  onSelectConversation: (id: string) => void;
  onCreateDot: () => void;
  onEditDot: (dot: Dot) => void;
  registerLeaveGuard: RegisterLeaveGuard;
}

interface AgentRunResponse {
  ok: boolean;
  threadId: string;
  dotId: string;
  text: string;
}

interface Operation {
  controller: AbortController;
  version: number;
}

export function ChatView({ dot, conversationId, conversations, onConversationCreated, onSelectConversation, onCreateDot, onEditDot, registerLeaveGuard }: ChatViewProps) {
  const api = useScopedApi();
  const [messages, setMessages] = useState<Message[]>([]);
  const [displayThreadId, setDisplayThreadId] = useState(conversationId);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [creatingConversation, setCreatingConversation] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [needsHistoryRefresh, setNeedsHistoryRefresh] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const mountedRef = useRef(false);
  const draftRef = useRef(draft);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const propsRef = useRef({ dotId: dot?.id ?? null, conversationId });
  const scopeRef = useRef({ dotId: dot?.id ?? null, threadId: conversationId, version: 0 });
  const adoptingRef = useRef<{ id: string; previousId: string | null } | null>(null);
  const operationRef = useRef<Operation | null>(null);
  const historyRequestRef = useRef<AbortController | null>(null);
  const pendingSendRef = useRef<{ raw: string; content: string; beforeIds: Set<string> } | null>(null);
  propsRef.current = { dotId: dot?.id ?? null, conversationId };
  draftRef.current = draft;

  const currentScope = useCallback((version: number) => {
    const scope = scopeRef.current;
    const props = propsRef.current;
    const adopting = adoptingRef.current;
    return mountedRef.current && scope.version === version && props.dotId === scope.dotId
      && (props.conversationId === scope.threadId
        || (adopting?.id === scope.threadId && props.conversationId === adopting.previousId));
  }, []);

  const refreshHistory = useCallback(async (threadId: string, version: number, showLoading = false): Promise<Message[] | null> => {
    historyRequestRef.current?.abort();
    const controller = new AbortController();
    historyRequestRef.current = controller;
    if (showLoading) setLoading(true);
    try {
      const list = await api<Message[]>(`/conversations/${encodeURIComponent(threadId)}/messages`, 'GET', undefined, { signal: controller.signal });
      if (!currentScope(version) || scopeRef.current.threadId !== threadId || controller.signal.aborted || historyRequestRef.current !== controller) return null;
      setMessages(list);
      setDisplayThreadId(threadId);
      setHistoryError(null);
      setNeedsHistoryRefresh(false);
      const pending = pendingSendRef.current;
      if (pending) {
        const persisted = list.some((message) => message.role === 'user' && message.content === pending.content && !pending.beforeIds.has(message.id));
        if (!persisted && draftRef.current === '') {
          draftRef.current = pending.raw;
          setDraft(pending.raw);
        }
        pendingSendRef.current = null;
      }
      return list;
    } catch (err) {
      if (currentScope(version) && !controller.signal.aborted && historyRequestRef.current === controller && !isAbortError(err)) {
        setHistoryError(err instanceof Error ? err.message : 'Could not load conversation history.');
        setNeedsHistoryRefresh(true);
      }
      return null;
    } finally {
      if (currentScope(version) && historyRequestRef.current === controller && !controller.signal.aborted) setLoading(false);
    }
  }, [currentScope, api]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      operationRef.current?.controller.abort();
      historyRequestRef.current?.abort();
    };
  }, []);

  useEffect(() => {
    // A thread we just created is the same operation, not an external scope switch.
    if (adoptingRef.current?.id === conversationId && scopeRef.current.dotId === (dot?.id ?? null)) {
      adoptingRef.current = null;
      setDisplayThreadId(conversationId);
      return;
    }
    operationRef.current?.controller.abort();
    operationRef.current = null;
    historyRequestRef.current?.abort();
    const version = scopeRef.current.version + 1;
    scopeRef.current = { dotId: dot?.id ?? null, threadId: conversationId, version };
    adoptingRef.current = null;
    pendingSendRef.current = null;
    draftRef.current = '';
    setDraft('');
    setMessages([]);
    setDisplayThreadId(conversationId);
    setError(null);
    setHistoryError(null);
    setNeedsHistoryRefresh(false);
    setNotice(null);
    setThinking(false);
    setCreatingConversation(false);
    setLoading(Boolean(conversationId));
    if (conversationId && dot) void refreshHistory(conversationId, version, true);
  }, [dot?.id, conversationId, refreshHistory]);

  useEffect(() => {
    registerLeaveGuard(() => !draftRef.current || window.confirm('Discard your unsent message and leave this conversation?'));
    return () => registerLeaveGuard(null);
  }, [registerLeaveGuard]);
  useBeforeUnload(draft !== '' || thinking || creatingConversation);

  useEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [messages, thinking]);

  const isCurrentOperation = (operation: Operation) => operationRef.current === operation
    && !operation.controller.signal.aborted && currentScope(operation.version);

  const createConversation = async (operation: Operation, title?: string) => {
    if (!dot) return null;
    const payload: { dotId: string; title?: string } = { dotId: dot.id };
    if (title) payload.title = title.slice(0, 60);
    const conversation = await api<Conversation>('/conversations', 'POST', payload, { signal: operation.controller.signal });
    if (!isCurrentOperation(operation)) return null;
    if (conversation.dotId !== dot.id) throw new Error('The server returned a conversation for a different Dot.');
    adoptingRef.current = { id: conversation.id, previousId: propsRef.current.conversationId };
    scopeRef.current.threadId = conversation.id;
    setDisplayThreadId(conversation.id);
    onConversationCreated(conversation);
    return conversation.id;
  };

  const handleNewConversation = async () => {
    if (!dot || operationRef.current || loading) return;
    if (draftRef.current && !window.confirm('Discard your unsent message and start a new conversation?')) return;
    const operation = { controller: new AbortController(), version: scopeRef.current.version };
    operationRef.current = operation;
    setCreatingConversation(true);
    setError(null);
    try {
      const id = await createConversation(operation);
      if (!id || !isCurrentOperation(operation)) return;
      setMessages([]);
      pendingSendRef.current = null;
      draftRef.current = '';
      setDraft('');
      setHistoryError(null);
      setNeedsHistoryRefresh(false);
      setNotice(null);
    } catch (err) {
      if (isCurrentOperation(operation) && !isAbortError(err)) setError(err instanceof Error ? err.message : 'Could not start a conversation.');
    } finally {
      if (operationRef.current === operation) {
        operationRef.current = null;
        if (currentScope(operation.version)) setCreatingConversation(false);
      }
    }
  };

  const send = async () => {
    const raw = draftRef.current;
    const content = raw.trim();
    if (!content || !dot || operationRef.current || loading || needsHistoryRefresh || displayThreadId !== conversationId) return;
    const operation = { controller: new AbortController(), version: scopeRef.current.version };
    operationRef.current = operation;
    setThinking(true);
    setError(null);
    setNotice(null);
    let threadId = scopeRef.current.threadId;
    try {
      if (!threadId) threadId = await createConversation(operation, content);
      if (!threadId || !isCurrentOperation(operation)) return;
      pendingSendRef.current = { raw, content, beforeIds: new Set(messages.map((message) => message.id)) };
      setMessages((prev) => [...prev, { id: `local-user-${Date.now()}`, role: 'user', content, createdAt: Date.now() }]);
      if (draftRef.current === raw) { draftRef.current = ''; setDraft(''); }
      const response = await api<AgentRunResponse>(`/copilotkit/agent/${encodeURIComponent(dot.id)}/run`, 'POST', {
        threadId, messages: [{ role: 'user', content }],
      }, { signal: operation.controller.signal });
      if (!isCurrentOperation(operation)) return;
      if (response.dotId !== dot.id || response.threadId !== threadId) throw new Error('The server returned a reply for a different conversation.');
      setMessages((prev) => [...prev, { id: `local-assistant-${Date.now()}`, role: 'assistant', content: response.text, createdAt: Date.now() }]);
      // Replace optimistic IDs with the stored message IDs after every send.
      const stored = await refreshHistory(threadId, operation.version);
      if (isCurrentOperation(operation) && !stored) setNotice('Reply received. Refresh history to confirm the saved messages before sending again.');
    } catch (err) {
      if (!isCurrentOperation(operation) || isAbortError(err)) return;
      setError(err instanceof Error ? err.message : 'Could not send the message.');
      if (threadId) await refreshHistory(threadId, operation.version);
    } finally {
      if (operationRef.current === operation) {
        operationRef.current = null;
        if (currentScope(operation.version)) setThinking(false);
      }
    }
  };

  const stopWaiting = () => {
    const operation = operationRef.current;
    if (!operation) return;
    operationRef.current = null;
    operation.controller.abort();
    historyRequestRef.current?.abort();
    setThinking(false);
    setCreatingConversation(false);
    setLoading(false);
    setNeedsHistoryRefresh(Boolean(scopeRef.current.threadId));
    setNotice('Stopped waiting in this view. The server may still finish the request. Refresh history to check what was saved.');
  };

  if (!dot) return (
    <div className="chat"><EmptyState title="Create your first Dot" hint="Give it a role and a Space, then start a conversation." action={<Button onClick={onCreateDot}>Create Dot</Button>} /></div>
  );

  const switching = displayThreadId !== conversationId;
  const busy = thinking || creatingConversation;
  return (
    <div className="chat">
      <header className="view-head view-head--actions">
        <div>
          <h1 className="view-title">{dot.name}</h1>
          <p className="view-sub">{dot.instructions.length > 90 ? `${dot.instructions.slice(0, 90)}…` : dot.instructions}</p>
        </div>
        <Button variant="ghost" small onClick={() => onEditDot(dot)}>Edit Dot</Button>
      </header>
      <div className="chat-toolbar">
        <label className="chat-history-select">
          <span className="form-label">Conversation</span>
          <select className="select" value={conversationId ?? ''} aria-label="Conversation" onChange={(event) => onSelectConversation(event.target.value)}>
            <option value="" disabled>New conversation</option>
            {conversations.map((conversation) => <option key={conversation.id} value={conversation.id}>{conversation.title || 'Untitled conversation'}</option>)}
          </select>
        </label>
        <Button variant="ghost" small disabled={busy || loading || switching} onClick={() => void handleNewConversation()}>New conversation</Button>
        <Button variant="ghost" small disabled={!conversationId || busy || loading || switching} onClick={() => { if (conversationId) void refreshHistory(conversationId, scopeRef.current.version, true); }}>Refresh history</Button>
      </div>
      <div className="chat-messages" ref={scrollRef} aria-label="Conversation messages" aria-busy={loading || thinking}>
        {loading || switching ? <Spinner label="Loading conversation…" /> : messages.length === 0 ? (
          <EmptyState title="What’s on your mind?" hint="Share a thought, ask a question, or talk through something you’re learning." />
        ) : messages.map((message) => (
          <div key={message.id} className={`bubble bubble--${message.role}`}>
            {message.content}
            {message.id.startsWith('local-') ? <span className="bubble-pending">{thinking ? 'Sending…' : 'Awaiting history confirmation'}</span> : null}
          </div>
        ))}
        {thinking && !switching ? <div className="bubble bubble--assistant bubble--thinking" role="status">Thinking…</div> : null}
      </div>
      {error ? <p className="view-error" role="alert">{error}</p> : null}
      {historyError ? <p className="view-error" role="alert">{historyError} Use Refresh history to try again.</p> : null}
      {notice ? <p className="chat-notice" role="status">{notice}</p> : null}
      <form className="composer" onSubmit={(event) => { event.preventDefault(); void send(); }}>
        <textarea className="composer-input" value={draft} maxLength={4000} disabled={loading || switching || creatingConversation}
          aria-label={`Message ${dot.name}`} placeholder={`Message ${dot.name}…`}
          onChange={(event) => { draftRef.current = event.target.value; setDraft(event.target.value); }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); }
          }} />
        <div className="composer-foot">
          <span className="composer-hint">Enter to send · Shift+Enter for a new line · {draft.length}/4000</span>
          <div className="inline-actions">
            {busy ? <Button variant="ghost" small onClick={stopWaiting}>Stop waiting</Button> : null}
            <Button type="submit" small disabled={!draft.trim() || busy || loading || switching || needsHistoryRefresh}>Send</Button>
          </div>
        </div>
      </form>
    </div>
  );
}
