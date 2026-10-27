import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Snapshot persistence over Supabase Storage (plain HTTP, no SDK).
 *
 * Every deployment container on Render's free tier has an ephemeral disk, so
 * the SQLite database is erased on each redeploy. This module snapshots the
 * database file into a private Storage bucket on a fixed interval and, on
 * boot, restores the newest snapshot when the local file is missing or empty.
 *
 * Opt-in per deployment: SUPABASE_SNAPSHOT_ENABLED=true plus SUPABASE_URL and
 * SUPABASE_SERVICE_ROLE_KEY. The bucket defaults to `dots-backup`. A
 * deployment that merely holds the keys stays inert, which keeps developer
 * machines from racing the deployment that owns the bucket.
 */

export type SnapshotConfig = {
  url: string;
  apiKey: string;
  bucket: string;
  intervalMs: number;
};

export type SnapshotHandle = {
  /** Runs one final snapshot cycle and awaits it (also waits out any in-flight cycle). */
  final: () => Promise<void>;
};

const SNAPSHOT_NAME = /^snap-(\d{16})\.sqlite$/;
const RETAINED_SNAPSHOTS = 3;
const REQUEST_TIMEOUT_MS = 15_000;

export function snapshotConfigFromEnv(
  env: NodeJS.ProcessEnv,
): SnapshotConfig | undefined {
  const enabled = /^(1|true|yes|on)$/i.test(
    env.SUPABASE_SNAPSHOT_ENABLED ?? '',
  );
  if (!enabled) return undefined;
  const url = env.SUPABASE_URL?.trim();
  const apiKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  if (!url || !apiKey)
    throw new Error(
      'SUPABASE_SNAPSHOT_ENABLED is set without both SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY.',
    );
  const bucket = env.SUPABASE_BUCKET?.trim() || 'dots-backup';
  const intervalMs = Math.max(
    60_000,
    Number(env.SUPABASE_SNAPSHOT_INTERVAL_MS ?? 240_000) || 240_000,
  );
  return { url: url.replace(/\/+$/, ''), apiKey, bucket, intervalMs };
}

type StorageJson = { name: string } & Record<string, unknown>;

function storageHeaders(config: SnapshotConfig): HeadersInit {
  return {
    authorization: `Bearer ${config.apiKey}`,
    'content-type': 'application/json',
  };
}

async function listSnapshots(
  config: SnapshotConfig,
  fetchImpl: typeof fetch,
): Promise<string[]> {
  const response = await fetchImpl(
    `${config.url}/storage/v1/object/list/${config.bucket}`,
    {
      method: 'POST',
      headers: storageHeaders(config),
      body: JSON.stringify({ prefix: '', limit: 1000, offset: 0 }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  if (!response.ok)
    throw new Error(
      `Listing snapshots failed (${response.status}): ${await response.text()}`,
    );
  const objects = (await response.json()) as StorageJson[];
  return objects
    .map((object) => object.name)
    .filter((name): name is string => typeof name === 'string')
    .filter((name) => SNAPSHOT_NAME.test(name))
    .sort();
}

async function uploadSnapshot(
  config: SnapshotConfig,
  name: string,
  body: Buffer,
  fetchImpl: typeof fetch,
): Promise<void> {
  const response = await fetchImpl(
    `${config.url}/storage/v1/object/${config.bucket}/${name}`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        'content-type': 'application/octet-stream',
        'x-upsert': 'true',
      },
      body: new Uint8Array(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  if (!response.ok)
    throw new Error(
      `Snapshot upload failed (${response.status}): ${await response.text()}`,
    );
}

export async function restoreLatestSnapshot(
  config: SnapshotConfig,
  databasePath: string,
  fetchImpl: typeof fetch = fetch,
  log: (...parts: unknown[]) => void = console.log,
): Promise<boolean> {
  if (databasePath === ':memory:') return false;
  let existingSize = -1;
  try {
    existingSize = statSync(databasePath).size;
  } catch {
    existingSize = -1;
  }
  if (existingSize > 0) return false;
  const object = (await listSnapshots(config, fetchImpl)).at(-1);
  if (!object) {
    log(
      `[snapshot] no snapshot yet in ${config.bucket}; starting a fresh database`,
    );
    return false;
  }
  const response = await fetchImpl(
    `${config.url}/storage/v1/object/${config.bucket}/${object}`,
    {
      headers: storageHeaders(config),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    },
  );
  if (!response.ok)
    throw new Error(
      `Snapshot download failed (${response.status}): ${await response.text()}`,
    );
  const bytes = Buffer.from(await response.arrayBuffer());
  mkdirSync(dirname(databasePath), { recursive: true });
  writeFileSync(databasePath, bytes);
  log(`[snapshot] restored database from ${object} (${bytes.length} bytes)`);
  return true;
}

function checkpointWal(databasePath: string): void {
  const db = new DatabaseSync(databasePath);
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
}

function pruneSnapshots(
  config: SnapshotConfig,
  names: string[],
  fetchImpl: typeof fetch,
  log: (...parts: unknown[]) => void,
): Promise<unknown[]> {
  const stale = names
    .slice(0, Math.max(0, names.length - RETAINED_SNAPSHOTS))
    .map((name) =>
      fetchImpl(`${config.url}/storage/v1/object/${config.bucket}/${name}`, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${config.apiKey}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      }).then((response) => {
        if (!response.ok)
          log(`[snapshot] pruning ${name} failed (${response.status})`);
      }),
    );
  return Promise.allSettled(stale);
}

export function startSnapshots(
  config: SnapshotConfig,
  databasePath: string,
  fetchImpl: typeof fetch = fetch,
  log: (...parts: unknown[]) => void = (...parts) => console.log(...parts),
): SnapshotHandle | undefined {
  if (databasePath === ':memory:') return undefined;
  let last = Promise.resolve();
  let running = false;
  const runCycle = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      let size = 0;
      try {
        checkpointWal(databasePath);
      } catch (error) {
        log('[snapshot] WAL checkpoint skipped:', error);
      }
      size = statSync(databasePath).size;
      if (size === 0) {
        log('[snapshot] database file is empty; nothing to upload yet');
        return;
      }
      const body = readFileSync(databasePath);
      const name = `snap-${String(Date.now()).padStart(16, '0')}.sqlite`;
      await uploadSnapshot(config, name, body, fetchImpl);
      log(`[snapshot] uploaded ${name} (${body.length} bytes)`);
      const names = await listSnapshots(config, fetchImpl);
      await pruneSnapshots(config, names, fetchImpl, log);
    } catch (error) {
      log('[snapshot] cycle failed:', error);
    } finally {
      running = false;
    }
  };
  const snapshotOnce = (): Promise<void> => {
    const pending = last.then(runCycle);
    last = pending.catch(() => undefined);
    return pending;
  };
  const timer = setInterval(() => void snapshotOnce(), config.intervalMs);
  void snapshotOnce();
  return {
    final: async () => {
      clearTimeout(timer);
      await last;
      await snapshotOnce();
    },
  };
}
