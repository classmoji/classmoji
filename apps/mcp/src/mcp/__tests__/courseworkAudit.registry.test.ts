/**
 * The coursework structure tools through the registry: each hands its shared
 * service the caller as actor (`serviceActor`, the viewing admin included
 * under View as), answers what it answered before, writes no audit row of its
 * own, and adds `audit_incomplete: true` when the service saved the change but
 * could not write its row (never an error, so a client does not retry a
 * change that took effect). A call that owed no row (nothing changed) gets no
 * field.
 *
 * Covers the module tools, the team tools and repo_create / repo_update /
 * repo_delete. The rows the services write are pinned against Postgres in
 * packages/services (moduleAudit, teamAudit and repositoryAudit integration
 * tests).
 *
 * The real tools run on a real McpServer over the SDK's in-memory transport,
 * with `@classmoji/services` faked.
 */

import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolDefinition } from '../registry.ts';

const mocks = vi.hoisted(() => ({
  auditCreate: vi.fn(),
  classroomFindAll: vi.fn(),
  classroomFindById: vi.fn(),
  findByClassroomAndUser: vi.fn(),
  membershipsByClassroom: vi.fn(),
  moduleCreate: vi.fn(),
  moduleUpdate: vi.fn(),
  moduleSetPublished: vi.fn(),
  moduleAddItem: vi.fn(),
  moduleRemoveItem: vi.fn(),
  moduleMoveEnd: vi.fn(),
  moduleFindById: vi.fn(),
  moduleDeleteById: vi.fn(),
  moduleReorderItems: vi.fn(),
  teamsByClassroom: vi.fn(),
  createTeam: vi.fn(),
  deleteTeam: vi.fn(),
  renameTeam: vi.fn(),
  addTeamMembers: vi.fn(),
  removeTeamMember: vi.fn(),
  addTeamTags: vi.fn(),
  removeTeamTag: vi.fn(),
  tagsByClassroom: vi.fn(),
  repositoryCreate: vi.fn(),
  repositoryFindById: vi.fn(),
  repositoryUpdate: vi.fn(),
  findDependents: vi.fn(),
  deleteIfUnprovisioned: vi.fn(),
  checkTemplate: vi.fn(),
  saveManifest: vi.fn(),
}));

vi.mock('@classmoji/database', async () =>
  (await import('../../__tests__/prismaSchemaStub.ts')).databaseModuleMock()
);

vi.mock('@classmoji/tasks', () => ({ default: {} }));
vi.mock('@classmoji/tasks/repo-sync', () => ({
  RepositorySyncNotFoundError: class extends Error {},
  RepositorySyncPartialError: class extends Error {},
  syncRepository: vi.fn(),
}));

class TeamServiceError extends Error {
  code = 'x';
}

vi.mock('@classmoji/services', () => ({
  HelperService: {},
  TeamServiceError,
  describeTeamFailureReason: () => '',
  ClassmojiService: {
    audit: {
      create: (...a: unknown[]) => mocks.auditCreate(...a),
      record: (row: unknown) =>
        import('../../__tests__/support/auditRecord.ts').then(m =>
          m.recordThrough(r => mocks.auditCreate(r))(row)
        ),
    },
    classroom: {
      findAll: (...a: unknown[]) => mocks.classroomFindAll(...a),
      findById: (...a: unknown[]) => mocks.classroomFindById(...a),
      getClassroomForUI: (c: unknown) => c,
      getTimeZone: async () => null,
    },
    classroomMembership: {
      findByClassroomAndUser: (...a: unknown[]) => mocks.findByClassroomAndUser(...a),
      findByClassroomId: (...a: unknown[]) => mocks.membershipsByClassroom(...a),
    },
    entitlement: { quizzesVisible: async () => true },
    module: {
      create: (...a: unknown[]) => mocks.moduleCreate(...a),
      updateForClassroom: (...a: unknown[]) => mocks.moduleUpdate(...a),
      setPublished: (...a: unknown[]) => mocks.moduleSetPublished(...a),
      addItem: (...a: unknown[]) => mocks.moduleAddItem(...a),
      removeItem: (...a: unknown[]) => mocks.moduleRemoveItem(...a),
      moveItemToModuleEnd: (...a: unknown[]) => mocks.moduleMoveEnd(...a),
      findOtherModulesHolding: async () => [],
      findById: (...a: unknown[]) => mocks.moduleFindById(...a),
      deleteById: (...a: unknown[]) => mocks.moduleDeleteById(...a),
      reorderItems: (...a: unknown[]) => mocks.moduleReorderItems(...a),
      QUIZ_ITEM_REFUSAL: 'quiz refusal',
    },
    team: { findByClassroomId: (...a: unknown[]) => mocks.teamsByClassroom(...a) },
    teamAdmin: {
      createTeam: (...a: unknown[]) => mocks.createTeam(...a),
      deleteTeam: (...a: unknown[]) => mocks.deleteTeam(...a),
      renameTeam: (...a: unknown[]) => mocks.renameTeam(...a),
      addTeamMembers: (...a: unknown[]) => mocks.addTeamMembers(...a),
      removeTeamMember: (...a: unknown[]) => mocks.removeTeamMember(...a),
      addTeamTags: (...a: unknown[]) => mocks.addTeamTags(...a),
      removeTeamTag: (...a: unknown[]) => mocks.removeTeamTag(...a),
    },
    organizationTag: { findByClassroomId: (...a: unknown[]) => mocks.tagsByClassroom(...a) },
    repository: {
      create: (...a: unknown[]) => mocks.repositoryCreate(...a),
      findById: (...a: unknown[]) => mocks.repositoryFindById(...a),
      update: (...a: unknown[]) => mocks.repositoryUpdate(...a),
      findDependents: (...a: unknown[]) => mocks.findDependents(...a),
      deleteIfUnprovisioned: (...a: unknown[]) => mocks.deleteIfUnprovisioned(...a),
      checkTemplate: (...a: unknown[]) => mocks.checkTemplate(...a),
    },
    contentManifest: { saveManifest: (...a: unknown[]) => mocks.saveManifest(...a) },
  },
}));

const modules = await import('../../tools/modules.ts');
const teams = await import('../../tools/teams.ts');
const repos = await import('../../tools/repos.ts');
const { buildMcpServer, registerToolDefinition } = await import('../registry.ts');
const { resetRateLimits } = await import('../rateLimit.ts');

const WRITTEN = { written: 1, missed: 0 };
const MISSED = { written: 0, missed: 1 };
const NONE = { written: 0, missed: 0 };

const MODULE_ID = '11111111-1111-4111-8111-111111111111';
const ITEM_ID = '22222222-2222-4222-8222-222222222222';
const PAGE_ID = '33333333-3333-4333-8333-333333333333';
const REPO_ID = '44444444-4444-4444-8444-444444444444';

beforeAll(() => {
  for (const def of [
    modules.moduleCreateTool,
    modules.moduleUpdateTool,
    modules.modulePublishTool,
    modules.moduleItemAddTool,
    modules.moduleItemRemoveTool,
    modules.moduleItemMoveTool,
    modules.moduleDeleteTool,
    modules.moduleReorderTool,
    teams.teamCreateTool,
    teams.teamDeleteTool,
    teams.teamRenameTool,
    teams.teamMembersAddTool,
    teams.teamMemberRemoveTool,
    teams.teamTagAddTool,
    teams.teamTagRemoveTool,
    repos.repoCreateTool,
    repos.repoUpdateTool,
    repos.repoDeleteTool,
  ]) {
    registerToolDefinition(def as unknown as ToolDefinition<never>);
  }
});

let viewerSeq = 0;
let impersonatedBy: string | undefined;

const MODULE_ROW = {
  id: MODULE_ID,
  classroom_id: 'class-1',
  title: 'Week 1',
  slug: 'week-1',
  description: null,
  is_published: true,
  assignments: [],
  items: [{ id: ITEM_ID, item_type: 'PAGE', page: { title: 'Intro', classroom_id: 'class-1' } }],
};
const TEAM_ROW = {
  id: 'team-1',
  name: 'Red',
  slug: 'red',
  is_visible: false,
  tags: [{ id: 'tt-1', tag_id: 'tag-1', tag: { id: 'tag-1', name: 'Projects' } }],
};
const REPO_ROW = {
  id: REPO_ID,
  classroom_id: 'class-1',
  title: 'Lab',
  slug: 'lab',
  type: 'INDIVIDUAL',
  is_published: false,
  template: 'org/t',
  tag_id: null,
  team_formation_mode: null,
  team_formation_deadline: null,
  max_team_size: null,
  project_template_id: null,
  project_template_title: null,
  description: null,
};

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  resetRateLimits();
  impersonatedBy = undefined;
  mocks.auditCreate.mockResolvedValue({ id: 'row-1' });
  mocks.classroomFindAll.mockResolvedValue([{ id: 'class-1', status: 'ACTIVE', slug: 'c' }]);
  mocks.findByClassroomAndUser.mockResolvedValue({ id: 'm-owner', role: 'OWNER' });
  mocks.classroomFindById.mockResolvedValue({
    id: 'class-1',
    git_organization: { login: 'myorg', provider: 'GITHUB' },
  });
  mocks.membershipsByClassroom.mockResolvedValue([
    {
      role: 'STUDENT',
      user: { id: 'u-1', accounts: [{ provider_id: 'github', username: 'ada' }] },
    },
  ]);
  mocks.moduleCreate.mockResolvedValue({ module: MODULE_ROW, audit: WRITTEN });
  mocks.moduleUpdate.mockResolvedValue({ module: MODULE_ROW, audit: WRITTEN });
  mocks.moduleSetPublished.mockResolvedValue({ module: MODULE_ROW, audit: WRITTEN });
  mocks.moduleAddItem.mockResolvedValue({
    item: { id: ITEM_ID, item_type: 'PAGE', position: 0 },
    audit: WRITTEN,
  });
  mocks.moduleRemoveItem.mockResolvedValue({
    item: { id: ITEM_ID, module_id: MODULE_ID, item_type: 'PAGE' },
    audit: WRITTEN,
  });
  mocks.moduleMoveEnd.mockResolvedValue({
    item: { id: ITEM_ID, item_type: 'PAGE', position: 1, from_module_id: 'm-0' },
    audit: WRITTEN,
  });
  mocks.moduleFindById.mockResolvedValue(MODULE_ROW);
  mocks.moduleDeleteById.mockResolvedValue({
    module: MODULE_ROW,
    deleted_quiz_assignment_ids: [],
    audit: WRITTEN,
  });
  mocks.moduleReorderItems.mockResolvedValue({ audit: WRITTEN });
  mocks.teamsByClassroom.mockResolvedValue([TEAM_ROW]);
  mocks.createTeam.mockResolvedValue({
    team: { id: 'team-1', name: 'Red', slug: 'red', isVisible: false },
    tagsAdded: ['tag-1'],
    tagsFailed: [],
    audit: WRITTEN,
  });
  mocks.deleteTeam.mockResolvedValue({
    id: 'team-1',
    name: 'Red',
    slug: 'red',
    removedFromProvider: false,
    reposDeleted: 0,
    deletedRepoNames: [],
    audit: WRITTEN,
  });
  mocks.renameTeam.mockResolvedValue({
    teamId: 'team-1',
    newName: 'Blue',
    newSlug: 'blue',
    renamedRepos: [],
    failed: [],
    audit: WRITTEN,
  });
  mocks.addTeamMembers.mockResolvedValue({
    succeeded: [{ login: 'ada' }],
    failed: [],
    audit: WRITTEN,
  });
  mocks.removeTeamMember.mockResolvedValue({
    teamId: 'team-1',
    login: 'ada',
    removed: true,
    audit: WRITTEN,
  });
  mocks.addTeamTags.mockResolvedValue({ added: ['tag-1'], failed: [], audit: WRITTEN });
  mocks.removeTeamTag.mockResolvedValue({
    teamTagId: 'tt-1',
    teamId: 'team-1',
    tagId: 'tag-1',
    audit: WRITTEN,
  });
  mocks.tagsByClassroom.mockResolvedValue([{ id: 'tag-1', name: 'Projects' }]);
  mocks.repositoryCreate.mockResolvedValue({ repository: REPO_ROW, audit: WRITTEN });
  mocks.repositoryFindById.mockResolvedValue(REPO_ROW);
  mocks.repositoryUpdate.mockResolvedValue({
    repository: { ...REPO_ROW, description: 'x', tag: null },
    audit: WRITTEN,
  });
  mocks.findDependents.mockResolvedValue({
    id: REPO_ID,
    assignments: [],
    _count: {
      git_repos: 0,
      module_items: 0,
      pages: 0,
      slides: 0,
      quizzes: 0,
      autograding_tests: 0,
    },
  });
  mocks.deleteIfUnprovisioned.mockResolvedValue({ status: 'deleted', audit: WRITTEN });
  mocks.checkTemplate.mockResolvedValue({ ok: true });
  mocks.saveManifest.mockResolvedValue(undefined);
});

async function call(name: string, args: Record<string, unknown>) {
  viewerSeq += 1;
  const server = buildMcpServer({
    userId: `user-${viewerSeq}`,
    clientId: 'coursework-audit-test',
    scopes: new Set(['read', 'write']),
    ...(impersonatedBy ? { impersonatedBy } : {}),
  } as never);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'coursework-audit-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
}

const parse = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0].text);

/** The actor `serviceActor` builds for the call `call()` made last. */
const actorFor = (tool: string, admin: string | null = null) => ({
  userId: `user-${viewerSeq}`,
  role: 'OWNER',
  tool,
  impersonatedBy: admin,
  clientId: 'coursework-audit-test',
  via: 'mcp',
});

/**
 * Each moved tool: its args, the service mock it calls, where in that call
 * the actor goes (an argument index, or the key of an object argument), and
 * how the mock answers with a given `audit`.
 */
interface Case {
  tool: string;
  args: Record<string, unknown>;
  mock: ReturnType<typeof vi.fn>;
  actorAt: number | { arg: number; key: string };
  answer: (audit: typeof WRITTEN) => unknown;
}

const C = 'org/c';
const CASES: Case[] = [
  {
    tool: 'module_create',
    args: { classroom: C, title: 'Week 1' },
    mock: mocks.moduleCreate,
    actorAt: 2,
    answer: audit => ({ module: MODULE_ROW, audit }),
  },
  {
    tool: 'module_update',
    args: { classroom: C, module_id: MODULE_ID, title: 'Week 1' },
    mock: mocks.moduleUpdate,
    actorAt: 3,
    answer: audit => ({ module: MODULE_ROW, audit }),
  },
  {
    tool: 'module_publish',
    args: { classroom: C, module_id: MODULE_ID, published: true },
    mock: mocks.moduleSetPublished,
    actorAt: 3,
    answer: audit => ({ module: MODULE_ROW, audit }),
  },
  {
    tool: 'module_item_add',
    args: { classroom: C, module_id: MODULE_ID, item_type: 'PAGE', target_id: PAGE_ID },
    mock: mocks.moduleAddItem,
    actorAt: 4,
    answer: audit => ({ item: { id: ITEM_ID, item_type: 'PAGE', position: 0 }, audit }),
  },
  {
    tool: 'module_item_remove',
    args: { classroom: C, item_id: ITEM_ID },
    mock: mocks.moduleRemoveItem,
    actorAt: 2,
    answer: audit => ({ item: { id: ITEM_ID, module_id: MODULE_ID, item_type: 'PAGE' }, audit }),
  },
  {
    tool: 'module_item_move',
    args: { classroom: C, item_id: ITEM_ID, module_id: MODULE_ID },
    mock: mocks.moduleMoveEnd,
    actorAt: 3,
    answer: audit => ({
      item: { id: ITEM_ID, item_type: 'PAGE', position: 1, from_module_id: 'm-0' },
      audit,
    }),
  },
  {
    tool: 'module_delete',
    args: { classroom: C, module_id: MODULE_ID },
    mock: mocks.moduleDeleteById,
    actorAt: 3,
    answer: audit => ({ module: MODULE_ROW, deleted_quiz_assignment_ids: [], audit }),
  },
  {
    tool: 'module_reorder',
    args: { classroom: C, kind: 'ITEMS', module_id: MODULE_ID, ordered_ids: [ITEM_ID] },
    mock: mocks.moduleReorderItems,
    actorAt: 3,
    answer: audit => ({ audit }),
  },
  {
    tool: 'team_create',
    args: { classroom: C, name: 'Red', tag_ids: ['tag-1'] },
    mock: mocks.createTeam,
    actorAt: { arg: 0, key: 'actor' },
    answer: audit => ({
      team: { id: 'team-1', name: 'Red', slug: 'red', isVisible: false },
      tagsAdded: ['tag-1'],
      tagsFailed: [],
      audit,
    }),
  },
  {
    tool: 'team_delete',
    args: { classroom: C, team: 'red', confirm: true },
    mock: mocks.deleteTeam,
    actorAt: { arg: 0, key: 'actor' },
    answer: audit => ({
      id: 'team-1',
      name: 'Red',
      slug: 'red',
      removedFromProvider: false,
      reposDeleted: 0,
      deletedRepoNames: [],
      audit,
    }),
  },
  {
    tool: 'team_rename',
    args: { classroom: C, team: 'red', new_name: 'Blue' },
    mock: mocks.renameTeam,
    actorAt: { arg: 0, key: 'actor' },
    answer: audit => ({
      teamId: 'team-1',
      newName: 'Blue',
      newSlug: 'blue',
      renamedRepos: [],
      failed: [],
      audit,
    }),
  },
  {
    tool: 'team_members_add',
    args: { classroom: C, team: 'red', logins: ['ada'] },
    mock: mocks.addTeamMembers,
    actorAt: { arg: 0, key: 'actor' },
    answer: audit => ({ succeeded: [{ login: 'ada' }], failed: [], audit }),
  },
  {
    tool: 'team_member_remove',
    args: { classroom: C, team: 'red', login: 'ada' },
    mock: mocks.removeTeamMember,
    actorAt: { arg: 0, key: 'actor' },
    answer: audit => ({ teamId: 'team-1', login: 'ada', removed: true, audit }),
  },
  {
    tool: 'team_tag_add',
    args: { classroom: C, team: 'red', tag_ids: ['tag-1'] },
    mock: mocks.addTeamTags,
    actorAt: { arg: 0, key: 'actor' },
    answer: audit => ({ added: ['tag-1'], failed: [], audit }),
  },
  {
    tool: 'team_tag_remove',
    args: { classroom: C, team: 'red', tag_id: 'tag-1' },
    mock: mocks.removeTeamTag,
    actorAt: { arg: 0, key: 'actor' },
    answer: audit => ({ teamTagId: 'tt-1', teamId: 'team-1', tagId: 'tag-1', audit }),
  },
  {
    tool: 'repo_create',
    args: { classroom: C, title: 'Lab', template: 'org/t' },
    mock: mocks.repositoryCreate,
    actorAt: 1,
    answer: audit => ({ repository: REPO_ROW, audit }),
  },
  {
    tool: 'repo_update',
    args: { classroom: C, repository_id: REPO_ID, description: 'x' },
    mock: mocks.repositoryUpdate,
    actorAt: 3,
    answer: audit => ({ repository: { ...REPO_ROW, description: 'x', tag: null }, audit }),
  },
  {
    tool: 'repo_delete',
    args: { classroom: C, repository_id: REPO_ID, confirm: true },
    mock: mocks.deleteIfUnprovisioned,
    actorAt: 2,
    answer: audit => ({ status: 'deleted', audit }),
  },
];

const actorOf = (c: Case) => {
  const call = c.mock.mock.calls[0];
  return typeof c.actorAt === 'number'
    ? call[c.actorAt]
    : (call[c.actorAt.arg] as Record<string, unknown>)[c.actorAt.key];
};

describe.each(CASES.map(c => [c.tool, c] as const))('%s', (tool, c) => {
  it('one service call with its actor; no row of its own; no audit_incomplete', async () => {
    const result = await call(tool, c.args);
    expect(result.isError).toBeFalsy();
    expect(c.mock).toHaveBeenCalledTimes(1);
    expect(actorOf(c)).toEqual(actorFor(tool));
    expect(mocks.auditCreate).not.toHaveBeenCalled();
    expect(parse(result)).not.toHaveProperty('audit_incomplete');
  });

  it('under View as: the admin rides on the actor', async () => {
    impersonatedBy = 'admin-1';
    await call(tool, c.args);
    expect(actorOf(c)).toEqual(actorFor(tool, 'admin-1'));
  });

  it('the same answer with audit_incomplete when the row was missed; none when none was owed', async () => {
    const written = parse(await call(tool, c.args));
    c.mock.mockResolvedValue(c.answer(MISSED));
    const missed = await call(tool, c.args);
    expect(missed.isError).toBeFalsy();
    expect(parse(missed)).toEqual({ ...written, audit_incomplete: true });

    c.mock.mockResolvedValue(c.answer(NONE));
    expect(parse(await call(tool, c.args))).toEqual(written);
  });
});
