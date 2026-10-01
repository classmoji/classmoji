/**
 * Browser links to a classroom's repos, for either git provider.
 *
 * Github repos live directly in the org (`github.com/<org>/<repo>`). A GitLab
 * classroom's student projects live in its class subgroup's `projects`
 * subgroup (`<gitlab host>/<group>/<class>/projects/<repo>`), and GitLab puts repo pages under
 * `/-/`. The GitLab host is the org's `base_url` (a self-managed instance), or
 * gitlab.com. Client-safe: no env reads.
 */

import { GITLAB_COM } from './gitlabInstance.ts';
import { GITLAB_PROJECTS_SUBGROUP } from './repoNames.ts';

export interface GitWebContext {
  provider?: string | null;
  /** The org (Github) or group full path (GitLab). */
  login?: string | null;
  /** GitLab: the class subgroup full path. Null/absent on Github. */
  git_namespace?: string | null;
  /** GitLab: the instance's host when self-managed. Null/absent means gitlab.com. */
  base_url?: string | null;
}

/** A classroom-shaped object: `{ git_namespace, git_organization: { provider, login } }`. */
export interface ClassroomLike {
  git_namespace?: string | null;
  git_organization?: {
    provider?: string | null;
    login?: string | null;
    base_url?: string | null;
  } | null;
}

const GITHUB_WEB = 'https://github.com';

export function gitContextFor(classroom: ClassroomLike | null | undefined): GitWebContext {
  return {
    provider: classroom?.git_organization?.provider ?? 'GITHUB',
    login: classroom?.git_organization?.login ?? null,
    git_namespace: classroom?.git_namespace ?? null,
    base_url: classroom?.git_organization?.base_url ?? null,
  };
}

/**
 * The words copy uses for each provider. Classmoji's own vocabulary is
 * Github's on both: repository, pull request, issue. Only what names a real
 * place in Gitlab's interface differs: the platform, the group a class lives
 * in, and the tab that shows a change's diff.
 */
export function gitTerms(isGitLab: boolean) {
  return isGitLab
    ? {
        platform: 'Gitlab',
        repo: 'repository',
        repos: 'repositories',
        Repo: 'Repository',
        Repos: 'Repositories',
        pr: 'pull request',
        prs: 'pull requests',
        PR: 'Pull request',
        prShort: 'PR',
        org: 'group',
        Org: 'Group',
        changesTab: 'Changes',
        issue: 'issue',
        issues: 'issues',
        Issue: 'Issue',
        anIssue: 'an issue',
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
        issue: 'issue',
        issues: 'issues',
        Issue: 'Issue',
        anIssue: 'an issue',
      };
}

export type GitTerms = ReturnType<typeof gitTerms>;

export function gitWeb(ctx: GitWebContext) {
  const isGitLab = ctx.provider === 'GITLAB';
  const host = isGitLab ? (ctx.base_url || GITLAB_COM).replace(/\/+$/, '') : GITHUB_WEB;
  // Gitlab: student and team projects sit in the class subgroup's `projects`
  // subgroup, the content project at the class subgroup's root.
  const classOwner = (isGitLab && ctx.git_namespace) || ctx.login || '';
  const owner =
    isGitLab && ctx.git_namespace
      ? `${ctx.git_namespace}/${GITLAB_PROJECTS_SUBGROUP}`
      : ctx.login || '';
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
    /** The autograding run: a Github Actions run, or a GitLab CI pipeline. */
    actionsRun: (name: string, runId: number | string) =>
      isGitLab ? `${repo(name)}/-/pipelines/${runId}` : `${repo(name)}/actions/runs/${runId}`,
    /**
     * The classroom's content repo (pages and slides): in the org on Github,
     * at the class subgroup's root on Gitlab.
     */
    contentRepo: (name: string) => `${host}/${classOwner}/${name}`,
    /** A branch comparison in the content repo (preview branches hold slashes). */
    contentCompare: (name: string, base: string, head: string) =>
      `${host}/${classOwner}/${name}${isGitLab ? '/-' : ''}/compare/${base}...${encodeURIComponent(head)}`,
    /** A file in the content repo at `branch`. */
    contentFile: (name: string, branch: string, path: string) =>
      `${host}/${classOwner}/${name}${isGitLab ? '/-' : ''}/blob/${branch}/${path}`,
    /** Where all of the classroom's repos are listed. */
    reposIndex: () =>
      isGitLab ? `${host}/${owner}` : `${GITHUB_WEB}/orgs/${ctx.login}/repositories`,
  };
}
