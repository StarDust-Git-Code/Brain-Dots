/**
 * Chat model catalog and selection. A conversation can run on any catalog
 * entry; servers build the catalog from env so owners can add any
 * OpenAI-compatible provider without code changes (`CHAT_MODELS`).
 */
export const DEFAULT_CHAT_MODEL_ID = 'default';
export const GEMINI_CHAT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';
const MODEL_ID = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
export function buildChatModelCatalog(base, env) {
    const defaultSelection = {
        model: base.model ?? '',
        baseUrl: base.baseUrl ?? 'https://api.openai.com/v1',
        apiKey: base.apiKey,
    };
    const options = [
        { id: DEFAULT_CHAT_MODEL_ID, label: base.model ?? 'Default model' },
    ];
    const selections = new Map();
    if (base.model)
        selections.set(DEFAULT_CHAT_MODEL_ID, defaultSelection);
    if (env.VOICE_API_KEY?.trim()) {
        // The voice key doubles as a Google AI Studio key: Gemini chat models can
        // reuse it through the OpenAI-compatible endpoint. Never appended when the
        // owner disabled Gemini voice by leaving the key unset.
        selections.set('gemini-flash', {
            model: 'gemini-2.5-flash',
            baseUrl: GEMINI_CHAT_BASE_URL,
            apiKey: env.VOICE_API_KEY.trim(),
        });
        options.push({ id: 'gemini-flash', label: 'Gemini 2.5 Flash' });
        selections.set('gemini-pro', {
            model: 'gemini-2.5-pro',
            baseUrl: GEMINI_CHAT_BASE_URL,
            apiKey: env.VOICE_API_KEY.trim(),
        });
        options.push({ id: 'gemini-pro', label: 'Gemini 2.5 Pro' });
    }
    const raw = env.CHAT_MODELS?.trim();
    if (raw) {
        let parsed;
        try {
            parsed = JSON.parse(raw);
        }
        catch (error) {
            throw new Error('CHAT_MODELS is not valid JSON.', { cause: error });
        }
        if (!Array.isArray(parsed) || parsed.length === 0)
            throw new Error('CHAT_MODELS must be a non-empty JSON array.');
        for (const entry of parsed) {
            const id = typeof entry?.id === 'string' ? entry.id.trim() : '';
            const label = typeof entry?.label === 'string' ? entry.label.trim() : '';
            const model = typeof entry?.model === 'string' ? entry.model.trim() : '';
            const baseUrl = typeof entry?.baseUrl === 'string' ? entry.baseUrl.trim() : '';
            if (!MODEL_ID.test(id))
                throw new Error(`CHAT_MODELS entry has an invalid id: ${JSON.stringify(id)}.`);
            if (!label || !model || !baseUrl)
                throw new Error(`CHAT_MODELS entry ${id} needs label, model and baseUrl.`);
            const apiKeyEnv = typeof entry?.apiKeyEnv === 'string' ? entry.apiKeyEnv.trim() : '';
            if (apiKeyEnv && !env[apiKeyEnv])
                throw new Error(`CHAT_MODELS entry ${id} needs env ${apiKeyEnv}.`);
            selections.set(id, {
                model,
                baseUrl,
                apiKey: (apiKeyEnv ? env[apiKeyEnv] : base.apiKey)?.trim(),
            });
            options.push({ id, label });
        }
    }
    return {
        defaultId: DEFAULT_CHAT_MODEL_ID,
        options,
        resolve(id) {
            const key = id?.trim() || DEFAULT_CHAT_MODEL_ID;
            return selections.get(key) ?? defaultSelection;
        },
    };
}
