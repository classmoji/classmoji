/**
 * Every registered tool that takes a submission id accepts both forms.
 *
 * Registry-driven rather than a hand-kept list: it registers the whole tool
 * manifest (tools/index.ts, which includes the resource-mirrored read tools),
 * walks every input whose key names a submission, and asserts the schema takes
 * a numeric (ISSUE-mode) id and a uuid. A new tool that declares a submission
 * id with `.uuid()` fails here without anyone having to add it to a list.
 *
 * It also reads the schemas the registry PUBLISHES over MCP, to pin what
 * clients see for a submission id: a string with the id pattern.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import type { ToolDefinition } from '../../mcp/registry.ts';

// Nothing here queries; the stub only keeps any import-time client off a DB.
vi.mock('@classmoji/database', async () =>
  (await import('../../__tests__/prismaSchemaStub.ts')).databaseModuleMock()
);

const NUMERIC_ID = '5482151816';
const UUID_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

/** Input keys that name a submission (GitRepoAssignment). */
const SUBMISSION_KEY = /submission|git_repo_assignment/i;

/**
 * Keys that match SUBMISSION_KEY but are not submission ids. Each is named
 * with its tool so a new match anywhere else is still checked.
 */
const NOT_SUBMISSION_IDS = new Set([
  'assignment_create.submission_mode', // ISSUE | REPO enum
  'list_form_responses.submission_state', // form response filter enum
]);

let tools: ToolDefinition<never>[];
let submissionInputs: Array<{ id: string; schema: z.ZodTypeAny }>;

beforeAll(async () => {
  const { registerAllTools } = await import('../index.ts');
  const { listToolDefinitions } = await import('../../mcp/registry.ts');
  registerAllTools();
  tools = listToolDefinitions();
  submissionInputs = tools.flatMap(tool =>
    Object.entries(tool.inputSchema)
      .filter(([key]) => SUBMISSION_KEY.test(key))
      .map(([key, schema]) => ({ id: `${tool.name}.${key}`, schema: schema as z.ZodTypeAny }))
      .filter(input => !NOT_SUBMISSION_IDS.has(input.id))
  );
}, 60_000);

/** Is this input a list of ids (git_repo_assignment_ids) rather than one? */
const isList = (schema: z.ZodTypeAny) => schema.safeParse([UUID_ID]).success;

describe('every registered submission-id input', () => {
  it('finds the known inputs, so the walk is actually looking', () => {
    expect(tools.length).toBeGreaterThan(50);
    expect(submissionInputs.map(i => i.id)).toEqual(
      expect.arrayContaining([
        'get_submission.submission_id',
        'grade_add.git_repo_assignment_id',
        'grade_remove.git_repo_assignment_id',
        'grade_remove_all.git_repo_assignment_id',
        'submission_late_override.git_repo_assignment_id',
        'submission_late_override.git_repo_assignment_ids',
        'grader_assign.git_repo_assignment_id',
        'grader_unassign.git_repo_assignment_id',
        'regrade_create.git_repo_assignment_id',
        'extension_purchase.git_repo_assignment_id',
      ])
    );
  });

  it('the excluded keys still exist, so the exclusions cannot go stale', () => {
    const allKeys = new Set(
      tools.flatMap(tool => Object.keys(tool.inputSchema).map(key => `${tool.name}.${key}`))
    );
    for (const id of NOT_SUBMISSION_IDS) expect(allKeys.has(id), id).toBe(true);
  });

  it('each accepts a numeric id and a uuid, and rejects junk', () => {
    const failures: string[] = [];
    for (const { id, schema } of submissionInputs) {
      const wrap = (v: unknown) => (isList(schema) ? [v] : v);
      if (!schema.safeParse(wrap(NUMERIC_ID)).success) failures.push(`${id}: numeric refused`);
      if (!schema.safeParse(wrap(UUID_ID)).success) failures.push(`${id}: uuid refused`);
      if (schema.safeParse(wrap('not-an-id')).success) failures.push(`${id}: junk accepted`);
    }
    expect(failures).toEqual([]);
  });
});

describe('the published schema for a submission id', () => {
  let published: Map<string, { properties?: Record<string, Record<string, unknown>> }>;

  beforeAll(async () => {
    const { buildMcpServer } = await import('../../mcp/registry.ts');
    const server = buildMcpServer({
      userId: 'schema-viewer',
      clientId: 'schema-test',
      scopes: new Set(['read', 'write']),
    } as never);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'schema-test', version: '0.0.0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const { tools: listed } = await client.listTools();
    published = new Map(listed.map(t => [t.name, t.inputSchema as never]));
  });

  it('is a string with the uuid-or-digits pattern, for every submission-id input', () => {
    for (const { id } of submissionInputs) {
      const [tool, key] = id.split('.');
      const prop = published.get(tool)?.properties?.[key];
      expect(prop, id).toBeDefined();
      const idSchema = (prop!.type === 'array' ? prop!.items : prop) as Record<string, unknown>;
      expect(idSchema.type, id).toBe('string');
      expect(idSchema.pattern, id).toBeDefined();
      const pattern = new RegExp(idSchema.pattern as string);
      expect(pattern.test(NUMERIC_ID), id).toBe(true);
      expect(pattern.test(UUID_ID), id).toBe(true);
      expect(pattern.test(UUID_ID.toUpperCase()), id).toBe(true);
      expect(pattern.test('not-an-id'), id).toBe(false);
    }
  });
});
