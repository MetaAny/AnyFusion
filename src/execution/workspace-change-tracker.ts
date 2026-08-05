import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

export interface WorkspaceState {
  kind: 'git_status_v1';
  paths: Record<string, string | null>;
  truncated: boolean;
}

export interface WorkspaceDeltaEntry {
  path: string;
  beforeHash: string | null;
  afterHash: string | null;
}

export interface WorkspaceDelta {
  kind: 'git_status_delta_v1';
  changed: WorkspaceDeltaEntry[];
  baselineTruncated: boolean;
  finalTruncated: boolean;
}

const MAX_TRACKED_PATHS = 2_000;
const MAX_HASH_BYTES = 8 * 1024 * 1024;

/** Captures dirty-path hashes without storing file contents or modifying the worktree. */
export function captureWorkspaceState(workspaceRoot: string): WorkspaceState {
  const resolvedRoot = resolve(workspaceRoot);
  const result = spawnSync('git', [
    '-c', `safe.directory=${resolvedRoot}`,
    'status', '--porcelain=v1', '-z', '--untracked-files=all',
  ], {
    cwd: workspaceRoot,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`workspace state capture failed: ${String(result.stderr || result.error?.message || 'git status failed').trim()}`);
  }
  const paths: Record<string, string | null> = {};
  const entries = result.stdout.split('\0').filter(Boolean);
  for (const entry of entries.slice(0, MAX_TRACKED_PATHS)) {
    const relativePath = statusPath(entry);
    if (!relativePath) continue;
    paths[relativePath] = hashPath(resolve(workspaceRoot, relativePath));
  }
  return { kind: 'git_status_v1', paths, truncated: entries.length > MAX_TRACKED_PATHS };
}

export function deriveWorkspaceDelta(before: WorkspaceState, after: WorkspaceState): WorkspaceDelta {
  const changed: WorkspaceDeltaEntry[] = [];
  const paths = new Set([...Object.keys(before.paths), ...Object.keys(after.paths)]);
  for (const path of [...paths].sort()) {
    const beforeHash = before.paths[path] ?? null;
    const afterHash = after.paths[path] ?? null;
    if (beforeHash !== afterHash) changed.push({ path, beforeHash, afterHash });
  }
  return {
    kind: 'git_status_delta_v1',
    changed,
    baselineTruncated: before.truncated,
    finalTruncated: after.truncated,
  };
}

export function parseWorkspaceDelta(value: unknown): WorkspaceDelta | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.kind !== 'git_status_delta_v1'
    || typeof record.baselineTruncated !== 'boolean'
    || typeof record.finalTruncated !== 'boolean'
    || !Array.isArray(record.changed)) return null;
  const changed: WorkspaceDeltaEntry[] = [];
  for (const entry of record.changed) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    const item = entry as Record<string, unknown>;
    if (typeof item.path !== 'string'
      || (typeof item.beforeHash !== 'string' && item.beforeHash !== null)
      || (typeof item.afterHash !== 'string' && item.afterHash !== null)) return null;
    changed.push({
      path: item.path,
      beforeHash: item.beforeHash,
      afterHash: item.afterHash,
    });
  }
  return {
    kind: 'git_status_delta_v1',
    changed,
    baselineTruncated: record.baselineTruncated,
    finalTruncated: record.finalTruncated,
  };
}

function statusPath(entry: string): string | null {
  const raw = entry.slice(3);
  const renamed = raw.includes(' -> ') ? raw.slice(raw.lastIndexOf(' -> ') + 4) : raw;
  return renamed.trim() || null;
}

function hashPath(path: string): string | null {
  if (!existsSync(path)) return null;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return `non_file:${stat.mode}:${stat.size}`;
    if (stat.size > MAX_HASH_BYTES) return `large_file:${stat.size}:${stat.mtimeMs}`;
    return createHash('sha256').update(readFileSync(path)).digest('hex');
  } catch {
    return null;
  }
}
