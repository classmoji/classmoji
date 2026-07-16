/**
 * Unit tests for repo_create (container create). The tool must:
 *   - write classroom_id from ctx, never from input;
 *   - refresh the content manifest but NEVER trigger repo provisioning
 *     (provisioning is repo_publish's job — a create must not touch GitHub repos);
 *   - validate a supplied tag belongs to the classroom (S1);
 *   - enforce the GROUP+INSTRUCTOR-needs-tag rule and map P2002 to invalid_params.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../mcp/registry.ts';

const mocks = vi.hoisted(() => ({
  repositoryCreate: vi.fn(),
  findByClassroomId: vi.fn(),
  saveManifest: vi.fn(),
  auditCreate: vi.fn(),
  createRepositoriesTrigger: vi.fn(),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    repository: { create: (...a: unknown[]) => mocks.repositoryCreate(...a) },
    organizationTag: { findByClassroomId: (...a: unknown[]) => mocks.findByClassroomId(...a) },
    contentManifest: { saveManifest: (...a: unknown[]) => mocks.saveManifest(...a) },
    audit: { create: (...a: unknown[]) => mocks.auditCreate(...a) },
  },
}));

vi.mock('@classmoji/tasks', () => ({
  default: {
    createRepositoriesTask: {
      trigger: (...a: unknown[]) => mocks.createRepositoriesTrigger(...a),
    },
  },
}));

const { repoCreateTool } = await import('../repos.ts');

const CTX: ToolContext = {
  viewer: { userId: 'owner-1', clientId: 'c', scopes: new Set(['read', 'write']) },
  classroom: {
    classroomId: 'class-1',
    role: 'OWNER',
    status: 'ACTIVE',
    slug: 'cs1-w26',
    membership: { id: 'm-1', role: 'OWNER' },
    classroom: { settings: {}, slug: 'cs1-w26' },
  },
} as unknown as ToolContext;

function parse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.saveManifest.mockResolvedValue(undefined);
  mocks.auditCreate.mockResolvedValue(undefined);
  mocks.repositoryCreate.mockResolvedValue({
    id: 'repo-new',
    title: 'Lab 1',
    slug: 'lab-1',
    type: 'INDIVIDUAL',
    is_published: false,
    weight: 100,
  });
});

describe('repo_create', () => {
  const BASE = { classroom: 'org/cs1-w26', title: 'Lab 1', template: 'lab1-template' };

  it('creates an unpublished container from ctx classroom, refreshes manifest, NO provisioning', async () => {
    const payload = parse(await repoCreateTool.handler(BASE, CTX));

    expect(payload.repository.id).toBe('repo-new');
    expect(payload.repository.is_published).toBe(false);

    const data = mocks.repositoryCreate.mock.calls[0][0] as { classroom_id: string; type: string };
    expect(data.classroom_id).toBe('class-1'); // from ctx, not input
    expect(data.type).toBe('INDIVIDUAL');

    expect(mocks.saveManifest).toHaveBeenCalledWith('class-1');
    // The key isolation guarantee: creating a container must NOT provision repos.
    expect(mocks.createRepositoriesTrigger).not.toHaveBeenCalled();
    expect((mocks.auditCreate.mock.calls[0][0] as { action: string }).action).toBe('CREATE');
  });

  it('rejects a GROUP + instructor-assigned container with no tag_id', async () => {
    await expect(repoCreateTool.handler({ ...BASE, type: 'GROUP' }, CTX)).rejects.toMatchObject({
      kind: 'invalid_params',
    });
    expect(mocks.repositoryCreate).not.toHaveBeenCalled();
  });

  it('refuses a tag_id that belongs to another classroom (S1)', async () => {
    mocks.findByClassroomId.mockResolvedValue([{ id: 'tag-a' }, { id: 'tag-b' }]);
    await expect(
      repoCreateTool.handler(
        { ...BASE, type: 'GROUP', tag_id: '11111111-1111-1111-1111-111111111111' },
        CTX
      )
    ).rejects.toMatchObject({ kind: 'not_found' });
    expect(mocks.repositoryCreate).not.toHaveBeenCalled();
  });

  it('creates a GROUP container when the tag_id belongs to the classroom', async () => {
    mocks.findByClassroomId.mockResolvedValue([{ id: 'tag-a' }]);
    mocks.repositoryCreate.mockResolvedValue({
      id: 'repo-g',
      title: 'Group Lab',
      slug: 'group-lab',
      type: 'GROUP',
      is_published: false,
      weight: 100,
    });

    await repoCreateTool.handler(
      { ...BASE, title: 'Group Lab', type: 'GROUP', tag_id: 'tag-a' },
      CTX
    );
    const data = mocks.repositoryCreate.mock.calls[0][0] as {
      type: string;
      tag_id: string;
      team_formation_mode: string;
    };
    expect(data.type).toBe('GROUP');
    expect(data.tag_id).toBe('tag-a');
    expect(data.team_formation_mode).toBe('INSTRUCTOR');
  });

  it('maps a duplicate-title P2002 to invalid_params', async () => {
    mocks.repositoryCreate.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));
    await expect(repoCreateTool.handler(BASE, CTX)).rejects.toMatchObject({
      kind: 'invalid_params',
    });
    expect(mocks.saveManifest).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });
});
