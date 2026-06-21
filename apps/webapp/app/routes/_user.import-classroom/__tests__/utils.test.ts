import { describe, it, expect } from 'vitest';
import { slugify } from '../utils.ts';

// Import data is now pulled live from the GitHub Classroom API (no ZIP parsing),
// so the normalizer is tested in packages/services
// (githubClassroomApi.service.test.ts). Only the client-safe slugify lives here.

describe('slugify', () => {
  it('matches the create-classroom slug rules', () => {
    expect(slugify('Rendering Algorithms Fall 2024')).toBe('rendering-algorithms-fall-2024');
    expect(slugify('  CS87 -- Dartmouth!  ')).toBe('cs87-dartmouth');
  });
});
