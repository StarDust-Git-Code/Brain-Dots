import { expect, it } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  statSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  restoreLatestSnapshot,
  snapshotConfigFromEnv,
  startSnapshots,
} from '../src/server/supabase-snapshot.js';

const config = {
  url: 'https://ref.supabase.co',
  apiKey: 'key',
  bucket: 'dots-backup',
  intervalMs: 240_000,
};

const silent = () => undefined;

function fakeFetch(
  handlers: Record<
    string,
    (url: URL, init: RequestInit) => Response | Promise<Response>
  >,
) {
  const calls: string[] = [];
  const impl = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? 'GET'} ${url.href}`);
    const handler = Object.entries(handlers).find(([path]) =>
      url.href.includes(path),
    );
    if (!handler) throw new Error(`Unexpected request for ${url.href}`);
    return Promise.resolve(handler[1](url, init ?? {}));
  }) as typeof fetch;
  return { impl, calls };
}

function seededDatabase(path: string, contents: string): void {
  const db = new DatabaseSync(path);
  db.exec(
    'CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, text TEXT NOT NULL);',
  );
  db.prepare('INSERT OR REPLACE INTO notes VALUES (1, ?)').run(contents);
  db.close();
}

it('only enables snapshot persistence when fully configured', () => {
  expect(snapshotConfigFromEnv({})).toBeUndefined();
  expect(
    snapshotConfigFromEnv({ SUPABASE_URL: 'https://x.supabase.co' }),
  ).toBeUndefined();
  expect(() =>
    snapshotConfigFromEnv({
      SUPABASE_SNAPSHOT_ENABLED: 'true',
      SUPABASE_URL: 'https://x.supabase.co',
    }),
  ).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  expect(
    snapshotConfigFromEnv({
      SUPABASE_SNAPSHOT_ENABLED: 'true',
      SUPABASE_URL: 'https://x.supabase.co/',
      SUPABASE_SERVICE_ROLE_KEY: 'k',
    }),
  ).toEqual({
    url: 'https://x.supabase.co',
    apiKey: 'k',
    bucket: 'dots-backup',
    intervalMs: 240_000,
  });
  expect(
    snapshotConfigFromEnv({
      SUPABASE_SNAPSHOT_ENABLED: '1',
      SUPABASE_URL: 'https://x.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'k',
      SUPABASE_BUCKET: 'b',
      SUPABASE_SNAPSHOT_INTERVAL_MS: '1000',
    })?.intervalMs,
  ).toBe(60_000);
});

it('leaves a healthy local database untouched', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'snap-'));
  const dbPath = join(dir, 'data', 'store.sqlite');
  mkdirSync(dirname(dbPath), { recursive: true });
  try {
    seededDatabase(dbPath, 'present');
    const { impl, calls } = fakeFetch({});
    await expect(
      restoreLatestSnapshot(config, dbPath, impl, silent),
    ).resolves.toBe(false);
    expect(calls).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('restores the newest snapshot when the local file is missing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'snap-'));
  const dbPath = join(dir, 'data', 'store.sqlite');
  const payload = 'restored-bytes';
  const { impl, calls } = fakeFetch({
    '/storage/v1/object/list/': () =>
      Response.json([
        { name: 'noise.txt' },
        { name: 'snap-0000000000000042.sqlite' },
        { name: 'snap-0000000000000100.sqlite' },
      ]),
    '/object/dots-backup/snap-0000000000000100.sqlite': () =>
      new Response(payload, { status: 200 }),
  });
  try {
    expect(statSync(dbPath, { throwIfNoEntry: false })).toBeUndefined();
    await expect(
      restoreLatestSnapshot(config, dbPath, impl, silent),
    ).resolves.toBe(true);
    expect(statSync(dbPath).size).toBe(payload.length);
    expect(
      calls.filter((call) => call.includes('snap-0000000000000042')),
    ).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('keeps a missing database fresh when the bucket has no snapshots', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'snap-'));
  const dbPath = join(dir, 'data', 'store.sqlite');
  const { impl, calls } = fakeFetch({
    '/storage/v1/object/list/': () => Response.json([{ name: 'noise.txt' }]),
  });
  try {
    await expect(
      restoreLatestSnapshot(config, dbPath, impl, silent),
    ).resolves.toBe(false);
    expect(statSync(dbPath, { throwIfNoEntry: false })).toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('uploads a checkpointed snapshot immediately and prunes older ones', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'snap-'));
  const dbPath = join(dir, 'store.sqlite');
  seededDatabase(dbPath, 'first');
  let uploaded = 0;
  const stored = [
    'snap-0000000000000001.sqlite',
    'snap-0000000000000002.sqlite',
    'snap-0000000000000003.sqlite',
  ];
  const { impl, calls } = fakeFetch({
    '/storage/v1/object/list/': () =>
      Response.json(stored.map((name) => ({ name }))),
    '/storage/v1/object/dots-backup/': (url, init) => {
      const name = url.pathname.split('/').at(-1) ?? '';
      if (init.method === 'DELETE') {
        stored.splice(stored.indexOf(name), 1);
        return Response.json({ message: 'deleted' }, { status: 200 });
      }
      uploaded += 1;
      stored.push(name);
      return Response.json({ Key: 'ok' }, { status: 200 });
    },
  });
  try {
    const handle = startSnapshots(config, dbPath, impl, silent);
    await handle?.final();
    // One cycle at start plus the deliberate final flush.
    expect(uploaded).toBe(2);
    // One prune per cycle (start cycle + final flush).
    expect(calls.filter((call) => call.includes('DELETE ')).length).toBe(2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

it('skips snapshotting an empty database file and in-memory stores', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'snap-'));
  const dbPath = join(dir, 'empty.sqlite');
  writeFileSync(dbPath, '');
  const { impl, calls } = fakeFetch({});
  try {
    const handle = startSnapshots(config, dbPath, impl, silent);
    await handle?.final();
    expect(calls).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  expect(startSnapshots(config, ':memory:', impl, silent)).toBeUndefined();
});
