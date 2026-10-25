import assert from 'node:assert/strict';
import test from 'node:test';
import { matchesWorkerToken } from '../worker-token';

test('recognizes only the configured server credential', () => {
  assert.equal(matchesWorkerToken('Bearer fixture-worker-secret', 'fixture-worker-secret'), true);
  assert.equal(matchesWorkerToken('Bearer different-token', 'fixture-worker-secret'), false);
  assert.equal(matchesWorkerToken('Bearer fixture-worker-secret-extra', 'fixture-worker-secret'), false);
});

test('an unset or empty server secret never authenticates a request', () => {
  assert.equal(matchesWorkerToken(null, undefined), false);
  assert.equal(matchesWorkerToken('Bearer undefined', undefined), false);
  assert.equal(matchesWorkerToken('Bearer ', ''), false);
  assert.equal(matchesWorkerToken('Bearer fixture', '  '), false);
});

test('accepts standard Bearer casing and tolerates the configured trailing newline', () => {
  assert.equal(matchesWorkerToken('bearer fixture-token', 'fixture-token\n'), true);
  assert.equal(matchesWorkerToken('Basic fixture-token', 'fixture-token'), false);
  assert.equal(matchesWorkerToken('Bearer fixture token', 'fixture token'), false);
});
