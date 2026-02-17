/**
 * Abstract base class for git providers.
 * Each method throws an error if not implemented by subclass.
 */
export class GitProvider {
  constructor(credentials) {
    if (new.target === GitProvider) {
      throw new Error('GitProvider is abstract and cannot be instantiated directly');
    }
    this.credentials = credentials;
  }

  // ─── Auth & User ───────────────────────────────────────────────────────────
  async getAccessToken(orgId) {
    throw new Error('getAccessToken() must be implemented by subclass');
  }

  async getCurrentUser(token) {
    throw new Error('getCurrentUser() must be implemented by subclass');
  }

  // ─── Repository ────────────────────────────────────────────────────────────
  async createRepository(org, name, isPrivate = true) {
    throw new Error('createRepository() must be implemented by subclass');
  }

  async getRepository(org, name) {
    throw new Error('getRepository() must be implemented by subclass');
  }

  async repositoryExists(org, name) {
    throw new Error('repositoryExists() must be implemented by subclass');
  }

  async deleteRepository(org, name) {
    throw new Error('deleteRepository() must be implemented by subclass');
  }

  // ─── Branches & PRs ────────────────────────────────────────────────────────
  async getLatestCommitSHA(org, repo, branch) {
    throw new Error('getLatestCommitSHA() must be implemented by subclass');
  }

  async createBranch(org, repo, branch, sha) {
    throw new Error('createBranch() must be implemented by subclass');
  }

  async protectBranch(org, repo, branch) {
    throw new Error('protectBranch() must be implemented by subclass');
  }

  async createPullRequest(org, repo, base, head, title, body) {
    throw new Error('createPullRequest() must be implemented by subclass');
  }

  // ─── Issues ────────────────────────────────────────────────────────────────
  async createIssue(org, repo, issue) {
    throw new Error('createIssue() must be implemented by subclass');
  }

  async addIssueAssignees(org, repo, issueNum, assignees) {
    throw new Error('addIssueAssignees() must be implemented by subclass');
  }

  async removeIssueAssignees(org, repo, issueNum, assignees) {
    throw new Error('removeIssueAssignees() must be implemented by subclass');
  }

  // ─── Organization/Group ────────────────────────────────────────────────────
  async getOrganization(org) {
    throw new Error('getOrganization() must be implemented by subclass');
  }

  async getOrganizationMembers(org) {
    throw new Error('getOrganizationMembers() must be implemented by subclass');
  }

  async inviteToOrganization(org, userIdOrEmail, teamIds) {
    throw new Error('inviteToOrganization() must be implemented by subclass');
  }

  async removeFromOrganization(org, username) {
    throw new Error('removeFromOrganization() must be implemented by subclass');
  }

  // ─── Teams ─────────────────────────────────────────────────────────────────
  async createTeam(org, name) {
    throw new Error('createTeam() must be implemented by subclass');
  }

  async getTeam(org, teamSlug) {
    throw new Error('getTeam() must be implemented by subclass');
  }

  async addTeamMember(org, teamSlug, username) {
    throw new Error('addTeamMember() must be implemented by subclass');
  }

  async removeTeamMember(org, teamSlug, username) {
    throw new Error('removeTeamMember() must be implemented by subclass');
  }

  async addTeamToRepo(org, repo, teamSlug, permission) {
    throw new Error('addTeamToRepo() must be implemented by subclass');
  }

  // ─── Collaborators ─────────────────────────────────────────────────────────
  async addCollaborator(org, repo, username, permission = 'maintain') {
    throw new Error('addCollaborator() must be implemented by subclass');
  }

  // ─── Webhooks ──────────────────────────────────────────────────────────────
  async verifyWebhook(payload, signature) {
    throw new Error('verifyWebhook() must be implemented by subclass');
  }

  // ─── Utilities ─────────────────────────────────────────────────────────────
  getCloneUrl(org, repo, token) {
    throw new Error('getCloneUrl() must be implemented by subclass');
  }
}
