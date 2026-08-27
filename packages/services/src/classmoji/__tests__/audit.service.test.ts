/**
 * audit.service dedup semantics: the 5s window must key on the acting TOOL
 * (data.tool) and on the role the payload ACTS ON (data.role) when present, so
 * distinct tools — and distinct roles granted or removed for the same person —
 * hitting the same resource in quick succession are never coalesced into one
 * row, while payloads carrying neither keep the original dedup key.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const findFirstMock = vi.fn();
const createMock = vi.fn();

vi.mock('@classmoji/database', () => ({
  default: () => ({
    auditLog: {
      findFirst: (...args: unknown[]) => findFirstMock(...args),
      create: (...args: unknown[]) => createMock(...args),
    },
  }),
}));

vi.mock('@prisma/client', () => ({
  Prisma: { JsonNull: Symbol('JsonNull') },
}));

const audit = await import('../audit.service.ts');

const baseEntry = {
  user_id: 'user-1',
  classroom_id: 'class-1',
  role: 'TEACHER',
  resource_type: 'SLIDES',
  resource_id: 'slide-1',
  action: 'UPDATE' as const,
};

type WhereArg = { where: Record<string, unknown> };

beforeEach(() => {
  vi.clearAllMocks();
  findFirstMock.mockResolvedValue(null);
  createMock.mockImplementation(({ data }: { data: unknown }) => Promise.resolve(data));
});

describe('audit.create dedup key', () => {
  it('includes data.tool in the dedup lookup when the payload names a tool', async () => {
    await audit.create({ ...baseEntry, data: { tool: 'deck_apply', new_sha: 'abc' } });

    const where = (findFirstMock.mock.calls[0][0] as WhereArg).where;
    expect(where).toMatchObject({
      user_id: 'user-1',
      classroom_id: 'class-1',
      resource_type: 'SLIDES',
      resource_id: 'slide-1',
      action: 'UPDATE',
      data: { path: ['tool'], equals: 'deck_apply' },
    });
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('two DIFFERENT tools within the window query different keys (never coalesced)', async () => {
    await audit.create({ ...baseEntry, data: { tool: 'deck_apply' } });
    await audit.create({ ...baseEntry, data: { tool: 'deck_preview_accept' } });

    const first = (findFirstMock.mock.calls[0][0] as WhereArg).where.data;
    const second = (findFirstMock.mock.calls[1][0] as WhereArg).where.data;
    expect(first).toEqual({ path: ['tool'], equals: 'deck_apply' });
    expect(second).toEqual({ path: ['tool'], equals: 'deck_preview_accept' });
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it('the SAME tool within the window still dedups (recent row found → skip)', async () => {
    findFirstMock.mockResolvedValue({ id: 'existing-row' });

    const result = await audit.create({ ...baseEntry, data: { tool: 'deck_apply' } });

    expect(result).toBeNull();
    expect(createMock).not.toHaveBeenCalled();
  });

  it('omits the data filter entirely when the payload has no tool (unchanged behavior)', async () => {
    await audit.create({ ...baseEntry, data: { note: 'no tool key' } });
    await audit.create(baseEntry); // no data at all

    for (const call of findFirstMock.mock.calls) {
      expect((call[0] as WhereArg).where).not.toHaveProperty('data');
      expect((call[0] as WhereArg).where).not.toHaveProperty('AND');
    }
  });

  it('a non-string tool value does not join the key', async () => {
    await audit.create({ ...baseEntry, data: { tool: 42 } });
    expect((findFirstMock.mock.calls[0][0] as WhereArg).where).not.toHaveProperty('data');
  });

  it('includes data.role in the dedup lookup when the payload names a role', async () => {
    await audit.create({
      ...baseEntry,
      resource_type: 'STAFF',
      action: 'CREATE',
      data: { tool: 'staff_add', role: 'TEACHER' },
    });

    const where = (findFirstMock.mock.calls[0][0] as WhereArg).where;
    // The role the payload acts on rides under AND: a second `data` filter
    // cannot share the object with the tool filter.
    expect(where).toMatchObject({
      data: { path: ['tool'], equals: 'staff_add' },
      AND: [{ data: { path: ['role'], equals: 'TEACHER' } }],
    });
    expect(createMock).toHaveBeenCalledTimes(1);
  });

  it('two DIFFERENT granted roles within the window are never coalesced', async () => {
    // Same person, same tool, same resource — only the granted role differs, so
    // these are two distinct records and both must be written.
    const entry = { ...baseEntry, resource_type: 'STAFF', action: 'CREATE' as const };
    await audit.create({ ...entry, data: { tool: 'staff_add', role: 'TEACHER' } });
    await audit.create({ ...entry, data: { tool: 'staff_add', role: 'OWNER' } });

    const first = (findFirstMock.mock.calls[0][0] as WhereArg).where.AND;
    const second = (findFirstMock.mock.calls[1][0] as WhereArg).where.AND;
    expect(first).toEqual([{ data: { path: ['role'], equals: 'TEACHER' } }]);
    expect(second).toEqual([{ data: { path: ['role'], equals: 'OWNER' } }]);
    expect(createMock).toHaveBeenCalledTimes(2);
  });

  it('the SAME role within the window still dedups (recent row found → skip)', async () => {
    findFirstMock.mockResolvedValue({ id: 'existing-row' });

    const result = await audit.create({
      ...baseEntry,
      data: { tool: 'staff_add', role: 'TEACHER' },
    });

    expect(result).toBeNull();
    expect(createMock).not.toHaveBeenCalled();
  });

  it('a non-string role value does not join the key', async () => {
    await audit.create({ ...baseEntry, data: { tool: 'staff_add', role: 42 } });
    expect((findFirstMock.mock.calls[0][0] as WhereArg).where).not.toHaveProperty('AND');
  });

  it('a role without a tool joins the key on its own', async () => {
    await audit.create({ ...baseEntry, data: { role: 'OWNER' } });

    const where = (findFirstMock.mock.calls[0][0] as WhereArg).where;
    expect(where).not.toHaveProperty('data');
    expect(where.AND).toEqual([{ data: { path: ['role'], equals: 'OWNER' } }]);
  });

  /**
   * The tool alone is not enough to tell repeated edits of the SAME field
   * apart. Route-originated writes name the field and the value they wrote, and
   * the value is what distinguishes them — without it, a page flipped
   * public → draft → public inside the window records only the first row, and
   * the log then asserts a state the page is no longer in.
   */
  describe('the written value joins the key, so same-tool repeats stay distinct', () => {
    const pageStatus = (value: string) => ({
      ...baseEntry,
      resource_type: 'PAGES',
      data: { tool: 'web:pages.status', field: 'status', value },
    });

    it('records every step of a public → draft → public sequence', async () => {
      await audit.create(pageStatus('public'));
      await audit.create(pageStatus('draft'));
      await audit.create(pageStatus('public'));

      const values = findFirstMock.mock.calls.map(
        call => ((call[0] as WhereArg).where.AND as Array<{ data: { equals: unknown } }>)[0].data
      );
      expect(values).toEqual([
        { path: ['value'], equals: 'public' },
        { path: ['value'], equals: 'draft' },
        { path: ['value'], equals: 'public' },
      ]);
      expect(createMock).toHaveBeenCalledTimes(3);
    });

    it('still dedups a genuine double-submit of the same value', async () => {
      // The case the window exists for: one intent, two deliveries.
      findFirstMock.mockResolvedValue({ id: 'existing-row' });

      expect(await audit.create(pageStatus('draft'))).toBeNull();
      expect(createMock).not.toHaveBeenCalled();
    });

    it('keys on a boolean value too, so a toggle flipped back is not lost', async () => {
      const toggle = (value: boolean) => ({
        ...baseEntry,
        resource_type: 'PAGES',
        data: { tool: 'web:pages.show_in_student_menu', value },
      });

      await audit.create(toggle(false));
      await audit.create(toggle(true));

      const first = (findFirstMock.mock.calls[0][0] as WhereArg).where.AND;
      const second = (findFirstMock.mock.calls[1][0] as WhereArg).where.AND;
      expect(first).toEqual([{ data: { path: ['value'], equals: false } }]);
      expect(second).toEqual([{ data: { path: ['value'], equals: true } }]);
      expect(createMock).toHaveBeenCalledTimes(2);
    });

    it('carries both the acted-on role and the value when a payload has both', async () => {
      await audit.create({
        ...baseEntry,
        data: { tool: 'staff_add', role: 'TEACHER', value: 'x' },
      });

      expect((findFirstMock.mock.calls[0][0] as WhereArg).where.AND).toEqual([
        { data: { path: ['role'], equals: 'TEACHER' } },
        { data: { path: ['value'], equals: 'x' } },
      ]);
    });

    it('leaves payloads with no value on the original key', async () => {
      // Calendar and quiz-weight rows carry no `value`; their behaviour is
      // unchanged.
      await audit.create({ ...baseEntry, data: { tool: 'web:calendar.update_event' } });

      const where = (findFirstMock.mock.calls[0][0] as WhereArg).where;
      expect(where).not.toHaveProperty('AND');
      expect(where.data).toEqual({ path: ['tool'], equals: 'web:calendar.update_event' });
    });

    it('a non-scalar value does not join the key', async () => {
      await audit.create({ ...baseEntry, data: { tool: 't', value: { nested: true } } });
      expect((findFirstMock.mock.calls[0][0] as WhereArg).where).not.toHaveProperty('AND');
    });
  });
});
