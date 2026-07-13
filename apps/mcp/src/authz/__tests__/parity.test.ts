/**
 * PARITY PIN (plan §8.1, S4): the pure predicates in src/authz/pure.ts are
 * hand-mirrored from @classmoji/auth/server (they are duplicated because that
 * module constructs betterAuth at import time and its assert* variants throw
 * web `Response` objects — see the pure.ts docblock). This suite imports the
 * REAL webapp predicates and asserts our mirrors agree on the FULL
 * status × role matrix, so any future edit to the webapp gates that is not
 * mirrored here fails CI instead of silently diverging.
 *
 * Importing @classmoji/auth/server pulls in betterAuth + a PrismaClient
 * construction, but neither touches the network/DB at import time in
 * non-production NODE_ENV (Prisma connects lazily on first query; betterAuth
 * falls back to its dev secret), so this stays a pure unit test.
 */

import { describe, expect, it } from 'vitest';
import type { ClassroomStatus, Role } from '@prisma/client';
import {
  assertClassroomEntryAllowed,
  assertClassroomMutationAllowed,
  canMutateClassroom as realCanMutateClassroom,
} from '@classmoji/auth/server';
import {
  assertEntryAllowed,
  assertMutationAllowed,
  canEnterClassroom,
  canMutateClassroom,
} from '../pure.ts';
import { ToolError } from '../../mcp/errors.ts';

const ROLES: Role[] = ['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT'];
const STATUSES: ClassroomStatus[] = ['ACTIVE', 'LOCKED', 'UNPUBLISHED'];

/** The real entry gate throws a web Response on denial — reduce to boolean. */
function realEntryAllowed(input: { status: ClassroomStatus; role: Role }): boolean {
  try {
    assertClassroomEntryAllowed(input);
    return true;
  } catch (error) {
    expect(error).toBeInstanceOf(Response);
    return false;
  }
}

/** Extract the typed error code from a thrown webapp 403 Response. */
async function realDenialCode(fn: () => void): Promise<string | null> {
  try {
    fn();
    return null;
  } catch (error) {
    expect(error).toBeInstanceOf(Response);
    const body = (await (error as Response).json()) as { error: string };
    return body.error;
  }
}

/** Extract the typed error code from our thrown ToolError. */
function ourDenialCode(fn: () => void): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    expect(error).toBeInstanceOf(ToolError);
    return (error as ToolError).code ?? null;
  }
}

describe('authz parity: pure.ts mirrors @classmoji/auth/server exactly', () => {
  for (const status of STATUSES) {
    for (const role of ROLES) {
      const input = { status, role };

      it(`entry gate agrees for ${role} on ${status}`, () => {
        expect(canEnterClassroom(input)).toBe(realEntryAllowed(input));
      });

      it(`mutation gate agrees for ${role} on ${status}`, () => {
        expect(canMutateClassroom(input)).toBe(realCanMutateClassroom(input));
      });

      it(`denial codes agree for ${role} on ${status}`, async () => {
        // Entry gate: same typed code (CLASSROOM_UNPUBLISHED) or both allow.
        expect(ourDenialCode(() => assertEntryAllowed(input))).toBe(
          await realDenialCode(() => assertClassroomEntryAllowed(input))
        );
        // Mutation gate: same typed code (CLASSROOM_LOCKED / CLASSROOM_UNPUBLISHED)
        // or both allow.
        expect(ourDenialCode(() => assertMutationAllowed(input))).toBe(
          await realDenialCode(() => assertClassroomMutationAllowed(input))
        );
      });
    }
  }
});
