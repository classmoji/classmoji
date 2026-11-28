/**
 * Gates whose refusals now carry the name every other row about the same
 * thing uses: a submission is GIT_REPO_ASSIGNMENT (the analytics gates said
 * REPOSITORY_ASSIGNMENT), a student's team is TEAMS (its page said TEAM).
 * Each gate is stopped right after it is asked, so only its options are read.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  gate: vi.fn(),
  findUnique: vi.fn(),
  findById: vi.fn(),
}));

const STOP = new Response('stopped at the gate', { status: 403 });

vi.mock('~/utils/routeAuth.server', () => ({
  assertClassroomAccess: (options: unknown) => mocks.gate(options),
  requireClassroomTeachingTeam: (_request: unknown, _slug: unknown, options: unknown) =>
    mocks.gate(options),
  assertClassroomMutationAllowed: vi.fn(),
}));
vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (options: unknown) => mocks.gate(options),
  assertClassroomMutationAllowed: vi.fn(),
}));
vi.mock('@classmoji/database', () => ({
  default: () => ({
    gitRepoAssignment: { findUnique: (...a: unknown[]) => mocks.findUnique(...a) },
  }),
  GIT_IDENTITY: {},
}));
vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    gitRepoAssignment: { findById: (...a: unknown[]) => mocks.findById(...a) },
  },
  getGitProvider: vi.fn(),
  isReservedSlug: vi.fn(),
}));
vi.mock('@trigger.dev/sdk', () => ({ tasks: { trigger: vi.fn() }, auth: {} }));
vi.mock('@trigger.dev/sdk/v3', () => ({ tasks: { trigger: vi.fn() } }));

const analytics = await import('../api.repos.$id.analytics/route.ts');
const refresh = await import('../api.repos.$id.refresh/route.ts');
const submission = await import('../admin.$class.submissions.$id/route.tsx');
const team = await import('../student.$class.repos_.$repo.team/route.tsx');

const args = (params: Record<string, string>, method = 'GET') =>
  ({
    request: new Request('http://localhost/x', { method }),
    params,
    context: {},
  }) as never;

const gateOptions = () => mocks.gate.mock.calls[0][0] as { resourceType?: string };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.gate.mockRejectedValue(STOP);
  const record = { id: 'gra-1', git_repo: { id: 'repo-1', classroom_id: 'class-1' } };
  mocks.findUnique.mockResolvedValue(record);
  mocks.findById.mockResolvedValue(record);
});

describe('gates named like every other row about the same thing', () => {
  it('a submission’s analytics and refresh refuse as GIT_REPO_ASSIGNMENT', async () => {
    await expect(analytics.loader(args({ id: 'gra-1' }))).rejects.toBe(STOP);
    expect(gateOptions().resourceType).toBe('GIT_REPO_ASSIGNMENT');

    mocks.gate.mockClear();
    await expect(refresh.action(args({ id: 'gra-1' }, 'POST'))).rejects.toBe(STOP);
    expect(gateOptions().resourceType).toBe('GIT_REPO_ASSIGNMENT');

    mocks.gate.mockClear();
    await expect(submission.loader(args({ class: 'cs1', id: 'gra-1' }))).rejects.toBe(STOP);
    expect(gateOptions().resourceType).toBe('GIT_REPO_ASSIGNMENT');
  });

  it('a student’s team page refuses as TEAMS, to view and to change', async () => {
    await expect(team.loader(args({ class: 'cs1', repo: 'lab-1' }))).rejects.toBe(STOP);
    expect(gateOptions().resourceType).toBe('TEAMS');

    mocks.gate.mockClear();
    await expect(team.action(args({ class: 'cs1', repo: 'lab-1' }, 'POST'))).rejects.toBe(STOP);
    expect(gateOptions().resourceType).toBe('TEAMS');
  });
});
