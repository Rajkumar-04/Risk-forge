import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import initSqlJs from 'sql.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = path.join(__dirname, 'data');
export const DB_PATH = path.join(DATA_DIR, 'release-control.sqlite');

let dbInstance = null;

function locateWasm(file) {
  return path.join(__dirname, '..', 'node_modules', 'sql.js', 'dist', file);
}

/**
 * Initializes the SQLite database (loading from disk if present) and creates tables.
 */
export async function initDatabase() {
  if (dbInstance) return dbInstance;

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const SQL = await initSqlJs({ locateFile: locateWasm });

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    dbInstance = new SQL.Database(fileBuffer);
  } else {
    dbInstance = new SQL.Database();
  }

  dbInstance.run(`
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      app TEXT NOT NULL,
      app_type TEXT DEFAULT '',
      version TEXT NOT NULL,
      type TEXT NOT NULL,
      build TEXT DEFAULT '',
      created_at TEXT DEFAULT '',
      source TEXT DEFAULT '',
      payload_json TEXT NOT NULL,
      uploaded_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      app TEXT NOT NULL,
      version TEXT NOT NULL,
      priority_code TEXT NOT NULL,
      team TEXT NOT NULL,
      owner TEXT NOT NULL DEFAULT 'Unassigned',
      source TEXT NOT NULL DEFAULT 'Custom',
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'todo',
      suggestion_key TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sign_offs (
      app_version_key TEXT PRIMARY KEY,
      app TEXT NOT NULL,
      version TEXT NOT NULL,
      decision TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      timestamp TEXT NOT NULL,
      action TEXT NOT NULL,
      detail TEXT NOT NULL
    );
  `);

  persistDatabase();
  return dbInstance;
}

/**
 * Writes the current in-memory SQLite database state to disk.
 */
export function persistDatabase() {
  if (!dbInstance) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const data = dbInstance.export();
  const tempPath = `${DB_PATH}.tmp`;
  fs.writeFileSync(tempPath, Buffer.from(data));
  fs.renameSync(tempPath, DB_PATH);
}

export function queryAll(sql, params = []) {
  if (!dbInstance) throw new Error('Database not initialized');
  const stmt = dbInstance.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

export function queryOne(sql, params = []) {
  const rows = queryAll(sql, params);
  return rows[0] || null;
}

export function runSql(sql, params = [], persist = true) {
  if (!dbInstance) throw new Error('Database not initialized');
  const stmt = dbInstance.prepare(sql);
  stmt.run(params);
  stmt.free();
  if (persist) persistDatabase();
}

export function runTransaction(work) {
  if (!dbInstance) throw new Error('Database not initialized');
  dbInstance.run('BEGIN TRANSACTION;');
  try {
    const result = work();
    dbInstance.run('COMMIT;');
    persistDatabase();
    return result;
  } catch (err) {
    dbInstance.run('ROLLBACK;');
    throw err;
  }
}

export function getDbStats() {
  const counts = {
    reports: queryOne('SELECT COUNT(*) AS count FROM reports')?.count || 0,
    tasks: queryOne('SELECT COUNT(*) AS count FROM tasks')?.count || 0,
    signOffs: queryOne('SELECT COUNT(*) AS count FROM sign_offs')?.count || 0,
    auditLogs: queryOne('SELECT COUNT(*) AS count FROM audit_logs')?.count || 0,
  };
  const fileSizeBytes = fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH).size : 0;
  return {
    engine: 'SQLite (sql.js)',
    dbPath: DB_PATH,
    fileSizeBytes,
    counts,
  };
}
