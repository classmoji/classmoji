/**
 * Create-classroom offers quiz import to Pro creators only, and only where the
 * AI agent is configured.
 *
 * The new classroom's only owner is its creator, so its Pro state is theirs:
 * the loader reads the creator's current subscription with the same test the
 * classroom resolver applies per owner (tier PRO and still active). Without
 * it, or without the agent, the repository picker has no quiz columns and the
 * review step never mentions quizzes. The action re-decides on the created
 * classroom (action.quizImport.test.ts).
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCurrent: vi.fn(),
  isAIAgentConfigured: vi.fn(),
}));

vi.mock('~/utils/aiFeatures.server', () => ({
  isAIAgentConfigured: () => mocks.isAIAgentConfigured(),
}));

vi.mock('@classmoji/auth/server', () => ({
  getAuthSession: vi.fn().mockResolvedValue({ userId: 'user-1', token: 'gh-token' }),
  clearRevokedToken: vi.fn(),
}));

// The real activity test, so a lapsed PRO row is judged exactly as the
// classroom resolver judges it. Its only import is the database, mocked below.
vi.mock('@classmoji/services', async () => {
  const subscription =
    await import('../../../../../../packages/services/src/classmoji/subscription.service.ts');
  return {
    ClassmojiService: {
      user: { findById: vi.fn().mockResolvedValue({ id: 'user-1', login: 'instructor' }) },
      gitOrganization: { syncUserInstallations: vi.fn().mockResolvedValue([]) },
      subscription: {
        getCurrent: (...a: unknown[]) => mocks.getCurrent(...a),
        isSubscriptionActive: subscription.isSubscriptionActive,
      },
    },
    GitHubProvider: {
      getUserOctokit: () => ({
        rest: {
          users: { getAuthenticated: vi.fn().mockResolvedValue({ data: { login: 'instructor' } }) },
        },
      }),
    },
  };
});

vi.mock('@classmoji/database', () => ({
  default: () => ({
    // A Github-connected creator: the Github side of the form.
    account: { findMany: vi.fn().mockResolvedValue([{ provider_id: 'github' }]) },
    gitOrganization: { findMany: vi.fn().mockResolvedValue([]) },
    classroom: { findMany: vi.fn().mockResolvedValue([]) },
  }),
}));

// The Gitlab side of the form is not under test: Gitlab is not configured.
vi.mock('../gitlabOptions.server', () => ({
  loadGitLabOptions: async () => ({
    enabled: false,
    connection: null,
    host: null,
    groups: [],
    error: null,
  }),
}));

// The loader is under test here, and the two leaf components below; the rest
// of the wizard only needs to import.
vi.mock('~/hooks', () => ({
  useGlobalFetcher: () => ({}),
  useGitHubAppInstallPopup: () => ({}),
}));
vi.mock('~/constants', () => ({ ActionTypes: {} }));
// Not under test here: a deployment with no Gitlab configured.
vi.mock('../gitlabOptions.server', () => ({
  loadGitLabOptions: vi.fn().mockResolvedValue({
    enabled: false,
    connection: null,
    host: null,
    groups: [],
    error: null,
  }),
}));
vi.mock('../StepBasicInfo', () => ({ default: () => null }));
vi.mock('../action', () => ({ action: vi.fn() }));

const { loader } = await import('../route.tsx');
const ModuleImportTable = (await import('../ModuleImportTable.tsx')).default;
const StepReview = (await import('../StepReview.tsx')).default;
const StepImportModules = (await import('../StepImportModules.tsx')).default;

const load = async () =>
  (await loader({
    request: new Request('http://localhost/create-classroom'),
    params: {},
  } as never)) as { quizzesVisible: boolean };

const DAY = 24 * 60 * 60 * 1000;

describe('create-classroom loader — quiz import follows the creator', () => {
  beforeEach(() => {
    mocks.getCurrent.mockReset();
    mocks.isAIAgentConfigured.mockReset().mockReturnValue(true);
  });

  it('offers it to a creator on an active Pro subscription', async () => {
    mocks.getCurrent.mockResolvedValue({ id: 's-1', tier: 'PRO', ends_at: null });
    expect((await load()).quizzesVisible).toBe(true);
    expect(mocks.getCurrent).toHaveBeenCalledWith('user-1');
  });

  it('withholds it from a Pro creator when the AI agent is not configured', async () => {
    mocks.isAIAgentConfigured.mockReturnValue(false);
    mocks.getCurrent.mockResolvedValue({ id: 's-1', tier: 'PRO', ends_at: null });
    expect((await load()).quizzesVisible).toBe(false);
  });

  it('withholds it from a free creator', async () => {
    mocks.getCurrent.mockResolvedValue({ id: null, tier: 'FREE' });
    expect((await load()).quizzesVisible).toBe(false);
  });

  it('withholds it from a creator whose Pro subscription has lapsed', async () => {
    mocks.getCurrent.mockResolvedValue({
      id: 's-1',
      tier: 'PRO',
      ends_at: new Date(Date.now() - DAY),
    });
    expect((await load()).quizzesVisible).toBe(false);
  });
});

const REPOSITORIES = [
  { id: 'repo-1', title: 'lab-1', type: 'INDIVIDUAL', _count: { assignments: 2, quizzes: 3 } },
];

describe('repository picker and review — quizzes go unmentioned without Pro', () => {
  const table = (quizzesVisible: boolean) =>
    renderToStaticMarkup(
      createElement(ModuleImportTable, {
        repositories: REPOSITORIES,
        selectedModules: new Map([['repo-1', { includeQuizzes: false }]]),
        onModuleToggle: () => {},
        onQuizToggle: () => {},
        quizzesVisible,
      })
    );

  const review = (quizzesVisible: boolean) =>
    renderToStaticMarkup(
      createElement(StepReview, {
        formValues: { git_org_id: 'org-1', name: 'Web Dev', slug: 'web-dev', content_repo: '' },
        gitOrgs: [{ id: 'org-1', login: 'cs52-org', avatar_url: null, classrooms: [] }],
        slugPreview: 'web-dev',
        importEnabled: true,
        sourceClassroom: {
          id: 'source-1',
          name: 'CS 52',
          is_owner: true,
          repositories: REPOSITORIES,
        },
        selectedModules: new Map([['repo-1', { includeQuizzes: false }]]),
        quizzesVisible,
      })
    );

  it('shows the quiz columns to a Pro creator', () => {
    const html = table(true);
    expect(html).toContain('Include Quizzes');
    expect(html).toContain('Quizzes');
  });

  it('leaves the quiz columns out otherwise', () => {
    const html = table(false);
    expect(html).toContain('Assignments');
    expect(html).not.toMatch(/quiz/i);
  });

  it('keeps the import step free of quizzes otherwise', () => {
    const step = (quizzesVisible: boolean) =>
      renderToStaticMarkup(
        createElement(StepImportModules, {
          importableClassrooms: [
            { id: 'source-1', name: 'CS 52', is_owner: true, repositories: REPOSITORIES },
          ],
          importEnabled: true,
          setImportEnabled: () => {},
          sourceClassroomId: 'source-1',
          setSourceClassroomId: () => {},
          selectedModules: new Map([['repo-1', { includeQuizzes: false }]]),
          setSelectedModules: () => {},
          importSelections: {
            grading: true,
            gradeScales: true,
            tokens: true,
            features: true,
            aiConfig: true,
            apiKeys: false,
            calendar: false,
            pages: true,
            slides: true,
            modules: true,
            duplicateTemplates: true,
          },
          setImportSelections: () => {},
          quizzesVisible,
        })
      );

    expect(step(true)).toContain('AI &amp; quiz config');
    expect(step(true)).toContain('Repositories and quizzes will start');
    expect(step(false)).toContain('AI config');
    expect(step(false)).not.toMatch(/quiz/i);
  });

  it('keeps the review step free of quizzes otherwise', () => {
    expect(review(true)).toMatch(/Quizzes/);
    expect(review(false)).not.toMatch(/quiz/i);
    expect(review(false)).toContain('Repositories will start unpublished.');
  });
});
