import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

const dbs = new Map<string, DatabaseSync>();

export function openSqliteDb(path: string): DatabaseSync {
  const existing = dbs.get(path);
  if (existing) return existing;
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");
  dbs.set(path, db);
  return db;
}

export function closeSqliteDb(path: string): void {
  const db = dbs.get(path);
  if (!db) return;
  db.close();
  dbs.delete(path);
}

export function sqliteDbExists(path: string): boolean {
  return existsSync(path);
}
