import { task, logger, auth } from '@trigger.dev/sdk';
import getPrisma from '@classmoji/database';
import { repoNamespace } from '@classmoji/utils';
import {
  ClassmojiService,
  getGitProvider,
  generateClassroomWorkflow,
  generateGitlabCi,
  signAutogradeRepoToken,
  verifyAutogradeCallbackToken,
  type GitProvider,
  type WorkflowTestInput,
} from '@classmoji/services';

const WORKFLOW_PATH = '.github/workflows/classroom.yml';
/** GitLab runs CI from the project's root `.gitlab-ci.yml`. */
const GITLAB_CI_PATH = '.gitlab-ci.yml';

const workflowPath = (provider?: string | null) =>
  provider === 'GITLAB' ? GITLAB_CI_PATH : WORKFLOW_PATH;
const COMMIT_MESSAGE = 'Add/update Classmoji autograding workflow';

// Results are reported by triggering this task via Trigger.dev's public REST
// API (reachable from GitHub Actions; routes to the dev/deployed worker).
const INGEST_TASK_ID = 'ingest_autograde_result';

/**
 * The Trigger.dev API address that GitHub Actions can reach.
 *
 * Deliberately NOT `TRIGGER_API_URL`: inside a deployed worker the platform
 * sets that to its own internal address (platform.internal.trigger.dev:44330),
 * which is what the SDK should talk to but which does not exist from the
 * public internet. Shipping it into a student's workflow made every report
 * step fail silently (issue #391). Self-hosters set TRIGGER_PUBLIC_API_URL to
 * their public Trigger URL; everyone else gets the cloud.
 */
export function publicTriggerApiBase(env: NodeJS.ProcessEnv = process.env): string {
  const base = (env.TRIGGER_PUBLIC_API_URL || 'https://api.trigger.dev').replace(/\/+$/, '');
  let host: string;
  try {
    host = new URL(base).hostname;
  } catch {
    throw new Error(`TRIGGER_PUBLIC_API_URL is not a URL: ${base}`);
  }
  if (host.includes('.internal.') || host === 'localhost' || host.startsWith('127.')) {
    throw new Error(
      `TRIGGER_PUBLIC_API_URL must be reachable from GitHub Actions; got ${base}. ` +
        'Set it to your public Trigger.dev URL (https://api.trigger.dev for the cloud).'
    );
  }
  return base;
}

/**
 * Where student CI posts results: hook-station's /autograde endpoint
 * (AUTOGRADE_CALLBACK_URL), which checks the repo's token before starting the
 * ingest task, so workflows carry no Trigger credentials. Null when unset:
 * workflows then post straight to Trigger with a task-scoped token, as before.
 */
export function autogradeCallbackUrl(env: NodeJS.ProcessEnv = process.env): string | null {
  const url = (env.AUTOGRADE_CALLBACK_URL || '').trim();
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`AUTOGRADE_CALLBACK_URL is not a URL: ${url}`);
  }
  if (env.NODE_ENV === 'production' && parsed.protocol !== 'https:') {
    throw new Error(`AUTOGRADE_CALLBACK_URL must be https in production; got ${url}`);
  }
  return url;
}

type GitOrganizationLike = Parameters<typeof getGitProvider>[0];

/** Commit the workflow, turning the App-permission 403 into an actionable error. */
export async function commitWorkflow(
  gitProvider: GitProvider,
  owner: string,
  repo: string,
  yaml: string,
  provider: string = 'GITHUB'
): Promise<void> {
  try {
    await gitProvider.putFile(owner, repo, workflowPath(provider), yaml, COMMIT_MESSAGE);
  } catch (error: unknown) {
    const status = (error as { status?: number })?.status;
    if (status === 403) {
      throw new Error(
        `GitHub refused to write ${WORKFLOW_PATH} to ${owner}/${repo}. The Classmoji app ` +
          `likely needs the "workflows" permission — re-authorize Classmoji for the "${owner}" org.`
      );
    }
    throw error;
  }
}

/** A Trigger token that can only start the ingest task, reusable for a year. */
function mintIngestTriggerToken(): Promise<string> {
  // multipleUse: trigger tokens are one-time-use by default — but this token is
  // committed into the workflow and used on every push, so it must be reusable.
  return auth.createTriggerPublicToken(INGEST_TASK_ID, {
    expirationTime: '1y',
    multipleUse: true,
  });
}

/**
 * Render the workflow (`classroom.yml`, or `.gitlab-ci.yml`) for ONE repo:
 * its callback token is that repo's own (signAutogradeRepoToken), so the
 * student who can read it can't report results for a classmate's repo.
 * Shared by the provision task and repo creation so both emit an identical,
 * current workflow.
 */
export async function buildClassroomWorkflowYaml(
  tests: WorkflowTestInput[],
  classroomSlug: string,
  provider: string = 'GITHUB',
  repoPath: string,
  triggerToken?: string
): Promise<string> {
  const generate = provider === 'GITLAB' ? generateGitlabCi : generateClassroomWorkflow;
  const callback = autogradeCallbackUrl();
  return generate(tests, {
    triggerUrl: callback ?? `${publicTriggerApiBase()}/api/v1/tasks/${INGEST_TASK_ID}/trigger`,
    triggerToken: callback ? null : (triggerToken ?? (await mintIngestTriggerToken())),
    classroomSlug,
    hmacToken: signAutogradeRepoToken(classroomSlug, repoPath),
  });
}

/**
 * Provision the autograding workflow into one repo, if its Repository has tests.
 * Best-effort — never throws, so it can't break the repo-creation flow. Called
 * when a student repo is created so every repo gets the workflow without relying
 * on template inheritance (which would couple repo creation to the App's
 * `workflows` permission via the template clone+push).
 */
export async function provisionAutogradeWorkflowForRepo(params: {
  repositoryId: string;
  repoName: string;
  classroomSlug: string;
  gitOrganization: GitOrganizationLike;
  /** Where the repo lives: the org on Github, the class subgroup on GitLab. */
  repoOwner?: string | null;
}): Promise<void> {
  const login = params.repoOwner || (params.gitOrganization as { login?: string | null }).login;
  if (!login) return;
  const provider = (params.gitOrganization as { provider?: string }).provider ?? 'GITHUB';
  try {
    const tests = await ClassmojiService.autogradingTest.findByRepositoryId(params.repositoryId);
    if (!tests.length) return;
    const yaml = await buildClassroomWorkflowYaml(
      tests as WorkflowTestInput[],
      params.classroomSlug,
      provider,
      `${login}/${params.repoName}`
    );
    const gitProvider = getGitProvider(params.gitOrganization);
    await commitWorkflow(gitProvider, login, params.repoName, yaml, provider);
  } catch (error) {
    logger.error('autograde: failed to provision workflow on new repo', {
      error,
      repoName: params.repoName,
    });
  }
}

interface ProvisionPayload {
  repositoryId: string;
  classroomSlug: string;
}

/**
 * Re-provision the autograding workflow to all EXISTING student repos for a
 * Repository (e.g. after the instructor edits the tests). New repos get the
 * workflow at creation time instead (see `provisionAutogradeWorkflowForRepo`).
 * Keeps the id `dispatch_autograde_workflow` so the webapp Autograde button keeps
 * working.
 */
export const provisionAutogradeWorkflowTask = task({
  id: 'dispatch_autograde_workflow',
  run: async (
    { repositoryId, classroomSlug }: ProvisionPayload,
    { ctx }: { ctx: { run: { tags?: string[] } } }
  ) => {
    const repository = await getPrisma().repository.findUnique({
      where: { id: repositoryId },
      include: {
        classroom: { include: { git_organization: true } },
        autograding_tests: { orderBy: { position: 'asc' } },
      },
    });

    if (!repository) throw new Error(`Repository not found: ${repositoryId}`);
    const gitOrganization = repository.classroom.git_organization;
    const orgLogin = gitOrganization?.login;
    if (!gitOrganization || !orgLogin) {
      throw new Error(`Git organization missing for classroom ${classroomSlug}`);
    }

    const tests = repository.autograding_tests as WorkflowTestInput[];
    // GitLab student projects live in the class subgroup's `projects`.
    const owner = repoNamespace(repository.classroom) || orgLogin;
    const triggerToken = autogradeCallbackUrl() ? undefined : await mintIngestTriggerToken();

    // Fan out to existing student repos. We deliberately do NOT write the
    // workflow to the template repo: that would make every future repo-creation
    // push include a workflow file and couple repo creation to the App's
    // `workflows` permission. New repos are handled at creation time instead.
    const studentRepos = await getPrisma().gitRepo.findMany({
      where: { classroom: { slug: classroomSlug }, repository_id: repositoryId },
      select: { name: true },
    });

    if (studentRepos.length) {
      // One workflow per repo: each carries its own repo's callback token.
      const payloads = await Promise.all(
        studentRepos.map(async repo => ({
          payload: {
            gitOrganization,
            repoName: repo.name,
            owner,
            yaml: await buildClassroomWorkflowYaml(
              tests,
              classroomSlug,
              gitOrganization.provider,
              `${owner}/${repo.name}`,
              triggerToken
            ),
          },
          // The session tag, so the instructor's callout counts each repo.
          options: { concurrencyKey: classroomSlug, tags: ctx.run.tags },
        }))
      );
      await commitAutogradeWorkflowToRepoTask.batchTriggerAndWait(payloads);
    }

    return { testCount: tests.length, repoCount: studentRepos.length };
  },
});

interface CommitToRepoPayload {
  gitOrganization: GitOrganizationLike & { login: string };
  repoName: string;
  yaml: string;
  /** The repo's namespace when it isn't the org itself (a GitLab class subgroup). */
  owner?: string;
}

/** Commit the generated workflow into a single student repo. */
export const commitAutogradeWorkflowToRepoTask = task({
  id: 'gh-commit_autograde_workflow',
  queue: { concurrencyLimit: 6 },
  run: async ({ gitOrganization, repoName, yaml, owner }: CommitToRepoPayload) => {
    const gitProvider = getGitProvider(gitOrganization);
    await commitWorkflow(
      gitProvider,
      owner || gitOrganization.login,
      repoName,
      yaml,
      gitOrganization.provider
    );
    return { repoName };
  },
});

interface IngestPayload {
  classroomSlug: string;
  repo: string; // "owner/name"
  sha: string;
  run_id?: string;
  actor?: string;
  token?: string;
  results?: Record<string, { name?: string; result?: string }>;
}

// The classroom-resources graders set `outputs.result` to a base64-encoded JSON
// ({ version, status: 'pass'|'fail'|'error', tests: [...] }). Decode it for the
// real verdict — the step's `outcome` is always 'success' because the graders
// catch failures internally and exit 0.
function graderPassed(resultBase64?: string): boolean {
  if (!resultBase64) return false;
  try {
    const parsed = JSON.parse(Buffer.from(resultBase64, 'base64').toString('utf8'));
    const status = parsed?.status ?? parsed?.tests?.[0]?.status;
    return status === 'pass';
  } catch {
    return false;
  }
}

/**
 * Receives autograding results from the generated workflow, which triggers this
 * task via Trigger.dev's REST API (so GitHub Actions can reach it without a
 * public webapp URL — in dev it runs on the local worker and writes to the local
 * DB). Advisory CI feedback only — never written to the grade tables.
 */
/**
 * Give every repo in a classroom its own callback token by re-provisioning
 * each repository's workflow (bot commits, which never count as submissions).
 * Once a day per classroom at most, however many old workflows report.
 */
async function reprovisionLegacyClassroom(classroomId: string, classroomSlug: string) {
  const repositories = await getPrisma().repository.findMany({
    where: { classroom_id: classroomId, autograding_tests: { some: {} } },
    select: { id: true },
  });
  const day = new Date().toISOString().slice(0, 10);
  for (const repository of repositories) {
    try {
      await provisionAutogradeWorkflowTask.trigger(
        { repositoryId: repository.id, classroomSlug },
        { idempotencyKey: `autograde-legacy-${repository.id}-${day}` }
      );
    } catch (error: unknown) {
      logger.warn('autograde ingest: could not re-provision a legacy workflow', {
        repositoryId: repository.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  logger.info('autograde ingest: legacy classroom token seen; re-provisioning', {
    classroomSlug,
    repositories: repositories.length,
  });
}

/**
 * One-off, for rollouts: re-provision the autograding workflow of every
 * repository that has tests, so each student repo gets its own callback token
 * (and posts to AUTOGRADE_CALLBACK_URL when set). Idempotent; commits are the
 * Classmoji bot's, which never count as submissions.
 */
export const reprovisionAllAutogradingTask = task({
  id: 'autograde-reprovision-all',
  run: async () => {
    const repositories = await getPrisma().repository.findMany({
      where: { autograding_tests: { some: {} }, classroom: { is_archived: false } },
      select: { id: true, classroom: { select: { slug: true } } },
    });
    for (const repository of repositories) {
      await provisionAutogradeWorkflowTask.trigger(
        { repositoryId: repository.id, classroomSlug: repository.classroom.slug },
        { concurrencyKey: repository.classroom.slug }
      );
    }
    logger.info('autograde: re-provisioning every repository with tests', {
      repositories: repositories.length,
    });
    return { repositories: repositories.length };
  },
});

export const ingestAutogradeResultTask = task({
  id: INGEST_TASK_ID,
  run: async (payload: IngestPayload) => {
    const { classroomSlug, repo, sha, run_id, token, results } = payload;

    // The token must be THIS repo's own. Github repos provisioned before
    // per-repo tokens still carry the old per-classroom one (Gitlab never
    // had it): accepted, but it also re-provisions the whole classroom so
    // every repo gets its own token and the shared one stops mattering.
    const classroom = await getPrisma().classroom.findUnique({
      where: { slug: classroomSlug ?? '' },
      select: { id: true, git_organization: { select: { provider: true } } },
    });
    const ownToken = verifyAutogradeCallbackToken(classroomSlug, token ?? null, { repoPath: repo });
    // Only while AUTOGRADE_LEGACY_TOKENS_UNTIL (an ISO date) is ahead: that
    // token lets anyone who read it report for every repo in the class, so it
    // is a rollout bridge, not a standing exception. Run the
    // `autograde-reprovision-all` task to hand every repo its own token.
    const legacyUntil = Date.parse(process.env.AUTOGRADE_LEGACY_TOKENS_UNTIL ?? '');
    const legacyToken =
      !ownToken &&
      legacyUntil > Date.now() &&
      classroom?.git_organization?.provider === 'GITHUB' &&
      verifyAutogradeCallbackToken(classroomSlug, token ?? null, {
        allowLegacyClassroomToken: true,
      });
    if (!ownToken && !legacyToken) {
      logger.warn('autograde ingest: invalid token', { classroomSlug, repo });
      return { ok: false, reason: 'invalid_token' };
    }
    if (legacyToken && classroom) {
      await reprovisionLegacyClassroom(classroom.id, classroomSlug);
    }
    if (!repo || !sha || !results) {
      return { ok: false, reason: 'missing_fields' };
    }

    const repoName = repo.split('/').pop();
    const gitRepo = await getPrisma().gitRepo.findFirst({
      where: { name: repoName, classroom: { slug: classroomSlug } },
      select: { id: true },
    });
    if (!gitRepo) {
      logger.warn('autograde ingest: repo not found', { repo, classroomSlug });
      return { ok: false, reason: 'repo_not_found' };
    }

    // Decode each grader's result into a pass/fail outcome, kept in the same
    // { name, outcome } shape the result card renders.
    const entries = Object.entries(results);
    const details: Record<string, { name?: string; outcome: 'success' | 'failure' }> = {};
    let passedTests = 0;
    for (const [id, entry] of entries) {
      const passed = graderPassed(entry?.result);
      if (passed) passedTests += 1;
      details[id] = { name: entry?.name, outcome: passed ? 'success' : 'failure' };
    }
    const totalTests = entries.length;
    const conclusion = totalTests > 0 && passedTests === totalTests ? 'success' : 'failure';

    await ClassmojiService.autogradingResult.recordResult({
      gitRepoId: gitRepo.id,
      commitSha: sha,
      runId: run_id ?? null,
      conclusion,
      totalTests,
      passedTests,
      details: details as Parameters<
        typeof ClassmojiService.autogradingResult.recordResult
      >[0]['details'],
    });

    return { ok: true, totalTests, passedTests };
  },
});
