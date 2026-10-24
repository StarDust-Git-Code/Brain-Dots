const windows = new Map<string, number[]>();

// Vercel functions are ephemeral: each instance has its own memory and cold
// starts reset it, so this in-memory limiter is best-effort only. Use a shared
// store (e.g. Firestore, Upstash) if hard limits are required.
export function rateLimit(key: string, limit = 30, windowMs = 60_000): boolean {
  const now = Date.now();
  if (windows.size > 10_000) {
    windows.forEach((hits, existingKey) => {
      if (hits.length === 0 || now - hits[hits.length - 1] >= windowMs) {
        windows.delete(existingKey);
      }
    });
  }
  const hits = (windows.get(key) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) {
    windows.set(key, hits);
    return false;
  }
  hits.push(now);
  windows.set(key, hits);
  return true;
}
