import { App, Octokit } from 'octokit';
import { createAppAuth } from '@octokit/auth-app';
import { createHmac, timingSafeEqual } from 'crypto';
import jwt from 'jsonwebtoken';
import { GitProvider } from './GitProvider.js';

import dotenv from 'dotenv';
dotenv.config();

const privateKey = process.env.GITHUB_PRIVATE_KEY_BASE64
  ? Buffer.from(process.env.GITHUB_PRIVATE_KEY_BASE64, 'base64').toString('utf8')
  : null;

/**
 * Generate a GitHub App JWT for direct API authentication
 * Used for simple installation token requests without Octokit overhead
 * @returns {string} JWT token (valid for 10 minutes)
 */
function generateGitHubJWT() {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iat: now,
    exp: now + 10 * 60, // JWT expires in 10 minutes
    iss: process.env.GITHUB_APP_ID,
  };
  return jwt.sign(payload, privateKey, { algorithm: 'RS256' });
}

/**
 * GitHub adapter - implements GitProvider interface using Octokit.
 * Uses GitHub App installation for organization-level access.
 */
export class GitHubProvider extends GitProvider {
  // Static cache shared across all instances
  static #installationCache = new Map();
  static #CACHE_TTL_MS = 50 * 60 * 1000; // 50 minutes (before 1-hour expiry)

  /**
   * @param {string} installationId - GitHub App installation ID
   * @param {string} [orgLogin] - Organization login (optional, for backward compat)
   */
  constructor(installationId, orgLogin = null) {
    super({ installationId, orgLogin });
    this.installationId = installationId;
    this.orgLogin = orgLogin;
    this._octokit = null;
  }

  /**
   * Get or create a cached Octokit instance for this installation
   * @returns {Promise<Octokit>}
   */
  async #getOctokit() {
    const cacheKey = this.installationId;
    const cached = GitHubProvider.#installationCache.get(cacheKey);

    if (cached && Date.now() < cached.expiresAt) {
      return cached.octokit;
    }

    try {
      const app = new App({
        appId: process.env.GITHUB_APP_ID,
        privateKey: privateKey,
        oauth: {
          clientId: process.env.GITHUB_CLIENT_ID,
          clientSecret: process.env.GITHUB_CLIENT_SECRET,
        },
      });

      const octokit = await app.getInstallationOctokit(this.installationId);

      GitHubProvider.#installationCache.set(cacheKey, {
        octokit,
        expiresAt: Date.now() + GitHubProvider.#CACHE_TTL_MS,
      });

      return octokit;
    } catch (error) {
      console.error(
        `[GitHubProvider] Failed to get installation ${this.installationId}:`,
        error.message
      );
      GitHubProvider.#installationCache.delete(cacheKey);
      throw error;
    }
  }

  // ─── Auth & User ───────────────────────────────────────────────────────────

  /**
   * Get an installation access token
   * @returns {Promise<string>} GitHub access token
   */
  async getAccessToken() {
    const jwtToken = generateGitHubJWT();
    const url = `https://api.github.com/app/installations/${this.installationId}/access_tokens`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwtToken}`,
        Accept: 'application/vnd.github+json',
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to retrieve GitHub installation token (${response.status})`);
    }

    const data = await response.json();
    if (!data.token) {
      throw new Error('Failed to retrieve GitHub installation token');
    }
    return data.token;
  }

  /**
   * Get current authenticated user from a personal access token
   * @param {string} token - Personal access token
   * @returns {Promise<Object>} GitHub user data
   */
  async getCurrentUser(token) {
    const octokit = new Octokit({ auth: token });
    const { data } = await octokit.request('GET /user');
    return data;
  }

  // ─── Repository ────────────────────────────────────────────────────────────

  /**
   * Create a repository in the organization
   * @param {string} org - Organization login
   * @param {string} name - Repository name
   * @param {boolean} isPrivate - Whether repo is private (default: true)
   * @returns {Promise<{id: string, name: string, url: string}>}
   */
  async createRepository(org, name, isPrivate = true) {
    const octokit = await this.#getOctokit();
    const { data } = await octokit.request('POST /orgs/{org}/repos', {
      org,
      name,
      private: isPrivate,
    });
    return { id: String(data.id), name: data.name, url: data.html_url };
  }

  /**
   * Create a repository from a template
   * @param {string} org - Organization login
   * @param {string} name - New repository name
   * @param {string} templateOwner - Template owner
   * @param {string} templateRepo - Template repository name
   * @param {boolean} isPrivate - Whether repo is private (default: true)
   * @returns {Promise<{id: string, name: string, url: string}>}
   */
  async createRepositoryFromTemplate(org, name, templateOwner, templateRepo, isPrivate = true) {
    const octokit = await this.#getOctokit();
    const { data } = await octokit.request('POST /repos/{template_owner}/{template_repo}/generate', {
      template_owner: templateOwner,
      template_repo: templateRepo,
      owner: org,
      name,
      private: isPrivate,
    });
    return { id: String(data.id), name: data.name, url: data.html_url };
  }

  /**
   * Create a public repository (e.g., for GitHub Pages content)
   * @param {string} org - Organization login
   * @param {string} name - Repository name
   * @param {string} description - Repository description
   * @returns {Promise<{id: string, name: string, url: string}>}
   */
  async createPublicRepository(org, name, description = '') {
    const octokit = await this.#getOctokit();
    const { data } = await octokit.request('POST /orgs/{org}/repos', {
      org,
      name,
      description,
      private: false,
      auto_init: true,
    });
    return { id: String(data.id), name: data.name, url: data.html_url };
  }

  /**
   * Get repository details
   * @param {string} org - Organization login
   * @param {string} name - Repository name
   * @returns {Promise<{id: string, name: string, url: string, node_id: string}>}
   */
  async getRepository(org, name) {
    const octokit = await this.#getOctokit();
    const { data } = await octokit.request('GET /repos/{owner}/{repo}', {
      owner: org,
      repo: name,
    });
    return { id: String(data.id), name: data.name, url: data.html_url, node_id: data.node_id };
  }

  /**
   * Check if repository exists
   * @param {string} org - Organization login
   * @param {string} name - Repository name
   * @returns {Promise<boolean>}
   */
  async repositoryExists(org, name) {
    try {
      await this.getRepository(org, name);
      return true;
    } catch (error) {
      if (error.status === 404) return false;
      throw error;
    }
  }

  /**
   * Delete a repository
   * @param {string} org - Organization login
   * @param {string} name - Repository name
   */
  async deleteRepository(org, name) {
    const octokit = await this.#getOctokit();
    await octokit.request('DELETE /repos/{owner}/{repo}', {
      owner: org,
      repo: name,
    });
  }

  // ─── Branches & PRs ────────────────────────────────────────────────────────

  /**
   * Get the latest commit SHA for a branch
   * @param {string} org - Organization login
   * @param {string} repo - Repository name
   * @param {string} branch - Branch name (default: main)
   * @returns {Promise<string>} Commit SHA
   */
  async getLatestCommitSHA(org, repo, branch = 'main') {
    const octokit = await this.#getOctokit();
    const { data } = await octokit.request('GET /repos/{owner}/{repo}/branches/{branch}', {
      owner: org,
      repo,
      branch,
    });
    return data.commit.sha;
  }

  /**
   * Create a new branch
   * @param {string} org - Organization login
   * @param {string} repo - Repository name
   * @param {string} branch - New branch name
   * @param {string} sha - Commit SHA to branch from
   */
  async createBranch(org, repo, branch, sha) {
    const octokit = await this.#getOctokit();
    await octokit.request('POST /repos/{owner}/{repo}/git/refs', {
      owner: org,
      repo,
      ref: `refs/heads/${branch}`,
      sha,
    });
  }

  /**
   * Protect a branch (restrict pushes to app only)
   * @param {string} org - Organization login
   * @param {string} repo - Repository name
   * @param {string} branch - Branch name
   */
  async protectBranch(org, repo, branch) {
    const octokit = await this.#getOctokit();
    await octokit.request('PUT /repos/{owner}/{repo}/branches/{branch}/protection', {
      owner: org,
      repo,
      branch,
      required_status_checks: null,
      enforce_admins: null,
      required_pull_request_reviews: null,
      allow_deletions: false,
      allow_force_pushes: true,
      restrictions: {
        users: [],
        teams: [],
        apps: [process.env.GITHUB_APP_NAME],
      },
    });
  }

  /**
   * Create a pull request
   * @param {string} org - Organization login
   * @param {string} repo - Repository name
   * @param {string} base - Base branch
   * @param {string} head - Head branch
   * @param {string} title - PR title
   * @param {string} body - PR body
   * @returns {Promise<{id: number, number: number, url: string}>}
   */
  async createPullRequest(org, repo, base, head, title, body) {
    const octokit = await this.#getOctokit();
    const { data } = await octokit.request('POST /repos/{owner}/{repo}/pulls', {
      owner: org,
      repo,
      base,
      head,
      title,
      body,
    });
    return { id: data.id, number: data.number, url: data.html_url };
  }

  // ─── Issues ────────────────────────────────────────────────────────────────

  /**
   * Create an issue in a repository
   * @param {string} org - Organization login
   * @param {string} repo - Repository name
   * @param {{title: string, body?: string, description?: string}} issue - Issue details
   * @returns {Promise<{id: string, number: number, url: string}>}
   */
  async createIssue(org, repo, issue) {
    const octokit = await this.#getOctokit();
    const { data } = await octokit.request('POST /repos/{owner}/{repo}/issues', {
      owner: org,
      repo,
      title: issue.title,
      body: issue.body || issue.description || '',
    });
    return { id: String(data.id), number: data.number, url: data.html_url };
  }

  /**
   * Get an issue by number
   * @param {string} org - Organization login
   * @param {string} repo - Repository name
   * @param {number} issueNumber - Issue number
   * @returns {Promise<{id: number, number: number, url: string, state: string}>}
   */
  async getIssue(org, repo, issueNumber) {
    const octokit = await this.#getOctokit();
    const { data } = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
      owner: org,
      repo,
      issue_number: issueNumber,
    });
    return { id: data.id, number: data.number, url: data.html_url, state: data.state };
  }

  /**
   * Add assignees to an issue
   * @param {string} org - Organization login
   * @param {string} repo - Repository name
   * @param {number} issueNum - Issue number
   * @param {string[]} assignees - Array of usernames
   */
  async addIssueAssignees(org, repo, issueNum, assignees) {
    const octokit = await this.#getOctokit();
    await octokit.request('POST /repos/{owner}/{repo}/issues/{issue_number}/assignees', {
      owner: org,
      repo,
      issue_number: issueNum,
      assignees,
    });
  }

  /**
   * Remove assignees from an issue
   * @param {string} org - Organization login
   * @param {string} repo - Repository name
   * @param {number} issueNum - Issue number
   * @param {string[]} assignees - Array of usernames to remove
   */
  async removeIssueAssignees(org, repo, issueNum, assignees) {
    const octokit = await this.#getOctokit();
    await octokit.request('DELETE /repos/{owner}/{repo}/issues/{issue_number}/assignees', {
      owner: org,
      repo,
      issue_number: issueNum,
      assignees,
    });
  }

  // ─── Organization/Group ────────────────────────────────────────────────────

  /**
   * Get organization details
   * @param {string} org - Organization login
   * @returns {Promise<Object>}
   */
  async getOrganization(org) {
    const octokit = await this.#getOctokit();
    const { data } = await octokit.request('GET /orgs/{org}', { org });
    return data;
  }

  /**
   * Get organization members
   * @param {string} org - Organization login
   * @returns {Promise<Object[]>}
   */
  async getOrganizationMembers(org) {
    const octokit = await this.#getOctokit();
    const { data } = await octokit.request('GET /orgs/{org}/members', { org });
    return data;
  }

  /**
   * Get pending organization invitations
   * @param {string} org - Organization login
   * @returns {Promise<Object[]>}
   */
  async getPendingInvitations(org) {
    const octokit = await this.#getOctokit();
    const { data } = await octokit.request('GET /orgs/{org}/invitations', { org });
    return data;
  }

  /**
   * Cancel a pending invitation
   * @param {string} org - Organization login
   * @param {number} invitationId - Invitation ID
   */
  async cancelPendingInvitation(org, invitationId) {
    const octokit = await this.#getOctokit();
    await octokit.request('DELETE /orgs/{org}/invitations/{invitation_id}', {
      org,
      invitation_id: invitationId,
    });
  }

  /**
   * Invite user to organization
   * @param {string} org - Organization login
   * @param {string} userIdOrEmail - User ID (number as string) or email
   * @param {number[]} teamIds - Array of team IDs to add user to
   */
  async inviteToOrganization(org, userIdOrEmail, teamIds) {
    const octokit = await this.#getOctokit();
    const payload = { org };

    if (String(userIdOrEmail).includes('@')) {
      payload.email = userIdOrEmail;
    } else {
      payload.invitee_id = parseInt(String(userIdOrEmail), 10);
    }

    if (teamIds?.length) {
      payload.team_ids = teamIds.map(Number);
    }

    await octokit.request('POST /orgs/{org}/invitations', payload);
  }

  /**
   * Remove user from organization
   * @param {string} org - Organization login
   * @param {string} username - GitHub username
   */
  async removeFromOrganization(org, username) {
    const octokit = await this.#getOctokit();
    await octokit.request('DELETE /orgs/{org}/members/{username}', {
      org,
      username,
    });
  }

  /**
   * Check if user is a member of the organization
   * @param {string} org - Organization login
   * @param {string} username - GitHub username
   * @returns {Promise<boolean>}
   */
  async isUserMemberOfOrganization(org, username) {
    const octokit = await this.#getOctokit();
    try {
      await octokit.request('GET /orgs/{org}/members/{username}', {
        org,
        username,
      });
      return true;
    } catch (error) {
      if (error.status === 404) return false;
      throw error;
    }
  }

  /**
   * Get a user by their login
   * @param {string} username - GitHub username
   * @returns {Promise<Object>}
   */
  async getUserByLogin(username) {
    const octokit = await this.#getOctokit();
    const { data } = await octokit.request('GET /users/{username}', { username });
    return data;
  }

  // ─── Teams ─────────────────────────────────────────────────────────────────

  /**
   * Create a team (idempotent - returns existing team if it already exists)
   * @param {string} org - Organization login
   * @param {string} name - Team name
   * @returns {Promise<{id: number, slug: string, name: string}>}
   */
  async createTeam(org, name) {
    const octokit = await this.#getOctokit();
    try {
      const { data } = await octokit.request('POST /orgs/{org}/teams', {
        org,
        name,
        privacy: 'closed',
      });
      return { id: data.id, slug: data.slug, name: data.name };
    } catch (error) {
      if (error.status === 422) {
        // Team already exists - fetch it
        const slug = name.toLowerCase().replace(/\s+/g, '-');
        return this.getTeam(org, slug);
      }
      throw error;
    }
  }

  /**
   * Get a team by slug
   * @param {string} org - Organization login
   * @param {string} teamSlug - Team slug
   * @returns {Promise<{id: number, slug: string, name: string}>}
   */
  async getTeam(org, teamSlug) {
    const octokit = await this.#getOctokit();
    const { data } = await octokit.request('GET /orgs/{org}/teams/{team_slug}', {
      org,
      team_slug: teamSlug,
    });
    return { id: data.id, slug: data.slug, name: data.name, node_id: data.node_id };
  }

  /**
   * Get all teams in organization
   * @param {string} org - Organization login
   * @returns {Promise<Object[]>}
   */
  async getTeams(org) {
    const octokit = await this.#getOctokit();
    const { data } = await octokit.request('GET /orgs/{org}/teams', { org });
    return data;
  }

  /**
   * Delete a team
   * @param {string} org - Organization login
   * @param {string} teamSlug - Team slug
   */
  async deleteTeam(org, teamSlug) {
    const octokit = await this.#getOctokit();
    await octokit.request('DELETE /orgs/{org}/teams/{team_slug}', {
      org,
      team_slug: teamSlug,
    });
  }

  /**
   * Add a member to a team
   * @param {string} org - Organization login
   * @param {string} teamSlug - Team slug
   * @param {string} username - GitHub username
   */
  async addTeamMember(org, teamSlug, username) {
    const octokit = await this.#getOctokit();
    await octokit.request('PUT /orgs/{org}/teams/{team_slug}/memberships/{username}', {
      org,
      team_slug: teamSlug,
      username,
    });
  }

  /**
   * Remove a member from a team
   * @param {string} org - Organization login
   * @param {string} teamSlug - Team slug
   * @param {string} username - GitHub username
   */
  async removeTeamMember(org, teamSlug, username) {
    const octokit = await this.#getOctokit();
    await octokit.request('DELETE /orgs/{org}/teams/{team_slug}/memberships/{username}', {
      org,
      team_slug: teamSlug,
      username,
    });
  }

  /**
   * Add team permission to repository
   * @param {string} org - Organization login
   * @param {string} repo - Repository name
   * @param {string} teamSlug - Team slug
   * @param {string} permission - Permission level (pull, push, admin, maintain, triage)
   */
  async addTeamToRepo(org, repo, teamSlug, permission) {
    const octokit = await this.#getOctokit();
    await octokit.request('PUT /orgs/{org}/teams/{team_slug}/repos/{owner}/{repo}', {
      org,
      team_slug: teamSlug,
      owner: org,
      repo,
      permission,
    });
  }

  // ─── Collaborators ─────────────────────────────────────────────────────────

  /**
   * Add a collaborator to a repository
   * @param {string} org - Organization login
   * @param {string} repo - Repository name
   * @param {string} username - GitHub username
   * @param {string} permission - Permission level (default: maintain)
   */
  async addCollaborator(org, repo, username, permission = 'maintain') {
    const octokit = await this.#getOctokit();
    await octokit.request('PUT /repos/{owner}/{repo}/collaborators/{username}', {
      owner: org,
      repo,
      username,
      permission,
    });
  }

  // ─── GitHub Pages ──────────────────────────────────────────────────────────

  /**
   * Enable GitHub Pages for a repository
   * @param {string} org - Organization login
   * @param {string} repo - Repository name
   * @param {string} branch - Branch to serve pages from (default: main)
   * @returns {Promise<{alreadyEnabled?: boolean}>}
   */
  async enableGitHubPages(org, repo, branch = 'main') {
    const octokit = await this.#getOctokit();
    try {
      await octokit.request('GET /repos/{owner}/{repo}/pages', {
        owner: org,
        repo,
      });
      return { alreadyEnabled: true };
    } catch (error) {
      if (error.status !== 404) {
        throw error;
      }
    }

    await octokit.request('POST /repos/{owner}/{repo}/pages', {
      owner: org,
      repo,
      source: {
        branch,
        path: '/',
      },
    });
    return { alreadyEnabled: false };
  }

  // ─── Webhooks ──────────────────────────────────────────────────────────────

  /**
   * Verify a GitHub webhook signature
   * @param {string} payload - Raw request body
   * @param {string} signature - X-Hub-Signature-256 header value
   * @returns {boolean}
   */
  verifyWebhook(payload, signature) {
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    const expected = 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex');
    try {
      return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
    } catch {
      return false;
    }
  }

  // ─── App Management ────────────────────────────────────────────────────────

  /**
   * Remove the GitHub App installation
   */
  async removeInstallation() {
    const app = new App({
      appId: process.env.GITHUB_APP_ID,
      privateKey: privateKey,
    });

    await app.octokit.request('DELETE /app/installations/{installation_id}', {
      installation_id: this.installationId,
    });
  }

  // ─── Projects (GitHub Projects V2) ────────────────────────────────────────

  /**
   * List organization projects (ProjectsV2)
   * @param {string} org - Organization login
   * @returns {Promise<Object[]>} Array of projects with node_id, title, number
   */
  async listOrganizationProjects(org) {
    const octokit = await this.#getOctokit();
    const result = await octokit.graphql(`
      query($org: String!) {
        organization(login: $org) {
          projectsV2(first: 50, orderBy: {field: TITLE, direction: ASC}) {
            nodes {
              id
              title
              number
              url
            }
          }
        }
      }
    `, { org });
    return result.organization.projectsV2.nodes;
  }

  /**
   * Copy a project from a template
   * @param {string} templateProjectId - Source project node_id to copy
   * @param {string} ownerId - Owner node_id (organization)
   * @param {string} title - Title for the new project
   * @returns {Promise<{id: string, number: number, url: string}>}
   */
  async copyProjectFromTemplate(templateProjectId, ownerId, title) {
    const octokit = await this.#getOctokit();
    const result = await octokit.graphql(`
      mutation($projectId: ID!, $ownerId: ID!, $title: String!) {
        copyProjectV2(input: {projectId: $projectId, ownerId: $ownerId, title: $title, includeDraftIssues: false}) {
          projectV2 {
            id
            number
            url
          }
        }
      }
    `, {
      projectId: templateProjectId,
      ownerId,
      title,
    });
    return result.copyProjectV2.projectV2;
  }

  /**
   * Get organization node_id for project creation
   * @param {string} org - Organization login
   * @returns {Promise<string>} Organization node_id
   */
  async getOrganizationNodeId(org) {
    const octokit = await this.#getOctokit();
    const { data } = await octokit.request('GET /orgs/{org}', { org });
    return data.node_id;
  }

  /**
   * Add an issue to a project and set it to the first status column
   * @param {string} projectId - Project node_id
   * @param {string} contentId - Issue/PR node_id
   * @returns {Promise<{itemId: string}>}
   */
  async addIssueToProject(projectId, contentId) {
    const octokit = await this.#getOctokit();

    // Add item to project
    const addResult = await octokit.graphql(`
      mutation($projectId: ID!, $contentId: ID!) {
        addProjectV2ItemById(input: {projectId: $projectId, contentId: $contentId}) {
          item {
            id
          }
        }
      }
    `, { projectId, contentId });

    const itemId = addResult.addProjectV2ItemById.item.id;

    // Get project's Status field and first option
    const statusField = await this.getProjectStatusField(projectId);

    if (statusField && statusField.firstOptionId) {
      // Set item to first status column
      await this.setProjectItemStatus(projectId, itemId, statusField.fieldId, statusField.firstOptionId);
    }

    return { itemId };
  }

  /**
   * Get the Status field and its first option from a project
   * @param {string} projectId - Project node_id
   * @returns {Promise<{fieldId: string, firstOptionId: string} | null>}
   */
  async getProjectStatusField(projectId) {
    const octokit = await this.#getOctokit();

    const result = await octokit.graphql(`
      query($projectId: ID!) {
        node(id: $projectId) {
          ... on ProjectV2 {
            field(name: "Status") {
              ... on ProjectV2SingleSelectField {
                id
                options {
                  id
                  name
                }
              }
            }
          }
        }
      }
    `, { projectId });

    const field = result.node?.field;
    if (!field || !field.options || field.options.length === 0) {
      return null;
    }

    return {
      fieldId: field.id,
      firstOptionId: field.options[0].id,
    };
  }

  /**
   * Set a project item's status field
   * @param {string} projectId - Project node_id
   * @param {string} itemId - Project item node_id
   * @param {string} fieldId - Status field node_id
   * @param {string} optionId - Status option node_id
   * @returns {Promise<void>}
   */
  async setProjectItemStatus(projectId, itemId, fieldId, optionId) {
    const octokit = await this.#getOctokit();

    await octokit.graphql(`
      mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
        updateProjectV2ItemFieldValue(input: {
          projectId: $projectId,
          itemId: $itemId,
          fieldId: $fieldId,
          value: { singleSelectOptionId: $optionId }
        }) {
          projectV2Item {
            id
          }
        }
      }
    `, { projectId, itemId, fieldId, optionId });
  }

  /**
   * Add a team as collaborator to a GitHub Project V2
   * @param {string} projectId - Project node_id
   * @param {string} orgLogin - Organization login
   * @param {string} teamSlug - Team slug
   * @param {string} role - ADMIN, WRITER, or READER (default: WRITER)
   * @returns {Promise<void>}
   */
  async addTeamToProject(projectId, orgLogin, teamSlug, role = 'WRITER') {
    const octokit = await this.#getOctokit();

    // Get team node_id
    const team = await this.getTeam(orgLogin, teamSlug);

    // Add team to project using updateProjectV2Collaborators mutation
    await octokit.graphql(`
      mutation($projectId: ID!, $teamId: ID!, $role: ProjectV2Roles!) {
        updateProjectV2Collaborators(input: {
          projectId: $projectId
          collaborators: [{ teamId: $teamId, role: $role }]
        }) {
          collaborators { totalCount }
        }
      }
    `, { projectId, teamId: team.node_id, role });
  }

  /**
   * Link a repository to a GitHub Project V2
   * @param {string} projectId - Project node_id
   * @param {string} repoNodeId - Repository node_id
   * @returns {Promise<void>}
   */
  async linkRepoToProject(projectId, repoNodeId) {
    const octokit = await this.#getOctokit();
    await octokit.graphql(`
      mutation($projectId: ID!, $repositoryId: ID!) {
        linkProjectV2ToRepository(input: {
          projectId: $projectId
          repositoryId: $repositoryId
        }) {
          repository { id }
        }
      }
    `, { projectId, repositoryId: repoNodeId });
  }

  /**
   * Update a GitHub Project V2 title
   * @param {string} projectId - Project node_id
   * @param {string} title - New project title
   * @returns {Promise<void>}
   */
  async updateProjectTitle(projectId, title) {
    const octokit = await this.#getOctokit();
    await octokit.graphql(`
      mutation($projectId: ID!, $title: String!) {
        updateProjectV2(input: {
          projectId: $projectId
          title: $title
        }) {
          projectV2 { id title }
        }
      }
    `, { projectId, title });
  }

  /**
   * Get issue node_id from issue number
   * @param {string} org - Organization login
   * @param {string} repo - Repository name
   * @param {number} issueNumber - Issue number
   * @returns {Promise<string>} Issue node_id
   */
  async getIssueNodeId(org, repo, issueNumber) {
    const octokit = await this.#getOctokit();
    const { data } = await octokit.request('GET /repos/{owner}/{repo}/issues/{issue_number}', {
      owner: org,
      repo,
      issue_number: issueNumber,
    });
    return data.node_id;
  }

  // ─── Utilities ─────────────────────────────────────────────────────────────

  /**
   * Get clone URL with authentication token
   * @param {string} org - Organization login
   * @param {string} repo - Repository name
   * @param {string} token - Access token
   * @returns {string}
   */
  getCloneUrl(org, repo, token) {
    return `https://x-access-token:${token}@github.com/${org}/${repo}.git`;
  }

  /**
   * Clear the installation cache (useful for testing or cache invalidation)
   */
  static clearCache() {
    GitHubProvider.#installationCache.clear();
  }

  // ─── Low-level Access (for advanced use cases) ────────────────────────────

  /**
   * Get the raw Octokit instance for direct API access
   * Use this when you need to make API calls not covered by this provider
   * @returns {Promise<Octokit>}
   */
  async getOctokit() {
    return this.#getOctokit();
  }

  /**
   * Get an Octokit instance authenticated with a user's personal access token
   * @param {string} token - Personal access token
   * @returns {Octokit}
   */
  static getUserOctokit(token) {
    return new Octokit({ auth: token });
  }

  /**
   * Get the GitHub App auth instance for OAuth flows
   * @returns {Object} createAppAuth instance
   */
  static getAppAuth() {
    return createAppAuth({
      appId: process.env.GITHUB_APP_ID,
      privateKey: privateKey,
      clientId: process.env.GITHUB_CLIENT_ID,
      clientSecret: process.env.GITHUB_CLIENT_SECRET,
    });
  }

  /**
   * Update organization settings
   * @param {string} org - Organization login
   * @param {Object} data - Settings to update
   * @returns {Promise<Object>}
   */
  async updateOrganization(org, data) {
    const octokit = await this.#getOctokit();
    const { data: result } = await octokit.request('PATCH /orgs/{org}', { org, ...data });
    return result;
  }
}
