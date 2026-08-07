import { describe, expect, it } from 'vitest';
import { SafetyScanner } from '../../src/learning/safety-scanner.js';
import { PromotionGate } from '../../src/learning/promotion-gate.js';

describe('Phase E learning core skeletons', () => {
  it('SafetyScanner redacts secrets and blocks unsafe learning candidates', () => {
    const scanner = new SafetyScanner();

    const result = scanner.scanCandidate({
      title: '部署脚本经验',
      content: '把 API_KEY=sk-live-secret123 写入配置，然后 rm -rf /tmp/demo',
    });

    expect(result.status).toBe('blocked');
    expect(result.redactedContent).not.toContain('sk-live-secret123');
    expect(result.reasons).toEqual(expect.arrayContaining(['contains_secret', 'contains_dangerous_command']));
  });

  it('PromotionGate requires review for pending candidates and refuses unsafe candidates', () => {
    const gate = new PromotionGate();

    expect(gate.evaluate({ status: 'pending', safetyStatus: 'passed', kind: 'skill' })).toMatchObject({
      decision: 'needs_review',
    });
    expect(gate.evaluate({ status: 'approved', safetyStatus: 'passed', kind: 'skill' })).toMatchObject({
      decision: 'promote',
    });
    expect(gate.evaluate({ status: 'approved', safetyStatus: 'blocked', kind: 'skill' })).toMatchObject({
      decision: 'blocked',
    });
  });
});
