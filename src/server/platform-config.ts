import type { WebConfig } from './parallel.js';
import type { SetupStatus } from '../shared/types.js';
import type { ChatModelCatalog } from '../shared/chat-models.js';

// `copilotkit project select` writes the CLI name and deletes the template name.
const INTELLIGENCE_API_KEY_ENV_NAMES = [
  'CPK_INTELLIGENCE_API_KEY',
  'INTELLIGENCE_API_KEY',
] as const;
export const INTELLIGENCE_KEY_MISSING_LABEL = `${INTELLIGENCE_API_KEY_ENV_NAMES[1]} (or ${INTELLIGENCE_API_KEY_ENV_NAMES[0]})`;
export const DEFAULT_AGENT_RUN_TIMEOUT_MS = 90_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export function intelligenceApiKeyFromEnv(
  env: Record<string, string | undefined>,
): string | undefined {
  return firstNonEmptyEnvValue(env, INTELLIGENCE_API_KEY_ENV_NAMES);
}

export function intelligenceWsUrlFromEnv(
  env: Record<string, string | undefined>,
): string | undefined {
  return firstNonEmptyEnvValue(env, [
    'INTELLIGENCE_GATEWAY_WS_URL',
    'INTELLIGENCE_WS_URL',
  ]);
}

export function agentRunTimeoutMsFromEnv(
  env: Record<string, string | undefined>,
): number {
  const raw = env.AGENT_RUN_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_AGENT_RUN_TIMEOUT_MS;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMER_DELAY_MS)
    throw new Error(
      `AGENT_RUN_TIMEOUT_MS must be an integer between 1 and ${MAX_TIMER_DELAY_MS}.`,
    );
  return value;
}

function firstNonEmptyEnvValue(
  env: Record<string, string | undefined>,
  names: readonly string[],
): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return undefined;
}

export interface ComputerRemote {
  name: string;
  url: string;
  /**
   * The box's access token. Boxes validate a single secret, so Dots sharing
   * one box must present that box's token; when omitted the per-Dot derived
   * HMAC token is sent, which matches boxes provisioned for one Dot.
   */
  token?: string;
}

/**
 * Remote computer stacks reached directly over HTTPS (`COMPUTER_REMOTES`),
 *  bypassing the supervisor entirely. Each Render box runs the pinned OpenBot
 * computer service on its own public URL; every action that needs execution
 * routes to it while local supervisor behavior stays untouched.
 */
export function computerRemotesFromEnv(
  env: Record<string, string | undefined>,
): ComputerRemote[] {
  const raw = env.COMPUTER_REMOTES?.trim();
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error('COMPUTER_REMOTES is not valid JSON.', { cause: error });
  }
  return parseRemotes(parsed);
}

function parseRemotes(parsed: unknown): ComputerRemote[] {
  if (!Array.isArray(parsed) || parsed.length === 0)
    throw new Error('COMPUTER_REMOTES must be a non-empty JSON array.');
  return parsed.map((entry) => {
    const record = entry as Record<string, unknown>;
    const name = typeof record?.name === 'string' ? record.name : '';
    const url = typeof record?.url === 'string' ? record.url : '';
    const token = typeof record?.token === 'string' ? record.token : '';
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name))
      throw new Error('Each COMPUTER_REMOTES entry needs a plain name.');
    let origin: URL;
    try {
      origin = new URL(url);
    } catch {
      throw new Error(`Computer remote ${name} has no valid url.`);
    }
    if (
      origin.protocol !== 'https:' ||
      origin.username ||
      origin.password ||
      origin.pathname !== '/' ||
      origin.search ||
      origin.hash
    )
      throw new Error(
        `Computer remote ${name} url must be a bare HTTPS origin.`,
      );
    if (token.trim().length > 512)
      throw new Error(`Computer remote ${name} token is too long.`);
    return { name, url: origin.origin, ...(token.trim() ? { token } : {}) };
  });
}

export interface PlatformConfig extends WebConfig {
  intelligenceKey?: string;
  intelligenceApiUrl?: string;
  intelligenceWsUrl?: string;
  model?: string;
  apiKey?: string;
  baseUrl: string;
  /** Selectable chat models; conversations may override the default. */
  chatModels?: ChatModelCatalog;
  agentRunTimeoutMs?: number;
  computerSupervisorUrl?: string;
  computerSupervisorToken?: string;
  computerToken?: string;
  computerNamespace?: string;
  computerRemotes?: ComputerRemote[];
  browserUrl?: string;
  browserSecret?: string;
  composioApiKey?: string;
  voiceKey?: string;
  voiceModel?: string;
  voiceName: string;
  voiceProvider?: VoiceProvider;
  slackChannel?: string;
  slackTeam?: string;
  slackUsers: string[];
  slackDotId?: string;
  runtimeUrl: string;
  ownerToken?: string;
}
export type VoiceProvider = 'openai' | 'gemini';

export function voiceProviderFromEnv(
  env: Record<string, string | undefined>,
): VoiceProvider {
  return env.VOICE_PROVIDER === 'gemini' ? 'gemini' : 'openai';
}

export function setupStatus(
  config: PlatformConfig,
  slack = 'not_configured',
  activationFailed = false,
): SetupStatus {
  const missing = [
    !config.intelligenceKey && INTELLIGENCE_KEY_MISSING_LABEL,
    !config.apiKey && 'OPENAI_API_KEY',
    !config.model && 'OPENAI_MODEL',
  ].filter((item): item is string => !!item);
  const declaredSlack = !!(
    config.slackChannel &&
    config.slackTeam &&
    config.slackUsers.length
  );
  slack = declaredSlack
    ? activationFailed && slack !== 'online'
      ? 'activation_failed'
      : slack
    : config.slackChannel || config.slackTeam || config.slackUsers.length
      ? 'setup_required'
      : 'not_configured';
  return {
    intelligence: !!config.intelligenceKey,
    model: !!(config.apiKey && config.model),
    browser: !!(config.browserUrl && config.browserSecret),
    voice: !!(config.voiceKey && config.voiceModel && !missing.length),
    composio: !!config.composioApiKey,
    slack,
    missing,
  };
}
