/**
 * The Github App's issue, organization and installation subscribers
 * (githubWebhook.ts), ported from hook-station's route tests.
 *
 * Signature verification and routing by `X-GitHub-Event` now belong to
 * Trigger.dev (the endpoint's source and each subscriber's filter), so what is
 * left to test here is what the handlers do once a delivery reaches them: the
 * "is this ours" lookup, and which task each action triggers.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  closed: vi.fn().mockResolvedValue(undefined),
  reopened: vi.fn().mockResolvedValue(undefined),
  deleted: vi.fn().mockResolvedValue(undefined),
  push: vi.fn().mockResolvedValue(undefined),
  memberAdded: vi.fn().mockResolvedValue(undefined),
  newInstall: vi.fn().mockResolvedValue(undefined),
  appUninstalled: vi.fn().mockResolvedValue(undefined),
  appSuspended: vi.fn().mockResolvedValue(undefined),
  appUnsuspended: vi.fn().mockResolvedValue(undefined),
  contentAssetsSync: vi.fn().mockResolvedValue(undefined),
  gitRepoAssignmentFindUnique: vi.fn(),
  classroomFindFirst: vi.fn(),
}));

// `webhook()` and `endpoint.define()` return their config, so the filters can
// be read back.
vi.mock('@trigger.dev/sdk', () => ({
  task: (config: unknown) => config,
  webhook: (config: unknown) => config,
  webhooks: { endpoint: { define: (config: unknown) => config }, github: () => ({}) },
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('@classmoji/database', () => {
  const prisma = () => ({
    gitRepoAssignment: { findUnique: mocks.gitRepoAssignmentFindUnique },
    classroom: { findFirst: mocks.classroomFindFirst },
  });
  return { getPrisma: prisma, default: prisma };
});

vi.mock('../gitRepoAssignment.ts', () => ({
  repositoryAssignmentClosedHandlerTask: { trigger: mocks.closed },
  repositoryAssignmentReopenedHandlerTask: { trigger: mocks.reopened },
  repositoryAssignmentDeletedHandlerTask: { trigger: mocks.deleted },
  repositoryPushHandlerTask: { trigger: mocks.push },
}));
vi.mock('../organization.ts', () => ({
  memberAddedHandlerTask: { trigger: mocks.memberAdded },
}));
vi.mock('../installation.ts', () => ({
  newInstallationHandlerTask: { trigger: mocks.newInstall },
  appUninstalledHandlerTask: { trigger: mocks.appUninstalled },
  appSuspendedHandlerTask: { trigger: mocks.appSuspended },
  appUnsuspendedHandlerTask: { trigger: mocks.appUnsuspended },
}));
vi.mock('../contentAssets.ts', () => ({
  contentAssetsSyncTask: { trigger: mocks.contentAssetsSync },
}));

import {
  githubInstallationWebhook,
  githubIssueWebhook,
  githubMemberAddedWebhook,
  githubPushWebhook,
  handleInstallationEvent,
  handleIssueEvent,
  handleMemberAdded,
} from '../githubWebhook.ts';

const triggers = [
  mocks.closed,
  mocks.reopened,
  mocks.deleted,
  mocks.push,
  mocks.memberAdded,
  mocks.newInstall,
  mocks.appUninstalled,
  mocks.appSuspended,
  mocks.appUnsuspended,
  mocks.contentAssetsSync,
];

beforeEach(() => {
  triggers.forEach(t => t.mockClear());
  // Every lookup answers "found" by default, so the dispatch tests stay about
  // dispatch; the gating tests flip them to null.
  mocks.gitRepoAssignmentFindUnique.mockReset().mockResolvedValue({ id: 'gra-1' });
  mocks.classroomFindFirst.mockReset().mockResolvedValue({ id: 'classroom-1' });
});

describe('subscriber filters', () => {
  // Trigger.dev evaluates these server-side; a delivery none of them takes is
  // recorded FILTERED and starts no run. GitHub reuses action words across
  // events (`created`, `deleted`, `suspend`), so every filter names the event.
  it('route on the event header and the actions the handlers act on', () => {
    const filter = (w: unknown) => (w as { filter: string }).filter;
    expect(filter(githubIssueWebhook)).toBe(
      "header.x-github-event == 'issues' && event.action in ['closed', 'reopened', 'deleted']"
    );
    expect(filter(githubMemberAddedWebhook)).toBe(
      "header.x-github-event == 'organization' && event.action == 'member_added'"
    );
    expect(filter(githubInstallationWebhook)).toBe(
      "header.x-github-event == 'installation' && event.action in ['created', 'deleted', 'suspend', 'unsuspend']"
    );
    expect(filter(githubPushWebhook)).toBe(
      "header.x-github-event == 'push' && event.ref startsWith 'refs/heads/' && event.ref not in ['refs/heads/feedback', 'refs/heads/updates'] && (event.sender.type != 'Bot' || (event.created == false && event.head_commit.message != 'Start your feedback space'))"
    );
  });
});

describe('issues', () => {
  it('triggers the closed handler with the parsed payload', async () => {
    await handleIssueEvent({ action: 'closed', issue: { id: 1, number: 7 } } as never);
    expect(mocks.closed).toHaveBeenCalledTimes(1);
    // The task resolves which assignment closed from the payload's issue.
    expect(mocks.closed).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'closed', issue: { id: 1, number: 7 } })
    );
  });

  it('triggers the reopened handler for a reopen', async () => {
    await handleIssueEvent({ action: 'reopened', issue: { id: 1, number: 7 } } as never);
    expect(mocks.reopened).toHaveBeenCalledTimes(1);
    expect(mocks.reopened).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'reopened', issue: { id: 1, number: 7 } })
    );
    expect(mocks.closed).not.toHaveBeenCalled();
  });

  it('triggers repositoryAssignmentDeleted for a deletion', async () => {
    await handleIssueEvent({ action: 'deleted', issue: { id: 1 } } as never);
    expect(mocks.deleted).toHaveBeenCalledTimes(1);
    expect(mocks.appUninstalled).not.toHaveBeenCalled();
  });

  it('does nothing when the payload has no issue', async () => {
    await handleIssueEvent({ action: 'closed' } as never);
    expect(mocks.closed).not.toHaveBeenCalled();
    expect(mocks.gitRepoAssignmentFindUnique).not.toHaveBeenCalled();
  });

  it('does nothing for an action it does not handle', async () => {
    await handleIssueEvent({ action: 'totally_unknown_action_xyz', issue: { id: 1 } } as never);
    expect(triggers.every(t => t.mock.calls.length === 0)).toBe(true);
  });
});

describe('organization.member_added', () => {
  it('triggers memberAdded', async () => {
    await handleMemberAdded({
      action: 'member_added',
      member: { login: 'alice' },
      organization: { id: 5, login: 'cs-org' },
    } as never);
    expect(mocks.memberAdded).toHaveBeenCalledTimes(1);
  });
});

describe('installation', () => {
  it('triggers newInstallation for created', async () => {
    await handleInstallationEvent({ action: 'created', installation: { id: 99 } } as never);
    expect(mocks.newInstall).toHaveBeenCalledTimes(1);
  });

  it('triggers appUninstalled for deleted', async () => {
    await handleInstallationEvent({ action: 'deleted', installation: { id: 99 } } as never);
    expect(mocks.appUninstalled).toHaveBeenCalledTimes(1);
    expect(mocks.deleted).not.toHaveBeenCalled();
  });

  it('triggers appSuspended for suspend', async () => {
    // A suspended installation mints no tokens, so the org has to stop
    // claiming it is connected.
    await handleInstallationEvent({ action: 'suspend', installation: { id: 99 } } as never);
    expect(mocks.appSuspended).toHaveBeenCalledTimes(1);
    expect(mocks.appUninstalled).not.toHaveBeenCalled();
    expect(mocks.newInstall).not.toHaveBeenCalled();
  });

  it('triggers appUnsuspended for unsuspend', async () => {
    await handleInstallationEvent({ action: 'unsuspend', installation: { id: 99 } } as never);
    expect(mocks.appUnsuspended).toHaveBeenCalledTimes(1);
    expect(mocks.appSuspended).not.toHaveBeenCalled();
  });

  it('does nothing when the payload carries no installation', async () => {
    await handleInstallationEvent({ action: 'suspend' } as never);
    expect(mocks.appSuspended).not.toHaveBeenCalled();
  });
});

describe('events from organizations that are not ours', () => {
  // The App is installed on orgs that never made a classroom, or made one and
  // moved on. Each of their events must cost one indexed read, never a run.

  it('does not trigger the closed handler for an issue no assignment submits through', async () => {
    mocks.gitRepoAssignmentFindUnique.mockResolvedValue(null);
    await handleIssueEvent({ action: 'closed', issue: { id: 4242, number: 9 } } as never);
    expect(mocks.closed).not.toHaveBeenCalled();
    // Looked up by the GitHub issue id, which is the row's provider id.
    expect(mocks.gitRepoAssignmentFindUnique).toHaveBeenCalledTimes(1);
    expect(mocks.gitRepoAssignmentFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { provider_provider_id: { provider: 'GITHUB', provider_id: '4242' } },
      })
    );
  });

  it('does not trigger the reopened or deleted handlers for an unknown issue', async () => {
    mocks.gitRepoAssignmentFindUnique.mockResolvedValue(null);
    for (const action of ['reopened', 'deleted']) {
      await handleIssueEvent({ action, issue: { id: 4242 } } as never);
    }
    expect(mocks.reopened).not.toHaveBeenCalled();
    expect(mocks.deleted).not.toHaveBeenCalled();
  });

  it('does not trigger memberAdded for an organization with no classroom', async () => {
    // A GitOrganization row is not enough: installing the App creates one.
    mocks.classroomFindFirst.mockResolvedValue(null);
    await handleMemberAdded({
      action: 'member_added',
      member: { login: 'alice' },
      organization: { id: 777, login: 'someone-elses-org' },
    } as never);
    expect(mocks.memberAdded).not.toHaveBeenCalled();
    expect(mocks.classroomFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { git_organization: { provider: 'GITHUB', provider_id: '777' } },
      })
    );
  });

  it('does not trigger memberAdded when the payload carries no organization', async () => {
    await handleMemberAdded({ action: 'member_added', member: { login: 'alice' } } as never);
    expect(mocks.memberAdded).not.toHaveBeenCalled();
    expect(mocks.classroomFindFirst).not.toHaveBeenCalled();
  });

  it('does not consult the database for installation events', async () => {
    // Installation events are rare and always about us; they are not gated.
    await handleInstallationEvent({ action: 'created', installation: { id: 99 } } as never);
    expect(mocks.newInstall).toHaveBeenCalledTimes(1);
    expect(mocks.gitRepoAssignmentFindUnique).not.toHaveBeenCalled();
    expect(mocks.classroomFindFirst).not.toHaveBeenCalled();
  });
});
