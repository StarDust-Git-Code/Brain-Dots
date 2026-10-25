import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { before, after, beforeEach, afterEach, test } from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright';

// Render the actual app and CSS in an isolated browser. Only Firebase and REST are fixtures;
// no Next build, production credentials, packages, or server files are changed by this runner.
const firebaseFixture = `
  const listeners = new Set();
  let tokenGate = null;
  const makeUser = uid => uid ? ({ uid, email: uid + '@example.test', getIdToken: async () => {
    if (tokenGate) await tokenGate.promise;
    return 'fixture-id-token-' + uid;
  } }) : null;
  const auth = { currentUser: makeUser(globalThis.__fixtureUser ?? 'user-a') };
  globalThis.__fixtureAuth = {
    switchUser(uid, notify = true) {
      auth.currentUser = makeUser(uid);
      if (notify) listeners.forEach(listener => listener(auth.currentUser));
    },
    notify() { listeners.forEach(listener => listener(auth.currentUser)); },
    holdTokens() {
      let resolve;
      tokenGate = { promise: new Promise(yes => { resolve = yes; }), resolve };
    },
    releaseTokens() { tokenGate?.resolve(); tokenGate = null; }
  };
  export const initializeApp = () => ({});
  export const getApps = () => [{}];
  export const getAuth = () => auth;
  export const onAuthStateChanged = (_auth, listener) => {
    listeners.add(listener);
    queueMicrotask(() => { if (listeners.has(listener)) listener(auth.currentUser); });
    return () => listeners.delete(listener);
  };
  export const signOut = async () => globalThis.__fixtureAuth.switchUser(null);
  export const signInWithEmailAndPassword = async () => {
    globalThis.__fixtureAuth.switchUser('user-a'); return { user: auth.currentUser };
  };
  export const createUserWithEmailAndPassword = signInWithEmailAndPassword;
`;

let browser;
let server;
let origin;
let bundle;
let sequence = 0;
let database = new Map();
let requests = [];
let holds = new Map();
let failure = { patches: 0, taskCreates: 0 };
let activePatches = 0;
let maxActivePatches = 0;

const clone = value => structuredClone(value);
const id = prefix => `${prefix}-${++sequence}`;
const stamp = () => Date.now();
const until = async (predicate, message, timeout = 5000) => {
  const end = Date.now() + timeout;
  while (!await predicate()) {
    if (Date.now() > end) throw new Error(message);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
};
const hold = key => {
  let resolve;
  const promise = new Promise(yes => { resolve = yes; });
  holds.set(key, { promise, resolve });
  return () => { holds.delete(key); resolve(); };
};
const waitForHold = async key => { await holds.get(key)?.promise; };

function account(uid) {
  if (!database.has(uid)) database.set(uid, {
    spaces: [], dots: [], memories: [], pages: [], conversations: [], messages: {}, tasks: [], details: {},
  });
  return database.get(uid);
}

function seed(uid = 'user-a') {
  const data = account(uid);
  const space = { id: `${uid}-space`, userId: uid, name: 'Notebook', description: '', createdAt: 1 };
  const dot = { id: `${uid}-dot`, userId: uid, spaceId: space.id, spaceIds: [space.id], name: 'Dot Alpha', instructions: 'Help me think clearly.', researchAllowed: true, memoryAllowed: true, createdAt: 1 };
  data.spaces.push(space);
  data.dots.push(dot);
  return { data, space, dot };
}

function addPage(data, uid, spaceId, pageId, title, content = '') {
  const page = { id: pageId, userId: uid, spaceId, parentId: null, title, content, revision: 1, createdAt: 1, updatedAt: 1, sourceThreadId: null };
  data.pages.push(page);
  return page;
}

function addConversation(data, uid, dotId, conversationId, title, createdAt, content) {
  data.conversations.push({ id: conversationId, userId: uid, dotId, title, createdAt });
  data.messages[conversationId] = [{ id: `${conversationId}-stored`, role: 'assistant', content, createdAt: 1 }];
}

async function endpoint(path, method, body, uid) {
  const data = account(uid);
  if (path === '/spaces') {
    if (method === 'GET') return [200, data.spaces];
    const saved = { id: id('space'), userId: uid, ...body, createdAt: stamp() };
    data.spaces.push(saved);
    return [201, saved];
  }
  if (path === '/dots') {
    if (method === 'GET') return [200, data.dots];
    assert.ok(body.spaceIds.every(spaceId => data.spaces.some(space => space.id === spaceId)));
    const saved = { id: id('dot'), userId: uid, ...body, createdAt: stamp() };
    data.dots.push(saved);
    return [201, saved];
  }
  if (path.startsWith('/dots/')) {
    const saved = data.dots.find(dot => dot.id === path.split('/')[2]);
    if (!saved) return [404, { error: 'Dot not found.' }];
    Object.assign(saved, body);
    return [200, saved];
  }
  if (path === '/memories') {
    if (method === 'GET') {
      const snapshot = clone(data.memories);
      await waitForHold(`memories:${uid}`);
      return [200, snapshot];
    }
    const saved = { id: id('memory'), userId: uid, text: body.text, createdAt: stamp() };
    data.memories.unshift(saved);
    return [201, saved];
  }
  if (path.startsWith('/memories/')) {
    const memoryId = path.split('/')[2];
    if (method === 'DELETE') { data.memories = data.memories.filter(memory => memory.id !== memoryId); return [200, { ok: true }]; }
    const saved = data.memories.find(memory => memory.id === memoryId);
    if (!saved) return [404, { error: 'Memory not found.' }];
    saved.text = body.text;
    return [200, saved];
  }
  const pageMatch = path.match(/^\/spaces\/([^/]+)\/pages(?:\/([^/]+))?$/);
  if (pageMatch) {
    const [, spaceId, pageId] = pageMatch;
    if (!pageId && method === 'GET') return [200, data.pages.filter(page => page.spaceId === spaceId)];
    if (!pageId) return [201, addPage(data, uid, spaceId, id('page'), body.title, body.content)];
    const saved = data.pages.find(page => page.id === pageId && page.spaceId === spaceId);
    if (!saved) return [404, { error: 'Page not found.' }];
    if (method === 'GET') return [200, saved];
    activePatches++;
    maxActivePatches = Math.max(maxActivePatches, activePatches);
    try {
      await waitForHold(`patch:${body.content}`);
      if (failure.patches > 0) { failure.patches--; return [500, { error: 'Fixture save failed.' }]; }
      if (body.expectedRevision !== saved.revision) return [409, { error: 'Revision conflict.' }];
      Object.assign(saved, { title: body.title, content: body.content, revision: saved.revision + 1, updatedAt: stamp() });
      return [200, clone(saved)];
    } finally { activePatches--; }
  }
  if (path === '/conversations') {
    if (method === 'GET') return [200, data.conversations];
    const saved = { id: id('thread'), userId: uid, dotId: body.dotId, title: body.title ?? 'New conversation', createdAt: stamp() };
    data.conversations.unshift(saved);
    data.messages[saved.id] = [];
    return [201, saved];
  }
  const historyMatch = path.match(/^\/conversations\/([^/]+)\/messages$/);
  if (historyMatch) {
    const snapshot = clone(data.messages[historyMatch[1]] ?? []);
    await waitForHold(`history:${historyMatch[1]}`);
    return [200, snapshot];
  }
  const runMatch = path.match(/^\/copilotkit\/agent\/([^/]+)\/run$/);
  if (runMatch) {
    assert.deepEqual(Object.keys(body).sort(), ['messages', 'threadId']);
    assert.deepEqual(Object.keys(body.messages[0]).sort(), ['content', 'role']);
    assert.equal(body.messages[0].role, 'user');
    const history = data.messages[body.threadId];
    history.push({ id: id('server-user'), ...body.messages[0], createdAt: stamp() });
    await waitForHold(`run:${body.messages[0].content}`);
    const text = `Reply to ${body.messages[0].content}`;
    history.push({ id: id('server-assistant'), role: 'assistant', content: text, createdAt: stamp() });
    return [200, { ok: true, dotId: runMatch[1], threadId: body.threadId, text }];
  }
  if (path === '/tasks') {
    if (method === 'GET') return [200, data.tasks];
    if (failure.taskCreates > 0) { failure.taskCreates--; return [400, { error: 'Fixture task creation failed.' }]; }
    const saved = { id: id('task'), userId: uid, ...body, dotId: body.dotId ?? data.dots[0]?.id ?? null, threadId: null, status: 'queued', nextRunAt: null, workerId: null, lease: null, leaseUntil: null, createdAt: stamp(), updatedAt: stamp(), error: null, result: null };
    data.tasks.unshift(saved);
    data.details[saved.id] = { runs: [], events: [] };
    return [201, saved];
  }
  const taskMatch = path.match(/^\/tasks\/([^/]+)(?:\/actions)?$/);
  if (taskMatch) {
    const saved = data.tasks.find(task => task.id === taskMatch[1]);
    if (!saved) return [404, { error: 'Task not found.' }];
    const detail = data.details[saved.id];
    if (method === 'GET') return [200, { task: saved, ...detail }];
    saved.status = body.action === 'pause' ? 'paused' : body.action === 'cancel' ? 'cancelled' : 'queued';
    saved.updatedAt = stamp();
    saved.error = null;
    detail.events.push({ id: id('event'), taskId: saved.id, text: `Action: ${body.action}`, createdAt: stamp() });
    return [200, saved];
  }
  return [404, { error: `Unhandled fixture endpoint: ${method} ${path}` }];
}

before(async () => {
  const result = await build({
    stdin: {
      contents: `import React from 'react'; import { createRoot } from 'react-dom/client'; import App from './src/app/page'; import css from './src/app/globals.css'; const style = document.createElement('style'); style.textContent = css; document.head.append(style); createRoot(document.getElementById('root')).render(<React.StrictMode><App /></React.StrictMode>);`,
      resolveDir: process.cwd(), loader: 'tsx',
    },
    bundle: true, write: false, platform: 'browser', jsx: 'automatic', loader: { '.css': 'text' },
    define: { 'process.env.NODE_ENV': '"development"', 'process.env.NEXT_PUBLIC_FIREBASE_API_KEY': '"fixture"', 'process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN': '"fixture"', 'process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID': '"fixture"' },
    plugins: [{ name: 'firebase-fixture', setup(builder) {
      builder.onResolve({ filter: /^firebase\/(app|auth)$/ }, () => ({ path: 'firebase-fixture', namespace: 'fixture' }));
      builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: firebaseFixture, loader: 'js' }));
    } }],
  });
  bundle = result.outputFiles[0].text;
  server = createServer(async (req, res) => {
    if (req.url === '/bundle.js') { res.setHeader('Content-Type', 'application/javascript'); res.end(bundle); return; }
    if (!req.url.startsWith('/api/')) { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script src="/bundle.js"></script></body></html>'); return; }
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
      const uid = req.headers.authorization?.replace('Bearer fixture-id-token-', '');
      assert.ok(uid && req.headers.authorization === `Bearer fixture-id-token-${uid}`, 'REST request must use a Firebase ID token');
      const path = decodeURI(req.url.slice(4));
      requests.push({ path, method: req.method, body, uid });
      const [status, value] = await endpoint(path, req.method, body, uid);
      if (!res.destroyed) { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)); }
    } catch (error) {
      if (!res.destroyed) { res.statusCode = 500; res.end(JSON.stringify({ error: error.message })); }
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
});
beforeEach(() => {
  database = new Map(); requests = []; holds = new Map(); sequence = 0;
  failure = { patches: 0, taskCreates: 0 }; activePatches = 0; maxActivePatches = 0;
});
afterEach(() => { holds.forEach(gate => gate.resolve()); holds.clear(); });

async function startPage(t, viewport = { width: 1280, height: 900 }, user = 'user-a') {
  const context = await browser.newContext({ viewport });
  await context.addInitScript(uid => { globalThis.__fixtureUser = uid; }, user);
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (/Maximum update|Cannot update a component|Encountered two children/.test(message.text())) errors.push(message.text()); });
  t.after(async () => { await context.close(); assert.deepEqual(errors, [], 'No client runtime or React state errors'); });
  await page.goto(origin);
  await page.locator('.app').waitFor();
  await page.locator('.workspace-loading').waitFor({ state: 'hidden' });
  return page;
}

async function snapshot(page, name) {
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, 'No horizontal overflow');
  if (process.env.BRAIN_DOTS_ARTIFACT_DIR) await page.screenshot({ path: join(process.env.BRAIN_DOTS_ARTIFACT_DIR, `${name}.png`), fullPage: true });
}

test('first account can create Space + Dot inline, chat, and manage memories on mobile', { timeout: 30000 }, async t => {
  const page = await startPage(t, { width: 375, height: 812 });
  await page.getByRole('heading', { name: 'Start your second brain' }).waitFor();
  await page.getByRole('button', { name: 'Create Dot', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Create Dot', exact: true });
  await dialog.getByLabel('Name', { exact: true }).fill('Learning companion');
  await dialog.getByLabel('Instructions', { exact: true }).fill('Help me connect my learning with examples.');
  await dialog.getByLabel('Space name').fill('Learning notes');
  await snapshot(page, 'brain-dots-mobile-create');
  await dialog.getByRole('button', { name: 'Create Space', exact: true }).click();
  await until(() => account('user-a').spaces.length === 1, 'Space was not created');
  assert.equal(await dialog.getByLabel('Name', { exact: true }).inputValue(), 'Learning companion');
  assert.equal(await dialog.getByLabel('Instructions', { exact: true }).inputValue(), 'Help me connect my learning with examples.');
  await dialog.getByRole('button', { name: 'Create Dot', exact: true }).click();
  await page.getByRole('heading', { name: 'Learning companion', exact: true }).waitFor();
  const releaseFirstSend = hold('run:Connect my ideas');
  await page.getByLabel('Message Learning companion').fill('Connect my ideas');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await until(() => requests.some(request => request.path.includes('/run')), 'First conversation send did not start');
  await page.getByLabel('Message Learning companion').fill('A newer unsent thought');
  releaseFirstSend();
  await page.getByText('Reply to Connect my ideas', { exact: true }).waitFor();
  await until(async () => await page.locator('.bubble-pending').count() === 0, 'Optimistic IDs were not reconciled');
  assert.equal(await page.getByLabel('Message Learning companion').inputValue(), 'A newer unsent thought');
  await page.getByLabel('Message Learning companion').fill('');
  await page.getByRole('combobox', { name: 'Navigate or create' }).selectOption('memories');
  await page.getByRole('heading', { name: 'Memories', exact: true }).waitFor();
  await page.getByLabel('What should your Dots remember?').fill('I learn best from concrete examples.');
  await page.getByRole('button', { name: 'Save memory', exact: true }).click();
  await page.getByText('I learn best from concrete examples.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Edit', exact: true }).click();
  await page.getByLabel('Edit memory', { exact: true }).fill('Use concise examples.');
  await page.getByRole('button', { name: 'Save changes', exact: true }).click();
  await page.getByText('Use concise examples.', { exact: true }).waitFor();
  await until(async () => await page.locator('.memory-edit').count() === 0, 'Memory edit did not finish');
  await snapshot(page, 'brain-dots-mobile-memories');
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete memory', exact: true }).click();
  await until(() => account('user-a').memories.length === 0, 'Memory was not deleted');
  await page.getByLabel('What should your Dots remember?').fill('Unsaved preference');
  page.once('dialog', popup => popup.dismiss());
  await page.getByRole('combobox', { name: 'Navigate or create' }).selectOption('home');
  assert.equal(await page.getByLabel('What should your Dots remember?').inputValue(), 'Unsaved preference');
  page.once('dialog', popup => popup.accept());
  await page.getByRole('combobox', { name: 'Navigate or create' }).selectOption('home');
  await page.getByRole('heading', { name: 'Your second brain', exact: true }).waitFor();
  await page.setViewportSize({ width: 1280, height: 900 });
  await snapshot(page, 'brain-dots-desktop-home');
  assert.equal(account('user-a').dots[0].spaceIds[0], account('user-a').spaces[0].id);
  assert.ok(requests.every(request => request.uid === 'user-a'));
});

test('standalone mobile Create Space leads to a Dot and a saved first page', { timeout: 30000 }, async t => {
  const page = await startPage(t, { width: 320, height: 740 });
  await page.getByRole('combobox', { name: 'Navigate or create' }).selectOption('new-space');
  const spaceDialog = page.getByRole('dialog', { name: 'Create Space', exact: true });
  await spaceDialog.getByLabel('Name', { exact: true }).fill('Research notes');
  await spaceDialog.getByLabel('Description (optional)', { exact: true }).fill('A place for what I learn.');
  await spaceDialog.getByRole('button', { name: 'Create Space', exact: true }).click();
  await page.getByRole('button', { name: 'Open Space', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Create Dot', exact: true }).click();
  const dotDialog = page.getByRole('dialog', { name: 'Create Dot', exact: true });
  assert.equal(await dotDialog.getByRole('checkbox', { name: 'Research notes', exact: true }).isChecked(), true);
  await dotDialog.getByRole('button', { name: 'Create Dot', exact: true }).click();
  await page.getByRole('heading', { name: 'My second brain', exact: true }).waitFor();
  await page.getByRole('combobox', { name: 'Navigate or create' }).selectOption('home');
  await page.getByRole('button', { name: 'Write a page', exact: true }).click();
  await page.getByRole('button', { name: 'Create a page', exact: true }).click();
  await page.getByLabel('Page title').fill('Research plan');
  await page.getByLabel('Page content').fill('Questions to explore and ideas to connect.');
  await snapshot(page, 'brain-dots-mobile-page');
  await page.getByRole('combobox', { name: 'Navigate or create' }).selectOption('memories');
  await page.getByRole('heading', { name: 'Memories', exact: true }).waitFor();
  assert.equal(account('user-a').spaces[0].description, 'A place for what I learn.');
  assert.equal(account('user-a').pages[0].title, 'Research plan');
  assert.equal(account('user-a').pages[0].content, 'Questions to explore and ideas to connect.');
});

test('page navigation serializes pending edits and keeps drafts through conflict/error recovery', { timeout: 30000 }, async t => {
  const { data, space } = seed();
  const firstPage = addPage(data, 'user-a', space.id, 'page-a', 'First page');
  addPage(data, 'user-a', space.id, 'page-b', 'Second page', 'Other page content');
  const page = await startPage(t);
  await page.getByRole('button', { name: 'Notebook', exact: true }).click();
  await page.getByLabel('Page title', { exact: true }).waitFor();
  const releaseOlder = hold('patch:Older draft');
  const releaseNewest = hold('patch:Newest draft');
  await page.getByLabel('Page content').fill('Older draft');
  await page.getByRole('button', { name: 'Save now', exact: true }).click();
  await until(() => activePatches === 1, 'First save did not start');
  await page.getByLabel('Page content').fill('Newest draft');
  await page.getByRole('button', { name: /Second page/ }).click();
  assert.equal(await page.getByLabel('Page title').inputValue(), 'First page');
  releaseOlder();
  await until(() => requests.filter(request => request.method === 'PATCH').length === 2, 'Newer edits were not saved after the old acknowledgement');
  assert.equal(await page.getByLabel('Page content').inputValue(), 'Newest draft');
  assert.equal(requests.filter(request => request.method === 'PATCH')[1].body.expectedRevision, 2);
  releaseNewest();
  await until(async () => await page.getByLabel('Page title').inputValue() === 'Second page', 'Navigation did not wait for the latest save');
  assert.equal(maxActivePatches, 1);
  assert.equal(firstPage.content, 'Newest draft');
  await page.getByRole('button', { name: /First page/ }).click();
  await until(async () => await page.getByLabel('Page title').inputValue() === 'First page', 'First page did not reopen');
  firstPage.content = 'Server version to review'; firstPage.revision++;
  await page.getByLabel('Page content').fill('Local draft to preserve');
  await page.getByRole('button', { name: 'Save now', exact: true }).click();
  await page.getByRole('button', { name: 'Review server version' }).waitFor();
  await page.getByRole('button', { name: 'Memories', exact: true }).click();
  assert.equal(await page.getByLabel('Page content').inputValue(), 'Local draft to preserve');
  await page.getByRole('button', { name: 'Review server version' }).click();
  await page.getByText('Server version to review', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Page content').inputValue(), 'Local draft to preserve');
  await snapshot(page, 'brain-dots-desktop-conflict');
  await page.getByRole('button', { name: 'Save my version' }).click();
  await until(() => firstPage.content === 'Local draft to preserve', 'Reviewed local version did not save');
  await until(async () => await page.locator('.save-status').textContent() === 'Saved', 'Reviewed save did not finish in the editor');
  failure.patches = 2;
  await page.getByLabel('Page content').fill('Draft surviving errors');
  await page.getByRole('button', { name: 'Save now', exact: true }).click();
  await page.getByRole('button', { name: 'Retry save' }).waitFor();
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await until(() => failure.patches === 0, 'Navigation did not attempt saving');
  assert.equal(await page.getByLabel('Page content').inputValue(), 'Draft surviving errors');
  await page.getByRole('button', { name: 'Retry save' }).click();
  await until(() => firstPage.content === 'Draft surviving errors', 'Explicit retry lost the draft');
  await page.getByRole('button', { name: 'Home', exact: true }).click();
  await page.getByRole('heading', { name: 'Your second brain', exact: true }).waitFor();
});

test('chat suppresses stale history/send results, reloads stored IDs, and exposes honest cancellation', { timeout: 30000 }, async t => {
  const { data, dot, space } = seed();
  const beta = { ...dot, id: 'dot-beta', name: 'Dot Beta', spaceIds: [space.id] }; data.dots.push(beta);
  addConversation(data, 'user-a', dot.id, 'thread-a1', 'Alpha first', 2, 'Alpha first history');
  addConversation(data, 'user-a', dot.id, 'thread-a2', 'Alpha second', 1, 'Alpha second history');
  addConversation(data, 'user-a', beta.id, 'thread-b1', 'Beta first', 1, 'Beta history');
  const releaseHistory = hold('history:thread-a1');
  const page = await startPage(t);
  await page.getByRole('combobox', { name: 'Conversation', exact: true }).selectOption('thread-a2');
  await page.getByText('Alpha second history', { exact: true }).waitFor();
  releaseHistory();
  assert.equal(await page.getByText('Alpha first history', { exact: true }).count(), 0);
  const releaseSend = hold('run:Old Alpha request');
  await page.getByLabel('Message Dot Alpha').fill('Old Alpha request');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await until(() => requests.some(request => request.path.includes('/run')), 'Send did not start');
  await page.getByRole('combobox', { name: 'Conversation', exact: true }).selectOption('thread-a1');
  await page.getByText('Alpha first history', { exact: true }).waitFor();
  releaseSend();
  await until(() => data.messages['thread-a2'].length === 3, 'Old server run did not finish');
  assert.equal(await page.getByText('Reply to Old Alpha request', { exact: true }).count(), 0);
  const releaseDotSend = hold('run:Old Dot request');
  await page.getByLabel('Message Dot Alpha').fill('Old Dot request');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await until(() => data.messages['thread-a1'].some(message => message.content === 'Old Dot request'), 'Old Dot request did not start');
  await page.getByRole('button', { name: /^Dot Beta / }).click();
  await page.getByText('Beta history', { exact: true }).waitFor();
  releaseDotSend();
  await until(() => data.messages['thread-a1'].some(message => message.content === 'Reply to Old Dot request'), 'Old Dot request did not finish');
  assert.equal(await page.getByText('Reply to Old Dot request', { exact: true }).count(), 0);
  await page.getByLabel('Message Dot Beta').fill('Beta message');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.getByText('Reply to Beta message', { exact: true }).waitFor();
  await until(async () => await page.locator('.bubble-pending').count() === 0, 'Stored message IDs were not reloaded');
  const releaseStop = hold('run:Long request');
  await page.getByLabel('Message Dot Beta').fill('Long request');
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await until(() => data.messages['thread-b1'].some(message => message.content === 'Long request'), 'Long request did not reach the server');
  await page.getByRole('button', { name: 'Stop waiting', exact: true }).click();
  await page.getByText(/The server may still finish the request/).waitFor();
  releaseStop();
  await until(() => data.messages['thread-b1'].some(message => message.content === 'Reply to Long request'), 'Stopped server request did not settle');
  await page.getByRole('button', { name: 'Refresh history', exact: true }).click();
  await page.getByText('Reply to Long request', { exact: true }).waitFor();
  await until(async () => await page.locator('.bubble-pending').count() === 0, 'Cancelled optimistic message did not reconcile');
});

test('expanded tasks poll fresh events and support reviewed retry plus pause/resume and optional Dot', { timeout: 30000 }, async t => {
  const { data, dot } = seed();
  const task = { id: 'task-repeat', userId: 'user-a', prompt: 'Summarize my learning', status: 'interrupted', intervalSeconds: 300, nextRunAt: null, threadId: null, dotId: dot.id, workerId: null, lease: null, leaseUntil: null, createdAt: 1, updatedAt: 1, error: 'Run interrupted.', result: null };
  data.tasks.push(task);
  data.details[task.id] = { runs: [{ id: 'run-interrupted', taskId: task.id, status: 'interrupted', startedAt: 1, finishedAt: 2, result: null, error: 'Worker disconnected.' }], events: [{ id: 'event-initial', taskId: task.id, text: 'Initial event', createdAt: 1 }] };
  const page = await startPage(t);
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await page.getByRole('button', { name: /Summarize my learning/ }).click();
  await page.getByText('Initial event', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Retry after review' }).isDisabled(), true);
  data.details[task.id].events.push({ id: 'event-new', taskId: task.id, text: 'Event added while expanded', createdAt: stamp() });
  await page.getByText('Event added while expanded', { exact: true }).waitFor({ timeout: 9000 });
  await page.getByRole('checkbox', { name: 'I’ve reviewed the run history and events.' }).check();
  await page.getByRole('button', { name: 'Retry after review' }).click();
  await until(() => task.status === 'queued', 'Reviewed retry did not queue the task');
  task.status = 'completed'; task.result = { text: 'New completed result', sources: [], sample: false };
  data.details[task.id].runs.unshift({ id: 'run-completed', taskId: task.id, status: 'completed', startedAt: 3, finishedAt: 4, result: task.result, error: null });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.getByRole('heading', { name: 'Run history (2)' }).waitFor();
  await page.getByRole('button', { name: 'Pause recurring' }).click();
  await page.getByRole('button', { name: 'Resume recurring' }).waitFor();
  assert.equal(task.status, 'paused');
  await page.getByRole('button', { name: 'Resume recurring' }).click();
  await until(() => task.status === 'queued', 'Resume did not queue the recurring task');
  assert.equal(task.intervalSeconds, 300);
  await page.getByLabel('Dot', { exact: true }).selectOption('');
  await page.getByLabel('Task prompt').fill('Default context task');
  await page.getByRole('button', { name: 'Create task', exact: true }).click();
  await until(() => requests.some(request => request.path === '/tasks' && request.method === 'POST'), 'Task creation did not send');
  const create = requests.find(request => request.path === '/tasks' && request.method === 'POST');
  assert.deepEqual(create.body, { prompt: 'Default context task', intervalSeconds: null });
  await until(async () => await page.getByLabel('Task prompt').inputValue() === '', 'Created task draft did not clear');
  await page.getByLabel('Dot', { exact: true }).selectOption(dot.id);
  await page.getByLabel('Repeat', { exact: true }).selectOption('5');
  await page.getByLabel('Task prompt').fill('Explicit Dot context task');
  await page.getByRole('button', { name: 'Create task', exact: true }).click();
  await until(async () => await page.getByLabel('Task prompt').inputValue() === '', 'Explicit Dot task did not finish');
  const explicit = requests.find(request => request.path === '/tasks' && request.method === 'POST' && request.body.prompt === 'Explicit Dot context task');
  assert.deepEqual(explicit.body, { prompt: 'Explicit Dot context task', intervalSeconds: 300, dotId: dot.id });
  failure.taskCreates = 1;
  await page.getByLabel('Task prompt').fill('Keep failed task draft');
  await page.getByRole('button', { name: 'Create task', exact: true }).click();
  await page.getByText('Fixture task creation failed.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  assert.equal(await page.getByLabel('Task prompt').inputValue(), 'Keep failed task draft');
  assert.equal(await page.getByText('Fixture task creation failed.', { exact: true }).isVisible(), true);
});

test('account switches reject old rendered requests and discard stale token/history results', { timeout: 30000 }, async t => {
  const alpha = seed('user-a');
  const beta = seed('user-b');
  alpha.data.memories.push({ id: 'memory-a', userId: 'user-a', text: 'Alpha private preference', createdAt: 1 });
  beta.data.memories.push({ id: 'memory-b', userId: 'user-b', text: 'Beta private preference', createdAt: 1 });
  const releaseAlpha = hold('memories:user-a');
  const page = await startPage(t);
  await page.getByRole('button', { name: 'Memories', exact: true }).click();
  await until(() => requests.some(request => request.path === '/memories' && request.uid === 'user-a'), 'Alpha memories did not start loading');
  await page.evaluate(() => globalThis.__fixtureAuth.switchUser('user-b'));
  await until(async () => await page.locator('.topbar-email').textContent() === 'user-b@example.test', 'Beta account did not render');
  await page.locator('.workspace-loading').waitFor({ state: 'hidden' });
  await page.getByRole('heading', { name: 'Dot Alpha', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Memories', exact: true }).click();
  await page.getByText('Beta private preference', { exact: true }).waitFor();
  releaseAlpha();
  assert.equal(await page.getByText('Alpha private preference', { exact: true }).count(), 0);
  await page.getByLabel('What should your Dots remember?').fill('Must stay in the old account draft');
  await page.evaluate(() => {
    globalThis.__fixtureAuth.switchUser('user-a', false);
    document.querySelector('.memory-create').requestSubmit();
  });
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(requests.filter(request => request.path === '/memories' && request.method === 'POST').length, 0, 'An old rendered component must not use the new account token');
  await page.evaluate(() => globalThis.__fixtureAuth.notify());
  await until(async () => await page.locator('.topbar-email').textContent() === 'user-a@example.test', 'Alpha account did not render');
  await page.locator('.workspace-loading').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: 'Memories', exact: true }).click();
  await page.getByText('Alpha private preference', { exact: true }).waitFor();
  await page.getByLabel('What should your Dots remember?').fill('Pending token draft');
  await page.evaluate(() => globalThis.__fixtureAuth.holdTokens());
  await page.getByRole('button', { name: 'Save memory', exact: true }).click();
  await page.evaluate(() => { globalThis.__fixtureAuth.switchUser('user-b'); globalThis.__fixtureAuth.releaseTokens(); });
  await until(async () => await page.locator('.topbar-email').textContent() === 'user-b@example.test', 'Beta account did not render after the token wait');
  await page.locator('.workspace-loading').waitFor({ state: 'hidden' });
  await page.getByRole('heading', { name: 'Dot Alpha', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Memories', exact: true }).click();
  await page.getByText('Beta private preference', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('What should your Dots remember?').inputValue(), '');
  assert.equal(requests.filter(request => request.path === '/memories' && request.method === 'POST').length, 0);
});
