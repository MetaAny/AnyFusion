import { describe, expect, it } from 'vitest';
import { resolveMetaclawDir } from '../../src/utils/paths.js';

describe('resolveMetaclawDir', () => {
  it('uses METACLAW_HOME when provided', () => {
    expect(resolveMetaclawDir('./tmp/metaclaw-home', '/Users/demo')).toMatch(/tmp\/metaclaw-home$/);
  });

  it('falls back to the AnyFusion XDG data directory when override is missing', () => {
    expect(resolveMetaclawDir('', '/Users/demo', '')).toBe('/Users/demo/.local/share/anyfusion');
    expect(resolveMetaclawDir('', '/Users/demo', '/var/lib/user-data')).toBe('/var/lib/user-data/anyfusion');
  });
});
