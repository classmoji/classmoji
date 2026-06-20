import { describe, it, expect } from 'vitest';
import { buildImportedMetadata, deriveTeamSlug } from '../githubClassroomImport.service.ts';
import type { ImportAcceptance } from '../githubClassroomImport.service.ts';

const baseAcc = (over: Partial<ImportAcceptance> = {}): ImportAcceptance => ({
  type: 'individual',
  students: [{ providerId: '1', login: 'alice', name: 'Alice' }],
  repo: { providerId: '500', name: 'hw1-alice', htmlUrl: 'https://github.com/org/hw1-alice' },
  commitCount: 12,
  submitted: true,
  passing: false,
  grade: null,
  ...over,
});

describe('buildImportedMetadata', () => {
  it('records points and export info when a grade is present', () => {
    const meta = buildImportedMetadata(baseAcc(), {
      pointsAwarded: '80',
      pointsAvailable: '100',
      submissionTimestamp: '2025-01-02T00:00:00Z',
    })!;
    expect(meta).toMatchObject({
      source: 'github_classroom',
      points_awarded: '80',
      points_available: '100',
      submission_timestamp: '2025-01-02T00:00:00Z',
      commit_count: 12,
      submitted: true,
      passing: false,
      original_url: 'https://github.com/org/hw1-alice',
    });
  });

  it('still records export info (commit count etc.) when there is no grade', () => {
    const meta = buildImportedMetadata(baseAcc(), null)!;
    expect(meta.source).toBe('github_classroom');
    expect(meta.commit_count).toBe(12);
    expect(meta).not.toHaveProperty('points_awarded');
  });

  it('omits fields that are absent (no points / no url) but keeps what it has', () => {
    const meta = buildImportedMetadata(
      // commit count present, but no grade and repo has no html_url.
      {
        type: 'individual',
        students: [],
        repo: null,
        commitCount: 3,
        submitted: false,
        passing: false,
      },
      null
    )!;
    expect(meta.commit_count).toBe(3);
    expect(meta).not.toHaveProperty('points_awarded');
    expect(meta).not.toHaveProperty('original_url');
  });

  it('returns null when there is nothing beyond the source tag', () => {
    expect(
      buildImportedMetadata({ type: 'individual', students: [], repo: null }, null)
    ).toBeNull();
  });

  it('handles a group acceptance (multiple students, shared grade) unchanged', () => {
    const groupAcc: ImportAcceptance = {
      type: 'group',
      students: [
        { providerId: '1', login: 'alice', name: 'Alice' },
        { providerId: '2', login: 'bob', name: 'Bob' },
      ],
      repo: {
        providerId: '900',
        name: 'proj1-avengers',
        htmlUrl: 'https://github.com/org/proj1-avengers',
      },
      commitCount: 7,
      submitted: true,
      passing: true,
    };
    const meta = buildImportedMetadata(groupAcc, { pointsAwarded: '18', pointsAvailable: '20' })!;
    expect(meta).toMatchObject({
      source: 'github_classroom',
      points_awarded: '18',
      points_available: '20',
      commit_count: 7,
      passing: true,
      original_url: 'https://github.com/org/proj1-avengers',
    });
  });
});

describe('deriveTeamSlug', () => {
  it('strips the assignment-slug prefix from the repo name', () => {
    expect(deriveTeamSlug('proj1-avengers', 'proj1', ['alice', 'bob'])).toBe('avengers');
  });

  it('strips only the leading prefix once (team name may contain the slug)', () => {
    expect(deriveTeamSlug('proj-proj-team-a', 'proj', ['x'])).toBe('proj-team-a');
  });

  it('is case-insensitive on the prefix', () => {
    expect(deriveTeamSlug('Proj1-Avengers', 'proj1', ['x'])).toBe('avengers');
  });

  it('returns the stripped slug verbatim (does not re-slugify)', () => {
    // A slug titleToIdentifier would leave alone, but we assert verbatim passthrough.
    expect(deriveTeamSlug('hw2-team-99', 'hw2', ['x'])).toBe('team-99');
  });

  it('falls back to a sorted member-set signature when the prefix does not match', () => {
    expect(deriveTeamSlug('hw-old-name', 'newslug', ['bob', 'alice'])).toBe('team-alice-bob');
  });

  it('falls back when the assignment slug is empty', () => {
    expect(deriveTeamSlug('whatever', '', ['carol', 'bob'])).toBe('team-bob-carol');
  });

  it('fallback is order-independent (deterministic for re-import)', () => {
    expect(deriveTeamSlug('x', 'y', ['bob', 'alice', 'carol'])).toBe(
      deriveTeamSlug('x', 'y', ['carol', 'bob', 'alice'])
    );
  });

  it('caps a very long member-set slug deterministically', () => {
    const many = Array.from({ length: 30 }, (_, i) => `student-with-a-long-login-${i}`);
    const slug = deriveTeamSlug('no-match', 'zzz', many)!;
    expect(slug.length).toBeLessThanOrEqual(64);
    expect(slug).toBe(deriveTeamSlug('no-match', 'zzz', [...many].reverse()));
  });

  it('guards against an empty result when the prefix equals the whole name', () => {
    // "proj1-" with slug "proj1" would strip to "" → must not return empty string.
    const slug = deriveTeamSlug('proj1-', 'proj1', ['alice']);
    expect(slug).toBe('team-alice');
  });

  it('returns null when there is no repo name and no members', () => {
    expect(deriveTeamSlug('', '', [])).toBeNull();
  });
});
