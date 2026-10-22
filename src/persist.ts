// Keeps the engine's in-memory database in MySQL. Every record is one row in `records`,
// written through as it changes; the whole church is loaded once at start-up.
// One pool serves every church on the server; each church is loaded into memory at start-up.
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';

import mysql from 'mysql2/promise';

import type { Change, Db, Dump } from './core/db.js';
import { KINDS } from './core/types.js';

type Conn = { host: string; port: number; user: string; password: string; database: string };

const DDL = `CREATE TABLE IF NOT EXISTS records (
  church_id  VARCHAR(40)  NOT NULL,
  kind       VARCHAR(32)  NOT NULL,
  id         VARCHAR(80)  NOT NULL,
  data       LONGTEXT     NOT NULL,
  updated_at DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (church_id, kind, id),
  KEY idx_records_kind (church_id, kind)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`;

export async function openPool(conn: Conn) {
  const pool = mysql.createPool({ ...conn, connectionLimit: 8, charset: 'utf8mb4', timezone: 'Z' });
  await pool.query(DDL);
  return pool;
}

/** Every church id that has data in the database. */
export async function churchIds(pool: mysql.Pool) {
  const [rows] = await pool.query<mysql.RowDataPacket[]>('SELECT DISTINCT church_id FROM records');
  return rows.map((r) => String(r.church_id));
}

export async function mysqlPersistence(pool: mysql.Pool, churchId: string, db: Db) {
  const [rows] = await pool.query<mysql.RowDataPacket[]>('SELECT kind, data FROM records WHERE church_id = ?', [churchId]);
  const dump: Dump = {};
  for (const r of rows) {
    if (!(KINDS as readonly string[]).includes(r.kind)) continue;
    ((dump as Record<string, unknown[]>)[r.kind] ??= []).push(JSON.parse(r.data));
  }
  db.load(dump);

  // Writes are coalesced per record and flushed in order, so a burst of changes to the
  // same record becomes one query.
  const pending = new Map<string, Change>();
  let flushing: Promise<void> | null = null;
  async function flush() {
    while (pending.size) {
      const batch = [...pending.values()];
      pending.clear();
      const upserts = batch.filter((c) => c.value);
      const deletes = batch.filter((c) => !c.value);
      try {
        for (let i = 0; i < upserts.length; i += 200) {
          const chunk = upserts.slice(i, i + 200);
          await pool.query('INSERT INTO records (church_id, kind, id, data) VALUES ? ON DUPLICATE KEY UPDATE data = VALUES(data)', [chunk.map((c) => [churchId, c.kind, c.id, JSON.stringify(c.value)])]);
        }
        for (const c of deletes) await pool.query('DELETE FROM records WHERE church_id = ? AND kind = ? AND id = ?', [churchId, c.kind, c.id]);
      } catch (e) {
        console.error('Saving to MySQL failed; will retry', e);
        for (const c of batch) if (!pending.has(`${c.kind}:${c.id}`)) pending.set(`${c.kind}:${c.id}`, c);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }
  db.onChange((c) => {
    pending.set(`${c.kind}:${c.id}`, c);
    flushing ??= Promise.resolve().then(flush).finally(() => (flushing = null));
  });
  return {
    /** Resolves once every change so far is in MySQL. */
    async settle() {
      while (flushing) await flushing;
    },
  };
}

/** Local development without MySQL: the whole database in one JSON file. */
export function filePersistence(path: string, db: Db) {
  if (existsSync(path)) db.load(JSON.parse(readFileSync(path, 'utf8')));
  let timer: NodeJS.Timeout | null = null;
  const save = () => {
    writeFileSync(`${path}.tmp`, JSON.stringify(db.dump()));
    renameSync(`${path}.tmp`, path);
  };
  db.onChange(() => {
    timer ??= setTimeout(() => {
      timer = null;
      save();
    }, 300);
  });
  return { settle: async () => save() };
}
