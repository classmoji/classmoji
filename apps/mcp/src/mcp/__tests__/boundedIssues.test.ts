/**
 * Bounded validation messages (boundedIssues.ts): the trimming itself, and
 * that registering every real tool through it leaves tools/list exactly as
 * the SDK renders the raw shapes.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  boundIssues,
  MAX_ISSUE_MESSAGE_CHARS,
  MAX_ISSUES_TEXT_CHARS,
  MAX_REPORTED_ISSUES,
  withBoundedIssues,
} from '../boundedIssues.ts';

vi.mock('@classmoji/database', async () =>
  (await import('../../__tests__/prismaSchemaStub.ts')).databaseModuleMock()
);

const issue = (message: string, path: (string | number)[] = []): z.ZodIssue => ({
  code: z.ZodIssueCode.custom,
  message,
  path,
});

describe('boundIssues', () => {
  it('keeps short lists as they are', () => {
    const issues = [issue('a', ['x']), issue('b', ['y', 0])];
    expect(boundIssues(issues)).toEqual(issues);
  });

  it('keeps the first 20 and says how many more there were', () => {
    const issues = Array.from({ length: 1_000 }, (_, i) => issue('bad', ['items', i]));
    const bounded = boundIssues(issues);
    expect(bounded).toHaveLength(MAX_REPORTED_ISSUES + 1);
    expect(bounded.slice(0, 20)).toEqual(issues.slice(0, 20));
    expect(bounded[20].message).toBe('…and 980 more validation issues not shown');
  });

  it('cuts long messages and stays within the text budget', () => {
    const long = 'x'.repeat(5_000);
    const bounded = boundIssues(Array.from({ length: 50 }, () => issue(long, ['a'])));
    for (const kept of bounded.slice(0, -1)) {
      expect(kept.message.length).toBeLessThanOrEqual(MAX_ISSUE_MESSAGE_CHARS);
    }
    const text = bounded.map(i => `${i.message} at ${i.path.join('.')}`).join('\n');
    expect(text.length).toBeLessThanOrEqual(MAX_ISSUES_TEXT_CHARS + 100);
  });
});

describe('withBoundedIssues', () => {
  it('bounds safeParseAsync and leaves valid input alone', async () => {
    const schema = withBoundedIssues(z.object({ items: z.array(z.string()) }));
    const bad = await schema.safeParseAsync({ items: Array.from({ length: 100 }, () => 1) });
    expect(bad.success).toBe(false);
    if (!bad.success) expect(bad.error.issues).toHaveLength(21);
    const good = await schema.safeParseAsync({ items: ['a'] });
    expect(good).toEqual({ success: true, data: { items: ['a'] } });
  });
});

describe('every real tool', () => {
  let toolDefs: Array<{
    name: string;
    title?: string;
    description: string;
    inputSchema: z.ZodRawShape;
  }>;
  let buildMcpServer: typeof import('../registry.ts').buildMcpServer;

  beforeAll(async () => {
    const { registerAllTools } = await import('../../tools/index.ts');
    const registry = await import('../registry.ts');
    registerAllTools();
    toolDefs = registry.listToolDefinitions() as unknown as typeof toolDefs;
    buildMcpServer = registry.buildMcpServer;
  });

  async function listTools(server: McpServer) {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'list', version: '0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const { tools } = await client.listTools();
    return new Map(tools.map(t => [t.name, t.inputSchema]));
  }

  it('advertises exactly the input schema the SDK builds from its raw shape', async () => {
    const viewer = { userId: 'u', clientId: 'some-client', scopes: new Set(['read', 'write']) };
    const ours = await listTools(buildMcpServer(viewer));

    const reference = new McpServer({ name: 'reference', version: '0' });
    for (const def of toolDefs) {
      reference.registerTool(
        def.name,
        { description: def.description, inputSchema: def.inputSchema },
        async () => ({ content: [] })
      );
    }
    const expected = await listTools(reference);

    expect(ours.size).toBeGreaterThan(100);
    expect(ours.size).toBe(expected.size);
    for (const [name, schema] of expected) {
      expect(JSON.stringify(ours.get(name)), name).toBe(JSON.stringify(schema));
    }
  });
});
