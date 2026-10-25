import type { Message } from '../types';

export interface PendingTurn {
  id: string;
  scope: string;
  content: string;
  startedAt: number;
  baselineIds: string[];
  status: 'sending' | 'failed' | 'sent';
  error?: string;
  reply?: string;
}

export interface ChatBubble extends Message {
  turnId?: string;
  sendStatus?: PendingTurn['status'];
  error?: string;
}

export const chatScope = (uid: string, dotId: string, threadId: string | null) =>
  JSON.stringify([uid, dotId, threadId]);

// Returning to the same thread still invalidates requests from a prior visit.
export class ScopeGuard {
  private scope = '';
  private generation = 0;
  select(scope: string) {
    if (scope !== this.scope) { this.scope = scope; this.generation += 1; }
  }
  invalidate() { this.generation += 1; }
  capture() { return { scope: this.scope, generation: this.generation }; }
  isCurrent(token: { scope: string; generation: number }) {
    return token.scope === this.scope && token.generation === this.generation;
  }
}

export function mergeMessages(previous: Message[], incoming: Message[]): Message[] {
  const byId = new Map(previous.map((message) => [message.id, message]));
  incoming.forEach((message) => byId.set(message.id, message));
  return [...byId.values()].sort((a, b) => a.createdAt - b.createdAt);
}

export function matchTurn(messages: Message[], turn: PendingTurn, used = new Set<string>()) {
  const baseline = new Set(turn.baselineIds);
  // The run API doesn't accept a client ID. Match one new identity per turn,
  // bounded to this request's timestamp (with five minutes of clock tolerance).
  // Historical equal text and identities already matched to another turn cannot
  // consume an optimistic message.
  const user = messages.find((message) => message.role === 'user' &&
    message.content === turn.content && !baseline.has(message.id) &&
    !used.has(message.id) && message.createdAt >= turn.startedAt - 300000);
  const userIndex = user ? messages.findIndex((message) => message.id === user.id) : -1;
  const next = userIndex >= 0 ? messages[userIndex + 1] : undefined;
  const assistant = turn.reply !== undefined
    ? messages.find((message) => message.role === 'assistant' && message.content === turn.reply &&
      !baseline.has(message.id) && !used.has(message.id) &&
      message.createdAt >= (user?.createdAt ?? turn.startedAt - 300000))
    : next?.role === 'assistant' && !baseline.has(next.id) && !used.has(next.id) ? next : undefined;
  return { user, assistant };
}

export function renderMessages(messages: Message[], turns: PendingTurn[], scope: string): ChatBubble[] {
  const bubbles = new Map<string, ChatBubble>(messages.map((message) => [message.id, message]));
  const used = new Set<string>();
  for (const turn of turns.filter((item) => item.scope === scope)) {
    const matched = matchTurn(messages, turn, used);
    if (matched.user) used.add(matched.user.id);
    if (matched.assistant) used.add(matched.assistant.id);
    const user: ChatBubble = matched.user ?? {
      id: `${turn.id}:user`, role: 'user', content: turn.content, createdAt: turn.startedAt,
    };
    bubbles.set(user.id, { ...user, turnId: turn.id, sendStatus: turn.status, error: turn.error });
    if (turn.reply && !matched.assistant) {
      bubbles.set(`${turn.id}:assistant`, {
        id: `${turn.id}:assistant`, role: 'assistant', content: turn.reply,
        createdAt: Math.max(turn.startedAt + 1, user.createdAt + 1),
      });
    }
  }
  return [...bubbles.values()].sort((a, b) => a.createdAt - b.createdAt);
}
