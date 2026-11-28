/**
 * A git provider's 4xx (the provider saying no: an invite already pending,
 * not allowed, not there, invalid) is an answer and never reported, in the
 * staff org invite and in team administration; a 5xx, a network failure and
 * a database fault are reported, with the status as their only tag.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  setErrorReporter,
  type ErrorReporter,
  type ReportContext,
} from '@classmoji/utils/error-report';

vi.mock('@trigger.dev/sdk', () => ({ tasks: { trigger: vi.fn() } }));
vi.mock('@classmoji/database', () => ({
  default: () => ({}),
  GIT_IDENTITY: {},
  gitScopeProvider: () => 'GITHUB',
  whereGitUsername: () => ({}),
}));

const { reportOrgInviteFailure } = await import('../staff.service.ts');
const { failureReason } = await import('../teamAdmin.service.ts');

let captured: Array<{ error: unknown; context: ReportContext }>;
const reporter: ErrorReporter = {
  capture: (error, context) => captured.push({ error, context }),
  flush: async () => true,
};
const withStatus = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

beforeEach(() => {
  captured = [];
  setErrorReporter(reporter);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  setErrorReporter(null);
  vi.restoreAllMocks();
});

describe('staff org invite', () => {
  it.each([403, 404, 422])('does not report a provider %i', status => {
    reportOrgInviteFailure(withStatus(status));
    expect(captured).toEqual([]);
  });

  it('reports a 5xx and a failure without a status', () => {
    const down = withStatus(502);
    const network = new TypeError('fetch failed');
    reportOrgInviteFailure(down);
    reportOrgInviteFailure(network);
    expect(captured).toEqual([
      { error: down, context: { surface: 'staff.org_invite', tags: { status: 502 } } },
      { error: network, context: { surface: 'staff.org_invite', tags: { status: undefined } } },
    ]);
  });
});

describe('team administration', () => {
  it.each([403, 404, 422])('does not report a provider %i, and classifies it as before', status => {
    const reason = failureReason('add someone to a team', withStatus(status), 'provider_error');
    expect(reason).toBe(status === 404 ? 'not_found' : 'provider_error');
    expect(captured).toEqual([]);
  });

  it('reports a 5xx and a database fault', () => {
    const down = withStatus(503);
    const db = Object.assign(new Error('db'), { code: 'P1001' });
    expect(failureReason('rename', down, 'provider_error')).toBe('provider_error');
    expect(failureReason('attach tag', db, 'db_error')).toBe('db_error');
    expect(captured.map(c => c.context)).toEqual([
      { surface: 'team.admin', tags: { reason: 'provider_error', status: 503 } },
      { surface: 'team.admin', tags: { reason: 'db_error', status: undefined } },
    ]);
  });
});
