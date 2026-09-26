/**
 * Unit tests for the webapp forms action.
 *
 * Three properties, and the first two are the reason this file exists:
 *
 * 1. Every write is bound to a form IN THE AUTHORIZED CLASSROOM. Authorization
 *    binds to `params.class`; the form id arrives in the request body, and
 *    `form.service` resolves forms by id alone. Without the binding the two are
 *    unrelated, and staff of one classroom could mutate — or DELETE, taking the
 *    responses with it — another classroom's form. The binding is asserted in
 *    two places on purpose: the action must refuse a foreign id, AND it must
 *    pass `classroomId` down so the write itself is scoped. The read alone
 *    would still be a race.
 *
 * 2. A LOCKED or UNPUBLISHED classroom is read-only, and the refusal is
 *    RETURNED (these are fetcher submissions; a thrown Response would replace
 *    the screen). Nothing may be written after it.
 *
 * 3. The two successful paths each record one audit row, shaped like the MCP
 *    form tools' rows: resource_type 'FORMS', the form id, and a `tool` naming
 *    the surface — `tool` is load-bearing, because the audit service dedups
 *    inside a 5-second window on everything else.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  assertClassroomAccess: vi.fn(),
  assertProTier: vi.fn(),
  addClassroomAuditLog: vi.fn(),
  formMutationBlocked: vi.fn(),
  formFindFirst: vi.fn(),
  quickUpdate: vi.fn(),
  deleteForm: vi.fn(),
  findByClassroomId: vi.fn(),
  publicFormUrlFor: vi.fn(),
}));

vi.mock('~/utils/helpers', () => ({
  assertClassroomAccess: (...a: unknown[]) => mocks.assertClassroomAccess(...a),
  assertProTier: (...a: unknown[]) => mocks.assertProTier(...a),
  addClassroomAuditLog: (...a: unknown[]) => mocks.addClassroomAuditLog(...a),
  formMutationBlocked: (...a: unknown[]) => mocks.formMutationBlocked(...a),
}));

vi.mock('@classmoji/database', () => ({
  default: () => ({ form: { findFirst: (...a: unknown[]) => mocks.formFindFirst(...a) } }),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    form: {
      findByClassroomId: (...a: unknown[]) => mocks.findByClassroomId(...a),
      quickUpdate: (...a: unknown[]) => mocks.quickUpdate(...a),
      deleteForm: (...a: unknown[]) => mocks.deleteForm(...a),
    },
  },
  publicFormUrlFor: (...a: unknown[]) => mocks.publicFormUrlFor(...a),
}));

// The action is what is under test; the view layer only needs to import.
vi.mock('@classmoji/ui-components', () => ({ useCallout: () => ({ show: vi.fn() }) }));
vi.mock('~/components', () => ({
  SearchInput: () => null,
  TableActionButtons: () => null,
}));
vi.mock('antd', () => ({
  Button: () => null,
  Modal: () => null,
  Select: () => null,
  Table: () => null,
  Tag: () => null,
}));
vi.mock('@tabler/icons-react', () => ({
  IconCopy: () => null,
  IconExternalLink: () => null,
  IconEyeOff: () => null,
  IconLock: () => null,
  IconPencil: () => null,
  IconPlus: () => null,
  IconWorld: () => null,
}));
vi.mock('react-router', () => ({ useFetcher: () => ({ submit: vi.fn(), state: 'idle' }) }));

const route = await import('../admin.$class.forms/route.tsx');

const CLASS_SLUG = 'cs52-26f';
const CLASSROOM = { id: 'class-1', slug: CLASS_SLUG, status: 'ACTIVE' };
const OWN_FORM = 'form-1';
const FOREIGN_FORM = 'form-in-another-classroom';

const submit = (body: Record<string, string>) =>
  route.action({
    params: { class: CLASS_SLUG },
    request: new Request(`http://localhost/admin/${CLASS_SLUG}/forms`, {
      method: 'POST',
      body: new URLSearchParams(body),
    }),
  } as unknown as Parameters<typeof route.action>[0]);

/** The single audit entry the action wrote. */
const auditEntry = () =>
  mocks.addClassroomAuditLog.mock.calls[0][0] as {
    classroomId: string;
    userId: string;
    role: string;
    action: string;
    resourceType: string;
    resourceId: string;
    metadata: Record<string, unknown>;
  };

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.assertClassroomAccess.mockResolvedValue({
    userId: 'owner-1',
    classroom: CLASSROOM,
    membership: { id: 'm-1', role: 'TEACHER' },
  });
  mocks.assertProTier.mockResolvedValue(undefined);
  // Not locked, by default.
  mocks.formMutationBlocked.mockReturnValue(null);
  // The scoped read resolves only for a form in the authorized classroom; the
  // service mock stands in for the scoped write.
  mocks.formFindFirst.mockImplementation((args: { where: { id: string } }) =>
    args.where.id === OWN_FORM
      ? Promise.resolve({ id: OWN_FORM, title: 'Spring Waitlist', slug: 'spring-waitlist' })
      : Promise.resolve(null)
  );
  mocks.quickUpdate.mockResolvedValue({ id: OWN_FORM, status: 'OPEN' });
  mocks.deleteForm.mockResolvedValue({ count: 1 });
});

describe('the forms action binds every write to the authorized classroom', () => {
  it('refuses a form id from another classroom, and writes nothing', async () => {
    const result = await submit({
      intent: 'update-status',
      formId: FOREIGN_FORM,
      status: 'CLOSED',
    });

    expect(result).toEqual({ error: 'Form not found' });
    expect(mocks.quickUpdate).not.toHaveBeenCalled();
    expect(mocks.deleteForm).not.toHaveBeenCalled();
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });

  it('refuses to DELETE a form id from another classroom', async () => {
    const result = await submit({ intent: 'delete', formId: FOREIGN_FORM });

    expect(result).toEqual({ error: 'Form not found' });
    expect(mocks.deleteForm).not.toHaveBeenCalled();
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });

  it('reads the form scoped by classroom_id rather than by id alone', async () => {
    await submit({ intent: 'update-status', formId: OWN_FORM, status: 'CLOSED' });

    expect(mocks.formFindFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: OWN_FORM, classroom_id: 'class-1' } })
    );
  });

  it('passes the classroom scope down to the WRITE, so the read is not the only guard', async () => {
    await submit({ intent: 'update-status', formId: OWN_FORM, status: 'CLOSED' });
    expect(mocks.quickUpdate).toHaveBeenCalledWith(
      OWN_FORM,
      { status: 'CLOSED' },
      { classroomId: 'class-1' }
    );

    mocks.addClassroomAuditLog.mockClear();
    await submit({ intent: 'delete', formId: OWN_FORM });
    expect(mocks.deleteForm).toHaveBeenCalledWith(OWN_FORM, { classroomId: 'class-1' });
  });

  it('reports a write that matched nothing as not-found rather than throwing', async () => {
    // The form left the classroom between the read and the write.
    mocks.quickUpdate.mockRejectedValue(
      Object.assign(new Error('gone'), { code: 'FORM_NOT_FOUND' })
    );

    const result = await submit({ intent: 'update-status', formId: OWN_FORM, status: 'CLOSED' });

    expect(result).toEqual({ error: 'Form not found' });
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });
});

describe('the forms action honours the classroom-status gate', () => {
  it('returns the platform refusal for a LOCKED classroom and writes nothing', async () => {
    const refusal = new Response(
      JSON.stringify({ error: 'CLASSROOM_LOCKED', message: 'This class is in read-only mode.' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    );
    mocks.formMutationBlocked.mockReturnValue(refusal);

    const result = await submit({ intent: 'delete', formId: OWN_FORM });

    expect(result).toBe(refusal);
    expect(mocks.deleteForm).not.toHaveBeenCalled();
    expect(mocks.quickUpdate).not.toHaveBeenCalled();
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });

  it('checks the status gate before it even looks the form up', async () => {
    mocks.formMutationBlocked.mockReturnValue(new Response(null, { status: 403 }));

    await submit({ intent: 'update-status', formId: OWN_FORM, status: 'OPEN' });

    expect(mocks.formFindFirst).not.toHaveBeenCalled();
  });
});

describe('the forms action audits what it changed', () => {
  it('audits a status change as UPDATE, naming the surface and the new status', async () => {
    const result = await submit({ intent: 'update-status', formId: OWN_FORM, status: 'OPEN' });

    expect(result).toEqual({ success: true });
    expect(mocks.addClassroomAuditLog).toHaveBeenCalledOnce();
    expect(auditEntry()).toEqual({
      classroomId: 'class-1',
      userId: 'owner-1',
      // The role the gate ENFORCED, matching what the MCP form tools record.
      role: 'TEACHER',
      action: 'UPDATE',
      resourceType: 'FORMS',
      resourceId: OWN_FORM,
      metadata: { tool: 'web:forms.status', status: 'OPEN' },
    });
  });

  it('audits a delete as DELETE, keeping the title and slug the row no longer has', async () => {
    const result = await submit({ intent: 'delete', formId: OWN_FORM });

    expect(result).toEqual({ success: true });
    expect(auditEntry()).toEqual({
      classroomId: 'class-1',
      userId: 'owner-1',
      role: 'TEACHER',
      action: 'DELETE',
      resourceType: 'FORMS',
      resourceId: OWN_FORM,
      // The row is gone; the audit entry is the only place these survive.
      metadata: { tool: 'web:forms.delete', title: 'Spring Waitlist', slug: 'spring-waitlist' },
    });
  });

  it('turns the publish-first refusal into the instruction, and audits nothing', async () => {
    mocks.quickUpdate.mockRejectedValue(
      Object.assign(new Error('no fields'), { code: 'FORM_NO_FIELDS' })
    );

    const result = await submit({ intent: 'update-status', formId: OWN_FORM, status: 'OPEN' });

    expect(result).toEqual({ error: 'Publish this form before opening it.' });
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });

  it('refuses an unknown status and an unknown intent without writing', async () => {
    expect(await submit({ intent: 'update-status', formId: OWN_FORM, status: 'MAYBE' })).toEqual({
      error: 'Unknown status',
    });
    expect(await submit({ intent: 'sudo', formId: OWN_FORM })).toEqual({ error: 'Unknown intent' });
    expect(mocks.quickUpdate).not.toHaveBeenCalled();
    expect(mocks.deleteForm).not.toHaveBeenCalled();
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });

  it('refuses a submission with no form id before reading anything', async () => {
    expect(await submit({ intent: 'delete' })).toEqual({ error: 'Form not found' });
    expect(mocks.formFindFirst).not.toHaveBeenCalled();
  });
});
