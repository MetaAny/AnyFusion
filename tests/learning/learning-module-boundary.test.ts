import { existsSync } from 'fs';
import { resolve } from 'path';
import { describe, expect, it } from 'vitest';

const projectRoot = resolve(__dirname, '../..');

const learningFiles = [
  'skill-usage-candidate-builder',
  'learning-weekly-review-builder',
  'skill-governance-engine',
  'promotion-gate',
  'safety-scanner',
];

describe('learning module architecture boundaries', () => {
  it('keeps learning implementations outside core', () => {
    for (const file of learningFiles) {
      expect(existsSync(resolve(projectRoot, `src/learning/${file}.ts`))).toBe(true);
      expect(existsSync(resolve(projectRoot, `src/core/${file}.ts`))).toBe(false);
    }
  });
});
