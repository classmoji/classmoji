import { GitProvider } from './GitProvider.js';
import { GitHubProvider } from './GitHubProvider.js';
import { GitLabProvider } from './GitLabProvider.js';
// Future: import { GiteaProvider } from './GiteaProvider.js';

/**
 * Factory function - returns the appropriate provider adapter for the git organization.
 *
 * @param {Object} gitOrganization - The GitOrganization record from database
 * @param {string} gitOrganization.provider - Git provider type (GITHUB, GITLAB, etc.)
 * @param {string} gitOrganization.github_installation_id - GitHub App installation ID
 * @param {string} [gitOrganization.access_token] - Access token (for GitLab/Gitea/Bitbucket)
 * @param {string} [gitOrganization.base_url] - Base URL for self-hosted providers
 * @param {string} [gitOrganization.login] - Organization login (optional)
 * @returns {GitProvider} - A concrete provider instance
 */
export function getGitProvider(gitOrganization) {
  const { provider, github_installation_id, access_token, base_url, login } = gitOrganization;

  switch (provider) {
    case 'GITHUB':
      if (!github_installation_id) {
        throw new Error('GitHub provider requires github_installation_id');
      }
      return new GitHubProvider(github_installation_id, login);

    case 'GITLAB':
      // GitLab uses group_id instead of installation_id
      // access_token is required for API access
      if (!access_token) {
        throw new Error('GitLab provider requires access_token');
      }
      return new GitLabProvider(gitOrganization.gitlab_group_id, login);

    // Future implementations:

    // case 'GITEA':
    //   if (!access_token) {
    //     throw new Error('Gitea provider requires access_token');
    //   }
    //   return new GiteaProvider(access_token, base_url);

    // case 'BITBUCKET':
    //   if (!access_token) {
    //     throw new Error('Bitbucket provider requires access_token');
    //   }
    //   return new BitbucketProvider(access_token);

    default:
      throw new Error(`Provider ${provider} not yet implemented`);
  }
}

/**
 * Get a GitHub provider instance by installation ID
 * Convenience function when you have the installation ID but not the full gitOrganization object
 *
 * @param {string} installationId - GitHub App installation ID
 * @param {string} [orgLogin] - Organization login (optional)
 * @returns {GitHubProvider}
 */
export function getGitHubProvider(installationId, orgLogin = null) {
  return new GitHubProvider(installationId, orgLogin);
}

/**
 * Get short term code (e.g., "25w" for Winter 2025)
 * @param {string} term - Term enum (WINTER, SPRING, SUMMER, FALL)
 * @param {number} year - Full year (e.g., 2025)
 * @returns {string} Short term code (e.g., "25w")
 */
export function getTermCode(term, year) {
  const termMap = { WINTER: 'w', SPRING: 's', SUMMER: 'x', FALL: 'f' };
  const shortYear = String(year).slice(-2);
  return `${shortYear}${termMap[term] || 'x'}`;
}

/**
 * Get team name for a classroom based on role
 * Format: {classroom-slug}-{students|assistants}
 * Example: cs101-25w-students (CS101 Winter 2025 students)
 *
 * @param {Object} classroom - Classroom object with slug
 * @param {string} classroom.slug - Unique classroom slug
 * @param {'STUDENT' | 'ASSISTANT' | 'TEACHER'} role - User role
 * @returns {string} Team name (e.g., "cs101-25w-students")
 */
export function getTeamNameForClassroom(classroom, role) {
  if (!classroom?.slug) {
    throw new Error('getTeamNameForClassroom requires classroom.slug');
  }
  const suffix = role === 'STUDENT' ? 'students' : 'assistants';
  const teamName = `${classroom.slug}-${suffix}`;
  // GitHub team names have a 100-character limit
  if (teamName.length > 100) {
    throw new Error(`Team name exceeds GitHub's 100-character limit: ${teamName}`);
  }
  return teamName;
}

/**
 * Ensure a classroom team exists on GitHub, creating it if necessary.
 * This is idempotent - safe to call multiple times.
 * Uses getTeamNameForClassroom internally for naming - single source of truth.
 *
 * @param {Object} gitProvider - GitProvider instance
 * @param {string} orgLogin - GitHub organization login
 * @param {Object} classroom - Classroom object with slug
 * @param {'STUDENT' | 'ASSISTANT'} role - Role to create team for
 * @returns {Promise<{id: number, slug: string, name: string}>} Team object
 */
export async function ensureClassroomTeam(gitProvider, orgLogin, classroom, role) {
  const teamName = getTeamNameForClassroom(classroom, role);

  console.log('teamName', teamName);
  try {
    return await gitProvider.getTeam(orgLogin, teamName);
  } catch (error) {
    if (error.status === 404) {
      return await gitProvider.createTeam(orgLogin, teamName);
    }
    throw error;
  }
}

// Re-export Octokit for direct use when needed
export { Octokit } from 'octokit';

export { GitProvider, GitHubProvider, GitLabProvider };
