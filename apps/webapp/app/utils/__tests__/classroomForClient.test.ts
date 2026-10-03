/**
 * classroomForClient: a classroom as a loader returns it — its own fields and
 * settings as given, and its git organization as id, login, provider,
 * provider_id and base_url.
 */

import { describe, expect, it } from 'vitest';
import { classroomForClient } from '../classroomForClient';
import { gitContextFor, gitWeb } from '../gitWeb';

const CLASSROOM = {
  id: 'class-1',
  slug: 'cs-1',
  name: 'CS 1',
  status: 'ACTIVE',
  settings: { quizzes_enabled: true, has_anthropic_key: false },
  git_organization: {
    id: 'org-1',
    login: 'cs-org',
    provider: 'GITHUB',
    provider_id: '4242',
    base_url: null,
    github_installation_id: '999',
    access_token: null,
    avatar_url: 'https://avatars.githubusercontent.com/u/4242?v=4',
    created_at: new Date('2026-01-01T00:00:00Z'),
    updated_at: new Date('2026-01-01T00:00:00Z'),
  },
};

describe('classroomForClient', () => {
  it('keeps the classroom and its settings, and the organization fields pages read', () => {
    const out = classroomForClient(CLASSROOM);

    expect(out).toEqual({
      id: 'class-1',
      slug: 'cs-1',
      name: 'CS 1',
      status: 'ACTIVE',
      settings: { quizzes_enabled: true, has_anthropic_key: false },
      git_organization: {
        id: 'org-1',
        login: 'cs-org',
        provider: 'GITHUB',
        provider_id: '4242',
        base_url: null,
      },
    });
  });

  it("keeps a self-managed Gitlab's host, so its links do not fall back to gitlab.com", () => {
    const out = classroomForClient({
      id: 'class-2',
      git_namespace: 'cs/cs50',
      git_organization: {
        id: 'org-2',
        login: 'cs',
        provider: 'GITLAB',
        provider_id: '7',
        base_url: 'https://gitlab.school.edu',
      },
    });

    expect(out.git_organization?.base_url).toBe('https://gitlab.school.edu');
    expect(gitWeb(gitContextFor(out)).repo('lab-1-jlee')).toBe(
      'https://gitlab.school.edu/cs/cs50/projects/lab-1-jlee'
    );
  });

  it('answers null for a classroom with no organization loaded', () => {
    expect(
      classroomForClient({ id: 'class-1', git_organization: null }).git_organization
    ).toBeNull();
  });
});
