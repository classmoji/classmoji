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

/**
 * The link a `beginPublicSubmission` MINTED.
 *
 * `rawToken` is nullable now: a submission whose address already holds a live,
 * unspent, young link reuses it and mails nothing (see `MAGIC_TOKEN_REUSE_MS`).
 * Every call site below that asks for a token is one where a fresh token is
 * genuinely expected — a first begin for a new address, or one whose previous
 * link has been spent or aged out — so a null here is a real failure and says
 * so, rather than surfacing three frames later as "cannot read null".
 */
const tokenOf = ({ rawToken }: { rawToken: string | null }): string => {
  if (!rawToken) throw new Error('expected a freshly minted link, got a reused one');
  return rawToken;
};

/** The raw token inside a composed link mail. */
const tokenIn = (result: {
  emails: Array<{ payload: { template: { variables: Record<string, string | number> } } }>;
}): string =>
  new URL(String(result.emails[0].payload.template.variables.VERIFY_URL)).searchParams.get(
    'token'
  )!;

/** The one response an address has on a form. */
const rowFor = (formId: string, email: string) =>
  getPrisma().formResponse.findFirstOrThrow({
    where: { form_id: formId, email_normalized: email.toLowerCase() },
  });

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
      expect(tokenOf(begun)).toHaveLength(43); // 32 bytes, base64url, unpadded

      // The mail is COMPOSED here and sent by the caller (roster.service shape).
      expect(begun.emails).toHaveLength(1);
      expect(begun.emails[0].payload.to).toBe('Maya.R.Chen.28@Dartmouth.edu');
      expect(begun.emails[0].payload.template.id).toBe('form-verify-link');
      expect(begun.emails[0].payload.template.variables.VERIFY_URL).toBe(begun.verifyUrl);
      expect(begun.verifyUrl).toContain(`token=${tokenOf(begun)}`);
      expect(begun.verifyUrl).toContain(`/formtest-${suite}/forms/`);

      const pending = await prisma.formResponse.findUniqueOrThrow({
        where: { id: begun.responseId },
      });
      expect(pending.submission_state).toBe('PENDING_VERIFICATION');
      expect(pending.verified_at).toBeNull();
      expect(pending.email_normalized).toBe('maya.r.chen.28@dartmouth.edu');
      expect(pending.email).toBe('Maya.R.Chen.28@Dartmouth.edu');

      const review = await responseService.verifyMagicToken(tokenOf(begun));
      expect(review.response.id).toBe(begun.responseId);
      expect(review.response).not.toHaveProperty('staff_note');

      const { response, firstVerification } = await responseService.confirmSubmission(
        tokenOf(begun)
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
      expect(token.token_hash).toBe(responseService.hashToken(tokenOf(begun)));
      expect(token.token_hash).not.toContain(tokenOf(begun));
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
      expect(await codeOf(responseService.verifyMagicToken(tokenOf(expired)))).toBe(
        responseService.MAGIC_LINK_EXPIRED
      );
      expect(await codeOf(responseService.confirmSubmission(tokenOf(expired)))).toBe(
        responseService.MAGIC_LINK_EXPIRED
      );

      const used = await responseService.beginPublicSubmission({
        formId,
        email: `used-${suite}@example.test`,
        answers: { [fieldId]: 'Maya' },
        revisionId,
      });
      await responseService.confirmSubmission(tokenOf(used));
      expect(await codeOf(responseService.confirmSubmission(tokenOf(used)))).toBe(
        responseService.MAGIC_LINK_USED
      );
    });

    /**
     * ── One live link per address ───────────────────────────────────────────
     *
     * Typing an address mails a link; submitting used to mail a second one
     * seconds later. Two mails for one action reads as broken, and the second
     * makes the first ambiguous. So a send that finds a live, unspent, young
     * link stands down — and every way that link could stop being usable puts
     * the mint back, which is what stops "no mail" from ever meaning "no link".
     */
    describe('reusing a link that is already in the inbox', () => {
      const beginFor = (formId: string, revisionId: string, fieldId: string, email: string) =>
        responseService.beginPublicSubmission({
          formId,
          email,
          answers: { [fieldId]: 'Maya' },
          revisionId,
        });

      it('a submit after the address was typed sends nothing and mints nothing', async () => {
        const { formId, revisionId } = await makeOpenForm();
        const fieldId = await nameFieldId(revisionId);
        const email = `reuse-blur-${suite}@example.test`;

        // Exactly the uninterrupted path: leave the email field, then submit.
        const blur = await responseService.beginAddressVerification({ formId, email, revisionId });
        expect(blur.sent).toBe(true);

        const submitted = await beginFor(formId, revisionId, fieldId, email);
        expect(submitted.rawToken).toBeNull();
        expect(submitted.verifyUrl).toBeNull();
        expect(submitted.emails).toHaveLength(0);
        expect(submitted.linkAlreadySentAt).not.toBeNull();

        // One link for the whole journey, and it opens the answers that were
        // just submitted — the placeholder overwrite filled the same row in.
        const row = await rowFor(formId, email);
        expect(await prisma.formMagicToken.count({ where: { response_id: row.id } })).toBe(1);
        const review = await responseService.verifyMagicToken(tokenIn(blur));
        expect(review.response.id).toBe(row.id);
        expect(review.response.answers).toEqual({ [fieldId]: 'Maya' });

        // And it still completes the submission.
        const { response } = await responseService.confirmSubmission(tokenIn(blur));
        expect(response.submission_state).toBe('SUBMITTED');
      });

      it('re-typing the same address does not mint a second link either', async () => {
        const { formId, revisionId } = await makeOpenForm();
        const email = `reuse-retype-${suite}@example.test`;

        await responseService.beginAddressVerification({ formId, email, revisionId });
        const again = await responseService.beginAddressVerification({ formId, email, revisionId });

        expect(again.sent).toBe(false);
        expect(again.emails).toHaveLength(0);
        const row = await rowFor(formId, email);
        expect(await prisma.formMagicToken.count({ where: { response_id: row.id } })).toBe(1);
      });

      /**
       * The three ways a link stops being worth pointing at. Each one has to
       * put the mint back — the one outcome that must never happen is somebody
       * submitting, getting no mail, and holding no live link.
       */
      it('mints afresh once the previous link is spent, expired, or old', async () => {
        const { formId, revisionId } = await makeOpenForm();
        const fieldId = await nameFieldId(revisionId);

        // SPENT.
        const spentEmail = `reuse-spent-${suite}@example.test`;
        const spent = await beginFor(formId, revisionId, fieldId, spentEmail);
        await responseService.confirmSubmission(tokenOf(spent));
        const afterSpent = await beginFor(formId, revisionId, fieldId, spentEmail);
        expect(afterSpent.rawToken).not.toBeNull();
        expect(afterSpent.emails).toHaveLength(1);

        // EXPIRED.
        const deadEmail = `reuse-expired-${suite}@example.test`;
        const dead = await beginFor(formId, revisionId, fieldId, deadEmail);
        await prisma.formMagicToken.updateMany({
          where: { response_id: dead.responseId },
          data: { expires_at: new Date(Date.now() - 1000) },
        });
        expect((await beginFor(formId, revisionId, fieldId, deadEmail)).rawToken).not.toBeNull();

        // OLD: still valid, but past the reuse window — so what it would hand
        // back has less than half its life left. Mint rather than strand.
        const oldEmail = `reuse-old-${suite}@example.test`;
        const old = await beginFor(formId, revisionId, fieldId, oldEmail);
        await prisma.formMagicToken.updateMany({
          where: { response_id: old.responseId },
          data: {
            created_at: new Date(Date.now() - responseService.MAGIC_TOKEN_REUSE_MS - 60_000),
          },
        });
        const renewed = await beginFor(formId, revisionId, fieldId, oldEmail);
        expect(renewed.rawToken).not.toBeNull();
        expect(renewed.emails).toHaveLength(1);
      });

      /**
       * ── THE FOURTH WAY, and the one that stranded somebody ────────────────
       *
       * A token is not a delivery. The three conditions above all describe the
       * TOKEN — unspent, unexpired, young — and every one of them is satisfied
       * by a link whose mail never went out at all. That is not hypothetical:
       * a Trigger run failed with "Template not found", the page had already
       * answered the browser successfully, and four hours later the submit
       * found a pristine token, concluded a live link covered the address, and
       * sent nothing. The applicant could not be sent a link BECAUSE the
       * system believed it already had.
       *
       * Marked by `sendEmailTask`'s `onFailure`, so FAILED means the retries
       * are spent and the message is genuinely never going out.
       */
      it('mints afresh when the previous send is known to have failed', async () => {
        const { formId, revisionId } = await makeOpenForm();
        const fieldId = await nameFieldId(revisionId);
        const email = `reuse-failed-${suite}@example.test`;

        // Blur: the link is minted and dispatched.
        const blur = await responseService.beginAddressVerification({ formId, email, revisionId });
        expect(blur.sent).toBe(true);

        // The dispatch fails, asynchronously, long after the page answered.
        await prisma.formMagicToken.updateMany({
          where: { id: blur.watchTokenId! },
          data: {
            delivery_state: responseService.MAGIC_LINK_SEND_FAILED,
            delivery_detail: 'Resend send failed: Template not found',
          },
        });

        // BOTH paths back in must mint. Re-typing the address is the first
        // chance to recover, and submitting is the one the form's own copy
        // promises ("press Submit — we will try again then").
        const retyped = await responseService.beginAddressVerification({
          formId,
          email,
          revisionId,
        });
        expect(retyped.sent).toBe(true);
        expect(retyped.emails).toHaveLength(1);
        expect(retyped.watchTokenId).not.toBe(blur.watchTokenId);

        // And that fresh token is dispatched with its OWN id, so its own
        // outcome can be written back rather than the dead one's.
        expect(retyped.emails[0].payload.formMagicTokenId).toBe(retyped.watchTokenId);

        // Now fail that one too, and submit.
        await prisma.formMagicToken.updateMany({
          where: { id: retyped.watchTokenId! },
          data: { delivery_state: responseService.MAGIC_LINK_SEND_FAILED },
        });
        const submitted = await beginFor(formId, revisionId, fieldId, email);
        expect(submitted.rawToken).not.toBeNull();
        expect(submitted.emails).toHaveLength(1);
        expect(submitted.linkAlreadySentAt).toBeNull();

        // The link it hands over is real — a fresh mint, not a resurrection of
        // a dead one.
        const review = await responseService.verifyMagicToken(tokenOf(submitted));
        expect(review.response.answers).toEqual({ [fieldId]: 'Maya' });
      });

      /**
       * THE OTHER HALF OF THAT RULE, and the regression it guards.
       *
       * A send dispatched seconds ago has NO delivery state — nothing has been
       * reported about it yet, and nothing will be for a while. If "not known
       * to have succeeded" disqualified reuse, every fresh token would be
       * unreusable and the double-send this whole rule exists to prevent would
       * be back: two mails for one action, seconds apart. Only a KNOWN failure
       * disqualifies.
       */
      it('still reuses a send nothing has been reported about yet', async () => {
        const { formId, revisionId } = await makeOpenForm();
        const fieldId = await nameFieldId(revisionId);
        const email = `reuse-inflight-${suite}@example.test`;

        const blur = await responseService.beginAddressVerification({ formId, email, revisionId });
        const row = await rowFor(formId, email);
        expect(
          await prisma.formMagicToken.findFirstOrThrow({ where: { id: blur.watchTokenId! } })
        ).toMatchObject({ delivery_state: null });

        const submitted = await beginFor(formId, revisionId, fieldId, email);
        expect(submitted.emails).toHaveLength(0);
        expect(submitted.linkAlreadySentAt).not.toBeNull();
        expect(await prisma.formMagicToken.count({ where: { response_id: row.id } })).toBe(1);
      });

      /**
       * A state that is not FAILED is not a failure.
       *
       * The filter is written as "null, or not FAILED" rather than as a list of
       * acceptable states, so a value this build has never heard of — a future
       * provider event, a state added by a later migration — keeps a live link
       * reusable rather than quietly doubling everybody's mail. 'SENT' is the
       * ordinary case and the one that must never regress: it is written by the
       * task on every successful dispatch.
       */
      it('reuses a link the provider accepted, and one in a state it does not know', async () => {
        const { formId, revisionId } = await makeOpenForm();
        const fieldId = await nameFieldId(revisionId);

        for (const state of ['SENT', 'DELIVERED', 'SOMETHING_NEW']) {
          const email = `reuse-${state.toLowerCase()}-${suite}@example.test`;
          const blur = await responseService.beginAddressVerification({
            formId,
            email,
            revisionId,
          });
          await prisma.formMagicToken.updateMany({
            where: { id: blur.watchTokenId! },
            data: { delivery_state: state },
          });

          const submitted = await beginFor(formId, revisionId, fieldId, email);
          expect(submitted.emails, `${state} must stay reusable`).toHaveLength(0);
        }
      });

      /**
       * THE SAFETY NET for somebody who loses the one mail.
       *
       * The reminder sweep is idempotent through the token table — a stage is
       * due when no token was created AFTER `submitted_at + stage`. A suppressed
       * submit moves `submitted_at` to now and adds no token, so the reused link
       * predates the row and the six-hour nudge still fires with a fresh one.
       */
      it('a suppressed submit is still nudged six hours later', async () => {
        const { formId, revisionId } = await makeOpenForm();
        const fieldId = await nameFieldId(revisionId);
        const email = `reuse-nudge-${suite}@example.test`;

        await responseService.beginAddressVerification({ formId, email, revisionId });
        const submitted = await beginFor(formId, revisionId, fieldId, email);
        expect(submitted.rawToken).toBeNull();

        // Wind the row and its link back, as if the sweep were running later.
        const shift = responseService.REMINDER_STAGES_MS[0] + 60_000;
        const back = (at: Date) => new Date(at.getTime() - shift);
        const row = await rowFor(formId, email);
        await prisma.formResponse.update({
          where: { id: row.id },
          data: { submitted_at: back(row.submitted_at) },
        });
        for (const token of await prisma.formMagicToken.findMany({
          where: { response_id: row.id },
        })) {
          await prisma.formMagicToken.update({
            where: { id: token.id },
            data: { created_at: back(token.created_at) },
          });
        }

        const swept = await responseService.remindUnverified();
        expect(swept.emails.some(mail => mail.payload.to === email)).toBe(true);
        expect(await prisma.formMagicToken.count({ where: { response_id: row.id } })).toBe(2);
      });
    });

    /**
     * The cooldown is now a limit on ASKING, not on submitting.
     *
     * Repeating the submit no longer spends the budget at all — the second one
     * reuses the live link — so the only way to reach the ceiling is the resend
     * button, which force-mints because it is the person on the check-email
     * screen saying the mail did not arrive. That is the shape worth pinning:
     * one link for the address, plus `MAX_PER_WINDOW - 1` times of asking
     * again, and then an hour's wait.
     */
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
      /** The check-email screen's "send it again". */
      const askAgain = () =>
        responseService.beginAddressVerification({ formId, email, revisionId, force: true });

      const first = await submit();
      const second = await submit();
      expect(second.mode).toBe('existing');
      // The second submit cost nothing: same row, same link, no mail.
      expect(second.rawToken).toBeNull();
      expect(second.emails).toHaveLength(0);

      // Read from the constant rather than hard-coded: a test that pins the
      // number would have to be edited every time the policy is retuned — which
      // is precisely when you want it still asserting the SHAPE.
      for (let n = 1; n < responseService.MAGIC_TOKEN_MAX_PER_WINDOW; n++) await askAgain();
      expect(await codeOf(askAgain())).toBe(responseService.MAGIC_LINK_COOLDOWN);
      // And a submit in that state is still not an error — it has a live link
      // to point at, which is exactly what the cooldown means.
      await expect(submit()).resolves.toMatchObject({ rawToken: null, emails: [] });

      // The refused send must not have left a token behind.
      expect(first.responseId).toBe(second.responseId);
      expect(await prisma.formMagicToken.count({ where: { response_id: second.responseId } })).toBe(
        responseService.MAGIC_TOKEN_MAX_PER_WINDOW
      );
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
      const confirmed = await responseService.confirmSubmission(tokenOf(first));
      const originalVerifiedAt = confirmed.response.verified_at;

      await new Promise(resolve => setTimeout(resolve, 20));

      const again = await responseService.beginPublicSubmission({
        formId,
        email,
        answers: { [fieldId]: 'Maya Chen' },
        revisionId,
      });
      const edited = await responseService.confirmSubmission(tokenOf(again), {
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
          responseService.confirmSubmission(tokenOf(good), { answers: { unknown: 'x' } })
        )
      ).toBe('FORM_ANSWERS_INVALID');
      // The failed confirm rolled back — the link is still usable.
      await expect(responseService.confirmSubmission(tokenOf(good))).resolves.toBeTruthy();
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
        tokens.push(tokenOf(begun));
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

      /**
       * The row lock serializes them, and reuse is decided INSIDE it — so the
       * first one through mints and the other five find that link and stand
       * down. Nobody is refused (a cooldown for pressing Submit twice would be
       * a bad way to meet a form) and the mailbox gets exactly one message.
       */
      const fulfilled = outcomes.filter(outcome => outcome.status === 'fulfilled');
      expect(fulfilled).toHaveLength(6);
      const minted = fulfilled.filter(
        outcome =>
          (outcome as PromiseFulfilledResult<{ rawToken: string | null }>).value.rawToken !== null
      );
      expect(minted).toHaveLength(1);
      expect(await prisma.formMagicToken.count({ where: { response_id: rows[0].id } })).toBe(1);
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

    /**
     * THE STAFF READ CARRIES NO CREDENTIAL.
     *
     * `draft_token` is the cookie value that resumes an anonymous half-filled
     * form — a bearer credential for someone else's submission. It used to ride
     * on every row this returns, kept out of actual responses only because each
     * consumer hand-wrote an allowlist on the way out (the web's
     * `toResponseRow`, the MCP's `responseSummary`). That is one rule enforced by
     * discipline in two places, and a third consumer added later inherits none
     * of it.
     *
     * Asserted against the DATABASE, not against a shape: the row is created
     * WITH a draft token, and the read still must not have one.
     */
    it('never returns draft_token or email_normalized, whatever the caller does', async () => {
      const { formId, revisionId } = await makeOpenForm();
      const fieldId = await nameFieldId(revisionId);
      await formService.update(formId, { save_partials: true });

      const token = randomUUID();
      await responseService.upsertDraft({
        formId,
        revisionId,
        draftToken: token,
        email: `formtest-${suite}-tokened@example.test`,
        answers: { [fieldId]: 'a partial answer' },
      });

      // The token really is on the row — otherwise the assertions below would
      // pass against a fixture that had nothing to leak.
      const stored = await prisma.formResponse.findFirstOrThrow({ where: { form_id: formId } });
      expect(stored.draft_token).toBe(token);
      expect(stored.email_normalized).toBe(`formtest-${suite}-tokened@example.test`);

      const [row] = await responseService.listByFormId(formId);
      expect(row).not.toHaveProperty('draft_token');
      expect(row).not.toHaveProperty('email_normalized');
      expect(JSON.stringify(row)).not.toContain(token);

      // Everything the staff surfaces and the CSV export actually read is still
      // there — a select that dropped a needed column would be the worse bug.
      for (const column of [
        'id',
        'form_id',
        'revision_id',
        'user_id',
        'email',
        'name',
        'answers',
        'resolved_context',
        'submission_state',
        'verified_at',
        'staff_status',
        'staff_note',
        'submitted_at',
        'updated_at',
      ]) {
        expect(row, column).toHaveProperty(column);
      }
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
      // And the ANSWERS survive too. Preserving only the state would leave a
      // row marked SUBMITTED holding a half-typed answer set — this is the
      // race a debounced autosave loses against its own submit.
      expect((after.answers as Record<string, unknown>)[fieldId]).toBe('Final');
    });

    it('a draft save leaves a PENDING_VERIFICATION row alone as well', async () => {
      const { formId, revisionId } = await makeOpenForm();
      const fieldId = await nameFieldId(revisionId);
      const email = `pending-draft-${suite}@example.test`;

      await responseService.beginPublicSubmission({
        formId,
        email,
        answers: { [fieldId]: 'Submitted, awaiting the link' },
        revisionId,
      });

      // Keyed by draft token, so this is a DIFFERENT row — the point is the one
      // that would collide: the public path autosaves under the same user once
      // a response is verified, and an unverified row must not be writable
      // either. Reached here through the same guard.
      const pending = await getPrisma().formResponse.findFirstOrThrow({
        where: { form_id: formId, email_normalized: email },
      });
      await getPrisma().formResponse.update({
        where: { id: pending.id },
        data: { user_id: studentBId },
      });

      const after = await responseService.upsertDraft({
        formId,
        revisionId,
        userId: studentBId,
        email,
        answers: { [fieldId]: 'Still typing' },
      });
      expect(after.submission_state).toBe('PENDING_VERIFICATION');
      expect((after.answers as Record<string, unknown>)[fieldId]).toBe(
        'Submitted, awaiting the link'
      );
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
      await responseService.confirmSubmission(tokenOf(verified));
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

  // ── Verifying the ADDRESS early ──────────────────────────────────────────

  describe('early address verification', () => {
    it('typing an address stores a placeholder and mails a link', async () => {
      const { formId, revisionId } = await makeOpenForm();
      const email = `early-${suite}@example.test`;

      const result = await responseService.beginAddressVerification({
        formId,
        email,
        name: 'Maya',
        revisionId,
      });

      expect(result.sent).toBe(true);
      expect(result.emails).toHaveLength(1);
      expect(result.emails[0].payload.template.id).toBe('form-verify-link');
      expect(result.emails[0].payload.to).toBe(email);

      const row = await rowFor(formId, email);
      // A slot held, and nothing else: no answers, nothing verified, nothing
      // visible to the cap.
      expect(row.submission_state).toBe('PENDING_VERIFICATION');
      expect(row.answers).toEqual({});
      expect(row.verified_at).toBeNull();
      expect(await prisma.formMagicToken.count({ where: { response_id: row.id } })).toBe(1);
    });

    it('the submit that follows fills the placeholder in and takes its position then', async () => {
      const { formId, revisionId } = await makeOpenForm();
      const fieldId = await nameFieldId(revisionId);
      const email = `early-fill-${suite}@example.test`;

      await responseService.beginAddressVerification({ formId, email, revisionId });
      const placeholder = await rowFor(formId, email);

      await new Promise(resolve => setTimeout(resolve, 25));
      await responseService.beginPublicSubmission({
        formId,
        email,
        name: 'Maya',
        answers: { [fieldId]: 'Maya' },
        revisionId,
      });

      // ONE row — the placeholder, filled in. A second would mean the address
      // slot had been lost, and the person would hold two half-responses.
      const rows = await prisma.formResponse.findMany({ where: { form_id: formId } });
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(placeholder.id);
      expect(rows[0].answers).toEqual({ [fieldId]: 'Maya' });
      // The FIFO position is the SUBMISSION, not the moment an address was
      // typed — otherwise opening a form early would buy a place in the queue.
      expect(rows[0].submitted_at.getTime()).toBeGreaterThan(placeholder.submitted_at.getTime());
    });

    it('answers already on an unverified row are never overwritten', async () => {
      const { formId, revisionId } = await makeOpenForm();
      const fieldId = await nameFieldId(revisionId);
      const email = `early-vandal-${suite}@example.test`;

      await responseService.beginPublicSubmission({
        formId,
        email,
        answers: { [fieldId]: 'The real applicant' },
        revisionId,
      });
      // Anyone can type anyone's address. The worst they may achieve is mailing
      // that person a link — never replacing what they wrote.
      await responseService.beginPublicSubmission({
        formId,
        email,
        answers: { [fieldId]: 'Vandalism' },
        revisionId,
      });

      expect((await rowFor(formId, email)).answers).toEqual({ [fieldId]: 'The real applicant' });
    });

    it('an address that already responded is not mailed — unless it asks', async () => {
      const { formId, revisionId } = await makeOpenForm();
      const fieldId = await nameFieldId(revisionId);
      const email = `early-done-${suite}@example.test`;

      const begun = await responseService.beginPublicSubmission({
        formId,
        email,
        answers: { [fieldId]: 'Maya' },
        revisionId,
      });
      await responseService.confirmSubmission(tokenOf(begun));

      const quiet = await responseService.beginAddressVerification({ formId, email, revisionId });
      expect(quiet.sent).toBe(false);
      expect(quiet.emails).toHaveLength(0);

      // …and the resend button, which is the person themselves asking.
      const asked = await responseService.beginAddressVerification({
        formId,
        email,
        revisionId,
        force: true,
      });
      expect(asked.sent).toBe(true);
      expect(asked.emails).toHaveLength(1);

      // Neither call touched the stored answers.
      expect((await rowFor(formId, email)).answers).toEqual({ [fieldId]: 'Maya' });
    });

    it('opening the link before submitting verifies the address and does not spend it', async () => {
      const { formId, revisionId } = await makeOpenForm();
      const email = `early-open-${suite}@example.test`;

      const sent = await responseService.beginAddressVerification({ formId, email, revisionId });
      const rawToken = tokenIn(sent);

      const first = await responseService.verifyAddressByToken(rawToken);
      expect(first.verifiedAt).toBeInstanceOf(Date);

      // Idempotent, and NOT consumed — a mail scanner opening the link ahead of
      // the human must not leave them holding a spent one.
      const again = await responseService.verifyAddressByToken(rawToken);
      expect(again.verifiedAt.getTime()).toBe(first.verifiedAt.getTime());
      const after = await prisma.formMagicToken.findUniqueOrThrow({
        where: { token_hash: responseService.hashToken(rawToken) },
      });
      expect(after.used_at).toBeNull();

      // Still not a submission: verified, but holding no answers and no slot.
      const verified = await rowFor(formId, email);
      expect(verified.submission_state).toBe('PENDING_VERIFICATION');
      expect(verified.verified_at).not.toBeNull();

      // Coming back to the form and tabbing past the address again sends
      // nothing: there is nothing left to prove, and the browser already holds
      // the link. Noise for the recipient, and a wasted slice of the cooldown.
      const again2 = await responseService.beginAddressVerification({
        formId,
        email,
        revisionId,
      });
      expect(again2.sent).toBe(false);
      expect(again2.emails).toHaveLength(0);
    });

    it('confirming a placeholder is refused rather than filed as an empty response', async () => {
      const { formId, revisionId } = await makeOpenForm();
      const email = `early-empty-${suite}@example.test`;

      const sent = await responseService.beginAddressVerification({ formId, email, revisionId });

      expect(await codeOf(responseService.confirmSubmission(tokenIn(sent)))).toBe(
        'FORM_NOT_SUBMITTED_YET'
      );
      expect((await rowFor(formId, email)).submission_state).toBe('PENDING_VERIFICATION');
    });

    // ── The binding ────────────────────────────────────────────────────────

    describe('one-round-trip submit', () => {
      /** A form, an address verified early, and the raw token that proved it. */
      const verifiedSetup = async (label: string) => {
        const { formId, revisionId } = await makeOpenForm();
        const fieldId = await nameFieldId(revisionId);
        const email = `bound-${label}-${suite}@example.test`;
        const sent = await responseService.beginAddressVerification({ formId, email, revisionId });
        const rawToken = tokenIn(sent);
        await responseService.verifyAddressByToken(rawToken);
        return { formId, revisionId, fieldId, email, rawToken };
      };

      it('records the response and spends the link', async () => {
        const { formId, revisionId, fieldId, email, rawToken } = await verifiedSetup('ok');

        const response = await responseService.submitVerifiedPublic({
          rawToken,
          formId,
          email,
          name: 'Maya',
          answers: { [fieldId]: 'Maya' },
          revisionId,
        });

        expect(response.submission_state).toBe('SUBMITTED');
        expect(response.verified_at).not.toBeNull();
        expect(response.answers).toEqual({ [fieldId]: 'Maya' });

        const token = await prisma.formMagicToken.findUniqueOrThrow({
          where: { token_hash: responseService.hashToken(rawToken) },
        });
        expect(token.used_at).not.toBeNull();
      });

      /**
       * THE BINDING.
       *
       * Verification is a property of the (form, address) pair, and the row is
       * found FROM THE TOKEN. So a caller holding a perfectly good token for
       * one address cannot submit under another: the addresses are compared,
       * they differ, and the request falls back to the ordinary flow. There is
       * no flag to forge and no id to swap — this is the whole attack surface
       * of the shortcut, and it is one string equality over server-read values.
       */
      it('a verified link cannot be used to submit under a different address', async () => {
        const { formId, revisionId, fieldId, rawToken } = await verifiedSetup('other');

        expect(
          await codeOf(
            responseService.submitVerifiedPublic({
              rawToken,
              formId,
              email: `victim-${suite}@example.test`,
              answers: { [fieldId]: 'Not Me' },
              revisionId,
            })
          )
        ).toBe('MAGIC_LINK_NOT_BOUND');

        // Nothing was written under either address.
        expect(
          await prisma.formResponse.count({
            where: { form_id: formId, submission_state: 'SUBMITTED' },
          })
        ).toBe(0);
        expect(
          await prisma.formResponse.findFirst({
            where: { form_id: formId, email_normalized: `victim-${suite}@example.test` },
          })
        ).toBeNull();
      });

      it("a link for another form does not bind, whoever's it is", async () => {
        const { rawToken } = await verifiedSetup('crossform');
        const other = await makeOpenForm();
        const otherField = await nameFieldId(other.revisionId);

        expect(
          await codeOf(
            responseService.submitVerifiedPublic({
              rawToken,
              formId: other.formId,
              email: `bound-crossform-${suite}@example.test`,
              answers: { [otherField]: 'Maya' },
              revisionId: other.revisionId,
            })
          )
        ).toBe('MAGIC_LINK_NOT_BOUND');
      });

      /**
       * TWO DEVICES, and the row gets there first.
       *
       * Verify the address on a phone, then submit the form from the laptop
       * that still holds the cookie — but in between, the response is submitted
       * and confirmed through the ordinary two-step flow. The laptop's token is
       * still live, still bound to the same address, and the row is now
       * SUBMITTED and counted.
       *
       * That is an EDIT, and the `counted` branch is the only place in this
       * service that says so about a public one-round-trip write: the answers
       * are replaced, the cap is not re-entered, and — the part a FIFO waitlist
       * cares about — neither `verified_at` nor `submitted_at` moves, so
       * changing an answer never costs somebody their place in the queue.
       */
      it('a live cookie on a response that got submitted elsewhere is an edit', async () => {
        const { formId, revisionId, fieldId, email, rawToken } = await verifiedSetup('elsewhere');

        /**
         * The other device: an ordinary submission, and a link of its own.
         *
         * The submit itself mints nothing — the address already holds the live
         * link the laptop is sitting on — so the phone gets its second link the
         * only way a second link is ever handed out: by asking for it on the
         * check-email screen. Which is exactly how somebody ends up holding two
         * live links for one response, and therefore the honest way to set this
         * scenario up.
         */
        const begun = await responseService.beginPublicSubmission({
          formId,
          email,
          answers: { [fieldId]: 'From the phone' },
          revisionId,
        });
        expect(begun.rawToken).toBeNull();
        const phone = await responseService.beginAddressVerification({
          formId,
          email,
          revisionId,
          force: true,
        });
        await responseService.confirmSubmission(tokenIn(phone));
        const counted = await prisma.formResponse.findUniqueOrThrow({
          where: { id: begun.responseId },
        });
        expect(counted.submission_state).toBe('SUBMITTED');

        const edited = await responseService.submitVerifiedPublic({
          rawToken,
          formId,
          email,
          answers: { [fieldId]: 'From the laptop' },
          revisionId,
        });

        expect(edited.id).toBe(counted.id);
        expect(edited.answers).toEqual({ [fieldId]: 'From the laptop' });
        // The place in the queue is untouched, in both of the columns that
        // decide it.
        expect(edited.verified_at?.getTime()).toBe(counted.verified_at?.getTime());
        expect(edited.submitted_at.getTime()).toBe(counted.submitted_at.getTime());
        // Still exactly one response, still counted exactly once.
        expect(
          await prisma.formResponse.count({
            where: { form_id: formId, submission_state: 'SUBMITTED', verified_at: { not: null } },
          })
        ).toBe(1);
        // And the link it rode in on is spent.
        expect(
          (
            await prisma.formMagicToken.findUniqueOrThrow({
              where: { token_hash: responseService.hashToken(rawToken) },
            })
          ).used_at
        ).not.toBeNull();
      });

      it('a link that was never opened does not bind', async () => {
        const { formId, revisionId } = await makeOpenForm();
        const fieldId = await nameFieldId(revisionId);
        const email = `bound-unopened-${suite}@example.test`;
        const sent = await responseService.beginAddressVerification({ formId, email, revisionId });

        // Minted and mailed, but nobody clicked it — `verified_at` is null, so
        // the shortcut is not available and the ordinary flow still applies.
        expect(
          await codeOf(
            responseService.submitVerifiedPublic({
              rawToken: tokenIn(sent),
              formId,
              email,
              answers: { [fieldId]: 'Maya' },
              revisionId,
            })
          )
        ).toBe('MAGIC_LINK_NOT_BOUND');
      });

      it('a spent link does not bind a second time', async () => {
        const { formId, revisionId, fieldId, email, rawToken } = await verifiedSetup('spent');
        await responseService.submitVerifiedPublic({
          rawToken,
          formId,
          email,
          answers: { [fieldId]: 'Maya' },
          revisionId,
        });

        expect(
          await codeOf(
            responseService.submitVerifiedPublic({
              rawToken,
              formId,
              email,
              answers: { [fieldId]: 'Changed' },
              revisionId,
            })
          )
        ).toBe('MAGIC_LINK_NOT_BOUND');
      });

      it('a verified placeholder still has to pass the cap', async () => {
        const { formId, revisionId } = await makeOpenForm({ response_cap: 1 });
        const fieldId = await nameFieldId(revisionId);

        // Someone else fills the only slot.
        const taken = await responseService.beginPublicSubmission({
          formId,
          email: `cap-taken-${suite}@example.test`,
          answers: { [fieldId]: 'First' },
          revisionId,
        });
        await responseService.confirmSubmission(tokenOf(taken));

        const email = `cap-late-${suite}@example.test`;
        const sent = await responseService.beginAddressVerification({ formId, email, revisionId });
        const rawToken = tokenIn(sent);
        await responseService.verifyAddressByToken(rawToken);

        // `verified_at` is set, and it buys nothing: the row was never counted,
        // so this is a first entry into the cap and the cap is full.
        expect(
          await codeOf(
            responseService.submitVerifiedPublic({
              rawToken,
              formId,
              email,
              answers: { [fieldId]: 'Late' },
              revisionId,
            })
          )
        ).toBe('FORM_CAP_REACHED');
      });
    });
  });

  // ── FIFO ─────────────────────────────────────────────────────────────────

  describe('queue position', () => {
    /**
     * THE SLOW INBOX.
     *
     * Two people, one slot. The first submits at t0, the second at t1 — and the
     * second's mail arrives first, so they confirm first. Before the
     * reservation rule that simply handed them the slot and told the earlier
     * person the form had filled up, which made a waitlist a race between mail
     * servers rather than a queue.
     */
    it('the earlier submission holds the slot even when the later one verifies first', async () => {
      const { formId, revisionId } = await makeOpenForm({ response_cap: 1 });
      const fieldId = await nameFieldId(revisionId);

      const early = await responseService.beginPublicSubmission({
        formId,
        email: `fifo-early-${suite}@example.test`,
        answers: { [fieldId]: 'Early' },
        revisionId,
      });
      await new Promise(resolve => setTimeout(resolve, 25));
      const late = await responseService.beginPublicSubmission({
        formId,
        email: `fifo-late-${suite}@example.test`,
        answers: { [fieldId]: 'Late' },
        revisionId,
      });

      // The LATER submission gets to the link first, and is turned away —
      // somebody who submitted before them is still inside the window.
      expect(await codeOf(responseService.confirmSubmission(tokenOf(late)))).toBe(
        'FORM_CAP_REACHED'
      );

      const { response } = await responseService.confirmSubmission(tokenOf(early));
      expect(response.submission_state).toBe('SUBMITTED');

      const submitted = await prisma.formResponse.findMany({
        where: { form_id: formId, submission_state: 'SUBMITTED' },
      });
      expect(submitted).toHaveLength(1);
      expect(submitted[0].email).toBe(`fifo-early-${suite}@example.test`);
    });

    it('an unverified row stops holding a place once its window closes', async () => {
      const { formId, revisionId } = await makeOpenForm({ response_cap: 1 });
      const fieldId = await nameFieldId(revisionId);

      const stale = await responseService.beginPublicSubmission({
        formId,
        email: `fifo-stale-${suite}@example.test`,
        answers: { [fieldId]: 'Stale' },
        revisionId,
      });
      await new Promise(resolve => setTimeout(resolve, 25));
      const fresher = await responseService.beginPublicSubmission({
        formId,
        email: `fifo-fresher-${suite}@example.test`,
        answers: { [fieldId]: 'Fresher' },
        revisionId,
      });

      // Submitted three days ago and still holding a perfectly good link — the
      // kind a reminder mints. The window is measured from the SUBMISSION, so a
      // renewable token cannot renew a reservation forever.
      await prisma.formResponse.update({
        where: { id: stale.responseId },
        data: { submitted_at: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) },
      });

      const { response: fresherResponse } = await responseService.confirmSubmission(
        tokenOf(fresher)
      );
      expect(fresherResponse.submission_state).toBe('SUBMITTED');
    });

    it('an unverified row whose link has expired stops holding a place', async () => {
      const { formId, revisionId } = await makeOpenForm({ response_cap: 1 });
      const fieldId = await nameFieldId(revisionId);

      const abandoned = await responseService.beginPublicSubmission({
        formId,
        email: `fifo-abandoned-${suite}@example.test`,
        answers: { [fieldId]: 'Abandoned' },
        revisionId,
      });
      await new Promise(resolve => setTimeout(resolve, 25));
      const later = await responseService.beginPublicSubmission({
        formId,
        email: `fifo-later-${suite}@example.test`,
        answers: { [fieldId]: 'Later' },
        revisionId,
      });

      // A reservation is a promise for the length of the window, not forever.
      await prisma.formMagicToken.updateMany({
        where: { response_id: abandoned.responseId },
        data: { expires_at: new Date(Date.now() - 1000) },
      });

      const { response } = await responseService.confirmSubmission(tokenOf(later));
      expect(response.submission_state).toBe('SUBMITTED');
    });

    it('a placeholder nobody has submitted through reserves nothing', async () => {
      const { formId, revisionId } = await makeOpenForm({ response_cap: 1 });
      const fieldId = await nameFieldId(revisionId);

      // Somebody typed an address into the form and walked away. It must not
      // cost the next person the last slot.
      await responseService.beginAddressVerification({
        formId,
        email: `fifo-placeholder-${suite}@example.test`,
        revisionId,
      });
      await new Promise(resolve => setTimeout(resolve, 25));

      const real = await responseService.beginPublicSubmission({
        formId,
        email: `fifo-real-${suite}@example.test`,
        answers: { [fieldId]: 'Real' },
        revisionId,
      });
      const { response } = await responseService.confirmSubmission(tokenOf(real));
      expect(response.submission_state).toBe('SUBMITTED');
    });
  });

  // ── Reminders ────────────────────────────────────────────────────────────

  describe('unverified reminders', () => {
    /**
     * Move a response and everything that has happened to it `ms` further into
     * the past, as if the sweep were running that much later.
     *
     * RELATIVE, not absolute, and that is the whole point: the idempotence rule
     * compares a token's age against the response's, so stamping them all with
     * one timestamp would collapse "the reminder we already sent" onto "the
     * moment they submitted" and make every stage look unserved again. Time
     * passing moves everything together.
     */
    const age = async (responseId: string, ms: number) => {
      const row = await prisma.formResponse.findUniqueOrThrow({ where: { id: responseId } });
      await prisma.formResponse.update({
        where: { id: responseId },
        data: {
          submitted_at: new Date(row.submitted_at.getTime() - ms),
          created_at: new Date(row.created_at.getTime() - ms),
        },
      });
      for (const token of await prisma.formMagicToken.findMany({
        where: { response_id: responseId },
      })) {
        await prisma.formMagicToken.update({
          where: { id: token.id },
          data: {
            created_at: new Date(token.created_at.getTime() - ms),
            expires_at: new Date(token.expires_at.getTime() - ms),
          },
        });
      }
    };

    const SIX_HOURS = 6 * 60 * 60 * 1000;
    const ONE_DAY = 24 * 60 * 60 * 1000;

    /** Only this suite's rows — the sweep is global by design. */
    const mine = (result: {
      emails: Array<{ payload: { to: string; template: { id: string } } }>;
    }) => result.emails.filter(email => email.payload.to.includes(suite));

    it('nudges a six-hour-old unverified submission exactly once', async () => {
      const { formId, revisionId } = await makeOpenForm();
      const fieldId = await nameFieldId(revisionId);
      const begun = await responseService.beginPublicSubmission({
        formId,
        email: `remind-six-${suite}@example.test`,
        answers: { [fieldId]: 'Maya' },
        revisionId,
      });
      await age(begun.responseId, SIX_HOURS + 60_000);

      const first = mine(await responseService.remindUnverified());
      expect(first).toHaveLength(1);
      expect(first[0].payload.template.id).toBe('form-verify-reminder');
      expect(first[0].payload.to).toBe(`remind-six-${suite}@example.test`);

      // IDEMPOTENT. The token the first pass minted is dated after the stage
      // boundary, which IS the record that the stage has been served — so a
      // second run finds nothing due, with no column tracking it.
      expect(mine(await responseService.remindUnverified())).toHaveLength(0);
    });

    it('nudges again at twenty-four hours, and then stops', async () => {
      const { formId, revisionId } = await makeOpenForm();
      const fieldId = await nameFieldId(revisionId);
      const begun = await responseService.beginPublicSubmission({
        formId,
        email: `remind-day-${suite}@example.test`,
        answers: { [fieldId]: 'Maya' },
        revisionId,
      });

      await age(begun.responseId, SIX_HOURS + 60_000);
      expect(mine(await responseService.remindUnverified())).toHaveLength(1);

      // Another day goes by. The six-hour nudge ages with everything else, so
      // it no longer sits after the twenty-four-hour boundary — which is what
      // makes the second stage due exactly once.
      await age(begun.responseId, ONE_DAY);
      expect(mine(await responseService.remindUnverified())).toHaveLength(1);
      expect(mine(await responseService.remindUnverified())).toHaveLength(0);

      // No third stage. Somebody who has ignored two mails has answered.
      await age(begun.responseId, 3 * ONE_DAY);
      expect(mine(await responseService.remindUnverified())).toHaveLength(0);
    });

    it('leaves alone what is not waiting on a click', async () => {
      const { formId, revisionId } = await makeOpenForm();
      const fieldId = await nameFieldId(revisionId);

      // Too young.
      await responseService.beginPublicSubmission({
        formId,
        email: `remind-fresh-${suite}@example.test`,
        answers: { [fieldId]: 'Fresh' },
        revisionId,
      });

      // Already verified — there is nothing left for them to do.
      const done = await responseService.beginPublicSubmission({
        formId,
        email: `remind-done-${suite}@example.test`,
        answers: { [fieldId]: 'Done' },
        revisionId,
      });
      await responseService.confirmSubmission(tokenOf(done));
      await age(done.responseId, 2 * ONE_DAY);

      // An address somebody typed and abandoned. No entry, so "finish your
      // entry" is not a sentence we get to send — and the address may not even
      // belong to whoever typed it.
      const placeholder = await responseService.beginAddressVerification({
        formId,
        email: `remind-placeholder-${suite}@example.test`,
        revisionId,
      });
      expect(placeholder.sent).toBe(true);
      const placeholderRow = await prisma.formResponse.findFirstOrThrow({
        where: { form_id: formId, email_normalized: `remind-placeholder-${suite}@example.test` },
      });
      await age(placeholderRow.id, 2 * ONE_DAY);

      expect(mine(await responseService.remindUnverified())).toHaveLength(0);
    });

    it('says nothing about a form that has closed', async () => {
      const { formId, revisionId } = await makeOpenForm();
      const fieldId = await nameFieldId(revisionId);
      const begun = await responseService.beginPublicSubmission({
        formId,
        email: `remind-closed-${suite}@example.test`,
        answers: { [fieldId]: 'Maya' },
        revisionId,
      });
      await age(begun.responseId, ONE_DAY + 60_000);
      await prisma.form.update({ where: { id: formId }, data: { status: 'CLOSED' } });

      expect(mine(await responseService.remindUnverified())).toHaveLength(0);
    });
  });

  // ── Retention ────────────────────────────────────────────────────────────

  describe('unverified rows are not deleted quietly', () => {
    it('an unverified row outlives its link by weeks, and a staff label keeps it', async () => {
      const { formId, revisionId } = await makeOpenForm();
      const fieldId = await nameFieldId(revisionId);

      const threeDays = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
      const forever = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);

      const recent = await responseService.beginPublicSubmission({
        formId,
        email: `retain-recent-${suite}@example.test`,
        answers: { [fieldId]: 'Recent' },
        revisionId,
      });
      await prisma.formResponse.update({
        where: { id: recent.responseId },
        data: { created_at: threeDays },
      });

      const labelled = await responseService.beginPublicSubmission({
        formId,
        email: `retain-labelled-${suite}@example.test`,
        answers: { [fieldId]: 'Labelled' },
        revisionId,
      });
      await prisma.formResponse.update({
        where: { id: labelled.responseId },
        data: { created_at: forever },
      });
      await responseService.updateStaff({
        responseId: labelled.responseId,
        staff_status: 'chased',
      });

      await responseService.expireStale();

      const survivors = (
        await prisma.formResponse.findMany({ where: { form_id: formId }, select: { id: true } })
      ).map(row => row.id);

      // Three days old, its link long dead — and still on the responses page,
      // because "somebody tried and did not finish" is information the
      // instructor is entitled to. It used to be deleted at 48 hours.
      expect(survivors).toContain(recent.responseId);
      // Ninety days old, and kept anyway: a staff member wrote something on it.
      expect(survivors).toContain(labelled.responseId);
    });
  });

  // ── Tier-1 option sourcing ───────────────────────────────────────────────

  describe('roster materialization at publish', () => {
    /** A roster field, minus the options publish is supposed to supply. */
    const rosterField = (patch: Record<string, unknown> = {}) => ({
      type: 'roster_select',
      label: 'Who would you like to work with?',
      optionSource: 'roster',
      ...patch,
    });

    /** The materialized options of the Nth roster field on a revision. */
    const rosterOptions = async (revisionId: string, index = 0) => {
      const revision = await prisma.formRevision.findUniqueOrThrow({ where: { id: revisionId } });
      const fields = formService
        .fieldsOf(revision.fields)
        .flatMap(field =>
          field.type === 'repeat_group' ? ((field.fields as (typeof field)[]) ?? []) : [field]
        )
        .filter(field => field.type === 'roster_select');
      return (fields[index]?.options ?? []) as Array<{ id: string; label: string }>;
    };

    beforeAll(async () => {
      await prisma.classroomMembership.createMany({
        data: [
          { classroom_id: classroomId, user_id: studentAId, role: 'STUDENT' },
          { classroom_id: classroomId, user_id: studentBId, role: 'STUDENT' },
          { classroom_id: classroomId, user_id: ownerId, role: 'OWNER' },
          // The same person twice on the teaching team. Dual-role memberships
          // are ordinary in this product (the seeded dev owner is OWNER and
          // ASSISTANT and STUDENT), and two options sharing an id is a
          // definition the contract rejects.
          { classroom_id: classroomId, user_id: ownerId, role: 'ASSISTANT' },
        ],
        skipDuplicates: true,
      });
    });

    it('freezes the live roster into the revision as {id: user_id, label}', async () => {
      const form = await makeForm({ access: 'CLASSROOM', fields: [rosterField()] });
      const { revision } = await formService.publish(form.id);

      const options = await rosterOptions(revision.id);
      expect(options.map(option => option.id).sort()).toEqual([studentAId, studentBId].sort());
      // "Form Test a (formtest-<suite>-a)" — name plus login, so two students
      // called Alex stay distinguishable.
      expect(options.every(option => option.label.startsWith('Form Test'))).toBe(true);
      expect(options[0].label).toMatch(/\(formtest-.+\)$/);
    });

    it('sources the teaching team as OWNER | TEACHER | ASSISTANT, deduped by person', async () => {
      const form = await makeForm({
        access: 'CLASSROOM',
        fields: [rosterField({ optionSource: 'teaching_team', label: 'Pick a TA' })],
      });
      const { revision } = await formService.publish(form.id);

      const options = await rosterOptions(revision.id);
      expect(options).toHaveLength(1);
      expect(options[0].id).toBe(ownerId);
    });

    it('leaves the draft empty and re-materializes on the next publish', async () => {
      const form = await makeForm({ access: 'CLASSROOM', fields: [rosterField()] });
      const first = await formService.publish(form.id);
      expect(await rosterOptions(first.revision.id)).toHaveLength(2);

      // The DRAFT never holds a roster: it is not what the author wrote.
      const draftFields = formService.fieldsOf(
        (await prisma.form.findUniqueOrThrow({ where: { id: form.id } })).draft_fields
      );
      expect(draftFields[0].options).toEqual([]);

      const latecomer = await makeUser('latecomer');
      await prisma.classroomMembership.create({
        data: { classroom_id: classroomId, user_id: latecomer, role: 'STUDENT' },
      });

      const second = await formService.publish(form.id);
      const options = await rosterOptions(second.revision.id);
      expect(options.map(option => option.id)).toContain(latecomer);
      expect(options).toHaveLength(3);

      // The FIRST revision is untouched — a response filed against it still
      // reads back with the roster the person actually saw.
      expect(await rosterOptions(first.revision.id)).toHaveLength(2);
    });

    it('materializes a roster field nested in a repeat group', async () => {
      const form = await makeForm({
        access: 'CLASSROOM',
        fields: [
          {
            type: 'repeat_group',
            label: 'Review each teammate',
            repeat: { over: 'teammates', scope: { by: 'classroom' } },
            fields: [rosterField({ label: 'Who else did they work with?', multiple: true })],
          },
        ],
      });
      const { revision } = await formService.publish(form.id);
      expect(await rosterOptions(revision.id).then(options => options.length)).toBeGreaterThan(0);
    });

    it('accepts a materialized user id at submit and refuses a stranger', async () => {
      const form = await makeForm({
        access: 'CLASSROOM',
        fields: [rosterField({ required: true })],
      });
      const { revision } = await formService.publish(form.id);
      const fieldId = formService.fieldsOf(revision.fields)[0].id;

      const submit = (userId: string, choice: string) =>
        responseService.submitClassroom({
          formId: form.id,
          userId,
          email: `formtest-${suite}-a@example.test`,
          answers: { [fieldId]: choice },
          revisionId: revision.id,
        });

      await expect(submit(studentAId, studentBId)).resolves.toMatchObject({
        submission_state: 'SUBMITTED',
      });
      // Nothing special guards this — the materialized options ARE the option
      // set the contract's `oneOf` is built from, so an id nobody on the roster
      // holds is simply not an option.
      expect(await codeOf(submit(studentBId, randomUUID()))).toBe('FORM_ANSWERS_INVALID');
    });

    it('refuses to publish a roster field on a PUBLIC form', async () => {
      const form = await makeForm({ access: 'PUBLIC' });
      // Written straight to the column: `update` already refuses this, and the
      // point here is that PUBLISH refuses it too — a draft written before the
      // mode was settled must not become live under it.
      await prisma.form.update({
        where: { id: form.id },
        data: {
          draft_fields: {
            definition_version: 1,
            fields: [{ ...rosterField(), id: randomUUID(), required: false, options: [] }],
          },
        },
      });

      expect(await codeOf(formService.publish(form.id))).toBe('FORM_FIELD_ACCESS_VIOLATION');
      const published = await prisma.form.findUniqueOrThrow({ where: { id: form.id } });
      expect(published.status).toBe('DRAFT');
      expect(published.current_revision_id).toBeNull();
    });
  });
});
