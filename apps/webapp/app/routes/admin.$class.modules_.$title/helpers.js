import { ClassmojiService } from '@classmoji/services';
import { getGitProvider } from '@classmoji/services';
import { tasks, auth } from '@trigger.dev/sdk';
import { nanoid } from 'nanoid';

export const calculateContributions = async (module, classroomSlug) => {
  const sessionId = nanoid();

  const repoNames = (await ClassmojiService.repository.findByModule(classroomSlug, module.id)).map(
    repo => repo.name
  );
  const classroom = await ClassmojiService.classroom.findBySlug(classroomSlug);
  const gitProvider = getGitProvider(classroom.git_organization);
  const githubAccessToken = await gitProvider.getAccessToken();

  const data = repoNames.map(repo => {
    return {
      payload: {
        classroomSlug,
        repoName: repo,
        accessToken: githubAccessToken,
      },
      options: { tags: [`session_${sessionId}`] },
    };
  });

  const accessToken = await auth.createPublicToken({
    scopes: {
      read: {
        tags: [`session_${sessionId}`],
      },
    },
  });

  await tasks.batchTrigger('calculate_repo_contributions', data);

  return {
    triggerSession: {
      accessToken,
      id: sessionId,
      numRepos: repoNames.length,
    },
  };
};
