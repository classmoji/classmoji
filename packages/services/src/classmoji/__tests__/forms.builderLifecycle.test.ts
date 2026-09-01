/**
 * The BUILDER'S lifecycle, against a real Postgres, driven with the exact
 * payload shapes the apps/pages routes send.
 *
 * `forms.integration.test.ts` covers the services on their own terms. This file
 * covers the sequence the admin UI actually performs, in order, because that is
 * where a route can be wrong while every service is right:
 *
 *   New Form drawer   → create({ ..., fields: <preset field list> })
 *   Save draft        → update(id, { fields: <the list read back from storage> })
 *   Publish           → publish(id)                                  → revision 1
 *   Tri-state select  → quickUpdate(id, { status })                  → CLOSED / OPEN
 *   Publish new       → quickUpdate(DRAFT) → update({fields}) → publish()  → revision 2
 *
 * Two properties are load-bearing and neither is visible from a single service
 * call:
 *
 *  - THE ROUND TRIP. The builder edits the NORMALIZED definition — the value
 *    `parseFormDefinition` produced and the database stored — and posts it
 *    back. Field ids must survive that, because answers key on them: a builder
 *    that sent its own pre-parse shape would mint new ids on every save and
 *    orphan every response collected so far. Parsing the same RAW input twice
 *    deliberately yields different ids, so "it round-trips" is a claim about
 *    what the route sends, not about the contract.
 *
 *  - THE NEW-VERSION DANCE. `update` refuses a field list on a non-DRAFT form
 *    (FORM_NOT_DRAFT), so editing a live form is not "save then publish". It is
 *    quickUpdate(DRAFT) → update → publish, run server-side in ONE action so a
 *    failure between the steps cannot strand an OPEN form in DRAFT.
 *
 * SAFETY: fixtures are namespaced with a fresh uuid and torn down by deleting
 * the git organization, which cascades. Nothing pre-existing is touched.
 * Skipped unless DATABASE_URL names a local, non-shared database — same guard
 * as the sibling integration suite.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';

import getPrisma from '@classmoji/database';
import * as formService from '../form.service.ts';
import { type FormField } from '../formContract.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
const isSharedDevDb = /\/classmoji(\?|$)/.test(DATABASE_URL);
const RUN = Boolean(DATABASE_URL) && isLocal && !isSharedDevDb;

const codeOf = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

/**
 * The Waitlist preset's field list, in the shape the New Form drawer posts:
 * ids already minted client-side, options as objects, a display block first.
 * Kept in step with `apps/pages/app/components/forms/presets.ts` by hand — the
 * pages app cannot be imported from here, and the point of the test is the
 * SHAPE, not the copy.
 */
const waitlistPreset = (): FormField[] => {
  const option = (label: string) => ({ id: randomUUID(), label });
  return [
    {
      id: randomUUID(),
      type: 'banner',
      text: 'This waitlist is FIFO and balanced across class years.',
      tone: 'info',
    },
    { id: randomUUID(), type: 'short_text', label: 'Full name', required: true },
    {
      id: randomUUID(),
      type: 'email',
      label: 'School email',
      required: true,
      help: 'We will send your confirmation link here.',
    },
    {
      id: randomUUID(),
      type: 'opinion_scale',
      label: 'How familiar are you with the material?',
      required: true,
      scale: { min: 1, max: 10, minLabel: 'Never tried it', maxLabel: 'I could teach it' },
    },
    {
      id: randomUUID(),
      type: 'dropdown',
      label: 'Class year',
      required: false,
      options: [option('2027'), option('2028'), option('2029')],
    },
  ] as unknown as FormField[];
};

describe.skipIf(!RUN)('forms builder lifecycle (integration)', () => {
  const suite = randomUUID().slice(0, 8);
  const prisma = getPrisma();

  let classroomId: string;
  let orgId: string;
  let ownerId: string;

  /** What the builder's loader hands the client: the stored, normalized list. */
  const storedDraft = async (formId: string): Promise<FormField[]> => {
    const form = await prisma.form.findUniqueOrThrow({ where: { id: formId } });
    return formService.fieldsOf(form.draft_fields);
  };

  const publishedFields = async (formId: string): Promise<FormField[]> => {
    const revision = await formService.getCurrentRevision(formId);
    return formService.fieldsOf(revision?.fields);
  };

  const idsOf = (fields: FormField[]) => fields.map(field => field.id);

  beforeAll(async () => {
    const org = await prisma.gitOrganization.create({
      data: {
        provider: 'GITHUB',
        provider_id: `formbuild-${suite}`,
        login: `formbuild-org-${suite}`,
      },
    });
    orgId = org.id;

    const classroom = await prisma.classroom.create({
      data: {
        slug: `formbuild-${suite}`,
        git_org_id: orgId,
        name: `Forms Builder ${suite}`,
        content_namespace: `formbuild-${suite}`,
        content_repo: `content-formbuild-${suite}`,
      },
    });
    classroomId = classroom.id;

    const user = await prisma.user.create({
      data: {
        login: `formbuild-${suite}-owner`,
        email: `formbuild-${suite}-owner@example.test`,
        name: 'Forms Builder Owner',
      },
    });
    ownerId = user.id;
  });

  afterAll(async () => {
    if (orgId) await prisma.gitOrganization.delete({ where: { id: orgId } }).catch(() => {});
    await prisma.user
      .deleteMany({ where: { login: { startsWith: `formbuild-${suite}-` } } })
      .catch(() => {});
  });

  it('walks create → save → publish → close → reopen → new version, keeping field ids', async () => {
    // ── New Form drawer ────────────────────────────────────────────────────
    const preset = waitlistPreset();
    const form = await formService.create({
      classroomId,
      title: `Waitlist ${suite}`,
      access: 'PUBLIC',
      createdBy: ownerId,
      fields: preset,
    });

    expect(form.status).toBe('DRAFT');
    expect(form.access).toBe('PUBLIC');

    const afterCreate = await storedDraft(form.id);
    expect(afterCreate).toHaveLength(5);
    // Client-minted ids are KEPT by the contract, which is what lets the drawer
    // and the builder agree about which field is which before anything is saved.
    expect(idsOf(afterCreate)).toEqual(idsOf(preset));

    // ── Save draft: post the stored list back, one label edited ────────────
    const edited = afterCreate.map(field =>
      field.type === 'short_text' ? { ...field, label: 'Full name (edited)' } : field
    );
    await formService.update(form.id, { fields: edited });

    const afterSave = await storedDraft(form.id);
    expect(idsOf(afterSave)).toEqual(idsOf(afterCreate));
    expect(afterSave.find(field => field.type === 'short_text')?.label).toBe('Full name (edited)');
    // Option ids survive too — answers store the option id, so rewording a
    // choice must not orphan the responses that picked it.
    const dropdownBefore = afterCreate.find(field => field.type === 'dropdown');
    const dropdownAfter = afterSave.find(field => field.type === 'dropdown');
    expect((dropdownAfter?.options as Array<{ id: string }>).map(o => o.id)).toEqual(
      (dropdownBefore?.options as Array<{ id: string }>).map(o => o.id)
    );

    // ── Publish ────────────────────────────────────────────────────────────
    const { revision: first } = await formService.publish(form.id);
    expect(first.version).toBe(1);

    const live = await publishedFields(form.id);
    expect(idsOf(live)).toEqual(idsOf(afterSave));

    const opened = await prisma.form.findUniqueOrThrow({ where: { id: form.id } });
    expect(opened.status).toBe('OPEN');

    // ── The tri-state select: CLOSED, then back to OPEN ────────────────────
    const closed = await formService.quickUpdate(form.id, { status: 'CLOSED' });
    expect(closed.status).toBe('CLOSED');

    const reopened = await formService.quickUpdate(form.id, { status: 'OPEN' });
    expect(reopened.status).toBe('OPEN');
    // Reopening does not mint a revision: the form people already filled in is
    // the form they get back.
    expect(reopened.current_revision_id).toBe(first.id);

    // ── Editing a live form is refused, which is why the dance exists ──────
    expect(await codeOf(formService.update(form.id, { fields: afterSave }))).toBe(
      formService.FORM_NOT_DRAFT
    );

    // ── Publish new version: the whole dance, as one action would run it ───
    const withExtra = [
      ...afterSave,
      {
        id: randomUUID(),
        type: 'long_text',
        label: 'Anything else?',
        required: false,
      } as unknown as FormField,
    ];

    await formService.quickUpdate(form.id, { status: 'DRAFT' });
    await formService.update(form.id, { fields: withExtra });
    const { revision: second } = await formService.publish(form.id);

    expect(second.version).toBe(2);

    const afterVersion = await prisma.form.findUniqueOrThrow({ where: { id: form.id } });
    expect(afterVersion.status).toBe('OPEN');
    expect(afterVersion.current_revision_id).toBe(second.id);

    // Revision 1 is untouched — a response filled against it still resolves to
    // the five questions its author actually saw.
    const originalRevision = await prisma.formRevision.findUniqueOrThrow({
      where: { id: first.id },
    });
    expect(formService.fieldsOf(originalRevision.fields)).toHaveLength(5);
    expect(await publishedFields(form.id)).toHaveLength(6);
    // And the six ids are the original five plus one, in order.
    expect(idsOf(await publishedFields(form.id)).slice(0, 5)).toEqual(idsOf(afterSave));
  });

  /**
   * THE EMAIL DOMAIN RESTRICTION SURVIVES EVERY HOP THE BUILDER MAKES.
   *
   * `formContract.test.ts` proves the refinement REJECTS the wrong domain. This
   * proves the restriction is still there to do the rejecting — a different
   * claim, and the one the builder can break on its own.
   *
   * `emailDef` is `.strict()`, so `domain` is either in the schema or it is a
   * save failure; what it is NOT is guaranteed to reach the PUBLISHED REVISION,
   * because a revision is a separate copy written by `publish`. The path a
   * restriction actually takes is: typed in the config pane → normalized draft →
   * read back by the builder's loader → posted again verbatim on the next save →
   * copied into revision 1 → and, after an edit, copied into revision 2. A drop
   * anywhere along it turns a Dartmouth-only waitlist into an open one, and the
   * form still looks right in the builder because the DRAFT kept the value.
   */
  it('round-trips an email domain restriction through save, publish and re-publish', async () => {
    const emailFieldId = randomUUID();

    const form = await formService.create({
      classroomId,
      title: `Domain Restricted ${suite}`,
      access: 'PUBLIC',
      createdBy: ownerId,
      fields: [
        {
          id: emailFieldId,
          type: 'email',
          label: 'School email',
          required: true,
          domain: 'dartmouth.edu',
        },
      ] as unknown as FormField[],
    });

    // The normalized draft the builder's loader hands back to the config pane.
    const draft = await storedDraft(form.id);
    expect(draft[0]).toMatchObject({ type: 'email', domain: 'dartmouth.edu' });

    // Saving the value the builder READ BACK — the round trip that matters,
    // because that is literally what the route posts.
    await formService.update(form.id, { fields: draft });
    expect(await storedDraft(form.id)).toMatchObject([{ domain: 'dartmouth.edu' }]);

    await formService.publish(form.id);
    const live = await publishedFields(form.id);
    expect(live[0]).toMatchObject({ id: emailFieldId, domain: 'dartmouth.edu' });

    // ── Revision 2 ─────────────────────────────────────────────────────────
    // An unrelated edit must not quietly drop the restriction.
    const { revision: second } = await formService.publishNewVersion(form.id, [
      { ...live[0], label: 'Dartmouth email' },
      { type: 'short_text', label: 'Full name', required: false },
    ] as unknown as FormField[]);

    expect(formService.fieldsOf(second.fields)[0]).toMatchObject({
      id: emailFieldId,
      label: 'Dartmouth email',
      domain: 'dartmouth.edu',
    });

    /**
     * CLEARING it is the other direction, and the one a `??`-style merge gets
     * wrong: the config pane sends `domain: undefined` for an emptied input, and
     * a definition that read absent as "keep the old value" would leave behind a
     * restriction the instructor believes they removed.
     */
    const { revision: third } = await formService.publishNewVersion(form.id, [
      { id: emailFieldId, type: 'email', label: 'Any email', required: true },
    ] as unknown as FormField[]);

    expect(formService.fieldsOf(third.fields)[0]).not.toHaveProperty('domain');
  });

  /**
   * A form with NO domain is unchanged by the feature existing at all — the
   * companion to the test above, and the one that would catch a default
   * sneaking in (`domain: ''` would refine every address against a bare `@`).
   */
  it('leaves an email field without a domain unrestricted', async () => {
    const form = await formService.create({
      classroomId,
      title: `Unrestricted ${suite}`,
      access: 'PUBLIC',
      createdBy: ownerId,
      fields: [{ type: 'email', label: 'Email', required: true }] as unknown as FormField[],
    });

    await formService.publish(form.id);
    expect((await publishedFields(form.id))[0]).not.toHaveProperty('domain');
  });

  it('refuses OPEN on a form that was never published, so the list can say "publish first"', async () => {
    const form = await formService.create({
      classroomId,
      title: `Never Published ${suite}`,
      createdBy: ownerId,
    });

    expect(await codeOf(formService.quickUpdate(form.id, { status: 'OPEN' }))).toBe(
      formService.FORM_NO_FIELDS
    );

    const unchanged = await prisma.form.findUniqueOrThrow({ where: { id: form.id } });
    expect(unchanged.status).toBe('DRAFT');
  });

  it('freezes access once the form leaves DRAFT, which is why the builder locks the row', async () => {
    const form = await formService.create({
      classroomId,
      title: `Frozen Access ${suite}`,
      access: 'PUBLIC',
      createdBy: ownerId,
      fields: [{ type: 'short_text', label: 'Name', required: true }],
    });

    // While it is a draft, the builder's Switch-to-Classroom link works.
    const switched = await formService.update(form.id, { access: 'CLASSROOM' });
    expect(switched.access).toBe('CLASSROOM');

    await formService.publish(form.id);

    expect(await codeOf(formService.update(form.id, { access: 'PUBLIC' }))).toBe(
      formService.FORM_ACCESS_FROZEN
    );
  });

  /**
   * PUBLISHING A NEW VERSION IS ONE MOVE, OR IT IS A BUG.
   *
   * Editing a live form needs three writes — DRAFT, save fields, publish — and
   * the builder used to make them as three separate service calls. A throw
   * anywhere in the middle left the form in DRAFT, and a DRAFT form 404s for
   * every filler: the instructor's edit takes the form off the internet and
   * nothing says so.
   *
   * The failure is provoked with an invalid definition rather than a mocked
   * connection error, because that is the one that actually happens — the
   * builder posts whatever is on the canvas, and the contract is strict.
   */
  it('publishes a new version atomically, or leaves the live one alone', async () => {
    const form = await formService.create({
      classroomId,
      title: `Atomic Version ${suite}`,
      access: 'PUBLIC',
      createdBy: ownerId,
      fields: [{ type: 'short_text', label: 'Name', required: true }],
    });
    const { revision: live } = await formService.publish(form.id);

    // ── The failure ────────────────────────────────────────────────────────
    const badFields = [{ type: 'short_text' /* no label */ }];
    expect(await codeOf(formService.publishNewVersion(form.id, badFields))).toBe(
      'FORM_DEFINITION_INVALID'
    );

    const afterFailure = await prisma.form.findUniqueOrThrow({ where: { id: form.id } });
    // Still OPEN, still serving the revision people were already filling in,
    // and the saved draft was not half-written either.
    expect(afterFailure.status).toBe('OPEN');
    expect(afterFailure.current_revision_id).toBe(live.id);
    expect(formService.fieldsOf(afterFailure.draft_fields)).toHaveLength(1);
    expect(await prisma.formRevision.count({ where: { form_id: form.id } })).toBe(1);

    // The three-call sequence it replaces DOES strand the form — which is why
    // the single call has to exist. Asserting it here keeps the test honest
    // about what it is protecting against.
    await formService.quickUpdate(form.id, { status: 'DRAFT' });
    expect(await codeOf(formService.update(form.id, { fields: badFields }))).toBe(
      'FORM_DEFINITION_INVALID'
    );
    const stranded = await prisma.form.findUniqueOrThrow({ where: { id: form.id } });
    expect(stranded.status).toBe('DRAFT');

    // ── The success ────────────────────────────────────────────────────────
    const { revision: second, form: reopened } = await formService.publishNewVersion(form.id, [
      ...formService.fieldsOf(stranded.draft_fields),
      { type: 'long_text', label: 'Anything else?' },
    ] as unknown as FormField[]);

    expect(second.version).toBe(2);
    expect(reopened.status).toBe('OPEN');
    expect(reopened.current_revision_id).toBe(second.id);
    expect(formService.fieldsOf(second.fields)).toHaveLength(2);
    // Revision 1 is untouched, so responses filed against it still resolve.
    expect(await prisma.formRevision.count({ where: { form_id: form.id } })).toBe(2);
  });

  it('refuses a new version whose fields break the form’s access mode', async () => {
    // The access check runs BEFORE the row is touched, so a Team Review pasted
    // onto a PUBLIC form is refused without taking the form down first.
    const form = await formService.create({
      classroomId,
      title: `Atomic Access ${suite}`,
      access: 'PUBLIC',
      createdBy: ownerId,
      fields: [{ type: 'short_text', label: 'Name', required: true }],
    });
    const { revision: live } = await formService.publish(form.id);

    expect(
      await codeOf(
        formService.publishNewVersion(form.id, [
          {
            type: 'roster_select',
            label: 'Pick a partner',
            optionSource: 'roster',
          },
        ])
      )
    ).toBe('FORM_FIELD_ACCESS_VIOLATION');

    const after = await prisma.form.findUniqueOrThrow({ where: { id: form.id } });
    expect(after.status).toBe('OPEN');
    expect(after.current_revision_id).toBe(live.id);
  });

  /**
   * THE ROSTER LEAK. A published CLASSROOM form must not be able to become
   * PUBLIC by way of the supported "take it back to DRAFT" move.
   *
   * The sequence below is the exact three-call path both the builder's
   * new-version action and the MCP tools expose:
   *
   *   form_publish { action: 'draft' }              → quickUpdate({ status: DRAFT })
   *   form_update  { access: 'PUBLIC', fields: [] } → update(...)
   *   form_publish { action: 'reopen' }             → reopen()
   *
   * `quickUpdate(DRAFT)` deliberately LEAVES `current_revision_id` in place, so
   * the middle call used to pass every guard: `!isDraft` was false, and the
   * stale-fields check at the end of `update` inspects `draft_fields`, not the
   * published revision. The result was an OPEN, PUBLIC form still serving a
   * revision whose `roster_select` options are one object per student —
   * `{ id: <user_id>, label: "Name (login)" }` — to anonymous visitors.
   */
  it('refuses a CLASSROOM→PUBLIC flip on a form that has ever been published', async () => {
    const student = await prisma.user.create({
      data: {
        login: `formbuild-${suite}-student`,
        email: `formbuild-${suite}-student@example.test`,
        name: 'Rostered Student',
      },
    });
    await prisma.classroomMembership.create({
      data: { classroom_id: classroomId, user_id: student.id, role: 'STUDENT' },
    });

    const form = await formService.create({
      classroomId,
      title: `Roster Leak ${suite}`,
      access: 'CLASSROOM',
      createdBy: ownerId,
      fields: [
        {
          id: randomUUID(),
          type: 'roster_select',
          label: 'Who would you like to work with?',
          optionSource: 'roster',
          required: true,
        },
      ] as unknown as FormField[],
    });

    const { revision } = await formService.publish(form.id);

    // Precondition: the revision really does hold the roster. Without this the
    // rest of the test would pass against a form that had nothing to leak.
    const materialized = formService.fieldsOf(revision.fields)[0] as unknown as {
      options: Array<{ id: string; label: string }>;
    };
    expect(materialized.options.map(option => option.id)).toContain(student.id);
    expect(materialized.options.map(option => option.label)).toContain(
      `Rostered Student (formbuild-${suite}-student)`
    );

    // ── The three calls ────────────────────────────────────────────────────
    await formService.quickUpdate(form.id, { status: 'DRAFT' });

    const cleanFields = [
      { id: randomUUID(), type: 'short_text', label: 'Your name', required: true },
    ] as unknown as FormField[];

    expect(
      await codeOf(formService.update(form.id, { access: 'PUBLIC', fields: cleanFields }))
    ).toBe(formService.FORM_ACCESS_FROZEN);

    // Nothing moved: not the access mode, not the revision the fill page serves.
    const after = await prisma.form.findUniqueOrThrow({ where: { id: form.id } });
    expect(after.access).toBe('CLASSROOM');
    expect(after.current_revision_id).toBe(revision.id);

    // And the flip is refused on its own too — the field list is not what makes
    // it dangerous, so dropping it from the call must not make it allowed.
    expect(await codeOf(formService.update(form.id, { access: 'PUBLIC' }))).toBe(
      formService.FORM_ACCESS_FROZEN
    );

    // Reopening still works and still serves the CLASSROOM revision.
    const reopened = await formService.reopen(form.id);
    expect(reopened.status).toBe('OPEN');
    expect(reopened.access).toBe('CLASSROOM');
  });

  it('rejects a Team Review preset saved onto a PUBLIC form, whatever the client sent', async () => {
    // The palette locks `repeat_group` when access is PUBLIC. This is the
    // server-side half of that rule — the half a hand-written request, an MCP
    // call, or a stale browser tab meets.
    const teamReview = [
      {
        id: randomUUID(),
        type: 'repeat_group',
        label: 'Review each teammate',
        required: false,
        repeat: {
          over: 'teammates',
          scope: { by: 'classroom' },
          exclude_self: true,
          require_all_targets: true,
        },
        fields: [
          { id: randomUUID(), type: 'long_text', label: 'How did they do?', required: false },
        ],
      },
    ] as unknown as FormField[];

    expect(
      await codeOf(
        formService.create({
          classroomId,
          title: `Public Team Review ${suite}`,
          access: 'PUBLIC',
          createdBy: ownerId,
          fields: teamReview,
        })
      )
    ).toBe('FORM_FIELD_ACCESS_VIOLATION');

    // The same field list on a CLASSROOM form is fine — which is what makes the
    // preset's forced Classroom mode the right fix rather than a workaround.
    const ok = await formService.create({
      classroomId,
      title: `Classroom Team Review ${suite}`,
      access: 'CLASSROOM',
      createdBy: ownerId,
      fields: teamReview,
    });
    expect(formService.fieldsOf(ok.draft_fields)).toHaveLength(1);
  });
});
