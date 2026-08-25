/**
 * Unit tests for assistant_add / assistant_update / assistant_remove.
 *
 * Security focus: the classroomId handed to every service call comes from the
 * ToolContext, never from args; the service's caller-fixable failures map onto
 * the right ToolError kinds (an unknown/foreign assistant is the uniform
 * scopedNotFound, so a probe cannot enumerate another classroom's staff); and
 * no mutation is left un-audited — while the no-op "already an assistant" path,
 * which mutates nothing, writes no audit row.
 *
 * `@classmoji/services` is mocked (factory idiom) INCLUDING AssistantServiceError,
 * so the handlers' `instanceof` mapping runs against the same class the test
 * throws — no real GitHub invites and no Trigger.dev runs.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolContext } from '../../mcp/registry.ts';

const mocks = vi.hoisted(() => ({
  addAssistant: vi.fn(),
  updateAssistant: vi.fn(),
  removeAssistant: vi.fn(),
  auditCreate: vi.fn(),
}));

vi.mock('@classmoji/services', () => {
  // Same shape as the real service error; the tools branch on `instanceof`, so
  // the class the handler imports must be the class the test constructs.
  class AssistantServiceError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = 'AssistantServiceError';
      this.code = code;
    }
  }
  return {
    AssistantServiceError,
    ClassmojiService: {
      assistant: {
        addAssistant: (...a: unknown[]) => mocks.addAssistant(...a),
        updateAssistant: (...a: unknown[]) => mocks.updateAssistant(...a),
        removeAssistant: (...a: unknown[]) => mocks.removeAssistant(...a),
      },
      audit: { create: (...a: unknown[]) => mocks.auditCreate(...a) },
    },
  };
});

const { AssistantServiceError } = await import('@classmoji/services');
const { assistantAddTool, assistantUpdateTool, assistantRemoveTool } =
  await import('../assistants.ts');

const CTX: ToolContext = {
  viewer: { userId: 'owner-1', clientId: 'c', scopes: new Set(['read', 'write']) },
  classroom: {
    classroomId: 'class-1',
    role: 'OWNER',
    status: 'ACTIVE',
    membership: { id: 'm-1', role: 'OWNER' },
    classroom: { settings: {} },
  },
} as unknown as ToolContext;

function parse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

/** The audit row the handler wrote (first call). */
function auditRow() {
  return mocks.auditCreate.mock.calls[0][0] as {
    action: string;
    classroom_id: string;
    resource_type: string;
    resource_id?: string | null;
    data: Record<string, unknown>;
  };
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.auditCreate.mockResolvedValue(undefined);
});

describe('assistant_add', () => {
  const ARGS = { classroom: 'org/w26', login: 'ta-ann', name: 'Ann', email: 'ann@x.edu' };

  it('adds via the service using ctx classroomId and reports the pending org invite', async () => {
    mocks.addAssistant.mockResolvedValue({
      created: true,
      alreadyExists: false,
      userId: 'ta-1',
      login: 'ta-ann',
      name: 'Ann',
      alreadyOrgMember: false,
    });

    const payload = parse(await assistantAddTool.handler(ARGS, CTX));
    expect(payload).toMatchObject({
      success: true,
      created: true,
      already_exists: false,
      login: 'ta-ann',
      user_id: 'ta-1',
      github: 'invited',
      invite_pending: true,
    });

    // classroomId comes from ctx, never from args.
    expect(mocks.addAssistant).toHaveBeenCalledWith({
      classroomId: 'class-1',
      login: 'ta-ann',
      name: 'Ann',
      email: 'ann@x.edu',
    });

    const audit = auditRow();
    expect(audit.action).toBe('CREATE');
    expect(audit.classroom_id).toBe('class-1');
    expect(audit.resource_id).toBe('ta-1');
    expect(audit.data).toMatchObject({ tool: 'assistant_add', login: 'ta-ann' });
  });

  it('reports a team add (no pending invite) when they were already in the org', async () => {
    mocks.addAssistant.mockResolvedValue({
      created: true,
      alreadyExists: false,
      userId: 'ta-1',
      login: 'ta-ann',
      name: 'Ann',
      alreadyOrgMember: true,
    });

    const payload = parse(await assistantAddTool.handler(ARGS, CTX));
    expect(payload).toMatchObject({ github: 'team_added', invite_pending: false });
  });

  it('is idempotent: an existing assistant is a no-op and writes NO audit row', async () => {
    mocks.addAssistant.mockResolvedValue({
      created: false,
      alreadyExists: true,
      userId: 'ta-1',
      login: 'ta-ann',
      name: 'Ann',
      alreadyOrgMember: true,
    });

    const payload = parse(await assistantAddTool.handler(ARGS, CTX));
    expect(payload).toMatchObject({ success: true, created: false, already_exists: true });
    // Nothing was mutated (the service short-circuits before any write), so
    // there is no mutation to audit.
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('maps git_user_not_found to a not_found error and audits nothing', async () => {
    mocks.addAssistant.mockRejectedValue(
      new AssistantServiceError('git_user_not_found', '[assistant] git user nope not found')
    );

    await expect(assistantAddTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'not_found',
      message: 'GitHub user not found',
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('maps no_org_configured to invalid_params', async () => {
    mocks.addAssistant.mockRejectedValue(
      new AssistantServiceError('no_org_configured', '[assistant] no git organization')
    );

    await expect(assistantAddTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'invalid_params',
    });
  });

  it('lets an unexpected service failure through for the generic wrapper', async () => {
    mocks.addAssistant.mockRejectedValue(new Error('boom'));
    await expect(assistantAddTool.handler(ARGS, CTX)).rejects.toThrow('boom');
  });
});

describe('assistant_update', () => {
  const ARGS = { classroom: 'org/w26', login: 'ta-ann', is_grader: true };

  it('flips is_grader via the service using ctx classroomId and audits the update', async () => {
    mocks.updateAssistant.mockResolvedValue({ id: 'm-2', is_grader: true });

    const payload = parse(await assistantUpdateTool.handler(ARGS, CTX));
    expect(payload).toMatchObject({ success: true, login: 'ta-ann', is_grader: true });

    expect(mocks.updateAssistant).toHaveBeenCalledWith({
      classroomId: 'class-1',
      login: 'ta-ann',
      isGrader: true,
    });

    const audit = auditRow();
    expect(audit.action).toBe('UPDATE');
    expect(audit.classroom_id).toBe('class-1');
    expect(audit.data).toMatchObject({ tool: 'assistant_update', is_grader: true });
  });

  it('refuses someone who is not an assistant here (uniform scopedNotFound)', async () => {
    mocks.updateAssistant.mockRejectedValue(
      new AssistantServiceError('assistant_not_found', '[assistant] not an assistant')
    );

    await expect(assistantUpdateTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'not_found',
      message: 'Assistant not found in this classroom',
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });
});

describe('assistant_remove', () => {
  const ARGS = { classroom: 'org/w26', login: 'ta-ann', confirm: true as const };

  it('queues the removal without waiting for the run and audits the DELETE', async () => {
    mocks.removeAssistant.mockResolvedValue({ userId: 'ta-1', login: 'ta-ann', runId: 'run-1' });

    const payload = parse(await assistantRemoveTool.handler(ARGS, CTX));
    // queued:true — the service awaited the ENQUEUE only; unlike the web route
    // we never waitForRunCompletion, and the run id is not surfaced.
    expect(payload).toMatchObject({
      success: true,
      queued: true,
      login: 'ta-ann',
      user_id: 'ta-1',
    });
    expect(payload.run_id).toBeUndefined();

    expect(mocks.removeAssistant).toHaveBeenCalledWith({
      classroomId: 'class-1',
      login: 'ta-ann',
    });

    const audit = auditRow();
    expect(audit.action).toBe('DELETE');
    expect(audit.classroom_id).toBe('class-1');
    expect(audit.resource_id).toBe('ta-1');
    expect(audit.data).toMatchObject({ tool: 'assistant_remove', login: 'ta-ann' });
  });

  it('refuses an unknown / cross-classroom assistant and audits nothing', async () => {
    mocks.removeAssistant.mockRejectedValue(
      new AssistantServiceError('assistant_not_found', '[assistant] user nope not found')
    );

    await expect(assistantRemoveTool.handler(ARGS, CTX)).rejects.toMatchObject({
      kind: 'not_found',
      message: 'Assistant not found in this classroom',
    });
    expect(mocks.auditCreate).not.toHaveBeenCalled();
  });

  it('requires confirm:true in the schema (destructive gate)', () => {
    // The registry validates inputSchema before the handler runs, so the gate
    // lives in the schema: only the literal `true` is accepted.
    const confirm = assistantRemoveTool.inputSchema.confirm;
    expect(confirm.safeParse(true).success).toBe(true);
    expect(confirm.safeParse(false).success).toBe(false);
    expect(confirm.safeParse(undefined).success).toBe(false);
  });
});
