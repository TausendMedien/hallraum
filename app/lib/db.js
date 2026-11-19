import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  db.exec(`UPDATE podcasts SET autocut_default = CASE autocut_default WHEN 'aus' THEN 'off' WHEN 'sanft' THEN 'soft' WHEN 'mittel' THEN 'medium' WHEN 'stark' THEN 'strong' ELSE autocut_default END`);
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
