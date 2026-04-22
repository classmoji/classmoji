import { useLoaderData } from 'react-router';
import {
  GitHubStatsPanel,
  type GitHubStatsSnapshot,
} from '~/components/features/analytics';

/**
 * Test-only smoke route for <GitHubStatsPanel>.
 *
 * Only responds in development / test (NODE_ENV !== 'production').
 * Not mounted on any real page — exists so Playwright can exercise
 * the component without needing a full submission + data pipeline.
 */

type LoaderData = {
  snapshot: GitHubStatsSnapshot;
  deadline: string;
};

export const loader = async (): Promise<LoaderData> => {
  if (process.env.NODE_ENV === 'production') {
    throw new Response('Not found', { status: 404 });
  }

  const snapshot: GitHubStatsSnapshot = {
    total_commits: 42,
    total_additions: 1337,
    total_deletions: 256,
    first_commit_at: '2026-04-01T12:00:00.000Z',
    last_commit_at: '2026-04-17T18:00:00.000Z',
    fetched_at: '2026-04-18T09:00:00.000Z',
    stale: false,
    error: null,
    commits: [
      {
        sha: 'a1',
        author_login: 'alice',
        author_email: null,
        author_user_id: null,
        ts: '2026-04-02T10:00:00.000Z',
        message: 'init',
        additions: 100,
        deletions: 0,
        parents: [],
      },
      {
        sha: 'a2',
        author_login: 'alice',
        author_email: null,
        author_user_id: null,
        ts: '2026-04-02T14:00:00.000Z',
        message: 'more',
        additions: 50,
        deletions: 5,
        parents: ['a1'],
      },
      {
        sha: 'b1',
        author_login: 'bob',
        author_email: null,
        author_user_id: null,
        ts: '2026-04-05T08:00:00.000Z',
        message: 'feat',
        additions: 200,
        deletions: 40,
        parents: ['a2'],
      },
      {
        sha: 'b2',
        author_login: 'bob',
        author_email: null,
        author_user_id: null,
        ts: '2026-04-10T11:00:00.000Z',
        message: 'fix',
        additions: 20,
        deletions: 10,
        parents: ['b1'],
      },
      {
        sha: 'c1',
        author_login: 'carol',
        author_email: null,
        author_user_id: null,
        ts: '2026-04-15T16:00:00.000Z',
        message: 'polish',
        additions: 967,
        deletions: 201,
        parents: ['b2'],
      },
    ],
    contributors: [
      { login: 'alice', user_id: 'user_alice', commits: 2, additions: 150, deletions: 5 },
      { login: 'bob', user_id: null, commits: 2, additions: 220, deletions: 50 },
      { login: 'carol', user_id: null, commits: 1, additions: 967, deletions: 201 },
    ],
    languages: {
      TypeScript: 60000,
      JavaScript: 20000,
      CSS: 5000,
    },
    pr_summary: { open: 3, merged: 12, closed: 1 },
  };

  return {
    snapshot,
    deadline: '2026-04-12T23:59:00.000Z',
  };
};

export default function TestGitHubStatsPanelRoute() {
  const { snapshot, deadline } = useLoaderData() as LoaderData;
  return (
    <div className="p-6 bg-white dark:bg-gray-950 min-h-screen">
      <GitHubStatsPanel snapshot={snapshot} deadline={deadline} />
    </div>
  );
}
