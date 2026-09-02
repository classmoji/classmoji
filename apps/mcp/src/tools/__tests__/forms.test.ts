/**
 * Unit tests for the forms tool batch — list_forms / form_get / form_create /
 * form_update / form_publish / form_delete / list_form_responses /
 * form_response_get / form_response_update.
 *
 * Security focus (the S1/S4 audit posture, applied to a surface that holds
 * applicant PII):
 *   - S4 role parity: every tool is OWNER|TEACHER, the tier apps/pages'
 *     `assertFormAdmin` composes. ASSISTANT and STUDENT are absent from all
 *     nine, so the registry never even resolves a context for them.
 *   - The Pro gate runs in EVERY handler — reads included, as on the web —
 *     and before any service call.
 *   - S1: a form id from another classroom is indistinguishable from an unknown
 *     one, and no service read/write happens on either. A response id belonging
 *     to another form is narrowed away the same way.
 *   - The response allowlist: `formResponse.listByFormId` returns `draft_token`
 *     (a bearer credential for an anonymous partial) and `email_normalized`.
 *     Neither may appear in any payload.
 *   - Definitions round-trip: the stored envelope is echoed, never re-parsed
 *     (re-parsing re-mints field ids and orphans every stored answer).
 *
 * Only the service boundary and the platform Pro gate are mocked — these tools
 * fire no external effects. Schema-level rules (confirm:true, the enums, the
 * absent `slug`) are asserted against `tool.inputSchema` itself, because the
 * registry/SDK validates arguments BEFORE the handler runs.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ToolError } from '../../mcp/errors.ts';
import { toolAnnotations, type ToolContext, type ToolDefinition } from '../../mcp/registry.ts';

const mocks = vi.hoisted(() => ({
  assertProTier: vi.fn(),
  formFindByClassroomId: vi.fn(),
  formFindById: vi.fn(),
  formGetCurrentRevision: vi.fn(),
  formListRevisions: vi.fn(),
  formCreate: vi.fn(),
  formUpdate: vi.fn(),
  formPublish: vi.fn(),
  formClose: vi.fn(),
  formReopen: vi.fn(),
  formQuickUpdate: vi.fn(),
  formDelete: vi.fn(),
  responseListByFormId: vi.fn(),
  responseStatusLabels: vi.fn(),
  responseUpdateStaff: vi.fn(),
  withoutTargetEmails: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock('@classmoji/auth/server', () => ({
  assertProTier: (...a: unknown[]) => mocks.assertProTier(...a),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    form: {
      findByClassroomId: (...a: unknown[]) => mocks.formFindByClassroomId(...a),
      findById: (...a: unknown[]) => mocks.formFindById(...a),
      getCurrentRevision: (...a: unknown[]) => mocks.formGetCurrentRevision(...a),
      listRevisions: (...a: unknown[]) => mocks.formListRevisions(...a),
      create: (...a: unknown[]) => mocks.formCreate(...a),
      update: (...a: unknown[]) => mocks.formUpdate(...a),
      publish: (...a: unknown[]) => mocks.formPublish(...a),
      close: (...a: unknown[]) => mocks.formClose(...a),
      reopen: (...a: unknown[]) => mocks.formReopen(...a),
      quickUpdate: (...a: unknown[]) => mocks.formQuickUpdate(...a),
      deleteForm: (...a: unknown[]) => mocks.formDelete(...a),
    },
    formResponse: {
      listByFormId: (...a: unknown[]) => mocks.responseListByFormId(...a),
      statusLabelSuggestions: (...a: unknown[]) => mocks.responseStatusLabels(...a),
      updateStaff: (...a: unknown[]) => mocks.responseUpdateStaff(...a),
    },
    audit: { create: (...a: unknown[]) => mocks.auditCreate(...a) },
    /**
     * The reviewee-email projection.
     *
     * Mocked like every other service call, and asserted the same way: the
     * MCP layer's job is to DELEGATE to the shared projection rather than echo
     * the raw snapshot, and that is what the tests below pin. What the
     * projection itself removes is `formTeamResolver`'s own property, covered
     * in `packages/services/…/forms.teamReview.test.ts` — it cannot be imported
     * here, because that module opens a Prisma client at module scope and this
     * suite exists to run without one.
     */
    formTeam: { withoutTargetEmails: (...a: unknown[]) => mocks.withoutTargetEmails(...a) },
  },
}));

const {
  listFormsTool,
  formGetTool,
  formCreateTool,
  formUpdateTool,
  formPublishTool,
  formDeleteTool,
  listFormResponsesTool,
  formResponseGetTool,
  formResponseUpdateTool,
} = await import('../forms.ts');

const ALL_TOOLS: ToolDefinition<never>[] = [
  listFormsTool,
  formGetTool,
  formCreateTool,
  formUpdateTool,
  formPublishTool,
  formDeleteTool,
  listFormResponsesTool,
  formResponseGetTool,
  formResponseUpdateTool,
] as unknown as ToolDefinition<never>[];

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

const DEFINITION = {
  definition_version: 1,
  fields: [
    { id: 'f-name', type: 'short_text', label: 'Your name', required: true },
    {
      id: 'f-why',
      type: 'long_text',
      label: 'Why do you want to take this class?',
      required: false,
    },
  ],
};

const FORM_ROW = {
  id: 'form-1',
  classroom_id: 'class-1',
  title: 'CS52 Waitlist',
  slug: 'cs52-waitlist-mcp-test',
  description: 'Join the list',
  access: 'PUBLIC',
  status: 'OPEN',
  draft_fields: DEFINITION,
  current_revision_id: 'rev-1',
  response_cap: null,
  closes_at: new Date('2026-09-30T04:00:00.000Z'),
  allow_multiple: false,
  save_partials: false,
  confirmation_email: false,
  created_at: new Date('2026-08-01T00:00:00.000Z'),
  updated_at: new Date('2026-08-20T00:00:00.000Z'),
};

/** A form that exists, but in ANOTHER classroom. */
const FOREIGN_FORM = { ...FORM_ROW, id: 'form-x', classroom_id: 'class-2' };

/**
 * A response row exactly as `formResponse.listByFormId` returns it — WITH the
 * two columns that must never be echoed.
 */
const RESPONSE_ROW = {
  id: 'resp-1',
  form_id: 'form-1',
  name: 'Maya Chen',
  email: 'Maya.Chen@dartmouth.edu',
  email_normalized: 'maya.chen@dartmouth.edu',
  user_id: 'user-9',
  submitted_at: new Date('2026-08-21T12:00:00.000Z'),
  verified_at: new Date('2026-08-21T12:05:00.000Z'),
  updated_at: new Date('2026-08-21T12:05:00.000Z'),
  submission_state: 'SUBMITTED',
  staff_status: null,
  staff_note: null,
  revision_id: 'rev-1',
  answers: { 'f-name': 'Maya Chen', 'f-why': 'I want to build things' },
  resolved_context: null,
  draft_token: 'SECRET-DRAFT-TOKEN',
};

function parse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

/** The 403 the lifted platform gate throws for a non-Pro classroom. */
const proDenial = () => new Response('This feature requires a Pro subscription', { status: 403 });

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.assertProTier.mockResolvedValue(undefined);
  mocks.auditCreate.mockResolvedValue(undefined);
  mocks.formListRevisions.mockResolvedValue([]);
  mocks.responseStatusLabels.mockResolvedValue([]);
  // Stands in for the real projection: strips `email` from every target and
  // leaves the rest of the snapshot alone, so a payload assertion still reads
  // the shape the tools actually emit.
  mocks.withoutTargetEmails.mockImplementation((snapshot: unknown) => {
    if (!snapshot || typeof snapshot !== 'object') return snapshot;
    const context = snapshot as { targets?: unknown };
    if (!context.targets || typeof context.targets !== 'object') return snapshot;
    const targets = Object.fromEntries(
      Object.entries(context.targets as Record<string, unknown>).map(([groupId, list]) => [
        groupId,
        Array.isArray(list)
          ? list.map(entry => {
              if (!entry || typeof entry !== 'object') return entry;
              const { email: _email, ...rest } = entry as Record<string, unknown>;
              return rest;
            })
          : list,
      ])
    );
    return { ...context, targets };
  });
});

// ─── Definition-level guarantees (the registry enforces these pre-handler) ───

describe('forms tool definitions', () => {
  it('gates every tool on OWNER|TEACHER — the assertFormAdmin tier', () => {
    for (const tool of ALL_TOOLS) {
      expect(tool.roles).toEqual(['OWNER', 'TEACHER']);
    }
  });

  it('never admits an assistant or a student to any forms tool', () => {
    for (const tool of ALL_TOOLS) {
      expect(tool.roles).not.toContain('ASSISTANT');
      expect(tool.roles).not.toContain('STUDENT');
    }
  });

  it('takes a classroom argument on every tool (the registry requires it)', () => {
    for (const tool of ALL_TOOLS) {
      expect(tool.inputSchema).toHaveProperty('classroom');
    }
  });

  it('declares complete, honest annotations', () => {
    // Reads: readOnlyHint true; nothing here reaches an external system.
    for (const tool of [listFormsTool, formGetTool, listFormResponsesTool, formResponseGetTool]) {
      expect(toolAnnotations(tool as unknown as ToolDefinition<never>)).toEqual({
        readOnlyHint: true,
        openWorldHint: false,
      });
    }
    // Writes: only the delete is destructive.
    expect(formCreateTool.annotations).toEqual({ destructive: false, openWorld: false });
    expect(formUpdateTool.annotations).toEqual({ destructive: false, openWorld: false });
    expect(formDeleteTool.annotations).toEqual({ destructive: true, openWorld: false });
    // form_publish is NOT idempotent: every publish snapshots a new revision.
    expect(formPublishTool.annotations?.idempotent).toBe(false);
    expect(formPublishTool.annotations?.destructive).toBe(false);
    // Setting the same triage label twice changes nothing.
    expect(formResponseUpdateTool.annotations?.idempotent).toBe(true);
    expect(formResponseUpdateTool.annotations?.destructive).toBe(false);
    // No forms tool sends email or touches GitHub.
    for (const tool of ALL_TOOLS) {
      expect(toolAnnotations(tool).openWorldHint).toBe(false);
    }
  });

  it('requires confirm:true to delete a form', () => {
    const confirm = formDeleteTool.inputSchema.confirm as z.ZodTypeAny;
    expect(confirm.safeParse(true).success).toBe(true);
    expect(confirm.safeParse(false).success).toBe(false);
    expect(confirm.safeParse(undefined).success).toBe(false);
  });

  it('does not let any tool set a form slug (it is the permanent address)', () => {
    for (const tool of ALL_TOOLS) {
      expect(tool.inputSchema).not.toHaveProperty('slug');
    }
  });

  it('does not let form_response_update touch the answers', () => {
    expect(formResponseUpdateTool.inputSchema).not.toHaveProperty('answers');
    expect(Object.keys(formResponseUpdateTool.inputSchema).sort()).toEqual([
      'classroom',
      'form_id',
      'response_id',
      'staff_note',
      'staff_status',
    ]);
  });
});

// ─── The Pro gate (in-handler, on reads too) ────────────────────────────────

describe('Pro gating', () => {
  /** A superset of every tool's required arguments; each ignores the rest. */
  const ARGS_FOR_ANY_TOOL: Record<string, unknown> = {
    classroom: 'org/w26',
    form_id: 'form-1',
    response_id: 'resp-1',
    title: 'A form',
    access: 'PUBLIC',
    confirm: true,
    staff_status: 'on roster',
  };

  it('denies every tool — reads included — before any service call', async () => {
    for (const tool of ALL_TOOLS) {
      for (const m of Object.values(mocks)) m.mockClear();
      mocks.assertProTier.mockRejectedValue(proDenial());

      const error = await tool.handler(ARGS_FOR_ANY_TOOL as never, CTX).catch(e => e);

      expect(error, `${tool.name} must deny`).toBeInstanceOf(ToolError);
      expect((error as ToolError).kind).toBe('forbidden');
      // Nothing about the classroom's forms was read or written.
      expect(mocks.formFindById).not.toHaveBeenCalled();
      expect(mocks.formFindByClassroomId).not.toHaveBeenCalled();
      expect(mocks.responseListByFormId).not.toHaveBeenCalled();
      expect(mocks.formCreate).not.toHaveBeenCalled();
      expect(mocks.formUpdate).not.toHaveBeenCalled();
      expect(mocks.formDelete).not.toHaveBeenCalled();
      expect(mocks.responseUpdateStaff).not.toHaveBeenCalled();
    }
  });

  it('asks the gate about the AUTHORIZED classroom slug, never an argument', async () => {
    mocks.formFindByClassroomId.mockResolvedValue([]);
    await listFormsTool.handler({ classroom: 'other-org/some-other-slug' } as never, CTX);
    expect(mocks.assertProTier).toHaveBeenCalledWith('w26');
    expect(mocks.assertProTier).not.toHaveBeenCalledWith('some-other-slug');
  });
});

// ─── S1: cross-classroom scoping ────────────────────────────────────────────

describe('cross-classroom scoping (S1)', () => {
  const BY_ID_TOOLS: Array<[string, ToolDefinition<never>, Record<string, unknown>]> = [
    ['form_get', formGetTool as never, {}],
    ['form_update', formUpdateTool as never, { title: 'Renamed' }],
    ['form_publish', formPublishTool as never, {}],
    ['form_delete', formDeleteTool as never, { confirm: true }],
    ['list_form_responses', listFormResponsesTool as never, {}],
    ['form_response_get', formResponseGetTool as never, { response_id: 'resp-1' }],
    [
      'form_response_update',
      formResponseUpdateTool as never,
      { response_id: 'resp-1', staff_status: 'on roster' },
    ],
  ];

  it('refuses a form from another classroom, with no data and no writes', async () => {
    for (const [name, tool, extra] of BY_ID_TOOLS) {
      for (const m of Object.values(mocks)) m.mockClear();
      mocks.assertProTier.mockResolvedValue(undefined);
      mocks.formFindById.mockResolvedValue(FOREIGN_FORM);

      const error = await tool
        .handler({ classroom: 'org/w26', form_id: 'form-x', ...extra } as never, CTX)
        .catch(e => e);

      expect(error, `${name} must refuse`).toBeInstanceOf(ToolError);
      expect((error as ToolError).kind).toBe('not_found');
      // The uniform message: identical to an id that does not exist at all.
      expect((error as ToolError).message).toBe('Form not found in this classroom');
      // Nothing of the foreign form leaked, and nothing was written.
      expect(JSON.stringify((error as ToolError).message)).not.toContain('CS52 Waitlist');
      expect(mocks.responseListByFormId).not.toHaveBeenCalled();
      expect(mocks.formUpdate).not.toHaveBeenCalled();
      expect(mocks.formPublish).not.toHaveBeenCalled();
      expect(mocks.formDelete).not.toHaveBeenCalled();
      expect(mocks.responseUpdateStaff).not.toHaveBeenCalled();
    }
  });

  it('gives an unknown form id the identical error (no existence leak)', async () => {
    mocks.formFindById.mockResolvedValue(null);
    const unknown = await formGetTool
      .handler({ classroom: 'org/w26', form_id: 'form-nope' } as never, CTX)
      .catch(e => e);

    mocks.formFindById.mockResolvedValue(FOREIGN_FORM);
    const foreign = await formGetTool
      .handler({ classroom: 'org/w26', form_id: 'form-x' } as never, CTX)
      .catch(e => e);

    expect((unknown as ToolError).kind).toBe((foreign as ToolError).kind);
    expect((unknown as ToolError).message).toBe((foreign as ToolError).message);
  });

  it('lists only the AUTHORIZED classroom’s forms, never an argument’s', async () => {
    mocks.formFindByClassroomId.mockResolvedValue([{ ...FORM_ROW, _count: { responses: 7 } }]);
    const payload = parse(
      await listFormsTool.handler({ classroom: 'other-org/other' } as never, CTX)
    );
    expect(mocks.formFindByClassroomId).toHaveBeenCalledWith('class-1');
    expect(payload.forms[0].response_count).toBe(7);
  });

  it('refuses a response id that belongs to another form', async () => {
    mocks.formFindById.mockResolvedValue(FORM_ROW);
    // This form's responses do not include `resp-elsewhere`.
    mocks.responseListByFormId.mockResolvedValue([RESPONSE_ROW]);

    for (const tool of [formResponseGetTool, formResponseUpdateTool]) {
      const error = await tool
        .handler(
          {
            classroom: 'org/w26',
            form_id: 'form-1',
            response_id: 'resp-elsewhere',
            staff_status: 'on roster',
          } as never,
          CTX
        )
        .catch(e => e);
      expect(error).toBeInstanceOf(ToolError);
      expect((error as ToolError).kind).toBe('not_found');
      expect((error as ToolError).message).toBe('Form response not found in this classroom');
    }
    expect(mocks.responseUpdateStaff).not.toHaveBeenCalled();
  });
});

// ─── PII allowlist ──────────────────────────────────────────────────────────

describe('response allowlist', () => {
  beforeEach(() => {
    mocks.formFindById.mockResolvedValue(FORM_ROW);
    mocks.responseListByFormId.mockResolvedValue([RESPONSE_ROW]);
    mocks.formGetCurrentRevision.mockResolvedValue({ id: 'rev-1', fields: DEFINITION });
    mocks.responseUpdateStaff.mockResolvedValue({ ...RESPONSE_ROW, staff_status: 'on roster' });
  });

  it('never echoes draft_token or email_normalized from any response tool', async () => {
    const payloads = [
      parse(
        await listFormResponsesTool.handler(
          { classroom: 'org/w26', form_id: 'form-1' } as never,
          CTX
        )
      ),
      parse(
        await formResponseGetTool.handler(
          { classroom: 'org/w26', form_id: 'form-1', response_id: 'resp-1' } as never,
          CTX
        )
      ),
      parse(
        await formResponseUpdateTool.handler(
          {
            classroom: 'org/w26',
            form_id: 'form-1',
            response_id: 'resp-1',
            staff_status: 'on roster',
          } as never,
          CTX
        )
      ),
    ];

    for (const payload of payloads) {
      const json = JSON.stringify(payload);
      expect(json).not.toContain('SECRET-DRAFT-TOKEN');
      expect(json).not.toContain('draft_token');
      expect(json).not.toContain('email_normalized');
      // …while the as-typed email a human reads survives.
      expect(json).toContain('Maya.Chen@dartmouth.edu');
    }
  });

  /**
   * A PEER REVIEW is a response about other people.
   *
   * `resolved_context` snapshots each REVIEWEE's name, login and email so the
   * staff CSV can still identify someone who has left the course. Echoed
   * verbatim, a single `list_form_responses` on a peer-review form hands an
   * agent every teammate's address once per response — a class roster's worth of
   * PII, in a payload a model may quote back or carry into another tool call.
   *
   * The reviewer's own address stays (it is who the response is FROM, and the
   * allowlist above pins it). The reviewees keep their name and user id, which
   * is what every read surface actually displays.
   */
  it('strips reviewee emails from the resolved_context snapshot', async () => {
    const withReview = {
      ...RESPONSE_ROW,
      resolved_context: {
        targets: {
          'group-1': [
            {
              user_id: 'user-11',
              name: 'Ari Patel',
              login: 'apatel',
              email: 'ari.patel@dartmouth.edu',
              removed: false,
            },
            {
              user_id: 'user-12',
              name: 'Jo Rivera',
              login: 'jrivera',
              email: 'jo.rivera@dartmouth.edu',
              removed: true,
            },
          ],
        },
        groups: { 'group-1': { team_id: 't-1', team_name: 'Team Otter' } },
      },
    };
    mocks.responseListByFormId.mockResolvedValue([withReview]);

    const payload = parse(
      await formResponseGetTool.handler(
        { classroom: 'org/w26', form_id: 'form-1', response_id: 'resp-1' } as never,
        CTX
      )
    );
    const json = JSON.stringify(payload);

    expect(json).not.toContain('ari.patel@dartmouth.edu');
    expect(json).not.toContain('jo.rivera@dartmouth.edu');
    // Everything an instructor reads a review by is still there, including the
    // departed-teammate marker the export depends on.
    expect(json).toContain('Ari Patel');
    expect(json).toContain('user-12');
    expect(json).toContain('Team Otter');
    expect(payload.response.resolved_context.targets['group-1'][1].removed).toBe(true);
    // The reviewer is not a reviewee: their own address is the identity of the
    // response and must survive.
    expect(json).toContain('Maya.Chen@dartmouth.edu');

    // And the tool DELEGATES rather than re-implementing the rule — the same
    // projection the fill page uses, so the two cannot drift.
    expect(mocks.withoutTargetEmails).toHaveBeenCalledWith(withReview.resolved_context);
  });

  it('serializes dates as ISO strings, not raw Date objects', async () => {
    const payload = parse(
      await formResponseGetTool.handler(
        { classroom: 'org/w26', form_id: 'form-1', response_id: 'resp-1' } as never,
        CTX
      )
    );
    expect(payload.response.submitted_at).toBe('2026-08-21T12:00:00.000Z');
    expect(payload.form.closes_at).toBe('2026-09-30T04:00:00.000Z');
  });
});

// ─── form_create ────────────────────────────────────────────────────────────

describe('form_create', () => {
  const ARGS = { classroom: 'org/w26', title: 'CS52 Waitlist', access: 'PUBLIC' as const };

  it('creates under the ctx classroom, credits the ctx user, and audits CREATE', async () => {
    mocks.formCreate.mockResolvedValue({ ...FORM_ROW, status: 'DRAFT', current_revision_id: null });

    const payload = parse(await formCreateTool.handler(ARGS as never, CTX));
    expect(payload.success).toBe(true);
    expect(payload.form.status).toBe('DRAFT');
    expect(payload.form.published).toBe(false);

    const input = mocks.formCreate.mock.calls[0][0] as Record<string, unknown>;
    expect(input.classroomId).toBe('class-1');
    expect(input.createdBy).toBe('owner-1');
    expect(input).not.toHaveProperty('slug');
    // No field list supplied → the key must be ABSENT, not undefined: passing
    // it at all makes the service validate it.
    expect('fields' in input).toBe(false);

    const audit = mocks.auditCreate.mock.calls[0][0] as {
      action: string;
      classroom_id: string;
      resource_type: string;
      data: { tool: string; via: string; mcp_tool: string };
    };
    expect(audit.action).toBe('CREATE');
    expect(audit.classroom_id).toBe('class-1');
    expect(audit.resource_type).toBe('FORMS');
    // The WEB's name for this act, so one audit query catches both surfaces…
    expect(audit.data.tool).toBe('forms.new.create');
    // …and these two keys are what still distinguishes an agent from a browser.
    expect(audit.data.via).toBe('mcp');
    expect(audit.data.mcp_tool).toBe('form_create');
  });

  it('forwards a supplied field list to the contract untouched', async () => {
    mocks.formCreate.mockResolvedValue({ ...FORM_ROW, status: 'DRAFT' });
    const authored = [{ type: 'short_text', label: 'Your name', required: true }];

    await formCreateTool.handler({ ...ARGS, fields: authored } as never, CTX);
    expect((mocks.formCreate.mock.calls[0][0] as { fields: unknown }).fields).toBe(authored);
  });

  it('surfaces the contract’s precise validation message and code', async () => {
    mocks.formCreate.mockRejectedValue(
      Object.assign(
        new Error('Invalid form definition: fields.0.label: String must contain at least 1'),
        { code: 'FORM_DEFINITION_INVALID' }
      )
    );

    const error = await formCreateTool
      .handler({ ...ARGS, fields: [{ type: 'short_text' }] } as never, CTX)
      .catch(e => e);

    expect(error).toBeInstanceOf(ToolError);
    expect((error as ToolError).kind).toBe('invalid_params');
    expect((error as ToolError).code).toBe('FORM_DEFINITION_INVALID');
    expect((error as ToolError).message).toContain('fields.0.label');
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('surfaces a reserved/unavailable slug refusal as invalid_params', async () => {
    mocks.formCreate.mockRejectedValue(
      Object.assign(new Error('"edit" has no slug-usable characters'), {
        code: 'FORM_SLUG_RESERVED',
      })
    );
    const error = await formCreateTool.handler(ARGS as never, CTX).catch(e => e);
    expect((error as ToolError).kind).toBe('invalid_params');
    expect((error as ToolError).code).toBe('FORM_SLUG_RESERVED');
  });

  it('requires an explicit access mode', () => {
    const access = formCreateTool.inputSchema.access as z.ZodTypeAny;
    expect(access.safeParse(undefined).success).toBe(false);
    expect(access.safeParse('PUBLIC').success).toBe(true);
    expect(access.safeParse('CLASSROOM').success).toBe(true);
    expect(access.safeParse('SECRET').success).toBe(false);
  });
});

// ─── form_update ────────────────────────────────────────────────────────────

describe('form_update', () => {
  beforeEach(() => {
    mocks.formFindById.mockResolvedValue(FORM_ROW);
    mocks.formUpdate.mockResolvedValue(FORM_ROW);
  });

  it('requires at least one field and never calls the service empty-handed', async () => {
    const error = await formUpdateTool
      .handler({ classroom: 'org/w26', form_id: 'form-1' } as never, CTX)
      .catch(e => e);
    expect((error as ToolError).kind).toBe('invalid_params');
    expect(mocks.formFindById).not.toHaveBeenCalled();
    expect(mocks.formUpdate).not.toHaveBeenCalled();
  });

  it('maps arguments field-by-field and records what changed', async () => {
    await formUpdateTool.handler(
      {
        classroom: 'org/w26',
        form_id: 'form-1',
        title: 'CS52 Waitlist 26W',
        response_cap: 40,
        closes_at: '2026-09-30T00:00:00-04:00',
        allow_multiple: true,
      } as never,
      CTX
    );

    const [formId, updates] = mocks.formUpdate.mock.calls[0] as [string, Record<string, unknown>];
    expect(formId).toBe('form-1');
    expect(updates.title).toBe('CS52 Waitlist 26W');
    expect(updates.response_cap).toBe(40);
    expect(updates.closes_at).toBeInstanceOf(Date);
    expect(updates.allow_multiple).toBe(true);
    // Nothing the caller did not send.
    expect(Object.keys(updates).sort()).toEqual([
      'allow_multiple',
      'closes_at',
      'response_cap',
      'title',
    ]);

    const audit = mocks.auditCreate.mock.calls[0][0] as {
      data: { tool: string; mcp_tool: string; fields: string[] };
    };
    // A settings-only edit is the builder's save-meta act.
    expect(audit.data.tool).toBe('forms.builder.save-meta');
    expect(audit.data.mcp_tool).toBe('form_update');
    expect(audit.data.fields.sort()).toEqual([
      'allow_multiple',
      'closes_at',
      'response_cap',
      'title',
    ]);
  });

  it('clears closes_at on null', async () => {
    await formUpdateTool.handler(
      { classroom: 'org/w26', form_id: 'form-1', closes_at: null } as never,
      CTX
    );
    expect((mocks.formUpdate.mock.calls[0][1] as { closes_at: unknown }).closes_at).toBeNull();
  });

  it('audits a field-list edit as the builder’s save-fields act', async () => {
    await formUpdateTool.handler(
      { classroom: 'org/w26', form_id: 'form-1', fields: [], title: 'x' } as never,
      CTX
    );
    const audit = mocks.auditCreate.mock.calls[0][0] as { data: { tool: string } };
    expect(audit.data.tool).toBe('forms.builder.save-fields');
  });

  it('surfaces the DRAFT-only field-list rule from the service', async () => {
    mocks.formUpdate.mockRejectedValue(
      Object.assign(
        new Error(
          'The field list of a OPEN form cannot be edited — publish a new revision instead.'
        ),
        { code: 'FORM_NOT_DRAFT' }
      )
    );
    const error = await formUpdateTool
      .handler({ classroom: 'org/w26', form_id: 'form-1', fields: [] } as never, CTX)
      .catch(e => e);

    expect((error as ToolError).kind).toBe('invalid_params');
    expect((error as ToolError).code).toBe('FORM_NOT_DRAFT');
    expect((error as ToolError).message).toContain('publish a new revision');
  });

  it('surfaces the frozen-access rule from the service', async () => {
    mocks.formUpdate.mockRejectedValue(
      Object.assign(new Error('Access is frozen once a form has been published.'), {
        code: 'FORM_ACCESS_FROZEN',
      })
    );
    const error = await formUpdateTool
      .handler({ classroom: 'org/w26', form_id: 'form-1', access: 'CLASSROOM' } as never, CTX)
      .catch(e => e);
    expect((error as ToolError).code).toBe('FORM_ACCESS_FROZEN');
  });

  /**
   * THE ROSTER LEAK, from the agent's side of the wire.
   *
   * An instructor who legitimately owns a CLASSROOM form could once ask an
   * agent for three ordinary-looking calls and end up serving every student's
   * name, login, and user id to anonymous visitors:
   *
   *   form_publish { action: 'draft' }
   *   form_update  { access: 'PUBLIC', fields: [<nothing roster-shaped>] }
   *   form_publish { action: 'reopen' }
   *
   * The published revision — the one the fill page renders — still held the
   * materialized roster, and nothing re-checked it against the new access mode.
   * `form.service.update` now refuses the middle call outright (see
   * forms.builderLifecycle.test.ts, which drives the same three functions
   * against a real database and a real roster).
   *
   * What is asserted HERE is the MCP layer's own contribution to that refusal:
   * the tool must hand the access change to the service on the SAME call as the
   * field list — never split into a softer sequence, never applied itself — and
   * it must relay the refusal instead of reporting a success the caller would
   * believe. A tool that quietly dropped `access` from the update would leave
   * every service-level test green and the agent misinformed.
   */
  it('cannot walk a published form from CLASSROOM to PUBLIC in three calls', async () => {
    const CLASSROOM_FORM = {
      ...FORM_ROW,
      access: 'CLASSROOM',
      status: 'OPEN',
      current_revision_id: 'rev-1',
    };

    // ── 1. form_publish { action: 'draft' } ────────────────────────────────
    mocks.formFindById.mockResolvedValue(CLASSROOM_FORM);
    mocks.formQuickUpdate.mockResolvedValue({ ...CLASSROOM_FORM, status: 'DRAFT' });
    await formPublishTool.handler(
      { classroom: 'org/w26', form_id: 'form-1', action: 'draft' } as never,
      CTX
    );
    expect(mocks.formQuickUpdate).toHaveBeenCalledWith('form-1', { status: 'DRAFT' });
    // Taking a form back to DRAFT must not disturb the live revision — that is
    // exactly the property the leak exploited, so it is pinned rather than
    // assumed.
    expect(mocks.formQuickUpdate.mock.calls[0][1]).not.toHaveProperty('current_revision_id');

    // ── 2. form_update { access: 'PUBLIC', fields } ────────────────────────
    mocks.auditCreate.mockClear();
    mocks.formFindById.mockResolvedValue({ ...CLASSROOM_FORM, status: 'DRAFT' });
    mocks.formUpdate.mockRejectedValue(
      Object.assign(
        new Error(
          'Access is frozen once a form has been published — its live revision was built for ' +
            'the audience it had then.'
        ),
        { code: 'FORM_ACCESS_FROZEN' }
      )
    );

    const error = await formUpdateTool
      .handler(
        {
          classroom: 'org/w26',
          form_id: 'form-1',
          access: 'PUBLIC',
          fields: [{ type: 'short_text', label: 'Your name', required: true }],
        } as never,
        CTX
      )
      .catch(e => e);

    // One call, carrying both — the service decides, and it has everything it
    // needs to decide with.
    expect(mocks.formUpdate).toHaveBeenCalledTimes(1);
    const [updatedId, updates] = mocks.formUpdate.mock.calls[0] as [
      string,
      { access?: string; fields?: unknown },
    ];
    expect(updatedId).toBe('form-1');
    expect(updates.access).toBe('PUBLIC');
    expect(updates.fields).toBeDefined();

    expect((error as ToolError).kind).toBe('invalid_params');
    expect((error as ToolError).code).toBe('FORM_ACCESS_FROZEN');
    // A refused write is not an event: no audit row claims the form changed.
    expect(mocks.auditCreate).not.toHaveBeenCalled();

    // ── 3. form_publish { action: 'reopen' } ───────────────────────────────
    // Reopening is still allowed; it just reopens the CLASSROOM form it always
    // was, on the revision it always had.
    mocks.formReopen.mockResolvedValue(CLASSROOM_FORM);
    const payload = parse(
      await formPublishTool.handler(
        { classroom: 'org/w26', form_id: 'form-1', action: 'reopen' } as never,
        CTX
      )
    );
    expect(payload.form.access).toBe('CLASSROOM');
    expect(mocks.formPublish).not.toHaveBeenCalled();
  });

  it('does not swallow an unexpected failure as bad input', async () => {
    mocks.formUpdate.mockRejectedValue(new Error('connection reset'));
    const error = await formUpdateTool
      .handler({ classroom: 'org/w26', form_id: 'form-1', title: 'x' } as never, CTX)
      .catch(e => e);
    expect(error).not.toBeInstanceOf(ToolError);
    expect((error as Error).message).toBe('connection reset');
  });
});

// ─── form_publish ───────────────────────────────────────────────────────────

describe('form_publish', () => {
  beforeEach(() => {
    mocks.formFindById.mockResolvedValue({ ...FORM_ROW, status: 'DRAFT' });
  });

  it('publishes by default, reporting the new revision and its definition', async () => {
    mocks.formPublish.mockResolvedValue({
      form: { ...FORM_ROW, status: 'OPEN', current_revision_id: 'rev-2' },
      revision: { id: 'rev-2', version: 2, fields: DEFINITION },
    });

    const payload = parse(
      await formPublishTool.handler({ classroom: 'org/w26', form_id: 'form-1' } as never, CTX)
    );
    expect(mocks.formPublish).toHaveBeenCalledWith('form-1');
    expect(payload.form.status).toBe('OPEN');
    expect(payload.previous_status).toBe('DRAFT');
    expect(payload.revision).toEqual({ id: 'rev-2', version: 2 });
    // The published envelope is echoed as stored — not re-parsed.
    expect(payload.definition).toEqual(DEFINITION);

    const audit = mocks.auditCreate.mock.calls[0][0] as {
      data: { tool: string; form_action: string; version: number };
    };
    expect(audit.data).toMatchObject({
      tool: 'forms.builder.publish',
      mcp_tool: 'form_publish',
      form_action: 'publish',
      version: 2,
    });
  });

  it('routes close / reopen / draft to their own service functions', async () => {
    for (const [action, mock] of [
      ['close', mocks.formClose],
      ['reopen', mocks.formReopen],
      ['draft', mocks.formQuickUpdate],
    ] as const) {
      for (const m of Object.values(mocks)) m.mockClear();
      mocks.assertProTier.mockResolvedValue(undefined);
      mocks.auditCreate.mockResolvedValue(undefined);
      mocks.formFindById.mockResolvedValue({ ...FORM_ROW, status: 'OPEN' });
      mock.mockResolvedValue({ ...FORM_ROW, status: action === 'close' ? 'CLOSED' : 'OPEN' });

      await formPublishTool.handler(
        { classroom: 'org/w26', form_id: 'form-1', action } as never,
        CTX
      );

      expect(mock).toHaveBeenCalled();
      // A status move must never snapshot a revision.
      expect(mocks.formPublish).not.toHaveBeenCalled();
      const audit = mocks.auditCreate.mock.calls[0][0] as {
        data: { tool: string; form_action: string };
      };
      // A status move is the admin list's own act, under the web's name.
      expect(audit.data.tool).toBe('forms.list.update-status');
      expect(audit.data.form_action).toBe(action);
    }
    expect(mocks.formQuickUpdate).toHaveBeenCalledWith('form-1', { status: 'DRAFT' });
  });

  it('surfaces "publish this form before opening it" from reopen', async () => {
    mocks.formFindById.mockResolvedValue({ ...FORM_ROW, current_revision_id: null });
    mocks.formReopen.mockRejectedValue(
      Object.assign(new Error('Publish this form before opening it.'), { code: 'FORM_NO_FIELDS' })
    );
    const error = await formPublishTool
      .handler({ classroom: 'org/w26', form_id: 'form-1', action: 'reopen' } as never, CTX)
      .catch(e => e);
    expect((error as ToolError).code).toBe('FORM_NO_FIELDS');
    expect((error as ToolError).message).toBe('Publish this form before opening it.');
  });

  it('surfaces the PUBLIC-form roster-field refusal at publish', async () => {
    mocks.formPublish.mockRejectedValue(
      Object.assign(new Error('A PUBLIC form cannot use: roster_select'), {
        code: 'FORM_FIELD_ACCESS_VIOLATION',
      })
    );
    const error = await formPublishTool
      .handler({ classroom: 'org/w26', form_id: 'form-1' } as never, CTX)
      .catch(e => e);
    expect((error as ToolError).code).toBe('FORM_FIELD_ACCESS_VIOLATION');
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });
});

// ─── form_delete ────────────────────────────────────────────────────────────

describe('form_delete', () => {
  it('deletes and records the cascade blast radius, without echoing the rows', async () => {
    mocks.formFindById.mockResolvedValue(FORM_ROW);
    mocks.responseListByFormId.mockResolvedValue([RESPONSE_ROW, { ...RESPONSE_ROW, id: 'resp-2' }]);
    mocks.formDelete.mockResolvedValue(FORM_ROW);

    const payload = parse(
      await formDeleteTool.handler(
        { classroom: 'org/w26', form_id: 'form-1', confirm: true } as never,
        CTX
      )
    );

    expect(mocks.formDelete).toHaveBeenCalledWith('form-1');
    expect(payload.deleted_form_id).toBe('form-1');
    expect(payload.responses_deleted).toBe(2);
    // A count, never the applicants.
    expect(JSON.stringify(payload)).not.toContain('Maya.Chen@dartmouth.edu');

    const audit = mocks.auditCreate.mock.calls[0][0] as {
      action: string;
      data: { tool: string; mcp_tool: string; responses_deleted: number };
    };
    expect(audit.action).toBe('DELETE');
    expect(audit.data.tool).toBe('forms.list.delete');
    expect(audit.data.mcp_tool).toBe('form_delete');
    expect(audit.data.responses_deleted).toBe(2);
  });
});

// ─── Reads: definition + audit ──────────────────────────────────────────────

describe('form_get', () => {
  it('returns the stored envelopes verbatim plus the revision list', async () => {
    mocks.formFindById.mockResolvedValue(FORM_ROW);
    mocks.formGetCurrentRevision.mockResolvedValue({ id: 'rev-1', fields: DEFINITION });
    mocks.formListRevisions.mockResolvedValue([
      { id: 'rev-1', version: 1, created_at: new Date('2026-08-10T00:00:00.000Z') },
    ]);

    const payload = parse(
      await formGetTool.handler({ classroom: 'org/w26', form_id: 'form-1' } as never, CTX)
    );

    expect(payload.definition).toEqual(DEFINITION);
    expect(payload.draft_definition).toEqual(DEFINITION);
    expect(payload.revisions).toEqual([
      { id: 'rev-1', version: 1, created_at: '2026-08-10T00:00:00.000Z', is_current: true },
    ]);
    // A pure read: nothing recorded (only PII reads are audited).
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('reports a never-published form as having no definition', async () => {
    mocks.formFindById.mockResolvedValue({
      ...FORM_ROW,
      status: 'DRAFT',
      current_revision_id: null,
    });

    const payload = parse(
      await formGetTool.handler({ classroom: 'org/w26', form_id: 'form-1' } as never, CTX)
    );
    expect(payload.definition).toBeNull();
    expect(payload.form.published).toBe(false);
    // No pointless lookup for a revision that cannot exist.
    expect(mocks.formGetCurrentRevision).not.toHaveBeenCalled();
  });
});

describe('list_form_responses', () => {
  beforeEach(() => {
    mocks.formFindById.mockResolvedValue(FORM_ROW);
    mocks.responseListByFormId.mockResolvedValue([RESPONSE_ROW]);
    mocks.formGetCurrentRevision.mockResolvedValue({ id: 'rev-1', fields: DEFINITION });
    mocks.responseStatusLabels.mockResolvedValue([{ label: 'on roster', count: 3 }]);
  });

  it('ships the definition alongside the answers so field ids can be read', async () => {
    const payload = parse(
      await listFormResponsesTool.handler({ classroom: 'org/w26', form_id: 'form-1' } as never, CTX)
    );
    expect(payload.definition).toEqual(DEFINITION);
    expect(payload.responses[0].answers['f-name']).toBe('Maya Chen');
    expect(payload.staff_status_labels).toEqual([{ label: 'on roster', count: 3 }]);
  });

  it('passes filters through and defaults the page size', async () => {
    await listFormResponsesTool.handler(
      {
        classroom: 'org/w26',
        form_id: 'form-1',
        submission_state: 'SUBMITTED',
        staff_status: null,
        search: 'chen',
        offset: 10,
      } as never,
      CTX
    );
    expect(mocks.responseListByFormId).toHaveBeenCalledWith('form-1', {
      submissionState: 'SUBMITTED',
      staffStatus: null,
      search: 'chen',
      take: 50,
      skip: 10,
    });
  });

  it('audits the PII read as a VIEW against the form', async () => {
    await listFormResponsesTool.handler({ classroom: 'org/w26', form_id: 'form-1' } as never, CTX);
    const audit = mocks.auditCreate.mock.calls[0][0] as {
      action: string;
      resource_type: string;
      resource_id: string;
      classroom_id: string;
      role: string;
      data: { tool: string; via: string; mcp_tool: string; count: number };
    };
    expect(audit).toMatchObject({
      action: 'VIEW',
      resource_type: 'FORMS',
      resource_id: 'form-1',
      classroom_id: 'class-1',
      role: 'OWNER',
    });
    expect(audit.data.tool).toBe('forms.responses.view');
    expect(audit.data.via).toBe('mcp');
    expect(audit.data.mcp_tool).toBe('list_form_responses');
    expect(audit.data.count).toBe(1);
  });
});

describe('form_response_update', () => {
  beforeEach(() => {
    mocks.formFindById.mockResolvedValue(FORM_ROW);
    mocks.responseListByFormId.mockResolvedValue([RESPONSE_ROW]);
    mocks.responseUpdateStaff.mockResolvedValue({ ...RESPONSE_ROW, staff_status: 'on roster' });
  });

  it('writes only the two staff columns', async () => {
    await formResponseUpdateTool.handler(
      {
        classroom: 'org/w26',
        form_id: 'form-1',
        response_id: 'resp-1',
        staff_status: 'on roster',
      } as never,
      CTX
    );
    expect(mocks.responseUpdateStaff).toHaveBeenCalledWith({
      responseId: 'resp-1',
      staff_status: 'on roster',
    });
    // staff_note was not supplied, so it must not be sent (omitted ≠ cleared).
    expect(mocks.responseUpdateStaff.mock.calls[0][0]).not.toHaveProperty('staff_note');
  });

  it('forwards null to clear a column (the service does the trim-to-null)', async () => {
    await formResponseUpdateTool.handler(
      {
        classroom: 'org/w26',
        form_id: 'form-1',
        response_id: 'resp-1',
        staff_status: null,
        staff_note: '   ',
      } as never,
      CTX
    );
    expect(mocks.responseUpdateStaff).toHaveBeenCalledWith({
      responseId: 'resp-1',
      staff_status: null,
      staff_note: '   ',
    });
  });

  it('refuses a call that sets nothing', async () => {
    const error = await formResponseUpdateTool
      .handler({ classroom: 'org/w26', form_id: 'form-1', response_id: 'resp-1' } as never, CTX)
      .catch(e => e);
    expect((error as ToolError).kind).toBe('invalid_params');
    expect(mocks.formFindById).not.toHaveBeenCalled();
    expect(mocks.responseUpdateStaff).not.toHaveBeenCalled();
  });

  it('audits the triage edit', async () => {
    await formResponseUpdateTool.handler(
      {
        classroom: 'org/w26',
        form_id: 'form-1',
        response_id: 'resp-1',
        staff_status: 'on roster',
        staff_note: 'emailed 8/21',
      } as never,
      CTX
    );
    const audit = mocks.auditCreate.mock.calls[0][0] as {
      action: string;
      resource_id: string;
      data: { tool: string; mcp_tool: string; fields: string[] };
    };
    expect(audit.action).toBe('UPDATE');
    expect(audit.resource_id).toBe('resp-1');
    expect(audit.data.tool).toBe('forms.responses.staff_update');
    expect(audit.data.mcp_tool).toBe('form_response_update');
    expect(audit.data.fields).toEqual(['staff_status', 'staff_note']);
  });
});

// ─── Audit family ───────────────────────────────────────────────────────────

describe('audit naming', () => {
  /**
   * Every row these tools write joins the WEB's `forms.*` family, so one audit
   * query returns a form's whole history across both surfaces — and carries
   * `via: 'mcp'` + `mcp_tool`, so agent activity is still separable within it.
   */
  it('writes forms.* rows tagged as MCP, from every tool that audits', async () => {
    mocks.formFindById.mockResolvedValue(FORM_ROW);
    mocks.formCreate.mockResolvedValue(FORM_ROW);
    mocks.formUpdate.mockResolvedValue(FORM_ROW);
    mocks.formPublish.mockResolvedValue({
      form: FORM_ROW,
      revision: { id: 'rev-2', version: 2, fields: DEFINITION },
    });
    mocks.formClose.mockResolvedValue({ ...FORM_ROW, status: 'CLOSED' });
    mocks.formDelete.mockResolvedValue(FORM_ROW);
    mocks.responseListByFormId.mockResolvedValue([RESPONSE_ROW]);
    mocks.responseUpdateStaff.mockResolvedValue(RESPONSE_ROW);
    mocks.formGetCurrentRevision.mockResolvedValue({ id: 'rev-1', fields: DEFINITION });

    const base = { classroom: 'org/w26', form_id: 'form-1' };
    const calls: Array<[ToolDefinition<never>, Record<string, unknown>]> = [
      [formCreateTool as never, { ...base, title: 'T', access: 'PUBLIC' }],
      [formUpdateTool as never, { ...base, title: 'T2' }],
      [formPublishTool as never, base],
      [formPublishTool as never, { ...base, action: 'close' }],
      [formDeleteTool as never, { ...base, confirm: true }],
      [listFormResponsesTool as never, base],
      [formResponseGetTool as never, { ...base, response_id: 'resp-1' }],
      [formResponseUpdateTool as never, { ...base, response_id: 'resp-1', staff_status: 'ok' }],
    ];

    const seen: string[] = [];
    for (const [tool, args] of calls) {
      mocks.auditCreate.mockClear();
      await tool.handler(args as never, CTX);
      const row = mocks.auditCreate.mock.calls[0][0] as {
        resource_type: string;
        data: { tool: string; via: string; mcp_tool: string };
      };
      expect(row.resource_type).toBe('FORMS');
      expect(row.data.tool.startsWith('forms.')).toBe(true);
      expect(row.data.via).toBe('mcp');
      expect(row.data.mcp_tool).toBe(tool.name);
      seen.push(row.data.tool);
    }

    expect(seen).toEqual([
      'forms.new.create',
      'forms.builder.save-meta',
      'forms.builder.publish',
      'forms.list.update-status',
      'forms.list.delete',
      'forms.responses.view',
      'forms.responses.view',
      'forms.responses.staff_update',
    ]);
  });

  it('does NOT audit the two non-PII reads', async () => {
    mocks.formFindByClassroomId.mockResolvedValue([]);
    mocks.formFindById.mockResolvedValue(FORM_ROW);
    mocks.formGetCurrentRevision.mockResolvedValue({ id: 'rev-1', fields: DEFINITION });

    await listFormsTool.handler({ classroom: 'org/w26' } as never, CTX);
    await formGetTool.handler({ classroom: 'org/w26', form_id: 'form-1' } as never, CTX);
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });
});

// ─── Round trip ─────────────────────────────────────────────────────────────

/**
 * create → publish → (a response arrives) → list → get → triage.
 *
 * A STATEFUL mock of the service layer, not the real one: the integration
 * harness (tests/*.integration.test.ts) spawns a server against the repo-root
 * DATABASE_URL, which in this worktree is not the devport database this work is
 * scoped to, so a real `submitClassroom` round trip is out of scope here. What
 * this pins is the part that is this batch's own: that the ids, revisions and
 * definitions the nine tools hand each other actually line up end to end.
 */
describe('round trip: create → publish → respond → triage', () => {
  it('carries ids, revisions and definitions through the whole batch', async () => {
    const store: {
      form: Record<string, unknown>;
      revisions: Array<{ id: string; version: number; fields: unknown; created_at: Date }>;
      responses: Array<Record<string, unknown>>;
    } = { form: {}, revisions: [], responses: [] };

    // A stand-in for the contract: mints ids the way parseFormDefinition does.
    const normalize = (fields: unknown) => ({
      definition_version: 1,
      fields: (fields as Array<Record<string, unknown>>).map((field, index) => ({
        id: `minted-${index}`,
        ...field,
      })),
    });

    mocks.formCreate.mockImplementation(async (input: Record<string, unknown>) => {
      store.form = {
        id: 'form-rt',
        classroom_id: input.classroomId,
        title: input.title,
        slug: 'cs52-planning-mcp-test',
        access: input.access,
        status: 'DRAFT',
        current_revision_id: null,
        draft_fields: input.fields === undefined ? null : normalize(input.fields),
        created_at: new Date('2026-08-30T00:00:00.000Z'),
        updated_at: new Date('2026-08-30T00:00:00.000Z'),
      };
      return store.form;
    });
    mocks.formFindById.mockImplementation(async (id: string) =>
      store.form.id === id ? store.form : null
    );
    mocks.formUpdate.mockImplementation(async (_id: string, updates: Record<string, unknown>) => {
      if (updates.fields !== undefined) store.form.draft_fields = normalize(updates.fields);
      return store.form;
    });
    mocks.formPublish.mockImplementation(async () => {
      const revision = {
        id: `rev-${store.revisions.length + 1}`,
        version: store.revisions.length + 1,
        fields: store.form.draft_fields,
        created_at: new Date('2026-08-30T01:00:00.000Z'),
      };
      store.revisions.push(revision);
      store.form.current_revision_id = revision.id;
      store.form.status = 'OPEN';
      return { form: store.form, revision };
    });
    mocks.formGetCurrentRevision.mockImplementation(
      async () => store.revisions.find(r => r.id === store.form.current_revision_id) ?? null
    );
    mocks.formListRevisions.mockImplementation(async () => store.revisions);
    mocks.formQuickUpdate.mockImplementation(async (_id: string, updates: { status?: string }) => {
      if (updates.status) store.form.status = updates.status;
      return store.form;
    });
    mocks.responseListByFormId.mockImplementation(async () => store.responses);
    mocks.responseUpdateStaff.mockImplementation(
      async ({ responseId, ...patch }: Record<string, unknown>) => {
        const row = store.responses.find(r => r.id === responseId)!;
        Object.assign(row, patch);
        return row;
      }
    );

    // 1. create, with a starting field list
    const created = parse(
      await formCreateTool.handler(
        {
          classroom: 'org/w26',
          title: 'CS52 26W Planning',
          access: 'CLASSROOM',
          fields: [{ type: 'short_text', label: 'Your name', required: true }],
        } as never,
        CTX
      )
    );
    const formId = created.form.id as string;
    expect(created.form.status).toBe('DRAFT');
    expect(created.draft_definition.fields[0].id).toBe('minted-0');

    // 2. publish → revision 1, form OPEN
    const published = parse(
      await formPublishTool.handler({ classroom: 'org/w26', form_id: formId } as never, CTX)
    );
    expect(published.revision.version).toBe(1);
    expect(published.form.status).toBe('OPEN');
    const revisionId = published.revision.id as string;

    // 3. a response arrives against that revision — what `submitClassroom`
    //    writes: SUBMITTED, verified, answers keyed on the minted field ids.
    store.responses.push({
      id: 'resp-rt',
      form_id: formId,
      name: 'Maya Chen',
      email: 'maya@dartmouth.edu',
      email_normalized: 'maya@dartmouth.edu',
      user_id: 'user-9',
      submitted_at: new Date('2026-08-30T02:00:00.000Z'),
      verified_at: new Date('2026-08-30T02:00:00.000Z'),
      updated_at: new Date('2026-08-30T02:00:00.000Z'),
      submission_state: 'SUBMITTED',
      staff_status: null,
      staff_note: null,
      revision_id: revisionId,
      answers: { 'minted-0': 'Maya Chen' },
      resolved_context: null,
      draft_token: null,
    });

    // 4. list — the answer keys match the published definition's field ids
    const listed = parse(
      await listFormResponsesTool.handler({ classroom: 'org/w26', form_id: formId } as never, CTX)
    );
    expect(listed.responses).toHaveLength(1);
    expect(listed.responses[0].revision_id).toBe(revisionId);
    const fieldId = listed.definition.fields[0].id as string;
    expect(Object.keys(listed.responses[0].answers)).toEqual([fieldId]);

    // 5. get one
    const got = parse(
      await formResponseGetTool.handler(
        { classroom: 'org/w26', form_id: formId, response_id: 'resp-rt' } as never,
        CTX
      )
    );
    expect(got.response.answers[fieldId]).toBe('Maya Chen');

    // 6. triage it, and see the label on the next read
    await formResponseUpdateTool.handler(
      {
        classroom: 'org/w26',
        form_id: formId,
        response_id: 'resp-rt',
        staff_status: 'on roster',
      } as never,
      CTX
    );
    const reread = parse(
      await formResponseGetTool.handler(
        { classroom: 'org/w26', form_id: formId, response_id: 'resp-rt' } as never,
        CTX
      )
    );
    expect(reread.response.staff_status).toBe('on roster');

    // 7. the new-version flow the builder uses: draft → update → publish again
    await formPublishTool.handler(
      { classroom: 'org/w26', form_id: formId, action: 'draft' } as never,
      CTX
    );
    expect(store.form.status).toBe('DRAFT');
    await formUpdateTool.handler(
      {
        classroom: 'org/w26',
        form_id: formId,
        fields: [
          { type: 'short_text', label: 'Your name', required: true },
          { type: 'long_text', label: 'What do you hope to get out of the class?' },
        ],
      } as never,
      CTX
    );
    const republished = parse(
      await formPublishTool.handler({ classroom: 'org/w26', form_id: formId } as never, CTX)
    );
    expect(republished.revision.version).toBe(2);
    // The earlier response still points at revision 1 — editing never rewrites
    // what somebody already answered.
    expect(store.responses[0].revision_id).toBe(revisionId);
    expect(republished.revision.id).not.toBe(revisionId);
  });
});
