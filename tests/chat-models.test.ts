import { expect, it } from 'vitest';
import { buildChatModelCatalog } from '../src/shared/chat-models.js';
import { WorkspaceStore } from '../src/server/workspace.js';

it('resolves the default model from the server config', () => {
  const catalog = buildChatModelCatalog(
    {
      model: 'minimaxai/minimax-m3.1-flash',
      baseUrl: 'https://integrate.api.nvidia.com/v1',
      apiKey: 'key',
    },
    {},
  );
  expect(catalog.options).toEqual([
    { id: 'default', label: 'minimaxai/minimax-m3.1-flash' },
  ]);
  expect(catalog.resolve(null)).toEqual({
    model: 'minimaxai/minimax-m3.1-flash',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    apiKey: 'key',
  });
  expect(catalog.resolve('unknown-model')).toEqual(catalog.resolve(null));
});

it('appends Gemini entries when a voice key exists and honors CHAT_MODELS', () => {
  const catalog = buildChatModelCatalog(
    { model: 'base-model', baseUrl: 'https://x/v1', apiKey: 'base-key' },
    {
      VOICE_API_KEY: 'google-key',
      OPENROUTER_API_KEY: 'or-key',
      CHAT_MODELS: JSON.stringify([
        {
          id: 'deepseek',
          label: 'DeepSeek V3.1 via NVIDIA',
          model: 'deepseek-ai/deepseek-v3.1',
          baseUrl: 'https://integrate.api.nvidia.com/v1',
        },
        {
          id: 'openrouter-free',
          label: 'OpenRouter free',
          model: 'provider/model:free',
          baseUrl: 'https://openrouter.ai/api/v1',
          apiKeyEnv: 'OPENROUTER_API_KEY',
        },
      ]),
    },
  );
  const ids = catalog.options.map((option) => option.id);
  expect(ids).toEqual([
    'default',
    'gemini-flash',
    'gemini-pro',
    'deepseek',
    'openrouter-free',
  ]);
  expect(catalog.resolve('deepseek')).toEqual({
    model: 'deepseek-ai/deepseek-v3.1',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    apiKey: 'base-key',
  });
  expect(catalog.resolve('gemini-flash')?.apiKey).toBe('google-key');
  expect(catalog.resolve('gemini-flash')?.model).toBe('gemini-2.5-flash');
  expect(catalog.resolve('openrouter-free')?.apiKey).toBe('or-key');
});

it('rejects malformed CHAT_MODELS catalogs', () => {
  expect(() => buildChatModelCatalog({}, { CHAT_MODELS: 'nope' })).toThrow(
    'CHAT_MODELS is not valid JSON.',
  );
  expect(() => buildChatModelCatalog({}, { CHAT_MODELS: '[]' })).toThrow(
    'CHAT_MODELS must be a non-empty JSON array.',
  );
  expect(() =>
    buildChatModelCatalog(
      {},
      {
        CHAT_MODELS: JSON.stringify([{ id: 'x', label: 'X', model: 'm' }]),
      },
    ),
  ).toThrow(/needs label, model and baseUrl/);
  expect(() =>
    buildChatModelCatalog(
      {},
      {
        CHAT_MODELS: JSON.stringify([
          {
            id: 'Bad Id',
            label: 'X',
            model: 'm',
            baseUrl: 'https://x/v1',
          },
        ]),
      },
    ),
  ).toThrow(/invalid id/);
});

it('stores a per-conversation model override and clears it with null', () => {
  const ws = new WorkspaceStore(':memory:', 'owner');
  const dot = ws.createDot(
    ws.createSpace('S', '').id,
    'Dot',
    'Help',
    false,
    true,
  );
  ws.bindThread('thread-1', dot.id, 'First');
  expect(ws.requireThread('thread-1').model).toBeNull();
  ws.setThreadModel('thread-1', 'gemini-pro');
  expect(ws.requireThread('thread-1').model).toBe('gemini-pro');
  ws.setThreadModel('thread-1', null);
  expect(ws.requireThread('thread-1').model).toBeNull();
  ws.setThreadModel('thread-1', '  ');
  expect(ws.requireThread('thread-1').model).toBeNull();
  expect(() => ws.setThreadModel('missing', 'gemini-pro')).toThrow();
  ws.close();
});
