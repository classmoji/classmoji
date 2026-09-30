/**
 * classroomForClient: a classroom as a loader returns it — its own fields and
 * settings as given, and its git organization as id, login, provider and
 * provider_id.
 */

import { describe, expect, it } from 'vitest';
import { classroomForClient } from '../classroomForClient';

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
      git_organization: { id: 'org-1', login: 'cs-org', provider: 'GITHUB', provider_id: '4242' },
    });
  });

  it('answers null for a classroom with no organization loaded', () => {
    expect(
      classroomForClient({ id: 'class-1', git_organization: null }).git_organization
    ).toBeNull();
  });
});
