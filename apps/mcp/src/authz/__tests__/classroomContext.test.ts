/**
 * Unit tests for resolveClassroomContext's ambiguity guard (finding A1).
 *
 * Classroom is unique only on (git_org_id, slug); the org login is matched
 * case-insensitively, so two case-variant twin orgs each owning the same slug
 * can return >1 row from findAll. The resolver must REFUSE such an ambiguous
 * reference with a non-leaking `not_found` rather than silently resolving to
 * matches[0] (the newest twin). A normal unambiguous reference must still
 * resolve; a zero-match must stay an indistinguishable clean not_found.
 *
 * `@classmoji/services` is mocked (factory idiom per packages/services
 * __tests__) so classroom/membership rows are hand-built and the resolver's
 * own decisions run for real.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolError } from '../../mcp/errors.ts';
import type { Viewer } from '../../auth/resolveViewer.ts';

const findAll = vi.fn();
const findByClassroomAndUser = vi.fn();

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    classroom: {
      findAll: (...args: unknown[]) => findAll(...args),
      getClassroomForUI: (c: unknown) => c,
    },
    classroomMembership: {
      findByClassroomAndUser: (...args: unknown[]) => findByClassroomAndUser(...args),
    },
  },
}));

const { resolveClassroomContext } = await import('../classroomContext.ts');

const VIEWER: Viewer = { userId: 'user-1', clientId: 'client-1', scopes: new Set(['read']) };
const REF = 'classmoji-dev/winter-2025';

function classroomRow(id: string, overrides: Record<string, unknown> = {}) {
  return { id, status: 'ACTIVE', slug: 'winter-2025', ...overrides };
}

beforeEach(() => {
  findAll.mockReset();
  findByClassroomAndUser.mockReset();
});

describe('resolveClassroomContext ambiguity guard (A1)', () => {
  it('REFUSES an ambiguous org/slug (two case-variant twin orgs) with not_found', async () => {
    // Two orgs whose logins differ only by case ("Classmoji-Dev" vs
    // "classmoji-dev") each own slug "winter-2025"; the insensitive match
    // returns both rows.
    findAll.mockResolvedValue([classroomRow('twin-a'), classroomRow('twin-b')]);

    const err = await resolveClassroomContext(VIEWER, REF).catch(e => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).kind).toBe('not_found');
    // Refused BEFORE any membership lookup — never resolves to one twin.
    expect(findByClassroomAndUser).not.toHaveBeenCalled();
  });

  it('keeps a zero-match as an indistinguishable clean not_found (no existence leak)', async () => {
    findAll.mockResolvedValue([]);

    const err = await resolveClassroomContext(VIEWER, REF).catch(e => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).kind).toBe('not_found');
    expect(findByClassroomAndUser).not.toHaveBeenCalled();
  });

  it('still resolves a normal unambiguous reference to its classroom context', async () => {
    findAll.mockResolvedValue([classroomRow('the-one')]);
    findByClassroomAndUser.mockResolvedValue({ id: 'membership-1', role: 'STUDENT' });

    const ctx = await resolveClassroomContext(VIEWER, REF);
    expect(ctx.classroomId).toBe('the-one');
    expect(ctx.role).toBe('STUDENT');
    expect(findByClassroomAndUser).toHaveBeenCalled();
  });
});
