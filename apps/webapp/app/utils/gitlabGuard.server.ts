/**
 * Features a GitLab classroom doesn't have yet. Each guarded action answers
 * with this instead of reaching a Github-only code path and failing midway.
 */
export const GITLAB_UNSUPPORTED = 'Not available for Gitlab classrooms yet.';

export const isGitLabClassroom = (classroom: {
  git_organization?: { provider?: string | null } | null;
}) => classroom.git_organization?.provider === 'GITLAB';
