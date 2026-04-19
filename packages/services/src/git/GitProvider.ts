/* eslint-disable @typescript-eslint/no-unused-vars */
import type { Octokit } from 'octokit';
/**
 * Abstract base class for git providers.
 * Each method throws an error if not implemented by subclass.
 */
export interface GitRepository {
  id: string;
  name: string;
  url: string;
  node_id?: string;
}

export interface GitIssue {
  id: string;
  number: number;
  url: string;
}

export interface GitOrganizationDetails {
  login?: string | null;
  node_id?: string;
  plan?: {
    name?: string | null;
  } | null;
}

export interface GitProject {
  id: string;
  number: number;
  url: string;
}

export class GitProvider {
  credentials: unknown;

  constructor(credentials: unknown) {
    if (new.target === GitProvider) {
      throw new Error('GitProvider is abstract and cannot be instantiated directly');
    }
    this.credentials = credentials;
  }

  // ─── Auth & User ───────────────────────────────────────────────────────────
  async getAccessToken(orgId?: string): Promise<string> {
    throw new Error('getAccessToken() must be implemented by subclass');
  }

  async getCurrentUser(token: string): Promise<unknown> {
    throw new Error('getCurrentUser() must be implemented by subclass');
  }

  // ─── Repository ────────────────────────────────────────────────────────────
  async createRepository(org: string, name: string, isPrivate = true): Promise<GitRepository> {
    throw new Error('createRepository() must be implemented by subclass');
  }

  async getRepository(org: string, name: string): Promise<GitRepository> {
    throw new Error('getRepository() must be implemented by subclass');
  }

  async repositoryExists(org: string, name: string): Promise<boolean> {
    throw new Error('repositoryExists() must be implemented by subclass');
  }

  async deleteRepository(org: string, name: string): Promise<void> {
    throw new Error('deleteRepository() must be implemented by subclass');
  }

  // ─── Branches & PRs ────────────────────────────────────────────────────────
  async getLatestCommitSHA(org: string, repo: string, branch?: string): Promise<string> {
    throw new Error('getLatestCommitSHA() must be implemented by subclass');
  }

  /**
   * List commits for a repository, optionally filtered by branch and a since timestamp.
   * Returns a normalized CommitRecord[] with per-commit additions/deletions.
   * @param {string} org - Organization login
   * @param {string} repo - Repository name
   * @param {{since?: string, branch?: string}} [opts] - Optional filters
   * @returns {Promise<CommitRecord[]>}
   */
  async listCommits(
    _org: string,
    _repo: string,
    _opts?: { since?: string; branch?: string }
  ): Promise<import('../classmoji/repoAnalytics.types.ts').CommitRecord[]> {
    throw new Error('listCommits() must be implemented by subclass');
  }

  async createBranch(org: string, repo: string, branch: string, sha: string): Promise<void> {
    throw new Error('createBranch() must be implemented by subclass');
  }

  async protectBranch(org: string, repo: string, branch: string): Promise<void> {
    throw new Error('protectBranch() must be implemented by subclass');
  }

  async createPullRequest(
    org: string,
    repo: string,
    base: string,
    head: string,
    title: string,
    body: string
  ): Promise<unknown> {
    throw new Error('createPullRequest() must be implemented by subclass');
  }

  // ─── Issues ────────────────────────────────────────────────────────────────
  async createIssue(
    org: string,
    repo: string,
    issue: { title: string; body?: string; description?: string }
  ): Promise<GitIssue> {
    throw new Error('createIssue() must be implemented by subclass');
  }

  async addIssueAssignees(
    org: string,
    repo: string,
    issueNum: number,
    assignees: string[]
  ): Promise<void> {
    throw new Error('addIssueAssignees() must be implemented by subclass');
  }

  async removeIssueAssignees(
    org: string,
    repo: string,
    issueNum: number,
    assignees: string[]
  ): Promise<void> {
    throw new Error('removeIssueAssignees() must be implemented by subclass');
  }

  // ─── Organization/Group ────────────────────────────────────────────────────
  async getOrganization(org: string): Promise<GitOrganizationDetails> {
    throw new Error('getOrganization() must be implemented by subclass');
  }

  async getOrganizationMembers(org: string): Promise<unknown[]> {
    throw new Error('getOrganizationMembers() must be implemented by subclass');
  }

  async inviteToOrganization(
    org: string,
    userIdOrEmail: string,
    teamIds?: number[]
  ): Promise<void> {
    throw new Error('inviteToOrganization() must be implemented by subclass');
  }

  async removeFromOrganization(org: string, username: string): Promise<void> {
    throw new Error('removeFromOrganization() must be implemented by subclass');
  }

  // ─── Teams ─────────────────────────────────────────────────────────────────
  async createTeam(org: string, name: string): Promise<{ id: number; slug: string; name: string }> {
    throw new Error('createTeam() must be implemented by subclass');
  }

  async getTeam(
    org: string,
    teamSlug: string
  ): Promise<{ id: number; slug: string; name: string }> {
    throw new Error('getTeam() must be implemented by subclass');
  }

  async addTeamMember(org: string, teamSlug: string, username: string): Promise<void> {
    throw new Error('addTeamMember() must be implemented by subclass');
  }

  async removeTeamMember(org: string, teamSlug: string, username: string): Promise<void> {
    throw new Error('removeTeamMember() must be implemented by subclass');
  }

  async addTeamToRepo(
    org: string,
    repo: string,
    teamSlug: string,
    permission: string
  ): Promise<void> {
    throw new Error('addTeamToRepo() must be implemented by subclass');
  }

  // ─── Collaborators ─────────────────────────────────────────────────────────
  async addCollaborator(
    org: string,
    repo: string,
    username: string,
    permission = 'maintain'
  ): Promise<void> {
    throw new Error('addCollaborator() must be implemented by subclass');
  }

  // ─── Webhooks ──────────────────────────────────────────────────────────────
  verifyWebhook(payload: string, signature: string): boolean {
    throw new Error('verifyWebhook() must be implemented by subclass');
  }

  // ─── Projects ──────────────────────────────────────────────────────────────
  async listOrganizationProjects(org: string): Promise<GitProject[]> {
    throw new Error('listOrganizationProjects() must be implemented by subclass');
  }

  async copyProjectFromTemplate(
    templateProjectId: string,
    ownerId: string,
    title: string
  ): Promise<GitProject> {
    throw new Error('copyProjectFromTemplate() must be implemented by subclass');
  }

  async getOrganizationNodeId(org: string): Promise<string> {
    throw new Error('getOrganizationNodeId() must be implemented by subclass');
  }

  async addIssueToProject(projectId: string, contentId: string): Promise<{ itemId: string }> {
    throw new Error('addIssueToProject() must be implemented by subclass');
  }

  async addTeamToProject(
    projectId: string,
    orgLogin: string,
    teamSlug: string,
    role = 'WRITER'
  ): Promise<void> {
    throw new Error('addTeamToProject() must be implemented by subclass');
  }

  async linkRepoToProject(projectId: string, repoNodeId: string): Promise<void> {
    throw new Error('linkRepoToProject() must be implemented by subclass');
  }

  async getIssueNodeId(org: string, repo: string, issueNumber: number): Promise<string> {
    throw new Error('getIssueNodeId() must be implemented by subclass');
  }

  async getOctokit(): Promise<Octokit> {
    throw new Error('getOctokit() must be implemented by subclass');
  }

  // ─── Utilities ─────────────────────────────────────────────────────────────
  getCloneUrl(org: string, repo: string, token: string): string {
    throw new Error('getCloneUrl() must be implemented by subclass');
  }
}
