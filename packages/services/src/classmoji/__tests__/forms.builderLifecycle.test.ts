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
