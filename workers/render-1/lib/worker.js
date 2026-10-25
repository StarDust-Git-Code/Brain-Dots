import { errorMessage, validateInterval, wait, withDeadline } from './control.js';
import { PING_TIMEOUT_MS, TURN_TIMEOUT_MS } from './turn.js';

export const DEFAULT_POLL_INTERVAL_MS = 30_000;
export const PING_INTERVAL_MS = 10 * 60 * 1000;
export const HEARTBEAT_INTERVAL_MS = 60_000;
export const OWNERSHIP_INTERVAL_MS = 15_000;
export const SHUTDOWN_TIMEOUT_MS = 5000;

export function pollIntervalFromEnv(env = process.env) {
  const value = env.WORKER_POLL_INTERVAL_MS;
  return value == null || value.trim() === '' ? DEFAULT_POLL_INTERVAL_MS :
    validateInterval(Number(value), 'WORKER_POLL_INTERVAL_MS');
}

// Scheduling is explicit: constructing/importing a worker does not start it.
export function createWorker({
  claimer, runTurn, ping = null, logger = console, clock = Date.now,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS, pingIntervalMs = PING_INTERVAL_MS,
  heartbeatIntervalMs = HEARTBEAT_INTERVAL_MS, ownershipIntervalMs = OWNERSHIP_INTERVAL_MS,
  turnTimeoutMs = TURN_TIMEOUT_MS, pingTimeoutMs = PING_TIMEOUT_MS,
  ownershipTimeoutMs = 10_000, shutdownTimeoutMs = SHUTDOWN_TIMEOUT_MS,
}) {
  if (!claimer || typeof runTurn !== 'function') throw new Error('Worker requires a claimer and runTurn.');
  for (const [name, value] of Object.entries({ pollIntervalMs, pingIntervalMs, heartbeatIntervalMs,
    ownershipIntervalMs, turnTimeoutMs, pingTimeoutMs, ownershipTimeoutMs, shutdownTimeoutMs })) {
    validateInterval(value, name);
  }
  const lifecycle = new AbortController();
  const startedAt = clock();
  let started = false;
  let active = null;
  let lastSuccessfulPingAt = null;
  let loopPromise = Promise.resolve();
  let pingPromise = Promise.resolve();
  let stopPromise = null;

  async function execute(claim) {
    const controller = new AbortController();
    const monitorStop = new AbortController();
    const onShutdown = () => controller.abort(lifecycle.signal.reason);
    const onAbort = () => monitorStop.abort();
    lifecycle.signal.addEventListener('abort', onShutdown, { once: true });
    controller.signal.addEventListener('abort', onAbort, { once: true });
    active = { claim, controller };
    if (lifecycle.signal.aborted) onShutdown();
    let monitorPromise = Promise.resolve();

    const leaseCall = (method, signal) => withDeadline(
      (operationSignal) => claimer[method](claim, { signal: operationSignal }),
      { signal, timeoutMs: ownershipTimeoutMs, message: 'Task lease verification timed out.' },
    );
    const record = (method, value, signal) => withDeadline(
      (operationSignal) => claimer[method](claim, value, { signal: operationSignal }),
      { signal, timeoutMs: method === 'settleInterrupted'
        ? Math.min(ownershipTimeoutMs, shutdownTimeoutMs) : ownershipTimeoutMs,
      message: 'Task settlement timed out.' },
    );

    async function monitor() {
      let nextHeartbeatAt = clock() + heartbeatIntervalMs;
      try {
        while (!monitorStop.signal.aborted) {
          await wait(ownershipIntervalMs, monitorStop.signal);
          const heartbeatDue = clock() >= nextHeartbeatAt;
          const owned = await leaseCall(heartbeatDue ? 'heartbeat' : 'checkOwnership', monitorStop.signal);
          if (monitorStop.signal.aborted) return;
          if (!owned) {
            controller.abort(new Error('Task lease revoked or expired. Review effects before retrying.'));
            return;
          }
          if (heartbeatDue) nextHeartbeatAt = clock() + heartbeatIntervalMs;
        }
      } catch (error) {
        if (!monitorStop.signal.aborted) {
          controller.abort(new Error(`Task lease could not be verified: ${errorMessage(error)}`));
        }
      }
    }

    try {
      if (!await leaseCall('checkOwnership', controller.signal)) {
        controller.abort(new Error('Task lease revoked or expired. Review effects before retrying.'));
      }
      controller.signal.throwIfAborted();
      monitorPromise = monitor();
      const result = await withDeadline(
        (signal) => runTurn(claim, { signal }),
        { signal: controller.signal, timeoutMs: turnTimeoutMs,
          message: 'Agent turn timed out; completion is unconfirmed. Review effects before retrying.' },
      );
      monitorStop.abort();
      await monitorPromise;
      controller.signal.throwIfAborted();
      const settled = await record('settleSuccess', result, controller.signal);
      if (!settled) logger.warn('Run result discarded: task ownership is no longer held.');
    } catch (error) {
      monitorStop.abort();
      const interrupted = controller.signal.aborted || error?.name === 'TimeoutError';
      const reason = controller.signal.aborted ? controller.signal.reason : error;
      try {
        let settled;
        if (interrupted) {
          settled = await record('settleInterrupted', errorMessage(reason));
        } else {
          try {
            settled = await record('settleFailure', errorMessage(reason), controller.signal);
          } catch (settlementError) {
            if (!controller.signal.aborted) throw settlementError;
          }
          // Shutdown can reject a pending failure RPC or make its transaction
          // return false. In either case interrupt only while this claim owns it.
          if (!settled && controller.signal.aborted) {
            settled = await record('settleInterrupted', errorMessage(controller.signal.reason));
          }
        }
        if (!settled) logger.warn('Run outcome discarded: task ownership is no longer held.');
      } catch (settlementError) {
        logger.error(`Task settlement error: ${errorMessage(settlementError)}`);
      }
    } finally {
      monitorStop.abort();
      await monitorPromise;
      lifecycle.signal.removeEventListener('abort', onShutdown);
      controller.signal.removeEventListener('abort', onAbort);
      active = null;
    }
  }

  async function loop() {
    while (!lifecycle.signal.aborted) {
      let claim = null;
      try {
        // Keep the promise attached during shutdown so a claim whose commit was
        // already in flight is interrupted before any agent request is sent.
        claim = await claimer.claimTask({ signal: lifecycle.signal });
        if (claim) await execute(claim);
      } catch (error) {
        if (!lifecycle.signal.aborted) logger.error(`Worker loop error: ${errorMessage(error)}`);
      }
      if (!claim && !lifecycle.signal.aborted) {
        try { await wait(pollIntervalMs, lifecycle.signal); } catch { break; }
      }
    }
  }

  async function pingLoop() {
    while (!lifecycle.signal.aborted) {
      try {
        await wait(pingIntervalMs, lifecycle.signal);
        await withDeadline((signal) => ping({ signal }), {
          signal: lifecycle.signal, timeoutMs: pingTimeoutMs, message: 'Self-ping timed out.',
        });
        if (!lifecycle.signal.aborted) lastSuccessfulPingAt = new Date(clock()).toISOString();
      } catch (error) {
        if (lifecycle.signal.aborted) return;
        logger.warn(`Self-ping failed: ${errorMessage(error)}`);
      }
    }
  }

  function start() {
    if (started || lifecycle.signal.aborted) return;
    started = true;
    loopPromise = loop();
    if (ping) pingPromise = pingLoop();
  }

  function stop(reason = 'Worker shutting down.') {
    if (stopPromise) return stopPromise;
    lifecycle.abort(new Error(`${reason} Review completed effects before retrying.`));
    stopPromise = withDeadline(() => Promise.allSettled([loopPromise, pingPromise]), {
      timeoutMs: shutdownTimeoutMs, message: 'Worker shutdown deadline reached.',
    }).then(() => true, (error) => {
      logger.warn(errorMessage(error));
      return false;
    });
    return stopPromise;
  }

  function health() {
    return {
      stopping: lifecycle.signal.aborted, busy: active !== null,
      uptimeSeconds: Math.max(0, Math.floor((clock() - startedAt) / 1000)),
      selfPingEnabled: Boolean(ping), lastSuccessfulPingAt,
    };
  }

  return { start, stop, health };
}
