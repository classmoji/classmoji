import { describe, it, expect } from 'vitest';
import { decideClassroom, parseArgs, selectorError } from '../pagesOffDecision.ts';

const base = { provider: 'GITHUB', login: 'org', contentDeliveryEnabled: true, force: false };

describe('parseArgs', () => {
  it('reads --classroom in both spellings', () => {
    expect(parseArgs(['--classroom', 'cs98-fall-2026']).classroomSlug).toBe('cs98-fall-2026');
    expect(parseArgs(['--classroom=cs98-fall-2026']).classroomSlug).toBe('cs98-fall-2026');
  });

  // `--classroom --dry-run` is a slug the operator forgot to type, not a
  // classroom named "--dry-run".
  it('does not swallow the next flag as a slug', () => {
    expect(parseArgs(['--classroom', '--dry-run']).classroomSlug).toBeNull();
  });

  it('reads the boolean flags', () => {
    const opts = parseArgs(['--all-enabled', '--dry-run', '--force']);
    expect(opts).toMatchObject({ allEnabled: true, dryRun: true, force: true });
  });
});

describe('selectorError', () => {
  // The whole point: no selector must never mean "every classroom".
  it('rejects no selector and both selectors', () => {
    expect(selectorError(parseArgs([]))).toMatch(/--classroom <slug>, or --all-enabled/);
    expect(selectorError(parseArgs(['--all-enabled', '--classroom', 'x']))).toMatch(/not both/);
  });

  it('accepts exactly one', () => {
    expect(selectorError(parseArgs(['--classroom', 'x']))).toBeNull();
    expect(selectorError(parseArgs(['--all-enabled']))).toBeNull();
  });
});

describe('decideClassroom', () => {
  it('proceeds unforced for a gated GitHub classroom', () => {
    expect(decideClassroom(base)).toEqual({ action: 'proceed', forced: false });
  });

  // The refusal this script exists to have: with the gate off, github.io IS
  // that classroom's delivery path.
  it('refuses when the gate is off', () => {
    const decision = decideClassroom({ ...base, contentDeliveryEnabled: false });
    expect(decision.action).toBe('refuse');
    expect(decision).toHaveProperty('reason', expect.stringContaining('content_delivery_enabled'));
  });

  it('proceeds under --force, and says it was forced', () => {
    expect(decideClassroom({ ...base, contentDeliveryEnabled: false, force: true })).toEqual({
      action: 'proceed',
      forced: true,
    });
  });

  // --force is an override of the gate, not of "this provider has no Pages API".
  it('skips a non-GitHub organization even under --force', () => {
    const decision = decideClassroom({ ...base, provider: 'GITLAB', force: true });
    expect(decision).toEqual({ action: 'skip', reason: 'not a GitHub organization (GITLAB)' });
  });

  it('skips an organization with no login', () => {
    expect(decideClassroom({ ...base, login: null }).action).toBe('skip');
  });
});
