import Database from 'better-sqlite3';
import { runMigrations } from './migrations.js';

/**
 * 创建并初始化数据库连接
 */
export function createDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  runMigrations(db, dbPath);
  return db;
}
