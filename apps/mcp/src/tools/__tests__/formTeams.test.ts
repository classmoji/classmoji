/**
 * Unit tests for the team-set tools — form_teams_get / form_teams_run /
 * form_teams_create.
 *
 * What is pinned, and why:
 *   - Tiers, through the REAL registry and SDK (in-memory transport): a TEACHER
 *     may read and run but not create; ASSISTANT and STUDENT reach none of the
 *     three; the OWNER reaches all; a multi-role member gets their highest
 *     role; a TEACHER in a LOCKED classroom may read but not run. Driving the
 *     registry also proves the input schemas convert for tools/list and
 *     validate a call.
 *   - The Pro gate runs first in every handler, reads included, before any
 *     form or team-set service call.
 *   - S1: a form from another classroom is indistinguishable from an unknown
 *     one, and the team-set service is never reached for it.
 *   - The user sees the setup first, structurally: the call that creates a set
 *     never starts a run (not even with start: true); check: true writes
 *     nothing; a second set needs new_set: true.
 *   - form_teams_create without confirm PREVIEWS ONLY: claimCreate is never
 *     called and the payload tells the agent to ask the user first.
 *   - Every save is audited at once — even when the run that follows fails —
 *     with a patch fingerprint so two quick edits stay two rows.
 *   - TeamSetError codes become fixed ToolErrors; the service's message text
 *     is never forwarded.
 *   - Payloads are allow-listed: a field the service adds (an email, say) does
 *     not reach the client; run responses name the set without its config.
 *
 * Only the service boundary and the platform Pro gate are mocked.
 */

import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { z } from 'zod';
import { ToolError } from '../../mcp/errors.ts';
import type { ToolContext, ToolDefinition } from '../../mcp/registry.ts';

const mocks = vi.hoisted(() => ({
  assertProTier: vi.fn(),
  formFindById: vi.fn(),
  auditCreate: vi.fn(),
  classroomFindAll: vi.fn(),
  membershipFind: vi.fn(),
  listForForm: vi.fn(),
  getSet: vi.fn(),
  suggestForForm: vi.fn(),
  saveConfig: vi.fn(),
  loadInputs: vi.fn(),
  checkPatch: vi.fn(),
  startRun: vi.fn(),
  getRun: vi.fn(),
  waitForRun: vi.fn(),
  listRuns: vi.fn(),
  describeRun: vi.fn(),
  previewCreate: vi.fn(),
  claimCreate: vi.fn(),
}));

vi.mock('@classmoji/auth/server', () => ({
  assertProTier: (...a: unknown[]) => mocks.assertProTier(...a),
}));

vi.mock('@classmoji/services', async () => {
  // The REAL config-patch schema (the tool validates `patch` with it), so the
  // registry tests below prove a realistic patch passes. Imported through its
  // own subpath: the barrel opens a Prisma client at module scope, and the
  // subpath is pure (zod + a slug helper). This mock intercepts only the root
  // specifier, so the subpath — which the tool also imports, for patch_help —
  // is the real module.
  const { TeamSetConfigPatchSchema } = await import('@classmoji/services/team-set-config');
  return {
    TeamSetConfigPatchSchema,
    ClassmojiService: {
      form: { findById: (...a: unknown[]) => mocks.formFindById(...a) },
      audit: { create: (...a: unknown[]) => mocks.auditCreate(...a) },
      classroom: {
        findAll: (...a: unknown[]) => mocks.classroomFindAll(...a),
        getClassroomForUI: (c: unknown) => c,
      },
      classroomMembership: {
        findByClassroomAndUser: (...a: unknown[]) => mocks.membershipFind(...a),
      },
      teamSet: {
        listForForm: (...a: unknown[]) => mocks.listForForm(...a),
        getSet: (...a: unknown[]) => mocks.getSet(...a),
        suggestForForm: (...a: unknown[]) => mocks.suggestForForm(...a),
        saveConfig: (...a: unknown[]) => mocks.saveConfig(...a),
        loadInputs: (...a: unknown[]) => mocks.loadInputs(...a),
        checkPatch: (...a: unknown[]) => mocks.checkPatch(...a),
        startRun: (...a: unknown[]) => mocks.startRun(...a),
        getRun: (...a: unknown[]) => mocks.getRun(...a),
        waitForRun: (...a: unknown[]) => mocks.waitForRun(...a),
        listRuns: (...a: unknown[]) => mocks.listRuns(...a),
        describeRun: (...a: unknown[]) => mocks.describeRun(...a),
        previewCreate: (...a: unknown[]) => mocks.previewCreate(...a),
        claimCreate: (...a: unknown[]) => mocks.claimCreate(...a),
      },
    },
  };
});

const { formTeamsGetTool, formTeamsRunTool, formTeamsCreateTool } = await import('../formTeams.ts');
const { buildMcpServer, registerToolDefinition, toolAnnotations } =
  await import('../../mcp/registry.ts');
const { resetRateLimits } = await import('../../mcp/rateLimit.ts');

const ALL_TOOLS = [formTeamsGetTool, formTeamsRunTool, formTeamsCreateTool] as unknown as Array<
  ToolDefinition<never>
>;

/** OWNER authorized in `class-1`, whose classroom slug is `w26`. */
const CTX: ToolContext = {
  viewer: { userId: 'owner-1', clientId: 'c', scopes: new Set(['read', 'write']) },
  classroom: {
    classroomId: 'class-1',
    role: 'OWNER',
    status: 'ACTIVE',
    membership: { id: 'm-1', role: 'OWNER' },
    classroom: { slug: 'w26', settings: {} },
  },
} as unknown as ToolContext;

const FORM_ID = '5a0c7d1e-2b3f-4a5b-8c6d-7e8f9a0b1c2d';
const FORM_ROW = {
  id: FORM_ID,
  classroom_id: 'class-1',
  slug: 'project-bids',
  access: 'CLASSROOM',
  current_revision_id: 'rev-1',
};
const FOREIGN_FORM = { ...FORM_ROW, classroom_id: 'class-2' };

const CONFIG = {
  version: 1,
  grouping: { mode: 'free' },
  team_size: { min: 3, max: 4, allow_one_larger: false },
};

const SET_ROW = {
  id: 'set-1',
  form_id: FORM_ID,
  name: 'project-bids-teams',
  config: CONFIG,
  tag_id: null,
  created_run_id: null,
  create_state: null,
};

const SUMMARY = {
  id: 'set-1',
  name: 'project-bids-teams',
  created: false,
  created_run_id: null,
  create_state: null,
  run_count: 7,
  latest_run: { id: 'run-7', number: 7, status: 'SOLVED', created_at: new Date() },
};

const RUN_ROW = {
  id: 'run-3',
  team_set_id: 'set-1',
  number: 3,
  status: 'QUEUED',
  metrics: null,
  result: null,
  error: null,
  created_at: new Date('2026-09-24T12:00:00.000Z'),
};

const METRICS = {
  people: 6,
  responded: 5,
  teams: 2,
  options_open: 1,
  options_total: 1,
  placement: { '1': 4, '2': 1, '3': 0, '4': 0, '5+': 0, fallback: 0, missed: 0, no_answer: 1 },
  first_choice: 4,
  top2: 5,
  requests: { total: 3, kept: 2, mutual_pairs: 1, mutual_pairs_kept: 1 },
  avoids: { total: 2, broken: 0 },
  must_broken: 0,
};

/** A run view as describeRun returns it — plus two keys that must not ship. */
const RUN_VIEW = {
  id: 'run-3',
  number: 3,
  status: 'SOLVED',
  error: null,
  created_at: '2026-09-24T12:00:00.000Z',
  finished_at: '2026-09-24T12:00:02.000Z',
  solver: { status: 'OPTIMAL', objective: 120, bound: 120, wall_s: 1.5 },
  metrics: METRICS,
  stale: false,
  stale_reasons: [],
  issues: [],
  core: [],
  summary: null,
  debug_trace: 'INTERNAL-TRACE',
  teams: [
    {
      n: 1,
      name: 'project-bids-teams-01',
      option: null,
      size: 1,
      members: [
        {
          user_id: 'u-1',
          name: 'Avery Quill',
          login: 'aquill',
          email: 'avery.quill@example.edu',
          placement: '1',
          requests_kept: 1,
          requests_total: 1,
          notes: [{ field_label: 'Anything else?', text: 'Prefers mornings' }],
        },
      ],
    },
  ],
};

const PREVIEW = {
  run_id: 'run-3',
  run_number: 3,
  tag: { name: 'project-bids-teams', exists: false },
  github_teams: true,
  teams: [
    {
      name: 'project-bids-teams-01',
      option: null,
      members: [
        { user_id: 'u-1', name: 'Avery Quill', login: 'aquill', email: 'avery.quill@example.edu' },
      ],
    },
  ],
  warnings: ['1 person has no GitHub login and cannot be added to a GitHub team.'],
};

/** A TeamSetError as the service throws it (matched structurally). */
function teamSetError(code: string, message: string, details?: unknown) {
  const error = new Error(message) as Error & { code: string; details?: unknown };
  error.name = 'TeamSetError';
  error.code = code;
  if (details !== undefined) error.details = details;
  return error;
}

function parse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

const proDenial = () => new Response('This feature requires a Pro subscription', { status: 403 });

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  resetRateLimits();
  mocks.assertProTier.mockResolvedValue(undefined);
  mocks.auditCreate.mockResolvedValue(undefined);
  mocks.formFindById.mockResolvedValue(FORM_ROW);
  mocks.listForForm.mockResolvedValue([]);
  mocks.getSet.mockResolvedValue(null);
  mocks.saveConfig.mockResolvedValue({ ...SET_ROW, notes: [] });
  mocks.checkPatch.mockResolvedValue({
    set: null,
    name: 'project-bids-teams',
    config: CONFIG,
    notes: [],
    issues: [],
  });
  mocks.startRun.mockResolvedValue({ run: RUN_ROW, issues: [] });
  mocks.waitForRun.mockResolvedValue({ ...RUN_ROW, status: 'SOLVED', metrics: METRICS });
  mocks.describeRun.mockResolvedValue(RUN_VIEW);
  mocks.getRun.mockResolvedValue({ ...RUN_ROW, status: 'SOLVED', result: { teams: [{}, {}] } });
  mocks.previewCreate.mockResolvedValue(PREVIEW);
  mocks.claimCreate.mockResolvedValue(undefined);
  mocks.listRuns.mockResolvedValue([]);
  mocks.loadInputs.mockResolvedValue({ responses: [], roster: [] });
});

// ─── Definitions ────────────────────────────────────────────────────────────

describe('team-set tool definitions', () => {
  it('gives get and run the forms tier and create the owner tier', () => {
    expect(formTeamsGetTool.roles).toEqual(['OWNER', 'TEACHER']);
    expect(formTeamsRunTool.roles).toEqual(['OWNER', 'TEACHER']);
    expect(formTeamsCreateTool.roles).toEqual(['OWNER']);
    for (const tool of ALL_TOOLS) {
      expect(tool.roles).not.toContain('ASSISTANT');
      expect(tool.roles).not.toContain('STUDENT');
      expect(tool.inputSchema).toHaveProperty('classroom');
    }
  });

  it('declares honest annotations', () => {
    expect(toolAnnotations(formTeamsGetTool as never)).toEqual({
      readOnlyHint: true,
      openWorldHint: false,
    });
    // A run is a proposal: nothing removed, nothing outside the database.
    expect(toolAnnotations(formTeamsRunTool as never)).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
    // Create mints GitHub teams and has no undo.
    expect(toolAnnotations(formTeamsCreateTool as never)).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
  });

  it('sizes run and create buckets for iteration (checks and previews spend the same bucket)', () => {
    expect(formTeamsRunTool.rateLimit).toEqual({ capacity: 30, refillPerSecond: 0.5 });
    expect(formTeamsCreateTool.rateLimit).toEqual({ capacity: 12, refillPerSecond: 0.1 });
  });

  it('bounds wait_s to 0..45 and takes only confirm: true', () => {
    const wait = formTeamsRunTool.inputSchema.wait_s as z.ZodTypeAny;
    expect(wait.safeParse(0).success).toBe(true);
    expect(wait.safeParse(45).success).toBe(true);
    expect(wait.safeParse(46).success).toBe(false);
    expect(wait.safeParse(-1).success).toBe(false);
    const confirm = formTeamsCreateTool.inputSchema.confirm as z.ZodTypeAny;
    expect(confirm.safeParse(true).success).toBe(true);
    expect(confirm.safeParse(undefined).success).toBe(true);
    expect(confirm.safeParse(false).success).toBe(false);
  });

  /** Same 1,500-byte ceiling forms.test.ts guards — the connector DROPS a tool over it. */
  it('keeps every description under 1,500 UTF-8 bytes', () => {
    for (const tool of ALL_TOOLS) {
      expect(new TextEncoder().encode(tool.description).length, tool.name).toBeLessThan(1500);
    }
  });

  it('tells the agent to show the user the setup, to poll, and to ask before creating', () => {
    expect(formTeamsRunTool.description).toMatch(/only saves it and never runs/);
    expect(formTeamsRunTool.description).toMatch(/show the user the setup/);
    expect(formTeamsRunTool.description).toMatch(/poll with form_teams_get; don’t start another/);
    expect(formTeamsRunTool.description).toMatch(/check: true saves and starts nothing/);
    expect(formTeamsCreateTool.description).toMatch(/ALWAYS show the user that preview/);
    expect(formTeamsCreateTool.description).toMatch(/explicit approval/);
  });

  it('is registered in the tool manifest', () => {
    const manifest = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    for (const name of ['formTeamsGetTool', 'formTeamsRunTool', 'formTeamsCreateTool']) {
      expect(manifest).toContain(`registerToolDefinition(${name})`);
    }
  });
});

// ─── Tiers through the real registry ────────────────────────────────────────

describe('role tiers (through the registry)', () => {
  beforeAll(() => {
    for (const tool of ALL_TOOLS) registerToolDefinition(tool);
  });

  const REF = 'dev-org/w26';

  /** The caller holds every role in `roles` in class-1, which has `status`. */
  function asMember(roles: string | string[], status = 'ACTIVE') {
    const held = Array.isArray(roles) ? roles : [roles];
    mocks.classroomFindAll.mockResolvedValue([{ id: 'class-1', status, slug: 'w26' }]);
    mocks.membershipFind.mockImplementation(
      async (_classroomId: string, _userId: string, wanted: string[] | null) => {
        const match = wanted ? held.find(role => wanted.includes(role)) : held[0];
        return match ? { id: `m-${match}`, role: match } : null;
      }
    );
  }

  async function connect() {
    const server = buildMcpServer({
      userId: 'user-1',
      clientId: 'test-client',
      scopes: new Set(['read', 'write']),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'form-teams-test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return client;
  }

  async function call(client: Client, name: string, args: Record<string, unknown>) {
    return (await client.callTool({ name, arguments: args })) as unknown as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
  }

  const GET_ARGS = { classroom: REF, form_id: FORM_ID };
  const RUN_ARGS = { classroom: REF, form_id: FORM_ID, patch: { fairness: 60 }, wait_s: 0 };
  const CREATE_ARGS = { classroom: REF, form_id: FORM_ID, run: 3 };

  it('lists all three with converted input schemas', async () => {
    asMember('OWNER');
    const client = await connect();
    const { tools } = await client.listTools();
    const names = tools.map(tool => tool.name);
    expect(names).toEqual(
      expect.arrayContaining(['form_teams_get', 'form_teams_run', 'form_teams_create'])
    );
    const run = tools.find(tool => tool.name === 'form_teams_run');
    expect(run?.inputSchema.properties).toHaveProperty('patch');
    expect(run?.inputSchema.properties).toHaveProperty('wait_s');
    expect(run?.inputSchema.properties).toHaveProperty('new_set');
  });

  it('lets a TEACHER read and run but not create', async () => {
    asMember('TEACHER');
    const client = await connect();

    expect((await call(client, 'form_teams_get', GET_ARGS)).isError).toBeFalsy();
    expect((await call(client, 'form_teams_run', RUN_ARGS)).isError).toBeFalsy();

    const denied = await call(client, 'form_teams_create', CREATE_ARGS);
    expect(denied.isError).toBe(true);
    expect(parse(denied)).toMatchObject({ error: 'forbidden', code: 'INSUFFICIENT_ROLE' });
    expect(mocks.previewCreate).not.toHaveBeenCalled();
    expect(mocks.claimCreate).not.toHaveBeenCalled();
  });

  it('lets the OWNER preview a create', async () => {
    asMember('OWNER');
    mocks.getSet.mockResolvedValue(SET_ROW);
    const client = await connect();
    const result = await call(client, 'form_teams_create', CREATE_ARGS);
    expect(result.isError).toBeFalsy();
    expect(parse(result).created).toBe(false);
  });

  it('gives a multi-role member their highest role', async () => {
    // ASSISTANT + TEACHER: the teacher may run, and still may not create.
    asMember(['ASSISTANT', 'TEACHER']);
    let client = await connect();
    expect((await call(client, 'form_teams_run', RUN_ARGS)).isError).toBeFalsy();
    expect((await call(client, 'form_teams_create', CREATE_ARGS)).isError).toBe(true);

    // STUDENT + OWNER: the owner may create.
    asMember(['STUDENT', 'OWNER']);
    mocks.getSet.mockResolvedValue(SET_ROW);
    client = await connect();
    const preview = await call(client, 'form_teams_create', CREATE_ARGS);
    expect(preview.isError).toBeFalsy();
    expect(mocks.previewCreate).toHaveBeenCalledTimes(1);
  });

  it('lets a TEACHER in a LOCKED classroom read but not run', async () => {
    asMember('TEACHER', 'LOCKED');
    const client = await connect();
    expect((await call(client, 'form_teams_get', GET_ARGS)).isError).toBeFalsy();
    const refused = await call(client, 'form_teams_run', RUN_ARGS);
    expect(refused.isError).toBe(true);
    expect(parse(refused)).toMatchObject({ error: 'forbidden', code: 'CLASSROOM_LOCKED' });
    expect(mocks.saveConfig).not.toHaveBeenCalled();
    expect(mocks.startRun).not.toHaveBeenCalled();
  });

  it('denies ASSISTANT and STUDENT on all three before any service call', async () => {
    for (const role of ['ASSISTANT', 'STUDENT']) {
      asMember(role);
      const client = await connect();
      for (const [name, args] of [
        ['form_teams_get', GET_ARGS],
        ['form_teams_run', RUN_ARGS],
        ['form_teams_create', CREATE_ARGS],
      ] as const) {
        const result = await call(client, name, args);
        expect(result.isError, `${role} → ${name}`).toBe(true);
        expect(parse(result).error).toBe('forbidden');
      }
    }
    expect(mocks.formFindById).not.toHaveBeenCalled();
    expect(mocks.saveConfig).not.toHaveBeenCalled();
    expect(mocks.startRun).not.toHaveBeenCalled();
  });

  it('advertises patch as a plain object, not the full config schema', async () => {
    asMember('OWNER');
    const client = await connect();
    const { tools } = await client.listTools();
    const run = tools.find(tool => tool.name === 'form_teams_run');
    const patch = (run?.inputSchema.properties as Record<string, Record<string, unknown>>).patch;
    expect(patch.type).toBe('object');
    expect(patch).not.toHaveProperty('properties');
    expect(patch.description).toMatch(/form_teams_get/);
    expect(JSON.stringify(run?.inputSchema)).not.toContain('$ref');
  });

  it('refuses a malformed patch with its issue list, before anything is read', async () => {
    asMember('OWNER');
    const client = await connect();
    const result = await call(client, 'form_teams_run', {
      ...RUN_ARGS,
      patch: { not_a_setting: true, fairness: 500, team_size: { min: 'three' } },
    });
    expect(result.isError).toBe(true);
    const error = parse(result);
    expect(error).toMatchObject({ error: 'invalid_params', code: 'invalid_config' });
    expect(error.problems).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^patch: .*not_a_setting/),
        expect.stringMatching(/^patch\.fairness: /),
        expect.stringMatching(/^patch\.team_size\.min: /),
      ])
    );
    expect(mocks.formFindById).not.toHaveBeenCalled();
    expect(mocks.saveConfig).not.toHaveBeenCalled();
  });

  it('caps the issue list at ten', async () => {
    const upsert = Array.from({ length: 15 }, () => ({ field_id: 'not-a-uuid', job: 'rank' }));
    const error = (await formTeamsRunTool
      .handler({ classroom: 'org/w26', form_id: FORM_ID, patch: { rules: { upsert } } }, CTX)
      .catch(e => e)) as ToolError;
    expect(error.code).toBe('invalid_config');
    const problems = error.data?.problems as string[];
    expect(problems).toHaveLength(11);
    expect(problems[10]).toBe('…and 5 more');
  });

  it('carries a realistic patch (rules, pins, options) through to saveConfig', async () => {
    asMember('TEACHER');
    const client = await connect();
    const patch = {
      team_size: { min: 3, max: 4 },
      rules: {
        upsert: [
          {
            field_id: '0b6d7c1e-9a3f-4d2b-8e1f-2a3b4c5d6e7f',
            job: 'rank',
            strength: 'prefer',
            weight: 8,
          },
        ],
        remove: [{ field_id: '1c7e8d2f-0b4a-4e3c-9f2a-3b4c5d6e7f80', job: 'note' }],
      },
      pins: {
        add: [
          {
            kind: 'apart',
            user_ids: [
              '2d8f9e3a-1c5b-4f4d-8a3b-4c5d6e7f8091',
              '3e9a0f4b-2d6c-4a5e-9b4c-5d6e7f8091a2',
            ],
            reason: 'Asked not to be paired',
          },
        ],
      },
      options: { 'opt-1': { open: 'open' }, 'opt-2': null },
    };
    const result = await call(client, 'form_teams_run', { ...RUN_ARGS, patch, start: false });
    expect(result.isError).toBeFalsy();
    // The tool hands saveConfig the PARSED patch, so the schema's defaults
    // arrive filled in (team_size is replaced whole, as applyConfigPatch does).
    expect(mocks.saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        patch: { ...patch, team_size: { min: 3, max: 4, allow_one_larger: false } },
      })
    );
  });
});

// ─── Pro gate ───────────────────────────────────────────────────────────────

describe('Pro gating', () => {
  const ARGS = { classroom: 'org/w26', form_id: FORM_ID, run: 3, confirm: true };

  it('denies all three — the read included — before any service call', async () => {
    for (const tool of ALL_TOOLS) {
      for (const m of Object.values(mocks)) m.mockClear();
      mocks.assertProTier.mockRejectedValue(proDenial());

      const error = await tool.handler(ARGS as never, CTX).catch(e => e);

      expect(error, tool.name).toBeInstanceOf(ToolError);
      expect((error as ToolError).kind).toBe('forbidden');
      expect(mocks.formFindById).not.toHaveBeenCalled();
      for (const name of [
        'listForForm',
        'getSet',
        'saveConfig',
        'checkPatch',
        'startRun',
        'previewCreate',
        'claimCreate',
      ] as const) {
        expect(mocks[name], `${tool.name} → ${name}`).not.toHaveBeenCalled();
      }
    }
  });

  it('asks the gate about the AUTHORIZED classroom slug', async () => {
    await formTeamsGetTool.handler({ classroom: 'other/elsewhere', form_id: FORM_ID }, CTX);
    expect(mocks.assertProTier).toHaveBeenCalledWith('w26');
  });
});

// ─── S1 ─────────────────────────────────────────────────────────────────────

describe('cross-classroom scoping (S1)', () => {
  it('refuses another classroom’s form exactly like an unknown one', async () => {
    for (const tool of ALL_TOOLS) {
      for (const row of [FOREIGN_FORM, null]) {
        for (const m of Object.values(mocks)) m.mockClear();
        mocks.formFindById.mockResolvedValue(row);

        const error = await tool
          .handler({ classroom: 'org/w26', form_id: FORM_ID, run: 3, confirm: true } as never, CTX)
          .catch(e => e);

        expect(error, tool.name).toBeInstanceOf(ToolError);
        expect((error as ToolError).kind).toBe('not_found');
        expect((error as ToolError).message).toBe('Form not found in this classroom');
        expect(mocks.getSet).not.toHaveBeenCalled();
        expect(mocks.listForForm).not.toHaveBeenCalled();
        expect(mocks.saveConfig).not.toHaveBeenCalled();
        expect(mocks.claimCreate).not.toHaveBeenCalled();
      }
    }
  });

  it('hands the service the AUTHORIZED classroom id and viewer', async () => {
    mocks.getSet.mockResolvedValue(SET_ROW);
    await formTeamsRunTool.handler({ classroom: 'other/elsewhere', form_id: FORM_ID }, CTX);
    expect(mocks.saveConfig).toHaveBeenCalledWith({
      classroomId: 'class-1',
      formId: FORM_ID,
      setRef: 'set-1',
      userId: 'owner-1',
    });
    expect(mocks.startRun).toHaveBeenCalledWith({
      classroomId: 'class-1',
      teamSetId: 'set-1',
      userId: 'owner-1',
    });
  });
});

// ─── form_teams_run ─────────────────────────────────────────────────────────

describe('form_teams_run — a new set shows its setup first', () => {
  const BASE = { classroom: 'org/w26', form_id: FORM_ID };

  it('saves a new set and returns its setup without running', async () => {
    const payload = parse(
      await formTeamsRunTool.handler({ ...BASE, patch: { fairness: 70 }, name: 'bids' }, CTX)
    );
    // "Is this set new?" is asked the way saveConfig picks its set: by name here.
    expect(mocks.getSet).toHaveBeenCalledWith({
      classroomId: 'class-1',
      formId: FORM_ID,
      setRef: 'bids',
    });
    expect(mocks.saveConfig).toHaveBeenCalledWith({
      classroomId: 'class-1',
      formId: FORM_ID,
      name: 'bids',
      patch: { fairness: 70 },
      userId: 'owner-1',
    });
    expect(mocks.startRun).not.toHaveBeenCalled();
    expect(payload).toMatchObject({
      set_created: true,
      started: false,
      team_set: {
        id: 'set-1',
        name: 'project-bids-teams',
        config: CONFIG,
        create_status: 'none',
        create_state: null,
      },
    });
    expect(payload.next).toMatch(/Show the user this setup/);
    expect(payload).not.toHaveProperty('start_refused');
    // A new set is a write: audited as a CREATE of the set, with a patch fingerprint.
    expect(mocks.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        resource_type: 'TEAM_SETS',
        resource_id: 'set-1',
        action: 'CREATE',
        data: expect.objectContaining({
          tool: 'form_teams_run',
          patched: ['fairness'],
          value: expect.stringMatching(/^[0-9a-f]{12}$/),
        }),
      })
    );
  });

  it('never runs on the creating call, even with start: true', async () => {
    const payload = parse(await formTeamsRunTool.handler({ ...BASE, start: true }, CTX));
    expect(mocks.saveConfig).toHaveBeenCalledTimes(1);
    expect(mocks.startRun).not.toHaveBeenCalled();
    expect(payload).toMatchObject({ set_created: true, started: false });
    expect(payload.start_refused).toMatch(/never run on the call that creates it/);
  });

  it('refuses to make a second set implicitly', async () => {
    mocks.listForForm.mockResolvedValue([SUMMARY]);
    const error = (await formTeamsRunTool
      .handler({ ...BASE, name: 'pairs' }, CTX)
      .catch(e => e)) as ToolError;
    expect(error.kind).toBe('invalid_params');
    expect(error.code).toBe('new_set_required');
    expect(error.data).toEqual({ team_sets: ['project-bids-teams'] });
    expect(mocks.saveConfig).not.toHaveBeenCalled();

    // …and makes it on request, still without running it.
    const payload = parse(
      await formTeamsRunTool.handler({ ...BASE, name: 'pairs', new_set: true }, CTX)
    );
    expect(mocks.saveConfig).toHaveBeenCalledWith(expect.objectContaining({ name: 'pairs' }));
    expect(payload.set_created).toBe(true);
    expect(mocks.startRun).not.toHaveBeenCalled();
  });

  it('refuses new_set for a name that exists, and new_set without a name', async () => {
    mocks.getSet.mockResolvedValue(SET_ROW);
    const exists = (await formTeamsRunTool
      .handler({ ...BASE, name: 'project-bids-teams', new_set: true }, CTX)
      .catch(e => e)) as ToolError;
    expect(exists.code).toBe('set_exists');

    const nameless = (await formTeamsRunTool
      .handler({ ...BASE, new_set: true }, CTX)
      .catch(e => e)) as ToolError;
    expect(nameless.code).toBe('invalid_config');
    expect(mocks.saveConfig).not.toHaveBeenCalled();
  });

  it('relays what a patch did beyond what it said', async () => {
    mocks.saveConfig.mockResolvedValue({
      ...SET_ROW,
      notes: [
        'Dropped the settings of 2 option(s): they belonged to the previous grouping question.',
      ],
    });
    const payload = parse(await formTeamsRunTool.handler(BASE, CTX));
    expect(payload.notes).toEqual([
      'Dropped the settings of 2 option(s): they belonged to the previous grouping question.',
    ]);
  });
});

describe('form_teams_run — check writes nothing', () => {
  const BASE = { classroom: 'org/w26', form_id: FORM_ID };

  it('checks a patch in memory: no save, no set, no run, no audit — even with start: true', async () => {
    mocks.getSet.mockResolvedValue(SET_ROW);
    mocks.checkPatch.mockResolvedValue({
      set: { id: 'set-1', name: 'project-bids-teams' },
      name: 'project-bids-teams',
      config: CONFIG,
      notes: [],
      issues: [
        { level: 'error', code: 'capacity', message: 'Too many people for the slots', extra: 'x' },
        {
          level: 'error',
          code: 'model_too_large',
          message: 'This setup is too large to solve',
          srcs: ['a:match'],
        },
      ],
    });
    const payload = parse(
      await formTeamsRunTool.handler(
        { ...BASE, check: true, start: true, patch: { fairness: 10 } },
        CTX
      )
    );
    expect(mocks.checkPatch).toHaveBeenCalledWith({
      classroomId: 'class-1',
      formId: FORM_ID,
      setRef: 'set-1',
      patch: { fairness: 10 },
    });
    expect(mocks.saveConfig).not.toHaveBeenCalled();
    expect(mocks.startRun).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
    expect(payload).toMatchObject({ checked: true, saved: false, started: false, config: CONFIG });
    expect(payload.issues).toEqual([
      { level: 'error', code: 'capacity', message: 'Too many people for the slots' },
      {
        level: 'error',
        code: 'model_too_large',
        message: 'This setup is too large to solve',
        hint: expect.stringMatching(/match or mix/),
        srcs: ['a:match'],
      },
    ]);
    expect(payload.next).toMatch(/Blocking problems/);
  });

  it('checks the would-be first set from the suggestion (no set exists)', async () => {
    const payload = parse(await formTeamsRunTool.handler({ ...BASE, check: true }, CTX));
    expect(mocks.checkPatch).toHaveBeenCalledWith({ classroomId: 'class-1', formId: FORM_ID });
    expect(payload.team_set).toBeNull();
    expect(mocks.saveConfig).not.toHaveBeenCalled();
  });
});

describe('form_teams_run — an existing set', () => {
  const BASE = { classroom: 'org/w26', form_id: FORM_ID };

  beforeEach(() => {
    mocks.getSet.mockResolvedValue(SET_ROW);
  });

  it('audits the save at once, even when the run that follows fails', async () => {
    mocks.startRun.mockRejectedValue(new Error('database went away'));
    const error = await formTeamsRunTool
      .handler({ ...BASE, patch: { fairness: 70 } }, CTX)
      .catch(e => e);
    expect(error).toBeInstanceOf(Error);
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
    expect(mocks.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        resource_id: 'set-1',
        action: 'UPDATE',
        data: expect.objectContaining({ patched: ['fairness'] }),
      })
    );
  });

  it('fingerprints each patch, so two quick edits are two audit rows', async () => {
    await formTeamsRunTool.handler({ ...BASE, patch: { fairness: 10 }, start: false }, CTX);
    await formTeamsRunTool.handler({ ...BASE, patch: { fairness: 90 }, start: false }, CTX);
    const values = mocks.auditCreate.mock.calls.map(
      ([row]) => (row as { data: { value: string } }).data.value
    );
    expect(values).toHaveLength(2);
    expect(values[0]).not.toBe(values[1]);
  });

  it('with start: false saves and returns the setup', async () => {
    const payload = parse(await formTeamsRunTool.handler({ ...BASE, start: false }, CTX));
    expect(mocks.startRun).not.toHaveBeenCalled();
    expect(payload).toMatchObject({
      set_created: false,
      started: false,
      team_set: { id: 'set-1', config: CONFIG },
    });
    // Nothing changed (existing set, no patch) → no audit row.
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('returns blocking issues (with names and hints) when the service refuses to start', async () => {
    mocks.startRun.mockResolvedValue({
      run: null,
      issues: [
        { level: 'error', code: 'pin_conflict', message: 'Two pins collide', srcs: ['pin:p1'] },
        {
          level: 'warning',
          code: 'odd_group_in_pairs',
          message: '3 people must not be alone',
          user_ids: ['u-1'],
          names: ['Avery Quill'],
        },
      ],
    });
    const payload = parse(await formTeamsRunTool.handler(BASE, CTX));
    expect(payload.started).toBe(false);
    expect(payload.team_set).toEqual({ id: 'set-1', name: 'project-bids-teams' });
    expect(payload.issues[0]).toEqual({
      level: 'error',
      code: 'pin_conflict',
      message: 'Two pins collide',
      srcs: ['pin:p1'],
    });
    expect(payload.issues[1]).toMatchObject({
      code: 'odd_group_in_pairs',
      hint: expect.stringMatching(/allow_one_larger/),
      names: ['Avery Quill'],
    });
    expect(mocks.waitForRun).not.toHaveBeenCalled();
  });

  it('waits, then returns the allow-listed run view with people and a next step', async () => {
    const payload = parse(await formTeamsRunTool.handler({ ...BASE, wait_s: 20 }, CTX));
    const { timeoutMs } = mocks.waitForRun.mock.calls[0]![0] as { timeoutMs: number };
    expect(timeoutMs).toBeLessThanOrEqual(20_000);
    expect(timeoutMs).toBeGreaterThan(19_000);
    expect(mocks.describeRun).toHaveBeenCalledWith(
      expect.objectContaining({ classroomId: 'class-1', includePeople: true })
    );
    expect(payload.started).toBe(true);
    // The set is named, not re-sent: its config belongs to the setup view.
    expect(payload.team_set).toEqual({ id: 'set-1', name: 'project-bids-teams' });
    expect(payload.run.number).toBe(3);
    expect(payload.run.metrics.avoids).toEqual({ total: 2, broken: 0 });
    expect(payload.run.next).toMatch(/form_teams_create \(run: 3\)/);
    expect(payload.run.teams[0].members[0]).toEqual({
      user_id: 'u-1',
      name: 'Avery Quill',
      login: 'aquill',
      placement: '1',
      requests_kept: 1,
      requests_total: 1,
      notes: [{ field_label: 'Anything else?', text: 'Prefers mornings' }],
    });
    const json = JSON.stringify(payload);
    expect(json).not.toContain('avery.quill@example.edu');
    expect(json).not.toContain('INTERNAL-TRACE');

    // The start is audited against the RUN, so two quick runs stay two rows.
    expect(mocks.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        resource_type: 'TEAM_SETS',
        resource_id: 'run-3',
        action: 'CREATE',
        data: expect.objectContaining({ tool: 'form_teams_run', run_number: 3 }),
      })
    );
  });

  it('budgets the wait from handler entry, within 45 seconds in all', async () => {
    await formTeamsRunTool.handler(BASE, CTX);
    const first = (mocks.waitForRun.mock.calls[0]![0] as { timeoutMs: number }).timeoutMs;
    expect(first).toBeLessThanOrEqual(40_000);
    expect(first).toBeGreaterThan(39_000);

    // Even the longest wait leaves room to describe the result inside 45 s.
    await formTeamsRunTool.handler({ ...BASE, wait_s: 45 }, CTX);
    const longest = (mocks.waitForRun.mock.calls[1]![0] as { timeoutMs: number }).timeoutMs;
    expect(longest).toBeLessThanOrEqual(42_000);

    // Time spent before the wait (here, a slow save) comes out of it.
    mocks.saveConfig.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 150));
      return { ...SET_ROW, notes: [] };
    });
    await formTeamsRunTool.handler({ ...BASE, wait_s: 1 }, CTX);
    const squeezed = (mocks.waitForRun.mock.calls[2]![0] as { timeoutMs: number }).timeoutMs;
    expect(squeezed).toBeLessThanOrEqual(850);
  });

  it('returns the run number to poll when the solve outlasts the wait', async () => {
    mocks.waitForRun.mockResolvedValue({ ...RUN_ROW, status: 'RUNNING' });
    const payload = parse(await formTeamsRunTool.handler(BASE, CTX));
    expect(payload.run).toEqual({ number: 3, status: 'RUNNING' });
    expect(payload.next).toMatch(/form_teams_get with run: 3; don't start another run/);
    expect(mocks.describeRun).not.toHaveBeenCalled();
  });

  it('does not wait at all with wait_s: 0', async () => {
    const payload = parse(await formTeamsRunTool.handler({ ...BASE, wait_s: 0 }, CTX));
    expect(mocks.waitForRun).not.toHaveBeenCalled();
    expect(payload.run).toEqual({ number: 3, status: 'QUEUED' });
  });

  it('says what to do next for each way a run can end', async () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ status: 'SOLVED', stale: true }, /start a new run before creating/],
      [{ status: 'INFEASIBLE', summary: 'They collide.' }, /relax or remove one of those in core/],
      [{ status: 'FAILED', error: 'no_solution_in_time' }, /raise time_limit_s/],
      [{ status: 'FAILED', error: 'lost' }, /start a new run/],
      [{ status: 'FAILED', error: 'queue_expired' }, /waited too long to start; start a new run/],
      [{ status: 'CANCELED' }, /canceled/],
    ];
    for (const [overrides, next] of cases) {
      mocks.describeRun.mockResolvedValue({ ...RUN_VIEW, teams: [], ...overrides });
      const payload = parse(await formTeamsRunTool.handler(BASE, CTX));
      expect(payload.run.next, JSON.stringify(overrides)).toMatch(next);
      if (overrides.summary) expect(payload.run.summary).toBe('They collide.');
    }
  });
});

// ─── form_teams_create ──────────────────────────────────────────────────────

describe('form_teams_create', () => {
  const BASE = { classroom: 'org/w26', form_id: FORM_ID, run: 3 };

  beforeEach(() => {
    mocks.getSet.mockResolvedValue(SET_ROW);
  });

  it('without confirm previews, creates nothing and says to ask the user', async () => {
    const payload = parse(await formTeamsCreateTool.handler(BASE, CTX));
    expect(mocks.previewCreate).toHaveBeenCalledWith({
      classroomId: 'class-1',
      teamSetId: 'set-1',
      runRef: 3,
    });
    expect(mocks.claimCreate).not.toHaveBeenCalled();
    expect(mocks.getRun).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
    expect(payload.created).toBe(false);
    expect(payload.notice).toBe(
      'Nothing was created. Show this to the user and call again with confirm: true only after they approve.'
    );
    expect(payload.preview.teams[0].members[0]).toEqual({
      user_id: 'u-1',
      name: 'Avery Quill',
      login: 'aquill',
    });
    expect(payload.preview).not.toHaveProperty('retry');
    expect(JSON.stringify(payload)).not.toContain('avery.quill@example.edu');
  });

  it('says when a preview is a retry of a failed create', async () => {
    mocks.previewCreate.mockResolvedValue({
      ...PREVIEW,
      retry: { attempt: 2, teams_already_created: 5, internal: 'x' },
    });
    const payload = parse(await formTeamsCreateTool.handler(BASE, CTX));
    expect(payload.preview.retry).toEqual({ attempt: 2, teams_already_created: 5 });
  });

  it('with confirm claims the create and audits it', async () => {
    const payload = parse(await formTeamsCreateTool.handler({ ...BASE, confirm: true }, CTX));
    expect(mocks.claimCreate).toHaveBeenCalledWith({
      classroomId: 'class-1',
      teamSetId: 'set-1',
      runId: 'run-3',
      userId: 'owner-1',
    });
    expect(payload).toMatchObject({ started: true, teams: 2 });
    expect(payload.next).toMatch(/form_teams_get/);
    expect(mocks.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        resource_type: 'TEAM_SETS',
        resource_id: 'set-1',
        action: 'CREATE',
        data: expect.objectContaining({ tool: 'form_teams_create', run_number: 3, teams: 2 }),
      })
    );
  });

  it('refuses when the form has no team set', async () => {
    mocks.getSet.mockResolvedValue(null);
    const error = await formTeamsCreateTool.handler(BASE, CTX).catch(e => e);
    expect((error as ToolError).kind).toBe('not_found');
    expect(mocks.previewCreate).not.toHaveBeenCalled();
  });
});

// ─── Error mapping ──────────────────────────────────────────────────────────

describe('TeamSetError mapping', () => {
  const BASE = { classroom: 'org/w26', form_id: FORM_ID, run: 3 };

  beforeEach(() => {
    mocks.getSet.mockResolvedValue(SET_ROW);
  });

  it('maps a refusal to a fixed message, never the service’s text', async () => {
    mocks.previewCreate.mockRejectedValue(
      teamSetError('run_stale', 'stale: response 9f3c… updated_at moved (db row 1234)')
    );
    const error = (await formTeamsCreateTool.handler(BASE, CTX).catch(e => e)) as ToolError;
    expect(error).toBeInstanceOf(ToolError);
    expect(error.kind).toBe('invalid_params');
    expect(error.code).toBe('run_stale');
    expect(error.message).toBe('Answers or the roster changed since this run; start a new run');
    expect(error.message).not.toContain('db row');
  });

  it('forwards a config problem list as structured data', async () => {
    mocks.saveConfig.mockRejectedValue(
      teamSetError('invalid_config', 'raw', { problems: ['team_size.min must be ≤ max', 42] })
    );
    const error = (await formTeamsRunTool
      .handler({ classroom: 'org/w26', form_id: FORM_ID }, CTX)
      .catch(e => e)) as ToolError;
    expect(error.kind).toBe('invalid_params');
    expect(error.code).toBe('invalid_config');
    expect(error.data).toEqual({ problems: ['team_size.min must be ≤ max'] });
  });

  it('maps trigger_unavailable to internal', async () => {
    mocks.claimCreate.mockRejectedValue(
      teamSetError('trigger_unavailable', 'no TRIGGER_SECRET_KEY')
    );
    const error = (await formTeamsCreateTool
      .handler({ ...BASE, confirm: true }, CTX)
      .catch(e => e)) as ToolError;
    expect(error.kind).toBe('internal');
    expect(error.message).not.toContain('TRIGGER_SECRET_KEY');
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('forwards staleness reasons, and nothing else the service attached', async () => {
    mocks.previewCreate.mockRejectedValue(
      teamSetError('run_stale', 'raw', {
        reasons: ['2 new responses came in.'],
        snapshot: { secret: true },
      })
    );
    const error = (await formTeamsCreateTool.handler(BASE, CTX).catch(e => e)) as ToolError;
    expect(error.data).toEqual({ reasons: ['2 new responses came in.'] });
  });

  it('names the colliding team names, and refuses an unreachable GitHub org', async () => {
    mocks.previewCreate.mockRejectedValueOnce(
      teamSetError('name_collision', 'raw', { names: ['pairs-02'] })
    );
    const collision = (await formTeamsCreateTool.handler(BASE, CTX).catch(e => e)) as ToolError;
    expect(collision).toMatchObject({ kind: 'invalid_params', code: 'name_collision' });
    expect(collision.data).toEqual({ names: ['pairs-02'] });

    mocks.previewCreate.mockRejectedValueOnce(teamSetError('github_unavailable', 'installation 9'));
    const down = (await formTeamsCreateTool.handler(BASE, CTX).catch(e => e)) as ToolError;
    expect(down.code).toBe('github_unavailable');
    expect(down.message).not.toContain('installation 9');
  });

  it('points a tag conflict at a new set, and says which run a failed create was', async () => {
    mocks.previewCreate.mockRejectedValueOnce(teamSetError('tag_conflict', 'raw'));
    const tag = (await formTeamsCreateTool.handler(BASE, CTX).catch(e => e)) as ToolError;
    expect(tag.message).toMatch(/name and new_set: true/);

    mocks.previewCreate.mockRejectedValueOnce(
      teamSetError('already_created', 'raw', { run_number: 4, status: 'FAILED' })
    );
    const created = (await formTeamsCreateTool.handler(BASE, CTX).catch(e => e)) as ToolError;
    expect(created.data).toEqual({ run_number: 4, status: 'FAILED' });
    // A failed create that made teams: only its run can be retried…
    expect(created.message).toBe(
      'A create of run 4 failed partway and made some teams; only run 4 can be retried (form_teams_create with run: 4)'
    );

    // …while a set that has its teams says so, and names no run to retry.
    mocks.previewCreate.mockRejectedValueOnce(
      teamSetError('already_created', 'raw', { run_number: 4, status: 'DONE' })
    );
    const done = (await formTeamsCreateTool.handler(BASE, CTX).catch(e => e)) as ToolError;
    expect(done.message).toMatch(/^This set already has its teams/);
    expect(done.message).not.toMatch(/retried/);
  });

  it('says GitHub only to a classroom that is not on GitHub', async () => {
    mocks.previewCreate.mockRejectedValueOnce(
      teamSetError('provider_unsupported', 'raw GITLAB text', { provider: 'GITLAB' })
    );
    const error = (await formTeamsCreateTool.handler(BASE, CTX).catch(e => e)) as ToolError;
    expect(error).toMatchObject({ kind: 'invalid_params', code: 'provider_unsupported' });
    expect(error.message).toMatch(/GitHub only/);
    expect(error.message).not.toMatch(/cannot be reached/);
    expect(error.data).toBeUndefined();
  });

  it('asks to try again when the GitHub pre-flight ran out of time', async () => {
    mocks.previewCreate.mockRejectedValueOnce(
      teamSetError('github_unavailable', 'raw', { reason: 'timeout' })
    );
    const error = (await formTeamsCreateTool.handler(BASE, CTX).catch(e => e)) as ToolError;
    expect(error.code).toBe('github_unavailable');
    expect(error.message).toMatch(/did not answer in time.*Try again/);
    expect(error.data).toEqual({ reason: 'timeout' });
  });

  it('says why a same-run retry is blocked, instead of "start a new run"', async () => {
    mocks.previewCreate.mockRejectedValueOnce(
      teamSetError('run_stale', 'raw', {
        reasons: ['1 person on teams not yet created has left the class.'],
        retry_blocked: true,
      })
    );
    const error = (await formTeamsCreateTool.handler(BASE, CTX).catch(e => e)) as ToolError;
    expect(error.message).toMatch(/left the class, so this create cannot be retried/);
    expect(error.data).toEqual({
      reasons: ['1 person on teams not yet created has left the class.'],
      retry_blocked: true,
    });
  });

  it('turns an ambiguous set reference into a question with the names', async () => {
    mocks.getSet.mockRejectedValue(
      teamSetError('not_found', 'raw', { reason: 'ambiguous', names: ['pairs', 'squads'] })
    );
    const error = (await formTeamsCreateTool.handler(BASE, CTX).catch(e => e)) as ToolError;
    expect(error.kind).toBe('invalid_params');
    expect(error.code).toBe('team_set_ambiguous');
    expect(error.data).toEqual({ team_sets: ['pairs', 'squads'] });
    expect(mocks.previewCreate).not.toHaveBeenCalled();
  });

  it('gives a service not_found the uniform S1 sentence', async () => {
    mocks.previewCreate.mockRejectedValue(teamSetError('not_found', 'Run abc not found.'));
    const error = (await formTeamsCreateTool.handler(BASE, CTX).catch(e => e)) as ToolError;
    expect(error.kind).toBe('not_found');
    expect(error.message).toBe('Run not found in this classroom');
  });

  it('refuses a form that was never published, before the service', async () => {
    mocks.formFindById.mockResolvedValue({ ...FORM_ROW, current_revision_id: null });
    for (const tool of ALL_TOOLS) {
      const error = (await tool
        .handler({ classroom: 'org/w26', form_id: FORM_ID, run: 3 } as never, CTX)
        .catch(e => e)) as ToolError;
      expect(error.code, tool.name).toBe('form_not_published');
    }
    expect(mocks.getSet).not.toHaveBeenCalled();
    expect(mocks.saveConfig).not.toHaveBeenCalled();
    expect(mocks.listForForm).not.toHaveBeenCalled();
  });

  it('leaves an unrelated error alone (it surfaces as internal)', async () => {
    const prismaish = Object.assign(new Error('P2002 unique'), { code: 'not_found' });
    mocks.previewCreate.mockRejectedValue(prismaish);
    const error = await formTeamsCreateTool.handler(BASE, CTX).catch(e => e);
    expect(error).toBe(prismaish);
  });
});

// ─── form_teams_get ─────────────────────────────────────────────────────────

describe('form_teams_get', () => {
  const BASE = { classroom: 'org/w26', form_id: FORM_ID };

  it('with no set returns the suggestion, readiness, a next step and patch_help', async () => {
    mocks.suggestForForm.mockResolvedValue({ name: 'project-bids-teams', config: CONFIG });
    mocks.loadInputs.mockResolvedValue({
      roster: [{ user_id: 'u-1' }, { user_id: 'u-2' }, { user_id: 'u-3' }],
      responses: [{ user_id: 'u-1' }, { user_id: 'u-3' }, { user_id: 'not-on-roster' }],
    });
    const payload = parse(await formTeamsGetTool.handler(BASE, CTX));
    expect(payload.team_sets).toEqual([]);
    expect(payload.set).toBeNull();
    expect(payload.suggested_config).toEqual(CONFIG);
    expect(payload.suggested_name).toBe('project-bids-teams');
    expect(payload.next).toMatch(/Show the suggested setup to the user/);
    expect(payload.readiness).toEqual({ roster: 3, responded: 2, not_responded: 1 });
    expect(mocks.loadInputs).toHaveBeenCalledWith({ classroomId: 'class-1', formId: FORM_ID });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
    // The config module's own tables, so the help cannot drift from the validator.
    expect(payload.patch_help.params_by_job.rank).toEqual(
      expect.arrayContaining(['rank_costs', 'unranked_cost', 'must_top'])
    );
    expect(payload.patch_help.field_types_by_job.together).toEqual(['roster_select']);
    expect(payload.patch_help.pins).toMatch(/identical to an existing one is skipped/);
    expect(payload.patch_help.options).toMatch(/single field set to null clears just that field/);
  });

  it('lists the newest runs with a summary and a stale flag, in one light read', async () => {
    mocks.listForForm.mockResolvedValue([SUMMARY]);
    mocks.getSet.mockResolvedValue(SET_ROW);
    mocks.listRuns.mockResolvedValue(
      [7, 6, 5, 4, 3].map(number => ({
        id: `run-${number}`,
        number,
        status: number === 7 ? 'SOLVED' : 'INFEASIBLE',
        created_at: new Date('2026-09-24T12:00:00.000Z'),
        finished_at: null,
        error: null,
        metrics: number === 7 ? METRICS : null,
        stale: number === 7 ? true : null,
      }))
    );

    const payload = parse(await formTeamsGetTool.handler(BASE, CTX));

    expect(mocks.listRuns).toHaveBeenCalledWith({
      classroomId: 'class-1',
      teamSetId: 'set-1',
      limit: 5,
      withStaleness: true,
    });
    // No per-run full read: staleness came with the list.
    expect(mocks.getRun).not.toHaveBeenCalled();

    expect(payload.set).toMatchObject({
      id: 'set-1',
      config: CONFIG,
      create_status: 'none',
      create_state: null,
    });
    expect(payload.suggested_config).toBeUndefined();
    expect(payload.team_sets).toEqual([
      {
        id: 'set-1',
        name: 'project-bids-teams',
        create_status: 'none',
        run_count: 7,
        latest_run: { number: 7, status: 'SOLVED' },
      },
    ]);
    // The newest five, newest first; the rest are counted, not fetched.
    expect(payload.runs.map((run: { number: number }) => run.number)).toEqual([7, 6, 5, 4, 3]);
    expect(payload.runs_omitted).toBe(2);
    expect(payload.runs[0]).toMatchObject({ status: 'SOLVED', stale: true, metrics: { teams: 2 } });
    expect(payload.runs[1]).toMatchObject({ status: 'INFEASIBLE', stale: null, metrics: null });
  });

  it('lists several sets without guessing which one was meant', async () => {
    mocks.listForForm.mockResolvedValue([SUMMARY, { ...SUMMARY, id: 'set-2', name: 'pairs' }]);
    const payload = parse(await formTeamsGetTool.handler(BASE, CTX));
    expect(mocks.getSet).not.toHaveBeenCalled();
    expect(payload.set).toBeNull();
    expect(payload.team_sets).toHaveLength(2);
    expect(payload.hint).toMatch(/pass team_set/);
  });

  it('reports create_status for every stage of a create', async () => {
    const stages: [Record<string, unknown>, string][] = [
      [{ created_run_id: null, create_state: null }, 'none'],
      [{ created_run_id: 'run-3', create_state: { status: 'RUNNING' } }, 'running'],
      [{ created_run_id: 'run-3', create_state: { status: 'DONE' } }, 'done'],
      [{ created_run_id: 'run-3', create_state: { status: 'PARTIAL' } }, 'partial'],
      [{ created_run_id: 'run-3', create_state: { status: 'FAILED' } }, 'failed'],
    ];
    for (const [state, status] of stages) {
      mocks.listForForm.mockResolvedValue([{ ...SUMMARY, ...state }]);
      mocks.getSet.mockResolvedValue({ ...SET_ROW, ...state });
      const payload = parse(await formTeamsGetTool.handler(BASE, CTX));
      expect(payload.team_sets[0].create_status, status).toBe(status);
      expect(payload.set.create_status, status).toBe(status);
    }
  });

  it('with run returns the view (set named, not re-sent) and audits the read of people', async () => {
    mocks.getSet.mockResolvedValue({
      ...SET_ROW,
      created_run_id: 'run-3',
      create_state: {
        status: 'RUNNING',
        total: 2,
        done: 1,
        failed: [],
        teams: [],
        attempt: 1,
        counts: { teams_created: 1, teams_failed: 0, members_added: 2, members_failed: 0 },
      },
    });
    mocks.getRun.mockResolvedValue({ ...RUN_ROW, status: 'SOLVED' });
    const payload = parse(await formTeamsGetTool.handler({ ...BASE, run: 3 }, CTX));
    expect(mocks.getRun).toHaveBeenCalledWith({
      classroomId: 'class-1',
      teamSetId: 'set-1',
      runRef: 3,
    });
    expect(payload.team_set).toEqual({ id: 'set-1', name: 'project-bids-teams' });
    expect(payload.run.teams).toHaveLength(1);
    // The set's create of this very run is under way: not "go create it".
    expect(payload.run.next).toMatch(/being created now \(from this run\)/);
    expect(payload.run.next).not.toMatch(/form_teams_create/);
    expect(payload.created_from_this_run).toBe(true);
    expect(payload.create_status).toBe('running');
    expect(payload.create_state).toMatchObject({
      status: 'RUNNING',
      total: 2,
      done: 1,
      attempt: 1,
      counts: { teams_created: 1, members_added: 2 },
    });
    expect(JSON.stringify(payload)).not.toContain('avery.quill@example.edu');
    expect(mocks.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({ resource_id: 'run-3', action: 'VIEW' })
    );
  });

  it('says on a SOLVED run where the set’s create stands, before staleness', async () => {
    mocks.getRun.mockResolvedValue({ ...RUN_ROW, status: 'SOLVED' });
    const state = (status: string, teams: number, run_number = 3) => ({
      status,
      run_number,
      total: 3,
      done: teams,
      failed: [],
      teams: Array.from({ length: teams }, (_, i) => ({ team_id: `t-${i}`, name: `t-${i}` })),
    });
    const cases: [Record<string, unknown>, boolean, RegExp][] = [
      // Nothing created yet: the ordinary advice.
      [
        { created_run_id: null, create_state: null },
        false,
        /owner previews with form_teams_create \(run: 3\)/,
      ],
      [
        { created_run_id: 'run-3', create_state: state('DONE', 3) },
        false,
        /already created from this set \(this run\); nothing is left/,
      ],
      [
        { created_run_id: 'run-2', create_state: state('PARTIAL', 3, 2) },
        false,
        /already created from this set \(run 2\), but some members or tags are missing/,
      ],
      // A failed create of THIS run is retried even though the run went stale.
      [
        { created_run_id: 'run-3', create_state: state('FAILED', 1) },
        true,
        /failed partway .*preview again with form_teams_create \(run: 3\)/,
      ],
      [
        { created_run_id: 'run-2', create_state: state('FAILED', 1, 2) },
        false,
        /A create of run 2 failed partway .*only that run can be retried/,
      ],
      // Failed before making any team: any run may be created.
      [
        { created_run_id: 'run-2', create_state: state('FAILED', 0, 2) },
        false,
        /owner previews with form_teams_create \(run: 3\)/,
      ],
    ];
    for (const [set, stale, next] of cases) {
      mocks.getSet.mockResolvedValue({ ...SET_ROW, ...set });
      mocks.describeRun.mockResolvedValue({ ...RUN_VIEW, stale });
      const payload = parse(await formTeamsGetTool.handler({ ...BASE, run: 3 }, CTX));
      expect(payload.run.next, JSON.stringify(set)).toMatch(next);
    }
  });

  it('forwards core_status beside an infeasible run’s summary, and nothing outside its vocabulary', async () => {
    mocks.getSet.mockResolvedValue(SET_ROW);
    mocks.getRun.mockResolvedValue({ ...RUN_ROW, status: 'INFEASIBLE' });
    mocks.describeRun.mockResolvedValue({
      ...RUN_VIEW,
      status: 'INFEASIBLE',
      teams: [],
      solver: {
        status: 'INFEASIBLE',
        objective: null,
        bound: null,
        wall_s: 30,
        core_status: 'timeout',
      },
      core: [{ src: 'pin:p1', label: 'Pin p1: together: 2 people' }],
      summary: 'The solver ran out of time.',
    });
    const payload = parse(await formTeamsGetTool.handler({ ...BASE, run: 3 }, CTX));
    expect(payload.run.solver.core_status).toBe('timeout');
    expect(payload.run.summary).toBe('The solver ran out of time.');
    expect(payload.run.core_status).toBe('timeout');

    mocks.describeRun.mockResolvedValue({
      ...RUN_VIEW,
      solver: { ...RUN_VIEW.solver, core_status: 'something-new' },
    });
    const solved = parse(await formTeamsGetTool.handler({ ...BASE, run: 3 }, CTX));
    expect(solved.run.solver).not.toHaveProperty('core_status');
    expect(solved.run).not.toHaveProperty('core_status');
  });

  it('reads avoids as zero on runs solved before it existed', async () => {
    mocks.getSet.mockResolvedValue(SET_ROW);
    mocks.getRun.mockResolvedValue({ ...RUN_ROW, status: 'SOLVED' });
    const { avoids: _dropped, ...older } = METRICS;
    mocks.describeRun.mockResolvedValue({ ...RUN_VIEW, metrics: older });
    const payload = parse(await formTeamsGetTool.handler({ ...BASE, run: 3 }, CTX));
    expect(payload.run.metrics.avoids).toEqual({ total: 0, broken: 0 });
  });

  it('skips people (and the audit) with include_people: false', async () => {
    mocks.getSet.mockResolvedValue(SET_ROW);
    mocks.getRun.mockResolvedValue({ ...RUN_ROW, status: 'SOLVED' });
    await formTeamsGetTool.handler({ ...BASE, run: 3, include_people: false }, CTX);
    expect(mocks.describeRun).toHaveBeenCalledWith(
      expect.objectContaining({ includePeople: false })
    );
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('refuses a named set that does not exist', async () => {
    mocks.listForForm.mockResolvedValue([{ id: 'set-1', name: 'project-bids-teams' }]);
    const error = await formTeamsGetTool.handler({ ...BASE, team_set: 'nope' }, CTX).catch(e => e);
    expect((error as ToolError).kind).toBe('not_found');
  });
});
