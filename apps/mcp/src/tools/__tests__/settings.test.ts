/**
 * Unit tests for classroom_settings_update / classroom_status_update /
 * org_repo_settings_update.
 *
 * Security focus: `updateSettings` is a bare upsert that writes ANY key it
 * receives (including anthropic_api_key / openai_api_key), and the web actions
 * forward whole request bodies into it. These tools must build an EXPLICIT
 * object instead — so the load-bearing assertions here are that the object
 * handed to the service contains EXACTLY the expected keys, and that an extra
 * key riding along on the arguments is not forwarded. The same rule is checked
 * for classroom.update (name only) and the organization settings service call.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ToolContext } from '../../mcp/registry.ts';

const mocks = vi.hoisted(() => ({
  classroomUpdate: vi.fn(),
  updateSettings: vi.fn(),
  classroomFindById: vi.fn(),
  pageFindById: vi.fn(),
  updateOrgRepoSettings: vi.fn(),
  getGitHubTokenForUser: vi.fn(),
  getGitProvider: vi.fn(),
  auditCreate: vi.fn(),
}));

// Stand-in with the service's contract (the real one is tested in services).
class OrgRepoSettingsError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

// The real rule lives in classroom.service (tested there); this stand-in has the
// same contract so the tool's wiring — call it, store what it returns, map its
// refusal — is what gets tested here.
class ClassroomSettingsValidationError extends Error {
  code = 'TIMEZONE_INVALID';
}

vi.mock('@classmoji/services', () => ({
  ClassroomSettingsValidationError,
  ClassmojiService: {
    classroom: {
      normalizeTimeZoneSetting: (value: unknown) => {
        if (value === null) return null;
        if (value === 'america/new_york') return 'America/New_York';
        throw new ClassroomSettingsValidationError(`'${String(value)}' is not a time zone`);
      },
      update: (...a: unknown[]) => mocks.classroomUpdate(...a),
      updateSettings: (...a: unknown[]) => mocks.updateSettings(...a),
      findById: (...a: unknown[]) => mocks.classroomFindById(...a),
    },
    page: { findById: (...a: unknown[]) => mocks.pageFindById(...a) },
    audit: { create: (...a: unknown[]) => mocks.auditCreate(...a) },
    orgRepoSettings: {
      updateOrgRepoSettings: (...a: unknown[]) => mocks.updateOrgRepoSettings(...a),
    },
    githubUserToken: {
      getGitHubTokenForUser: (...a: unknown[]) => mocks.getGitHubTokenForUser(...a),
    },
  },
  OrgRepoSettingsError,
  getGitProvider: (...a: unknown[]) => mocks.getGitProvider(...a),
}));

const { classroomSettingsUpdateTool, classroomStatusUpdateTool, orgRepoSettingsUpdateTool } =
  await import('../settings.ts');

const CTX: ToolContext = {
  viewer: { userId: 'owner-1', clientId: 'c', scopes: new Set(['read', 'write']) },
  classroom: {
    classroomId: 'class-1',
    role: 'OWNER',
    status: 'ACTIVE',
    membership: { id: 'm-1', role: 'OWNER' },
    classroom: { settings: {} },
  },
} as unknown as ToolContext;

function parse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.auditCreate.mockResolvedValue(undefined);
  mocks.updateSettings.mockResolvedValue({});
  mocks.classroomUpdate.mockResolvedValue({ status: 'ACTIVE', is_archived: false });
  mocks.getGitHubTokenForUser.mockResolvedValue({ token: 'ghu_owner', expiresAt: null });
  mocks.updateOrgRepoSettings.mockImplementation(
    async ({ input }: { input: Record<string, unknown> }) => ({
      org: 'myorg',
      changes: Object.fromEntries(
        Object.entries(input).map(([field, to]) => [field, { from: null, to }])
      ),
      settings: input,
      value: Object.entries(input)
        .map(([field, to]) => `${field}=${String(to)}`)
        .join(';'),
    })
  );
});

describe('classroom_settings_update', () => {
  it('requires at least one field', async () => {
    await expect(
      classroomSettingsUpdateTool.handler({ classroom: 'org/w26' }, CTX)
    ).rejects.toMatchObject({ kind: 'invalid_params' });
    expect(mocks.updateSettings).not.toHaveBeenCalled();
    expect(mocks.classroomUpdate).not.toHaveBeenCalled();
  });

  it('passes an explicit object with EXACTLY the validated keys', async () => {
    await classroomSettingsUpdateTool.handler(
      { classroom: 'org/w26', quizzes_enabled: false, default_tokens_per_hour: 5 },
      CTX
    );

    const [classroomId, settings] = mocks.updateSettings.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(classroomId).toBe('class-1'); // from ctx, never from args
    expect(Object.keys(settings).sort()).toEqual(['default_tokens_per_hour', 'quizzes_enabled']);
    expect(settings).toEqual({ quizzes_enabled: false, default_tokens_per_hour: 5 });
  });

  it('never forwards an unknown argument key to the settings upsert', async () => {
    // updateSettings writes any key it receives — including API-key columns. An
    // extra key on the arguments must therefore die at the tool boundary, not
    // reach the service. (The registry's zod validation would already strip it;
    // this proves the handler does not depend on that.)
    await classroomSettingsUpdateTool.handler(
      {
        classroom: 'org/w26',
        show_pages: true,
        anthropic_api_key: 'sk-should-never-be-written',
        content_repo_name: 'nope',
      } as unknown as Parameters<typeof classroomSettingsUpdateTool.handler>[0],
      CTX
    );

    const settings = mocks.updateSettings.mock.calls[0][1] as Record<string, unknown>;
    expect(settings).toEqual({ show_pages: true });
    expect(settings).not.toHaveProperty('anthropic_api_key');
    expect(settings).not.toHaveProperty('content_repo_name');
    expect(JSON.stringify(mocks.updateSettings.mock.calls)).not.toContain('sk-should-never');
  });

  it('sends name to classroom.update (PROFILE_FIELDS) and not to updateSettings', async () => {
    await classroomSettingsUpdateTool.handler(
      { classroom: 'org/w26', name: 'CS 52 — Winter', theme: 'sand' },
      CTX
    );

    expect(mocks.classroomUpdate).toHaveBeenCalledWith('class-1', { name: 'CS 52 — Winter' });
    const settings = mocks.updateSettings.mock.calls[0][1] as Record<string, unknown>;
    expect(settings).toEqual({ theme: 'sand' });
    expect(settings).not.toHaveProperty('name');
  });

  it('does not touch the classroom row when only settings change', async () => {
    await classroomSettingsUpdateTool.handler({ classroom: 'org/w26', show_repos: false }, CTX);
    expect(mocks.classroomUpdate).not.toHaveBeenCalled();
  });

  it('does not touch settings when only the name changes', async () => {
    await classroomSettingsUpdateTool.handler({ classroom: 'org/w26', name: 'Renamed' }, CTX);
    expect(mocks.updateSettings).not.toHaveBeenCalled();
    expect(mocks.classroomUpdate).toHaveBeenCalledWith('class-1', { name: 'Renamed' });
  });

  it('resolves a page: default_student_page inside this classroom', async () => {
    mocks.pageFindById.mockResolvedValue({ id: 'page-1', classroom_id: 'class-1' });

    await classroomSettingsUpdateTool.handler(
      { classroom: 'org/w26', default_student_page: 'page:page-1' },
      CTX
    );
    expect(mocks.updateSettings.mock.calls[0][1]).toEqual({ default_student_page: 'page:page-1' });
  });

  it('refuses a page from another classroom (S1) and writes nothing', async () => {
    mocks.pageFindById.mockResolvedValue({ id: 'page-1', classroom_id: 'OTHER-class' });

    await expect(
      classroomSettingsUpdateTool.handler(
        { classroom: 'org/w26', default_student_page: 'page:page-1' },
        CTX
      )
    ).rejects.toMatchObject({ kind: 'not_found', message: 'Page not found in this classroom' });
    expect(mocks.updateSettings).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('rejects a malformed default_student_page', async () => {
    await expect(
      classroomSettingsUpdateTool.handler(
        { classroom: 'org/w26', default_student_page: 'grades' },
        CTX
      )
    ).rejects.toMatchObject({ kind: 'invalid_params' });
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });

  it('audits the changed field names with the ctx classroom id', async () => {
    await classroomSettingsUpdateTool.handler(
      { classroom: 'org/w26', name: 'Renamed', slides_enabled: true },
      CTX
    );
    const audit = mocks.auditCreate.mock.calls[0][0] as {
      action: string;
      classroom_id: string;
      resource_type: string;
      data: { fields: string[] };
    };
    expect(audit.action).toBe('UPDATE');
    expect(audit.classroom_id).toBe('class-1');
    expect(audit.resource_type).toBe('SETTINGS');
    expect(audit.data.fields.sort()).toEqual(['name', 'slides_enabled']);
  });

  it('constrains theme to the known keys in the schema', () => {
    const theme = classroomSettingsUpdateTool.inputSchema.theme;
    expect(theme.safeParse('stone').success).toBe(true);
    expect(theme.safeParse('lavender').success).toBe(true);
    expect(theme.safeParse('neon').success).toBe(false);
  });

  it('exposes no API-key or llm_* fields in its schema', () => {
    const keys = Object.keys(classroomSettingsUpdateTool.inputSchema);
    expect(keys.filter(k => k.includes('api_key') || k.startsWith('llm_'))).toEqual([]);
    // Dead / legacy columns stay out too.
    expect(keys).not.toContain('show_grades_to_students');
    expect(keys).not.toContain('content_repo_name');
  });

  it('rejects negative numeric settings in the schema', () => {
    const schema = z.object(classroomSettingsUpdateTool.inputSchema);
    const base = { classroom: 'org/w26' };
    expect(schema.safeParse({ ...base, default_tokens_per_hour: -1 }).success).toBe(false);
    expect(schema.safeParse({ ...base, default_tokens_per_hour: 1.5 }).success).toBe(false);
    expect(schema.safeParse({ ...base, late_penalty_points_per_hour: -0.5 }).success).toBe(false);
    expect(schema.safeParse({ ...base, late_penalty_points_per_hour: 2.5 }).success).toBe(true);
    expect(schema.safeParse({ ...base, name: '   ' }).success).toBe(false);
  });
});

describe('classroom_settings_update — timezone', () => {
  it('stores the canonical zone and echoes it', async () => {
    const result = await classroomSettingsUpdateTool.handler(
      { classroom: 'org/w26', timezone: 'america/new_york' },
      CTX
    );
    expect(mocks.updateSettings).toHaveBeenCalledWith('class-1', { timezone: 'America/New_York' });
    expect(parse(result).settings).toEqual({ timezone: 'America/New_York' });
  });

  it('clears the zone with null', async () => {
    await classroomSettingsUpdateTool.handler({ classroom: 'org/w26', timezone: null }, CTX);
    expect(mocks.updateSettings).toHaveBeenCalledWith('class-1', { timezone: null });
  });

  it('refuses an unknown zone as invalid_params and writes nothing', async () => {
    const error = await classroomSettingsUpdateTool
      .handler({ classroom: 'org/w26', timezone: 'Mars/Olympus' }, CTX)
      .catch(e => e);
    expect(error.kind).toBe('invalid_params');
    expect(error.code).toBe('TIMEZONE_INVALID');
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });

  it('accepts a nullable string in the schema', () => {
    const schema = z.object(classroomSettingsUpdateTool.inputSchema);
    expect(schema.safeParse({ classroom: 'o/s', timezone: null }).success).toBe(true);
    expect(schema.safeParse({ classroom: 'o/s', timezone: 5 }).success).toBe(false);
  });
});

describe('classroom_status_update', () => {
  it('requires status and/or is_archived', async () => {
    await expect(
      classroomStatusUpdateTool.handler({ classroom: 'org/w26' }, CTX)
    ).rejects.toMatchObject({ kind: 'invalid_params' });
    expect(mocks.classroomUpdate).not.toHaveBeenCalled();
  });

  it('updates both columns explicitly using the ctx classroom id', async () => {
    mocks.classroomUpdate.mockResolvedValue({ status: 'LOCKED', is_archived: true });

    const payload = parse(
      await classroomStatusUpdateTool.handler(
        { classroom: 'org/w26', status: 'LOCKED', is_archived: true },
        CTX
      )
    );
    expect(payload).toMatchObject({ status: 'LOCKED', is_archived: true });
    expect(mocks.classroomUpdate).toHaveBeenCalledWith('class-1', {
      status: 'LOCKED',
      is_archived: true,
    });
  });

  it('sets only the column provided', async () => {
    mocks.classroomUpdate.mockResolvedValue({ status: 'ACTIVE', is_archived: true });
    await classroomStatusUpdateTool.handler({ classroom: 'org/w26', is_archived: true }, CTX);
    expect(mocks.classroomUpdate.mock.calls[0][1]).toEqual({ is_archived: true });
  });

  it('never forwards extra argument keys to the classroom row', async () => {
    // classroom.update takes an arbitrary ClassroomUpdateInput — slug (the key
    // in every URL and two HMAC credentials) and git_org_id are exactly what
    // the web route's PROFILE_FIELDS whitelist exists to keep unwritable.
    await classroomStatusUpdateTool.handler(
      {
        classroom: 'org/w26',
        status: 'LOCKED',
        slug: 'hijacked',
        git_org_id: 'other-org',
      } as unknown as Parameters<typeof classroomStatusUpdateTool.handler>[0],
      CTX
    );

    const updates = mocks.classroomUpdate.mock.calls[0][1] as Record<string, unknown>;
    expect(updates).toEqual({ status: 'LOCKED' });
    expect(updates).not.toHaveProperty('slug');
    expect(updates).not.toHaveProperty('git_org_id');
  });

  it('accepts only the three lifecycle statuses and is marked idempotent', () => {
    const status = classroomStatusUpdateTool.inputSchema.status;
    for (const value of ['ACTIVE', 'LOCKED', 'UNPUBLISHED']) {
      expect(status.safeParse(value).success).toBe(true);
    }
    expect(status.safeParse('ARCHIVED').success).toBe(false);
    expect(status.safeParse('DELETED').success).toBe(false);
    expect(classroomStatusUpdateTool.annotations?.idempotent).toBe(true);
  });

  it('audits against CLASSROOM with the ctx classroom id', async () => {
    await classroomStatusUpdateTool.handler({ classroom: 'org/w26', status: 'ACTIVE' }, CTX);
    const audit = mocks.auditCreate.mock.calls[0][0] as {
      resource_type: string;
      classroom_id: string;
    };
    expect(audit.resource_type).toBe('CLASSROOM');
    expect(audit.classroom_id).toBe('class-1');
  });
});

describe('org_repo_settings_update', () => {
  const ORG = { id: 'gorg-1', login: 'myorg', github_installation_id: '123' };
  // The confirm gate lives in the schema; the handler takes it already parsed.
  const BASE = { classroom: 'org/w26', confirm: true as const };

  beforeEach(() => {
    mocks.classroomFindById.mockResolvedValue({ id: 'class-1', git_organization: ORG });
  });

  it('requires at least one field', async () => {
    await expect(orgRepoSettingsUpdateTool.handler(BASE, CTX)).rejects.toMatchObject({
      kind: 'invalid_params',
    });
    expect(mocks.updateOrgRepoSettings).not.toHaveBeenCalled();
  });

  it('applies an exact object to the ctx classroom organization with the caller token', async () => {
    const payload = parse(
      await orgRepoSettingsUpdateTool.handler(
        { ...BASE, default_repository_permission: 'read' },
        CTX
      )
    );
    expect(payload).toMatchObject({
      success: true,
      organization: 'myorg',
      settings: { default_repository_permission: 'read' },
    });

    expect(mocks.classroomFindById).toHaveBeenCalledWith('class-1');
    // The caller's own GitHub token, looked up by the ctx viewer.
    expect(mocks.getGitHubTokenForUser).toHaveBeenCalledWith('owner-1');
    const [call] = mocks.updateOrgRepoSettings.mock.calls[0] as [
      { gitOrganization: unknown; userToken: unknown; input: Record<string, unknown> },
    ];
    expect(call.gitOrganization).toBe(ORG);
    expect(call.userToken).toBe('ghu_owner');
    expect(call.input).toEqual({ default_repository_permission: 'read' });
    // The App installation is never used for the change.
    expect(mocks.getGitProvider).not.toHaveBeenCalled();
  });

  it('never forwards extra argument keys', async () => {
    await orgRepoSettingsUpdateTool.handler(
      {
        ...BASE,
        members_can_create_repositories: true,
        billing_email: 'nope@x.edu',
        org: 'other-org',
      } as unknown as Parameters<typeof orgRepoSettingsUpdateTool.handler>[0],
      CTX
    );
    // Neither the stray keys nor `confirm` reach the service.
    const [call] = mocks.updateOrgRepoSettings.mock.calls[0] as [{ input: unknown }];
    expect(call.input).toEqual({ members_can_create_repositories: true });
  });

  it('passes a missing token through so the service asks the caller to sign in again', async () => {
    mocks.getGitHubTokenForUser.mockResolvedValue(null);
    mocks.updateOrgRepoSettings.mockRejectedValue(
      new OrgRepoSettingsError('NO_GITHUB_TOKEN', 'Your GitHub sign-in has expired.')
    );
    await expect(
      orgRepoSettingsUpdateTool.handler({ ...BASE, members_can_create_repositories: false }, CTX)
    ).rejects.toMatchObject({ kind: 'forbidden', code: 'NO_GITHUB_TOKEN' });
    const [call] = mocks.updateOrgRepoSettings.mock.calls[0] as [{ userToken: unknown }];
    expect(call.userToken).toBeNull();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('reports a GitHub refusal as organization owners only', async () => {
    mocks.updateOrgRepoSettings.mockRejectedValue(
      new OrgRepoSettingsError(
        'NOT_ORG_OWNER',
        'Only GitHub organization owners can change these settings.'
      )
    );
    await expect(
      orgRepoSettingsUpdateTool.handler({ ...BASE, default_repository_permission: 'none' }, CTX)
    ).rejects.toMatchObject({
      kind: 'forbidden',
      code: 'NOT_ORG_OWNER',
      message: 'Only GitHub organization owners can change these settings.',
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('maps a missing organization or App installation to invalid_params', async () => {
    for (const code of ['NO_ORGANIZATION', 'APP_NOT_INSTALLED']) {
      mocks.updateOrgRepoSettings.mockRejectedValueOnce(new OrgRepoSettingsError(code, 'no'));
      await expect(
        orgRepoSettingsUpdateTool.handler({ ...BASE, members_can_create_repositories: false }, CTX)
      ).rejects.toMatchObject({ kind: 'invalid_params', code });
    }
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('maps other GitHub failures to internal', async () => {
    mocks.updateOrgRepoSettings.mockRejectedValue(
      new OrgRepoSettingsError('GITHUB_ERROR', "GitHub couldn't apply the change (boom).")
    );
    await expect(
      orgRepoSettingsUpdateTool.handler({ ...BASE, default_repository_permission: 'none' }, CTX)
    ).rejects.toMatchObject({ kind: 'internal', code: 'GITHUB_ERROR' });
  });

  it('enforces a strict permission enum', () => {
    const permission = orgRepoSettingsUpdateTool.inputSchema.default_repository_permission;
    for (const value of ['none', 'read', 'write']) {
      expect(permission.safeParse(value).success).toBe(true);
    }
    expect(permission.safeParse('admin').success).toBe(false);
    expect(permission.safeParse('READ').success).toBe(false);
  });

  it('is annotated openWorld and destructive (it changes the whole organization)', () => {
    expect(orgRepoSettingsUpdateTool.annotations?.openWorld).toBe(true);
    expect(orgRepoSettingsUpdateTool.annotations?.destructive).toBe(true);
  });

  it('requires confirm:true in the schema', () => {
    // The registry validates inputSchema before the handler runs, so the gate
    // lives in the schema: only the literal `true` is accepted.
    const confirm = orgRepoSettingsUpdateTool.inputSchema.confirm;
    expect(confirm.safeParse(true).success).toBe(true);
    expect(confirm.safeParse(false).success).toBe(false);
    expect(confirm.safeParse(undefined).success).toBe(false);
  });

  it('says in its description that the change is organization-wide, immediate and runs as the caller', () => {
    expect(orgRepoSettingsUpdateTool.description).toContain('IMMEDIATELY');
    expect(orgRepoSettingsUpdateTool.description).toContain('ORGANIZATION-WIDE');
    expect(orgRepoSettingsUpdateTool.description).toContain('own GitHub account');
    expect(orgRepoSettingsUpdateTool.description).toContain('owner of the GitHub organization');
  });

  it('keeps its description under 1,500 bytes', () => {
    expect(Buffer.byteLength(orgRepoSettingsUpdateTool.description, 'utf8')).toBeLessThan(1500);
  });

  it('audits against REPO_SETTINGS with old and new values after the GitHub write', async () => {
    mocks.updateOrgRepoSettings.mockResolvedValue({
      org: 'myorg',
      changes: { default_repository_permission: { from: 'read', to: 'none' } },
      settings: { default_repository_permission: 'none' },
      value: 'default_repository_permission=none',
    });
    await orgRepoSettingsUpdateTool.handler(
      { ...BASE, default_repository_permission: 'none' },
      CTX
    );
    const audit = mocks.auditCreate.mock.calls[0][0] as {
      resource_type: string;
      classroom_id: string;
      action: string;
      data: Record<string, unknown>;
    };
    expect(audit.resource_type).toBe('REPO_SETTINGS');
    expect(audit.classroom_id).toBe('class-1');
    expect(audit.action).toBe('UPDATE');
    expect(audit.data).toEqual({
      tool: 'org_repo_settings_update',
      org: 'myorg',
      changes: { default_repository_permission: { from: 'read', to: 'none' } },
      value: 'default_repository_permission=none',
    });
  });
});
