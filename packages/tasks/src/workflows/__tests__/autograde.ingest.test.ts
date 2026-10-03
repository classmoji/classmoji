/**
 * Who the ingest task believes: a result is recorded only with the repo's own
 * token. The old per-classroom token (Github workflows provisioned before
 * per-repo tokens) is accepted only while AUTOGRADE_LEGACY_TOKENS_UNTIL is in
 * the future, since anyone who read it could report for every repo in the class.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  recordResult: vi.fn(),
  classroomFindUnique: vi.fn(),
  gitRepoFindFirst: vi.fn(),
  repositoryFindMany: vi.fn(),
}));

vi.mock('@trigger.dev/sdk', () => ({
  task: (config: unknown) => config,
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  auth: { createTriggerPublicToken: vi.fn() },
}));
vi.mock('@classmoji/database', () => ({
  default: () => ({
    classroom: { findUnique: mocks.classroomFindUnique },
    gitRepo: { findFirst: mocks.gitRepoFindFirst },
    repository: { findMany: mocks.repositoryFindMany },
  }),
}));
vi.mock('@classmoji/services', async () => {
  const tokens = await vi.importActual<Record<string, unknown>>(
    '../../../../services/src/autograding/callbackToken.ts'
  );
  return {
    ClassmojiService: { autogradingResult: { recordResult: mocks.recordResult } },
    getGitProvider: vi.fn(),
    generateClassroomWorkflow: vi.fn(),
    generateGitlabCi: vi.fn(),
    ...tokens,
  };
});

const { ingestAutogradeResultTask } = await import('../autograde.ts');
const { signAutogradeRepoToken, signAutogradeCallbackToken } =
  await import('../../../../services/src/autograding/callbackToken.ts');

const run = (payload: Record<string, unknown>) =>
  (ingestAutogradeResultTask as unknown as { run: (p: unknown) => Promise<unknown> }).run(payload);

const pass = Buffer.from('{"status":"pass"}').toString('base64');
const payload = (repo: string, token: string) => ({
  classroomSlug: 'c1',
  repo,
  sha: 'abc',
  token,
  results: { t: { name: 't', result: pass } },
});

beforeEach(() => {
  process.env.AUTOGRADE_CALLBACK_SECRET = 'test-secret';
  delete process.env.AUTOGRADE_LEGACY_TOKENS_UNTIL;
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.classroomFindUnique.mockResolvedValue({
    id: 'class-1',
    git_organization: { provider: 'GITHUB' },
  });
  mocks.gitRepoFindFirst.mockResolvedValue({ id: 'repo-1' });
  mocks.repositoryFindMany.mockResolvedValue([]);
});
afterEach(() => {
  delete process.env.AUTOGRADE_LEGACY_TOKENS_UNTIL;
});

describe('ingest_autograde_result', () => {
  it("records a result carrying the repo's own token", async () => {
    const out = await run(payload('org/hw1-a', signAutogradeRepoToken('c1', 'org/hw1-a')));
    expect(out).toMatchObject({ ok: true, passedTests: 1 });
    expect(mocks.recordResult).toHaveBeenCalledTimes(1);
  });

  it("refuses a classmate's token", async () => {
    const out = await run(payload('org/hw1-b', signAutogradeRepoToken('c1', 'org/hw1-a')));
    expect(out).toMatchObject({ ok: false, reason: 'invalid_token' });
    expect(mocks.recordResult).not.toHaveBeenCalled();
  });

  it('refuses the old class token outside the rollout window', async () => {
    expect(await run(payload('org/hw1-b', signAutogradeCallbackToken('c1')))).toMatchObject({
      reason: 'invalid_token',
    });
    process.env.AUTOGRADE_LEGACY_TOKENS_UNTIL = '2000-01-01T00:00:00Z';
    expect(await run(payload('org/hw1-b', signAutogradeCallbackToken('c1')))).toMatchObject({
      reason: 'invalid_token',
    });
  });

  it('accepts the old class token on Github only while the window is open', async () => {
    process.env.AUTOGRADE_LEGACY_TOKENS_UNTIL = new Date(Date.now() + 86_400_000).toISOString();
    expect(await run(payload('org/hw1-b', signAutogradeCallbackToken('c1')))).toMatchObject({
      ok: true,
    });
    mocks.classroomFindUnique.mockResolvedValue({
      id: 'class-1',
      git_organization: { provider: 'GITLAB' },
    });
    expect(
      await run(payload('g/c1/projects/hw1-b', signAutogradeCallbackToken('c1')))
    ).toMatchObject({
      reason: 'invalid_token',
    });
  });
});
