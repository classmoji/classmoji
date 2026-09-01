/**
 * FORM module items against a REAL Postgres.
 *
 * What cannot be mocked, and is therefore the whole point of this file:
 *   - the widened `module_items_one_target` CHECK, which must reject a row that
 *     sets both `form_id` and a sibling target;
 *   - the `module_items_module_id_form_id_key` unique index, which must reject
 *     the same form twice in one module;
 *   - `ON DELETE CASCADE` from forms → module_items, so deleting a form takes
 *     its module items with it rather than leaving a dangling row that violates
 *     the CHECK.
 * A fake Prisma would happily agree with whatever the service did.
 *
 * SAFETY: every fixture is namespaced with a fresh uuid and torn down in
 * afterAll by deleting the git organization (which cascades classroom → modules
 * → module items, and classroom → forms). Nothing is truncated and no
 * pre-existing row is touched — the devport database holds real development
 * data.
 *
 * Skipped unless DATABASE_URL names a LOCAL, non-shared database, exactly as
 * forms.integration.test.ts does.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';

import getPrisma from '@classmoji/database';
import * as formService from '../form.service.ts';
import * as moduleService from '../module.service.ts';
import * as calendarService from '../calendar.service.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
const isSharedDevDb = /\/classmoji(\?|$)/.test(DATABASE_URL);
const RUN = Boolean(DATABASE_URL) && isLocal && !isSharedDevDb;

const NAME_FIELD = { type: 'short_text', label: 'Full Name', required: true } as const;

describe.skipIf(!RUN)('FORM module items (integration)', () => {
  const suite = randomUUID().slice(0, 8);
  let classroomId: string;
  let classroomSlug: string;
  let otherClassroomId: string;
  let orgId: string;
  let ownerId: string;

  const prisma = getPrisma();

  const makeForm = async ({
    inClassroom,
    access = 'CLASSROOM' as const,
    publish = true,
    closesAt = null as Date | null,
  }: {
    inClassroom?: string;
    access?: 'PUBLIC' | 'CLASSROOM';
    publish?: boolean;
    closesAt?: Date | null;
  } = {}) => {
    const form = await formService.create({
      classroomId: inClassroom ?? classroomId,
      title: `Form ${suite} ${randomUUID().slice(0, 8)}`,
      access,
      createdBy: ownerId,
      fields: [NAME_FIELD],
    });
    if (closesAt) await formService.update(form.id, { closes_at: closesAt });
    if (publish) await formService.publish(form.id);
    return form.id;
  };

  const makeModule = async (title = `Module ${randomUUID().slice(0, 8)}`) =>
    moduleService.create(classroomId, { title: `${title} ${suite}` });

  beforeAll(async () => {
    const org = await prisma.gitOrganization.create({
      data: {
        provider: 'GITHUB',
        provider_id: `mitest-${suite}`,
        login: `mitest-org-${suite}`,
      },
    });
    orgId = org.id;

    const classroom = await prisma.classroom.create({
      data: {
        slug: `mitest-${suite}`,
        git_org_id: orgId,
        name: `Module Item Test ${suite}`,
        content_namespace: `mitest-${suite}`,
        content_repo: `content-mitest-${suite}`,
      },
    });
    classroomId = classroom.id;
    classroomSlug = classroom.slug;

    const other = await prisma.classroom.create({
      data: {
        slug: `mitest-other-${suite}`,
        git_org_id: orgId,
        name: `Module Item Other ${suite}`,
        content_namespace: `mitest-other-${suite}`,
        content_repo: `content-mitest-other-${suite}`,
      },
    });
    otherClassroomId = other.id;

    const user = await prisma.user.create({
      data: {
        login: `mitest-${suite}-owner`,
        email: `mitest-${suite}-owner@example.test`,
        name: `Module Item Owner ${suite}`,
      },
    });
    ownerId = user.id;
  });

  afterAll(async () => {
    if (orgId) await prisma.gitOrganization.delete({ where: { id: orgId } }).catch(() => {});
    await prisma.user
      .deleteMany({ where: { login: { startsWith: `mitest-${suite}-` } } })
      .catch(() => {});
  });

  // ── CRUD ─────────────────────────────────────────────────────────────────

  it('adds a form to a module as a FORM item', async () => {
    const mod = await makeModule();
    const formId = await makeForm();

    const item = await moduleService.addItem(mod.id, 'FORM', formId, classroomId);

    expect(item.item_type).toBe('FORM');
    expect(item.form_id).toBe(formId);
    expect(item.page_id).toBeNull();
    expect(item.quiz_id).toBeNull();
    expect(item.slide_id).toBeNull();
    expect(item.repository_id).toBeNull();
  });

  it('appends form items after existing items and reorders them', async () => {
    const mod = await makeModule();
    const first = await makeForm();
    const second = await makeForm();

    const a = await moduleService.addItem(mod.id, 'FORM', first, classroomId);
    const b = await moduleService.addItem(mod.id, 'FORM', second, classroomId);
    expect(b.position).toBeGreaterThan(a.position);

    await moduleService.reorderItems(mod.id, [b.id, a.id], classroomId);

    const rows = await prisma.moduleItem.findMany({
      where: { module_id: mod.id },
      orderBy: { position: 'asc' },
      select: { id: true },
    });
    expect(rows.map(r => r.id)).toEqual([b.id, a.id]);
  });

  it('removes a form item without touching the form', async () => {
    const mod = await makeModule();
    const formId = await makeForm();
    const item = await moduleService.addItem(mod.id, 'FORM', formId, classroomId);

    await moduleService.removeItem(item.id, classroomId);

    expect(await prisma.moduleItem.findUnique({ where: { id: item.id } })).toBeNull();
    expect(await prisma.form.findUnique({ where: { id: formId } })).not.toBeNull();
  });

  it('refuses a form belonging to another classroom', async () => {
    const mod = await makeModule();
    const foreignFormId = await makeForm({ inClassroom: otherClassroomId });

    await expect(moduleService.addItem(mod.id, 'FORM', foreignFormId, classroomId)).rejects.toThrow(
      'Module item target not found in classroom'
    );
  });

  // ── database invariants ──────────────────────────────────────────────────

  it('rejects a row that sets form_id alongside another target (one-target CHECK)', async () => {
    const mod = await makeModule();
    const formId = await makeForm();
    const pageSlug = `page-${randomUUID().slice(0, 8)}`;
    const page = await prisma.page.create({
      data: {
        classroom: { connect: { id: classroomId } },
        creator: { connect: { id: ownerId } },
        title: `Page ${suite} ${pageSlug}`,
        slug: pageSlug,
        content_path: `pages/${pageSlug}`,
      },
    });

    await expect(
      prisma.moduleItem.create({
        data: { module_id: mod.id, item_type: 'FORM', form_id: formId, page_id: page.id },
      })
    ).rejects.toThrow();
  });

  it('rejects a FORM item with no target at all (one-target CHECK)', async () => {
    const mod = await makeModule();

    await expect(
      prisma.moduleItem.create({ data: { module_id: mod.id, item_type: 'FORM' } })
    ).rejects.toThrow();
  });

  it('rejects the same form twice in one module, but allows it in two modules', async () => {
    const modA = await makeModule();
    const modB = await makeModule();
    const formId = await makeForm();

    await moduleService.addItem(modA.id, 'FORM', formId, classroomId);
    await expect(moduleService.addItem(modA.id, 'FORM', formId, classroomId)).rejects.toThrow();

    const inB = await moduleService.addItem(modB.id, 'FORM', formId, classroomId);
    expect(inB.form_id).toBe(formId);
  });

  it('cascades: deleting a form deletes its module items', async () => {
    const mod = await makeModule();
    const formId = await makeForm();
    const item = await moduleService.addItem(mod.id, 'FORM', formId, classroomId);

    await prisma.form.delete({ where: { id: formId } });

    expect(await prisma.moduleItem.findUnique({ where: { id: item.id } })).toBeNull();
    // The module itself survives its item being cascaded away.
    expect(await prisma.module.findUnique({ where: { id: mod.id } })).not.toBeNull();
  });

  // ── visibility ───────────────────────────────────────────────────────────

  it('hides a DRAFT form from members but shows an OPEN and a CLOSED one', async () => {
    const mod = await makeModule();
    const draftId = await makeForm({ publish: false });
    const openId = await makeForm();
    const closedId = await makeForm();
    await formService.close(closedId);

    await moduleService.addItem(mod.id, 'FORM', draftId, classroomId);
    await moduleService.addItem(mod.id, 'FORM', openId, classroomId);
    await moduleService.addItem(mod.id, 'FORM', closedId, classroomId);
    await moduleService.setPublished(mod.id, true, classroomId);

    const forMembers = await moduleService.listForClassroom(classroomSlug);
    const target = forMembers.find(m => m.id === mod.id)!;
    const visibleFormIds = target.items.map(i => i.form_id);

    expect(visibleFormIds).toContain(openId);
    expect(visibleFormIds).toContain(closedId);
    expect(visibleFormIds).not.toContain(draftId);

    // Staff still see the draft.
    const forStaff = await moduleService.listForClassroom(classroomSlug, {
      includeUnpublished: true,
    });
    expect(forStaff.find(m => m.id === mod.id)!.items.map(i => i.form_id)).toContain(draftId);
  });

  it('offers every classroom form to the admin picker, drafts included', async () => {
    const openId = await makeForm();
    const draftId = await makeForm({ publish: false });

    const candidates = await moduleService.getCandidateContent(classroomId);
    const ids = candidates.forms.map(f => f.id);

    expect(ids).toContain(openId);
    expect(ids).toContain(draftId);
    // The picker needs enough to label and badge the option.
    const draft = candidates.forms.find(f => f.id === draftId)!;
    expect(draft.status).toBe('DRAFT');
    expect(draft).toHaveProperty('access');
    expect(draft).toHaveProperty('closes_at');
  });

  // ── calendar ─────────────────────────────────────────────────────────────

  it('puts an OPEN form with a closes_at on the calendar and leaves a DRAFT off it', async () => {
    const closesAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const openId = await makeForm({ closesAt });
    const draftId = await makeForm({ closesAt, publish: false });
    // A form with no close date has no deadline and therefore no event.
    const noCloseId = await makeForm();

    const from = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const to = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const events = await calendarService.getFormCloseEventsForRange(classroomId, from, to);
    const ids = events.map(e => e.form_id);

    expect(ids).toContain(openId);
    expect(ids).not.toContain(draftId);
    expect(ids).not.toContain(noCloseId);

    const event = events.find(e => e.form_id === openId)!;
    expect(event.is_form_close).toBe(true);
    expect(event.event_type).toBe('DEADLINE');
    expect(event.title).toMatch(/ closes$/);
    expect(event.form_url).toContain(`/${classroomSlug}/forms/${event.form_slug}`);
    expect(event.form_url).not.toContain('/responses');
  });

  it('merges form closes into the classroom calendar and points managers at responses', async () => {
    const closesAt = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    const formId = await makeForm({ closesAt });

    const from = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const to = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

    const managerView = await calendarService.getClassroomCalendar(
      classroomId,
      from,
      to,
      null,
      true,
      true,
      { canManageForms: true }
    );
    const managerEvent = managerView.find(e => (e as { form_id?: string }).form_id === formId) as
      | { form_url: string }
      | undefined;
    expect(managerEvent?.form_url).toMatch(/\/responses$/);

    // An assistant sees the same calendar (includeUnpublished) but must NOT be
    // sent to the responses view — that page is OWNER|TEACHER only.
    const assistantView = await calendarService.getClassroomCalendar(
      classroomId,
      from,
      to,
      null,
      true,
      true
    );
    const assistantEvent = assistantView.find(
      e => (e as { form_id?: string }).form_id === formId
    ) as { form_url: string } | undefined;
    expect(assistantEvent?.form_url).not.toMatch(/\/responses$/);

    const memberView = await calendarService.getClassroomCalendar(classroomId, from, to);
    const memberEvent = memberView.find(e => (e as { form_id?: string }).form_id === formId) as
      | { form_url: string }
      | undefined;
    expect(memberEvent?.form_url).toBeDefined();
    expect(memberEvent!.form_url).not.toMatch(/\/responses$/);
  });
});
