import { defineTool } from '@copilotkit/runtime/v2';
import { safeFailure } from './slack-channel.js';
export async function composioTools(session, check, signal) {
    check();
    // @composio/core 0.22 supports request options at runtime but omits them
    // from the public Session function aliases.
    const cancellable = session;
    const tools = await cancellable.tools(undefined, { signal });
    return tools
        .filter((tool) => tool.type === 'function')
        .map(({ function: fn }) => defineTool({
        name: fn.name,
        description: fn.description ?? `Use the Composio ${fn.name} tool.`,
        parameters: fn.parameters,
        execute: async (input) => {
            check();
            try {
                const { data, error } = await cancellable.execute(fn.name, input, undefined, { signal });
                return { data, error };
            }
            catch (error) {
                return {
                    data: {},
                    error: `Composio tool failed: ${safeFailure(error)}.`,
                };
            }
        },
    }));
}
