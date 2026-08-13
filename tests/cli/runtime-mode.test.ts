import { describe, expect, it } from 'vitest';
import { shouldRunPlannerTui } from '../../src/cli/runtime-mode.js';

describe('runtime mode selection', () => {
  it('keeps gateway run out of the Planner TUI without a hidden env flag', () => {
    expect(shouldRunPlannerTui({ gateway: true }, {})).toBe(false);
    expect(shouldRunPlannerTui({ gateway: false }, {})).toBe(true);
    expect(shouldRunPlannerTui({ gateway: false }, { METACLAW_STANDBY_TUI: '1' })).toBe(false);
  });
});
