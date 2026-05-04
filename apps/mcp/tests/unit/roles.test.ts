import { describe, expect, it } from 'vitest';
import type { Role } from '@prisma/client';
import {
  highestRole,
  isOwnerInAny,
  isPrivilegedRole,
  isStaffInAny,
  isStudentInAny,
  isTeachingInAny,
} from '../../src/auth/roles.ts';

const set = (...roles: Role[]) => new Set<Role>(roles);

describe('role helpers — exact alignment with webapp route auth', () => {
  it('isOwnerInAny is OWNER-only', () => {
    expect(isOwnerInAny(set('OWNER'))).toBe(true);
    expect(isOwnerInAny(set('TEACHER'))).toBe(false);
    expect(isOwnerInAny(set('ASSISTANT'))).toBe(false);
    expect(isOwnerInAny(set('STUDENT'))).toBe(false);
    expect(isOwnerInAny(set('TEACHER', 'STUDENT'))).toBe(false);
    expect(isOwnerInAny(set('OWNER', 'STUDENT'))).toBe(true);
  });

  it('isStaffInAny is OWNER + TEACHER', () => {
    expect(isStaffInAny(set('OWNER'))).toBe(true);
    expect(isStaffInAny(set('TEACHER'))).toBe(true);
    expect(isStaffInAny(set('ASSISTANT'))).toBe(false);
    expect(isStaffInAny(set('STUDENT'))).toBe(false);
  });

  it('isTeachingInAny is OWNER + TEACHER + ASSISTANT', () => {
    expect(isTeachingInAny(set('OWNER'))).toBe(true);
    expect(isTeachingInAny(set('TEACHER'))).toBe(true);
    expect(isTeachingInAny(set('ASSISTANT'))).toBe(true);
    expect(isTeachingInAny(set('STUDENT'))).toBe(false);
  });

  it('isStudentInAny is STUDENT-only', () => {
    expect(isStudentInAny(set('STUDENT'))).toBe(true);
    expect(isStudentInAny(set('OWNER'))).toBe(false);
    expect(isStudentInAny(set('OWNER', 'STUDENT'))).toBe(true);
  });

  it('isPrivilegedRole flags every role except STUDENT', () => {
    expect(isPrivilegedRole('OWNER')).toBe(true);
    expect(isPrivilegedRole('TEACHER')).toBe(true);
    expect(isPrivilegedRole('ASSISTANT')).toBe(true);
    expect(isPrivilegedRole('STUDENT')).toBe(false);
  });
});

describe('highestRole', () => {
  it('orders OWNER > TEACHER > ASSISTANT > STUDENT', () => {
    expect(highestRole(set('STUDENT', 'TEACHER'))).toBe('TEACHER');
    expect(highestRole(set('STUDENT', 'OWNER', 'ASSISTANT'))).toBe('OWNER');
    expect(highestRole(set('ASSISTANT', 'STUDENT'))).toBe('ASSISTANT');
    expect(highestRole(set('STUDENT'))).toBe('STUDENT');
  });

  it('accepts arrays as well as sets', () => {
    expect(highestRole(['STUDENT', 'TEACHER'])).toBe('TEACHER');
  });
});
