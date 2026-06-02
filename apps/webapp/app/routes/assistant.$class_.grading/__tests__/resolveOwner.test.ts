import { describe, it, expect, vi } from 'vitest';

// RepositoryAssignmentsTable pulls in antd + '~/...' UI barrels at import time.
// Stub those seams so we can import the module under the node test environment
// and exercise the Owner-cell null-safety rule in isolation. A full DOM render
// of the Ant Design Table isn't possible here (no jsdom/testing-library in the
// webapp dev deps), and the git_repo FK is required in the DB so an orphaned
// row can't be produced via E2E — hence this focused unit test of the guard.
vi.mock('antd', () => ({
  Switch: () => null,
  Table: () => null,
  Tooltip: () => null,
  Skeleton: () => null,
  Alert: () => null,
}));
vi.mock('~/components/features/analytics', () => ({ GitHubStatsPanel: () => null }));
vi.mock('~/utils/helpers.client', () => ({ openRepositoryAssignmentInGithub: () => {} }));
vi.mock('~/store', () => ({ default: () => ({ classroom: null }) }));
vi.mock('~/components', () => ({
  EmojiGrader: () => null,
  UserThumbnailView: () => null,
  SearchInput: () => null,
  Countdown: () => null,
  TableActionButtons: () => null,
  EmojisDisplay: () => null,
}));
vi.mock('react-router', () => ({ useParams: () => ({}) }));

const { resolveOwner } = await import('../RepositoryAssignmentsTable.tsx');

describe('RepositoryAssignmentsTable resolveOwner — git_repo null-safety', () => {
  it('returns undefined for a null/undefined git_repo (empty Owner cell, no throw)', () => {
    expect(resolveOwner(null)).toBeUndefined();
    expect(resolveOwner(undefined)).toBeUndefined();
  });

  it('returns undefined when the repo has neither student nor team', () => {
    expect(resolveOwner({ name: 'r', repository: { title: 'R' } })).toBeUndefined();
  });

  it('prefers the student over the team when both are present', () => {
    const student = { name: 'Stu', login: 'stu' };
    const team = { name: 'Team', slug: 'team' };
    expect(resolveOwner({ name: 'r', student, team, repository: { title: 'R' } })).toBe(student);
  });

  it('falls back to the team when there is no student', () => {
    const team = { name: 'Team', slug: 'team' };
    expect(resolveOwner({ name: 'r', team, repository: { title: 'R' } })).toBe(team);
  });
});
