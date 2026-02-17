import { Page, Route } from '@playwright/test';

export interface GitHubMockOptions {
  /** Custom user data to return */
  users?: Record<string, Partial<GitHubUser>>;
  /** Custom organization data */
  organizations?: Record<string, Partial<GitHubOrg>>;
  /** Custom repository data */
  repos?: Record<string, Partial<GitHubRepo>>;
  /** Simulate API errors */
  simulateErrors?: boolean;
}

interface GitHubUser {
  login: string;
  id: number;
  name: string;
  email: string;
  avatar_url: string;
}

interface GitHubOrg {
  login: string;
  id: number;
  name: string;
  description: string;
  default_repository_permission: string;
}

interface GitHubRepo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  owner: { login: string };
}

/**
 * Mock GitHub API responses
 *
 * The webapp uses @octokit/rest which calls api.github.com
 * This intercepts those requests and returns mock data.
 */
export async function mockGitHubAPI(page: Page, options: GitHubMockOptions = {}): Promise<void> {
  const { simulateErrors = false } = options;

  await page.route('**/api.github.com/**', async (route: Route) => {
    const url = route.request().url();
    const method = route.request().method();

    // Simulate errors if requested
    if (simulateErrors) {
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'GitHub API Error' }),
      });
    }

    // Authenticated user endpoint
    if (url.includes('/user') && !url.includes('/users/')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          login: 'prof-classmoji',
          id: 220514774,
          name: 'Professor Classmoji',
          email: 'prof.classmoji@gmail.com',
          avatar_url: 'https://avatars.githubusercontent.com/u/220514774?v=4',
          ...options.users?.['prof-classmoji'],
        }),
      });
    }

    // Organization endpoints
    if (url.match(/\/orgs\/([^/]+)$/)) {
      const orgMatch = url.match(/\/orgs\/([^/]+)$/);
      const orgLogin = orgMatch?.[1] || 'classmoji-development';

      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          login: orgLogin,
          id: 123456,
          description: 'Test organization',
          default_repository_permission: 'none',
          ...options.organizations?.[orgLogin],
        }),
      });
    }

    // Organization members
    if (url.includes('/orgs/') && url.includes('/members')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([
          {
            login: 'prof-classmoji',
            id: 220514774,
            role: 'admin',
          },
        ]),
      });
    }

    // Team sync endpoints
    if (url.includes('/teams')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    }

    // Repository endpoints
    if (url.includes('/repos/')) {
      const repoMatch = url.match(/\/repos\/([^/]+)\/([^/]+)/);
      const repoName = repoMatch?.[2] || 'test-repo';

      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          id: Date.now(),
          name: repoName,
          full_name: `classmoji-development/${repoName}`,
          private: true,
          owner: { login: 'classmoji-development' },
          ...options.repos?.[repoName],
        }),
      });
    }

    // Organization invitations
    if (url.includes('/invitations')) {
      if (method === 'POST') {
        return route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify({ id: Date.now() }),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    }

    // Issues endpoints
    if (url.includes('/issues')) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([]),
      });
    }

    // Default: return empty success
    console.log(`[GitHub Mock] Unhandled request: ${method} ${url}`);
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({}),
    });
  });
}

/**
 * Mock GitHub roster sync operations
 */
export async function mockGitHubRosterSync(page: Page): Promise<void> {
  await page.route('**/api.github.com/orgs/*/memberships/*', async (route) => {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ state: 'active', role: 'member' }),
    });
  });

  await page.route('**/api.github.com/orgs/*/invitations', async (route) => {
    if (route.request().method() === 'POST') {
      return route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ id: Date.now() }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify([]),
    });
  });
}

/**
 * Clear GitHub API mocks
 */
export async function clearGitHubMocks(page: Page): Promise<void> {
  await page.unroute('**/api.github.com/**');
}
