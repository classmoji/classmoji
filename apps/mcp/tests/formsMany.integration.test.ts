/**
 * The forms tools on a form that takes several responses per person
 * (responses_per_person MANY), against a REAL Postgres: the real form and
 * response services, the real partial unique indexes, the real refusals.
 *
 * The other suites in this directory spawn a server against a seeded database.
 * This one calls the tool handlers in process, so it needs no seed: it makes
 * its own git organization, classroom, users and forms, namespaced by a fresh
 * id, and deletes the organization afterwards (classroom → forms → revisions →
 * responses → team sets cascade), then its users. Only the Pro gate (a billing
 * read) and the audit write are stubbed, so no audit row outlives the suite.
 *
 * Skipped unless DATABASE_URL names a LOCAL database other than the shared
 * dev database `classmoji` (the same guard as the services' forms suite). It
 * deliberately does not import ./helpers.ts, which falls back to the repo's
 * .env URL. Run it with the URL of a database of its own:
 *
 *   DATABASE_URL=… ../../node_modules/.bin/vitest run \
 *     --config vitest.integration.config.ts tests/formsMany.integration.test.ts
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../src/mcp/registry.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
const isSharedDevDb = /\/classmoji(\?|$)/.test(DATABASE_URL);
const RUN = Boolean(DATABASE_URL) && isLocal && !isSharedDevDb;

vi.mock('@classmoji/auth/server', () => ({ assertProTier: async () => undefined }));

const audits = vi.hoisted(() => ({ create: vi.fn(async (_row: unknown) => undefined) }));
vi.mock('@classmoji/services', async importOriginal => {
  const actual = await importOriginal<typeof import('@classmoji/services')>();
  return {
    ...actual,
    ClassmojiService: { ...actual.ClassmojiService, audit: { create: audits.create } },
  };
});

type Payload = Record<string, any>;
const parse = (result: { content: Array<{ text: string }> }): Payload =>
  JSON.parse(result.content[0].text);

/** The error a rejected handler call throws, or a failure if it resolved. */
async function refusalOf(call: Promise<unknown>): Promise<{
  kind: string;
  code?: string;
  message: string;
}> {
  try {
    await call;
  } catch (error) {
    return error as { kind: string; code?: string; message: string };
  }
  throw new Error('expected the call to be refused');
}

describe.skipIf(!RUN)('forms tools on a MANY form (real database)', () => {
  const suite = randomUUID().slice(0, 8);
  let prisma: ReturnType<(typeof import('@classmoji/database'))['default']>;
  let tools: typeof import('../src/tools/forms.ts');
  let teamTools: typeof import('../src/tools/formTeams.ts');
  let responses: (typeof import('@classmoji/services'))['ClassmojiService']['formResponse'];

  let orgId = '';
  let ownerId = '';
  let studentAId = '';
  let studentBId = '';
  let ctx: ToolContext;
  let otherCtx: ToolContext;

  const emailOf = (label: string) => `formsmany-${suite}-${label}@example.test`;

  const makeUser = async (label: string) =>
    (
      await prisma.user.create({
        data: {
          accounts: {
            create: {
              provider_id: 'github',
              account_id: `formsmany-${suite}-${label}`,
              username: `formsmany-${suite}-${label}`,
            },
          },
          email: emailOf(label),
          name: `Forms Many ${label}`,
        },
      })
    ).id;

  const contextFor = (classroomId: string, slug: string): ToolContext =>
    ({
      viewer: { userId: ownerId, clientId: 'formsmany-test', scopes: new Set(['read', 'write']) },
      classroom: {
        classroomId,
        role: 'OWNER',
        status: 'ACTIVE',
        membership: { id: `m-${slug}`, role: 'OWNER' },
        classroom: { slug, settings: {} },
      },
    }) as unknown as ToolContext;

  /** A CLASSROOM form made and published through the tools, with one short-text field. */
  const openForm = async (responsesPerPerson: 'ONE' | 'REPLACE' | 'MANY', on = ctx) => {
    const created = parse(
      await tools.formCreateTool.handler(
        {
          classroom: 'org/slug',
          title: `Check-in ${suite} ${randomUUID().slice(0, 6)}`,
          access: 'CLASSROOM',
          responses_per_person: responsesPerPersonOrUndefined(responsesPerPerson),
          fields: [{ type: 'short_text', label: 'How is it going?', required: true }],
        },
        on
      )
    );
    const published = parse(
      await tools.formPublishTool.handler({ classroom: 'org/slug', form_id: created.form.id }, on)
    );
    const fieldId = (published.definition as { fields: Array<{ id: string }> }).fields[0].id;
    return {
      formId: created.form.id as string,
      revisionId: published.revision.id as string,
      fieldId,
    };
  };
  // ONE is the default: leave it out, so the default is what is exercised.
  const responsesPerPersonOrUndefined = (value: 'ONE' | 'REPLACE' | 'MANY') =>
    value === 'ONE' ? undefined : value;

  const submit = (
    form: { formId: string; revisionId: string; fieldId: string },
    userId: string,
    label: string,
    answer: string
  ) =>
    responses.submitClassroom({
      formId: form.formId,
      revisionId: form.revisionId,
      userId,
      email: emailOf(label),
      answers: { [form.fieldId]: answer },
    });

  beforeAll(async () => {
    prisma = (await import('@classmoji/database')).default();
    tools = await import('../src/tools/forms.ts');
    teamTools = await import('../src/tools/formTeams.ts');
    responses = (await import('@classmoji/services')).ClassmojiService.formResponse;

    const org = await prisma.gitOrganization.create({
      data: {
        provider: 'GITHUB',
        provider_id: `formsmany-${suite}`,
        login: `formsmany-org-${suite}`,
      },
    });
    orgId = org.id;
    const classroom = (slug: string) =>
      prisma.classroom.create({
        data: {
          slug,
          git_org_id: orgId,
          name: `Forms Many ${slug}`,
          content_namespace: slug,
          content_repo: `content-${slug}`,
        },
      });
    const x = await classroom(`formsmany-${suite}-x`);
    const y = await classroom(`formsmany-${suite}-y`);

    ownerId = await makeUser('owner');
    studentAId = await makeUser('a');
    studentBId = await makeUser('b');
    ctx = contextFor(x.id, x.slug);
    otherCtx = contextFor(y.id, y.slug);
  }, 60_000);

  afterAll(async () => {
    if (!prisma) return;
    if (orgId) await prisma.gitOrganization.delete({ where: { id: orgId } }).catch(() => {});
    await prisma.user
      .deleteMany({
        where: {
          accounts: {
            some: { provider_id: 'github', username: { startsWith: `formsmany-${suite}-` } },
          },
        },
      })
      .catch(() => {});
  });

  it('form_create stores MANY on a CLASSROOM form and refuses it on a PUBLIC one', async () => {
    const { formId } = await openForm('MANY');
    const stored = await prisma.form.findUniqueOrThrow({ where: { id: formId } });
    expect(stored.responses_per_person).toBe('MANY');

    const got = parse(
      await tools.formGetTool.handler({ classroom: 'org/slug', form_id: formId }, ctx)
    );
    expect(got.form.responses_per_person).toBe('MANY');
    expect(got.form).not.toHaveProperty('allow_multiple');

    const error = await refusalOf(
      tools.formCreateTool.handler(
        {
          classroom: 'org/slug',
          title: `Public ${suite}`,
          access: 'PUBLIC',
          responses_per_person: 'MANY',
        },
        ctx
      )
    );
    expect(error).toMatchObject({
      kind: 'invalid_params',
      code: 'FORM_MANY_NEEDS_CLASSROOM',
      message:
        'Several responses per person need a classroom form: a public form keeps one response per email address.',
    });
  });

  it('lists every response of a MANY form, one row each, attributed to its filler', async () => {
    const form = await openForm('MANY');
    const a1 = await submit(form, studentAId, 'a', 'Week 1');
    const b1 = await submit(form, studentBId, 'b', 'Fine');
    const a2 = await submit(form, studentAId, 'a', 'Week 2');
    expect(new Set([a1.id, b1.id, a2.id]).size).toBe(3);

    const listed = parse(
      await tools.listFormResponsesTool.handler(
        { classroom: 'org/slug', form_id: form.formId },
        ctx
      )
    );
    expect(listed.form.responses_per_person).toBe('MANY');
    expect(listed.returned).toBe(3);
    // Oldest first, the service's order, with nothing grouped by person.
    expect(
      listed.responses.map((row: Payload) => [
        row.id,
        row.user_id,
        row.email,
        row.answers[form.fieldId],
      ])
    ).toEqual([
      [a1.id, studentAId, emailOf('a'), 'Week 1'],
      [b1.id, studentBId, emailOf('b'), 'Fine'],
      [a2.id, studentAId, emailOf('a'), 'Week 2'],
    ]);

    // Paging walks the same rows without repeating one.
    const pages = [];
    for (const offset of [0, 1, 2]) {
      const page = parse(
        await tools.listFormResponsesTool.handler(
          { classroom: 'org/slug', form_id: form.formId, limit: 1, offset },
          ctx
        )
      );
      pages.push(page.responses[0].id);
    }
    expect(pages).toEqual([a1.id, b1.id, a2.id]);

    // One response by id, not the person's other one.
    const one = parse(
      await tools.formResponseGetTool.handler(
        { classroom: 'org/slug', form_id: form.formId, response_id: a2.id },
        ctx
      )
    );
    expect(one.response.id).toBe(a2.id);
    expect(one.response.answers[form.fieldId]).toBe('Week 2');

    // A staff label lands on exactly the row named.
    await tools.formResponseUpdateTool.handler(
      { classroom: 'org/slug', form_id: form.formId, response_id: a1.id, staff_status: 'read' },
      ctx
    );
    const labels = await prisma.formResponse.findMany({
      where: { form_id: form.formId },
      select: { id: true, staff_status: true },
    });
    expect(Object.fromEntries(labels.map(row => [row.id, row.staff_status]))).toEqual({
      [a1.id]: 'read',
      [b1.id]: null,
      [a2.id]: null,
    });
  });

  it('refuses another classroom’s MANY form exactly like an unknown one', async () => {
    const elsewhere = await openForm('MANY', otherCtx);
    await submit(elsewhere, studentAId, 'a', 'Elsewhere');

    for (const call of [
      tools.listFormResponsesTool.handler(
        { classroom: 'org/slug', form_id: elsewhere.formId },
        ctx
      ),
      tools.formUpdateTool.handler(
        { classroom: 'org/slug', form_id: elsewhere.formId, responses_per_person: 'ONE' },
        ctx
      ),
    ]) {
      expect(await refusalOf(call)).toMatchObject({
        kind: 'not_found',
        message: 'Form not found in this classroom',
      });
    }
    const stored = await prisma.form.findUniqueOrThrow({ where: { id: elsewhere.formId } });
    expect(stored.responses_per_person).toBe('MANY');
  });

  it('form_update refuses to leave MANY once a response exists, and moves ONE ↔ REPLACE freely', async () => {
    const many = await openForm('MANY');
    await submit(many, studentAId, 'a', 'First');
    const locked = await refusalOf(
      tools.formUpdateTool.handler(
        { classroom: 'org/slug', form_id: many.formId, responses_per_person: 'REPLACE' },
        ctx
      )
    );
    expect(locked).toMatchObject({
      kind: 'invalid_params',
      code: 'FORM_RESPONSES_MODE_LOCKED',
      message:
        'This form already has a response (drafts included), so it cannot switch to or from several responses per person.',
    });

    const one = await openForm('ONE');
    await submit(one, studentAId, 'a', 'Only');
    const replaced = parse(
      await tools.formUpdateTool.handler(
        { classroom: 'org/slug', form_id: one.formId, responses_per_person: 'REPLACE' },
        ctx
      )
    );
    expect(replaced.form.responses_per_person).toBe('REPLACE');
    const audit = audits.create.mock.calls.at(-1)?.[0] as { data: { fields: string[] } };
    expect(audit.data.fields).toEqual(['responses_per_person']);
  });

  it('form_update refuses MANY on a form with a team set', async () => {
    const form = await openForm('ONE');
    await prisma.teamSet.create({
      data: {
        classroom_id: (ctx.classroom as { classroomId: string }).classroomId,
        form_id: form.formId,
        name: `set-${suite}`,
        config: {},
        created_by: ownerId,
      },
    });
    const error = await refusalOf(
      tools.formUpdateTool.handler(
        { classroom: 'org/slug', form_id: form.formId, responses_per_person: 'MANY' },
        ctx
      )
    );
    expect(error).toMatchObject({
      kind: 'invalid_params',
      code: 'FORM_MANY_HAS_TEAM_SETS',
      message:
        'This form has team sets, which read one response per person, so it cannot take several.',
    });
  });

  it('the team-set tools refuse a MANY form with one clear message', async () => {
    const form = await openForm('MANY');
    for (const call of [
      teamTools.formTeamsGetTool.handler({ classroom: 'org/slug', form_id: form.formId }, ctx),
      teamTools.formTeamsGetTool.handler(
        { classroom: 'org/slug', form_id: form.formId, team_set: 'pairs' },
        ctx
      ),
      teamTools.formTeamsRunTool.handler({ classroom: 'org/slug', form_id: form.formId }, ctx),
      teamTools.formTeamsCreateTool.handler(
        { classroom: 'org/slug', form_id: form.formId, run: 1 },
        ctx
      ),
    ]) {
      expect(await refusalOf(call)).toMatchObject({
        kind: 'invalid_params',
        code: 'form_many_responses',
        message:
          'Team sets need one response per person, and this form takes several (responses_per_person MANY). Use a form whose responses_per_person is ONE or REPLACE',
      });
    }
    expect(await prisma.teamSet.count({ where: { form_id: form.formId } })).toBe(0);
  });
});
