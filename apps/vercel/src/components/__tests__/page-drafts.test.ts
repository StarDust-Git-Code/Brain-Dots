import assert from 'node:assert/strict';
import test from 'node:test';
import type { Page } from '../../lib/types';
import { PageDraftSession } from '../pageDrafts';

const original: Page = {
  id: 'page-a', userId: 'user-a', spaceId: 'space-a', parentId: null,
  title: 'Notes', content: 'Original', revision: 1,
  createdAt: 1, updatedAt: 1, sourceThreadId: null,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('overlapping save requests serialize and save edits made during the older request', async () => {
  const writes: Array<{ changes: { title: string; content: string; expectedRevision: number }; response: ReturnType<typeof deferred<Page>> }> = [];
  const session = new PageDraftSession(original, async (_page, changes) => {
    const response = deferred<Page>();
    writes.push({ changes, response });
    return response.promise;
  });
  session.edit({ content: 'First draft' });
  const first = session.save();
  await tick();
  session.edit({ title: 'Newest title', content: 'Newest draft' });
  const second = session.save();
  assert.equal(first, second);
  assert.equal(writes.length, 1);
  writes[0].response.resolve({ ...original, content: 'First draft', revision: 2 });
  await tick();
  assert.equal(session.getSnapshot().content, 'Newest draft');
  assert.equal(session.getSnapshot().status, 'saving');
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[1].changes, { title: 'Newest title', content: 'Newest draft', expectedRevision: 2 });
  writes[1].response.resolve({ ...original, title: 'Newest title', content: 'Newest draft', revision: 3 });
  assert.equal(await first, true);
  assert.equal(session.dirty, false);
  assert.equal(session.getSnapshot().status, 'saved');
});

test('reverting a draft during a request still persists the latest local version', async () => {
  const firstResponse = deferred<Page>();
  const writes: string[] = [];
  const session = new PageDraftSession(original, async (_page, changes) => {
    writes.push(changes.content);
    return writes.length === 1 ? firstResponse.promise : { ...original, ...changes, revision: 3 };
  });
  session.edit({ content: 'Temporary change' });
  const save = session.save();
  await tick();
  session.edit({ content: 'Original' });
  firstResponse.resolve({ ...original, content: 'Temporary change', revision: 2 });
  assert.equal(await save, true);
  assert.deepEqual(writes, ['Temporary change', 'Original']);
  assert.equal(session.getSnapshot().content, 'Original');
});

test('a revert before the queued save starts settles as saved without a request', async () => {
  let writes = 0;
  const session = new PageDraftSession(original, async () => { writes++; return original; });
  session.edit({ content: 'Temporary change' });
  const save = session.save();
  session.edit({ content: 'Original' });
  assert.equal(await save, true);
  assert.equal(writes, 0);
  assert.equal(session.getSnapshot().status, 'saved');
  assert.equal(session.dirty, false);
});

test('conflicts preserve newer edits and require an explicit reviewed revision before retry', async () => {
  const response = deferred<Page>();
  const revisions: number[] = [];
  const session = new PageDraftSession(original, async (_page, changes) => {
    revisions.push(changes.expectedRevision);
    return revisions.length === 1 ? response.promise : { ...original, ...changes, revision: 10 };
  });
  session.edit({ content: 'First draft' });
  const save = session.save();
  await tick();
  session.edit({ content: 'Draft typed while saving' });
  response.reject(Object.assign(new Error('Revision conflict'), { status: 409 }));
  assert.equal(await save, false);
  assert.equal(session.getSnapshot().status, 'conflict');
  assert.equal(session.getSnapshot().content, 'Draft typed while saving');
  assert.equal(await session.save(), false);
  assert.deepEqual(revisions, [1]);
  session.rebase({ ...original, content: 'Changed elsewhere', revision: 9 });
  assert.equal(session.getSnapshot().content, 'Draft typed while saving');
  assert.equal(await session.save(), true);
  assert.deepEqual(revisions, [1, 9]);
  assert.equal(session.dirty, false);
});

test('network failures keep the draft and retry uses the latest edits without advancing revision', async () => {
  const response = deferred<Page>();
  const writes: Array<{ content: string; expectedRevision: number }> = [];
  const session = new PageDraftSession(original, async (_page, changes) => {
    writes.push(changes);
    return writes.length === 1 ? response.promise : { ...original, ...changes, revision: 2 };
  });
  session.edit({ content: 'First draft' });
  const save = session.save();
  await tick();
  session.edit({ content: 'Still here after failure' });
  response.reject(new Error('Offline'));
  assert.equal(await save, false);
  assert.equal(session.getSnapshot().status, 'error');
  assert.equal(session.getSnapshot().content, 'Still here after failure');
  assert.equal(session.dirty, true);
  assert.equal(await session.save(), true);
  assert.equal(writes[1].content, 'Still here after failure');
  assert.equal(writes[1].expectedRevision, 1);
});

test('validation does not send an invalid draft or prevent a later valid retry', async () => {
  let writes = 0;
  const session = new PageDraftSession(original, async (_page, changes) => { writes++; return { ...original, ...changes, revision: 2 }; });
  session.edit({ title: ' ', content: 'Keep this content' });
  assert.equal(await session.save(), false);
  assert.equal(writes, 0);
  assert.equal(session.getSnapshot().content, 'Keep this content');
  session.edit({ title: 'Valid title' });
  assert.equal(await session.save(), true);
  assert.equal(writes, 1);
});

test('disposing a scope suppresses the old acknowledgement and queued follow-up writes', async () => {
  const response = deferred<Page>();
  let writes = 0;
  const session = new PageDraftSession(original, async () => { writes++; return response.promise; });
  session.edit({ content: 'First draft' });
  const save = session.save();
  await tick();
  session.edit({ content: 'Second draft' });
  let notifications = 0;
  session.subscribe(() => { notifications++; });
  session.dispose();
  response.resolve({ ...original, content: 'First draft', revision: 2 });
  assert.equal(await save, false);
  assert.equal(writes, 1);
  assert.equal(notifications, 0);
  assert.equal(session.getSnapshot().content, 'Second draft');
});

test('server normalization is adopted only for fields that have no newer local edits', async () => {
  let writes = 0;
  const session = new PageDraftSession(original, async (_page, changes) => { writes++; return { ...original, ...changes, title: changes.title.trim(), revision: 2 }; });
  session.edit({ title: ' Normalized title ' });
  assert.equal(await session.save(), true);
  assert.equal(writes, 1);
  assert.equal(session.getSnapshot().title, 'Normalized title');
  assert.equal(session.dirty, false);
});
