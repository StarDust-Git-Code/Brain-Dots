import { createHmac } from 'node:crypto';
import { z } from 'zod';
import {
  computerInputs,
  computerPermissionsSchema,
  type ComputerAction,
  type ComputerControl,
  type ComputerStatus,
} from '../shared/computer-types.js';
import type { WorkspaceStore } from './workspace.js';
import type { ComputerRemote, PlatformConfig } from './platform-config.js';
const stateSchema = z.object({
  botId: z.string(),
  container: z.string(),
  status: z.string(),
  port: z.number().int().min(1024).max(65535).optional(),
  url: z.string().optional(),
});
const controlSchema = z.object({
  holder: z.enum(['bot', 'human']),
  requested: z.boolean(),
  transitioning: z.boolean(),
  resumeSnapshotRequired: z.boolean(),
  request: z.object({ id: z.string(), status: z.string() }).optional(),
});
export class ComputerService {
  /**
   * When the app last installed each Dot's egress policy on a remote stack.
   * Remote boxes keep policies in memory, so a cold start (free tiers idle
   * out after ~15 minutes) drops them; before acting we re-push when stale.
   */
  private remotePolicies = new Map<string, number>();

  constructor(
    private workspace: WorkspaceStore,
    private config: PlatformConfig,
    private paused: () => boolean,
    private transport: typeof fetch = fetch,
    private deadlineMs = 70000,
  ) {}
  get configured() {
    return !!(
      (this.config.computerSupervisorUrl?.trim() &&
        this.config.computerSupervisorToken?.trim() &&
        this.config.computerToken?.trim()) ||
      (this.config.computerToken?.trim() &&
        !!this.config.computerRemotes?.length)
    );
  }
  /**
   * The remote stack a Dot runs on. Explicit assignment wins; a Dot whose
   * assigned box is no longer configured falls back to the first remote.
   * There is no hash-based default: boxes authorize one fixed secret, so a
   * Dot may only run where its token is valid.
   */
  private remoteFor(id: string) {
    if (
      !this.config.computerRemotes?.length ||
      !this.config.computerToken?.trim()
    )
      return undefined;
    const name = this.workspace.computers.assignment(id);
    const assigned = name
      ? this.config.computerRemotes.find((remote) => remote.name === name)
      : undefined;
    return assigned ?? this.config.computerRemotes[0];
  }
  private remoteOrigin(id: string) {
    const remote = this.remoteFor(id);
    if (!remote) throw new Error('Computer service is not configured.');
    return remote.url;
  }
  /**
   * The credential this Dot presents to its box: the box's own token when one
   * is configured, else the per-Dot derived HMAC token.
   */
  private remoteToken(remote: ComputerRemote | undefined, id: string) {
    const boxToken = remote?.token?.trim();
    return boxToken || this.token(id);
  }
  private token(id: string) {
    return createHmac('sha256', this.config.computerToken!.trim())
      .update(`opendots-computer:${id}`)
      .digest('hex');
  }
  /**
   * A remote box refuses browser and shell network traffic until a policy
   * arrives (upstream deploys push one "before it acts and whenever the
   * computer wakes"). Free tiers spin unattended boxes down, so the push is
   * repeated when it may have been lost to a cold start.
   */
  private async ensureRemotePolicy(id: string, signal?: AbortSignal) {
    const remote = this.remoteFor(id);
    if (!remote) return;
    const installed = this.remotePolicies.get(id) ?? 0;
    if (Date.now() - installed < 300_000) return;
    await this.json(
      `${remote.url}/egress-policy`,
      this.remoteToken(remote, id),
      { policy: { mode: 'allow_all' } },
      signal,
      id,
      'PUT',
    );
    this.remotePolicies.set(id, Date.now());
  }
  private requireDot(id: string) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(id) || !this.workspace.dot(id))
      throw new Error('Dot not found.');
  }
  private allowed(
    id: string,
    kind: 'browser' | 'files' | 'shell' | undefined,
    actor: 'agent' | 'owner',
  ) {
    this.requireDot(id);
    if (!this.configured)
      throw new Error('Computer service is not configured.');
    const policy = this.workspace.computers.permissions(id);
    if (!policy.enabled || (kind && !policy[kind]))
      throw new Error('Computer permission is disabled.');
    if (actor === 'agent' && this.paused())
      throw new Error('Agents are paused.');
  }
  private async json(
    url: string,
    token: string,
    body: unknown | undefined,
    signal?: AbortSignal,
    dotId?: string,
    method?: 'POST' | 'PUT',
  ): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.deadlineMs);

    const combined = signal
      ? AbortSignal.any([signal, controller.signal])
      : controller.signal;
    try {
      const response = await this.transport(url, {
        method: method ?? (body === undefined ? 'GET' : 'POST'),
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
          ...(dotId ? { 'x-openbot-bot-id': dotId } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'error',
        signal: combined,
      });
      if (response.status === 409)
        throw new Error(
          'Computer service returned HTTP 409: refresh the browser with computer_snapshot before retrying. If the owner has control, wait for them to release it; do not bypass takeover.',
        );
      if (!response.ok)
        throw new Error(`Computer service returned HTTP ${response.status}.`);
      if (!response.body)
        throw new Error('Computer service returned an empty response.');
      const reader = response.body.getReader();
      let size = 0;
      const chunks: Uint8Array[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 4_000_000) {
          await reader.cancel();
          throw new Error('Computer response exceeded its size limit.');
        }
        chunks.push(value);
      }
      // Infrastructure secrets must never leave the gateway even if an upstream response reflects one.
      let text = Buffer.concat(chunks).toString('utf8');
      for (const secret of [
        token,
        this.config.computerToken?.trim(),
        this.config.computerSupervisorToken?.trim(),
      ])
        if (secret) text = text.split(secret).join('[redacted]');
      return JSON.parse(text);
    } catch (error) {
      if (combined.aborted)
        throw new Error('Computer request was cancelled or timed out.', {
          cause: error,
        });
      if (
        error instanceof Error &&
        /^Computer (service returned|response exceeded)/.test(error.message)
      )
        throw error;
      throw new Error(
        'Computer service is unavailable or returned an invalid response.',
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }
  }
  private supervisor(path: string, body?: unknown, signal?: AbortSignal) {
    return this.json(
      `${this.config.computerSupervisorUrl!.replace(/\/$/, '')}${path}`,
      this.config.computerSupervisorToken!.trim(),
      body,
      signal,
    );
  }
  private parseUpstream<T>(schema: z.ZodType<T>, raw: unknown): T {
    const result = schema.safeParse(raw);
    if (!result.success)
      throw new Error('Computer service returned an invalid response.', {
        cause: result.error,
      });
    return result.data;
  }
  private endpoint(id: string, raw: unknown) {
    const state = this.parseUpstream(stateSchema, raw);
    const ns = this.config.computerNamespace ?? 'opendots';
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(ns))
      throw new Error('Invalid computer namespace.');
    const expected = `${ns}-computer-${id}`;
    if (state.botId !== id || state.container !== expected)
      throw new Error('Computer identity mismatch.');
    const url = new URL(
      state.url ??
        (state.port
          ? `http://127.0.0.1:${state.port}`
          : `http://${expected}:4100`),
    );
    const network =
      url.hostname === expected.toLowerCase() && url.port === '4100';
    const local =
      url.hostname === '127.0.0.1' &&
      !!state.port &&
      url.port === String(state.port) &&
      new URL(this.config.computerSupervisorUrl!).hostname === '127.0.0.1';
    if (
      url.protocol !== 'http:' ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash ||
      (!network && !local)
    )
      throw new Error('Computer endpoint is not bound to this Dot.');
    return url.origin;
  }
  private async existing(id: string, signal?: AbortSignal) {
    const listing = this.parseUpstream(
      z.object({ computers: z.array(stateSchema) }),
      await this.supervisor('/computers', undefined, signal),
    );
    return listing.computers.find((c) => c.botId === id);
  }
  private async running(id: string, signal?: AbortSignal) {
    // Remote stacks return their origin as a plain string: a URL object would
    // stringify with a trailing slash and double the action's leading one.
    if (this.remoteFor(id)) return this.remoteOrigin(id);
    const state = await this.existing(id, signal);
    if (!state || state.status !== 'running')
      throw new Error('Start this Dot’s computer first.');
    return this.endpoint(id, state);
  }
  async status(id: string): Promise<ComputerStatus> {
    this.requireDot(id);
    const base = {
      configured: this.configured,
      permissions: this.workspace.computers.permissions(id),
      audit: this.workspace.computers.audit(id),
    };
    if (!this.configured) return { ...base, state: 'not_configured' };
    try {
      if (this.remoteFor(id)) {
        // Keep the egress policy installed even for UI polling: the first
        // request after a cold start is often a status check, and a silent
        // push there spares actions a surprise 502.
        this.ensureRemotePolicy(id).catch(() => {});
        return {
          ...base,
          state: 'running',
          assignment: this.workspace.computers.assignment(id),
          remotes: this.config.computerRemotes?.map((remote) => remote.name),
          control: controlSchema.parse(
            await this.json(
              `${this.remoteOrigin(id)}/control`,
              this.remoteToken(this.remoteFor(id), id),
              undefined,
              undefined,
              id,
            ),
          ),
        };
      }
      const state = await this.existing(id);
      if (!state || state.status !== 'running')
        return { ...base, state: 'stopped' };
      const url = this.endpoint(id, state);
      const control = controlSchema.parse(
        await this.json(
          `${url}/control`,
          this.token(id),
          undefined,
          undefined,
          id,
        ),
      );
      return { ...base, state: 'running', control };
    } catch {
      return {
        ...base,
        state: 'unavailable',
        error:
          'Computer service is unavailable. Check the supervisor configuration and connection.',
      };
    }
  }
  private async audited<T>(
    id: string,
    action: string,
    actor: 'owner' | 'agent',
    fn: () => Promise<T>,
  ): Promise<T> {
    this.requireDot(id);
    const receipt = this.workspace.computers.begin(id, action, actor);
    try {
      const result = await fn();
      this.workspace.computers.finish(receipt, 'succeeded');
      return result;
    } catch (error) {
      this.workspace.computers.finish(receipt, 'failed');
      throw error;
    }
  }
  async permissions(id: string, input: unknown) {
    const patch = computerPermissionsSchema.partial().parse(input);
    await this.audited(id, 'permissions', 'owner', async () =>
      this.workspace.computers.patch(id, patch),
    );
    return this.status(id);
  }
  async start(id: string) {
    await this.audited(id, 'start', 'owner', async () => {
      if (this.remoteFor(id)) {
        // A remote stack is always provisioned; a health check proves the box
        // is awake and the origin is the one the configuration named.
        this.allowed(id, undefined, 'owner');
        await this.json(`${this.remoteOrigin(id)}/health`, '', undefined);
        await this.ensureRemotePolicy(id);
        return;
      }
      this.allowed(id, undefined, 'owner');
      this.endpoint(id, await this.supervisor(`/computers/${id}/ensure`, {}));
    });
    return this.status(id);
  }
  async stop(id: string) {
    await this.audited(id, 'stop', 'owner', async () => {
      if (!this.configured)
        throw new Error('Computer service is not configured.');
      if (this.remoteFor(id)) {
        // Stops the browser session on the box; the Render service itself
        // keeps serving so files and profiles survive.
        await this.json(
          `${this.remoteOrigin(id)}/computers/stop`,
          this.remoteToken(this.remoteFor(id), id),
          {},
          undefined,
          id,
        );
        return;
      }
      await this.supervisor(`/computers/${id}/stop`, {});
    });
    return this.status(id);
  }
  /**
   * Pin a Dot to one remote box, or clear the pin (`remote: null`) to fall
   * back to the first configured box.
   */
  async assignment(id: string, input: unknown) {
    const patch = z
      .object({ remote: z.string().max(64).nullable() })
      .strict()
      .parse(input);
    await this.audited(id, 'assignment', 'owner', async () => {
      const name = patch.remote?.trim() || null;
      if (
        name &&
        !this.config.computerRemotes?.some((remote) => remote.name === name)
      )
        throw new Error('Unknown computer remote.');
      this.workspace.computers.assign(id, name);
    });
    return this.status(id);
  }
  async control(id: string, verb: 'take' | 'release') {
    await this.audited(id, verb, 'owner', async () => {
      if (!this.configured)
        throw new Error('Computer service is not configured.');
      if (verb === 'take') this.allowed(id, 'browser', 'owner');
      const url = await this.running(id);
      if (verb === 'take') this.allowed(id, 'browser', 'owner');
      let control: ComputerControl = this.parseUpstream(
        controlSchema,
        await this.json(
          `${url}/control`,
          this.remoteToken(this.remoteFor(id), id),
          undefined,
          undefined,
          id,
        ),
      );
      if (verb === 'take' && !control.request)
        control = this.parseUpstream(
          controlSchema,
          await this.json(
            `${url}/control/request`,
            this.remoteToken(this.remoteFor(id), id),
            { reason: 'Owner requested control.' },
            undefined,
            id,
          ),
        );
      if (
        verb === 'take' &&
        control.request &&
        !['waiting', 'taken'].includes(control.request.status)
      )
        control = this.parseUpstream(
          controlSchema,
          await this.json(
            `${url}/control/request`,
            this.remoteToken(this.remoteFor(id), id),
            { reason: 'Owner requested control.' },
            undefined,
            id,
          ),
        );
      if (!control.request)
        throw new Error('There is no active control request.');
      await this.json(
        `${url}/control/${verb}`,
        this.remoteToken(this.remoteFor(id), id),
        { requestId: control.request.id },
        undefined,
        id,
      );
    });
    return this.status(id);
  }
  async action(
    id: string,
    action: ComputerAction,
    input: unknown,
    actor: 'owner' | 'agent' = 'owner',
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!Object.hasOwn(computerInputs, action))
      throw new Error('Unknown computer action.');
    const parsed = computerInputs[action].parse(input);
    return this.audited(id, action, actor, async () => {
      if (actor === 'agent' && action.startsWith('human_'))
        throw new Error('Human controls are owner-only.');
      const kind =
        action === 'exec'
          ? 'shell'
          : action.startsWith('files_')
            ? 'files'
            : 'browser';
      this.allowed(id, kind, actor);
      const cancellation = new AbortController();
      const activeSignal = signal
        ? AbortSignal.any([signal, cancellation.signal])
        : cancellation.signal;
      const watcher = setInterval(() => {
        try {
          this.allowed(id, kind, actor);
        } catch {
          cancellation.abort();
        }
      }, 50);
      try {
        const url = await this.running(id, activeSignal);
        this.allowed(id, kind, actor);
        activeSignal.throwIfAborted();
        await this.ensureRemotePolicy(id, activeSignal);
        const path = action
          .replace(/^files_/, 'files/')
          .replace(/^human_/, 'human/');
        const result = await this.json(
          `${url}/${path}`,
          this.remoteToken(this.remoteFor(id), id),
          ['read', 'screenshot'].includes(action) ? undefined : parsed,
          activeSignal,
          id,
        );
        this.allowed(id, kind, actor);
        if (action === 'exec' && result && typeof result === 'object') {
          const copy = { ...result } as Record<string, unknown>;
          delete copy.command;
          return copy;
        }
        return result;
      } finally {
        clearInterval(watcher);
      }
    });
  }
}
