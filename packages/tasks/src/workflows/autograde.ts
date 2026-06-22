import { task, logger, auth } from '@trigger.dev/sdk';
import getPrisma from '@classmoji/database';
import {
  ClassmojiService,
  getGitProvider,
  generateClassroomWorkflow,
  signAutogradeCallbackToken,
  verifyAutogradeCallbackToken,
  type GitProvider,
  type WorkflowTestInput,
} from '@classmoji/services';

const WORKFLOW_PATH = '.github/workflows/classroom.yml';
const COMMIT_MESSAGE = 'Add/update Classmoji autograding workflow';

// Results are reported by triggering this task via Trigger.dev's public REST
// API (reachable from GitHub Actions; routes to the dev/deployed worker).
const INGEST_TASK_ID = 'ingest_autograde_result';
const TRIGGER_API_BASE = process.env.TRIGGER_API_URL || 'https://api.trigger.dev';

type GitOrganizationLike = Parameters<typeof getGitProvider>[0];

/** Commit the workflow, turning the App-permission 403 into an actionable error. */
export async function commitWorkflow(
  gitProvider: GitProvider,
  owner: string,
  repo: string,
  yaml: string
): Promise<void> {
  try {
    await gitProvider.putFile(owner, repo, WORKFLOW_PATH, yaml, COMMIT_MESSAGE);
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

/**
 * Mint a task-scoped Trigger token + per-classroom HMAC and render the
 * `classroom.yml` for a repository's tests. Shared by the provision task and
 * repo creation so both emit an identical, current workflow.
 */
export async function buildClassroomWorkflowYaml(
  tests: WorkflowTestInput[],
  classroomSlug: string
): Promise<string> {
  // multipleUse: trigger tokens are one-time-use by default — but this token is
  // committed into the workflow and used on every push, so it must be reusable.
  const triggerToken = await auth.createTriggerPublicToken(INGEST_TASK_ID, {
    expirationTime: '1y',
    multipleUse: true,
  });
  return generateClassroomWorkflow(tests, {
    triggerUrl: `${TRIGGER_API_BASE}/api/v1/tasks/${INGEST_TASK_ID}/trigger`,
    triggerToken,
    classroomSlug,
    hmacToken: signAutogradeCallbackToken(classroomSlug),
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
}): Promise<void> {
  const login = (params.gitOrganization as { login?: string | null }).login;
  if (!login) return;
  try {
    const tests = await ClassmojiService.autogradingTest.findByRepositoryId(params.repositoryId);
    if (!tests.length) return;
    const yaml = await buildClassroomWorkflowYaml(
      tests as WorkflowTestInput[],
      params.classroomSlug
    );
    const gitProvider = getGitProvider(params.gitOrganization);
    await commitWorkflow(gitProvider, login, params.repoName, yaml);
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
  run: async ({ repositoryId, classroomSlug }: ProvisionPayload) => {
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
    const yaml = await buildClassroomWorkflowYaml(tests, classroomSlug);

    // Fan out to existing student repos. We deliberately do NOT write the
    // workflow to the template repo: that would make every future repo-creation
    // push include a workflow file and couple repo creation to the App's
    // `workflows` permission. New repos are handled at creation time instead.
    const studentRepos = await getPrisma().gitRepo.findMany({
      where: { classroom: { slug: classroomSlug }, repository_id: repositoryId },
      select: { name: true },
    });

    if (studentRepos.length) {
      await commitAutogradeWorkflowToRepoTask.batchTriggerAndWait(
        studentRepos.map(repo => ({
          payload: { gitOrganization, repoName: repo.name, yaml },
          options: { concurrencyKey: classroomSlug },
        }))
      );
    }

    return { testCount: tests.length, repoCount: studentRepos.length };
  },
});

interface CommitToRepoPayload {
  gitOrganization: GitOrganizationLike & { login: string };
  repoName: string;
  yaml: string;
}

/** Commit the generated workflow into a single student repo. */
export const commitAutogradeWorkflowToRepoTask = task({
  id: 'gh-commit_autograde_workflow',
  queue: { concurrencyLimit: 6 },
  run: async ({ gitOrganization, repoName, yaml }: CommitToRepoPayload) => {
    const gitProvider = getGitProvider(gitOrganization);
    await commitWorkflow(gitProvider, gitOrganization.login, repoName, yaml);
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
export const ingestAutogradeResultTask = task({
  id: INGEST_TASK_ID,
  run: async (payload: IngestPayload) => {
    const { classroomSlug, repo, sha, run_id, token, results } = payload;

    if (!verifyAutogradeCallbackToken(classroomSlug, token ?? null)) {
      logger.warn('autograde ingest: invalid token', { classroomSlug, repo });
      return { ok: false, reason: 'invalid_token' };
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
