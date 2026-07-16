import { describe, it, expect } from 'vitest';
import type { Role } from '@prisma/client';
import { buildSuggestions, FACULTY_SUGGESTIONS, STUDENT_SUGGESTIONS } from '../suggestions.ts';

describe('buildSuggestions', () => {
  it('returns only faculty prompts for a staff-only user', () => {
    const s = buildSuggestions(['OWNER'] as Role[]);
    expect(s.faculty).toEqual([...FACULTY_SUGGESTIONS]);
    expect(s.student).toBeUndefined();
  });

  it('returns only student prompts for a student-only user', () => {
    const s = buildSuggestions(['STUDENT'] as Role[]);
    expect(s.student).toEqual([...STUDENT_SUGGESTIONS]);
    expect(s.faculty).toBeUndefined();
  });

  it('returns both for a user who is staff in one class and a student in another', () => {
    const s = buildSuggestions(['ASSISTANT', 'STUDENT'] as Role[]);
    expect(s.faculty).toBeDefined();
    expect(s.student).toBeDefined();
  });

  it('treats every staff role (OWNER/TEACHER/ASSISTANT) as faculty', () => {
    for (const role of ['OWNER', 'TEACHER', 'ASSISTANT'] as Role[]) {
      const s = buildSuggestions([role]);
      expect(s.faculty).toBeDefined();
      expect(s.student).toBeUndefined();
    }
  });

  it('returns an empty object for a user with no memberships', () => {
    expect(buildSuggestions([])).toEqual({});
  });

  it('returns fresh array copies (callers cannot mutate the shared constants)', () => {
    const faculty = buildSuggestions(['OWNER'] as Role[]).faculty ?? [];
    faculty.push('mutated');
    expect(FACULTY_SUGGESTIONS).not.toContain('mutated');
  });
});
