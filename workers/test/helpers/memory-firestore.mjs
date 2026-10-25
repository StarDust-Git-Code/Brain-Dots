import { randomUUID } from 'node:crypto';

const clone = (value) => structuredClone(value);

// An optimistic transaction store, not a mock of the claimer. It retries on
// document/query version conflicts and rejects reads after writes, like Firestore.
// Hooks let tests interleave an independent writer at query/commit boundaries.
export function createMemoryFirestore() {
  const records = new Map();
  const versions = new Map();
  const revisions = new Map();
  const db = { afterQuery: null, beforeCommit: null, transactionAttempts: 0 };
  const version = (path) => versions.get(path) ?? 0;
  const revision = (path) => revisions.get(path) ?? 0;

  function document(path) {
    return {
      path, id: path.split('/').at(-1),
      collection: (name) => query(`${path}/${name}`),
      get: async () => snapshot(path),
      set: async (data, options) => apply([{ type: 'set', path, data, merge: options?.merge }]),
      update: async (data) => apply([{ type: 'update', path, data }]),
      delete: async () => apply([{ type: 'delete', path }]),
    };
  }

  function snapshot(path) {
    const value = clone(records.get(path));
    return { id: path.split('/').at(-1), ref: document(path), exists: records.has(path),
      data: () => clone(value) };
  }

  function query(path, filters = [], ordering = [], cap = Infinity) {
    const ref = {
      path, filters, ordering, cap, isQuery: true,
      doc: (id = randomUUID()) => document(`${path}/${id}`),
      where: (field, operator, value) => query(path, [...filters, [field, operator, value]], ordering, cap),
      orderBy: (field, direction = 'asc') => query(path, filters, [...ordering, [field, direction]], cap),
      limit: (value) => query(path, filters, ordering, value),
      get: async () => {
        const result = querySnapshot(ref);
        await db.afterQuery?.(ref, result);
        return result;
      },
    };
    return ref;
  }

  function querySnapshot(ref) {
    let paths = [...records.keys()].filter((path) => path.slice(0, path.lastIndexOf('/')) === ref.path);
    paths = paths.filter((path) => {
      const data = records.get(path);
      return ref.ordering.every(([field]) => data[field] !== undefined) &&
        ref.filters.every(([field, operator, value]) => {
          if (data[field] === undefined) return false;
          if (operator === '==') return data[field] === value;
          if (operator === '<=') return data[field] !== null && data[field] <= value;
          throw new Error(`Unsupported query operator: ${operator}`);
        });
    });
    paths.sort((a, b) => {
      for (const [field, direction] of ref.ordering) {
        const left = records.get(a)[field];
        const right = records.get(b)[field];
        if (left !== right) return (left < right ? -1 : 1) * (direction === 'asc' ? 1 : -1);
      }
      return a.localeCompare(b);
    });
    const docs = paths.slice(0, ref.cap).map(snapshot);
    return { docs, size: docs.length, empty: docs.length === 0, forEach: (fn) => docs.forEach(fn) };
  }

  function apply(writes) {
    const next = new Map(records);
    for (const write of writes) {
      if (write.type === 'delete') next.delete(write.path);
      else if (write.type === 'update' || write.merge) {
        if (write.type === 'update' && !next.has(write.path)) throw new Error(`Missing document: ${write.path}`);
        next.set(write.path, { ...next.get(write.path), ...clone(write.data) });
      } else next.set(write.path, clone(write.data));
    }
    for (const write of writes) {
      if (next.has(write.path)) records.set(write.path, next.get(write.path));
      else records.delete(write.path);
      versions.set(write.path, version(write.path) + 1);
      const parent = write.path.slice(0, write.path.lastIndexOf('/'));
      revisions.set(parent, revision(parent) + 1);
    }
  }

  db.collection = (path) => query(path);
  db.runTransaction = async (operation) => {
    for (let attempt = 1; attempt <= 25; attempt += 1) {
      db.transactionAttempts += 1;
      const reads = new Map();
      const queryReads = new Map();
      const writes = [];
      const tx = {
        writes,
        get: async (ref) => {
          if (writes.length) throw new Error('Firestore transactions require all reads before writes.');
          if (ref.isQuery) {
            queryReads.set(ref.path, revision(ref.path));
            const result = querySnapshot(ref);
            for (const doc of result.docs) reads.set(doc.ref.path, version(doc.ref.path));
            return result;
          }
          reads.set(ref.path, version(ref.path));
          return snapshot(ref.path);
        },
        set: (ref, data) => { writes.push({ type: 'set', path: ref.path, data: clone(data) }); },
        update: (ref, data) => { writes.push({ type: 'update', path: ref.path, data: clone(data) }); },
        delete: (ref) => { writes.push({ type: 'delete', path: ref.path }); },
      };
      const result = await operation(tx);
      await db.beforeCommit?.(tx, attempt);
      if ([...reads].some(([path, readVersion]) => version(path) !== readVersion) ||
          [...queryReads].some(([path, readRevision]) => revision(path) !== readRevision)) continue;
      apply(writes);
      return result;
    }
    throw new Error('Transaction contention exceeded the retry limit.');
  };
  return db;
}

export async function seedTask(db, id, overrides = {}, now = 1_000_000) {
  const ref = db.collection('tasks').doc(id);
  await ref.set({
    userId: 'test-user', prompt: 'Research this task', status: 'queued',
    intervalSeconds: null, nextRunAt: null, threadId: 'test-thread', dotId: 'test-dot',
    workerId: null, lease: null, leaseUntil: null, runId: null,
    createdAt: now - 10_000, updatedAt: now - 10_000, error: null, result: null,
    ...overrides,
  });
  return ref;
}
