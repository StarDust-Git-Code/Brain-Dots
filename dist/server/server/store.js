import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
export const DEFAULT_WORKER_LEASE_MS = 180_000;
const defaults = {
    name: 'Dot',
    paused: false,
    researchAllowed: true,
    memoryAllowed: true,
    appsAllowed: false,
};
export class Store {
    db;
    constructor(path) {
        if (path !== ':memory:')
            mkdirSync(dirname(path), { recursive: true });
        this.db = new DatabaseSync(path);
        this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS setup_telemetry (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, prompt TEXT NOT NULL, status TEXT NOT NULL, intervalSeconds INTEGER, nextRunAt INTEGER, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, error TEXT, lease TEXT, leaseUntil INTEGER);
      CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, taskId TEXT NOT NULL, status TEXT NOT NULL, startedAt INTEGER NOT NULL, finishedAt INTEGER, result TEXT, error TEXT);
      CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, taskId TEXT NOT NULL, runId TEXT, text TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, text TEXT NOT NULL, createdAt INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS tasks_due ON tasks(status, nextRunAt);
      CREATE INDEX IF NOT EXISTS runs_task ON runs(taskId, startedAt);
      CREATE INDEX IF NOT EXISTS events_task ON events(taskId, id);`);
        this.db
            .prepare('INSERT OR IGNORE INTO settings VALUES (1, ?)')
            .run(JSON.stringify(defaults));
    }
    setupTelemetryState() {
        return this.db.prepare('SELECT value FROM setup_telemetry WHERE id=1').get()?.value;
    }
    saveSetupTelemetryState(value) {
        this.db
            .prepare('INSERT OR REPLACE INTO setup_telemetry VALUES (1, ?)')
            .run(value);
    }
    clearSetupTelemetry() {
        this.db.prepare('DELETE FROM setup_telemetry').run();
    }
    close() {
        this.db.close();
    }
    transaction(fn) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const value = fn();
            this.db.exec('COMMIT');
            return value;
        }
        catch (error) {
            this.db.exec('ROLLBACK');
            throw error;
        }
    }
    settings() {
        const row = this.db
            .prepare('SELECT value FROM settings WHERE id=1')
            .get();
        return { ...defaults, ...JSON.parse(row.value) };
    }
    updateSettings(patch) {
        return this.transaction(() => {
            const previous = this.settings();
            const settings = { ...previous, ...patch };
            this.db
                .prepare('UPDATE settings SET value=? WHERE id=1')
                .run(JSON.stringify(settings));
            if ((!previous.paused && settings.paused) ||
                (previous.researchAllowed && !settings.researchAllowed) ||
                (previous.memoryAllowed && !settings.memoryAllowed) ||
                (previous.appsAllowed && !settings.appsAllowed)) {
                const running = this.tasks().filter((t) => t.status === 'running');
                for (const task of running) {
                    this.invalidate(task, 'interrupted', 'Run interrupted because settings changed. Review completed effects before retrying.');
                }
            }
            return settings;
        });
    }
    tasks() {
        return this.db
            .prepare('SELECT * FROM tasks ORDER BY createdAt DESC')
            .all();
    }
    task(id) {
        return this.db
            .prepare('SELECT * FROM tasks WHERE id=?')
            .get(id);
    }
    createTask(prompt, intervalSeconds = null) {
        const now = Date.now();
        const id = randomUUID();
        this.db
            .prepare("INSERT INTO tasks VALUES (?, ?, 'queued', ?, NULL, ?, ?, NULL, NULL, NULL)")
            .run(id, prompt, intervalSeconds, now, now);
        this.event(id, null, 'Task added to the queue.');
        return this.task(id);
    }
    detail(id) {
        const task = this.task(id);
        if (!task)
            return undefined;
        const rows = this.db
            .prepare('SELECT * FROM runs WHERE taskId=? ORDER BY startedAt DESC, rowid DESC')
            .all(id);
        return {
            task,
            runs: rows.map((row) => ({
                ...row,
                result: row.result ? JSON.parse(row.result) : null,
            })),
            events: this.db
                .prepare('SELECT * FROM events WHERE taskId=? ORDER BY id')
                .all(id),
        };
    }
    event(taskId, runId, text) {
        this.db
            .prepare('INSERT INTO events (taskId, runId, text, createdAt) VALUES (?, ?, ?, ?)')
            .run(taskId, runId, text, Date.now());
    }
    invalidate(task, status, reason) {
        const now = Date.now();
        if (task.lease)
            this.db
                .prepare("UPDATE runs SET status='interrupted', finishedAt=?, error=? WHERE id=? AND status='running'")
                .run(now, reason, task.lease);
        this.db
            .prepare('UPDATE tasks SET status=?, lease=NULL, leaseUntil=NULL, updatedAt=?, error=? WHERE id=?')
            .run(status, now, status === 'interrupted' ? reason : null, task.id);
        this.event(task.id, task.lease, reason);
    }
    action(id, action) {
        return this.transaction(() => {
            const task = this.task(id);
            if (!task)
                return undefined;
            if (action === 'run' && task.status === 'running')
                return task;
            const status = action === 'run'
                ? 'queued'
                : action === 'pause'
                    ? 'paused'
                    : 'cancelled';
            this.invalidate(task, status, action === 'run' ? 'Task queued for a new run.' : `Task ${status}.`);
            this.db
                .prepare('UPDATE tasks SET error=NULL, nextRunAt=NULL WHERE id=?')
                .run(id);
            return this.task(id);
        });
    }
    schedule(id, intervalSeconds) {
        const task = this.task(id);
        if (!task)
            return undefined;
        const next = intervalSeconds && task.status === 'completed'
            ? Date.now() + intervalSeconds * 1000
            : null;
        this.db
            .prepare('UPDATE tasks SET intervalSeconds=?, nextRunAt=?, updatedAt=? WHERE id=?')
            .run(intervalSeconds, next, Date.now(), id);
        this.event(id, null, intervalSeconds
            ? `Repeats every ${intervalSeconds / 60} minutes after a successful run.`
            : 'Repeat schedule removed.');
        return this.task(id);
    }
    claim(now = Date.now(), leaseDurationMs = DEFAULT_WORKER_LEASE_MS) {
        return this.transaction(() => {
            const settings = this.settings();
            if (settings.paused || !settings.researchAllowed)
                return null;
            const expired = this.db
                .prepare("SELECT * FROM tasks WHERE status='running' AND leaseUntil<=?")
                .all(now);
            for (const task of expired)
                this.invalidate(task, 'interrupted', 'Worker lease expired. Review completed effects before retrying.');
            const task = this.db
                .prepare("SELECT * FROM tasks WHERE status='queued' OR (status='completed' AND nextRunAt IS NOT NULL AND nextRunAt<=?) ORDER BY createdAt LIMIT 1")
                .get(now);
            if (!task)
                return null;
            const lease = randomUUID();
            this.db
                .prepare("UPDATE tasks SET status='running', lease=?, leaseUntil=?, nextRunAt=NULL, error=NULL, updatedAt=? WHERE id=?")
                .run(lease, now + leaseDurationMs, now, task.id);
            this.db
                .prepare("INSERT INTO runs VALUES (?, ?, 'running', ?, NULL, NULL, NULL)")
                .run(lease, task.id, now);
            this.event(task.id, lease, 'Run started.');
            return { ...this.task(task.id), lease };
        });
    }
    owns(claim) {
        const task = this.task(claim.id);
        return task?.status === 'running' && task.lease === claim.lease;
    }
    finish(claim, result, now = Date.now()) {
        return this.transaction(() => {
            if (!this.owns(claim))
                return false;
            const task = this.task(claim.id);
            this.db
                .prepare("UPDATE runs SET status='completed', finishedAt=?, result=? WHERE id=?")
                .run(now, JSON.stringify(result), claim.lease);
            this.db
                .prepare("UPDATE tasks SET status='completed', lease=NULL, leaseUntil=NULL, updatedAt=?, nextRunAt=? WHERE id=?")
                .run(now, task.intervalSeconds ? now + task.intervalSeconds * 1000 : null, claim.id);
            this.event(claim.id, claim.lease, result.sample ? 'Fictional sample brief ready.' : 'Run completed.');
            return true;
        });
    }
    interrupt(claim, reason) {
        this.transaction(() => {
            if (this.owns(claim))
                this.invalidate(claim, 'interrupted', reason);
        });
    }
    fail(claim, error) {
        this.transaction(() => {
            if (!this.owns(claim))
                return;
            const now = Date.now();
            this.db
                .prepare("UPDATE runs SET status='failed', finishedAt=?, error=? WHERE id=?")
                .run(now, error, claim.lease);
            this.db
                .prepare("UPDATE tasks SET status='failed', lease=NULL, leaseUntil=NULL, error=?, updatedAt=? WHERE id=?")
                .run(error, now, claim.id);
            this.event(claim.id, claim.lease, error);
        });
    }
    memories() {
        return this.db
            .prepare('SELECT * FROM memories ORDER BY createdAt DESC')
            .all();
    }
    saveMemory(text, id = randomUUID()) {
        this.db
            .prepare('INSERT INTO memories VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET text=excluded.text')
            .run(id, text, Date.now());
        return this.db
            .prepare('SELECT * FROM memories WHERE id=?')
            .get(id);
    }
    deleteMemory(id) {
        return (this.db.prepare('DELETE FROM memories WHERE id=?').run(id).changes > 0);
    }
}
