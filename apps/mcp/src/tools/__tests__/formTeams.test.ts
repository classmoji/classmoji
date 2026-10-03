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
  changesSinceRun: vi.fn(),
  revertToRun: vi.fn(),
  newSetFromSetup: vi.fn(),
  compareRuns: vi.fn(),
  explainPlacements: vi.fn(),
  readinessCounts: vi.fn(),
  mustLabels: vi.fn(),
  nonRespondentsFor: vi.fn(),
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
        getTimeZone: async () => null,
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
        changesSinceRun: (...a: unknown[]) => mocks.changesSinceRun(...a),
        revertToRun: (...a: unknown[]) => mocks.revertToRun(...a),
        newSetFromSetup: (...a: unknown[]) => mocks.newSetFromSetup(...a),
        compareRuns: (...a: unknown[]) => mocks.compareRuns(...a),
        explainPlacements: (...a: unknown[]) => mocks.explainPlacements(...a),
        readinessCounts: (...a: unknown[]) => mocks.readinessCounts(...a),
        mustLabels: (...a: unknown[]) => mocks.mustLabels(...a),
        nonRespondentsFor: (...a: unknown[]) => mocks.nonRespondentsFor(...a),
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
  team_size: { min: 3, max: 4 },
};

/** A set as getSet returns it: the row, its status and its lock. */
const SET_ROW = {
  id: 'set-1',
  form_id: FORM_ID,
  name: 'project-bids-teams',
  config: CONFIG,
  tag_id: null,
  created_run_id: null,
  create_state: null,
  status: 'setting_up',
  locked: false,
};

/** A set as listForForm returns it (`created` is an object once teams exist). */
const SUMMARY = {
  id: 'set-1',
  name: 'project-bids-teams',
  status: 'setting_up',
  created: null,
  created_run_id: null,
  create_state: null,
  run_count: 7,
  latest_run: {
    number: 7,
    status: 'SOLVED',
    solver_status: 'OPTIMAL',
    first_choice: 4,
    responded: 5,
  },
  updated_at: '2026-09-24T12:00:00.000Z',
};

/** Real user ids: `person` is a uuid on the wire. */
const AVERY = '0c1d2e3f-4a5b-4c6d-8e7f-8091a2b3c4d5';
const BLAIR = '1d2e3f4a-5b6c-4d7e-9f80-91a2b3c4d5e6';

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
  top3: 5,
};

/** An answer to an identity question: it must never appear in any payload. */
const IDENTITY_ANSWER = 'IDENTITY-ANSWER-Oak';

/** A run view as describeRun returns it — plus two keys that must not ship. */
const RUN_VIEW = {
  id: 'run-3',
  number: 3,
  status: 'SOLVED',
  error: null,
  created_at: '2026-09-24T12:00:00.000Z',
  finished_at: '2026-09-24T12:00:02.000Z',
  created_by: { user_id: 'owner-1', name: 'Olive Owner' },
  solver: { status: 'OPTIMAL', objective: 120, bound: 120, wall_s: 1.5, gap_pct: 0 },
  metrics: METRICS,
  stale: false,
  stale_reasons: [],
  issues: [],
  core: [],
  summary: null,
  changes_since_run: [],
  changes_from_previous: null,
  progress: { responses: 5, people: 6, pins: 0, warnings: 0 },
  identity_rules: [],
  non_respondents: { mode: 'include', people: 1 },
  option_status: [],
  debug_trace: 'INTERNAL-TRACE',
  teams: [
    {
      n: 1,
      name: 'project-bids-teams-01',
      option: null,
      size: 1,
      signals: {
        wanted_first: null,
        seats: { used: 1, max: 4 },
        pitcher_on_team: null,
        requests: { kept: 1, total: 1 },
        pinned: 0,
        did_not_answer: 0,
        fourth_or_lower: 0,
        balance: [],
      },
      members: [
        {
          user_id: 'u-1',
          name: 'Avery Quill',
          login: 'aquill',
          email: 'avery.quill@example.edu',
          placement: '1',
          rank: null,
          pinned: false,
          responded: true,
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
  mocks.readinessCounts.mockResolvedValue({ roster: 0, responded: 0 });
  mocks.mustLabels.mockResolvedValue({});
  mocks.nonRespondentsFor.mockResolvedValue({ setting: null, resolved: 'include' });
  mocks.changesSinceRun.mockResolvedValue({ run_number: null, changes: [] });
  mocks.revertToRun.mockResolvedValue(SET_ROW);
  mocks.newSetFromSetup.mockResolvedValue({
    ...SET_ROW,
    id: 'set-2',
    name: 'project-bids-teams-2',
  });
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

  it('names every setting the page can change, and the new reads', () => {
    for (const phrase of [
      'options (open, size, note)',
      'non_respondents (include/group/exclude)',
      'priority',
      'copy_from',
      'revert_to_run',
      'locked',
    ]) {
      expect(formTeamsRunTool.description, phrase).toContain(phrase);
    }
    expect(formTeamsGetTool.description).toMatch(/compare_with/);
    expect(formTeamsGetTool.description).toMatch(/person/);
    expect(formTeamsGetTool.description).toMatch(/held on N of M teams, never per person/);
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
    expect(run?.inputSchema.properties).toHaveProperty('copy_from');
    expect(run?.inputSchema.properties).toHaveProperty('revert_to_run');
    const get = tools.find(tool => tool.name === 'form_teams_get');
    expect(get?.inputSchema.properties).toHaveProperty('compare_with');
    expect(get?.inputSchema.properties).toHaveProperty('person');
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

  /**
   * The three tools' share of tools/list: name + description + input JSON
   * Schema, as the registry serializes them. Every tool on this server shares
   * one manifest, so the team-set tools may not grow past this ceiling
   * without a deliberate raise here.
   *   staging 5b01af66 (release 1):  5,117 B (descriptions 720 / 920 / 785)
   *   release 2 (MCP parity):        6,068 B (descriptions 918 / 1,145 / 785)
   *     + compare_with, person, copy_from, revert_to_run and the texts for
   *       them, sizes, notes, non_respondents and priority.
   * The ceiling leaves ~180 B for wording fixes, not for another argument.
   */
  const TEAM_SET_MANIFEST_CEILING = 6_250;

  it('keeps the three tools’ manifest (name + description + schema) under its ceiling', async () => {
    asMember('OWNER');
    const client = await connect();
    const { tools } = await client.listTools();
    const bytes = ['form_teams_get', 'form_teams_run', 'form_teams_create'].map(name => {
      const tool = tools.find(entry => entry.name === name);
      expect(tool, name).toBeDefined();
      return new TextEncoder().encode(
        JSON.stringify({
          name: tool!.name,
          description: tool!.description,
          inputSchema: tool!.inputSchema,
        })
      ).length;
    });
    const total = bytes.reduce((sum, n) => sum + n, 0);
    expect(total).toBeLessThanOrEqual(TEAM_SET_MANIFEST_CEILING);
    // A shared schema object converts to a `$ref` some clients can't follow.
    for (const tool of tools.filter(entry => entry.name.startsWith('form_teams_'))) {
      expect(JSON.stringify(tool.inputSchema), tool.name).not.toContain('$ref');
    }
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
    // The tool hands saveConfig the PARSED patch: team_size is replaced whole,
    // as applyConfigPatch does, and gets no default for the retired
    // allow_one_larger.
    expect(mocks.saveConfig).toHaveBeenCalledWith(
      expect.objectContaining({ patch: { ...patch, team_size: { min: 3, max: 4 } } })
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
      via: 'mcp',
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
      via: 'mcp',
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
    // The same code, sentence and details as the service's own name_taken.
    expect(exists.code).toBe('name_taken');
    expect(exists.data).toEqual({ name: 'project-bids-teams' });
    expect(exists.message).toContain('"project-bids-teams"');

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
      {
        level: 'error',
        code: 'capacity',
        message: 'Too many people for the slots',
        hint: expect.stringMatching(/team_size/),
      },
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
      hint: expect.stringMatching(/team of 3/),
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
      rank: null,
      pinned: false,
      responded: true,
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
    // The preview names every member: its read is audited, and nothing else is written.
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
    expect(mocks.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        resource_type: 'TEAM_SETS',
        resource_id: PREVIEW.run_id,
        action: 'VIEW',
        data: expect.objectContaining({ tool: 'form_teams_create', value: 'preview' }),
      })
    );
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

    // …while a set whose teams all exist is locked (a DONE or PARTIAL
    // preview), and says so without naming a run to retry.
    mocks.previewCreate.mockRejectedValueOnce(
      teamSetError('set_locked', 'raw', { run_number: 4, status: 'DONE' })
    );
    const done = (await formTeamsCreateTool.handler(BASE, CTX).catch(e => e)) as ToolError;
    expect(done.code).toBe('set_locked');
    expect(done.message).toMatch(/^This set’s teams were created from run 4/);
    expect(done.message).toMatch(/copy_from and new_set: true/);
    expect(done.message).not.toMatch(/retr/);

    // A claim that loses the race to another create still reads already_created.
    mocks.claimCreate.mockRejectedValueOnce(
      teamSetError('already_created', 'raw', { run_number: 4, status: 'DONE' })
    );
    const raced = (await formTeamsCreateTool
      .handler({ ...BASE, confirm: true }, CTX)
      .catch(e => e)) as ToolError;
    expect(raced.message).toMatch(/^This set already has its teams/);
    expect(raced.message).not.toMatch(/retried/);
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
    mocks.readinessCounts.mockResolvedValue({ roster: 3, responded: 2 });
    const payload = parse(await formTeamsGetTool.handler(BASE, CTX));
    expect(payload.team_sets).toEqual([]);
    expect(payload.set).toBeNull();
    expect(payload.suggested_config).toEqual(CONFIG);
    expect(payload.suggested_name).toBe('project-bids-teams');
    expect(payload.next).toMatch(/Show the suggested setup to the user/);
    expect(payload.readiness).toEqual({ roster: 3, responded: 2, not_responded: 1 });
    // Two counts, no answers: the inputs (every response's answers) are never loaded.
    expect(mocks.readinessCounts).toHaveBeenCalledWith({ classroomId: 'class-1', formId: FORM_ID });
    expect(mocks.loadInputs).not.toHaveBeenCalled();
    expect(mocks.mustLabels).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
    // The config module's own tables, so the help cannot drift from the validator.
    expect(payload.patch_help.params_by_job.rank).toEqual(
      expect.arrayContaining(['rank_costs', 'unranked_cost', 'must_top'])
    );
    expect(payload.patch_help.field_types_by_job.together).toEqual(['roster_select']);
    expect(payload.patch_help.pins).toMatch(/identical to an existing one is skipped/);
    expect(payload.patch_help.options).toMatch(/single field set to null clears just that field/);
    // Release 2: every new setting is documented where the agent reads it.
    expect(payload.patch_help.options).toMatch(/size\?: \{ min\?, max\? \}/);
    expect(payload.patch_help.options).toMatch(/note\?: .*500 characters/);
    expect(payload.patch_help.other).toMatch(/non_respondents include\|group\|exclude/);
    expect(payload.patch_help.other).toMatch(
      /group when team_size\.max is 2 and they can form teams of their own, else include/
    );
    expect(payload.patch_help.other).not.toMatch(/allow_one_larger/);
    expect(payload.patch_help.params_by_job.priority).toEqual([
      'rule_a',
      'rule_b',
      'answers',
      'shift',
    ]);
    expect(payload.patch_help.field_types_by_job.priority).toEqual(['dropdown', 'switch']);
    expect(payload.patch_help.field_types_by_job.no_one_alone).toContain('multiselect');
    expect(payload.patch_help.priority).toMatch(/shift = 10-90 in steps of 10 \(default 50\)/);
    expect(payload.patch_help.priority).toMatch(
      /rank\/fallback\/owner\/together\/apart\/match\/mix/
    );
    expect(payload.patch_help.identity).toMatch(/takes only no_one_alone, strength off or prefer/);
    expect(payload.patch_help.identity).toMatch(/can’t group teams or carry a note rule/);
    expect(payload.patch_help.rules).toMatch(/refused in a patch/);
  });

  it('lists the newest runs with a summary and a stale flag, in one light read', async () => {
    mocks.listForForm.mockResolvedValue([SUMMARY]);
    mocks.getSet.mockResolvedValue(SET_ROW);
    mocks.listRuns.mockResolvedValue(
      [7, 6, 5, 4, 3].map(number => ({
        id: `run-${number}`,
        number,
        status: number === 7 ? 'SOLVED' : 'INFEASIBLE',
        // The service returns ISO strings now; they pass through as they are.
        created_at: '2026-09-24T12:00:00.000Z',
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
        status: 'setting_up',
        create_status: 'none',
        run_count: 7,
        latest_run: { number: 7, status: 'SOLVED' },
      },
    ]);
    expect(payload.runs[0].created_at).toBe('2026-09-24T12:00:00.000Z');
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

// ─── Release 2: every new setting rides the patch ───────────────────────────

/** Field and option ids for the release-2 fixtures (uuids where the schema asks). */
const RANK_FIELD = '2a3b4c5d-6e7f-4a8b-9c0d-1e2f3a4b5c6d';
const PARTNER_FIELD = '3b4c5d6e-7f80-4b9c-8d1e-2f3a4b5c6d7e';
const PRIORITY_FIELD = '4c5d6e7f-8091-4cad-9e2f-3a4b5c6d7e8f';
const IDENTITY_FIELD = '5d6e7f80-91a2-4dbe-8f3a-4b5c6d7e8f90';

describe('form_teams_run — release-2 settings ride the patch', () => {
  const BASE = { classroom: 'org/w26', form_id: FORM_ID, start: false };

  beforeEach(() => {
    mocks.getSet.mockResolvedValue(SET_ROW);
  });

  it('carries option size and note, non_respondents group, and a priority rule to saveConfig', async () => {
    const patch = {
      non_respondents: 'group',
      options: {
        'opt-1': { size: { max: 5 }, note: 'Needs a lab bench' },
        'opt-2': { size: null, note: null },
      },
      rules: {
        upsert: [
          { field_id: IDENTITY_FIELD, job: 'no_one_alone', strength: 'prefer' },
          {
            field_id: PRIORITY_FIELD,
            job: 'priority',
            strength: 'prefer',
            params: {
              rule_a: `${RANK_FIELD}:rank`,
              rule_b: `${PARTNER_FIELD}:together`,
              answers: { 'ans-project': 'a', 'ans-people': 'b', 'ans-both': 'none' },
              shift: 60,
            },
          },
        ],
      },
    };
    const payload = parse(await formTeamsRunTool.handler({ ...BASE, patch }, CTX));
    expect(mocks.saveConfig).toHaveBeenCalledWith({
      classroomId: 'class-1',
      formId: FORM_ID,
      setRef: 'set-1',
      patch,
      userId: 'owner-1',
      via: 'mcp',
    });
    expect(payload).toMatchObject({ started: false, set_created: false });
    // Back to the default (group for pairs, else spread) is a null.
    await formTeamsRunTool.handler({ ...BASE, patch: { non_respondents: null } }, CTX);
    expect(mocks.saveConfig).toHaveBeenLastCalledWith(
      expect.objectContaining({ patch: { non_respondents: null } })
    );
  });

  it('refuses provenance stamps in a patch, before anything is read', async () => {
    for (const patch of [
      {
        pins: {
          add: [{ kind: 'apart', user_ids: [AVERY, BLAIR], added_by: AVERY, added_via: 'mcp' }],
        },
      },
      { options: { 'opt-1': { open: 'closed', closed_by: AVERY } } },
    ]) {
      const error = (await formTeamsRunTool
        .handler({ ...BASE, patch }, CTX)
        .catch(e => e)) as ToolError;
      expect(error.code, JSON.stringify(patch)).toBe('invalid_config');
    }
    expect(mocks.formFindById).not.toHaveBeenCalled();
    expect(mocks.saveConfig).not.toHaveBeenCalled();
  });

  it('refuses github_teams: false (classroom-only teams are cut), before anything is read', async () => {
    const error = (await formTeamsRunTool
      .handler({ ...BASE, patch: { github_teams: false } }, CTX)
      .catch(e => e)) as ToolError;
    expect(error).toMatchObject({ kind: 'invalid_params', code: 'github_teams_off_unsupported' });
    expect(mocks.formFindById).not.toHaveBeenCalled();
    expect(mocks.saveConfig).not.toHaveBeenCalled();
    // true is the only value there is, and it saves.
    await formTeamsRunTool.handler({ ...BASE, patch: { github_teams: true } }, CTX);
    expect(mocks.saveConfig).toHaveBeenCalledTimes(1);
  });

  it('still refuses github_teams: false at create, with a way forward', async () => {
    mocks.previewCreate.mockRejectedValueOnce(
      teamSetError('github_teams_off_unsupported', 'raw service text')
    );
    const error = (await formTeamsCreateTool
      .handler({ classroom: 'org/w26', form_id: FORM_ID, run: 3 }, CTX)
      .catch(e => e)) as ToolError;
    expect(error.code).toBe('github_teams_off_unsupported');
    expect(error.message).toMatch(/patch github_teams: true, run again/);
    expect(error.message).not.toContain('raw service text');
  });
});

// ─── Release 2: Discard (revert_to_run) ─────────────────────────────────────

describe('form_teams_run — revert_to_run (Discard)', () => {
  const BASE = { classroom: 'org/w26', form_id: FORM_ID };

  beforeEach(() => {
    mocks.getSet.mockResolvedValue(SET_ROW);
  });

  it('puts the setup back to the run’s, stamped over MCP, saving only', async () => {
    const payload = parse(await formTeamsRunTool.handler({ ...BASE, revert_to_run: 2 }, CTX));
    expect(mocks.revertToRun).toHaveBeenCalledWith({
      classroomId: 'class-1',
      teamSetId: 'set-1',
      runRef: 2,
      userId: 'owner-1',
      via: 'mcp',
    });
    expect(mocks.saveConfig).not.toHaveBeenCalled();
    expect(mocks.checkPatch).not.toHaveBeenCalled();
    expect(mocks.startRun).not.toHaveBeenCalled();
    expect(payload).toMatchObject({
      set_created: false,
      started: false,
      reverted_to_run: 2,
      team_set: { id: 'set-1', config: CONFIG, locked: false, status: 'setting_up' },
    });
    expect(payload.next).toMatch(/start: true to run it/);
    expect(mocks.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        resource_type: 'TEAM_SETS',
        resource_id: 'set-1',
        action: 'UPDATE',
        data: expect.objectContaining({
          tool: 'form_teams_run',
          reverted_to_run: 2,
          value: 'revert:2',
        }),
      })
    );
  });

  it('refuses a revert mixed with another act, before anything is read', async () => {
    const mixed: Record<string, unknown>[] = [
      { patch: { fairness: 10 } },
      { check: true },
      { start: true },
      { new_set: true, name: 'again' },
      { name: 'other' },
      { copy_from: 'project-bids-teams', new_set: true },
    ];
    for (const extra of mixed) {
      const error = (await formTeamsRunTool
        .handler({ ...BASE, revert_to_run: 2, ...extra } as never, CTX)
        .catch(e => e)) as ToolError;
      expect(error.kind, JSON.stringify(extra)).toBe('invalid_params');
    }
    expect(mocks.formFindById).not.toHaveBeenCalled();
    expect(mocks.revertToRun).not.toHaveBeenCalled();
  });

  it('maps a locked set and an unknown run', async () => {
    mocks.revertToRun.mockRejectedValueOnce(
      teamSetError('set_locked', 'raw', { run_number: 3, status: 'DONE' })
    );
    const locked = (await formTeamsRunTool
      .handler({ ...BASE, revert_to_run: 2 }, CTX)
      .catch(e => e)) as ToolError;
    expect(locked).toMatchObject({ kind: 'invalid_params', code: 'set_locked' });
    expect(locked.message).toMatch(/created from run 3/);
    expect(locked.data).toEqual({ run_number: 3, status: 'DONE' });
    expect(mocks.auditCreate).not.toHaveBeenCalled();

    mocks.revertToRun.mockRejectedValueOnce(teamSetError('not_found', 'Run 99 not found.'));
    const missing = (await formTeamsRunTool
      .handler({ ...BASE, revert_to_run: 99 }, CTX)
      .catch(e => e)) as ToolError;
    expect(missing.kind).toBe('not_found');
    expect(missing.message).toBe('Run not found in this classroom');
  });

  it('refuses a form without a set', async () => {
    mocks.getSet.mockResolvedValue(null);
    const error = (await formTeamsRunTool
      .handler({ ...BASE, revert_to_run: 1 }, CTX)
      .catch(e => e)) as ToolError;
    expect(error.kind).toBe('not_found');
    expect(mocks.revertToRun).not.toHaveBeenCalled();
  });
});

// ─── Release 2: a new set from another set's setup (copy_from) ──────────────

describe('form_teams_run — copy_from', () => {
  const BASE = { classroom: 'org/w26', form_id: FORM_ID };

  it('copies a set’s setup into a new set, stamped over MCP, and never runs it', async () => {
    mocks.getSet.mockImplementation(async ({ setRef }: { setRef?: string }) =>
      setRef === 'project-bids-teams' ? { ...SET_ROW, status: 'created', locked: true } : null
    );
    const payload = parse(
      await formTeamsRunTool.handler(
        { ...BASE, copy_from: 'project-bids-teams', new_set: true, name: 'bids-2', start: true },
        CTX
      )
    );
    expect(mocks.newSetFromSetup).toHaveBeenCalledWith({
      classroomId: 'class-1',
      formId: FORM_ID,
      fromSetRef: 'set-1',
      name: 'bids-2',
      userId: 'owner-1',
      via: 'mcp',
    });
    expect(mocks.saveConfig).not.toHaveBeenCalled();
    expect(mocks.startRun).not.toHaveBeenCalled();
    expect(payload).toMatchObject({
      set_created: true,
      started: false,
      copied_from: { id: 'set-1', name: 'project-bids-teams' },
      team_set: { id: 'set-2', name: 'project-bids-teams-2', locked: false },
    });
    expect(payload.start_refused).toMatch(/never run on the call that creates it/);
    expect(payload.next).toMatch(/Show the user this setup/);
    expect(mocks.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        resource_id: 'set-2',
        action: 'CREATE',
        data: expect.objectContaining({ copied_from: 'set-1', value: 'copy:set-1' }),
      })
    );
  });

  it('lets the service name the copy when no name is given', async () => {
    mocks.getSet.mockResolvedValue(SET_ROW);
    await formTeamsRunTool.handler({ ...BASE, copy_from: 'set-1', new_set: true }, CTX);
    // Only the source is looked up: no name to clash.
    expect(mocks.getSet).toHaveBeenCalledTimes(1);
    const call = mocks.newSetFromSetup.mock.calls[0]![0] as Record<string, unknown>;
    expect(call).not.toHaveProperty('name');
    expect(call.fromSetRef).toBe('set-1');
  });

  it('refuses copy_from without new_set, with a patch or check, or with team_set', async () => {
    for (const extra of [
      {},
      { new_set: true, patch: { fairness: 10 } },
      { new_set: true, check: true },
      { new_set: true, team_set: 'project-bids-teams' },
    ]) {
      const error = (await formTeamsRunTool
        .handler({ ...BASE, copy_from: 'project-bids-teams', ...extra } as never, CTX)
        .catch(e => e)) as ToolError;
      expect(error.kind, JSON.stringify(extra)).toBe('invalid_params');
    }
    expect(mocks.formFindById).not.toHaveBeenCalled();
    expect(mocks.newSetFromSetup).not.toHaveBeenCalled();
  });

  it('refuses a name that is taken, and a source that does not exist', async () => {
    mocks.getSet.mockResolvedValue(SET_ROW);
    const taken = (await formTeamsRunTool
      .handler(
        { ...BASE, copy_from: 'project-bids-teams', new_set: true, name: 'project-bids-teams' },
        CTX
      )
      .catch(e => e)) as ToolError;
    expect(taken.code).toBe('name_taken');
    expect(taken.data).toEqual({ name: 'project-bids-teams' });

    mocks.getSet.mockResolvedValue(null);
    const missing = (await formTeamsRunTool
      .handler({ ...BASE, copy_from: 'nope', new_set: true }, CTX)
      .catch(e => e)) as ToolError;
    expect(missing.kind).toBe('not_found');
    expect(mocks.newSetFromSetup).not.toHaveBeenCalled();
  });
});

// ─── Release 2: locks and runs in flight ────────────────────────────────────

describe('set_locked and run_in_progress', () => {
  const BASE = { classroom: 'org/w26', form_id: FORM_ID };

  beforeEach(() => {
    mocks.getSet.mockResolvedValue(SET_ROW);
  });

  it('refuses a save to a created set with the run and a way forward', async () => {
    mocks.saveConfig.mockRejectedValueOnce(
      teamSetError('set_locked', 'Teams were created from run 4 (internal)', {
        run_number: 4,
        status: 'PARTIAL',
      })
    );
    const error = (await formTeamsRunTool
      .handler({ ...BASE, patch: { fairness: 10 } }, CTX)
      .catch(e => e)) as ToolError;
    expect(error).toMatchObject({ kind: 'invalid_params', code: 'set_locked' });
    expect(error.message).toMatch(/created from run 4, so its setup can’t change/);
    expect(error.message).toMatch(/copy_from and new_set: true/);
    expect(error.message).not.toContain('internal');
    expect(error.data).toEqual({ run_number: 4, status: 'PARTIAL' });
    expect(mocks.startRun).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('says a create is under way, and how a failed one is retried', async () => {
    mocks.saveConfig.mockRejectedValueOnce(
      teamSetError('set_locked', 'raw', { run_number: null, status: null })
    );
    const creating = (await formTeamsRunTool.handler(BASE, CTX).catch(e => e)) as ToolError;
    expect(creating.message).toMatch(/being created from this set now/);

    mocks.saveConfig.mockRejectedValueOnce(
      teamSetError('set_locked', 'raw', { run_number: 2, status: 'FAILED' })
    );
    const failed = (await formTeamsRunTool.handler(BASE, CTX).catch(e => e)) as ToolError;
    expect(failed.message).toMatch(/Retry it with form_teams_create \(run: 2\)/);

    // Without details, the code's own sentence.
    mocks.startRun.mockRejectedValueOnce(teamSetError('set_locked', 'raw'));
    const bare = (await formTeamsRunTool.handler(BASE, CTX).catch(e => e)) as ToolError;
    expect(bare.message).toMatch(/^This set’s teams exist/);
  });

  it('says which run is still solving when a start is refused, after the save was audited', async () => {
    mocks.startRun.mockRejectedValueOnce(
      teamSetError('run_in_progress', 'Run 6 has not finished.', { run_number: 6 })
    );
    const error = (await formTeamsRunTool
      .handler({ ...BASE, patch: { fairness: 20 } }, CTX)
      .catch(e => e)) as ToolError;
    expect(error).toMatchObject({ kind: 'invalid_params', code: 'run_in_progress' });
    expect(error.message).toMatch(/Run 6 of this set hasn’t finished/);
    expect(error.message).toMatch(/Poll form_teams_get with run: 6/);
    expect(error.message).toMatch(/a patch, if any, was saved/);
    expect(error.data).toEqual({ run_number: 6 });
    expect(mocks.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'UPDATE', resource_id: 'set-1' })
    );
  });
});

// ─── Release 2: advice lives in the hints, facts in the messages ────────────

describe('CHECK_HINTS', () => {
  /** The checks module's own vocabulary: its header, and the codes it emits. */
  const checksSource = readFileSync(
    new URL('../../../../../packages/services/src/classmoji/teamSetChecks.ts', import.meta.url),
    'utf8'
  );
  const header = checksSource.slice(
    checksSource.indexOf('Codes (closed vocabulary):'),
    checksSource.indexOf(' *   ok ')
  );
  const headerCodes = header
    .replace('Codes (closed vocabulary):', ' ')
    .replace(/\*|\berrors\b|\bwarnings\b/g, ' ')
    .split(/[\s·]+/)
    .filter(Boolean);
  const okLine = checksSource.slice(
    checksSource.indexOf(' *   ok '),
    checksSource.indexOf('\n *\n', checksSource.indexOf(' *   ok '))
  );
  const okCodes = okLine
    .replace(/\*|\bok\b|\(includePassed only\)/g, ' ')
    .split(/[\s·]+/)
    .filter(Boolean);

  /** Run one issue through a check call and read back its payload. */
  async function hinted(issue: Record<string, unknown>) {
    mocks.checkPatch.mockResolvedValueOnce({
      set: null,
      name: 'x',
      config: CONFIG,
      notes: [],
      issues: [issue],
    });
    const payload = parse(
      await formTeamsRunTool.handler({ classroom: 'org/w26', form_id: FORM_ID, check: true }, CTX)
    );
    return payload.issues[0] as Record<string, unknown>;
  }

  it('reads the full vocabulary from the checks module', () => {
    expect(headerCodes).toEqual(
      expect.arrayContaining(['no_people', 'capacity', 'group_too_small', 'priority_target_off'])
    );
    expect(headerCodes.length).toBeGreaterThanOrEqual(22);
    // Every code the module emits is in its header (error/warning) or its ok line.
    const emitted = [
      ...checksSource.matchAll(/code: '([a-z_]+)'/g),
      ...checksSource.matchAll(/code: \w+ \? '([a-z_]+)' : '([a-z_]+)'/g),
    ].flatMap(match => match.slice(1).filter(Boolean));
    for (const code of emitted) {
      expect([...headerCodes, ...okCodes], code).toContain(code);
    }
  });

  it('gives every error and warning code a hint, and the config refusals too', async () => {
    for (const code of [...headerCodes, 'invalid_config', 'no_grouping_field']) {
      const payload = await hinted({ level: 'warning', code, message: 'fact' });
      expect(payload.hint, code).toEqual(expect.any(String));
      expect((payload.hint as string).length, code).toBeGreaterThan(20);
    }
  });

  it('holds the advice the page’s messages no longer carry', async () => {
    const hintFor = async (code: string) =>
      (await hinted({ level: 'error', code, message: 'fact' })).hint as string;
    expect(await hintFor('group_too_small')).toMatch(/choose Spread .* or Leave out/);
    expect(await hintFor('group_split')).toMatch(/Spread|Leave out/);
    expect(await hintFor('odd_group_in_pairs')).toMatch(/prefer instead of must/);
    // allow_one_larger is retired: no hint sends an agent to it.
    for (const code of headerCodes)
      expect(await hintFor(code), code).not.toMatch(/allow_one_larger/);
    expect(await hintFor('no_response')).toMatch(/non_respondents include .* group .* exclude/);
    expect(await hintFor('model_too_large')).toMatch(/match or mix/);
    expect(await hintFor('option_capacity_pins')).toMatch(/size\.max/);
    expect(await hintFor('priority_target_off')).toMatch(/rule_a \/ rule_b/);
    expect(await hintFor('invalid_config')).toMatch(/pins\.remove/);
  });

  it('forwards option ids, and never a person on an identity issue', async () => {
    const capacity = await hinted({
      level: 'error',
      code: 'option_capacity_pins',
      message: "'Ledger' has 4 seats, and 5 people must be on it.",
      option_ids: ['opt-1'],
      user_ids: [AVERY],
      names: ['Avery Quill'],
    });
    expect(capacity).toMatchObject({ option_ids: ['opt-1'], user_ids: [AVERY] });

    for (const code of ['identity_single_answer', 'identity_rule_pairs']) {
      const payload = await hinted({
        level: 'warning',
        code,
        message: '1 answer to "Q" has a single student.',
        srcs: [`${IDENTITY_FIELD}:no_one_alone`],
        user_ids: [AVERY],
        names: ['Avery Quill'],
      });
      expect(payload, code).not.toHaveProperty('user_ids');
      expect(payload, code).not.toHaveProperty('names');
      expect(JSON.stringify(payload)).not.toContain(AVERY);
      expect(payload.srcs).toEqual([`${IDENTITY_FIELD}:no_one_alone`]);
    }
  });
});

// ─── Release 2: the run view ────────────────────────────────────────────────

describe('form_teams_get — the release-2 run view', () => {
  const BASE = { classroom: 'org/w26', form_id: FORM_ID, run: 3 };

  beforeEach(() => {
    mocks.getSet.mockResolvedValue(SET_ROW);
    mocks.getRun.mockResolvedValue({ ...RUN_ROW, status: 'SOLVED' });
  });

  it('adds top3, the gap, team signals, option status, non-respondents and changes', async () => {
    mocks.describeRun.mockResolvedValue({
      ...RUN_VIEW,
      solver: { ...RUN_VIEW.solver, gap_pct: 2.5 },
      changes_since_run: [
        { kind: 'fairness', before: 50, after: 70, text: 'Fairness: 50 → 70', extra: 'x' },
      ],
      option_status: [
        { option_id: 'opt-1', label: 'Ledger', status: 'full', placed: 4, max: 4 },
        { option_id: 'opt-9', label: null, status: 'not_on_form', placed: 0, max: 0 },
      ],
      non_respondents: { mode: 'group', people: 2 },
      teams: [
        {
          ...RUN_VIEW.teams[0],
          option: { id: 'opt-9', label: null },
          signals: {
            ...RUN_VIEW.teams[0]!.signals,
            wanted_first: 3,
            pitcher_on_team: true,
            balance: [
              { field_id: 'f-1', label: 'Experience', team_avg: 3, class_avg: 3.2, raw: [1, 5] },
            ],
          },
          members: [{ ...RUN_VIEW.teams[0]!.members[0], rank: 2, pinned: true }],
        },
      ],
    });
    const { run } = parse(await formTeamsGetTool.handler(BASE, CTX));
    expect(run.metrics.top3).toBe(5);
    expect(run.solver.gap_pct).toBe(2.5);
    expect(run.changes_since_run).toEqual(['Fairness: 50 → 70']);
    expect(run.non_respondents).toEqual({ mode: 'group', people: 2 });
    expect(run.option_status).toEqual([
      { option_id: 'opt-1', label: 'Ledger', status: 'full', placed: 4, max: 4 },
      { option_id: 'opt-9', label: null, status: 'not_on_form', placed: 0, max: 0 },
    ]);
    // A label is null when the option is no longer on the form.
    expect(run.teams[0].option).toEqual({ id: 'opt-9', label: null });
    expect(run.teams[0].signals).toEqual({
      wanted_first: 3,
      seats: { used: 1, max: 4 },
      pitcher_on_team: true,
      requests: { kept: 1, total: 1 },
      pinned: 0,
      did_not_answer: 0,
      fourth_or_lower: 0,
      balance: [{ question: 'Experience', team_avg: 3, class_avg: 3.2 }],
    });
    expect(run.teams[0].members[0]).toMatchObject({ rank: 2, pinned: true, responded: true });
  });

  it('derives top3 from placement on runs scored before it existed', async () => {
    const { top3: _gone, ...older } = METRICS;
    mocks.describeRun.mockResolvedValue({ ...RUN_VIEW, metrics: older });
    const { run } = parse(await formTeamsGetTool.handler(BASE, CTX));
    expect(run.metrics.top3).toBe(5);
  });

  it('keeps the null picks of free teams null, never zeros', async () => {
    const free = { ...METRICS, placement: null, first_choice: null, top2: null, top3: null };
    mocks.describeRun.mockResolvedValue({ ...RUN_VIEW, metrics: free });
    const { run } = parse(await formTeamsGetTool.handler(BASE, CTX));
    expect(run.metrics).toMatchObject({
      placement: null,
      first_choice: null,
      top2: null,
      top3: null,
      people: METRICS.people,
    });
    const { top3: _gone, ...older } = free;
    mocks.describeRun.mockResolvedValue({ ...RUN_VIEW, metrics: older });
    expect(parse(await formTeamsGetTool.handler(BASE, CTX)).run.metrics.top3).toBeNull();
  });

  it('names the students of a per-student Can’t-solve item from people, with what to patch', async () => {
    mocks.getRun.mockResolvedValue({ ...RUN_ROW, status: 'INFEASIBLE' });
    mocks.describeRun.mockResolvedValue({
      ...RUN_VIEW,
      status: 'INFEASIBLE',
      teams: [],
      summary:
        "The settings listed can't all be met together within the team-size, teams-per-option and team-count limits.",
      solver: {
        status: 'INFEASIBLE',
        objective: null,
        bound: null,
        wall_s: 2,
        core_status: 'complete',
        gap_pct: null,
      },
      core: [
        {
          src: `${RANK_FIELD}:rank@3`,
          kind: 'rule',
          label: 'Rank the projects (rank, must)',
          user_ids: [AVERY],
          people: [{ user_id: AVERY, name: 'Avery Quill' }],
          link: { tab: 'questions', field_id: RANK_FIELD },
        },
        {
          src: 'option:opt-1',
          kind: 'option',
          label: "'Ledger' is closed",
          option: {
            id: 'opt-1',
            label: 'Ledger',
            open: 'closed',
            note: 'Sponsor withdrew',
            closed: { since_run: 2, by: { user_id: 'owner-1', name: 'Olive Owner' }, via: 'mcp' },
          },
          link: { tab: 'projects', option_id: 'opt-1' },
        },
        {
          src: 'pin:p1',
          kind: 'pin',
          label: 'Pin p1: together: 2 people',
          user_ids: [AVERY, BLAIR],
          link: { tab: 'pins', pin_id: 'p1' },
        },
      ],
      changes_from_previous: {
        since_run: 2,
        items: [
          {
            kind: 'option',
            option_id: 'opt-1',
            field: 'open',
            text: "'Ledger': Solver decides → Closed",
          },
        ],
      },
    });
    const { run } = parse(await formTeamsGetTool.handler(BASE, CTX));
    expect(run.core).toEqual([
      {
        src: `${RANK_FIELD}:rank@3`,
        label: 'Rank the projects (rank, must)',
        people: [{ user_id: AVERY, name: 'Avery Quill' }],
        field_id: RANK_FIELD,
      },
      {
        src: 'option:opt-1',
        label: "'Ledger' is closed",
        option: {
          id: 'opt-1',
          label: 'Ledger',
          open: 'closed',
          note: 'Sponsor withdrew',
          closed: { since_run: 2, by: 'Olive Owner', via: 'mcp' },
        },
        option_id: 'opt-1',
      },
      {
        src: 'pin:p1',
        label: 'Pin p1: together: 2 people',
        user_ids: [AVERY, BLAIR],
        pin_id: 'p1',
      },
    ]);
    expect(run.changes_from_previous).toEqual({
      run: 2,
      changes: ["'Ledger': Solver decides → Closed"],
    });
    // The page's sentence is facts; the advice is in next.
    expect(run.summary).toMatch(/can't all be met together/);
    expect(run.next).toMatch(/relax or remove one of those in core/);
    // No teams, but a student is named: the read is audited.
    expect(mocks.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({ resource_id: 'run-3', action: 'VIEW' })
    );
  });

  it('gives INFEASIBLE advice for group mode, the size limits alone, and a timed-out core', async () => {
    mocks.getRun.mockResolvedValue({ ...RUN_ROW, status: 'INFEASIBLE' });
    const infeasible = {
      ...RUN_VIEW,
      status: 'INFEASIBLE',
      teams: [],
      solver: { status: 'INFEASIBLE', objective: null, bound: null, wall_s: 2, gap_pct: null },
    };
    const cases: [Record<string, unknown>, RegExp][] = [
      [
        { non_respondents: { mode: 'group', people: 3 }, core: [] },
        /choose Spread \(non_respondents: include\) or Leave out \(exclude\)/,
      ],
      [
        {
          non_respondents: { mode: 'group', people: 3 },
          core: [
            {
              src: 'non_respondents',
              kind: 'non_respondents',
              label: 'x',
              link: { tab: 'non_respondents' },
            },
          ],
        },
        /choose Spread/,
      ],
      [
        { core: [], solver: { ...infeasible.solver, core_status: 'complete' } },
        /size limits alone can’t place everyone/,
      ],
      [
        { core: [], solver: { ...infeasible.solver, core_status: 'timeout' } },
        /raise time_limit_s/,
      ],
      [
        {
          core: [{ src: 'pin:p1', kind: 'pin', label: 'x', link: { tab: 'pins', pin_id: 'p1' } }],
          solver: { ...infeasible.solver, core_status: 'timeout' },
        },
        /relax or remove one of those in core.*may not be part of the conflict/,
      ],
    ];
    for (const [overrides, next] of cases) {
      mocks.describeRun.mockResolvedValue({ ...infeasible, ...overrides });
      const { run } = parse(await formTeamsGetTool.handler(BASE, CTX));
      expect(run.next, JSON.stringify(overrides)).toMatch(next);
    }
  });
});

// ─── Release 2: identity questions — the aggregate only ─────────────────────

describe('identity questions — aggregate only', () => {
  const BASE = { classroom: 'org/w26', form_id: FORM_ID, run: 3 };

  beforeEach(() => {
    mocks.getSet.mockResolvedValue(SET_ROW);
    mocks.getRun.mockResolvedValue({ ...RUN_ROW, status: 'SOLVED' });
  });

  it('forwards "held on N of M teams" and never which teams missed', async () => {
    mocks.describeRun.mockResolvedValue({
      ...RUN_VIEW,
      identity_rules: [
        {
          rule_id: `${IDENTITY_FIELD}:no_one_alone`,
          label: 'Which describes you?',
          teams_held: 5,
          teams_total: 6,
          missed_teams: [{ n: 4, name: 'MISSED-TEAM-bids-04' }],
          answers: [IDENTITY_ANSWER],
        },
      ],
      issues: [
        {
          level: 'warning',
          code: 'identity_single_answer',
          message: '1 answer to "Which describes you?" has a single student.',
          srcs: [`${IDENTITY_FIELD}:no_one_alone`],
          user_ids: [AVERY],
          names: ['Avery Quill'],
        },
      ],
    });
    const payload = parse(await formTeamsGetTool.handler(BASE, CTX));
    expect(payload.run.identity_rules).toEqual([
      { question: 'Which describes you?', teams_held: 5, teams_total: 6 },
    ]);
    const json = JSON.stringify(payload);
    expect(json).not.toContain('MISSED-TEAM');
    expect(json).not.toContain('missed_teams');
    expect(json).not.toContain(IDENTITY_ANSWER);
    expect(payload.run.issues[0]).not.toHaveProperty('user_ids');
    expect(payload.run.issues[0]).not.toHaveProperty('names');
    // The reveal is the page's, on request; no tool asks for it.
    const call = mocks.describeRun.mock.calls[0]![0] as Record<string, unknown>;
    expect(call.revealIdentity).toBeUndefined();
  });

  it('keeps identity answers out of the why facts and the comparison', async () => {
    mocks.explainPlacements.mockResolvedValue([
      {
        ...WHY_FACTS,
        identity_answers: { [IDENTITY_FIELD]: IDENTITY_ANSWER },
        answers: { [IDENTITY_FIELD]: IDENTITY_ANSWER },
        team: { ...WHY_FACTS.team, identity: IDENTITY_ANSWER },
      },
    ]);
    const why = parse(await formTeamsGetTool.handler({ ...BASE, person: AVERY }, CTX));
    expect(JSON.stringify(why)).not.toContain(IDENTITY_ANSWER);
    expect(why.why).not.toHaveProperty('answers');
    expect(why.why).not.toHaveProperty('identity_answers');

    mocks.compareRuns.mockResolvedValue({
      ...COMPARISON,
      missed_teams: [{ n: 4, name: 'MISSED-TEAM-bids-04' }],
      moved: COMPARISON.moved.map(mover => ({ ...mover, answer: IDENTITY_ANSWER })),
    });
    const compared = parse(await formTeamsGetTool.handler({ ...BASE, compare_with: 2 }, CTX));
    const json = JSON.stringify(compared);
    expect(json).not.toContain(IDENTITY_ANSWER);
    expect(json).not.toContain('MISSED-TEAM');
    // The identity rule's row is a held count, as on the page.
    expect(compared.comparison.metrics).toContainEqual({
      key: 'rule_held',
      question: 'Which describes you?',
      identity: true,
      run: 5,
      other: 4,
      delta: 1,
      of: { run: 6, other: 6 },
    });
  });
});

// ─── Release 2: compare two runs ────────────────────────────────────────────

/** compareRuns as the service returns it (plus keys that must not ship). */
const COMPARISON = {
  run_number: 3,
  other_run_number: 2,
  grouped: true,
  changes: [
    {
      kind: 'option',
      option_id: 'opt-1',
      field: 'open',
      before: 'auto',
      after: 'closed',
      text: "'Ledger': Solver decides → Closed",
    },
  ],
  metrics: [
    { key: 'first_choice', run: 4, other: 3, delta: 1 },
    { key: 'requests_kept', run: 2, other: 1, delta: 1, of: { run: 3, other: 3 } },
    { key: 'options_open', run: 2, other: 2, delta: 0, of: { run: 3, other: 3 }, same_set: true },
    {
      key: 'rule_held',
      rule_id: `${IDENTITY_FIELD}:no_one_alone`,
      identity: true,
      run: 5,
      other: 4,
      delta: 1,
      of: { run: 6, other: 6 },
    },
  ],
  moved: [
    {
      user: { user_id: AVERY, name: 'Avery Quill' },
      from: { option: { id: 'opt-1', label: 'Ledger' }, team_n: 1, rank: 1, responded: true },
      to: { option: { id: 'opt-2', label: null }, team_n: 2, rank: 2, responded: true },
      pin: { pin_id: 'p1', kind: 'on_option', reason: 'Asked to move' },
      requests: [
        {
          kind: 'now_kept',
          asker: { user_id: BLAIR, name: 'Blair Stone' },
          asked: { user_id: AVERY, name: 'Avery Quill' },
        },
      ],
      email: 'avery.quill@example.edu',
    },
  ],
  unchanged: 4,
  joined: 0,
  left: 1,
  rule_labels: { [`${IDENTITY_FIELD}:no_one_alone`]: 'Which describes you?' },
};

describe('form_teams_get — compare_with', () => {
  const BASE = { classroom: 'org/w26', form_id: FORM_ID, run: 3 };

  beforeEach(() => {
    mocks.getSet.mockResolvedValue(SET_ROW);
    mocks.getRun.mockResolvedValue({ ...RUN_ROW, status: 'SOLVED' });
    mocks.compareRuns.mockResolvedValue(COMPARISON);
  });

  it('compares the run with another, compactly, and audits the read of people', async () => {
    const payload = parse(await formTeamsGetTool.handler({ ...BASE, compare_with: 2 }, CTX));
    expect(mocks.compareRuns).toHaveBeenCalledWith({
      classroomId: 'class-1',
      teamSetId: 'set-1',
      runRef: 'run-3',
      otherRunRef: 2,
      includePeople: true,
    });
    expect(mocks.describeRun).not.toHaveBeenCalled();
    expect(payload.run).toEqual({ number: 3, status: 'SOLVED' });
    expect(payload.comparison).toEqual({
      run: 3,
      other_run: 2,
      grouped: true,
      changes: ["'Ledger': Solver decides → Closed"],
      metrics: [
        { key: 'first_choice', run: 4, other: 3, delta: 1 },
        { key: 'requests_kept', run: 2, other: 1, delta: 1, of: { run: 3, other: 3 } },
        {
          key: 'options_open',
          run: 2,
          other: 2,
          delta: 0,
          of: { run: 3, other: 3 },
          same_set: true,
        },
        {
          key: 'rule_held',
          question: 'Which describes you?',
          identity: true,
          run: 5,
          other: 4,
          delta: 1,
          of: { run: 6, other: 6 },
        },
      ],
      moved: [
        {
          user_id: AVERY,
          name: 'Avery Quill',
          from: "'Ledger', team 1, 1st pick",
          to: 'option opt-2 (no longer on the form), team 2, 2nd pick',
          pin: { id: 'p1', kind: 'on_option', reason: 'Asked to move' },
          requests: ["Now kept: Blair Stone's request for Avery Quill"],
        },
      ],
      unchanged: 4,
      joined: 0,
      left: 1,
    });
    expect(JSON.stringify(payload)).not.toContain('avery.quill@example.edu');
    expect(mocks.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        resource_id: 'run-3',
        action: 'VIEW',
        data: expect.objectContaining({ tool: 'form_teams_get', value: 'compare:2' }),
      })
    );
  });

  it('reads movers by team in free mode, and skips names and the audit without people', async () => {
    mocks.compareRuns.mockResolvedValue({
      ...COMPARISON,
      grouped: false,
      moved: [
        {
          user: { user_id: AVERY, name: null },
          from: { option: null, team_n: 1, rank: null, responded: true },
          to: { option: null, team_n: 3, rank: null, responded: false },
          requests: [],
        },
      ],
    });
    const payload = parse(
      await formTeamsGetTool.handler({ ...BASE, compare_with: 2, include_people: false }, CTX)
    );
    expect(mocks.compareRuns).toHaveBeenCalledWith(
      expect.objectContaining({ includePeople: false })
    );
    // Without people, who moved is a count: no user id, seat, pin or request.
    expect(payload.comparison).not.toHaveProperty('moved');
    expect(payload.comparison.moved_count).toBe(1);
    expect(JSON.stringify(payload)).not.toContain(AVERY);
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('a seat reads "not ranked" for who answered, "no answer" for who did not', async () => {
    const ledger = { id: 'opt-1', label: 'Ledger' };
    mocks.compareRuns.mockResolvedValue({
      ...COMPARISON,
      moved: [
        {
          user: { user_id: AVERY, name: 'Avery Quill' },
          from: { option: ledger, team_n: 1, rank: null, responded: false },
          to: { option: ledger, team_n: 2, rank: null, responded: true },
          requests: [],
        },
        {
          user: { user_id: BLAIR, name: 'Blair Stone' },
          from: { option: null, team_n: 1, rank: null, responded: false },
          to: { option: null, team_n: 3, rank: null, responded: false },
          requests: [],
        },
      ],
    });
    const payload = parse(await formTeamsGetTool.handler({ ...BASE, compare_with: 2 }, CTX));
    expect(
      payload.comparison.moved.map((m: { from: string; to: string }) => [m.from, m.to])
    ).toEqual([
      ["'Ledger', team 1, no answer", "'Ledger', team 2, not ranked"],
      // No option on the seat: the team only, whether they answered or not.
      ['team 1', 'team 3'],
    ]);
  });

  it('passes a free run’s side of projects running as null, with no change and no same-set', async () => {
    mocks.compareRuns.mockResolvedValue({
      ...COMPARISON,
      grouped: false,
      metrics: [
        { key: 'options_open', run: 5, other: null, delta: null, of: { run: 8, other: null } },
      ],
    });
    const payload = parse(await formTeamsGetTool.handler({ ...BASE, compare_with: 2 }, CTX));
    expect(payload.comparison.metrics).toEqual([
      { key: 'options_open', run: 5, other: null, delta: null, of: { run: 8, other: null } },
    ]);
  });

  it('needs run, and takes compare_with or person, not both — before anything is read', async () => {
    const withoutRun = (await formTeamsGetTool
      .handler({ classroom: 'org/w26', form_id: FORM_ID, compare_with: 2 }, CTX)
      .catch(e => e)) as ToolError;
    expect(withoutRun.kind).toBe('invalid_params');
    const both = (await formTeamsGetTool
      .handler({ ...BASE, compare_with: 2, person: AVERY }, CTX)
      .catch(e => e)) as ToolError;
    expect(both.kind).toBe('invalid_params');
    expect(mocks.formFindById).not.toHaveBeenCalled();
    expect(mocks.compareRuns).not.toHaveBeenCalled();
    expect(mocks.explainPlacements).not.toHaveBeenCalled();
  });

  it('refuses an unknown other run with the uniform sentence', async () => {
    mocks.compareRuns.mockRejectedValue(teamSetError('not_found', 'Run 9 not found.'));
    const error = (await formTeamsGetTool
      .handler({ ...BASE, compare_with: 9 }, CTX)
      .catch(e => e)) as ToolError;
    expect(error.kind).toBe('not_found');
    expect(error.message).toBe('Run not found in this classroom');
  });
});

// ─── Release 2: why one person is where they are ────────────────────────────

/** explainPlacements' facts for one person (plus a key that must not ship). */
const WHY_FACTS = {
  user_id: AVERY,
  name: 'Avery Quill',
  responded: true,
  team: {
    n: 2,
    name: 'bids-studio',
    option: { id: 'opt-2', label: 'Studio' },
    mates: [{ user_id: BLAIR, name: 'Blair Stone' }],
  },
  placement: '2',
  rank: 2,
  pitched: [
    {
      option: { id: 'opt-3', label: 'Canopy' },
      status: { status: 'not_running', placed: 0, max: 4 },
    },
  ],
  pins: [
    {
      id: 'p1',
      kind: 'together',
      people: [
        { user_id: AVERY, name: 'Avery Quill' },
        { user_id: BLAIR, name: 'Blair Stone' },
      ],
      option: null,
      reason: 'Lab partners',
      added_by: { user_id: 'owner-1', name: 'Olive Owner' },
      added_via: 'mcp',
      added_at: '2026-09-24T12:00:00.000Z',
    },
  ],
  previous: { run_number: 2, option: { id: 'opt-1', label: 'Ledger' }, team_n: 1 },
  higher_picks: [
    {
      rank: 1,
      option: { id: 'opt-1', label: 'Ledger' },
      status: { status: 'full', placed: 4, max: 4 },
    },
  ],
  requests: [
    {
      user: { user_id: BLAIR, name: 'Blair Stone' },
      kept: true,
      on: { team_n: 2, option: { id: 'opt-2', label: 'Studio' } },
    },
    {
      user: { user_id: 'u-9', name: null },
      kept: false,
      on: { team_n: 1, option: { id: 'opt-1', label: 'Ledger' } },
    },
  ],
  notes: [{ field_label: 'Anything else?', text: 'Prefers mornings' }],
  priority: [
    {
      rule_id: `${PRIORITY_FIELD}:priority`,
      question: 'What matters more to you?',
      answer: 'The project',
      favored: 'Rank the projects',
      other: 'Partner',
      up: 1.5,
      down: 0.5,
    },
  ],
  email: 'avery.quill@example.edu',
};

describe('form_teams_get — person (why this placement)', () => {
  const BASE = { classroom: 'org/w26', form_id: FORM_ID, run: 3 };

  beforeEach(() => {
    mocks.getSet.mockResolvedValue(SET_ROW);
    mocks.getRun.mockResolvedValue({ ...RUN_ROW, status: 'SOLVED' });
    mocks.explainPlacements.mockResolvedValue([WHY_FACTS]);
  });

  it('returns the facts behind one placement, allow-listed, and audits the read', async () => {
    const payload = parse(await formTeamsGetTool.handler({ ...BASE, person: AVERY }, CTX));
    expect(mocks.explainPlacements).toHaveBeenCalledWith({
      classroomId: 'class-1',
      teamSetId: 'set-1',
      runRef: 'run-3',
      userIds: [AVERY],
    });
    expect(mocks.describeRun).not.toHaveBeenCalled();
    expect(payload.run).toEqual({ number: 3, status: 'SOLVED' });
    expect(payload.why).toEqual({
      user_id: AVERY,
      name: 'Avery Quill',
      responded: true,
      team: { n: 2, name: 'bids-studio', option: "'Studio'", mates: ['Blair Stone'] },
      placement: '2',
      rank: 2,
      pitched: ["'Canopy': not running"],
      pins: [
        {
          id: 'p1',
          kind: 'together',
          people: ['Avery Quill', 'Blair Stone'],
          reason: 'Lab partners',
        },
      ],
      previous: { run: 2, option: "'Ledger'", team: 1 },
      higher_picks: ["1st 'Ledger': full 4 of 4"],
      requests: ['Blair Stone: kept', "u-9: not kept (on team 1, 'Ledger')"],
      notes: [{ field_label: 'Anything else?', text: 'Prefers mornings' }],
      priority: [
        'Answered "The project" to "What matters more to you?": "Rank the projects" counts ×1.5 and "Partner" ×0.5 for this student.',
      ],
    });
    expect(JSON.stringify(payload)).not.toContain('avery.quill@example.edu');
    expect(mocks.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        resource_id: 'run-3',
        action: 'VIEW',
        data: expect.objectContaining({ tool: 'form_teams_get', value: `person:${AVERY}` }),
      })
    );
  });

  it('says so for a non-respondent seated with the others, and an answer that changes nothing', async () => {
    mocks.explainPlacements.mockResolvedValue([
      {
        ...WHY_FACTS,
        responded: false,
        non_respondents_mode: 'group',
        grouped: true,
        rank: null,
        placement: 'no_answer',
        priority: [
          {
            ...WHY_FACTS.priority[0],
            answer: 'Both equally',
            favored: null,
            other: null,
            up: 1,
            down: 1,
          },
        ],
      },
    ]);
    const { why } = parse(await formTeamsGetTool.handler({ ...BASE, person: AVERY }, CTX));
    expect(why).toMatchObject({ responded: false, non_respondents_mode: 'group', grouped: true });
    expect(why.priority).toEqual([
      'Answered "Both equally" to "What matters more to you?": no change to the weights.',
    ]);
  });

  it('passes a placement the service does not show as null, never as no answer', async () => {
    // A run grouped by a question that is an identity question now.
    mocks.explainPlacements.mockResolvedValue([
      {
        ...WHY_FACTS,
        team: { ...WHY_FACTS.team, option: null },
        placement: null,
        rank: null,
        higher_picks: [],
        previous: { ...WHY_FACTS.previous, option: null },
        requests: [],
      },
    ]);
    const { why } = parse(await formTeamsGetTool.handler({ ...BASE, person: AVERY }, CTX));
    expect(why).toMatchObject({
      responded: true,
      team: { n: 2, option: null },
      placement: null,
      rank: null,
      higher_picks: [],
      previous: { run: 2, option: null, team: 1 },
    });
    expect(why).not.toHaveProperty('non_respondents_mode');
    expect(JSON.stringify(why)).not.toContain('no_answer');
    expect(JSON.stringify(why)).not.toContain('Studio');
  });

  it('refuses a run that is not solved, and a person who is not in it', async () => {
    mocks.getRun.mockResolvedValueOnce({ ...RUN_ROW, status: 'INFEASIBLE' });
    const unsolved = (await formTeamsGetTool
      .handler({ ...BASE, person: AVERY }, CTX)
      .catch(e => e)) as ToolError;
    expect(unsolved).toMatchObject({ kind: 'invalid_params', code: 'run_not_solved' });
    expect(mocks.explainPlacements).not.toHaveBeenCalled();

    mocks.explainPlacements.mockResolvedValueOnce([]);
    const absent = (await formTeamsGetTool
      .handler({ ...BASE, person: BLAIR }, CTX)
      .catch(e => e)) as ToolError;
    expect(absent).toMatchObject({ kind: 'invalid_params', code: 'person_not_in_run' });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('takes only a user id on the wire', () => {
    const person = formTeamsGetTool.inputSchema.person as z.ZodTypeAny;
    expect(person.safeParse(AVERY).success).toBe(true);
    expect(person.safeParse('Avery Quill').success).toBe(false);
  });
});

// ─── Release 2: the setup view ──────────────────────────────────────────────

describe('form_teams_get — the release-2 setup view', () => {
  const BASE = { classroom: 'org/w26', form_id: FORM_ID };
  const LOCKED_STATE = {
    status: 'DONE',
    run_number: 3,
    attempt: 1,
    total: 1,
    done: 1,
    failed: [],
    teams: [{ team_id: 't-1', name: 'bids-01' }],
  };

  it('shows the lock, and the changes since the last run without anyone’s name', async () => {
    mocks.listForForm.mockResolvedValue([
      {
        ...SUMMARY,
        status: 'created',
        created: { run_number: 3, teams_created: 1, finished_at: '2026-09-24T12:05:00.000Z' },
        created_run_id: 'run-3',
        create_state: LOCKED_STATE,
      },
    ]);
    mocks.getSet.mockResolvedValue({
      ...SET_ROW,
      status: 'created',
      locked: true,
      created_run_id: 'run-3',
      create_state: LOCKED_STATE,
    });
    mocks.listRuns.mockResolvedValue([
      {
        id: 'run-3',
        number: 3,
        status: 'SOLVED',
        created_at: '2026-09-24T12:00:00.000Z',
        finished_at: '2026-09-24T12:00:02.000Z',
        error: null,
        metrics: METRICS,
        stale: false,
      },
    ]);
    mocks.changesSinceRun.mockResolvedValue({
      run_number: 3,
      changes: [
        {
          kind: 'pin',
          pin_id: 'p4',
          change: 'added',
          pin: {
            id: 'p4',
            kind: 'on_option',
            people: [{ user_id: AVERY, name: 'Avery Quill' }],
            option: { id: 'opt-1', label: 'Ledger' },
            reason: null,
            added_by: null,
            added_via: null,
            added_at: null,
          },
          text: "Pin added: Avery Quill → 'Ledger'",
        },
        { kind: 'fairness', before: 50, after: 70, text: 'Fairness: 50 → 70' },
      ],
    });
    const payload = parse(await formTeamsGetTool.handler(BASE, CTX));
    // The mode a run would use now is read once and handed to the diff.
    expect(mocks.changesSinceRun).toHaveBeenCalledWith({
      classroomId: 'class-1',
      teamSetId: 'set-1',
      nonRespondents: 'include',
    });
    expect(payload.set).toMatchObject({ status: 'created', locked: true, create_status: 'done' });
    expect(payload.team_sets[0]).toMatchObject({ status: 'created', create_status: 'done' });
    expect(payload.changes_since_last_run).toEqual({
      run: 3,
      changes: ["Pin p4 added: on_option 'Ledger', 1 person", 'Fairness: 50 → 70'],
    });
    // This view is not audited, so it names no one.
    expect(JSON.stringify(payload)).not.toContain('Avery Quill');
    expect(mocks.auditCreate).not.toHaveBeenCalled();
    expect(payload.next).toMatch(/locked/);
    expect(payload.next).toMatch(/copy_from and new_set: true/);
  });

  it('reads no changes for a set that has never run', async () => {
    mocks.listForForm.mockResolvedValue([{ ...SUMMARY, run_count: 0, latest_run: null }]);
    mocks.getSet.mockResolvedValue(SET_ROW);
    const payload = parse(await formTeamsGetTool.handler(BASE, CTX));
    expect(mocks.changesSinceRun).not.toHaveBeenCalled();
    expect(payload).not.toHaveProperty('changes_since_last_run');
    expect(payload.set).toMatchObject({ status: 'setting_up', locked: false });
    expect(payload).not.toHaveProperty('next');
  });
});

// ─── Fix wave: names, audits, people-free views, counts ─────────────────────

describe('team-set tools — who a response names, and what it says', () => {
  const BASE = { classroom: 'org/w26', form_id: FORM_ID };

  it('maps name_taken to a sentence naming the set, with the name', async () => {
    mocks.saveConfig.mockRejectedValue(
      teamSetError('name_taken', 'A team set named "pairs" already exists on this form.', {
        name: 'pairs',
      })
    );
    const error = (await formTeamsRunTool
      .handler({ ...BASE, name: 'pairs' }, CTX)
      .catch(e => e)) as ToolError;
    expect(error.kind).toBe('invalid_params');
    expect(error.code).toBe('name_taken');
    expect(error.message).toBe(
      'This form already has a team set named "pairs"; pass team_set: "pairs" to edit it, or choose another name'
    );
    expect(error.data).toEqual({ name: 'pairs' });
  });

  it('forwards where each config problem is, aligned with the problems', async () => {
    mocks.getSet.mockResolvedValue(SET_ROW);
    mocks.saveConfig.mockRejectedValue(
      teamSetError('invalid_config', 'x', {
        problems: [
          'A pin places people on options, but teams are not grouped by a question.',
          'Two pins have the same id.',
        ],
        paths: ['pins.p1', ''],
      })
    );
    const error = (await formTeamsRunTool
      .handler({ ...BASE, patch: { fairness: 10 } }, CTX)
      .catch(e => e)) as ToolError;
    expect(error.code).toBe('invalid_config');
    expect(error.data).toEqual({
      problems: [
        'A pin places people on options, but teams are not grouped by a question.',
        'Two pins have the same id.',
      ],
      paths: ['pins.p1', ''],
    });
  });

  it('refuses to compare a run that is not solved, in words about comparing', async () => {
    mocks.getSet.mockResolvedValue(SET_ROW);
    mocks.getRun.mockResolvedValue({ ...RUN_ROW, status: 'SOLVED' });
    mocks.compareRuns.mockRejectedValue(
      teamSetError('run_not_solved', 'Run 2 is INFEASIBLE, not SOLVED.', {
        run_number: 2,
        status: 'INFEASIBLE',
      })
    );
    const error = (await formTeamsGetTool
      .handler({ ...BASE, run: 3, compare_with: 2 }, CTX)
      .catch(e => e)) as ToolError;
    expect(error.kind).toBe('invalid_params');
    expect(error.code).toBe('run_not_solved');
    expect(error.message).toBe('Run 2 is INFEASIBLE; only SOLVED runs can be compared');
    expect(error.data).toEqual({ run_number: 2, status: 'INFEASIBLE' });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('carries no person in a run view without people', async () => {
    mocks.getSet.mockResolvedValue(SET_ROW);
    mocks.getRun.mockResolvedValue({ ...RUN_ROW, status: 'INFEASIBLE' });
    mocks.describeRun.mockResolvedValue({
      ...RUN_VIEW,
      status: 'INFEASIBLE',
      teams: [],
      issues: [
        {
          level: 'warning',
          code: 'no_response',
          message: '2 people haven’t answered',
          user_ids: [AVERY, BLAIR],
          names: ['Avery Quill', 'Blair Stone'],
        },
      ],
      core: [
        {
          src: 'f:together@0+1',
          kind: 'rule',
          label: 'Who? (together, must)',
          user_ids: [AVERY, BLAIR],
          people: [
            { user_id: AVERY, name: 'Avery Quill' },
            { user_id: BLAIR, name: 'Blair Stone' },
          ],
          link: { tab: 'questions', field_id: 'f' },
        },
        {
          src: 'pin:p1',
          kind: 'pin',
          label: 'Pin: together — 2 students',
          user_ids: [AVERY, BLAIR],
          link: { tab: 'pins', pin_id: 'p1' },
        },
      ],
    });
    const payload = parse(
      await formTeamsGetTool.handler({ ...BASE, run: 3, include_people: false }, CTX)
    );
    expect(payload.run.issues[0]).toEqual({
      level: 'warning',
      code: 'no_response',
      message: '2 people haven’t answered',
      hint: expect.any(String),
    });
    expect(
      payload.run.core.map((item: Record<string, unknown>) => Object.keys(item).sort())
    ).toEqual([
      ['field_id', 'label', 'src'],
      ['label', 'pin_id', 'src'],
    ]);
    const json = JSON.stringify(payload);
    expect(json).not.toContain(AVERY);
    expect(json).not.toContain('Avery Quill');
    expect(mocks.auditCreate).not.toHaveBeenCalled();

    // With people, the same view names them — and is audited.
    const named = parse(await formTeamsGetTool.handler({ ...BASE, run: 3 }, CTX));
    expect(named.run.core[0].people).toHaveLength(2);
    expect(named.run.issues[0].names).toEqual(['Avery Quill', 'Blair Stone']);
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
  });

  it('audits the finished run a form_teams_run call returns with its members', async () => {
    mocks.getSet.mockResolvedValue(SET_ROW);
    await formTeamsRunTool.handler({ ...BASE, wait_s: 1 }, CTX);
    expect(mocks.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        resource_id: 'run-3',
        action: 'VIEW',
        data: expect.objectContaining({ tool: 'form_teams_run', run_number: 3 }),
      })
    );
  });

  it('audits a check and a refused start only when their issues name people', async () => {
    mocks.getSet.mockResolvedValue(SET_ROW);
    const named = {
      level: 'warning',
      code: 'no_response',
      message: '1 person hasn’t answered',
      user_ids: [AVERY],
      names: ['Avery Quill'],
    };
    mocks.checkPatch.mockResolvedValue({
      set: { id: 'set-1', name: 'project-bids-teams' },
      name: 'project-bids-teams',
      config: CONFIG,
      notes: [],
      issues: [named],
    });
    await formTeamsRunTool.handler({ ...BASE, check: true }, CTX);
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);
    expect(mocks.auditCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        resource_id: 'set-1',
        action: 'VIEW',
        data: expect.objectContaining({
          tool: 'form_teams_run',
          value: expect.stringMatching(/^check:/),
        }),
      })
    );

    mocks.auditCreate.mockClear();
    mocks.startRun.mockResolvedValue({
      run: null,
      issues: [{ level: 'error', code: 'capacity', message: 'Too many people' }, named],
    });
    await formTeamsRunTool.handler(BASE, CTX);
    const refusedRow = expect.objectContaining({
      resource_id: 'set-1',
      action: 'VIEW',
      data: expect.objectContaining({
        tool: 'form_teams_run',
        value: expect.stringMatching(/^checks:[0-9a-f]{12}$/),
      }),
    });
    expect(mocks.auditCreate).toHaveBeenCalledWith(refusedRow);
    // Refused starts of different patches are keyed apart, so neither row is merged away.
    const valueOf = () =>
      (mocks.auditCreate.mock.calls.at(-1)![0] as { data: { value: string } }).data.value;
    const first = valueOf();
    await formTeamsRunTool.handler({ ...BASE, patch: { fairness: 70 } }, CTX);
    expect(valueOf()).toMatch(/^checks:/);
    expect(valueOf()).not.toBe(first);

    // Nobody named: nothing to audit.
    mocks.auditCreate.mockClear();
    mocks.checkPatch.mockResolvedValue({
      set: { id: 'set-1', name: 'project-bids-teams' },
      name: 'project-bids-teams',
      config: CONFIG,
      notes: [],
      issues: [{ level: 'error', code: 'capacity', message: 'Too many people' }],
    });
    await formTeamsRunTool.handler({ ...BASE, check: true }, CTX);
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('says a checked set is locked, and that the patch can’t be saved', async () => {
    mocks.getSet.mockResolvedValue({ ...SET_ROW, status: 'created', locked: true });
    const payload = parse(
      await formTeamsRunTool.handler({ ...BASE, check: true, patch: { fairness: 10 } }, CTX)
    );
    expect(payload).toMatchObject({ checked: true, saved: false, locked: true });
    expect(payload.next).toMatch(/This set is locked/);
    expect(payload.next).toMatch(/copy_from and new_set: true/);
    expect(mocks.saveConfig).not.toHaveBeenCalled();
  });

  it('shows what Must means for each rule in the setup view', async () => {
    mocks.listForForm.mockResolvedValue([SUMMARY]);
    const config = {
      ...CONFIG,
      rules: [{ field_id: 'f-rank', job: 'rank', strength: 'prefer', weight: 5, params: {} }],
    };
    mocks.getSet.mockResolvedValue({ ...SET_ROW, config });
    mocks.mustLabels.mockResolvedValue({
      'f-rank:rank': 'Everyone gets one of the options they ranked',
    });
    const payload = parse(await formTeamsGetTool.handler(BASE, CTX));
    expect(mocks.mustLabels).toHaveBeenCalledWith({
      classroomId: 'class-1',
      formId: FORM_ID,
      config,
    });
    expect(payload.set.must_labels).toEqual({
      'f-rank:rank': 'Everyone gets one of the options they ranked',
    });
  });

  it('reports each made team’s members and the teams a retry renamed in create_state', async () => {
    mocks.listForForm.mockResolvedValue([SUMMARY]);
    mocks.getSet.mockResolvedValue({
      ...SET_ROW,
      created_run_id: 'run-3',
      status: 'creating',
      locked: true,
      create_state: {
        status: 'RUNNING',
        run_id: 'run-3',
        run_number: 3,
        total: 2,
        done: 1,
        failed: [],
        teams: [{ team_id: 't-1', name: 'pb-01', n: 1, members_added: 2 }],
        names: ['pb-01', 'pb-02-2'],
        sizes: [3, 2],
        renamed: [{ n: 2, from: 'pb-02', to: 'pb-02-2' }],
        claimed_by: 'owner-1',
        started_at: '2026-09-24T12:00:00.000Z',
        finished_at: null,
      },
    });
    const payload = parse(await formTeamsGetTool.handler(BASE, CTX));
    expect(payload.set.create_state.teams).toEqual([
      { team_id: 't-1', name: 'pb-01', n: 1, members_added: 2, size: 3 },
    ]);
    expect(payload.set.create_state.renamed).toEqual([{ n: 2, from: 'pb-02', to: 'pb-02-2' }]);
  });
});

// ─── W9: people only where audited, one code per fact ───────────────────────

describe('team-set tools — people only in audited reads', () => {
  const BASE = { classroom: 'org/w26', form_id: FORM_ID };

  /** A create that failed partway: one team made, two members not added. */
  const FAILED_STATE = {
    status: 'FAILED',
    run_id: 'run-3',
    run_number: 3,
    total: 2,
    done: 1,
    failed: [
      {
        team: 'pb-01',
        reason: 'members_failed',
        members: [
          { user_id: AVERY, login: 'aquill', reason: 'github_user_not_found' },
          { user_id: BLAIR, login: null, reason: 'no_login' },
        ],
      },
      { team: 'pb-02', reason: 'provider_error' },
    ],
    teams: [{ team_id: 't-1', name: 'pb-01', n: 1, members_added: 1 }],
    names: ['pb-01', 'pb-02'],
    sizes: [3, 2],
    claimed_by: 'owner-1',
    started_at: '2026-09-24T12:00:00.000Z',
    finished_at: '2026-09-24T12:01:00.000Z',
  };
  const FAILED_SET = {
    ...SET_ROW,
    created_run_id: 'run-3',
    status: 'create_failed',
    locked: true,
    create_state: FAILED_STATE,
  };

  it('counts the members a create couldn’t add in the setup view, without naming them', async () => {
    mocks.listForForm.mockResolvedValue([{ ...SUMMARY, created_run_id: 'run-3' }]);
    mocks.getSet.mockResolvedValue(FAILED_SET);
    const payload = parse(await formTeamsGetTool.handler(BASE, CTX));
    expect(payload.set.create_state.failed).toEqual([
      { team: 'pb-01', reason: 'members_failed', members_failed: 2 },
      { team: 'pb-02', reason: 'provider_error' },
    ]);
    const json = JSON.stringify(payload);
    expect(json).not.toContain(AVERY);
    expect(json).not.toContain('aquill');
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('names them in a run read with people (audited), and counts them without', async () => {
    mocks.getSet.mockResolvedValue(FAILED_SET);
    mocks.getRun.mockResolvedValue({ ...RUN_ROW, status: 'SOLVED' });
    const named = parse(await formTeamsGetTool.handler({ ...BASE, run: 3 }, CTX));
    expect(named.create_state.failed[0].members).toEqual([
      { user_id: AVERY, login: 'aquill', reason: 'github_user_not_found' },
      { user_id: BLAIR, login: null, reason: 'no_login' },
    ]);
    expect(mocks.auditCreate).toHaveBeenCalledTimes(1);

    mocks.auditCreate.mockClear();
    const bare = parse(
      await formTeamsGetTool.handler({ ...BASE, run: 3, include_people: false }, CTX)
    );
    expect(bare.create_state.failed[0]).toEqual({
      team: 'pb-01',
      reason: 'members_failed',
      members_failed: 2,
    });
    expect(JSON.stringify(bare)).not.toContain(AVERY);
    expect(JSON.stringify(bare)).not.toContain('aquill');
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('says who closed an option, and who is paired with whom, only in a view with people', async () => {
    mocks.getSet.mockResolvedValue(SET_ROW);
    mocks.getRun.mockResolvedValue({ ...RUN_ROW, status: 'INFEASIBLE' });
    mocks.describeRun.mockResolvedValue({
      ...RUN_VIEW,
      status: 'INFEASIBLE',
      teams: [],
      core: [
        {
          src: 'f:together@0+1',
          kind: 'rule',
          label: 'Who? (together, must)',
          user_ids: [AVERY, BLAIR],
          people: [
            { user_id: AVERY, name: 'Avery Quill' },
            { user_id: BLAIR, name: 'Blair Stone' },
          ],
          pairs: [[0, 1]],
          link: { tab: 'questions', field_id: 'f' },
        },
        {
          src: 'option:opt-1',
          kind: 'option',
          label: "'Ledger' is closed",
          option: {
            id: 'opt-1',
            label: 'Ledger',
            open: 'closed',
            note: null,
            // No name resolved: the payload would fall back to the user id.
            closed: { since_run: 2, by: { user_id: 'owner-1', name: null }, via: 'page' },
          },
          link: { tab: 'projects', option_id: 'opt-1' },
        },
      ],
    });
    const named = parse(await formTeamsGetTool.handler({ ...BASE, run: 3 }, CTX));
    expect(named.run.core[0].pairs).toEqual([[0, 1]]);
    expect(named.run.core[1].option.closed).toEqual({ since_run: 2, by: 'owner-1', via: 'page' });

    const bare = parse(
      await formTeamsGetTool.handler({ ...BASE, run: 3, include_people: false }, CTX)
    );
    expect(bare.run.core[0]).not.toHaveProperty('pairs');
    expect(bare.run.core[1].option.closed).toEqual({ since_run: 2, via: 'page' });
    expect(JSON.stringify(bare)).not.toContain('owner-1');
  });

  it('never forwards a person on the issues an error carries', async () => {
    mocks.getSet.mockResolvedValue(SET_ROW);
    mocks.startRun.mockRejectedValueOnce(
      teamSetError('checks_failed', 'Blocked.', {
        issues: [
          {
            level: 'error',
            code: 'no_response',
            message: '1 person hasn’t answered',
            user_ids: [AVERY],
            names: ['Avery Quill'],
          },
        ],
      })
    );
    const error = (await formTeamsRunTool.handler(BASE, CTX).catch(e => e)) as ToolError;
    expect(error.code).toBe('checks_failed');
    expect((error.data as { issues: unknown[] }).issues).toEqual([
      {
        level: 'error',
        code: 'no_response',
        message: '1 person hasn’t answered',
        hint: expect.any(String),
      },
    ]);
    expect(JSON.stringify(error.data)).not.toContain(AVERY);
  });
});

describe('team-set tools — how people who didn’t answer are placed', () => {
  const BASE = { classroom: 'org/w26', form_id: FORM_ID };

  it('shows the setting and the mode a run would use now in the setup view', async () => {
    mocks.listForForm.mockResolvedValue([SUMMARY]);
    mocks.getSet.mockResolvedValue(SET_ROW);
    mocks.nonRespondentsFor.mockResolvedValue({ setting: null, resolved: 'include' });
    const payload = parse(await formTeamsGetTool.handler(BASE, CTX));
    expect(mocks.nonRespondentsFor).toHaveBeenCalledWith({
      classroomId: 'class-1',
      teamSetId: 'set-1',
    });
    expect(payload.set.non_respondents).toEqual({ setting: null, resolved: 'include' });
    expect(payload.patch_help.other).toMatch(/non_respondents\.resolved/);
  });

  it('never echoes the retired allow_one_larger', async () => {
    // The service drops it on every read; the tool drops it too.
    const retired = { ...CONFIG, team_size: { min: 3, max: 4, allow_one_larger: true } };
    mocks.listForForm.mockResolvedValue([SUMMARY]);
    mocks.getSet.mockResolvedValue({ ...SET_ROW, config: retired });
    const payload = parse(await formTeamsGetTool.handler(BASE, CTX));
    expect(payload.set.config.team_size).toEqual({ min: 3, max: 4 });
    expect(JSON.stringify(payload)).not.toContain('allow_one_larger');
    mocks.checkPatch.mockResolvedValueOnce({
      set: null,
      name: 'x',
      config: retired,
      notes: [],
      issues: [],
    });
    const checked = parse(await formTeamsRunTool.handler({ ...BASE, check: true }, CTX));
    expect(checked.config.team_size).toEqual({ min: 3, max: 4 });
  });

  it('gives a check the would-be mode, closed vocabulary only', async () => {
    mocks.checkPatch.mockResolvedValueOnce({
      set: null,
      name: 'x',
      config: CONFIG,
      notes: [],
      issues: [],
      non_respondents: { setting: null, resolved: 'include' },
    });
    const checked = parse(await formTeamsRunTool.handler({ ...BASE, check: true }, CTX));
    expect(checked.non_respondents).toEqual({ setting: null, resolved: 'include' });

    mocks.checkPatch.mockResolvedValueOnce({
      set: null,
      name: 'x',
      config: CONFIG,
      notes: [],
      issues: [],
      non_respondents: { setting: 'sideways', resolved: 'include' },
    });
    const odd = parse(await formTeamsRunTool.handler({ ...BASE, check: true }, CTX));
    expect(odd).not.toHaveProperty('non_respondents');
  });

  it('relays what Discard left out of the run’s setup', async () => {
    mocks.getSet.mockResolvedValue(SET_ROW);
    mocks.revertToRun.mockResolvedValue({
      ...SET_ROW,
      notes: ['Left out of run 2’s setup: 1 pin.'],
    });
    const payload = parse(await formTeamsRunTool.handler({ ...BASE, revert_to_run: 2 }, CTX));
    expect(payload.notes).toEqual(['Left out of run 2’s setup: 1 pin.']);
    expect(payload.next).toMatch(/except what notes lists/);
  });

  it('maps set_busy to its own sentence', async () => {
    mocks.getSet.mockResolvedValue(SET_ROW);
    mocks.saveConfig.mockRejectedValueOnce(
      teamSetError('set_busy', 'Another save or run held this set; this change was not saved.')
    );
    const error = (await formTeamsRunTool
      .handler({ ...BASE, patch: { fairness: 60 } }, CTX)
      .catch(e => e)) as ToolError;
    expect(error).toBeInstanceOf(ToolError);
    expect(error.code).toBe('set_busy');
    expect(error.kind).toBe('invalid_params');
    expect(error.message).toMatch(/not saved/);
    expect(error.message).toMatch(/same arguments/);
  });

  it('asks for the same call again when a revert was the busy part (it has no patch)', async () => {
    mocks.getSet.mockResolvedValue(SET_ROW);
    mocks.revertToRun.mockRejectedValueOnce(
      teamSetError('set_busy', 'Another save or run held this set; this change was not saved.')
    );
    const error = (await formTeamsRunTool
      .handler({ ...BASE, revert_to_run: 2 }, CTX)
      .catch(e => e)) as ToolError;
    expect(error).toBeInstanceOf(ToolError);
    expect(error.code).toBe('set_busy');
    expect(error.message).toMatch(/not saved; call again with the same arguments/);
    expect(error.message).not.toMatch(/patch/);
  });

  it('says no run was started when the run’s start was the busy part', async () => {
    mocks.getSet.mockResolvedValue(SET_ROW);
    mocks.startRun.mockRejectedValueOnce(
      teamSetError('set_busy', 'Another save or run held this set; no run was started.', {
        action: 'run',
      })
    );
    const error = (await formTeamsRunTool
      .handler({ ...BASE, patch: { fairness: 60 } }, CTX)
      .catch(e => e)) as ToolError;
    expect(error).toBeInstanceOf(ToolError);
    expect(error.code).toBe('set_busy');
    expect(error.message).toMatch(/no run was started \(a patch, if any, was saved\)/);
  });

  it('points the group hints at a second team per option, and at Spread', async () => {
    const hintFor = async (code: string) => {
      mocks.checkPatch.mockResolvedValueOnce({
        set: null,
        name: 'x',
        config: CONFIG,
        notes: [],
        issues: [{ level: 'error', code, message: 'fact' }],
      });
      const payload = parse(await formTeamsRunTool.handler({ ...BASE, check: true }, CTX));
      return payload.issues[0].hint as string;
    };
    expect(await hintFor('group_no_option')).toMatch(/grouping\.teams_per_option/);
    expect(await hintFor('capacity')).toMatch(/Spread \(non_respondents: include\)/);
  });
});
