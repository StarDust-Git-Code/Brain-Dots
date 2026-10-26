import { randomUUID } from 'node:crypto';
export class ComputerStore {
    db;
    constructor(db) {
        this.db = db;
        db.exec(`CREATE TABLE IF NOT EXISTS computer_permissions(dotId TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS computer_assignment(dotId TEXT PRIMARY KEY,remote TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS computer_audit(id TEXT PRIMARY KEY,dotId TEXT NOT NULL,action TEXT NOT NULL,actor TEXT NOT NULL,outcome TEXT NOT NULL,createdAt INTEGER NOT NULL);`);
    }
    /**
     * Which remote stack this Dot's computer actions route to. Null means the
     * default (the first configured remote).
     */
    assignment(id) {
        const row = this.db
            .prepare('SELECT remote FROM computer_assignment WHERE dotId=?')
            .get(id);
        return row ? String(row.remote) : null;
    }
    assign(id, remote) {
        if (remote === null) {
            this.db.prepare('DELETE FROM computer_assignment WHERE dotId=?').run(id);
            return;
        }
        this.db
            .prepare('INSERT OR REPLACE INTO computer_assignment VALUES (?,?)')
            .run(id, remote);
    }
    permissions(id) {
        const row = this.db
            .prepare('SELECT value FROM computer_permissions WHERE dotId=?')
            .get(id);
        return row
            ? JSON.parse(String(row.value))
            : { enabled: false, browser: false, files: false, shell: false };
    }
    patch(id, patch) {
        const value = { ...this.permissions(id), ...patch };
        this.db
            .prepare('INSERT OR REPLACE INTO computer_permissions VALUES (?,?)')
            .run(id, JSON.stringify(value));
        return value;
    }
    begin(dotId, action, actor) {
        const id = randomUUID();
        this.db
            .prepare('INSERT INTO computer_audit VALUES (?,?,?,?,?,?)')
            .run(id, dotId, action, actor, 'pending', Date.now());
        return id;
    }
    finish(id, outcome) {
        this.db
            .prepare('UPDATE computer_audit SET outcome=? WHERE id=?')
            .run(outcome, id);
        this.db
            .prepare(`DELETE FROM computer_audit WHERE dotId=(SELECT dotId FROM computer_audit WHERE id=?) AND outcome!='pending' AND id NOT IN (SELECT id FROM computer_audit WHERE dotId=(SELECT dotId FROM computer_audit WHERE id=?) AND outcome!='pending' ORDER BY createdAt DESC,rowid DESC LIMIT 1000)`)
            .run(id, id);
    }
    audit(id) {
        return this.db
            .prepare('SELECT id,action,actor,outcome,createdAt FROM computer_audit WHERE dotId=? ORDER BY createdAt DESC LIMIT 50')
            .all(id);
    }
}
