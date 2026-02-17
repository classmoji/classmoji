import { GitProvider } from './GitProvider.js';

/**
 * GitLab adapter - implements GitProvider interface.
 * Uses GitLab Group for organization-level access.
 *
 * Terminology mapping:
 * - GitHub Organization → GitLab Group
 * - GitHub Repository → GitLab Project
 * - GitHub Team → GitLab Subgroup (or Group members with roles)
 */
export class GitLabProvider extends GitProvider {
  /**
   * @param {string} groupId - GitLab Group ID
   * @param {string} [groupPath] - Group path/slug (optional)
   */
  constructor(groupId, groupPath = null) {
    super({ groupId, groupPath });
    this.groupId = groupId;
    this.groupPath = groupPath;
    this._client = null;
  }

  // ─── Auth & User ───────────────────────────────────────────────────────────

  /**
   * Get an access token for GitLab API
   * @returns {Promise<string>} GitLab access token
   */
  async getAccessToken() {
    // TODO: Implement GitLab OAuth token retrieval
    throw new Error('GitLabProvider.getAccessToken() not implemented');
  }

  /**
   * Get current authenticated user from a personal access token
   * @param {string} token - Personal access token
   * @returns {Promise<Object>} GitLab user data
   */
  async getCurrentUser(token) {
    // TODO: GET /api/v4/user
    throw new Error('GitLabProvider.getCurrentUser() not implemented');
  }

  // ─── Repository (Project) ─────────────────────────────────────────────────

  /**
   * Create a project in the group
   * @param {string} group - Group path
   * @param {string} name - Project name
   * @param {boolean} isPrivate - Whether project is private (default: true)
   * @returns {Promise<{id: string, name: string, url: string}>}
   */
  async createRepository(group, name, isPrivate = true) {
    // TODO: POST /api/v4/projects with namespace_id
    throw new Error('GitLabProvider.createRepository() not implemented');
  }

  /**
   * Create a project from a template
   * @param {string} group - Group path
   * @param {string} name - New project name
   * @param {string} templateOwner - Template namespace
   * @param {string} templateRepo - Template project name
   * @param {boolean} isPrivate - Whether project is private (default: true)
   * @returns {Promise<{id: string, name: string, url: string}>}
   */
  async createRepositoryFromTemplate(group, name, templateOwner, templateRepo, isPrivate = true) {
    // TODO: POST /api/v4/projects with import_url or fork
    throw new Error('GitLabProvider.createRepositoryFromTemplate() not implemented');
  }

  /**
   * Create a public project
   * @param {string} group - Group path
   * @param {string} name - Project name
   * @param {string} description - Project description
   * @returns {Promise<{id: string, name: string, url: string}>}
   */
  async createPublicRepository(group, name, description = '') {
    // TODO: POST /api/v4/projects with visibility: 'public'
    throw new Error('GitLabProvider.createPublicRepository() not implemented');
  }

  /**
   * Check if project exists
   * @param {string} group - Group path
   * @param {string} name - Project name
   * @returns {Promise<boolean>}
   */
  async repositoryExists(group, name) {
    // TODO: GET /api/v4/projects/:id (URL-encoded group/name)
    throw new Error('GitLabProvider.repositoryExists() not implemented');
  }

  /**
   * Delete a project
   * @param {string} group - Group path
   * @param {string} name - Project name
   */
  async deleteRepository(group, name) {
    // TODO: DELETE /api/v4/projects/:id
    throw new Error('GitLabProvider.deleteRepository() not implemented');
  }

  // ─── Branches & Merge Requests ────────────────────────────────────────────

  /**
   * Get the latest commit SHA for a branch
   * @param {string} group - Group path
   * @param {string} project - Project name
   * @param {string} branch - Branch name (default: main)
   * @returns {Promise<string>} Commit SHA
   */
  async getLatestCommitSHA(group, project, branch = 'main') {
    // TODO: GET /api/v4/projects/:id/repository/branches/:branch
    throw new Error('GitLabProvider.getLatestCommitSHA() not implemented');
  }

  /**
   * Create a new branch
   * @param {string} group - Group path
   * @param {string} project - Project name
   * @param {string} branch - New branch name
   * @param {string} sha - Commit SHA to branch from
   */
  async createBranch(group, project, branch, sha) {
    // TODO: POST /api/v4/projects/:id/repository/branches
    throw new Error('GitLabProvider.createBranch() not implemented');
  }

  /**
   * Protect a branch
   * @param {string} group - Group path
   * @param {string} project - Project name
   * @param {string} branch - Branch name
   */
  async protectBranch(group, project, branch) {
    // TODO: POST /api/v4/projects/:id/protected_branches
    throw new Error('GitLabProvider.protectBranch() not implemented');
  }

  /**
   * Create a merge request (equivalent to GitHub PR)
   * @param {string} group - Group path
   * @param {string} project - Project name
   * @param {string} targetBranch - Target branch
   * @param {string} sourceBranch - Source branch
   * @param {string} title - MR title
   * @param {string} description - MR description
   * @returns {Promise<{id: number, iid: number, url: string}>}
   */
  async createPullRequest(group, project, targetBranch, sourceBranch, title, description) {
    // TODO: POST /api/v4/projects/:id/merge_requests
    throw new Error('GitLabProvider.createPullRequest() not implemented');
  }

  // ─── Issues ───────────────────────────────────────────────────────────────

  /**
   * Create an issue in a project
   * @param {string} group - Group path
   * @param {string} project - Project name
   * @param {{title: string, body?: string}} issue - Issue details
   * @returns {Promise<{id: string, iid: number, url: string}>}
   */
  async createIssue(group, project, issue) {
    // TODO: POST /api/v4/projects/:id/issues
    throw new Error('GitLabProvider.createIssue() not implemented');
  }

  /**
   * Add assignees to an issue
   * @param {string} group - Group path
   * @param {string} project - Project name
   * @param {number} issueIid - Issue IID (internal ID)
   * @param {string[]} assignees - Array of usernames
   */
  async addIssueAssignees(group, project, issueIid, assignees) {
    // TODO: PUT /api/v4/projects/:id/issues/:issue_iid with assignee_ids
    throw new Error('GitLabProvider.addIssueAssignees() not implemented');
  }

  /**
   * Remove assignees from an issue
   * @param {string} group - Group path
   * @param {string} project - Project name
   * @param {number} issueIid - Issue IID
   * @param {string[]} assignees - Array of usernames to remove
   */
  async removeIssueAssignees(group, project, issueIid, assignees) {
    // TODO: PUT /api/v4/projects/:id/issues/:issue_iid with updated assignee_ids
    throw new Error('GitLabProvider.removeIssueAssignees() not implemented');
  }

  // ─── Group (Organization equivalent) ──────────────────────────────────────

  /**
   * Get group details
   * @param {string} group - Group path
   * @returns {Promise<Object>}
   */
  async getOrganization(group) {
    // TODO: GET /api/v4/groups/:id
    throw new Error('GitLabProvider.getOrganization() not implemented');
  }

  /**
   * Get group members
   * @param {string} group - Group path
   * @returns {Promise<Object[]>}
   */
  async getOrganizationMembers(group) {
    // TODO: GET /api/v4/groups/:id/members
    throw new Error('GitLabProvider.getOrganizationMembers() not implemented');
  }

  /**
   * Get pending group invitations
   * @param {string} group - Group path
   * @returns {Promise<Object[]>}
   */
  async getPendingInvitations(group) {
    // TODO: GET /api/v4/groups/:id/invitations
    throw new Error('GitLabProvider.getPendingInvitations() not implemented');
  }

  /**
   * Cancel a pending invitation
   * @param {string} group - Group path
   * @param {string} email - Invited user's email
   */
  async cancelPendingInvitation(group, email) {
    // TODO: DELETE /api/v4/groups/:id/invitations/:email
    throw new Error('GitLabProvider.cancelPendingInvitation() not implemented');
  }

  /**
   * Invite user to group
   * @param {string} group - Group path
   * @param {string} userIdOrEmail - User ID or email
   * @param {number[]} subgroupIds - Array of subgroup IDs (optional)
   */
  async inviteToOrganization(group, userIdOrEmail, subgroupIds) {
    // TODO: POST /api/v4/groups/:id/invitations or /members
    throw new Error('GitLabProvider.inviteToOrganization() not implemented');
  }

  /**
   * Remove user from group
   * @param {string} group - Group path
   * @param {string} username - GitLab username
   */
  async removeFromOrganization(group, username) {
    // TODO: DELETE /api/v4/groups/:id/members/:user_id
    throw new Error('GitLabProvider.removeFromOrganization() not implemented');
  }

  /**
   * Check if user is a member of the group
   * @param {string} group - Group path
   * @param {string} username - GitLab username
   * @returns {Promise<boolean>}
   */
  async isUserMemberOfOrganization(group, username) {
    // TODO: GET /api/v4/groups/:id/members/:user_id
    throw new Error('GitLabProvider.isUserMemberOfOrganization() not implemented');
  }

  /**
   * Get a user by their username
   * @param {string} username - GitLab username
   * @returns {Promise<Object>}
   */
  async getUserByLogin(username) {
    // TODO: GET /api/v4/users?username=:username
    throw new Error('GitLabProvider.getUserByLogin() not implemented');
  }

  // ─── Subgroups (Team equivalent) ──────────────────────────────────────────

  /**
   * Create a subgroup (equivalent to GitHub team)
   * @param {string} group - Parent group path
   * @param {string} name - Subgroup name
   * @returns {Promise<{id: number, path: string, name: string}>}
   */
  async createTeam(group, name) {
    // TODO: POST /api/v4/groups with parent_id
    throw new Error('GitLabProvider.createTeam() not implemented');
  }

  /**
   * Get a subgroup by path
   * @param {string} group - Parent group path
   * @param {string} subgroupPath - Subgroup path
   * @returns {Promise<{id: number, path: string, name: string}>}
   */
  async getTeam(group, subgroupPath) {
    // TODO: GET /api/v4/groups/:id (with full path)
    throw new Error('GitLabProvider.getTeam() not implemented');
  }

  /**
   * Get all subgroups in group
   * @param {string} group - Group path
   * @returns {Promise<Object[]>}
   */
  async getTeams(group) {
    // TODO: GET /api/v4/groups/:id/subgroups
    throw new Error('GitLabProvider.getTeams() not implemented');
  }

  /**
   * Delete a subgroup
   * @param {string} group - Parent group path
   * @param {string} subgroupPath - Subgroup path
   */
  async deleteTeam(group, subgroupPath) {
    // TODO: DELETE /api/v4/groups/:id
    throw new Error('GitLabProvider.deleteTeam() not implemented');
  }

  /**
   * Add a member to a subgroup
   * @param {string} group - Parent group path
   * @param {string} subgroupPath - Subgroup path
   * @param {string} username - GitLab username
   */
  async addTeamMember(group, subgroupPath, username) {
    // TODO: POST /api/v4/groups/:id/members
    throw new Error('GitLabProvider.addTeamMember() not implemented');
  }

  /**
   * Remove a member from a subgroup
   * @param {string} group - Parent group path
   * @param {string} subgroupPath - Subgroup path
   * @param {string} username - GitLab username
   */
  async removeTeamMember(group, subgroupPath, username) {
    // TODO: DELETE /api/v4/groups/:id/members/:user_id
    throw new Error('GitLabProvider.removeTeamMember() not implemented');
  }

  /**
   * Share project with a group (team permission to repo)
   * @param {string} group - Group path
   * @param {string} project - Project name
   * @param {string} shareWithGroup - Group to share with
   * @param {string} permission - Access level (guest, reporter, developer, maintainer)
   */
  async addTeamToRepo(group, project, shareWithGroup, permission) {
    // TODO: POST /api/v4/projects/:id/share
    throw new Error('GitLabProvider.addTeamToRepo() not implemented');
  }

  // ─── Collaborators ────────────────────────────────────────────────────────

  /**
   * Add a member to a project
   * @param {string} group - Group path
   * @param {string} project - Project name
   * @param {string} username - GitLab username
   * @param {string} permission - Access level (default: maintainer)
   */
  async addCollaborator(group, project, username, permission = 'maintainer') {
    // TODO: POST /api/v4/projects/:id/members
    throw new Error('GitLabProvider.addCollaborator() not implemented');
  }

  // ─── GitLab Pages ─────────────────────────────────────────────────────────

  /**
   * GitLab Pages is enabled via .gitlab-ci.yml, not API
   * @param {string} group - Group path
   * @param {string} project - Project name
   * @param {string} branch - Branch to serve pages from
   * @returns {Promise<{alreadyEnabled?: boolean}>}
   */
  async enableGitHubPages(group, project, branch = 'main') {
    // GitLab Pages requires CI/CD configuration, not API call
    // TODO: Check if pages job exists in .gitlab-ci.yml
    throw new Error('GitLabProvider.enableGitHubPages() not implemented - GitLab uses CI/CD for Pages');
  }

  // ─── Webhooks ─────────────────────────────────────────────────────────────

  /**
   * Verify a GitLab webhook signature
   * @param {string} payload - Raw request body
   * @param {string} token - X-Gitlab-Token header value
   * @returns {boolean}
   */
  verifyWebhook(payload, token) {
    // TODO: Compare token with stored webhook secret
    throw new Error('GitLabProvider.verifyWebhook() not implemented');
  }

  // ─── Utilities ────────────────────────────────────────────────────────────

  /**
   * Get clone URL with authentication token
   * @param {string} group - Group path
   * @param {string} project - Project name
   * @param {string} token - Access token
   * @returns {string}
   */
  getCloneUrl(group, project, token) {
    // GitLab clone URL format
    return `https://oauth2:${token}@gitlab.com/${group}/${project}.git`;
  }
}
