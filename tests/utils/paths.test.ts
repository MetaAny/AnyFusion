import { describe, expect, it } from 'vitest';
import { resolveAnyFusionConfigHome, resolveMetaclawDir } from '../../src/utils/paths.js';

describe('resolveMetaclawDir', () => {
  it('uses METACLAW_HOME when provided', () => {
    expect(resolveMetaclawDir('./tmp/metaclaw-home', '/Users/demo')).toMatch(/tmp\/metaclaw-home$/);
  });

  it('falls back to the AnyFusion XDG data directory when override is missing', () => {
    expect(resolveMetaclawDir('', '/Users/demo', '')).toBe('/Users/demo/.local/share/anyfusion/runtime');
    expect(resolveMetaclawDir('', '/Users/demo', '/var/lib/user-data')).toBe('/var/lib/user-data/anyfusion/runtime');
  });

  it('uses the same XDG config layout as the shared bootstrap', () => {
    expect(resolveAnyFusionConfigHome('', '/Users/demo', '')).toBe('/Users/demo/.config/anyfusion');
    expect(resolveAnyFusionConfigHome('', '/Users/demo', '/etc/user-config')).toBe('/etc/user-config/anyfusion');
  });
});
