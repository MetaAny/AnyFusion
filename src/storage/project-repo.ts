import type Database from 'better-sqlite3';
import type { Project } from '../project/types.js';

interface ProjectRow {
  id: string;
  root_path: string;
  main_branch: 'main';
  created_at: string;
  updated_at: string;
}

function fromRow(row: ProjectRow): Project {
  return {
    id: row.id,
    rootPath: row.root_path,
    mainBranch: row.main_branch,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ProjectRepo {
  constructor(private readonly db: Database.Database) {}

  upsert(project: Project): Project {
    this.db.prepare(`
      INSERT INTO projects (id, root_path, main_branch, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(root_path) DO UPDATE SET
        updated_at = excluded.updated_at
    `).run(
      project.id,
      project.rootPath,
      project.mainBranch,
      project.createdAt,
      project.updatedAt,
    );
    return this.findByRootPath(project.rootPath) ?? project;
  }

  find(id: string): Project | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?')
      .get(id) as ProjectRow | undefined;
    return row ? fromRow(row) : null;
  }

  findByRootPath(rootPath: string): Project | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE root_path = ?')
      .get(rootPath) as ProjectRow | undefined;
    return row ? fromRow(row) : null;
  }
}

