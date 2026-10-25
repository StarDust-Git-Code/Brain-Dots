import { withDeadline } from './control.js';

export const TURN_TIMEOUT_MS = 85_000;
export const PING_TIMEOUT_MS = 10_000;
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;

function baseUrl(value, name) {
  if (!nonempty(value)) throw new Error(`${name} is required.`);
  let url;
  try { url = new URL(value); } catch { throw new Error(`${name} must be an absolute HTTP(S) URL.`); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.search || url.hash) throw new Error(`${name} must be an absolute HTTP(S) base URL.`);
  return url.href.replace(/\/+$/, '');
}

export async function runTurn(claim, {
  apiUrl, ownerToken, signal, fetchImpl = globalThis.fetch, timeoutMs = TURN_TIMEOUT_MS,
}) {
  for (const field of ['id', 'lease', 'dotId', 'threadId', 'prompt']) {
    if (!nonempty(claim?.[field])) throw new Error(`Task is missing a nonempty ${field}.`);
  }
  if (!nonempty(ownerToken)) throw new Error('OWNER_TOKEN is required for worker turns.');
  const url = `${baseUrl(apiUrl, 'VERCEL_API_URL')}/api/copilotkit/agent/${encodeURIComponent(claim.dotId)}/run`;
  return withDeadline(async (requestSignal) => {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({
        threadId: claim.threadId,
        messages: [{ role: 'user', content: claim.prompt }],
        taskId: claim.id,
        lease: claim.lease,
      }),
      signal: requestSignal,
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Vercel API returned HTTP ${response.status}.`);
    }
    let data;
    try { data = await response.json(); } catch {
      requestSignal.throwIfAborted();
      throw new Error('Vercel API returned invalid JSON.');
    }
    if (!nonempty(data?.text) || data.error || data.ok === false) {
      throw new Error('Vercel API did not return a nonempty successful text result.');
    }
    return { text: data.text, sources: [], sample: false };
  }, { signal, timeoutMs, message: 'Vercel agent turn timed out; completion is unconfirmed.' });
}

export async function pingSelf(selfUrl, {
  signal, fetchImpl = globalThis.fetch, timeoutMs = PING_TIMEOUT_MS,
} = {}) {
  const url = `${baseUrl(selfUrl, 'SELF_URL')}/api/ping`;
  return withDeadline(async (requestSignal) => {
    const response = await fetchImpl(url, { signal: requestSignal });
    await response.body?.cancel();
    if (!response.ok) throw new Error(`Self-ping returned HTTP ${response.status}.`);
  }, { signal, timeoutMs, message: 'Self-ping timed out.' });
}
