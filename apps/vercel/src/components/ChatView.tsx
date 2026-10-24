'use client';

import { useEffect, useRef, useState } from 'react';
import { api } from '../lib/client';
import type { Conversation, Dot, Message } from '../lib/types';
import { Button, EmptyState, Spinner } from './ui';

interface ChatViewProps {
  dot: Dot | null;
  conversationId: string | null;
  onConversationCreated: (conversation: Conversation) => void;
}

interface AgentRunResponse {
  ok: boolean;
  threadId: string;
  dotId: string;
  text: string;
}

export function ChatView({ dot, conversationId, onConversationCreated }: ChatViewProps) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState('');
  const [loading, setLoading] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const skipLoadRef = useRef<string | null>(null);

  useEffect(() => {
    setError(null);
    if (!conversationId) {
      setMessages([]);
      setLoading(false);
      return;
    }
    if (skipLoadRef.current === conversationId) {
      skipLoadRef.current = null;
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api<Message[]>(`/conversations/${conversationId}/messages`)
      .then((list) => {
        if (!cancelled) setMessages(list);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load messages.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, thinking]);

  const ensureConversation = async (): Promise<string | null> => {
    if (!dot) return null;
    const trimmed = draft.trim();
    const payload: { dotId: string; title?: string } = { dotId: dot.id };
    if (trimmed) payload.title = trimmed.slice(0, 60);
    const conversation = await api<Conversation>('/conversations', 'POST', payload);
    skipLoadRef.current = conversation.id;
    onConversationCreated(conversation);
    return conversation.id;
  };

  const handleNewConversation = async () => {
    setError(null);
    try {
      await ensureConversation();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start a conversation.');
    }
  };

  const send = async () => {
    const content = draft.trim();
    if (!content || !dot || thinking) return;
    setError(null);
    try {
      let threadId = conversationId;
      if (!threadId) {
        threadId = await ensureConversation();
      }
      if (!threadId) return;
      setMessages((prev) => [
        ...prev,
        { id: `local-user-${Date.now()}`, role: 'user', content, createdAt: Date.now() },
      ]);
      setDraft('');
      setThinking(true);
      const res = await api<AgentRunResponse>(`/copilotkit/agent/${dot.id}/run`, 'POST', {
        threadId,
        messages: [{ role: 'user', content }],
      });
      setMessages((prev) => [
        ...prev,
        {
          id: `local-assistant-${Date.now()}`,
          role: 'assistant',
          content: res.text,
          createdAt: Date.now(),
        },
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the message.');
    } finally {
      setThinking(false);
    }
  };

  if (!dot) {
    return (
      <div className="chat">
        <EmptyState
          title="No dot selected"
          hint="Pick a dot in the sidebar, or create one to start chatting."
        />
      </div>
    );
  }

  return (
    <div className="chat">
      <header className="view-head">
        <h1 className="view-title">{dot.name}</h1>
        <p className="view-sub">
          {dot.instructions.length > 90 ? `${dot.instructions.slice(0, 90)}…` : dot.instructions}
        </p>
      </header>

      <div className="chat-messages" ref={scrollRef}>
        {loading ? (
          <Spinner />
        ) : messages.length === 0 ? (
          <EmptyState
            title="Say something to your dot"
            hint={
              conversationId
                ? undefined
                : 'Write a first thought below — a conversation will be created for it.'
            }
          />
        ) : (
          messages.map((message) => (
            <div key={message.id} className={`bubble bubble--${message.role}`}>
              {message.content}
            </div>
          ))
        )}
        {thinking ? <div className="bubble bubble--assistant bubble--thinking">Thinking…</div> : null}
      </div>

      {error ? <p className="view-error">{error}</p> : null}

      {dot && !conversationId ? (
        <div className="chat-newconv">
          <Button variant="ghost" small onClick={() => void handleNewConversation()}>
            New conversation
          </Button>
        </div>
      ) : null}

      <form
        className="composer"
        onSubmit={(event) => {
          event.preventDefault();
          void send();
        }}
      >
        <textarea
          className="composer-input"
          value={draft}
          maxLength={4000}
          placeholder={`Message ${dot.name}…`}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void send();
            }
          }}
        />
        <div className="composer-foot">
          <span className="composer-hint">
            Enter to send · Shift+Enter for a new line · {draft.length}/4000
          </span>
          <Button type="submit" small disabled={!draft.trim() || thinking}>
            Send
          </Button>
        </div>
      </form>
    </div>
  );
}
