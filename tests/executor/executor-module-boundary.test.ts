import { existsSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const projectRoot = resolve(__dirname, '../..');

const executorServiceFiles = [
  'executor-registration-service',
  'executor-registry-service',
];

describe('executor module architecture boundaries', () => {
  it('keeps executor service implementations in src/executor and out of core', () => {
    for (const file of executorServiceFiles) {
      expect(existsSync(resolve(projectRoot, `src/executor/${file}.ts`))).toBe(true);
      expect(existsSync(resolve(projectRoot, `src/core/${file}.ts`))).toBe(false);
    }
  });
});
