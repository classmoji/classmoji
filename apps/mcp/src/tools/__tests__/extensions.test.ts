/**
 * Unit tests for extension_purchase: who may buy hours on which submission.
 *
 * The caller always pays from their own balance; the submission must be their
 * own repo or a repo of a team they are on, as on the web. Anything else gets
 * the same not-found error as a submission that does not exist. Pricing and
 * the balance check live in the service (mocked here).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToolError } from '../../mcp/errors.ts';
import type { ToolContext } from '../../mcp/registry.ts';

const mocks = vi.hoisted(() => ({
  findById: vi.fn(),
  isTeamMember: vi.fn(),
  purchaseExtensionHours: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock('@classmoji/services', () => ({
  ClassmojiService: {
    gitRepoAssignment: { findById: (...a: unknown[]) => mocks.findById(...a) },
    teamMembership: { isTeamMember: (...a: unknown[]) => mocks.isTeamMember(...a) },
    token: { purchaseExtensionHours: (...a: unknown[]) => mocks.purchaseExtensionHours(...a) },
    audit: { create: (...a: unknown[]) => mocks.auditCreate(...a) },
  },
}));

const { extensionPurchaseTool } = await import('../extensions.ts');

const SUB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CLASSROOM = 'test-org/winter-2025';

const CTX: ToolContext = {
  viewer: { userId: 'student-1', clientId: 'c', scopes: new Set(['read', 'write']) },
  classroom: {
    classroomId: 'class-1',
    role: 'STUDENT',
    status: 'ACTIVE',
    membership: { id: 'm-1', role: 'STUDENT' },
    classroom: { settings: {} },
  },
} as unknown as ToolContext;

const submission = (gitRepo: { student_id: string | null; team_id: string | null }) => ({
  id: SUB,
  git_repo: { classroom_id: 'class-1', ...gitRepo },
});

const buy = () =>
  extensionPurchaseTool.handler(
    { classroom: CLASSROOM, git_repo_assignment_id: SUB, hours: 2 },
    CTX
  );

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.auditCreate.mockResolvedValue(undefined);
  mocks.isTeamMember.mockResolvedValue(false);
  mocks.purchaseExtensionHours.mockResolvedValue({
    id: 'tx-1',
    hours_purchased: 2,
    amount: -6,
    balance_after: 94,
  });
});

describe('extension_purchase', () => {
  it("sells hours on the caller's own repo without a team lookup", async () => {
    mocks.findById.mockResolvedValue(submission({ student_id: 'student-1', team_id: null }));

    const result = JSON.parse((await buy()).content[0].text);

    expect(result.success).toBe(true);
    expect(mocks.isTeamMember).not.toHaveBeenCalled();
    expect(mocks.purchaseExtensionHours).toHaveBeenCalledWith({
      classroomId: 'class-1',
      studentId: 'student-1',
      gitRepoAssignmentId: SUB,
      hours: 2,
    });
  });

  it("sells hours on a team's repo to a member, paid from the member's own balance", async () => {
    mocks.findById.mockResolvedValue(submission({ student_id: null, team_id: 'team-1' }));
    mocks.isTeamMember.mockResolvedValue(true);

    const result = JSON.parse((await buy()).content[0].text);

    expect(result.success).toBe(true);
    expect(mocks.isTeamMember).toHaveBeenCalledWith('team-1', 'student-1');
    expect(mocks.purchaseExtensionHours).toHaveBeenCalledWith(
      expect.objectContaining({ studentId: 'student-1', gitRepoAssignmentId: SUB })
    );
  });

  it("refuses a team's repo to a non-member with the not-found error", async () => {
    mocks.findById.mockResolvedValue(submission({ student_id: null, team_id: 'team-1' }));

    const err = await buy().catch(e => e);

    expect(err).toBeInstanceOf(ToolError);
    expect((err as ToolError).kind).toBe('not_found');
    expect((err as ToolError).message).toBe('Submission not found in this classroom');
    expect(mocks.purchaseExtensionHours).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("refuses a member of another team, asking about the repo's own team", async () => {
    // The caller is on team-2; the submission belongs to team-1.
    mocks.isTeamMember.mockImplementation(
      async (teamId: string, userId: string) => teamId === 'team-2' && userId === 'student-1'
    );
    mocks.findById.mockResolvedValue(submission({ student_id: null, team_id: 'team-1' }));

    const err = await buy().catch(e => e);

    expect(mocks.isTeamMember).toHaveBeenCalledWith('team-1', 'student-1');
    expect((err as ToolError).kind).toBe('not_found');
    expect((err as ToolError).message).toBe('Submission not found in this classroom');
    expect(mocks.purchaseExtensionHours).not.toHaveBeenCalled();
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it("refuses a classmate's individual repo the same way", async () => {
    mocks.findById.mockResolvedValue(submission({ student_id: 'student-2', team_id: null }));

    const err = await buy().catch(e => e);

    expect((err as ToolError).kind).toBe('not_found');
    expect((err as ToolError).message).toBe('Submission not found in this classroom');
    expect(mocks.isTeamMember).not.toHaveBeenCalled();
    expect(mocks.purchaseExtensionHours).not.toHaveBeenCalled();
  });

  it('refuses a submission from another classroom the same way', async () => {
    mocks.findById.mockResolvedValue({
      id: SUB,
      git_repo: { classroom_id: 'class-2', student_id: 'student-1', team_id: null },
    });

    const err = await buy().catch(e => e);

    expect((err as ToolError).message).toBe('Submission not found in this classroom');
    expect(mocks.purchaseExtensionHours).not.toHaveBeenCalled();
  });
});
