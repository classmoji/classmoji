/**
 * Tool/resource registry — the uniform enforcement layer (S5, S6, S7).
 *
 * Every capability this server exposes is declared as a `ToolDefinition` /
 * `ResourceDefinition` and registered here. The registry — not the handler —
 * enforces, in order, BEFORE any handler code runs:
 *
 *   1. scope   (S7: every surface declares 'read' or 'write'; tokens missing
 *               the scope never even see the tool in tools/list, and a
 *               defense-in-depth check runs again at call time)
 *   2. rate limit (S6: per-user per-tool token bucket)
 *   3. classroom + role resolution (when `roles` is non-null the tool MUST
 *      take a `classroom` ('org/slug') argument; the registry resolves it,
 *      applies the role set and the UNPUBLISHED entry gate, and hands the
 *      handler a ready ClassroomContext)
 *   4. mutation gate (write-scope tools on a classroom: non-owners mutate
 *      only when the classroom is ACTIVE)
 *
 * Handlers are wrapped so ANY thrown error becomes a structured `isError`
 * tool result (S5) — never a hung request or a crashed process.
 *
 * HOW TO ADD A TOOL (Phase 2):
 *   1. Create src/tools/<name>.ts exporting a `ToolDefinition`.
 *   2. Import and add it to the list in src/tools/index.ts.
 *   3. In the handler, do S1 target-ownership checks by comparing ids
 *      against `ctx.classroom.classroomId`, route mutations through
 *      packages/services orchestrators, and write an audit-log entry for
 *      every mutation (ClassmojiService.audit.create).
 * Resources follow the same shape via `ResourceDefinition` (scope is always
 * 'read'); they get the identical enforcement pipeline.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Role } from '@prisma/client';
import type { ZodRawShape } from 'zod';
import type { Viewer } from '../auth/resolveViewer.ts';
import { resolveClassroomContext, type ClassroomContext } from '../authz/classroomContext.ts';
import { assertMutationAllowed } from '../authz/pure.ts';
import { ToolError } from './errors.ts';
import { DEFAULT_RATE_LIMIT, tryConsume, type RateLimitConfig } from './rateLimit.ts';

export type Scope = 'read' | 'write';

/** Context handed to every handler after the enforcement pipeline passes. */
export interface ToolContext {
  viewer: Viewer;
  /** Present iff the tool declared a non-null `roles` (classroom-bound). */
  classroom?: ClassroomContext;
}

export interface ToolResult {
  [key: string]: unknown;
  content: Array<{ [key: string]: unknown; type: 'text'; text: string }>;
  isError?: boolean;
}

export interface ToolDefinition<Args = Record<string, unknown>> {
  /** Unique tool name (platform vocabulary, snake_case — e.g. 'grade_add'). */
  name: string;
  title: string;
  description: string;
  /** S7: every tool declares exactly one scope. */
  scope: Scope;
  /**
   * Per-classroom role gate. `null` = any authenticated user (identity /
   * bootstrap tools). Non-null = the tool is classroom-bound: its inputSchema
   * MUST include `classroom: z.string()` taking an `org/slug` reference, and
   * the registry resolves + role-gates it before the handler runs. Use the
   * route-derived tiers from plan §4.2 — never guess.
   */
  roles: readonly Role[] | null;
  /** Zod raw shape (v1.x SDK registerTool style). */
  inputSchema: ZodRawShape;
  /** Optional per-tool override of the default rate limit (S6). */
  rateLimit?: RateLimitConfig;
  handler: (args: Args, ctx: ToolContext) => Promise<ToolResult>;
}

const toolDefinitions = new Map<string, ToolDefinition<never>>();

export function registerToolDefinition<Args>(def: ToolDefinition<Args>): void {
  if (toolDefinitions.has(def.name)) {
    throw new Error(`[mcp] duplicate tool definition: ${def.name}`);
  }
  if (def.roles && !('classroom' in def.inputSchema)) {
    // Fail at startup, not at call time: a role-gated tool without a
    // classroom argument has nothing to gate against.
    throw new Error(
      `[mcp] tool '${def.name}' declares roles but its inputSchema has no 'classroom' argument`
    );
  }
  toolDefinitions.set(def.name, def as ToolDefinition<never>);
}

export function listToolDefinitions(): ToolDefinition<never>[] {
  return [...toolDefinitions.values()];
}

/** Serialize a caught error into a structured isError tool result (S5). */
function toErrorResult(error: unknown, toolName: string): ToolResult {
  if (error instanceof ToolError) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: error.kind,
            ...(error.code ? { code: error.code } : {}),
            message: error.message,
          }),
        },
      ],
    };
  }
  // Unknown failure: log server-side, return a generic message (no internals).
  console.error(`[mcp] unhandled error in tool '${toolName}':`, error);
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify({ error: 'internal', message: 'Internal server error' }),
      },
    ],
  };
}

function wrapHandler(def: ToolDefinition<never>, viewer: Viewer) {
  return async (args: Record<string, unknown>): Promise<ToolResult> => {
    try {
      // 1. Scope (defense in depth — registration is already scope-filtered).
      if (!viewer.scopes.has(def.scope)) {
        throw new ToolError('forbidden', `Tool '${def.name}' requires the '${def.scope}' scope`);
      }

      // 2. Rate limit (S6).
      if (!tryConsume(`${viewer.userId}:${def.name}`, def.rateLimit ?? DEFAULT_RATE_LIMIT)) {
        throw new ToolError('rate_limited', `Rate limit exceeded for '${def.name}' — retry later`);
      }

      const ctx: ToolContext = { viewer };

      // 3. Classroom + role resolution for classroom-bound tools.
      if (def.roles) {
        const classroomRef = args?.classroom;
        if (typeof classroomRef !== 'string') {
          throw new ToolError('invalid_params', "Missing required 'classroom' argument (org/slug)");
        }
        ctx.classroom = await resolveClassroomContext(viewer, classroomRef, {
          allowedRoles: def.roles,
        });

        // 4. Mutation gate for writes (non-owners mutate only when ACTIVE).
        if (def.scope === 'write') {
          assertMutationAllowed({ status: ctx.classroom.status, role: ctx.classroom.role });
        }
      }

      return await (def.handler as ToolDefinition['handler'])(args, ctx);
    } catch (error) {
      return toErrorResult(error, def.name);
    }
  };
}

/**
 * Build a per-request McpServer bound to the authenticated viewer
 * (locked decision 3: stateless — new server + transport per request).
 * Tools whose scope the token was not granted are not registered at all,
 * so tools/list only ever shows what the token can actually call (S7).
 */
export function buildMcpServer(viewer: Viewer): McpServer {
  const server = new McpServer({ name: 'classmoji-mcp', version: '0.1.0' });
  for (const def of toolDefinitions.values()) {
    if (!viewer.scopes.has(def.scope)) continue;
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.inputSchema,
      },
      wrapHandler(def, viewer) as never
    );
  }
  return server;
}
