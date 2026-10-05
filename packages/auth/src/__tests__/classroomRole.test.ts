import { describe, expect, it } from 'vitest';

import { canEditPages, highestRole } from '../classroomRole.ts';

describe('highestRole', () => {
  it('picks the most privileged row', () => {
    expect(highestRole(['STUDENT', 'OWNER', 'ASSISTANT'])).toBe('OWNER');
    expect(highestRole(['STUDENT', 'TEACHER'])).toBe('TEACHER');
    expect(highestRole([])).toBeNull();
  });
});

describe('canEditPages', () => {
  it('is OWNER or TEACHER', () => {
    expect(canEditPages('OWNER')).toBe(true);
    expect(canEditPages('TEACHER')).toBe(true);
    expect(canEditPages('ASSISTANT')).toBe(false);
    expect(canEditPages('STUDENT')).toBe(false);
    expect(canEditPages(null)).toBe(false);
  });
});
