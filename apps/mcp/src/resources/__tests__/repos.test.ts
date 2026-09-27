/**
 * Unit tests for the `repos` resource (the read side of list_repos).
 *
 * Pinned here: the STAFF view carries every field repo_update edits — so an
 * agent can read a repo before it writes one — while the existing `tag` (the
 * tag's name) keeps its shape and `tag_id` is added beside it. The STUDENT view
 * does not grow: none of those configuration fields reach a student.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../mcp/registry.ts';

const findByClassroomId = vi.fn();
const findPublished = vi.fn();
const findForUser = vi.fn();

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    repository: {
      findByClassroomId: (...a: unknown[]) => findByClassroomId(...a),
      findPublished: (...a: unknown[]) => findPublished(...a),
    },
    gitRepoAssignment: { findForUser: (...a: unknown[]) => findForUser(...a) },
  },
}));

const { reposResource } = await import('../repos.ts');

const VARS = { org: 'test-org', slug: 'winter-2025' };
const URI = new URL('classmoji://test-org/winter-2025/repos');

function ctxFor(role: 'OWNER' | 'ASSISTANT' | 'STUDENT'): ToolContext {
  return {
    viewer: { userId: 'user-1', clientId: 'c', scopes: new Set(['read']) },
    classroom: {
      classroomId: 'class-1',
      role,
      status: 'ACTIVE',
      membership: { id: 'm-1', role },
      classroom: { settings: {}, git_organization: { login: 'test-org' } },
    },
  } as unknown as ToolContext;
}

const DEADLINE = new Date('2026-10-02T03:59:00.000Z');

const REPO_ROW = {
  id: 'repo-1',
  title: 'workshop',
  slug: 'workshop',
  description: 'Pairs',
  is_published: true,
  type: 'GROUP',
  template: 'org/workshop-template',
  tag_id: 'tag-1',
  tag: { id: 'tag-1', name: 'workshop-pairs' },
  team_formation_mode: 'INSTRUCTOR',
  team_formation_deadline: DEADLINE,
  max_team_size: 2,
  project_template_id: 'PVT_1',
  project_template_title: 'Board',
  assignments: [],
};

/** Every configuration field the staff view adds for repo_update. */
const STAFF_ONLY_FIELDS = [
  'template',
  'tag_id',
  'team_formation_mode',
  'team_formation_deadline',
  'max_team_size',
  'project_template_id',
  'project_template_title',
  'tag',
];

type ReposPayload = { repositories: Array<Record<string, unknown>> };

beforeEach(() => {
  findByClassroomId.mockReset();
  findPublished.mockReset();
  findForUser.mockReset();
});

describe('repos resource', () => {
  it('shows staff every field repo_update edits, keeping `tag` as the name', async () => {
    findByClassroomId.mockResolvedValue([REPO_ROW]);

    const payload = (await reposResource.handler(VARS, ctxFor('ASSISTANT'), URI)) as ReposPayload;

    expect(findByClassroomId).toHaveBeenCalledWith('class-1');
    expect(payload.repositories[0]).toMatchObject({
      id: 'repo-1',
      description: 'Pairs',
      template: 'org/workshop-template',
      tag: 'workshop-pairs',
      tag_id: 'tag-1',
      team_formation_mode: 'INSTRUCTOR',
      team_formation_deadline: DEADLINE,
      max_team_size: 2,
      project_template_id: 'PVT_1',
      project_template_title: 'Board',
    });
  });

  it('reports absent configuration as null for staff', async () => {
    findByClassroomId.mockResolvedValue([
      {
        ...REPO_ROW,
        type: 'INDIVIDUAL',
        tag_id: null,
        tag: null,
        team_formation_deadline: null,
        project_template_id: null,
        project_template_title: null,
      },
    ]);

    const payload = (await reposResource.handler(VARS, ctxFor('OWNER'), URI)) as ReposPayload;
    expect(payload.repositories[0]).toMatchObject({
      tag: null,
      tag_id: null,
      team_formation_deadline: null,
      project_template_id: null,
    });
  });

  it('leaves the student view without any of the configuration fields', async () => {
    findPublished.mockResolvedValue([REPO_ROW]);
    findForUser.mockResolvedValue([
      {
        id: 'sub-1',
        status: 'OPEN',
        assignment: { id: 'a-1' },
        git_repo: { repository_id: 'repo-1', name: 'workshop-team-a' },
        grades: [],
        graders: [],
      },
    ]);

    const payload = (await reposResource.handler(VARS, ctxFor('STUDENT'), URI)) as ReposPayload;

    expect(payload.repositories).toHaveLength(1);
    for (const field of STAFF_ONLY_FIELDS) {
      expect(payload.repositories[0], field).not.toHaveProperty(field);
    }
  });
});
