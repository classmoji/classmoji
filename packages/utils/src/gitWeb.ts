/**
 * Browser links to a classroom's repos, for either git provider.
 *
 * Github repos live directly in the org (`github.com/<org>/<repo>`). A GitLab
 * classroom's student projects live in its class subgroup
 * (`gitlab.com/<group>/<class>/<repo>`), and GitLab puts repo pages under `/-/`.
 * Client-safe: no env reads.
 */

export interface GitWebContext {
  provider?: string | null;
  /** The org (Github) or group full path (GitLab). */
  login?: string | null;
  /** GitLab: the class subgroup full path. Null/absent on Github. */
  git_namespace?: string | null;
}

/** A classroom-shaped object: `{ git_namespace, git_organization: { provider, login } }`. */
export interface ClassroomLike {
  git_namespace?: string | null;
  git_organization?: { provider?: string | null; login?: string | null } | null;
}

const GITLAB_WEB = 'https://gitlab.com';
const GITHUB_WEB = 'https://github.com';

export function gitContextFor(classroom: ClassroomLike | null | undefined): GitWebContext {
  return {
    provider: classroom?.git_organization?.provider ?? 'GITHUB',
    login: classroom?.git_organization?.login ?? null,
    git_namespace: classroom?.git_namespace ?? null,
  };
}

/**
 * The words each provider uses for the same things. Copy that names a repo,
 * pull request or organization reads from here so Gitlab classrooms say
 * project, merge request and group.
 */
export function gitTerms(isGitLab: boolean) {
  return isGitLab
    ? {
        platform: 'Gitlab',
        repo: 'project',
        repos: 'projects',
        Repo: 'Project',
        Repos: 'Projects',
        pr: 'merge request',
        prs: 'merge requests',
        PR: 'Merge request',
        prShort: 'MR',
        org: 'group',
        Org: 'Group',
        changesTab: 'Changes',
      }
    : {
        platform: 'Github',
        repo: 'repository',
        repos: 'repositories',
        Repo: 'Repository',
        Repos: 'Repositories',
        pr: 'pull request',
        prs: 'pull requests',
        PR: 'Pull request',
        prShort: 'PR',
        org: 'organization',
        Org: 'Organization',
        changesTab: 'Files changed',
      };
}

export type GitTerms = ReturnType<typeof gitTerms>;

export function gitWeb(ctx: GitWebContext) {
  const isGitLab = ctx.provider === 'GITLAB';
  const host = isGitLab ? GITLAB_WEB : GITHUB_WEB;
  const owner = (isGitLab && ctx.git_namespace) || ctx.login || '';
  const repo = (name: string) => `${host}/${owner}/${name}`;

  return {
    isGitLab,
    /** "Gitlab" / "Github", for link labels. */
    label: isGitLab ? 'Gitlab' : 'Github',
    /** Provider vocabulary for UI copy (see gitTerms). */
    terms: gitTerms(isGitLab),
    repo,
    /** A repo given as a full path (`owner/name`), e.g. a template. */
    fullPath: (path: string) => `${host}/${path}`,
    /**
     * A repository's template: a full path, or a bare name in the org/group
     * (the same rule `resolveTemplateRef` applies when repos are created).
     */
    template: (template: string) =>
      template.includes('/') ? `${host}/${template}` : `${host}/${ctx.login}/${template}`,
    commits: (name: string) => (isGitLab ? `${repo(name)}/-/commits` : `${repo(name)}/commits`),
    commit: (name: string, sha: string) =>
      isGitLab ? `${repo(name)}/-/commit/${sha}` : `${repo(name)}/commit/${sha}`,
    issue: (name: string, number: number) =>
      isGitLab ? `${repo(name)}/-/issues/${number}` : `${repo(name)}/issues/${number}`,
    /** Github Projects board. GitLab has none: null. */
    project: (projectNumber: number) =>
      isGitLab ? null : `${GITHUB_WEB}/orgs/${ctx.login}/projects/${projectNumber}`,
    /** Github Actions run. GitLab classrooms have no autograding: null. */
    actionsRun: (name: string, runId: number | string) =>
      isGitLab ? null : `${repo(name)}/actions/runs/${runId}`,
    /** Where all of the classroom's repos are listed. */
    reposIndex: () =>
      isGitLab ? `${host}/${owner}` : `${GITHUB_WEB}/orgs/${ctx.login}/repositories`,
  };
}
