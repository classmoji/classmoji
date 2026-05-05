import { describe, it, expect } from 'vitest';
import { initialsFor, avatarTintFor } from '../leaderboardHelpers';

describe('initialsFor', () => {
  it('uses both initials of a two-part name', () => {
    expect(initialsFor({ name: 'Ada Lovelace' })).toBe('AL');
  });

  it('uses just the first initial when name is single-word', () => {
    expect(initialsFor({ name: 'Ada' })).toBe('A');
  });

  it('falls back to login when name is null/empty', () => {
    expect(initialsFor({ name: null, login: 'ada-l' })).toBe('a');
    expect(initialsFor({ name: '', login: 'ada-l' })).toBe('a');
  });

  it('returns "?" when both name and login are nullish', () => {
    expect(initialsFor({ name: null, login: null })).toBe('?');
    expect(initialsFor({})).toBe('?');
  });

  it('does not crash on whitespace-only name (returns "?" — name is truthy)', () => {
    // Documents current behavior: empty-after-trim does NOT fall back to login
    // because the truthiness check happens before trim. Captured here so a
    // future tightening of this rule will deliberately update this test.
    expect(initialsFor({ name: '   ', login: 'fallback' })).toBe('?');
  });

  it('uppercase preserved as-is, doesn’t force-uppercase', () => {
    expect(initialsFor({ name: 'alan turing' })).toBe('at');
  });
});

describe('avatarTintFor', () => {
  it('returns the same tint for indices in the same modulo class', () => {
    expect(avatarTintFor(0)).toBe(avatarTintFor(6));
    expect(avatarTintFor(1)).toBe(avatarTintFor(7));
  });

  it('returns 6 distinct tints for 0..5', () => {
    const tints = new Set([0, 1, 2, 3, 4, 5].map(avatarTintFor));
    expect(tints.size).toBe(6);
  });
});
