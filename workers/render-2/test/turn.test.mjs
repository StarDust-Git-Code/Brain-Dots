import assert from 'node:assert/strict';
import test from 'node:test';
import { pingSelf, runTurn } from '../lib/turn.js';

const claim = { id: 'task-id', lease: 'lease-proof', dotId: 'dot/id', threadId: 'thread-id',
  prompt: 'Research this', workerId: 'worker-id', runId: 'run-id', userId: 'task-owner' };
const options = { apiUrl: 'https://example.test/', ownerToken: 'test-owner-token', timeoutMs: 500 };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });

test('worker turn sends exactly the new owner-token task/lease proof contract', async () => {
  let request;
  const result = await runTurn(claim, { ...options, fetchImpl: async (url, init) => {
    request = { url, ...init };
    return json({ text: 'A real brief' });
  } });
  assert.equal(request.url, 'https://example.test/api/copilotkit/agent/dot%2Fid/run');
  assert.equal(request.method, 'POST');
  assert.deepEqual(request.headers, {
    'Content-Type': 'application/json', Authorization: 'Bearer test-owner-token',
  });
  assert.deepEqual(JSON.parse(request.body), {
    threadId: claim.threadId, messages: [{ role: 'user', content: claim.prompt }],
    taskId: claim.id, lease: claim.lease,
  });
  assert.deepEqual(result, { text: 'A real brief', sources: [], sample: false });
});

test('missing task proofs, dot/thread, prompt or owner token fail before making a request', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return json({ text: 'unexpected' }); };
  for (const field of ['id', 'lease', 'dotId', 'threadId', 'prompt']) {
    await assert.rejects(runTurn({ ...claim, [field]: '  ' }, { ...options, fetchImpl }),
      new RegExp(`nonempty ${field}`));
  }
  await assert.rejects(runTurn(claim, { ...options, ownerToken: '', fetchImpl }), /OWNER_TOKEN/);
  assert.equal(calls, 0);
});

test('error JSON, empty/whitespace text and malformed responses cannot become successful briefs', async () => {
  for (const value of [null, { error: 'API failed' }, { text: '' }, { text: '  \n' },
    { text: 'not a success', error: 'API failed' }, { text: 'not a success', ok: false }]) {
    await assert.rejects(runTurn(claim, { ...options, fetchImpl: async () => json(value) }),
      /nonempty successful text/);
  }
  await assert.rejects(runTurn(claim, { ...options, fetchImpl: async () => new Response('invalid-json') }),
    /invalid JSON/);
  await assert.rejects(runTurn(claim, { ...options, fetchImpl: async () => json({ error: 'denied' }, 403) }),
    /HTTP 403/);
});

test('turn deadlines bound both a stuck fetch and a stuck response body', { timeout: 2000 }, async (t) => {
  for (const phase of ['fetch', 'body']) {
    await t.test(phase, async () => {
      let signal;
      const fetchImpl = async (_url, init) => {
        signal = init.signal;
        if (phase === 'fetch') return new Promise(() => {});
        return { ok: true, json: () => new Promise(() => {}) };
      };
      await assert.rejects(runTurn(claim, { ...options, timeoutMs: 30, fetchImpl }),
        (error) => error.name === 'TimeoutError');
      assert.equal(signal.aborted, true);
    });
  }
});

test('caller cancellation propagates to the agent request and prevents late success', async () => {
  const controller = new AbortController();
  const reason = new Error('Task paused.');
  let requestSignal;
  const promise = runTurn(claim, { ...options, signal: controller.signal,
    fetchImpl: async (_url, { signal }) => {
      requestSignal = signal;
      controller.abort(reason);
      return json({ text: 'too late' });
    } });
  await assert.rejects(promise, (error) => error === reason);
  assert.equal(requestSignal.aborted, true);
  let called = false;
  await assert.rejects(runTurn(claim, { ...options, signal: controller.signal,
    fetchImpl: async () => { called = true; return json({ text: 'unexpected' }); } }),
  (error) => error === reason);
  assert.equal(called, false);
});

test('self-ping requires HTTP success, has a deadline and propagates cancellation', { timeout: 2000 }, async () => {
  let url;
  await pingSelf('https://worker.example.test/', { fetchImpl: async (value) => {
    url = value;
    return json({ ok: true });
  } });
  assert.equal(url, 'https://worker.example.test/api/ping');
  await assert.rejects(pingSelf('https://worker.example.test', {
    fetchImpl: async () => json({ ok: false }, 503),
  }), /HTTP 503/);
  let timedOutSignal;
  await assert.rejects(pingSelf('https://worker.example.test', {
    timeoutMs: 30, fetchImpl: async (_url, { signal }) => {
      timedOutSignal = signal;
      return new Promise(() => {});
    },
  }), (error) => error.name === 'TimeoutError');
  assert.equal(timedOutSignal.aborted, true);
  const controller = new AbortController();
  await assert.rejects(pingSelf('https://worker.example.test', {
    signal: controller.signal, fetchImpl: async () => {
      controller.abort(new Error('Shutdown.'));
      return new Promise(() => {});
    },
  }), /Shutdown/);
});
