import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { resolveMetaclawDir } from '../utils/paths.js';
import type { MemoryEngine } from './memory-engine.js';

export interface MemoryVaultExportResult {
  vaultDir: string;
  preferenceCount: number;
}

function ensureDir(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true });
  }
}

function defaultVaultDir(): string {
  return join(resolveMetaclawDir(), 'vault');
}

function yamlString(value: string | null): string {
  return value === null ? 'null' : JSON.stringify(value);
}

export class MemoryVaultExporter {
  constructor(private memoryEngine: MemoryEngine) {}

  export(input: { vaultDir?: string } = {}): MemoryVaultExportResult {
    const vaultDir = input.vaultDir ?? defaultVaultDir();
    const dirs = [
      '',
      'preferences',
      'profiles',
      'profiles/projects',
      'profiles/contacts',
      'profiles/executors',
      'tasks',
      'decisions',
      'skills',
    ];
    for (const dir of dirs) {
      ensureDir(join(vaultDir, dir));
    }

    const preferences = this.memoryEngine.list({ status: 'confirmed' });

    writeFileSync(join(vaultDir, 'README.md'), [
      '# MetaClaw Memory Vault',
      '',
      'This vault is a one-way export from SQLite. SQLite remains the runtime source of truth.',
      '',
      `- preferences=${preferences.length}`,
    ].join('\n'));

    for (const preference of preferences) {
      writeFileSync(join(vaultDir, 'preferences', `${preference.id}.md`), [
        '---',
        `id: ${preference.id}`,
        `kind: preference`,
        `scope: ${preference.scope}`,
        `subject: ${yamlString(preference.subject)}`,
        `confidence: ${preference.confidence}`,
        `risk: low`,
        '---',
        '',
        `# ${preference.content.slice(0, 40)}`,
        '',
        preference.content,
      ].join('\n'));
    }

    writeFileSync(join(vaultDir, 'profiles', 'user.md'), [
      '# User Profile',
      '',
      `长期记忆 ${preferences.length} 条。`,
      '',
      ...preferences.map(preference => `- [${preference.scope}] ${preference.content}`),
    ].join('\n'));

    const projectSubjects = Array.from(new Set(preferences
      .filter(preference => preference.scope === 'project' && preference.subject)
      .map(preference => preference.subject as string)));
    for (const subject of projectSubjects) {
      const projectPreferences = preferences.filter(preference => preference.scope === 'project' && preference.subject === subject);
      writeFileSync(join(vaultDir, 'profiles', 'projects', `${subject}.md`), [
        `# Project ${subject}`,
        '',
        ...projectPreferences.map(preference => `- ${preference.content}`),
      ].join('\n'));
    }

    return {
      vaultDir,
      preferenceCount: preferences.length,
    };
  }

  status(input: { vaultDir?: string } = {}): MemoryVaultExportResult {
    const vaultDir = input.vaultDir ?? defaultVaultDir();
    return {
      vaultDir,
      preferenceCount: this.memoryEngine.list({ status: 'confirmed' }).length,
    };
  }
}
