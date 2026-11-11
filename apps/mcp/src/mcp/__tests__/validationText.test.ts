/**
 * What a client reads when a real tool refuses its arguments, through the
 * real SDK: the tool and the argument are named, the allowed values of an
 * enum are listed, and a long list of problems is cut to the first 20 with a
 * count of the rest. zod's own wording ("Required", "Invalid uuid") is not
 * pinned here: only what the text tells the reader.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@classmoji/database', async () =>
  (await import('../../__tests__/prismaSchemaStub.ts')).databaseModuleMock()
);

let client: Client;

beforeAll(async () => {
  const { registerAllTools } = await import('../../tools/index.ts');
  const registry = await import('../registry.ts');
  registerAllTools();
  const server = registry.buildMcpServer({
    userId: 'u',
    clientId: 'some-client',
    scopes: new Set(['read', 'write']),
  } as never);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'validation-text', version: '0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
});

async function refusal(name: string, args: Record<string, unknown>): Promise<string> {
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
  expect(result.isError).toBe(true);
  return result.content[0].text;
}

const PREFIX = 'MCP error -32602: Input validation error: Invalid arguments for tool';

describe('tool argument refusals', () => {
  it('names each missing required argument', async () => {
    const text = await refusal('list_form_responses', {});
    expect(text.startsWith(`${PREFIX} list_form_responses: `)).toBe(true);
    expect(text).toMatch(/\bclassroom\b/);
    expect(text).toMatch(/\bform_id\b/);
  });

  it('names a bad enum argument and lists the allowed values', async () => {
    const text = await refusal('list_form_responses', {
      classroom: 'org/class',
      form_id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      submission_state: 'nope',
    });
    expect(text.startsWith(`${PREFIX} list_form_responses: `)).toBe(true);
    expect(text).toMatch(/\bsubmission_state\b/);
    for (const allowed of ['DRAFT', 'PENDING_VERIFICATION', 'SUBMITTED']) {
      expect(text).toContain(allowed);
    }
  });

  it('names a malformed id argument and says it is not a uuid', async () => {
    const text = await refusal('list_form_responses', {
      classroom: 'org/class',
      form_id: 'not-an-id',
    });
    expect(text).toMatch(/\bform_id\b/);
    expect(text).toMatch(/uuid/i);
  });

  it('cuts a long list of problems to the first 20 and counts the rest', async () => {
    const text = await refusal('page_content_apply', {
      classroom: 'org/class',
      page_id: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
      ops: Array.from({ length: 25 }, () => ({ op: 'delete' })),
    });
    expect(text.startsWith(`${PREFIX} page_content_apply: `)).toBe(true);
    expect(text.length).toBeLessThanOrEqual(4_096);
    expect(text).toMatch(/…and \d+ more validation issues not shown$/);
  });
});
