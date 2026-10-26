import { randomUUID } from 'node:crypto';
import { PageError } from './pages.js';
async function bounded(operation) {
    let timer;
    try {
        return await Promise.race([
            operation,
            new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('Intelligence request timed out. Retry to recover the same conversation.')), 30000);
            }),
        ]);
    }
    finally {
        clearTimeout(timer);
    }
}
export class PageService {
    workspace;
    intelligence;
    pending = new Map();
    constructor(workspace, intelligence) {
        this.workspace = workspace;
        this.intelligence = intelligence;
    }
    async conversation(spaceId, pageId, dotId) {
        const page = this.workspace.pages.get(spaceId, pageId);
        const dot = this.workspace.dot(dotId);
        if (!dot || !this.workspace.canAccessSpace(dotId, spaceId))
            throw new PageError('Choose a specialist in this Space with access enabled.', 400);
        const key = `${pageId}:${dotId}`;
        const pending = this.pending.get(key);
        if (pending)
            return pending;
        const current = this.workspace.pages.thread(pageId, dotId);
        if (current?.ready)
            return this.workspace.requireThread(current.threadId, dotId);
        const sdk = this.intelligence();
        const task = (async () => {
            const candidateId = randomUUID();
            if (!this.workspace.pages.reserveThread(pageId, dotId, candidateId))
                throw new PageError('This page conversation is being created. Retry shortly.', 409);
            const threadId = this.workspace.pages.thread(pageId, dotId).threadId;
            try {
                await bounded(sdk.getOrCreateThread({
                    threadId,
                    userId: this.workspace.ownerId,
                    agentId: dotId,
                    name: page.title,
                }));
                if (!this.workspace.canAccessSpace(dotId, spaceId))
                    throw new PageError('Space access has been revoked.');
                const thread = this.workspace.conversations().find((t) => t.id === threadId) ??
                    this.workspace.bindThread(threadId, dotId, page.title);
                this.workspace.pages.finishThread(pageId, dotId);
                return thread;
            }
            catch (error) {
                this.workspace.pages.releaseThread(pageId, dotId);
                throw error;
            }
        })();
        this.pending.set(key, task);
        try {
            return await task;
        }
        finally {
            this.pending.delete(key);
        }
    }
    async saveConversation(threadId, title, parentId) {
        const thread = this.workspace.requireThread(threadId);
        const dot = this.workspace.dot(thread.dotId);
        const history = await bounded(this.intelligence().getThreadMessages({
            threadId,
            userId: this.workspace.ownerId,
        }));
        const chunks = [];
        for (const message of history.messages) {
            if (!['user', 'assistant'].includes(message.role))
                continue;
            let text = '';
            if (typeof message.content === 'string')
                text = message.content;
            else if (Array.isArray(message.content)) {
                text = message.content
                    .flatMap((part) => part &&
                    typeof part === 'object' &&
                    'text' in part &&
                    typeof part.text === 'string'
                    ? [part.text]
                    : [])
                    .join('\n');
            }
            if (text.trim())
                chunks.push(`## ${message.role === 'user' ? 'You' : 'Dot'}\n\n${text}`);
        }
        const content = chunks.join('\n\n');
        if (!content)
            throw new PageError('This conversation has no persisted text to save.');
        if (content.length > 100000)
            throw new PageError('This conversation exceeds the 100,000 character page limit. Save a shorter conversation.');
        const destination = this.workspace.pages.forThread(threadId)?.spaceId ?? dot.spaceId;
        if (!this.workspace.canAccessSpace(dot.id, destination))
            throw new PageError('Space access has been revoked.', 400);
        return this.workspace.pages.create(destination, { title, content, parentId }, threadId);
    }
}
