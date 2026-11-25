import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { settingsFromLevel } from './autocut.js';

const here = path.dirname(fileURLToPath(import.meta.url));

export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(here, '..', '..', 'data'));

export function openDb(file = process.env.DB_FILE || path.join(DATA_DIR, 'app.sqlite')) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(fs.readFileSync(path.join(here, '..', 'db', 'schema.sql'), 'utf8'));
  migrate(db);
  return wrap(db);
}

// Small additive migrations for databases created by older versions
function migrate(db) {
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  if (!cols('users').includes('locale')) db.exec('ALTER TABLE users ADD COLUMN locale TEXT');
  for (const [table, col, type] of [['transcripts', 'gaps', 'TEXT'], ['transcripts', 'loudness', 'TEXT'],
    ['audio_files', 'source_id', 'INTEGER REFERENCES audio_files(id) ON DELETE CASCADE'], ['audio_files', 'cut_info', 'TEXT']]) {
    if (!cols(table).includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  }
  if (!cols('autocut').includes('own_cuts')) db.exec("ALTER TABLE autocut ADD COLUMN own_cuts TEXT NOT NULL DEFAULT '[]'");
  // Auto-cut: the single level (off / soft / medium / strong) became three separate settings stored as JSON
  for (const [table, oldCol] of [['podcasts', 'autocut_default'], ['episodes', 'autocut_level']]) {
    if (!cols(table).includes('autocut_settings')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN autocut_settings TEXT${table === 'podcasts' ? " NOT NULL DEFAULT '{}'" : ''}`);
    }
    if (cols(table).includes(oldCol)) {
      for (const row of db.prepare(`SELECT id, ${oldCol} AS level FROM ${table} WHERE ${oldCol} IS NOT NULL`).all()) {
        const s = settingsFromLevel(row.level);
        if (s) db.prepare(`UPDATE ${table} SET autocut_settings = ? WHERE id = ?`).run(JSON.stringify(s), row.id);
      }
      db.exec(`ALTER TABLE ${table} DROP COLUMN ${oldCol}`);
    }
  }
}

// Thin helper layer: db.get / db.all / db.run / db.tx
function wrap(raw) {
  const cache = new Map();
  const prep = (sql) => {
    let s = cache.get(sql);
    if (!s) { s = raw.prepare(sql); cache.set(sql, s); }
    return s;
  };
  const norm = (params) => params.map((p) => (p === undefined ? null : typeof p === 'boolean' ? Number(p) : p));
  return {
    raw,
    get: (sql, ...p) => prep(sql).get(...norm(p)),
    all: (sql, ...p) => prep(sql).all(...norm(p)),
    run: (sql, ...p) => prep(sql).run(...norm(p)),
    exec: (sql) => raw.exec(sql),
    tx(fn) {
      raw.exec('BEGIN IMMEDIATE');
      try { const r = fn(); raw.exec('COMMIT'); return r; }
      catch (e) { raw.exec('ROLLBACK'); throw e; }
    },
    close: () => raw.close(),
  };
}
