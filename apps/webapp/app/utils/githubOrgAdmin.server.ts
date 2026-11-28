/**
 * Whether the signed-in user administers a Github organization, asked of
 * Github with the user's own token. "New classroom" and the Github Classroom
 * import both decide with these queries: one organization by its login, or
 * every organization the user belongs to (each with its id).
 */

/** How long one check may take before it counts as Github not answering. */
export const GITHUB_ORG_CHECK_TIMEOUT_MS = 10_000;

const ORGANIZATION_ADMIN_QUERY = `
  query($login: String!) {
    organization(login: $login) {
      login
      databaseId
      viewerCanAdminister
    }
  }
`;

const VIEWER_ORGANIZATIONS_QUERY = `
  query($after: String) {
    viewer {
      organizations(first: 100, after: $after) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          login
          databaseId
          viewerCanAdminister
          avatarUrl
        }
      }
    }
  }
`;

/** At most this many pages of 100 organizations are read for one user. */
export const MAX_VIEWER_ORGANIZATION_PAGES = 10;

export interface GithubOrganizationAdmin {
  /** The login Github has for the organization now. */
  login: string;
  /** Github's numeric id for the organization (null when Github did not give one). */
  databaseId: number | null;
  /** The token's user can administer the organization (an owner). */
  viewerCanAdminister: boolean;
}

/** The part of an Octokit this needs. */
export interface GraphqlClient {
  graphql: <T>(query: string, parameters?: Record<string, unknown>) => Promise<T>;
}

/** Github did not answer within the time allowed. */
export class GithubOrgCheckTimeoutError extends Error {
  constructor() {
    super('Github did not answer in time.');
    this.name = 'GithubOrgCheckTimeoutError';
  }
}

/**
 * Runs `run` with a signal that aborts after `timeoutMs`, and stops waiting
 * then with `GithubOrgCheckTimeoutError`. The race also ends the wait when a
 * retry or a throttle inside the client does not look at the signal.
 */
async function withTimeout<T>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new GithubOrgCheckTimeoutError());
    }, timeoutMs);
  });
  try {
    return await Promise.race([run(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

const databaseIdOf = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) ? value : null;

/**
 * Github's answer for the organization named `login`, or null when Github
 * reports none, or reports one without its login (an answer that verifies
 * nothing). Throws what Octokit throws (401, GraphQL errors such as
 * NOT_FOUND or FORBIDDEN) and `GithubOrgCheckTimeoutError` after `timeoutMs`.
 */
export async function readOrganizationAdmin(
  octokit: GraphqlClient,
  login: string,
  { timeoutMs = GITHUB_ORG_CHECK_TIMEOUT_MS }: { timeoutMs?: number } = {}
): Promise<GithubOrganizationAdmin | null> {
  const { organization } = await withTimeout(timeoutMs, signal =>
    octokit.graphql<{
      organization: {
        login?: unknown;
        databaseId?: unknown;
        viewerCanAdminister?: unknown;
      } | null;
    }>(ORGANIZATION_ADMIN_QUERY, { login, request: { signal } })
  );
  if (!organization || typeof organization.login !== 'string') return null;
  return {
    login: organization.login,
    databaseId: databaseIdOf(organization.databaseId),
    viewerCanAdminister: organization.viewerCanAdminister === true,
  };
}

export interface GithubViewerOrganization extends GithubOrganizationAdmin {
  avatarUrl: string | null;
}

interface ViewerOrganizationsConnection {
  pageInfo?: { hasNextPage?: unknown; endCursor?: unknown } | null;
  nodes?: unknown[] | null;
}

interface ViewerOrganizationsPage {
  viewer?: { organizations?: ViewerOrganizationsConnection | null } | null;
}

/**
 * Every organization the token's user belongs to, as Github lists them, read
 * page by page (at most `MAX_VIEWER_ORGANIZATION_PAGES`) within one
 * `timeoutMs`. A page Github answers with errors beside its data still gives
 * the organizations it lists (an empty entry is passed over); a page without
 * data throws what Octokit throws, and the wait ends with
 * `GithubOrgCheckTimeoutError`.
 */
export async function readViewerOrganizations(
  octokit: GraphqlClient,
  { timeoutMs = GITHUB_ORG_CHECK_TIMEOUT_MS }: { timeoutMs?: number } = {}
): Promise<GithubViewerOrganization[]> {
  return withTimeout(timeoutMs, async signal => {
    const organizations: GithubViewerOrganization[] = [];
    let after: string | null = null;
    for (let page = 0; page < MAX_VIEWER_ORGANIZATION_PAGES && !signal.aborted; page++) {
      let data: ViewerOrganizationsPage | undefined;
      try {
        data = await octokit.graphql<ViewerOrganizationsPage>(VIEWER_ORGANIZATIONS_QUERY, {
          after,
          request: { signal },
        });
      } catch (error: unknown) {
        const partial = (error as { data?: ViewerOrganizationsPage } | null)?.data;
        if (!partial?.viewer?.organizations) throw error;
        data = partial;
      }
      const connection: ViewerOrganizationsConnection | null | undefined =
        data?.viewer?.organizations;
      for (const node of connection?.nodes ?? []) {
        const org = node as {
          login?: unknown;
          databaseId?: unknown;
          viewerCanAdminister?: unknown;
          avatarUrl?: unknown;
        } | null;
        if (!org || typeof org.login !== 'string') continue;
        organizations.push({
          login: org.login,
          databaseId: databaseIdOf(org.databaseId),
          viewerCanAdminister: org.viewerCanAdminister === true,
          avatarUrl: typeof org.avatarUrl === 'string' ? org.avatarUrl : null,
        });
      }
      const cursor: unknown = connection?.pageInfo?.endCursor;
      if (connection?.pageInfo?.hasNextPage !== true || typeof cursor !== 'string') break;
      after = cursor;
    }
    return organizations;
  });
}
