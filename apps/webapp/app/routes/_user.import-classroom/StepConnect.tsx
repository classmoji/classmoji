import { useEffect } from 'react';
import { useFetcher } from 'react-router';
import { Alert, Button, Spin } from 'antd';
import { IconBrandGithub } from '@tabler/icons-react';

import { authClient } from '@classmoji/auth/client';
import type { ListedClassroom } from './utils';

const EXPORT_WALKTHROUGH_URL = 'https://classmoji.io/docs/instructors/import-github-classroom';

interface ListResponse {
  classrooms?: ListedClassroom[];
  reauth?: boolean;
  error?: string;
}

interface Props {
  /** Called once the classroom list loads (possibly empty). */
  onLoaded: (classrooms: ListedClassroom[]) => void;
  /** Whether a list has already been loaded (so we can show a re-fetch hint). */
  hasLoaded: boolean;
}

/**
 * Step 1 — pull the classrooms the signed-in teacher administers straight from
 * GitHub Classroom. No file to export or upload; the import reads everything
 * live via the GitHub API.
 */
export default function StepConnect({ onLoaded, hasLoaded }: Props) {
  const fetcher = useFetcher<ListResponse>();
  const loading = fetcher.state !== 'idle';
  const data = fetcher.data;

  // Lift the loaded list up to the wizard once it arrives.
  useEffect(() => {
    if (data?.classrooms && !data.reauth && !data.error) {
      onLoaded(data.classrooms);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const fetchClassrooms = () => fetcher.load('/api/github-classrooms');

  const isEmpty = Boolean(data?.classrooms && data.classrooms.length === 0 && !data.reauth);

  return (
    <div>
      <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
        Import your classrooms, assignments, rosters, and grades straight from GitHub Classroom. We
        read everything live using your GitHub sign-in. You must be an administrator of the
        classrooms you want to import.{' '}
        <a
          href={EXPORT_WALKTHROUGH_URL}
          target="_blank"
          rel="noreferrer"
          className="text-blue-600 dark:text-blue-400 underline underline-offset-2"
        >
          Learn more
        </a>
        .
      </p>

      <Button
        type="primary"
        icon={loading ? <Spin size="small" /> : <IconBrandGithub size={16} />}
        disabled={loading}
        onClick={fetchClassrooms}
      >
        {loading
          ? 'Loading your classrooms…'
          : hasLoaded
            ? 'Refresh classrooms'
            : 'Fetch my GitHub Classrooms'}
      </Button>

      {data?.reauth && (
        <Alert
          className="mt-4"
          type="warning"
          showIcon
          message="GitHub sign-in needed"
          description={
            <span>
              We couldn&apos;t reach GitHub with your current session. Please{' '}
              <Button
                type="link"
                size="small"
                className="!p-0 !h-auto underline underline-offset-2"
                onClick={() =>
                  authClient.signIn.social({ provider: 'github', callbackURL: '/import-classroom' })
                }
              >
                sign in with GitHub again
              </Button>{' '}
              and retry.
            </span>
          }
        />
      )}

      {data?.error && (
        <Alert
          className="mt-4"
          type="error"
          showIcon
          message="Could not load classrooms"
          description={data.error}
        />
      )}

      {isEmpty && (
        <Alert
          className="mt-4"
          type="info"
          showIcon
          message="No classrooms found"
          description="We didn't find any GitHub Classrooms you administer. Make sure you're an admin of the classroom's organization, then try again."
        />
      )}
    </div>
  );
}
