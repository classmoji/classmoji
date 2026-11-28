/**
 * The settings tools through the registry: each hands its shared service one
 * call with the caller as actor (`serviceActor`), answers what it answered
 * before, writes no audit row of its own, and adds `audit_incomplete: true`
 * when the service saved the change but could not write its row (never an
 * error, so a client does not retry a change that took effect).
 *
 * Covers classroom_settings_update, org_repo_settings_update,
 * emoji_mapping_upsert, letter_grade_mapping_upsert and tag_create. The rows
 * the services write are pinned against Postgres in packages/services
 * (settingsAudit.integration.test.ts).
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
  updateClassroomSettings: vi.fn(),
  updateOrgRepoSettings: vi.fn(),
  getGitHubTokenForUser: vi.fn(),
  saveEmojiMapping: vi.fn(),
  saveLetterGrade: vi.fn(),
  tagFindOrCreate: vi.fn(),
}));

vi.mock('@classmoji/database', async () =>
  (await import('../../__tests__/prismaSchemaStub.ts')).databaseModuleMock()
);

class OrgRepoSettingsError extends Error {}
class ClassroomSettingsEntitlementError extends Error {}
class ClassroomSettingsValidationError extends Error {}

vi.mock('@classmoji/services', () => ({
  HelperService: {},
  OrgRepoSettingsError,
  ClassroomSettingsEntitlementError,
  ClassroomSettingsValidationError,
  TeamServiceError: class extends Error {},
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
      normalizeTimeZoneSetting: (value: unknown) => value,
      normalizeInstructionsSetting: (value: unknown) => value,
      updateClassroomSettings: (...a: unknown[]) => mocks.updateClassroomSettings(...a),
    },
    classroomMembership: {
      findByClassroomAndUser: (...a: unknown[]) => mocks.findByClassroomAndUser(...a),
    },
    orgRepoSettings: {
      updateOrgRepoSettings: (...a: unknown[]) => mocks.updateOrgRepoSettings(...a),
    },
    githubUserToken: {
      getGitHubTokenForUser: (...a: unknown[]) => mocks.getGitHubTokenForUser(...a),
      clearRevokedTokenForUser: vi.fn(),
    },
    emojiMapping: { saveEmojiMapping: (...a: unknown[]) => mocks.saveEmojiMapping(...a) },
    letterGradeMapping: { save: (...a: unknown[]) => mocks.saveLetterGrade(...a) },
    organizationTag: { findOrCreate: (...a: unknown[]) => mocks.tagFindOrCreate(...a) },
  },
}));

const { classroomSettingsUpdateTool, orgRepoSettingsUpdateTool } =
  await import('../../tools/settings.ts');
const { emojiMappingUpsertTool, letterGradeMappingUpsertTool } =
  await import('../../tools/mappings.ts');
const { tagCreateTool } = await import('../../tools/teams.ts');
const { buildMcpServer, registerToolDefinition } = await import('../registry.ts');
const { resetRateLimits } = await import('../rateLimit.ts');

const WRITTEN = { written: 1, missed: 0 };
const MISSED = { written: 0, missed: 1 };
const NONE = { written: 0, missed: 0 };

beforeAll(() => {
  for (const def of [
    classroomSettingsUpdateTool,
    orgRepoSettingsUpdateTool,
    emojiMappingUpsertTool,
    letterGradeMappingUpsertTool,
    tagCreateTool,
  ]) {
    registerToolDefinition(def as unknown as ToolDefinition<never>);
  }
});

let viewerSeq = 0;
let impersonatedBy: string | undefined;

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  resetRateLimits();
  impersonatedBy = undefined;
  mocks.auditCreate.mockResolvedValue({ id: 'row-1' });
  mocks.classroomFindAll.mockResolvedValue([{ id: 'class-1', status: 'ACTIVE', slug: 'c' }]);
  mocks.findByClassroomAndUser.mockResolvedValue({ id: 'm-owner', role: 'OWNER' });
  mocks.classroomFindById.mockResolvedValue({
    id: 'class-1',
    git_organization: { login: 'myorg', provider: 'GITHUB', github_installation_id: '1' },
  });
  mocks.getGitHubTokenForUser.mockResolvedValue({ token: 'ghu_owner', expiresAt: null });
  mocks.updateClassroomSettings.mockResolvedValue({
    settings: { anthropic_api_key: 'sk-ant-stored-key', show_pages: false },
    classroom: null,
    audit: WRITTEN,
  });
  mocks.updateOrgRepoSettings.mockResolvedValue({
    org: 'myorg',
    changes: { members_can_create_repositories: { from: true, to: false } },
    settings: { members_can_create_repositories: false },
    value: 'members_can_create_repositories=false',
    audit: WRITTEN,
  });
  mocks.saveEmojiMapping.mockResolvedValue({
    mapping: { id: 'em-1', emoji: '⭐', grade: 90, extra_tokens: 1, description: 'Great' },
    audit: WRITTEN,
  });
  mocks.saveLetterGrade.mockResolvedValue({
    mapping: { id: 'lg-1', letter_grade: 'A', min_grade: 93 },
    audit: WRITTEN,
  });
  mocks.tagFindOrCreate.mockResolvedValue({
    tag: { id: 'tag-1', name: 'Section A', classroom_id: 'class-1' },
    created: true,
    audit: WRITTEN,
  });
});

async function call(name: string, args: Record<string, unknown>) {
  viewerSeq += 1;
  const server = buildMcpServer({
    userId: `user-${viewerSeq}`,
    clientId: 'settings-audit-test',
    scopes: new Set(['read', 'write']),
    ...(impersonatedBy ? { impersonatedBy } : {}),
  } as never);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'settings-audit-test', version: '0.0.0' });
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
  clientId: 'settings-audit-test',
  via: 'mcp',
});

describe('classroom_settings_update', () => {
  const ARGS = { classroom: 'org/c', show_pages: false, name: 'CS 52' };
  const ANSWER = {
    success: true,
    updated_fields: ['show_pages', 'name'],
    settings: { show_pages: false, name: 'CS 52' },
  };

  it('one service call with its actor; the same answer, no key echoed, no row of its own', async () => {
    const result = await call('classroom_settings_update', ARGS);
    expect(mocks.updateClassroomSettings).toHaveBeenCalledExactlyOnceWith(
      'class-1',
      { settings: { show_pages: false }, classroom: { name: 'CS 52' } },
      actorFor('classroom_settings_update')
    );
    expect(parse(result)).toEqual(ANSWER);
    expect(JSON.stringify(result)).not.toContain('sk-ant-stored-key');
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('under View as: the admin rides on the actor', async () => {
    impersonatedBy = 'admin-1';
    await call('classroom_settings_update', ARGS);
    expect(mocks.updateClassroomSettings.mock.calls[0][2]).toEqual(
      actorFor('classroom_settings_update', 'admin-1')
    );
  });

  it('a missed row: the same answer with audit_incomplete, not an error', async () => {
    mocks.updateClassroomSettings.mockResolvedValue({
      settings: {},
      classroom: null,
      audit: MISSED,
    });
    const result = await call('classroom_settings_update', ARGS);
    expect(result.isError).toBeFalsy();
    expect(parse(result)).toEqual({ ...ANSWER, audit_incomplete: true });
    expect(mocks.updateClassroomSettings).toHaveBeenCalledTimes(1);
  });

  it('a save that changed nothing owes no row: no field', async () => {
    mocks.updateClassroomSettings.mockResolvedValue({
      settings: {},
      classroom: null,
      audit: NONE,
    });
    expect(parse(await call('classroom_settings_update', ARGS))).toEqual(ANSWER);
  });
});

describe('org_repo_settings_update', () => {
  const ARGS = { classroom: 'org/c', members_can_create_repositories: false, confirm: true };
  const ANSWER = {
    success: true,
    organization: 'myorg',
    updated_fields: ['members_can_create_repositories'],
    settings: { members_can_create_repositories: false },
    message:
      "Updated organization-wide Github settings for 'myorg' — this affects every classroom and repository in that organization.",
  };

  it('one service call with the classroom and its actor; the same answer', async () => {
    const result = await call('org_repo_settings_update', ARGS);
    expect(mocks.updateOrgRepoSettings).toHaveBeenCalledExactlyOnceWith({
      gitOrganization: { login: 'myorg', provider: 'GITHUB', github_installation_id: '1' },
      userToken: 'ghu_owner',
      input: { members_can_create_repositories: false },
      classroomId: 'class-1',
      actor: actorFor('org_repo_settings_update'),
    });
    expect(parse(result)).toEqual(ANSWER);
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('a missed row: audit_incomplete', async () => {
    mocks.updateOrgRepoSettings.mockResolvedValue({
      org: 'myorg',
      changes: {},
      settings: { members_can_create_repositories: false },
      value: '',
      audit: MISSED,
    });
    expect(parse(await call('org_repo_settings_update', ARGS))).toEqual({
      ...ANSWER,
      audit_incomplete: true,
    });
  });
});

describe('the grading scale tools', () => {
  it('emoji_mapping_upsert: one service call with its actor; the same answer', async () => {
    const result = await call('emoji_mapping_upsert', {
      classroom: 'org/c',
      emoji: '⭐',
      grade: 90,
      description: 'Great',
    });
    expect(mocks.saveEmojiMapping).toHaveBeenCalledExactlyOnceWith(
      'class-1',
      { emoji: '⭐', grade: 90, description: 'Great' },
      actorFor('emoji_mapping_upsert')
    );
    expect(parse(result)).toEqual({
      success: true,
      mapping: { emoji: '⭐', grade: 90, extra_tokens: 1, description: 'Great' },
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('letter_grade_mapping_upsert: one service call with its actor; audit_incomplete on a miss', async () => {
    mocks.saveLetterGrade.mockResolvedValue({
      mapping: { id: 'lg-1', letter_grade: 'A', min_grade: 93 },
      audit: MISSED,
    });
    const result = await call('letter_grade_mapping_upsert', {
      classroom: 'org/c',
      letter_grade: 'A',
      min_grade: 93,
    });
    expect(mocks.saveLetterGrade).toHaveBeenCalledExactlyOnceWith(
      'class-1',
      { letter_grade: 'A', min_grade: 93 },
      actorFor('letter_grade_mapping_upsert')
    );
    expect(parse(result)).toEqual({
      success: true,
      mapping: { letter_grade: 'A', min_grade: 93 },
      audit_incomplete: true,
    });
  });
});

describe('tag_create', () => {
  it('one service call with its actor; the same answer; audit_incomplete on a miss', async () => {
    const answer = {
      success: true,
      created: true,
      tag: { id: 'tag-1', name: 'Section A' },
      message: "Tag 'Section A' created.",
    };
    expect(parse(await call('tag_create', { classroom: 'org/c', name: 'Section A' }))).toEqual(
      answer
    );
    expect(mocks.tagFindOrCreate).toHaveBeenCalledExactlyOnceWith(
      'class-1',
      'Section A',
      actorFor('tag_create')
    );

    mocks.tagFindOrCreate.mockResolvedValue({
      tag: { id: 'tag-1', name: 'Section A' },
      created: true,
      audit: MISSED,
    });
    expect(parse(await call('tag_create', { classroom: 'org/c', name: 'Section A' }))).toEqual({
      ...answer,
      audit_incomplete: true,
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });
});
