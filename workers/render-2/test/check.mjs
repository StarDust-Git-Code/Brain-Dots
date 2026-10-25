import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = ['index.js', 'lib/claim.js', 'lib/control.js', 'lib/turn.js', 'lib/worker.js',
  'test/claim.test.mjs', 'test/turn.test.mjs', 'test/worker.test.mjs',
  'test/double-claim.test.mjs', 'test/helpers/memory-firestore.mjs',
  'test/helpers/emulator.mjs', 'test/check.mjs'];
for (const file of files) {
  const check = spawnSync(process.execPath, ['--check', file], {
    cwd: root, encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(check.status, 0, `${file}: ${check.error?.message ?? check.stderr}`);
  console.log(`PASS node --check ${file}`);
}

const originalFetch = globalThis.fetch;
globalThis.fetch = () => { throw new Error('Module import attempted network I/O.'); };
try {
  await Promise.all(['../index.js', '../lib/claim.js', '../lib/control.js', '../lib/turn.js',
    '../lib/worker.js', './helpers/memory-firestore.mjs', './helpers/emulator.mjs']
    .map((file) => import(file)));
  const { getApps } = await import('firebase-admin/app');
  assert.equal(getApps().length, 0, 'Import initialized Firebase.');
  console.log('PASS 7 side-effect-free module imports (fetch blocked; no Firebase apps)');
} finally {
  globalThis.fetch = originalFetch;
}
