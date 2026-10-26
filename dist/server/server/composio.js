import { createHash } from 'node:crypto';
import { Composio } from '@composio/core';
let client;
let clientKey;
function composioClient(apiKey) {
    if (!client || clientKey !== apiKey) {
        client = new Composio({ apiKey });
        clientKey = apiKey;
    }
    return client;
}
export async function composioSession(config, workspace, dot, ownerId, signal) {
    if (!config.composioApiKey)
        throw new Error('Composio is not configured.');
    const toolkits = [...new Set(dot.composioToolkits)].sort();
    const policy = { toolkits, instant: false };
    const policyHash = createHash('sha256')
        .update(JSON.stringify(policy))
        .digest('hex');
    const composio = composioClient(config.composioApiKey);
    if (dot.composioSessionId && dot.composioPolicyHash === policyHash)
        return composio.sessions.use(dot.composioSessionId, undefined, { signal });
    const session = await composio.sessions.create(ownerId, {
        ...(toolkits.length ? { toolkits } : {}),
        manageConnections: true,
        instant: false,
    }, { signal });
    workspace.saveComposioSession(dot.id, session.sessionId, policyHash);
    return session;
}
