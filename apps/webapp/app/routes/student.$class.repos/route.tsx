import dayjs from 'dayjs';
import { IconExternalLink } from '@tabler/icons-react';
import { IconGithub } from '@classmoji/ui-components';

import type { Route } from './+types/route';
import { ClassmojiService } from '@classmoji/services';
import { requireStudentAccess } from '~/utils/helpers';
import { gitContextFor, gitWeb } from '~/utils/gitWeb';
import { GitlabLogo } from '~/components/ui/display/GitlabLogo';

/**
 * The student's own repositories: theirs and their teams'. A repository can be
 * handed out without an assignment, and then this is the only place in
 * Classmoji that shows it.
 */
export const loader = async ({ request, params }: Route.LoaderArgs) => {
  const { userId, classroom } = await requireStudentAccess(request, params.class!, {
    resourceType: 'REPOSITORIES',
    action: 'view_student_repositories',
  });

  const web = gitWeb(gitContextFor(classroom));
  const repos = await ClassmojiService.gitRepo.findForStudent(classroom.id, userId);

  return {
    platform: web.label,
    isGitLab: web.isGitLab,
    repos: repos.map(repo => ({
      id: repo.id,
      name: repo.name,
      url: web.repo(repo.name),
      title: repo.repository.title,
      lastPushAt: repo.last_push_at?.toISOString() ?? null,
    })),
  };
};

const StudentRepositories = ({ loaderData }: Route.ComponentProps) => {
  const { repos, platform, isGitLab } = loaderData;

  return (
    <div className="min-h-full relative">
      <div className="flex items-center justify-between gap-3 mt-2 mb-4">
        <h1 className="text-base font-semibold text-gray-600 dark:text-gray-400">Repositories</h1>
      </div>

      <div className="rounded-2xl bg-white dark:bg-neutral-900 ring-1 ring-stone-200 dark:ring-neutral-800 p-5 sm:p-6 min-h-[calc(100vh-10rem)]">
        {repos.length === 0 ? (
          <div className="text-center py-12 text-gray-500">
            <div className="font-medium">No repositories yet</div>
            <div className="text-sm">
              Repositories your instructor creates for you or your team show up here.
            </div>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-ink-3 border-b border-line">
                <th className="py-2 pr-4 font-semibold">Repository</th>
                <th className="py-2 pr-4 font-semibold">Your copy</th>
                <th className="py-2 font-semibold hidden md:table-cell">Last push</th>
              </tr>
            </thead>
            <tbody>
              {repos.map(repo => (
                <tr key={repo.id} className="border-b border-line/60 last:border-0">
                  <td className="py-3 pr-4 font-medium text-ink-0">{repo.title}</td>
                  <td className="py-3 pr-4">
                    <a
                      href={repo.url}
                      target="_blank"
                      rel="noreferrer"
                      title={`Open on ${platform}`}
                      className="inline-flex items-center gap-1.5 max-w-[18rem] text-gray-700! dark:text-gray-200! hover:text-ink-0! hover:underline underline-offset-2"
                    >
                      <span className="shrink-0 inline-flex text-gray-900 dark:text-gray-100">
                        {isGitLab ? <GitlabLogo size={14} /> : <IconGithub size={14} />}
                      </span>
                      <span className="truncate">{repo.name}</span>
                      <IconExternalLink
                        size={13}
                        className="shrink-0 text-gray-400 dark:text-gray-500"
                      />
                    </a>
                  </td>
                  <td className="py-3 text-gray-600 dark:text-gray-300 hidden md:table-cell">
                    {repo.lastPushAt ? dayjs(repo.lastPushAt).fromNow() : 'No push yet'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
};

export default StudentRepositories;
