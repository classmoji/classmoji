/**
 * The Github App's webhooks, received by Trigger.dev instead of hook-station.
 *
 * One hosted endpoint (`github`) gets every delivery the App sends. Trigger.dev
 * verifies `X-Hub-Signature-256`, records the delivery (deduplicated on
 * `X-GitHub-Delivery`, replayable from the dashboard or the MCP) and starts each
 * subscriber below whose filter takes it. Anything else, an issue being
 * labeled, a pull request, is recorded as FILTERED and starts nothing.
 *
 * The subscribers do what apps/hook-station/src/routes/github.ts does: decide
 * from the database whether the payload is ours, then trigger the same task
 * hook-station triggers, with the same concurrency keys. They trigger rather
 * than do the work themselves because a `webhook()` task cannot set a
 * concurrency key, and the push and asset-sync tasks depend on theirs to apply
 * one repo's (or one classroom's) deliveries in order. That second run is only
 * started for a payload that is ours.
 *
 * hook-station's Github route stays until the App's webhook URL points here
 * in every environment; delete it, its collabExternal.ts and their tests then.
 *
 * Filters can only compare a field with a literal, so "is this the repo's
 * default branch" is checked in code, as before.
 */
import { webhook, webhooks } from '@trigger.dev/sdk';
import getPrisma from '@classmoji/database';
import {
  repositoryAssignmentClosedHandlerTask,
  repositoryAssignmentDeletedHandlerTask,
  repositoryAssignmentReopenedHandlerTask,
  repositoryPushHandlerTask,
} from './gitRepoAssignment.ts';
import { memberAddedHandlerTask } from './organization.ts';
import {
  appSuspendedHandlerTask,
  appUninstalledHandlerTask,
  appUnsuspendedHandlerTask,
  newInstallationHandlerTask,
} from './installation.ts';
import { contentAssetsSyncTask } from './contentAssets.ts';
import {
  createCollabExternalTrigger,
  createGithubCompare,
  notifyCollabOfPush,
  type CollabPrisma,
} from '../helpers/collabPushNotify.ts';

export const githubEndpoint = webhooks.endpoint.define({
  id: 'github',
  source: webhooks.github(),
  description: 'The Classmoji Github App: push, issues, organization and installation events.',
});

/** A Github payload, as far as these handlers read it. */
type GithubPayload = Record<string, unknown> & {
  action?: string;
  issue?: { id?: number | string } | null;
  organization?: { id?: number | string } | null;
  installation?: unknown;
};

/** The GitRepoAssignment row an ISSUE-mode issue submits through, if any. */
async function isTrackedIssue(data: GithubPayload): Promise<boolean> {
  if (!data.issue || data.issue.id == null) return false;
  const row = await getPrisma().gitRepoAssignment.findUnique({
    where: { provider_provider_id: { provider: 'GITHUB', provider_id: String(data.issue.id) } },
    select: { id: true },
  });
  return row !== null;
}

/**
 * Whether the organization in the payload has at least one classroom. A
 * GitOrganization row alone is not enough: installing the App creates one.
 */
async function isTrackedOrganization(data: GithubPayload): Promise<boolean> {
  if (!data.organization || data.organization.id == null) return false;
  const row = await getPrisma().classroom.findFirst({
    where: {
      git_organization: { provider: 'GITHUB', provider_id: String(data.organization.id) },
    },
    select: { id: true },
  });
  return row !== null;
}

type Payload<T extends { trigger: (...args: never[]) => unknown }> = Parameters<T['trigger']>[0];

/**
 * ISSUE-mode submissions: closing submits, reopening un-submits, deleting
 * marks the issue gone. Any other issue in the org is not ours.
 */
export async function handleIssueEvent(data: GithubPayload): Promise<void> {
  if (!(await isTrackedIssue(data))) return;
  const payload = data as unknown;
  switch (data.action) {
    case 'closed':
      await repositoryAssignmentClosedHandlerTask.trigger(
        payload as Payload<typeof repositoryAssignmentClosedHandlerTask>
      );
      return;
    case 'reopened':
      await repositoryAssignmentReopenedHandlerTask.trigger(
        payload as Payload<typeof repositoryAssignmentReopenedHandlerTask>
      );
      return;
    case 'deleted':
      await repositoryAssignmentDeletedHandlerTask.trigger(
        payload as Payload<typeof repositoryAssignmentDeletedHandlerTask>
      );
      return;
  }
}

/** A new member of a Github org that has a classroom. */
export async function handleMemberAdded(data: GithubPayload): Promise<void> {
  if (!(await isTrackedOrganization(data))) return;
  await memberAddedHandlerTask.trigger(data as unknown as Payload<typeof memberAddedHandlerTask>);
}

/**
 * The App being installed, removed, suspended or unsuspended. Not gated: rare,
 * and always about us. `unsuspend` has to put the installation id back, or a
 * suspend/unsuspend round trip leaves the org disconnected.
 */
export async function handleInstallationEvent(data: GithubPayload): Promise<void> {
  if (!data.installation) return;
  const payload = data as unknown;
  switch (data.action) {
    case 'created':
      await newInstallationHandlerTask.trigger(
        payload as Payload<typeof newInstallationHandlerTask>
      );
      return;
    case 'deleted':
      await appUninstalledHandlerTask.trigger(payload as Payload<typeof appUninstalledHandlerTask>);
      return;
    case 'suspend':
      await appSuspendedHandlerTask.trigger(payload as Payload<typeof appSuspendedHandlerTask>);
      return;
    case 'unsuspend':
      await appUnsuspendedHandlerTask.trigger(payload as Payload<typeof appUnsuspendedHandlerTask>);
      return;
  }
}

/**
 * GitHub's push payload holds at most 2048 commits in `commits[]`; a push with
 * more has a diff we cannot see the whole of.
 */
const GITHUB_PUSH_COMMIT_CAP = 2048;

/**
 * The asset sync applies a push incrementally only below this many commits;
 * at or above it, it re-reads the whole tree (`complete: false`).
 */
const ASSET_SYNC_INCREMENTAL_BELOW = 20;

interface PushCommit {
  id?: string;
  message?: string;
  added?: string[];
  modified?: string[];
  removed?: string[];
}

export interface PushEventPayload {
  ref?: string;
  forced?: boolean;
  /** True when the push deleted the ref (then `after` is all zeros). */
  deleted?: boolean;
  /** The commit the branch pointed at BEFORE this push. */
  before?: string;
  /** The commit it points at now. */
  after?: string;
  commits?: PushCommit[];
  repository?: {
    /** GitHub's numeric repository id; GitRepo.provider_id holds it as a string. */
    id?: number | string;
    name?: string;
    default_branch?: string;
    owner?: { id?: number | string; login?: string; name?: string };
    /** When GitHub's servers received the push (epoch seconds). Server-set. */
    pushed_at?: number | string;
  };
  sender?: { login?: string; type?: string };
}

/**
 * When the push reached GitHub: the payload's server-set `pushed_at`, which
 * holds even for a delayed or redelivered webhook. Never the commit date (the
 * author's clock). Falls back to now when absent or implausible.
 */
export function serverPushTime(pushedAt: number | string | undefined): string {
  const now = Date.now();
  const ms = typeof pushedAt === 'number' ? pushedAt * 1000 : pushedAt ? Date.parse(pushedAt) : NaN;
  return Number.isFinite(ms) && ms <= now + 60_000
    ? new Date(ms).toISOString()
    : new Date(now).toISOString();
}

type PathStatus = 'added' | 'modified' | 'removed';

/**
 * Flatten a push's commits into one net change set. Commits arrive
 * oldest-first and later ones overwrite earlier ones, so a path added and then
 * removed in the same push comes out as `removed`, the state of the repo now.
 */
export function aggregateChanges(commits: PushCommit[]): {
  added: string[];
  modified: string[];
  removed: string[];
} {
  const statuses = new Map<string, PathStatus>();

  for (const commit of commits) {
    for (const path of commit.added ?? []) statuses.set(path, 'added');
    for (const path of commit.modified ?? []) statuses.set(path, 'modified');
    for (const path of commit.removed ?? []) statuses.set(path, 'removed');
  }

  const changes = { added: [] as string[], modified: [] as string[], removed: [] as string[] };
  for (const [path, status] of statuses) {
    changes[status].push(path);
  }

  return changes;
}

const triggerCollabExternal = createCollabExternalTrigger();

/**
 * A push to a repo's DEFAULT branch, checked in the order it is likely.
 *
 * To a STUDENT repo it is the submission for every published REPO-mode
 * assignment that submits through that repo, at the time GitHub received it
 * (`repository.pushed_at`). Branch deletions and bot pushes (the autograde
 * workflow commits) are not submissions.
 *
 * To a classroom's CONTENT repo it refreshes that classroom's asset map and,
 * for a live-editing classroom, hands changed pages/decks to the collab
 * service. No classroom means not ours, never an error.
 */
export async function handlePush(data: PushEventPayload): Promise<void> {
  const repo = data.repository?.name;
  const owner = data.repository?.owner?.login;
  const defaultBranch = data.repository?.default_branch;
  const ownerId = data.repository?.owner?.id;

  if (!repo || !owner || !defaultBranch) return;
  if (data.ref !== `refs/heads/${defaultBranch}`) return;

  const providerRepoId = data.repository?.id;
  if (providerRepoId != null && !data.deleted && data.sender?.type !== 'Bot') {
    const gitRepo = await getPrisma().gitRepo.findUnique({
      where: { provider_provider_id: { provider: 'GITHUB', provider_id: String(providerRepoId) } },
      select: { id: true },
    });
    if (gitRepo) {
      await repositoryPushHandlerTask.trigger(
        { gitRepoId: gitRepo.id, pushedAt: serverPushTime(data.repository?.pushed_at) },
        // One submission update per student repo at a time, in delivery order.
        { concurrencyKey: gitRepo.id }
      );
      return;
    }
  }

  const classroom = await getPrisma().classroom.findFirst({
    where: {
      content_repo: repo,
      // The org by GitHub's immutable id when the payload has it, else by login.
      git_organization:
        ownerId != null ? { provider: 'GITHUB', provider_id: String(ownerId) } : { login: owner },
    },
    select: {
      id: true,
      collab_enabled: true,
      git_organization: {
        select: { provider: true, github_installation_id: true, login: true },
      },
    },
  });

  if (!classroom) return;

  const commits = data.commits ?? [];

  // Live editing: tell the collab service about an outside push. Never throws.
  // Awaited, unlike in hook-station: a run can end before an unawaited promise
  // settles. It runs alongside the asset sync so neither holds up the other.
  const collab =
    !data.deleted && data.after
      ? notifyCollabOfPush(
          {
            classroomId: classroom.id,
            collabEnabled: classroom.collab_enabled,
            after: data.after,
            before: data.before ?? null,
            commits,
            complete: commits.length < GITHUB_PUSH_COMMIT_CAP,
            forced: Boolean(data.forced),
            sender: data.sender,
          },
          {
            prisma: getPrisma() satisfies CollabPrisma,
            trigger: triggerCollabExternal,
            compare: createGithubCompare(classroom.git_organization, owner, repo),
          }
        )
      : Promise.resolve();

  const sync = contentAssetsSyncTask.trigger(
    {
      classroomId: classroom.id,
      reason: 'push' as const,
      changes: aggregateChanges(commits),
      // A force-push rewrites history, so the commits listed are not a diff
      // against what we last synced.
      forced: Boolean(data.forced),
      complete: commits.length < ASSET_SYNC_INCREMENTAL_BELOW,
      // `before` lets the sync notice an earlier delivery went missing;
      // `after` is what the map records once it has.
      before: data.before,
      after: data.after,
    },
    // One sync per classroom at a time, so the recorded commit never moves back.
    { concurrencyKey: classroom.id }
  );

  await Promise.all([collab, sync]);
}

export const githubIssueWebhook = webhook({
  id: 'github-issue',
  endpoint: githubEndpoint,
  filter: "header.x-github-event == 'issues' && event.action in ['closed', 'reopened', 'deleted']",
  onEvent: async ({ event }) => handleIssueEvent(event as GithubPayload),
});

export const githubMemberAddedWebhook = webhook({
  id: 'github-member-added',
  endpoint: githubEndpoint,
  filter: "header.x-github-event == 'organization' && event.action == 'member_added'",
  onEvent: async ({ event }) => handleMemberAdded(event as GithubPayload),
});

export const githubInstallationWebhook = webhook({
  id: 'github-installation',
  endpoint: githubEndpoint,
  filter:
    "header.x-github-event == 'installation' && event.action in ['created', 'deleted', 'suspend', 'unsuspend']",
  onEvent: async ({ event }) => handleInstallationEvent(event as GithubPayload),
});

export const githubPushWebhook = webhook({
  id: 'github-push',
  endpoint: githubEndpoint,
  // Branches only (not tags); which branch is the default is checked in code.
  //
  // The rest keeps repo creation's setup pushes (helpers/createRepository.ts)
  // from starting runs, none of which would do anything:
  //  - `feedback` and `updates`, the side branches every repo is created with;
  //  - the App's two pushes to `main`: the template history, which creates the
  //    branch, and the empty "Start your feedback space" commit. Classmoji's
  //    other bot pushes (checkpoints, uploads to a content repo) go to an
  //    existing branch with other messages, so they still get through.
  // If that commit message changes, its run just comes back; nothing breaks.
  filter:
    "header.x-github-event == 'push' && event.ref startsWith 'refs/heads/' && event.ref not in ['refs/heads/feedback', 'refs/heads/updates'] && (event.sender.type != 'Bot' || (event.created == false && event.head_commit.message != 'Start your feedback space'))",
  onEvent: async ({ event }) => handlePush(event as PushEventPayload),
});
