/**
 * Unit tests for the pure authorization predicates (plan §8.1 layer 1, S4).
 *
 * The full role × status matrix is written out EXPLICITLY (not derived from
 * the same boolean expression under test) so the expected values document the
 * exact semantics:
 *   - entry gate: UNPUBLISHED blocks non-OWNER entry; LOCKED never blocks entry
 *     (mirror of assertClassroomEntryAllowed, packages/auth/src/server.ts)
 *   - mutation gate: OWNER always mutates; non-owners mutate only when ACTIVE
 *     (mirror of canMutateClassroom, packages/auth/src/server.ts)
 * The predicates under test are imported from @classmoji/auth/predicates —
 * the same module packages/auth/src/server.ts consumes — so webapp agreement
 * holds by construction (a single source; no separate parity test needed).
 */

import { describe, expect, it } from 'vitest';
import type { ClassroomStatus, Role } from '@prisma/client';
import {
  assertEntryAllowed,
  assertMutationAllowed,
  canEnterClassroom,
  canMutateClassroom,
  parseClassroomRef,
  requireRole,
} from '../pure.ts';
import { ToolError } from '../../mcp/errors.ts';

type Row = { role: Role; status: ClassroomStatus; enter: boolean; mutate: boolean };

// Hand-written truth table: every role × every status.
const MATRIX: Row[] = [
  // OWNER: always enters, always mutates.
  { role: 'OWNER', status: 'ACTIVE', enter: true, mutate: true },
  { role: 'OWNER', status: 'LOCKED', enter: true, mutate: true },
  { role: 'OWNER', status: 'UNPUBLISHED', enter: true, mutate: true },
  // TEACHER: enters unless UNPUBLISHED; mutates only when ACTIVE.
  { role: 'TEACHER', status: 'ACTIVE', enter: true, mutate: true },
  { role: 'TEACHER', status: 'LOCKED', enter: true, mutate: false },
  { role: 'TEACHER', status: 'UNPUBLISHED', enter: false, mutate: false },
  // ASSISTANT: same as TEACHER (non-owner).
  { role: 'ASSISTANT', status: 'ACTIVE', enter: true, mutate: true },
  { role: 'ASSISTANT', status: 'LOCKED', enter: true, mutate: false },
  { role: 'ASSISTANT', status: 'UNPUBLISHED', enter: false, mutate: false },
  // STUDENT: same as TEACHER (non-owner).
  { role: 'STUDENT', status: 'ACTIVE', enter: true, mutate: true },
  { role: 'STUDENT', status: 'LOCKED', enter: true, mutate: false },
  { role: 'STUDENT', status: 'UNPUBLISHED', enter: false, mutate: false },
];

function thrownToolError(fn: () => void): ToolError | null {
  try {
    fn();
    return null;
  } catch (error) {
    expect(error).toBeInstanceOf(ToolError);
    return error as ToolError;
  }
}

describe('canEnterClassroom / assertEntryAllowed', () => {
  for (const { role, status, enter } of MATRIX) {
    it(`${role} on ${status} → ${enter ? 'allowed' : 'blocked'}`, () => {
      expect(canEnterClassroom({ role, status })).toBe(enter);

      const error = thrownToolError(() => assertEntryAllowed({ role, status }));
      if (enter) {
        expect(error).toBeNull();
      } else {
        expect(error?.kind).toBe('forbidden');
        expect(error?.code).toBe('CLASSROOM_UNPUBLISHED');
      }
    });
  }
});

describe('canMutateClassroom / assertMutationAllowed', () => {
  for (const { role, status, mutate } of MATRIX) {
    it(`${role} on ${status} → ${mutate ? 'allowed' : 'blocked'}`, () => {
      expect(canMutateClassroom({ role, status })).toBe(mutate);

      const error = thrownToolError(() => assertMutationAllowed({ role, status }));
      if (mutate) {
        expect(error).toBeNull();
      } else {
        expect(error?.kind).toBe('forbidden');
        // LOCKED and UNPUBLISHED produce distinct typed codes (webapp parity).
        expect(error?.code).toBe(
          status === 'LOCKED' ? 'CLASSROOM_LOCKED' : 'CLASSROOM_UNPUBLISHED'
        );
      }
    });
  }
});

describe('parseClassroomRef', () => {
  it('parses a valid org/slug reference', () => {
    expect(parseClassroomRef('dev-org/classmoji-dev-winter-2025')).toEqual({
      org: 'dev-org',
      slug: 'classmoji-dev-winter-2025',
    });
  });

  it('trims whitespace around both parts', () => {
    expect(parseClassroomRef(' cs-dept / cs101-fall-2025 ')).toEqual({
      org: 'cs-dept',
      slug: 'cs101-fall-2025',
    });
  });

  const invalid: Array<[string, unknown]> = [
    ['missing slash', 'just-a-slug'],
    ['empty org part', '/slug-only'],
    ['empty slug part', 'org-only/'],
    ['whitespace-only org', '   /slug'],
    ['whitespace-only slug', 'org/   '],
    ['too many slashes', 'org/slug/extra'],
    ['empty string', ''],
    ['bare slash', '/'],
    ['non-string (number)', 42],
    ['non-string (null)', null],
    ['non-string (undefined)', undefined],
    ['non-string (object)', { org: 'a', slug: 'b' }],
  ];

  for (const [label, value] of invalid) {
    it(`rejects ${label} with invalid_params`, () => {
      const error = thrownToolError(() => parseClassroomRef(value));
      expect(error?.kind).toBe('invalid_params');
    });
  }
});

describe('requireRole', () => {
  const owner = { role: 'OWNER' as Role };
  const teacher = { role: 'TEACHER' as Role };
  const assistant = { role: 'ASSISTANT' as Role };
  const student = { role: 'STUDENT' as Role };

  // Route-derived tiers from plan §4.2.
  const TIERS: Array<{ name: string; allowed: Role[] }> = [
    { name: 'admin (OWNER)', allowed: ['OWNER'] },
    { name: 'staff (OWNER+TEACHER)', allowed: ['OWNER', 'TEACHER'] },
    { name: 'teaching team', allowed: ['OWNER', 'TEACHER', 'ASSISTANT'] },
    { name: 'student-only', allowed: ['STUDENT'] },
  ];

  for (const { name, allowed } of TIERS) {
    for (const membership of [owner, teacher, assistant, student]) {
      const shouldPass = allowed.includes(membership.role);
      it(`${name}: ${membership.role} → ${shouldPass ? 'allowed' : 'denied'}`, () => {
        if (shouldPass) {
          expect(requireRole([membership], allowed)).toBe(membership);
        } else {
          const error = thrownToolError(() => requireRole([membership], allowed));
          expect(error?.kind).toBe('forbidden');
          expect(error?.code).toBe('INSUFFICIENT_ROLE');
        }
      });
    }
  }

  it('distinguishes "not a member" (no memberships at all)', () => {
    const error = thrownToolError(() => requireRole([], ['OWNER']));
    expect(error?.kind).toBe('forbidden');
    expect(error?.code).toBe('NOT_A_MEMBER');
  });

  it('"not a member" also applies when no role filter is given', () => {
    const error = thrownToolError(() => requireRole([], null));
    expect(error?.code).toBe('NOT_A_MEMBER');
  });

  it('null allowedRoles admits any member (first membership wins)', () => {
    expect(requireRole([student, owner], null)).toBe(student);
  });

  it('empty allowedRoles behaves like null (any member)', () => {
    expect(requireRole([student], [])).toBe(student);
  });

  it('multi-role user: picks the membership satisfying the filter', () => {
    // A user can hold several roles in one classroom (unique on
    // classroom_id+user_id+role); the satisfying row must be returned.
    expect(requireRole([student, assistant], ['OWNER', 'TEACHER', 'ASSISTANT'])).toBe(assistant);
  });
});
