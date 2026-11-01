/**
 * The gradebook CSV download: gated like the gradebook (OWNER and TEACHER), the
 * export built for the classroom the gate resolved (never one named by the
 * request), and every download audited.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  requireClassroomStaff: vi.fn(),
  addClassroomAuditLog: vi.fn(),
  buildGradebookExport: vi.fn(),
  toCsv: vi.fn(),
}));

vi.mock('~/utils/routeAuth.server', () => ({
  requireClassroomStaff: (...a: unknown[]) => mocks.requireClassroomStaff(...a),
}));
vi.mock('~/utils/helpers', () => ({
  addClassroomAuditLog: (...a: unknown[]) => mocks.addClassroomAuditLog(...a),
}));
vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    gradebookExport: {
      buildGradebookExport: (...a: unknown[]) => mocks.buildGradebookExport(...a),
      toCsv: (...a: unknown[]) => mocks.toCsv(...a),
    },
  },
}));

const { loader } = await import('../route');

const CLASSROOM_X = { id: 'class-x', slug: 'intro-x' };

const call = (slug: string) =>
  loader({
    request: new Request(`http://localhost/admin/${slug}/grades/export`),
    params: { class: slug },
    context: {},
  } as never) as Promise<Response>;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireClassroomStaff.mockResolvedValue({
    userId: 'teacher-a',
    classroom: CLASSROOM_X,
    membership: { role: 'TEACHER' },
  });
  mocks.buildGradebookExport.mockResolvedValue({
    headers: ['Name'],
    rows: [['Ada']],
    studentCount: 1,
    assignmentCount: 0,
  });
  mocks.toCsv.mockReturnValue('Name\r\nAda\r\n');
});

describe('admin.$class.grades.export', () => {
  it('serves a CSV file for the classroom the gate resolved', async () => {
    const res = await call('intro-x');

    expect(mocks.requireClassroomStaff).toHaveBeenCalledWith(
      expect.any(Request),
      'intro-x',
      expect.objectContaining({ resourceType: 'GRADES' })
    );
    expect(mocks.buildGradebookExport).toHaveBeenCalledWith(CLASSROOM_X);
    expect(res.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');
    expect(res.headers.get('Content-Disposition')).toMatch(
      /^attachment; filename="intro-x-grades-\d{4}-\d{2}-\d{2}\.csv"$/
    );
    // Read as bytes: `text()` would strip the BOM Excel needs.
    const body = new TextDecoder('utf-8', { ignoreBOM: true }).decode(await res.arrayBuffer());
    expect(body).toBe('﻿Name\r\nAda\r\n');
  });

  it('builds nothing and audits nothing when the gate refuses', async () => {
    // An assistant, a student, or staff of another classroom.
    mocks.requireClassroomStaff.mockRejectedValue(new Response('Forbidden', { status: 403 }));

    await expect(call('intro-y')).rejects.toMatchObject({ status: 403 });
    expect(mocks.buildGradebookExport).not.toHaveBeenCalled();
    expect(mocks.addClassroomAuditLog).not.toHaveBeenCalled();
  });

  it('audits each download against the caller and their classroom', async () => {
    await call('intro-x');

    expect(mocks.addClassroomAuditLog).toHaveBeenCalledWith({
      classroomId: 'class-x',
      userId: 'teacher-a',
      role: 'TEACHER',
      action: 'VIEW',
      resourceType: 'GRADES',
      metadata: { tool: 'web:grades.export_csv', students: 1, assignments: 0 },
      dedupe: false,
    });
  });
});
