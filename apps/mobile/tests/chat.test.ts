import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chatScope, matchTurn, mergeMessages, renderMessages, ScopeGuard, type PendingTurn } from '../src/lib/chat-messages';
import type { Message } from '../src/types';

const scope = chatScope('user-a', 'dot-a', 'thread-a');
const turn = (patch: Partial<PendingTurn> = {}): PendingTurn => ({
  id: 'turn-a', scope, content: 'Repeat this', startedAt: 1000000,
  baselineIds: ['historical'], status: 'sending', ...patch,
});
const user = (id: string, createdAt: number, content = 'Repeat this'): Message => ({ id, createdAt, content, role: 'user' });
const assistant = (id: string, createdAt: number, content = 'Reply'): Message => ({ id, createdAt, content, role: 'assistant' });

test('historical repeated content cannot consume a new optimistic message', () => {
  const historical = user('historical', 999000);
  const rendered = renderMessages([historical], [turn()], scope);
  assert.deepEqual(rendered.map((message) => message.id), ['historical', 'turn-a:user']);
  const confirmed = renderMessages([historical, user('new-identity', 1000010)], [turn()], scope);
  assert.deepEqual(confirmed.map((message) => message.id), ['historical', 'new-identity']);
});

test('two repeated sends reconcile one-to-one against different new server identities', () => {
  const messages = [user('historical', 999000), user('new-a', 1000010), user('new-b', 1000030)];
  const rendered = renderMessages(messages, [turn(), turn({ id: 'turn-b', startedAt: 1000020 })], scope);
  assert.equal(rendered.length, 3);
  assert.equal(rendered.find((message) => message.id === 'new-a')?.turnId, 'turn-a');
  assert.equal(rendered.find((message) => message.id === 'new-b')?.turnId, 'turn-b');
});

test('REST and Firestore events merge by identity without losing newer history', () => {
  const a = user('new-a', 1000010);
  const b = assistant('reply-a', 1000020);
  assert.deepEqual(mergeMessages([a, b], [a]), [a, b]);
  assert.equal(mergeMessages([a], [a, a, b]).length, 2);
});

test('JSON reply and persisted assistant render once, including interleaved turns', () => {
  const outgoing = turn({ status: 'sent', reply: 'Reply' });
  const messages = [user('new-a', 1000010), user('other-device', 1000020, 'Another prompt'), assistant('reply-a', 1000030)];
  assert.equal(renderMessages(messages, [outgoing], scope).length, 3);
  assert.equal(renderMessages([messages[0]], [outgoing], scope).length, 2);
});

test('failed message remains retryable without duplicating its persisted user bubble', () => {
  const rendered = renderMessages([user('new-a', 1000010)], [turn({ status: 'failed', error: 'Model unavailable' })], scope);
  assert.equal(rendered.length, 1);
  assert.equal(rendered[0].sendStatus, 'failed');
  assert.equal(rendered[0].error, 'Model unavailable');
});

test('retry preflight recognizes a completed persisted turn after an HTTP response was lost', () => {
  const persisted = matchTurn([user('new-a', 1000010), assistant('reply-a', 1000020)], turn({ status: 'failed' }));
  assert.equal(persisted.user?.id, 'new-a');
  assert.equal(persisted.assistant?.id, 'reply-a');
  // An assistant answering a later user's prompt must not be assumed to be ours.
  const interleaved = matchTurn([user('new-a', 1000010), user('other', 1000020, 'Other'), assistant('other-reply', 1000030)], turn({ status: 'failed' }));
  assert.equal(interleaved.assistant, undefined);
});

test('optimistic messages are scoped to the exact account, dot and thread', () => {
  assert.equal(renderMessages([], [turn()], chatScope('user-a', 'dot-b', 'thread-a')).length, 0);
  assert.equal(renderMessages([], [turn()], chatScope('user-a', 'dot-a', 'thread-b')).length, 0);
  assert.equal(renderMessages([], [turn()], chatScope('user-b', 'dot-a', 'thread-a')).length, 0);
});

test('scope generations suppress stale requests even after switching away and back', () => {
  const guard = new ScopeGuard();
  guard.select(scope);
  const old = guard.capture();
  guard.select(chatScope('user-a', 'dot-b', 'thread-b'));
  assert.equal(guard.isCurrent(old), false);
  guard.select(scope);
  assert.equal(guard.isCurrent(old), false);
  assert.equal(guard.isCurrent(guard.capture()), true);
});

test('unknown historical messages outside the timestamp window cannot reconcile a new send', () => {
  const rendered = renderMessages([user('unseen-old-id', 100)], [turn({ baselineIds: [] })], scope);
  assert.equal(rendered.length, 2);
});

test('New Chat invalidation suppresses a pending automatic thread selection', () => {
  const guard = new ScopeGuard();
  guard.select(chatScope('user-a', 'dot-a', null));
  const initialThreadLoad = guard.capture();
  guard.invalidate();
  assert.equal(guard.isCurrent(initialThreadLoad), false);
  assert.equal(guard.isCurrent(guard.capture()), true);
});
