/**
 * form.service + formResponse.service against a REAL Postgres.
 *
 * The things this file covers cannot be mocked: `SELECT … FOR UPDATE`, the two
 * partial unique indexes, and what happens when six clients confirm at once
 * against a cap of two. A fake Prisma would happily agree with whatever the
 * service did.
 *
 * SAFETY: every fixture is namespaced with a fresh uuid and torn down in
 * afterAll by deleting the git organization (which cascades classroom → forms →
 * revisions → responses → tokens). Nothing is truncated and no pre-existing row
 * is touched — the devport database holds real development data.
 *
 * Skipped unless DATABASE_URL names a LOCAL database. `npm run test` from the
 * repo root routes through scripts/devport.sh, which points DATABASE_URL at
 * this worktree's own database; a bare package-level run has no DATABASE_URL
 * and skips.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';

import getPrisma from '@classmoji/database';
import * as formService from '../form.service.ts';
import * as responseService from '../formResponse.service.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
/**
 * Refuse the SHARED dev database by name. `.env` in a devport worktree still
 * points DATABASE_URL at the main `classmoji` database, so "is it localhost"
 * alone would let `dotenv -e .env -- vitest` write fixtures into everyone's dev
 * data. A devport database (`classmoji_forms`, `classmoji_<feature>`) is fine.
 */
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

const NAME_FIELD = { type: 'short_text', label: 'Full Name', required: true } as const;
const NOTE_FIELD = { type: 'long_text', label: 'Anything else?' } as const;

describe.skipIf(!RUN)('forms services (integration)', () => {
  const suite = randomUUID().slice(0, 8);
  let classroomId: string;
  let orgId: string;
  let ownerId: string;
  let studentAId: string;
  let studentBId: string;

  const prisma = getPrisma();

  const makeUser = async (label: string) => {
    const user = await prisma.user.create({
      data: {
        login: `formtest-${suite}-${label}`,
        email: `formtest-${suite}-${label}@example.test`,
        name: `Form Test ${label}`,
      },
    });
    return user.id;
  };

  /** A fresh DRAFT form with a unique title (and therefore a unique slug). */
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
  } = {}) => {
    const form = await formService.create({
      classroomId,
      title: `Form ${suite} ${randomUUID().slice(0, 8)}`,
      access,
      createdBy: ownerId,
      fields,
    });
    if (Object.keys(rest).length > 0) await formService.update(form.id, rest);
    return form;
  };

  /** A published form, plus the id of the revision its fill page renders. */
  const makeOpenForm = async (options: Parameters<typeof makeForm>[0] = {}) => {
    const form = await makeForm(options);
    const { revision } = await formService.publish(form.id);
    return { formId: form.id, revisionId: revision.id };
  };

  const nameFieldId = async (revisionId: string) => {
    const revision = await prisma.formRevision.findUniqueOrThrow({ where: { id: revisionId } });
    return formService.fieldsOf(revision.fields)[0].id;
  };

  beforeAll(async () => {
    const org = await prisma.gitOrganization.create({
      data: {
        provider: 'GITHUB',
        provider_id: `formtest-${suite}`,
        login: `formtest-org-${suite}`,
      },
    });
    orgId = org.id;

    const classroom = await prisma.classroom.create({
      data: {
        slug: `formtest-${suite}`,
        git_org_id: orgId,
        name: `Forms Test ${suite}`,
        content_namespace: `formtest-${suite}`,
        content_repo: `content-formtest-${suite}`,
      },
    });
    classroomId = classroom.id;

    ownerId = await makeUser('owner');
    studentAId = await makeUser('a');
    studentBId = await makeUser('b');
  });

  afterAll(async () => {
    // Deleting the org cascades: classrooms → forms → revisions → responses →
    // magic tokens. Users are deleted after, once nothing references them.
    if (orgId) await prisma.gitOrganization.delete({ where: { id: orgId } }).catch(() => {});
    await prisma.user
      .deleteMany({ where: { login: { startsWith: `formtest-${suite}-` } } })
      .catch(() => {});
  });

  // ── form.service ─────────────────────────────────────────────────────────

  describe('form.service', () => {
    it('derives a slug from the title and finds the form by it', async () => {
      const form = await formService.create({
        classroomId,
        title: `Waitlist ${suite}`,
        createdBy: ownerId,
      });
      expect(form.slug).toBe(`waitlist-${suite}`);
      expect(form.status).toBe('DRAFT');
      expect(form.access).toBe('PUBLIC');

      const found = await formService.findBySlug(classroomId, form.slug);
      expect(found?.id).toBe(form.id);
    });

    it('uniquifies a colliding slug rather than failing', async () => {
      const title = `Duplicate ${suite}`;
      const first = await formService.create({ classroomId, title, createdBy: ownerId });
      const second = await formService.create({ classroomId, title, createdBy: ownerId });
      expect(second.slug).toBe(`${first.slug}-2`);
    });

    it.each(['edit', 'responses', 'new'])('never hands out the reserved slug %s', async word => {
      const form = await formService.create({
        classroomId,
        title: word,
        createdBy: ownerId,
      });
      expect(form.slug).not.toBe(word);
      expect(form.slug).toBe(`${word}-2`);
    });

    it('rejects a title with no slug-usable characters', async () => {
      expect(
        await codeOf(formService.create({ classroomId, title: '🎉', createdBy: ownerId }))
      ).toBe(formService.FORM_SLUG_RESERVED);
    });

    it('gives up with FORM_SLUG_UNAVAILABLE once every candidate is taken', async () => {
      const title = `Crowded ${suite}`;
      const taken = formService.formSlugCandidates(title);
      await prisma.form.createMany({
        data: taken.map(slug => ({
          classroom_id: classroomId,
          title,
          slug,
          created_by: ownerId,
        })),
      });
      expect(await codeOf(formService.create({ classroomId, title, createdBy: ownerId }))).toBe(
        formService.FORM_SLUG_UNAVAILABLE
      );
    });

    it('rejects a roster field on a PUBLIC form at create and at update', async () => {
      const rosterField = {
        type: 'roster_select',
        label: 'Teammates',
        optionSource: 'roster',
        options: [{ label: 'Someone' }],
      };
      expect(
        await codeOf(
          formService.create({
            classroomId,
            title: `Roster ${suite} ${randomUUID().slice(0, 6)}`,
            createdBy: ownerId,
            fields: [rosterField],
          })
        )
      ).toBe('FORM_FIELD_ACCESS_VIOLATION');

      const form = await makeForm();
      expect(await codeOf(formService.update(form.id, { fields: [rosterField] }))).toBe(
        'FORM_FIELD_ACCESS_VIOLATION'
      );
    });

    it('refuses to narrow CLASSROOM → PUBLIC while roster fields are saved', async () => {
      const form = await makeForm({
        access: 'CLASSROOM',
        fields: [
          {
            type: 'roster_select',
            label: 'Teammates',
            optionSource: 'roster',
            options: [{ label: 'Someone' }],
          },
        ],
      });
      expect(await codeOf(formService.update(form.id, { access: 'PUBLIC' }))).toBe(
        'FORM_FIELD_ACCESS_VIOLATION'
      );
    });

    it('freezes access once the form leaves DRAFT', async () => {
      const form = await makeForm({ access: 'PUBLIC' });
      // Still a draft: the change goes through.
      await formService.update(form.id, { access: 'CLASSROOM' });
      await formService.update(form.id, { access: 'PUBLIC' });

      await formService.publish(form.id);
      expect(await codeOf(formService.update(form.id, { access: 'CLASSROOM' }))).toBe(
        formService.FORM_ACCESS_FROZEN
      );

      // Re-stating the CURRENT access is not a change and must not be refused.
      await expect(formService.update(form.id, { access: 'PUBLIC' })).resolves.toBeTruthy();
    });

    it('refuses a field-list edit once the form is published', async () => {
      const form = await makeForm();
      await formService.publish(form.id);
      expect(await codeOf(formService.update(form.id, { fields: [NAME_FIELD] }))).toBe(
        formService.FORM_NOT_DRAFT
      );
    });

    it('refuses to publish a form with no fields', async () => {
      const form = await formService.create({
        classroomId,
        title: `Empty ${suite} ${randomUUID().slice(0, 6)}`,
        createdBy: ownerId,
      });
      expect(await codeOf(formService.publish(form.id))).toBe(formService.FORM_NO_FIELDS);
    });

    it('publishing twice produces versions 1 and 2 and moves current_revision_id', async () => {
      const form = await makeForm();
      const first = await formService.publish(form.id);
      expect(first.revision.version).toBe(1);
      expect(first.form.status).toBe('OPEN');
      expect(first.form.current_revision_id).toBe(first.revision.id);

      const second = await formService.publish(form.id);
      expect(second.revision.version).toBe(2);
      expect(second.form.current_revision_id).toBe(second.revision.id);

      const versions = (await formService.listRevisions(form.id)).map(r => r.version);
      expect(versions).toEqual([1, 2]);
    });

    it('close, reopen, and refusing to open a never-published form', async () => {
      const draft = await makeForm();
      expect(await codeOf(formService.reopen(draft.id))).toBe(formService.FORM_NO_FIELDS);
      // The inline tri-state select calls quickUpdate directly — same guard.
      expect(await codeOf(formService.quickUpdate(draft.id, { status: 'OPEN' }))).toBe(
        formService.FORM_NO_FIELDS
      );
      // Draft → Draft and Draft → Closed are always allowed.
      expect((await formService.quickUpdate(draft.id, { status: 'CLOSED' })).status).toBe('CLOSED');

      await formService.quickUpdate(draft.id, { status: 'DRAFT' });
      await formService.publish(draft.id);
      expect((await formService.close(draft.id)).status).toBe('CLOSED');
      expect((await formService.reopen(draft.id)).status).toBe('OPEN');
    });

    it('deleting a form takes its revisions, responses, and tokens with it', async () => {
      const { formId, revisionId } = await makeOpenForm();
      const fieldId = await nameFieldId(revisionId);
      const { responseId } = await responseService.beginPublicSubmission({
        formId,
        email: `del-${suite}@example.test`,
        answers: { [fieldId]: 'Maya Chen' },
        revisionId,
      });

      await formService.deleteForm(formId);

      expect(await prisma.formResponse.findUnique({ where: { id: responseId } })).toBeNull();
      expect(await prisma.formRevision.findUnique({ where: { id: revisionId } })).toBeNull();
      expect(await prisma.formMagicToken.count({ where: { response_id: responseId } })).toBe(0);
    });
  });

  // ── public submission + magic links ──────────────────────────────────────

  describe('magic links', () => {
    it('begin → confirm is the happy path, and nothing counts until confirm', async () => {
      const { formId, revisionId } = await makeOpenForm();
      const fieldId = await nameFieldId(revisionId);

      const begun = await responseService.beginPublicSubmission({
        formId,
        email: '  Maya.R.Chen.28@Dartmouth.edu ',
        name: 'Maya Chen',
        answers: { [fieldId]: 'Maya Chen' },
        revisionId,
      });
      expect(begun.mode).toBe('new');
      expect(begun.rawToken).toHaveLength(43); // 32 bytes, base64url, unpadded

      // The mail is COMPOSED here and sent by the caller (roster.service shape).
      expect(begun.emails).toHaveLength(1);
      expect(begun.emails[0].payload.to).toBe('Maya.R.Chen.28@Dartmouth.edu');
      expect(begun.emails[0].payload.template.id).toBe('form-verify-link');
      expect(begun.emails[0].payload.template.variables.VERIFY_URL).toBe(begun.verifyUrl);
      expect(begun.verifyUrl).toContain(`token=${begun.rawToken}`);
      expect(begun.verifyUrl).toContain(`/formtest-${suite}/forms/`);

      const pending = await prisma.formResponse.findUniqueOrThrow({
        where: { id: begun.responseId },
      });
      expect(pending.submission_state).toBe('PENDING_VERIFICATION');
      expect(pending.verified_at).toBeNull();
      expect(pending.email_normalized).toBe('maya.r.chen.28@dartmouth.edu');
      expect(pending.email).toBe('Maya.R.Chen.28@Dartmouth.edu');

      const review = await responseService.verifyMagicToken(begun.rawToken);
      expect(review.response.id).toBe(begun.responseId);
      expect(review.response).not.toHaveProperty('staff_note');

      const { response, firstVerification } = await responseService.confirmSubmission(
        begun.rawToken
      );
      expect(firstVerification).toBe(true);
      expect(response.submission_state).toBe('SUBMITTED');
      expect(response.verified_at).toBeInstanceOf(Date);
    });

    it('stores the raw token only as a sha256 digest', async () => {
      const { formId, revisionId } = await makeOpenForm();
      const fieldId = await nameFieldId(revisionId);
      const begun = await responseService.beginPublicSubmission({
        formId,
        email: `hash-${suite}@example.test`,
        answers: { [fieldId]: 'Maya' },
        revisionId,
      });
      const token = await prisma.formMagicToken.findFirstOrThrow({
        where: { response_id: begun.responseId },
      });
      expect(token.token_hash).toBe(responseService.hashToken(begun.rawToken));
      expect(token.token_hash).not.toContain(begun.rawToken);
    });

    it('rejects an unknown, an expired, and an already-used link', async () => {
      const { formId, revisionId } = await makeOpenForm();
      const fieldId = await nameFieldId(revisionId);

      expect(await codeOf(responseService.confirmSubmission('not-a-real-token'))).toBe(
        responseService.MAGIC_LINK_INVALID
      );

      const expired = await responseService.beginPublicSubmission({
        formId,
        email: `expired-${suite}@example.test`,
        answers: { [fieldId]: 'Maya' },
        revisionId,
      });
      await prisma.formMagicToken.updateMany({
        where: { response_id: expired.responseId },
        data: { expires_at: new Date(Date.now() - 1000) },
      });
      expect(await codeOf(responseService.verifyMagicToken(expired.rawToken))).toBe(
        responseService.MAGIC_LINK_EXPIRED
      );
      expect(await codeOf(responseService.confirmSubmission(expired.rawToken))).toBe(
        responseService.MAGIC_LINK_EXPIRED
      );

      const used = await responseService.beginPublicSubmission({
        formId,
        email: `used-${suite}@example.test`,
        answers: { [fieldId]: 'Maya' },
        revisionId,
      });
      await responseService.confirmSubmission(used.rawToken);
      expect(await codeOf(responseService.confirmSubmission(used.rawToken))).toBe(
        responseService.MAGIC_LINK_USED
      );
    });

    it('allows three link sends per response per hour, then cools down', async () => {
      const { formId, revisionId } = await makeOpenForm();
      const fieldId = await nameFieldId(revisionId);
      const email = `cooldown-${suite}@example.test`;
      const submit = () =>
        responseService.beginPublicSubmission({
          formId,
          email,
          answers: { [fieldId]: 'Maya' },
          revisionId,
        });

      await submit();
      const second = await submit();
      expect(second.mode).toBe('existing');
      await submit();
      expect(await codeOf(submit())).toBe(responseService.MAGIC_LINK_COOLDOWN);

      // The refused send must not have left a token behind.
      const responseId = second.responseId;
      expect(await prisma.formMagicToken.count({ where: { response_id: responseId } })).toBe(3);
    });

    it('a second begin for the same email opens the SAME row and keeps its answers', async () => {
      const { formId, revisionId } = await makeOpenForm();
      const fieldId = await nameFieldId(revisionId);
      const email = `same-${suite}@example.test`;

      const first = await responseService.beginPublicSubmission({
        formId,
        email,
        answers: { [fieldId]: 'The real Maya' },
        revisionId,
      });
      const second = await responseService.beginPublicSubmission({
        formId,
        email,
        answers: { [fieldId]: 'An impostor' },
        revisionId,
      });

      expect(second.mode).toBe('existing');
      expect(second.responseId).toBe(first.responseId);
      const row = await prisma.formResponse.findUniqueOrThrow({ where: { id: first.responseId } });
      expect((row.answers as Record<string, string>)[fieldId]).toBe('The real Maya');
    });

    it('a later edit replaces the answers but preserves the first verified_at', async () => {
      const { formId, revisionId } = await makeOpenForm();
      const fieldId = await nameFieldId(revisionId);
      const email = `edit-${suite}@example.test`;

      const first = await responseService.beginPublicSubmission({
        formId,
        email,
        answers: { [fieldId]: 'Maya Chen' },
        revisionId,
      });
      const confirmed = await responseService.confirmSubmission(first.rawToken);
      const originalVerifiedAt = confirmed.response.verified_at;

      await new Promise(resolve => setTimeout(resolve, 20));

      const again = await responseService.beginPublicSubmission({
        formId,
        email,
        answers: { [fieldId]: 'Maya Chen' },
        revisionId,
      });
      const edited = await responseService.confirmSubmission(again.rawToken, {
        answers: { [fieldId]: 'Maya R. Chen' },
      });

      expect(edited.firstVerification).toBe(false);
      expect(edited.response.verified_at?.getTime()).toBe(originalVerifiedAt?.getTime());
      expect((edited.response.answers as Record<string, string>)[fieldId]).toBe('Maya R. Chen');
    });

    it('validates answers against the revision on both begin and confirm', async () => {
      const { formId, revisionId } = await makeOpenForm();
      const fieldId = await nameFieldId(revisionId);

      // Required field missing.
      expect(
        await codeOf(
          responseService.beginPublicSubmission({
            formId,
            email: `bad-${suite}@example.test`,
            answers: {},
            revisionId,
          })
        )
      ).toBe('FORM_ANSWERS_INVALID');

      const good = await responseService.beginPublicSubmission({
        formId,
        email: `good-${suite}@example.test`,
        answers: { [fieldId]: 'Maya' },
        revisionId,
      });
      expect(
        await codeOf(
          responseService.confirmSubmission(good.rawToken, { answers: { unknown: 'x' } })
        )
      ).toBe('FORM_ANSWERS_INVALID');
      // The failed confirm rolled back — the link is still usable.
      await expect(responseService.confirmSubmission(good.rawToken)).resolves.toBeTruthy();
    });

    it('refuses a submission against a stale revision', async () => {
      const { formId, revisionId } = await makeOpenForm();
      const fieldId = await nameFieldId(revisionId);
      await formService.publish(formId); // revision 2 supersedes it

      expect(
        await codeOf(
          responseService.beginPublicSubmission({
            formId,
            email: `stale-${suite}@example.test`,
            answers: { [fieldId]: 'Maya' },
            revisionId,
          })
        )
      ).toBe(responseService.FORM_REVISION_STALE);
    });

    it('refuses a public submission to a CLOSED or DRAFT form, and past closes_at', async () => {
      const { formId, revisionId } = await makeOpenForm();
      const fieldId = await nameFieldId(revisionId);
      const submit = (email: string) =>
        responseService.beginPublicSubmission({
          formId,
          email,
          answers: { [fieldId]: 'Maya' },
          revisionId,
        });

      await formService.close(formId);
      expect(await codeOf(submit(`closed-${suite}@example.test`))).toBe(
        responseService.FORM_NOT_OPEN
      );

      await formService.reopen(formId);
      await formService.update(formId, { closes_at: new Date(Date.now() - 1000) });
      expect(await codeOf(submit(`past-${suite}@example.test`))).toBe(responseService.FORM_CLOSED);
    });

    it('refuses the public path on a CLASSROOM form', async () => {
      const { formId, revisionId } = await makeOpenForm({ access: 'CLASSROOM' });
      const fieldId = await nameFieldId(revisionId);
      expect(
        await codeOf(
          responseService.beginPublicSubmission({
            formId,
            email: `wrongmode-${suite}@example.test`,
            answers: { [fieldId]: 'Maya' },
            revisionId,
          })
        )
      ).toBe(responseService.FORM_ACCESS_MISMATCH);
    });
  });

  // ── concurrency ──────────────────────────────────────────────────────────

  describe('concurrency', () => {
    it('a cap of 2 admits exactly 2 of 6 simultaneous confirmations', async () => {
      const { formId, revisionId } = await makeOpenForm({ response_cap: 2 });
      const fieldId = await nameFieldId(revisionId);

      const tokens: string[] = [];
      for (let n = 0; n < 6; n++) {
        const begun = await responseService.beginPublicSubmission({
          formId,
          email: `cap-${suite}-${n}@example.test`,
          answers: { [fieldId]: `Person ${n}` },
          revisionId,
        });
        tokens.push(begun.rawToken);
      }

      const outcomes = await Promise.allSettled(
        tokens.map(token => responseService.confirmSubmission(token))
      );

      const fulfilled = outcomes.filter(outcome => outcome.status === 'fulfilled');
      const capErrors = outcomes.filter(
        outcome =>
          outcome.status === 'rejected' &&
          (outcome.reason as { code?: string }).code === responseService.FORM_CAP_REACHED
      );
      expect(fulfilled).toHaveLength(2);
      expect(capErrors).toHaveLength(4);

      const submitted = await prisma.formResponse.count({
        where: { form_id: formId, submission_state: 'SUBMITTED', verified_at: { not: null } },
      });
      expect(submitted).toBe(2);

      // The four refused rows are still unverified and still hold their slots.
      const pending = await prisma.formResponse.count({
        where: { form_id: formId, submission_state: 'PENDING_VERIFICATION' },
      });
      expect(pending).toBe(4);
    });

    it('six simultaneous public submissions for one email create exactly one row', async () => {
      const { formId, revisionId } = await makeOpenForm();
      const fieldId = await nameFieldId(revisionId);
      const email = `race-${suite}@example.test`;

      const outcomes = await Promise.allSettled(
        Array.from({ length: 6 }, (_, n) =>
          responseService.beginPublicSubmission({
            formId,
            email,
            answers: { [fieldId]: `Attempt ${n}` },
            revisionId,
          })
        )
      );

      const rows = await prisma.formResponse.findMany({ where: { form_id: formId } });
      expect(rows).toHaveLength(1);

      // The row-lock serializes them, so the cooldown is exact too: three links
      // are sent, the rest are refused.
      const fulfilled = outcomes.filter(outcome => outcome.status === 'fulfilled');
      expect(fulfilled).toHaveLength(responseService.MAGIC_TOKEN_MAX_PER_WINDOW);
      for (const outcome of outcomes) {
        if (outcome.status === 'rejected') {
          expect((outcome.reason as { code?: string }).code).toBe(
            responseService.MAGIC_LINK_COOLDOWN
          );
        }
      }
      expect(await prisma.formMagicToken.count({ where: { response_id: rows[0].id } })).toBe(3);
    });

    it('the partial unique index refuses a second row for one classroom user', async () => {
      const { formId, revisionId } = await makeOpenForm({ access: 'CLASSROOM' });
      await prisma.formResponse.create({
        data: {
          form_id: formId,
          revision_id: revisionId,
          user_id: studentAId,
          email: 'a@example.test',
          email_normalized: 'a@example.test',
          answers: {},
          submission_state: 'SUBMITTED',
        },
      });
      await expect(
        prisma.formResponse.create({
          data: {
            form_id: formId,
            revision_id: revisionId,
            user_id: studentAId,
            email: 'a@example.test',
            email_normalized: 'a@example.test',
            answers: {},
            submission_state: 'SUBMITTED',
          },
        })
      ).rejects.toMatchObject({ code: 'P2002' });
    });
  });

  // ── classroom submission ─────────────────────────────────────────────────

  describe('classroom submission', () => {
    it('records the session identity and verifies immediately', async () => {
      const { formId, revisionId } = await makeOpenForm({ access: 'CLASSROOM' });
      const fieldId = await nameFieldId(revisionId);

      const response = await responseService.submitClassroom({
        formId,
        userId: studentAId,
        email: `formtest-${suite}-a@example.test`,
        name: 'Student A',
        answers: { [fieldId]: 'Student A' },
        revisionId,
      });

      expect(response.user_id).toBe(studentAId);
      expect(response.submission_state).toBe('SUBMITTED');
      expect(response.verified_at).toBeInstanceOf(Date);
    });

    it('refuses a second submission unless allow_multiple is set', async () => {
      const { formId, revisionId } = await makeOpenForm({ access: 'CLASSROOM' });
      const fieldId = await nameFieldId(revisionId);
      const submit = (value: string) =>
        responseService.submitClassroom({
          formId,
          userId: studentAId,
          email: `formtest-${suite}-a@example.test`,
          answers: { [fieldId]: value },
          revisionId,
        });

      await submit('First');
      expect(await codeOf(submit('Second'))).toBe(responseService.FORM_ALREADY_SUBMITTED);

      await formService.update(formId, { allow_multiple: true });
      const replaced = await submit('Second');
      expect((replaced.answers as Record<string, string>)[fieldId]).toBe('Second');
      expect(await prisma.formResponse.count({ where: { form_id: formId } })).toBe(1);
    });

    it('a resubmission keeps the original verified_at and does not re-take a cap slot', async () => {
      const { formId, revisionId } = await makeOpenForm({
        access: 'CLASSROOM',
        response_cap: 1,
        allow_multiple: true,
      });
      const fieldId = await nameFieldId(revisionId);
      const submit = (value: string) =>
        responseService.submitClassroom({
          formId,
          userId: studentAId,
          email: `formtest-${suite}-a@example.test`,
          answers: { [fieldId]: value },
          revisionId,
        });

      const first = await submit('First');
      const second = await submit('Second');
      expect(second.verified_at?.getTime()).toBe(first.verified_at?.getTime());

      // The single slot is taken, so a different member is refused.
      expect(
        await codeOf(
          responseService.submitClassroom({
            formId,
            userId: studentBId,
            email: `formtest-${suite}-b@example.test`,
            answers: { [fieldId]: 'Student B' },
            revisionId,
          })
        )
      ).toBe(responseService.FORM_CAP_REACHED);
    });

    it('refuses the classroom path on a PUBLIC form', async () => {
      const { formId, revisionId } = await makeOpenForm({ access: 'PUBLIC' });
      const fieldId = await nameFieldId(revisionId);
      expect(
        await codeOf(
          responseService.submitClassroom({
            formId,
            userId: studentAId,
            email: `formtest-${suite}-a@example.test`,
            answers: { [fieldId]: 'Student A' },
            revisionId,
          })
        )
      ).toBe(responseService.FORM_ACCESS_MISMATCH);
    });
  });

  // ── isolation ────────────────────────────────────────────────────────────

  describe('isolation', () => {
    it('findOwnResponse returns only the caller’s row, and never staff columns', async () => {
      const { formId, revisionId } = await makeOpenForm({ access: 'CLASSROOM' });
      const fieldId = await nameFieldId(revisionId);

      for (const [userId, label] of [
        [studentAId, 'a'],
        [studentBId, 'b'],
      ] as const) {
        await responseService.submitClassroom({
          formId,
          userId,
          email: `formtest-${suite}-${label}@example.test`,
          answers: { [fieldId]: `Answer from ${label}` },
          revisionId,
        });
      }

      const rows = await responseService.listByFormId(formId);
      await responseService.updateStaff({
        responseId: rows[0].id,
        staff_status: 'responded to',
        staff_note: 'internal',
      });

      const mine = await responseService.findOwnResponse(formId, studentAId);
      expect(mine?.user_id).toBe(studentAId);
      expect((mine?.answers as Record<string, string>)[fieldId]).toBe('Answer from a');
      expect(mine).not.toHaveProperty('staff_status');
      expect(mine).not.toHaveProperty('staff_note');

      const theirs = await responseService.findOwnResponse(formId, studentBId);
      expect(theirs?.user_id).toBe(studentBId);
      expect(theirs?.id).not.toBe(mine?.id);

      // A user with no response gets null, not somebody else's row.
      expect(await responseService.findOwnResponse(formId, ownerId)).toBeNull();

      // listByFormId is the only path that returns everyone.
      expect(await responseService.listByFormId(formId)).toHaveLength(2);
    });

    it('findOwnResponseByDraftToken is scoped to the form and the token', async () => {
      const { formId, revisionId } = await makeOpenForm();
      await formService.update(formId, { save_partials: true });
      const token = randomUUID();

      await responseService.upsertDraft({
        formId,
        revisionId,
        draftToken: token,
        email: `draft-${suite}@example.test`,
        answers: { partial: true },
      });

      expect(await responseService.findOwnResponseByDraftToken(formId, token)).toBeTruthy();
      expect(await responseService.findOwnResponseByDraftToken(formId, randomUUID())).toBeNull();
    });
  });

  // ── drafts, triage, sweep ────────────────────────────────────────────────

  describe('drafts, staff triage, and the expiry sweep', () => {
    it('refuses an anonymous server-side draft when save_partials is off', async () => {
      const { formId, revisionId } = await makeOpenForm();
      expect(
        await codeOf(
          responseService.upsertDraft({
            formId,
            revisionId,
            draftToken: randomUUID(),
            email: `nopartial-${suite}@example.test`,
            answers: {},
          })
        )
      ).toBe(responseService.FORM_PARTIALS_DISABLED);
    });

    it('a draft save never walks a submitted response backwards', async () => {
      const { formId, revisionId } = await makeOpenForm({ access: 'CLASSROOM' });
      const fieldId = await nameFieldId(revisionId);

      await responseService.submitClassroom({
        formId,
        userId: studentAId,
        email: `formtest-${suite}-a@example.test`,
        answers: { [fieldId]: 'Final' },
        revisionId,
      });

      const after = await responseService.upsertDraft({
        formId,
        revisionId,
        userId: studentAId,
        email: `formtest-${suite}-a@example.test`,
        answers: { [fieldId]: 'Still typing' },
      });
      expect(after.submission_state).toBe('SUBMITTED');
      expect(after.verified_at).toBeInstanceOf(Date);
    });

    it('staff status and note round-trip, and suggest the labels already used', async () => {
      const { formId, revisionId } = await makeOpenForm();
      const fieldId = await nameFieldId(revisionId);

      const ids: string[] = [];
      for (let n = 0; n < 3; n++) {
        const begun = await responseService.beginPublicSubmission({
          formId,
          email: `triage-${suite}-${n}@example.test`,
          answers: { [fieldId]: `Person ${n}` },
          revisionId,
        });
        ids.push(begun.responseId);
      }

      await responseService.updateStaff({ responseId: ids[0], staff_status: 'on roster' });
      await responseService.updateStaff({ responseId: ids[1], staff_status: 'on roster' });
      await responseService.updateStaff({
        responseId: ids[2],
        staff_status: 'responded to',
        staff_note: 'emailed 8/25',
      });

      expect(await responseService.statusLabelSuggestions(formId)).toEqual([
        { label: 'on roster', count: 2 },
        { label: 'responded to', count: 1 },
      ]);

      const filtered = await responseService.listByFormId(formId, { staffStatus: 'on roster' });
      expect(filtered).toHaveLength(2);

      // Blank clears the label rather than storing ''.
      await responseService.updateStaff({ responseId: ids[0], staff_status: '  ' });
      const cleared = await prisma.formResponse.findUniqueOrThrow({ where: { id: ids[0] } });
      expect(cleared.staff_status).toBeNull();
    });

    it('deletes a single response', async () => {
      const { formId, revisionId } = await makeOpenForm();
      const fieldId = await nameFieldId(revisionId);
      const begun = await responseService.beginPublicSubmission({
        formId,
        email: `delete-one-${suite}@example.test`,
        answers: { [fieldId]: 'Maya' },
        revisionId,
      });
      await responseService.deleteResponse(begun.responseId);
      expect(await prisma.formResponse.findUnique({ where: { id: begun.responseId } })).toBeNull();
    });

    it('the sweep drops stale unverified rows and orphan drafts, keeping the rest', async () => {
      const { formId, revisionId } = await makeOpenForm();
      const fieldId = await nameFieldId(revisionId);
      const long_ago = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

      const stale = await responseService.beginPublicSubmission({
        formId,
        email: `stale-pending-${suite}@example.test`,
        answers: { [fieldId]: 'Maya' },
        revisionId,
      });
      await prisma.formResponse.update({
        where: { id: stale.responseId },
        data: { created_at: long_ago },
      });

      const fresh = await responseService.beginPublicSubmission({
        formId,
        email: `fresh-pending-${suite}@example.test`,
        answers: { [fieldId]: 'Maya' },
        revisionId,
      });

      const verified = await responseService.beginPublicSubmission({
        formId,
        email: `verified-${suite}@example.test`,
        answers: { [fieldId]: 'Maya' },
        revisionId,
      });
      await responseService.confirmSubmission(verified.rawToken);
      await prisma.formResponse.update({
        where: { id: verified.responseId },
        data: { created_at: long_ago },
      });

      const orphanDraft = await prisma.formResponse.create({
        data: {
          form_id: formId,
          revision_id: revisionId,
          draft_token: randomUUID(),
          email: `orphan-${suite}@example.test`,
          email_normalized: `orphan-${suite}@example.test`,
          answers: {},
          submission_state: 'DRAFT',
          updated_at: long_ago,
        },
      });

      const memberDraft = await prisma.formResponse.create({
        data: {
          form_id: formId,
          revision_id: revisionId,
          user_id: studentAId,
          email: `member-${suite}@example.test`,
          email_normalized: `member-${suite}@example.test`,
          answers: {},
          submission_state: 'DRAFT',
          updated_at: long_ago,
        },
      });

      await responseService.expireStale();

      const survivors = await prisma.formResponse.findMany({
        where: { form_id: formId },
        select: { id: true },
      });
      const ids = survivors.map(row => row.id);
      expect(ids).not.toContain(stale.responseId);
      expect(ids).not.toContain(orphanDraft.id);
      expect(ids).toContain(fresh.responseId);
      expect(ids).toContain(verified.responseId);
      expect(ids).toContain(memberDraft.id);

      // The freed slot lets the same address start over.
      await expect(
        responseService.beginPublicSubmission({
          formId,
          email: `stale-pending-${suite}@example.test`,
          answers: { [fieldId]: 'Maya' },
          revisionId,
        })
      ).resolves.toMatchObject({ mode: 'new' });
    });
  });
});
