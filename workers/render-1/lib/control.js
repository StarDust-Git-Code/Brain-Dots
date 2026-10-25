import { setTimeout as delay } from 'node:timers/promises';

export class DeadlineError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TimeoutError';
  }
}

export const errorMessage = (error) => error instanceof Error ? error.message : String(error);

export function validateInterval(value, name) {
  if (!Number.isInteger(value) || value <= 0 || value > 2_147_483_647) {
    throw new Error(`${name} must be a positive integer no greater than 2147483647.`);
  }
  return value;
}

// The race also bounds implementations which ignore AbortSignal. Native fetch
// receives the same signal, including while reading its response body.
export async function withDeadline(operation, { signal, timeoutMs, message = 'Operation timed out.' }) {
  validateInterval(timeoutMs, 'timeoutMs');
  const controller = new AbortController();
  const relayAbort = () => controller.abort(signal.reason ?? new Error('Operation cancelled.'));
  let rejectAbort;
  const aborted = new Promise((_resolve, reject) => { rejectAbort = reject; });
  const onAbort = () => rejectAbort(controller.signal.reason);
  controller.signal.addEventListener('abort', onAbort, { once: true });
  signal?.addEventListener('abort', relayAbort, { once: true });
  if (signal?.aborted) relayAbort();
  const timer = setTimeout(() => controller.abort(new DeadlineError(message)), timeoutMs);
  try {
    const pending = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return operation(controller.signal);
    });
    const result = await Promise.race([pending, aborted]);
    controller.signal.throwIfAborted();
    return result;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', relayAbort);
    controller.signal.removeEventListener('abort', onAbort);
  }
}

export function wait(ms, signal) {
  return delay(ms, undefined, { signal });
}

export async function closeHttpServer(server, timeoutMs = 5000) {
  try {
    await withDeadline(() => new Promise((resolve, reject) => {
      server.close((error) => {
        if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') reject(error);
        else resolve();
      });
      server.closeIdleConnections?.();
    }), { timeoutMs, message: 'HTTP server shutdown timed out.' });
    return true;
  } catch {
    server.closeAllConnections?.();
    return false;
  }
}
