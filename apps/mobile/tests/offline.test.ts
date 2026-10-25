import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UserCache, pageKey, pagesKey, type StorageAdapter } from '../src/lib/cache';
import { PageSaveQueue, type PageDraft } from '../src/lib/page-save-queue';
import type { Page, Space, Task } from '../src/types';

class MemoryDisk implements StorageAdapter {
  values = new Map<string, string>();
  failWrites = false;
  async getItem(key: string) { return this.values.get(key) ?? null; }
  async setItem(key: string, value: string) {
    if (this.failWrites) throw new Error('Device storage full');
    this.values.set(key, value);
  }
}

const original: Page = {
  id: 'page-1', spaceId: 'space-1', parentId: null, title: 'Original', content: 'Original content',
  revision: 3, createdAt: 1000, updatedAt: 1000,
};
const key = pageKey(original.spaceId, original.id);
const conflict = () => Object.assign(new Error('Revision conflict'), { status: 409 });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function harness(disk = new MemoryDisk()) {
  const state = { online: true, authorized: true, server: { ...original }, requests: [] as PageDraft[], mutations: 0 };
  const save = async (draft: PageDraft) => {
    state.requests.push(draft);
    if (draft.base.revision !== state.server.revision) throw conflict();
    state.mutations += 1;
    state.server = { ...state.server, title: draft.title, content: draft.content, revision: state.server.revision + 1, updatedAt: state.server.updatedAt + 1 };
    return { ...state.server };
  };
  const makeQueue = (customSave = save, load = async () => ({ ...state.server })) => {
    const cache = new UserCache(disk, 'user-a');
    return new PageSaveQueue({
      load: () => cache.read<Record<string, PageDraft>>('page-drafts'),
      save: (drafts) => cache.write('page-drafts', drafts),
      cachePage: async (page) => {
        await cache.write(pageKey(page.spaceId, page.id), page);
        await cache.update<Page[]>(pagesKey(page.spaceId), (pages) => [page, ...(pages ?? []).filter((item) => item.id !== page.id)]);
      },
    }, {
      canSync: () => state.online && state.authorized,
      load,
      save: customSave,
    });
  };
  return { disk, state, makeQueue, save };
}

test('spaces, pages and paused tasks survive cache re-creation and are isolated by UID', async () => {
  const disk = new MemoryDisk();
  const cache = new UserCache(disk, 'user-a');
  const spaces: Space[] = [{ id: 'space-1', name: 'Notes', description: '', createdAt: 1000 }];
  const tasks: Task[] = [{ id: 'task-1', prompt: 'Research topic', status: 'paused', intervalSeconds: 300, nextRunAt: null, createdAt: 1000, error: null, result: null }];
  await Promise.all([cache.write('spaces', spaces), cache.write(pagesKey('space-1'), [original]), cache.write('tasks', tasks)]);
  const restarted = new UserCache(disk, 'user-a');
  assert.deepEqual(await restarted.read('spaces'), spaces);
  assert.deepEqual(await restarted.read(pagesKey('space-1')), [original]);
  assert.deepEqual(await restarted.read('tasks'), tasks);
  assert.equal(await new UserCache(disk, 'user-b').read('spaces'), null);
  assert.equal(await new UserCache(disk, 'user-b').read('tasks'), null);
});

test('concurrent cache updates preserve both results in storage', async () => {
  const disk = new MemoryDisk();
  const cache = new UserCache(disk, 'user-a');
  await Promise.all([
    cache.update<string[]>('items', (list) => [...(list ?? []), 'first']),
    cache.update<string[]>('items', (list) => [...(list ?? []), 'second']),
  ]);
  assert.deepEqual(await new UserCache(disk, 'user-a').read('items'), ['first', 'second']);
});

test('offline title/content drafts survive editor/provider teardown and replay with expectedRevision', async () => {
  const h = harness();
  h.state.online = false;
  const editorQueue = h.makeQueue();
  await editorQueue.open(original);
  await editorQueue.edit(key, { title: 'Offline title' });
  await editorQueue.edit(key, { content: 'Offline body' });
  await editorQueue.storePending();
  await editorQueue.flush();
  assert.equal(h.state.requests.length, 0);

  // New instances read only the persisted disk, with no previous editor refs.
  const restarted = h.makeQueue();
  await restarted.ready();
  assert.equal(restarted.getSnapshot().drafts[key].title, 'Offline title');
  assert.equal(restarted.getSnapshot().drafts[key].content, 'Offline body');
  h.state.online = true;
  await restarted.flush();
  assert.equal(h.state.requests[0].base.revision, 3);
  assert.equal(h.state.server.revision, 4);
  assert.equal(restarted.getSnapshot().drafts[key].status, 'saved');
  assert.equal(await new UserCache(h.disk, 'user-a').read<Page>(key).then((page) => page?.content), 'Offline body');
});

test('one in-flight writer preserves newer edits and sends them at the acknowledged revision', async () => {
  const h = harness();
  const entered = deferred<void>();
  const release = deferred<void>();
  let active = 0;
  let maxActive = 0;
  let calls = 0;
  const queue = h.makeQueue(async (draft) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      calls += 1;
      if (calls === 1) { entered.resolve(); await release.promise; }
      return await h.save(draft);
    } finally { active -= 1; }
  });
  await queue.open(original);
  await queue.edit(key, { title: 'First title', content: 'First body' });
  const flushing = queue.flush();
  await entered.promise;
  assert.equal(queue.flush(), flushing);
  await queue.edit(key, { title: 'Latest title' });
  await queue.edit(key, { content: 'Latest body' });
  release.resolve();
  await flushing;
  assert.equal(maxActive, 1);
  assert.deepEqual(h.state.requests.map((draft) => draft.base.revision), [3, 4]);
  assert.deepEqual(h.state.requests.map((draft) => draft.content), ['First body', 'Latest body']);
  assert.equal(queue.getSnapshot().drafts[key].content, 'Latest body');
  assert.equal(queue.getSnapshot().drafts[key].base.revision, 5);
  assert.equal(queue.getSnapshot().drafts[key].status, 'saved');
  const restarted = h.makeQueue();
  await restarted.ready();
  assert.equal(restarted.getSnapshot().drafts[key].title, 'Latest title');
});

test('failed saves retain draft and error across restart, then retry successfully', async () => {
  const h = harness();
  const queue = h.makeQueue(async () => { throw new Error('Network unavailable'); });
  await queue.open(original);
  await queue.edit(key, { content: 'Keep this edit' });
  await queue.flush();
  assert.equal(queue.getSnapshot().drafts[key].status, 'error');
  const restarted = h.makeQueue();
  await restarted.ready();
  assert.equal(restarted.getSnapshot().drafts[key].error, 'Network unavailable');
  assert.equal(restarted.getSnapshot().drafts[key].content, 'Keep this edit');
  await restarted.flush();
  assert.equal(h.state.server.content, 'Keep this edit');
  assert.equal(restarted.getSnapshot().drafts[key].error, '');
});

test('409 conflicts persist, block automatic replay, and keep-draft resolution uses the latest revision', async () => {
  const h = harness();
  const queue = h.makeQueue();
  await queue.open(original);
  await queue.edit(key, { content: 'Mobile draft' });
  h.state.server = { ...original, revision: 8, content: 'Web edit' };
  await queue.flush();
  assert.equal(queue.getSnapshot().drafts[key].status, 'conflict');
  assert.equal(queue.getSnapshot().drafts[key].content, 'Mobile draft');
  assert.equal(queue.getSnapshot().drafts[key].conflict?.content, 'Web edit');
  await queue.flush();
  assert.equal(h.state.requests.length, 1);
  const restarted = h.makeQueue();
  await restarted.ready();
  assert.equal(restarted.getSnapshot().drafts[key].status, 'conflict');
  await restarted.edit(key, { title: 'Still editing' });
  assert.equal(restarted.getSnapshot().drafts[key].status, 'conflict');
  await restarted.resolve(key, 'keep-draft');
  assert.equal(restarted.getSnapshot().drafts[key].base.revision, 8);
  assert.equal(restarted.getSnapshot().drafts[key].content, 'Mobile draft');
  await restarted.flush();
  assert.equal(h.state.requests[1].base.revision, 8);
  assert.equal(h.state.server.content, 'Mobile draft');
});

test('another server edit after review raises a fresh conflict instead of overwriting', async () => {
  const h = harness();
  const queue = h.makeQueue();
  await queue.open(original);
  await queue.edit(key, { content: 'Mobile draft' });
  h.state.server = { ...original, revision: 4, content: 'Web edit' };
  await queue.flush();
  await queue.resolve(key, 'keep-draft');
  h.state.server = { ...h.state.server, revision: 5, content: 'Newer web edit' };
  await queue.flush();
  assert.equal(queue.getSnapshot().drafts[key].status, 'conflict');
  assert.equal(queue.getSnapshot().drafts[key].content, 'Mobile draft');
  assert.equal(h.state.server.content, 'Newer web edit');
  await queue.resolve(key, 'use-server');
  assert.equal(queue.getSnapshot().drafts[key].content, 'Newer web edit');
  assert.equal(queue.getSnapshot().drafts[key].status, 'saved');
});

test('a committed save with a lost response is acknowledged on replay without a second mutation', async () => {
  const h = harness();
  let first = true;
  const queue = h.makeQueue(async (draft) => {
    const saved = await h.save(draft);
    if (first) { first = false; throw new Error('Response lost'); }
    return saved;
  });
  await queue.open(original);
  await queue.edit(key, { title: 'New title', content: 'Saved despite response loss' });
  await queue.flush();
  assert.equal(queue.getSnapshot().drafts[key].status, 'error');
  const restarted = h.makeQueue();
  await restarted.flush();
  assert.equal(restarted.getSnapshot().drafts[key].status, 'saved');
  assert.equal(restarted.getSnapshot().drafts[key].base.revision, 4);
  assert.equal(h.state.mutations, 1);
});

test('local storage failure retains edits in memory and prevents sending an unpersisted draft', async () => {
  const h = harness();
  const queue = h.makeQueue();
  await queue.open(original);
  h.disk.failWrites = true;
  await assert.rejects(queue.edit(key, { content: 'Retain in memory' }), /storage full/);
  await queue.flush();
  assert.equal(h.state.requests.length, 0);
  assert.equal(queue.getSnapshot().drafts[key].content, 'Retain in memory');
  assert.match(queue.getSnapshot().storageError, /storage full/);
  h.disk.failWrites = false;
  await queue.flush();
  assert.equal(h.state.server.content, 'Retain in memory');
});

test('a cached/server reload cannot overwrite a dirty draft, and account changes stop replay', async () => {
  const h = harness();
  const queue = h.makeQueue();
  await queue.open(original);
  await queue.edit(key, { content: 'Local draft' });
  await queue.open({ ...original, revision: 10, content: 'Late load response' });
  assert.equal(queue.getSnapshot().drafts[key].content, 'Local draft');
  assert.equal(queue.getSnapshot().drafts[key].base.revision, 3);
  h.state.authorized = false;
  await queue.flush();
  assert.equal(h.state.requests.length, 0);
  h.state.authorized = true;
  await queue.flush();
  assert.equal(h.state.server.content, 'Local draft');
});

test('edits made during server-version review prevent a stale discard', async () => {
  const h = harness();
  const entered = deferred<void>();
  const release = deferred<void>();
  let reviewing = false;
  const queue = h.makeQueue(h.save, async () => {
    if (reviewing) { entered.resolve(); await release.promise; }
    return { ...h.state.server };
  });
  await queue.open(original);
  await queue.edit(key, { content: 'First draft' });
  h.state.server = { ...original, revision: 4, content: 'Web edit' };
  await queue.flush();
  reviewing = true;
  const review = queue.resolve(key, 'use-server');
  await entered.promise;
  await queue.edit(key, { content: 'New edit made during review' });
  release.resolve();
  await assert.rejects(review, /draft changed during review/i);
  assert.equal(queue.getSnapshot().drafts[key].content, 'New edit made during review');
  assert.equal(queue.getSnapshot().drafts[key].status, 'conflict');
});
