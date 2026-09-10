/**
 * `formResponse.createResponses` against a REAL Postgres.
 *
 * The interesting parts of this function are all things a fake Prisma would
 * agree with whatever it was told: the form row lock, the partial unique index
 * on (form_id, email_normalized), batch cap arithmetic against a live count,
 * and an audit row that must land inside the same transaction as two hundred
 * responses or not at all. So it runs against the devport database.
 *
 * SAFETY: every fixture is namespaced with a fresh uuid and torn down in
 * afterAll by deleting the git organization (which cascades classroom → forms →
 * revisions → responses → tokens, and audit logs with the classroom). Nothing
 * is truncated and no pre-existing row is touched.
 *
 * Skipped unless DATABASE_URL names a LOCAL, non-shared database — the same
 * guard forms.integration.test.ts uses, for the same reason.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';

import getPrisma from '@classmoji/database';
import * as formService from '../form.service.ts';
import * as responseService from '../formResponse.service.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
/** A devport database (`classmoji_<feature>`) is fine; the shared dev one is not. */
const isSharedDevDb = /\/classmoji(\?|$)/.test(DATABASE_URL);
const RUN = Boolean(DATABASE_URL) && isLocal && !isSharedDevDb;

/** The error `code` a rejected promise carries, or undefined. */
const codeOf = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

const tokenOf = ({ rawToken }: { rawToken: string | null }): string => {
  if (!rawToken) throw new Error('expected a freshly minted link, got a reused one');
  return rawToken;
};

const NAME_FIELD = { type: 'short_text', label: 'Full Name', required: true } as const;
const NOTE_FIELD = { type: 'long_text', label: 'Anything else?' } as const;

describe.skipIf(!RUN)('formResponse.createResponses (integration)', () => {
  const suite = randomUUID().slice(0, 8);
  let classroomId: string;
  let orgId: string;
  let ownerId: string;

  const prisma = getPrisma();

  /** An address nobody else in the suite will collide with. */
  const addr = (label: string) => `create-${suite}-${label}@example.test`;

  /**
   * The audit descriptor every call now carries — `audit` is a REQUIRED
   * parameter, so there is no such thing as an unaudited batch to test.
   */
  const descriptor = () => ({
    user_id: ownerId,
    classroom_id: classroomId,
    role: 'OWNER' as const,
    data: { tool: 'form_response_create' },
  });

  const makeForm = async ({
    access = 'PUBLIC' as const,
    fields = [NAME_FIELD, NOTE_FIELD] as unknown,
    ...rest
  }: {
    access?: 'PUBLIC' | 'CLASSROOM';
    fields?: unknown;
    response_cap?: number | null;
    allow_multiple?: boolean;
    closes_at?: Date | null;
    save_partials?: boolean;
  } = {}) => {
    const form = await formService.create({
      classroomId,
      title: `Create ${suite} ${randomUUID().slice(0, 8)}`,
      access,
      createdBy: ownerId,
      fields,
    });
    if (Object.keys(rest).length > 0) await formService.update(form.id, rest);
    return form;
  };

  /** A published form, the revision its fill page renders, and its field ids. */
  const makeOpenForm = async (options: Parameters<typeof makeForm>[0] = {}) => {
    const form = await makeForm(options);
    const { revision } = await formService.publish(form.id);
    const fields = formService.fieldsOf(revision.fields);
    return { formId: form.id, revisionId: revision.id, nameId: fields[0].id };
  };

  /** The answer set a valid row carries. */
  const answersFor = (nameId: string, name: string) => ({ [nameId]: name });

  /** Every response row on a form, oldest first. */
  const rowsOf = (formId: string) =>
    prisma.formResponse.findMany({ where: { form_id: formId }, orderBy: { submitted_at: 'asc' } });

  /** Put a real, verified, respondent-submitted response on a form. */
  const publicSubmit = async (formId: string, revisionId: string, email: string, name: string) => {
    const begun = await responseService.beginPublicSubmission({
      formId,
      revisionId,
      email,
      name,
      answers: answersFor(await nameFieldOf(revisionId), name),
    });
    await responseService.confirmSubmission(tokenOf(begun));
    return begun.responseId;
  };

  /** Leave an unverified PENDING_VERIFICATION row behind, and nothing else. */
  const publicBegin = async (formId: string, revisionId: string, email: string, name: string) => {
    const begun = await responseService.beginPublicSubmission({
      formId,
      revisionId,
      email,
      name,
      answers: answersFor(await nameFieldOf(revisionId), name),
    });
    return begun.responseId;
  };

  const nameFieldOf = async (revisionId: string) => {
    const revision = await prisma.formRevision.findUniqueOrThrow({ where: { id: revisionId } });
    return formService.fieldsOf(revision.fields)[0].id;
  };

  beforeAll(async () => {
    const org = await prisma.gitOrganization.create({
      data: {
        provider: 'GITHUB',
        provider_id: `createtest-${suite}`,
        login: `createtest-org-${suite}`,
      },
    });
    orgId = org.id;

    const classroom = await prisma.classroom.create({
      data: {
        slug: `createtest-${suite}`,
        git_org_id: orgId,
        name: `Create Test ${suite}`,
        content_namespace: `createtest-${suite}`,
        content_repo: `content-createtest-${suite}`,
      },
    });
    classroomId = classroom.id;

    const owner = await prisma.user.create({
      data: {
        login: `createtest-${suite}-owner`,
        email: `createtest-${suite}-owner@example.test`,
        name: `Create Test owner`,
      },
    });
    ownerId = owner.id;
  });

  afterAll(async () => {
    if (orgId) await prisma.gitOrganization.delete({ where: { id: orgId } }).catch(() => {});
    await prisma.user
      .deleteMany({ where: { login: { startsWith: `createtest-${suite}-` } } })
      .catch(() => {});
  });

  // ── The happy path ───────────────────────────────────────────────────────

  it('writes verified SUBMITTED rows, attributed, with no magic token anywhere', async () => {
    const { formId, revisionId, nameId } = await makeOpenForm();
    const when = [
      new Date('2026-03-01T10:00:00.000Z'),
      new Date('2026-03-02T10:00:00.000Z'),
      new Date('2026-03-03T10:00:00.000Z'),
    ];

    const before = new Date();
    const report = await responseService.createResponses({
      formId,
      revisionId,
      addedBy: ownerId,
      audit: descriptor(),
      responses: ['a', 'b', 'c'].map((label, index) => ({
        email: addr(`happy-${label}`),
        name: `Person ${label}`,
        answers: answersFor(nameId, `Person ${label}`),
        submittedAt: when[index],
      })),
    });

    expect(report.outcome).toBe('committed');
    expect(report.revision_id).toBe(revisionId);
    expect(report.counts).toEqual({ would_create: 0, created: 3, duplicate: 0, invalid: 0 });
    expect(report.rows.map(row => row.disposition)).toEqual(['created', 'created', 'created']);

    const rows = await rowsOf(formId);
    expect(rows).toHaveLength(3);
    for (const [index, row] of rows.entries()) {
      expect(row.submission_state).toBe('SUBMITTED');
      expect(row.verified_at).not.toBeNull();
      // NEVER backdated, whatever submitted_at says.
      expect(row.verified_at?.getTime() ?? 0).toBeGreaterThanOrEqual(before.getTime());
      expect(row.submitted_at.toISOString()).toBe(when[index].toISOString());
      expect(row.added_by).toBe(ownerId);
      expect(row.user_id).toBeNull();
      expect(row.draft_token).toBeNull();
      expect(row.resolved_context).toBeNull();
      expect(row.revision_id).toBe(revisionId);
    }

    // The whole reason this is not a mode of beginPublicSubmission.
    const tokens = await prisma.formMagicToken.count({
      where: { response_id: { in: rows.map(row => row.id) } },
    });
    expect(tokens).toBe(0);
  });

  it('names every id it created, and each one is really there', async () => {
    const { formId, revisionId, nameId } = await makeOpenForm();
    const report = await responseService.createResponses({
      formId,
      revisionId,
      addedBy: ownerId,
      audit: descriptor(),
      responses: [
        { email: addr('ids-a'), answers: answersFor(nameId, 'A') },
        { email: addr('ids-b'), answers: answersFor(nameId, 'B') },
      ],
    });

    const ids = report.rows.map(row => row.response_id);
    expect(ids.every(Boolean)).toBe(true);
    const found = await prisma.formResponse.findMany({
      where: { id: { in: ids as string[] } },
      select: { id: true, email: true },
    });
    expect(found).toHaveLength(2);
    expect(new Set(found.map(row => row.id))).toEqual(new Set(ids));
  });

  it('defaults submitted_at to now when the caller supplies none', async () => {
    const { formId, revisionId, nameId } = await makeOpenForm();
    const before = new Date();
    await responseService.createResponses({
      formId,
      revisionId,
      addedBy: ownerId,
      audit: descriptor(),
      responses: [{ email: addr('nodate'), answers: answersFor(nameId, 'No Date') }],
    });
    const [row] = await rowsOf(formId);
    expect(row.submitted_at.getTime()).toBeGreaterThanOrEqual(before.getTime());
  });

  // ── Duplicates ───────────────────────────────────────────────────────────

  it('reports an existing SUBMITTED row as a duplicate and leaves its answers alone', async () => {
    const { formId, revisionId, nameId } = await makeOpenForm();
    const email = addr('dup-submitted');
    const existingId = await publicSubmit(formId, revisionId, email, 'Original Answer');
    const before = await prisma.formResponse.findUniqueOrThrow({ where: { id: existingId } });

    const report = await responseService.createResponses({
      formId,
      revisionId,
      addedBy: ownerId,
      audit: descriptor(),
      responses: [
        { email: email.toUpperCase(), answers: answersFor(nameId, 'Staff Overwrite Attempt') },
        { email: addr('dup-submitted-other'), answers: answersFor(nameId, 'Fresh') },
      ],
    });

    expect(report.outcome).toBe('committed');
    expect(report.counts).toEqual({ would_create: 0, created: 1, duplicate: 1, invalid: 0 });
    expect(report.rows[0]).toMatchObject({
      input_index: 0,
      disposition: 'duplicate',
      response_id: existingId,
      existing_state: 'SUBMITTED',
    });
    expect(report.rows[1].disposition).toBe('created');

    const after = await prisma.formResponse.findUniqueOrThrow({ where: { id: existingId } });
    expect(after.answers).toEqual(before.answers);
    expect(after.name).toBe(before.name);
    expect(after.added_by).toBeNull();
    expect(await rowsOf(formId)).toHaveLength(2);
  });

  it('reports a PENDING_VERIFICATION row as one, and does not promote it', async () => {
    const { formId, revisionId, nameId } = await makeOpenForm();
    const email = addr('dup-pending');
    const existingId = await publicBegin(formId, revisionId, email, 'Half Way');

    const report = await responseService.createResponses({
      formId,
      revisionId,
      addedBy: ownerId,
      audit: descriptor(),
      responses: [{ email, answers: answersFor(nameId, 'Staff Version') }],
    });

    expect(report.counts).toEqual({ would_create: 0, created: 0, duplicate: 1, invalid: 0 });
    expect(report.rows[0]).toMatchObject({
      disposition: 'duplicate',
      response_id: existingId,
      existing_state: 'PENDING_VERIFICATION',
    });

    const after = await prisma.formResponse.findUniqueOrThrow({ where: { id: existingId } });
    expect(after.submission_state).toBe('PENDING_VERIFICATION');
    expect(after.name).toBe('Half Way');
    expect(after.added_by).toBeNull();
  });

  it('reports an anonymous DRAFT row as a duplicate and leaves it a draft', async () => {
    const { formId, revisionId, nameId } = await makeOpenForm({ save_partials: true });
    const email = addr('dup-draft');
    const draft = await responseService.upsertDraft({
      formId,
      revisionId,
      draftToken: randomUUID(),
      email,
      name: 'Half Typed',
      answers: answersFor(nameId, 'Half Typed'),
    });
    expect(draft.submission_state).toBe('DRAFT');

    const report = await responseService.createResponses({
      formId,
      revisionId,
      addedBy: ownerId,
      audit: descriptor(),
      responses: [{ email: email.toUpperCase(), answers: answersFor(nameId, 'Staff Version') }],
    });

    expect(report.counts).toEqual({ would_create: 0, created: 0, duplicate: 1, invalid: 0 });
    expect(report.rows[0]).toMatchObject({
      disposition: 'duplicate',
      response_id: draft.id,
      existing_state: 'DRAFT',
    });

    // A DRAFT is somebody's half-finished typing, not a submission — and it is
    // certainly not staff's to overwrite on the way past.
    const after = await prisma.formResponse.findUniqueOrThrow({ where: { id: draft.id } });
    expect(after.submission_state).toBe('DRAFT');
    expect(after.name).toBe('Half Typed');
    expect(after.answers).toEqual(answersFor(nameId, 'Half Typed'));
    expect(after.added_by).toBeNull();
    expect(after.draft_token).not.toBeNull();
    expect(await rowsOf(formId)).toHaveLength(1);
  });

  it('marks BOTH rows invalid when one call carries the same address twice', async () => {
    const { formId, revisionId, nameId } = await makeOpenForm();
    const email = addr('twice');

    const report = await responseService.createResponses({
      formId,
      revisionId,
      addedBy: ownerId,
      audit: descriptor(),
      responses: [
        { email, answers: answersFor(nameId, 'First') },
        { email: ` ${email.toUpperCase()} `, answers: answersFor(nameId, 'Second') },
        { email: addr('twice-other'), answers: answersFor(nameId, 'Other') },
      ],
    });

    // The caller's own list disagrees with itself — a data error like any
    // other, so the whole batch is rejected and NOTHING is written, not even
    // the third row that was fine.
    expect(report.outcome).toBe('rejected');
    expect(report.counts).toEqual({ would_create: 1, created: 0, duplicate: 0, invalid: 2 });
    expect(report.rows[0].disposition).toBe('invalid');
    expect(report.rows[1].disposition).toBe('invalid');
    expect(report.rows[0].issues?.[0]).toMatchObject({
      code: 'duplicate_in_input',
      path: 'email',
    });
    expect(report.rows[1].issues?.[0]?.code).toBe('duplicate_in_input');
    // No first-wins rule: neither is written, and neither claims a row id.
    expect(report.rows[0].response_id).toBeUndefined();
    expect(report.rows[0].existing_state).toBeUndefined();

    expect(await rowsOf(formId)).toHaveLength(0);
  });

  // ── All or nothing ───────────────────────────────────────────────────────

  it('rejects the whole batch for one invalid row, and writes nothing', async () => {
    const { formId, revisionId, nameId } = await makeOpenForm();

    const report = await responseService.createResponses({
      formId,
      revisionId,
      addedBy: ownerId,
      audit: descriptor(),
      responses: [
        { email: addr('reject-a'), answers: answersFor(nameId, 'Fine') },
        // The required field has no answer — the fill page's own rule.
        { email: addr('reject-b'), answers: {} },
        { email: addr('reject-c'), answers: answersFor(nameId, 'Also fine') },
      ],
    });

    expect(report.outcome).toBe('rejected');
    expect(report.counts).toEqual({ would_create: 2, created: 0, duplicate: 0, invalid: 1 });
    expect(await rowsOf(formId)).toHaveLength(0);

    const issue = report.rows[1].issues?.[0];
    expect(issue?.field_id).toBe(nameId);
    expect(issue?.label).toBe('Full Name');
    expect(issue?.path).toBe(nameId);
    expect(issue?.code).toBeTruthy();
    expect(issue?.message).toBeTruthy();
  });

  it('names the offending key when the answers carry a field id the form has not', async () => {
    const { formId, revisionId, nameId } = await makeOpenForm();
    const stale = randomUUID();

    const report = await responseService.createResponses({
      formId,
      revisionId,
      addedBy: ownerId,
      audit: descriptor(),
      responses: [
        {
          email: addr('unknown-key'),
          answers: { ...answersFor(nameId, 'Fine'), [stale]: 'from an older revision' },
        },
      ],
    });

    expect(report.outcome).toBe('rejected');
    // ONE issue per refused key, each naming the key — not a single issue with
    // an empty path, which is what zod's `unrecognized_keys` would give.
    const issues = report.rows[0].issues ?? [];
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      code: 'unrecognized_keys',
      field_id: stale,
      path: stale,
    });
    expect(issues[0]?.label).toBeUndefined();
    expect(issues[0]?.message).toContain(stale);
    expect(issues[0]?.message).toContain('form_get');
    expect(await rowsOf(formId)).toHaveLength(0);
  });

  it('marks a malformed address invalid', async () => {
    const { formId, revisionId, nameId } = await makeOpenForm();
    const report = await responseService.createResponses({
      formId,
      revisionId,
      addedBy: ownerId,
      audit: descriptor(),
      responses: [{ email: 'not an address', answers: answersFor(nameId, 'X') }],
    });
    expect(report.outcome).toBe('rejected');
    expect(report.rows[0].issues?.[0]).toMatchObject({ code: 'invalid_email', path: 'email' });
    expect(await rowsOf(formId)).toHaveLength(0);
  });

  it('marks a submitted_at in the future invalid', async () => {
    const { formId, revisionId, nameId } = await makeOpenForm();
    const report = await responseService.createResponses({
      formId,
      revisionId,
      addedBy: ownerId,
      audit: descriptor(),
      responses: [
        { email: addr('past'), answers: answersFor(nameId, 'Past'), submittedAt: new Date(0) },
        {
          email: addr('future'),
          answers: answersFor(nameId, 'Future'),
          submittedAt: new Date(Date.now() + 60_000),
        },
      ],
    });

    expect(report.outcome).toBe('rejected');
    expect(report.rows[0].disposition).toBe('would_create');
    expect(report.rows[1].disposition).toBe('invalid');
    expect(report.rows[1].issues?.[0]).toMatchObject({
      code: 'future_timestamp',
      path: 'submitted_at',
    });
    expect(await rowsOf(formId)).toHaveLength(0);
  });

  // ── Dry run ──────────────────────────────────────────────────────────────

  it('counts a dry run without writing anything', async () => {
    const { formId, revisionId, nameId } = await makeOpenForm();
    const email = addr('dry-existing');
    await publicSubmit(formId, revisionId, email, 'Already Here');

    const report = await responseService.createResponses({
      formId,
      revisionId,
      addedBy: ownerId,
      audit: descriptor(),
      dryRun: true,
      responses: [
        { email: addr('dry-a'), answers: answersFor(nameId, 'A') },
        { email: addr('dry-b'), answers: answersFor(nameId, 'B') },
        { email, answers: answersFor(nameId, 'Dup') },
      ],
    });

    expect(report.outcome).toBe('dry_run');
    expect(report.counts).toEqual({ would_create: 2, created: 0, duplicate: 1, invalid: 0 });
    expect(report.rows[2].existing_state).toBe('SUBMITTED');
    expect(report.rows.every(row => row.disposition !== 'created')).toBe(true);
    // Only the row the public path made.
    expect(await rowsOf(formId)).toHaveLength(1);
  });

  // ── The cap ──────────────────────────────────────────────────────────────

  it('does batch arithmetic against the cap, and writes nothing when it overflows', async () => {
    const { formId, revisionId, nameId } = await makeOpenForm({ response_cap: 3 });
    await publicSubmit(formId, revisionId, addr('cap-1'), 'One');
    await publicSubmit(formId, revisionId, addr('cap-2'), 'Two');

    const twoRows = [
      { email: addr('cap-3'), answers: answersFor(nameId, 'Three') },
      { email: addr('cap-4'), answers: answersFor(nameId, 'Four') },
    ];

    expect(
      await codeOf(
        responseService.createResponses({
          formId,
          revisionId,
          addedBy: ownerId,
          audit: descriptor(),
          responses: twoRows,
        })
      )
    ).toBe(responseService.FORM_CAP_REACHED);
    expect(await rowsOf(formId)).toHaveLength(2);

    // A dry run is refused on exactly the same terms — a rehearsal that says
    // "fine" and a commit that says "full" would be worse than no rehearsal.
    expect(
      await codeOf(
        responseService.createResponses({
          formId,
          revisionId,
          addedBy: ownerId,
          audit: descriptor(),
          dryRun: true,
          responses: twoRows,
        })
      )
    ).toBe(responseService.FORM_CAP_REACHED);

    const report = await responseService.createResponses({
      formId,
      revisionId,
      addedBy: ownerId,
      audit: descriptor(),
      responses: [twoRows[0]],
    });
    expect(report.outcome).toBe('committed');
    expect(await rowsOf(formId)).toHaveLength(3);
  });

  // ── Guards ───────────────────────────────────────────────────────────────

  it('refuses a revision that is not the form’s current one', async () => {
    const { formId, revisionId, nameId } = await makeOpenForm();
    await formService.publish(formId); // revision 2 supersedes it

    expect(
      await codeOf(
        responseService.createResponses({
          formId,
          revisionId,
          addedBy: ownerId,
          audit: descriptor(),
          responses: [{ email: addr('stale'), answers: answersFor(nameId, 'Stale') }],
        })
      )
    ).toBe(responseService.FORM_REVISION_STALE);
    expect(await rowsOf(formId)).toHaveLength(0);
  });

  it('refuses a CLASSROOM form', async () => {
    const { formId, revisionId, nameId } = await makeOpenForm({ access: 'CLASSROOM' });
    expect(
      await codeOf(
        responseService.createResponses({
          formId,
          revisionId,
          addedBy: ownerId,
          audit: descriptor(),
          responses: [{ email: addr('classroom'), answers: answersFor(nameId, 'Nope') }],
        })
      )
    ).toBe(responseService.FORM_ACCESS_MISMATCH);
  });

  it('refuses a form that was never published', async () => {
    const form = await makeForm();
    expect(
      await codeOf(
        responseService.createResponses({
          formId: form.id,
          addedBy: ownerId,
          audit: descriptor(),
          responses: [{ email: addr('draft'), answers: {} }],
        })
      )
    ).toBe(responseService.FORM_NOT_OPEN);
  });

  it('accepts a CLOSED form — adding to a closed waitlist is the ordinary case', async () => {
    const { formId, revisionId, nameId } = await makeOpenForm();
    await formService.close(formId);

    const report = await responseService.createResponses({
      formId,
      revisionId,
      addedBy: ownerId,
      audit: descriptor(),
      responses: [{ email: addr('closed'), answers: answersFor(nameId, 'Late') }],
    });
    expect(report.outcome).toBe('committed');
    expect(await rowsOf(formId)).toHaveLength(1);
  });

  it('refuses an empty batch and one over the ceiling', async () => {
    const { formId, revisionId, nameId } = await makeOpenForm();
    expect(
      await codeOf(
        responseService.createResponses({
          formId,
          revisionId,
          addedBy: ownerId,
          audit: descriptor(),
          responses: [],
        })
      )
    ).toBe(responseService.FORM_BATCH_INVALID);

    const tooMany = Array.from({ length: responseService.CREATE_RESPONSES_MAX + 1 }, (_, i) => ({
      email: addr(`bulk-${i}`),
      answers: answersFor(nameId, `Bulk ${i}`),
    }));
    expect(
      await codeOf(
        responseService.createResponses({
          formId,
          revisionId,
          addedBy: ownerId,
          audit: descriptor(),
          responses: tooMany,
        })
      )
    ).toBe(responseService.FORM_BATCH_INVALID);
  });

  // ── Audit ────────────────────────────────────────────────────────────────

  describe('the audit row', () => {
    const auditsFor = (formId: string) =>
      prisma.auditLog.count({ where: { classroom_id: classroomId, resource_id: formId } });

    it('writes exactly one row on a commit, carrying the ids and counts', async () => {
      const { formId, revisionId, nameId } = await makeOpenForm();
      const report = await responseService.createResponses({
        formId,
        revisionId,
        addedBy: ownerId,
        audit: descriptor(),
        responses: [
          { email: addr('audit-a'), answers: answersFor(nameId, 'A') },
          { email: addr('audit-b'), answers: answersFor(nameId, 'B') },
        ],
      });

      expect(await auditsFor(formId)).toBe(1);
      const row = await prisma.auditLog.findFirstOrThrow({
        where: { classroom_id: classroomId, resource_id: formId },
      });
      expect(row.action).toBe('CREATE');
      expect(row.resource_type).toBe('FORMS');
      expect(row.user_id).toBe(ownerId);
      const payload = row.data as Record<string, unknown>;
      expect(payload.tool).toBe('form_response_create');
      expect(payload.revision_id).toBe(revisionId);
      expect(payload.counts).toMatchObject({ created: 2 });
      expect(payload.created_ids).toEqual(report.rows.map(r => r.response_id));
    });

    it('writes none on a dry run', async () => {
      const { formId, revisionId, nameId } = await makeOpenForm();
      await responseService.createResponses({
        formId,
        revisionId,
        addedBy: ownerId,
        audit: descriptor(),
        dryRun: true,
        responses: [{ email: addr('audit-dry'), answers: answersFor(nameId, 'Dry') }],
      });
      expect(await auditsFor(formId)).toBe(0);
    });

    it('writes none on a commit that created nothing — a no-op is not a mutation', async () => {
      const { formId, revisionId, nameId } = await makeOpenForm();
      const email = addr('audit-noop');
      await publicSubmit(formId, revisionId, email, 'Already Here');

      const report = await responseService.createResponses({
        formId,
        revisionId,
        addedBy: ownerId,
        audit: descriptor(),
        responses: [{ email, answers: answersFor(nameId, 'Staff Version') }],
      });

      expect(report.outcome).toBe('committed');
      expect(report.counts).toEqual({ would_create: 0, created: 0, duplicate: 1, invalid: 0 });
      // The transaction committed, but it wrote no response — so no CREATE row
      // may claim it did. (The MCP tool records that case as the VIEW it was.)
      expect(await auditsFor(formId)).toBe(0);
    });

    it('writes none on a rejected batch', async () => {
      const { formId, revisionId, nameId } = await makeOpenForm();
      const report = await responseService.createResponses({
        formId,
        revisionId,
        addedBy: ownerId,
        audit: descriptor(),
        responses: [
          { email: addr('audit-rej-a'), answers: answersFor(nameId, 'A') },
          { email: addr('audit-rej-b'), answers: {} },
        ],
      });
      expect(report.outcome).toBe('rejected');
      expect(await auditsFor(formId)).toBe(0);
    });
  });

  // ── What the staff list sees ─────────────────────────────────────────────

  it('files created rows into the FIFO order by their supplied submitted_at', async () => {
    const { formId, revisionId, nameId } = await makeOpenForm();
    // A real submission lands NOW, between the two backdated rows below.
    const middleId = await publicSubmit(formId, revisionId, addr('order-mid'), 'Middle');
    await prisma.formResponse.update({
      where: { id: middleId },
      data: { submitted_at: new Date('2026-02-15T12:00:00.000Z') },
    });

    const report = await responseService.createResponses({
      formId,
      revisionId,
      addedBy: ownerId,
      audit: descriptor(),
      responses: [
        {
          email: addr('order-late'),
          answers: answersFor(nameId, 'Late'),
          submittedAt: new Date('2026-03-15T12:00:00.000Z'),
        },
        {
          email: addr('order-early'),
          answers: answersFor(nameId, 'Early'),
          submittedAt: new Date('2026-01-15T12:00:00.000Z'),
        },
      ],
    });
    expect(report.outcome).toBe('committed');

    const listed = await responseService.listByFormId(formId);
    expect(listed.map(row => row.email)).toEqual([
      addr('order-early'),
      addr('order-mid'),
      addr('order-late'),
    ]);
    // And the staff select carries the attribution the list column reads.
    expect(listed.map(row => row.added_by)).toEqual([ownerId, null, ownerId]);
  });
});
