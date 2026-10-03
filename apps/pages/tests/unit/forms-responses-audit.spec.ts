import { test, expect } from '@playwright/test';

import {
  exportAuditValue,
  responsesGateAction,
} from '../../app/forms/admin/responsesData.server.ts';

/**
 * What the responses surface writes to the audit log, where it is a pure
 * choice: the name the action's gate is called with, and an export row's
 * `value`.
 *
 * The audit service coalesces rows with the same user, resource, action, tool
 * and value inside five seconds, so `value` decides whether two exports are
 * one row or two. The gate's action name is what a refused attempt is logged
 * under, so a refused reveal of identity answers must not read as a refused
 * triage edit.
 */

test.describe('the responses action gate', () => {
  test('a reveal of identity answers is gated under its own name', () => {
    expect(responsesGateAction('reveal-identity')).toBe('reveal_identity_answers');
  });

  test('triage intents, and a body with no intent, keep the triage name', () => {
    for (const intent of ['set-status', 'set-note', 'delete', undefined, null, 5, 'reveal']) {
      expect(responsesGateAction(intent), String(intent)).toBe('triage_responses');
    }
  });
});

test.describe('an export row’s value', () => {
  test('names the sheet and what it covered', () => {
    expect(exportAuditValue('wide', null)).toBe('wide:all');
    expect(exportAuditValue('long', null)).toBe('long:all');
    expect(exportAuditValue('wide', new Set(['r1']))).toMatch(/^wide:[0-9a-f]{12}$/);
  });

  test('the same selection is the same value, in any order; another selection is not', () => {
    const a = exportAuditValue('wide', new Set(['r1', 'r2', 'r3']));
    expect(exportAuditValue('wide', new Set(['r3', 'r1', 'r2']))).toBe(a);
    // Same size, different responses: two different exports.
    expect(exportAuditValue('wide', new Set(['r1', 'r2', 'r4']))).not.toBe(a);
    // Same responses, the other sheet.
    expect(exportAuditValue('long', new Set(['r1', 'r2', 'r3']))).not.toBe(a);
    expect(exportAuditValue('wide', new Set(['r1', 'r2']))).not.toBe(
      exportAuditValue('wide', null)
    );
  });

  test('the value is a scalar with no response id in it', () => {
    const value = exportAuditValue('wide', new Set(['resp-0001', 'resp-0002']));
    expect(typeof value).toBe('string');
    expect(value).not.toContain('resp-');
  });
});
