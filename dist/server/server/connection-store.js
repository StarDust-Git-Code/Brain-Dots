import { randomUUID } from 'node:crypto';
export class ConnectionStore {
    db;
    constructor(db) {
        this.db = db;
        db.exec(`CREATE TABLE IF NOT EXISTS mcp_connections(id TEXT PRIMARY KEY, dotId TEXT NOT NULL, name TEXT NOT NULL, url TEXT NOT NULL, token TEXT, tools TEXT NOT NULL, error TEXT, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS mcp_approvals(id TEXT PRIMARY KEY, threadId TEXT NOT NULL, dotId TEXT NOT NULL, connectionId TEXT NOT NULL, tool TEXT NOT NULL, arguments TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS mcp_actions(threadId TEXT NOT NULL, toolCallId TEXT NOT NULL, connectionId TEXT NOT NULL, tool TEXT NOT NULL, status TEXT NOT NULL, result TEXT, createdAt INTEGER NOT NULL, PRIMARY KEY(threadId, toolCallId));`);
        // A receipt belongs to the approval that produced it.
        if (!db
            .prepare('PRAGMA table_info(mcp_actions)')
            .all()
            .some((column) => column.name === 'approvalId'))
            db.exec('ALTER TABLE mcp_actions ADD COLUMN approvalId TEXT');
    }
    rows(dotId) {
        return this.db
            .prepare(`SELECT * FROM mcp_connections ${dotId ? 'WHERE dotId=?' : ''} ORDER BY createdAt, rowid`)
            .all(...(dotId ? [dotId] : []));
    }
    view({ token, tools, ...row }) {
        return { ...row, hasToken: !!token, tools: JSON.parse(tools) };
    }
    list(dotId) {
        return this.rows(dotId).map((row) => this.view(row));
    }
    get(id) {
        const row = this.rows().find((row) => row.id === id);
        return row && this.view(row);
    }
    // Secrets never leave the server: only the MCP transport reads them.
    credentials(id) {
        const row = this.rows().find((row) => row.id === id);
        if (!row)
            throw new Error('Connection not found.');
        return { url: row.url, token: row.token ?? undefined };
    }
    create(dotId, value, tools) {
        const id = randomUUID();
        const now = Date.now();
        this.db
            .prepare('INSERT INTO mcp_connections VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)')
            .run(id, dotId, value.name, value.url, value.token || null, JSON.stringify(tools), now, now);
        return this.get(id);
    }
    saveTools(id, tools, error = null) {
        this.db
            .prepare('UPDATE mcp_connections SET tools=?, error=?, updatedAt=? WHERE id=?')
            .run(JSON.stringify(tools), error, this.tick(id), id);
        return this.get(id);
    }
    setError(id, error) {
        this.db
            .prepare('UPDATE mcp_connections SET error=?, updatedAt=? WHERE id=?')
            .run(error, this.tick(id), id);
        return this.get(id);
    }
    remove(id) {
        return (this.db.prepare('DELETE FROM mcp_connections WHERE id=?').run(id)
            .changes > 0);
    }
    // Running turns compare this to stop as soon as the owner changes access.
    fingerprint(dotId) {
        return this.rows(dotId)
            .map((row) => `${row.id}:${row.updatedAt}`)
            .join(',');
    }
    // Keep updatedAt strictly increasing so rapid edits always change the fingerprint.
    tick(id) {
        return Math.max(Date.now(), (this.get(id)?.updatedAt ?? 0) + 1);
    }
    // Binds a gated call to its exact connection, tool, and arguments, so a
    // later approval runs that call and nothing else.
    createApproval(value) {
        const id = randomUUID();
        this.db
            .prepare('INSERT INTO mcp_approvals VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(id, value.threadId, value.dotId, value.connectionId, value.tool, JSON.stringify(value.arguments), Date.now());
        return id;
    }
    approval(id) {
        const row = this.db
            .prepare('SELECT * FROM mcp_approvals WHERE id=?')
            .get(id);
        if (!row)
            return undefined;
        return {
            id: String(row.id),
            threadId: String(row.threadId),
            dotId: String(row.dotId),
            connectionId: String(row.connectionId),
            tool: String(row.tool),
            arguments: JSON.parse(String(row.arguments)),
            createdAt: Number(row.createdAt),
        };
    }
    action(threadId, toolCallId) {
        const row = this.db
            .prepare('SELECT status, result, approvalId FROM mcp_actions WHERE threadId=? AND toolCallId=?')
            .get(threadId, toolCallId);
        if (!row)
            return undefined;
        return {
            approvalId: typeof row.approvalId === 'string' ? row.approvalId : null,
            status: String(row.status),
            result: typeof row.result === 'string'
                ? JSON.parse(row.result)
                : null,
        };
    }
    // Looks up what an approval was already claimed for, so one approval can
    // never run its stored request twice under different tool call ids.
    actionForApproval(approvalId) {
        const row = this.db
            .prepare('SELECT threadId, toolCallId FROM mcp_actions WHERE approvalId=?')
            .get(approvalId);
        return row
            ? { threadId: String(row.threadId), toolCallId: String(row.toolCallId) }
            : undefined;
    }
    // Claim an approved action once. Returns false if it was already claimed,
    // so a double click or a retried request never executes twice.
    claimAction(threadId, toolCallId, approvalId, connectionId, tool) {
        return (this.db
            .prepare("INSERT OR IGNORE INTO mcp_actions (threadId, toolCallId, connectionId, tool, status, result, createdAt, approvalId) VALUES (?, ?, ?, ?, 'running', NULL, ?, ?)")
            .run(threadId, toolCallId, connectionId, tool, Date.now(), approvalId)
            .changes > 0);
    }
    finishAction(threadId, toolCallId, result) {
        this.db
            .prepare("UPDATE mcp_actions SET status='done', result=? WHERE threadId=? AND toolCallId=?")
            .run(JSON.stringify(result), threadId, toolCallId);
    }
}
