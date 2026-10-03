import { describe, it, expect, beforeEach } from 'vitest';
import {
  signAutogradeCallbackToken,
  signAutogradeRepoToken,
  verifyAutogradeCallbackToken,
} from '../callbackToken.ts';

beforeEach(() => {
  process.env.AUTOGRADE_CALLBACK_SECRET = 'test-secret';
});

describe('autograde callback tokens', () => {
  it("accepts a repo's own token, case-insensitively on the path", () => {
    const token = signAutogradeRepoToken('cs10', 'cs/cs10/projects/hw1-alice');
    expect(
      verifyAutogradeCallbackToken('cs10', token, { repoPath: 'CS/cs10/projects/HW1-alice' })
    ).toBe(true);
  });

  it("refuses one repo's token for a classmate's repo", () => {
    const token = signAutogradeRepoToken('cs10', 'org/hw1-alice');
    expect(verifyAutogradeCallbackToken('cs10', token, { repoPath: 'org/hw1-bob' })).toBe(false);
    expect(verifyAutogradeCallbackToken('cs11', token, { repoPath: 'org/hw1-alice' })).toBe(false);
  });

  it('accepts the old per-classroom token only when allowed (Github)', () => {
    const legacy = signAutogradeCallbackToken('cs10');
    expect(verifyAutogradeCallbackToken('cs10', legacy, { repoPath: 'org/hw1-bob' })).toBe(false);
    expect(
      verifyAutogradeCallbackToken('cs10', legacy, {
        repoPath: 'org/hw1-bob',
        allowLegacyClassroomToken: true,
      })
    ).toBe(true);
  });

  it('refuses without a secret or token', () => {
    const token = signAutogradeRepoToken('cs10', 'org/r');
    expect(verifyAutogradeCallbackToken('cs10', null, { repoPath: 'org/r' })).toBe(false);
    delete process.env.AUTOGRADE_CALLBACK_SECRET;
    expect(verifyAutogradeCallbackToken('cs10', token, { repoPath: 'org/r' })).toBe(false);
  });
});
