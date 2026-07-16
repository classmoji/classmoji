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

import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { UriTemplate } from '@modelcontextprotocol/sdk/shared/uriTemplate.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { ClassmojiService } from '@classmoji/services';
import type { Role } from '@prisma/client';
import type { ZodRawShape } from 'zod';
import type { Viewer } from '../auth/resolveViewer.ts';
import { resolveClassroomContext, type ClassroomContext } from '../authz/classroomContext.ts';
import { assertMutationAllowed, canEnterClassroom } from '../authz/pure.ts';
import { ToolError, type ToolErrorKind } from './errors.ts';
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
  /**
   * MCP behavioral hints surfaced to clients (tools/list `annotations`).
   * `readOnlyHint` is derived from `scope` automatically — do NOT set it here.
   * These fields describe the WRITE surface so a client can decide whether to
   * run a call silently or pause for human confirmation:
   *   - `destructive`: the call deletes/removes data or access (a client should
   *     double-check before running). Deletes/removes → true; pure creates/
   *     updates/upserts → false. Defaults to `true` when omitted on a write, so
   *     an unclassified new tool errs toward "make the human confirm".
   *   - `idempotent`: repeating the call with the same args has no additional
   *     effect (e.g. upserts). Meaningful only for writes; defaults false.
   *   - `openWorld`: the call ripples to an external system (GitHub) rather than
   *     just our own database. Defaults false (closed classroom domain).
   */
  annotations?: {
    destructive?: boolean;
    idempotent?: boolean;
    openWorld?: boolean;
  };
  /** Optional per-tool override of the default rate limit (S6). */
  rateLimit?: RateLimitConfig;
  handler: (args: Args, ctx: ToolContext) => Promise<ToolResult>;
}

/**
 * A read-only MCP resource (plan §7). Mirrors ToolDefinition: same scope
 * declaration (S7 — always 'read', still declared AND enforced), same
 * rate-limit hook (S6), same classroom/role resolution. Classroom-bound
 * resources address the classroom through `{org}`/`{slug}` URI-template
 * variables instead of a `classroom` argument.
 *
 * Error mapping for resource reads (there is no `isError` result shape for
 * resources, so failures become JSON-RPC errors — see RESOURCE_ERROR_CODES):
 *   invalid_params → -32602, not_found → -32002 (MCP resource-not-found),
 *   forbidden → -32003, rate_limited → -32005, internal → -32603.
 */
export interface ResourceDefinition {
  /** Unique resource name (snake/kebab, e.g. 'roster'). */
  name: string;
  /**
   * RFC 6570 URI template (e.g. 'classmoji://{org}/{slug}/roster') or a
   * static URI when there is nothing to parameterize (e.g. 'classmoji://me').
   * When `roles` is non-null the template MUST contain `{org}` and `{slug}`.
   */
  uriTemplate: string;
  title: string;
  description: string;
  /** S7: resources are read-only; the 'read' scope is still declared + enforced. */
  scope: 'read';
  /**
   * Same semantics as ToolDefinition.roles: `null` = any authenticated user;
   * non-null = classroom-bound — the registry resolves `{org}/{slug}` from
   * the URI, applies the role set + UNPUBLISHED entry gate, and hands the
   * handler a ready ClassroomContext. Route-derived tiers only (plan §4.2).
   */
  roles: readonly Role[] | null;
  /** Optional per-resource override of the default rate limit (S6). */
  rateLimit?: RateLimitConfig;
  /** Defaults to 'application/json'. */
  mimeType?: string;
  /**
   * Returns a JSON-serializable payload; the registry wraps it into MCP
   * resource contents. `vars` are the matched URI-template variables.
   */
  handler: (vars: Record<string, string>, ctx: ToolContext, uri: URL) => Promise<unknown>;
}

const toolDefinitions = new Map<string, ToolDefinition<never>>();
const resourceDefinitions = new Map<string, ResourceDefinition>();

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

export function registerResourceDefinition(def: ResourceDefinition): void {
  if (resourceDefinitions.has(def.name)) {
    throw new Error(`[mcp] duplicate resource definition: ${def.name}`);
  }
  if (def.scope !== 'read') {
    // S7: resources are the read surface — writes are tools.
    throw new Error(`[mcp] resource '${def.name}' must declare the 'read' scope`);
  }
  if (def.roles) {
    const vars = new UriTemplate(def.uriTemplate).variableNames;
    if (!vars.includes('org') || !vars.includes('slug')) {
      // Fail at startup: a role-gated resource without {org}/{slug} variables
      // has no classroom to gate against.
      throw new Error(
        `[mcp] resource '${def.name}' declares roles but its uriTemplate lacks {org}/{slug} variables`
      );
    }
  }
  resourceDefinitions.set(def.name, def);
}

export function listResourceDefinitions(): ResourceDefinition[] {
  return [...resourceDefinitions.values()];
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

// ─── Resource enforcement (mirrors the tool pipeline; steps 1–3, no mutation
//     gate — resources are read-only by construction) ─────────────────────────

/** JSON-RPC error codes for resource-read failures (see ResourceDefinition doc). */
const RESOURCE_ERROR_CODES: Record<ToolErrorKind, number> = {
  invalid_params: ErrorCode.InvalidParams,
  not_found: -32002, // MCP convention: resource not found
  forbidden: -32003,
  rate_limited: -32005,
  internal: ErrorCode.InternalError,
};

/** Serialize a caught error into an McpError (resources have no isError result). */
function toResourceError(error: unknown, resourceName: string): McpError {
  if (error instanceof McpError) return error;
  if (error instanceof ToolError) {
    return new McpError(RESOURCE_ERROR_CODES[error.kind], error.message, {
      kind: error.kind,
      ...(error.code ? { code: error.code } : {}),
    });
  }
  // Unknown failure: log server-side, return a generic message (no internals).
  console.error(`[mcp] unhandled error in resource '${resourceName}':`, error);
  return new McpError(ErrorCode.InternalError, 'Internal server error');
}

/** Coerce SDK template variables (string | string[]) to plain strings. */
function normalizeVars(variables: Record<string, string | string[]>): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [key, value] of Object.entries(variables)) {
    vars[key] = Array.isArray(value) ? (value[0] ?? '') : value;
  }
  return vars;
}

function wrapResourceRead(def: ResourceDefinition, viewer: Viewer) {
  return async (uri: URL, variables: Record<string, string | string[]>) => {
    try {
      // 1. Scope (defense in depth — registration is already scope-filtered).
      if (!viewer.scopes.has(def.scope)) {
        throw new ToolError(
          'forbidden',
          `Resource '${def.name}' requires the '${def.scope}' scope`
        );
      }

      // 2. Rate limit (S6 — reads are rate-limited too). Namespaced so a
      //    resource never shares a bucket with a same-named tool.
      if (
        !tryConsume(`${viewer.userId}:resource:${def.name}`, def.rateLimit ?? DEFAULT_RATE_LIMIT)
      ) {
        throw new ToolError('rate_limited', `Rate limit exceeded for '${def.name}' — retry later`);
      }

      const vars = normalizeVars(variables);
      const ctx: ToolContext = { viewer };

      // 3. Classroom + role resolution for classroom-bound resources.
      if (def.roles) {
        if (!vars.org || !vars.slug) {
          throw new ToolError('invalid_params', 'Resource URI must include org and slug segments');
        }
        ctx.classroom = await resolveClassroomContext(viewer, `${vars.org}/${vars.slug}`, {
          allowedRoles: def.roles,
        });
      }

      const payload = await def.handler(vars, ctx, uri);
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: def.mimeType ?? 'application/json',
            text: JSON.stringify(payload, null, 2),
          },
        ],
      };
    } catch (error) {
      throw toResourceError(error, def.name);
    }
  };
}

/**
 * Build a resources/list callback for a classroom-bound resource: expand the
 * template once per classroom where the viewer holds a satisfying role and
 * may enter (UNPUBLISHED blocks non-owners). Only templates whose variables
 * are exactly {org}/{slug} are listable; others return no list callback.
 * `fetchMemberships` is memoized per request-server so a resources/list call
 * costs one membership query total, not one per registered template.
 */
type MembershipListing = Awaited<ReturnType<typeof ClassmojiService.classroom.findByUserId>>;

function makeListCallback(
  def: ResourceDefinition,
  template: UriTemplate,
  fetchMemberships: () => Promise<MembershipListing>
) {
  if (!def.roles) return undefined;
  if (template.variableNames.some(name => name !== 'org' && name !== 'slug')) return undefined;
  const roles = def.roles;
  return async () => {
    const classrooms = await fetchMemberships();
    const seen = new Set<string>();
    const resources = [];
    for (const classroom of classrooms) {
      const role = classroom.membership.role;
      if (!roles.includes(role)) continue;
      if (!canEnterClassroom({ status: classroom.status, role })) continue;
      if (seen.has(classroom.id)) continue; // multi-role users: one URI per classroom
      seen.add(classroom.id);
      const org = classroom.git_organization?.login;
      if (!org) continue;
      resources.push({
        uri: template.expand({ org, slug: classroom.slug }),
        name: `${def.name}: ${org}/${classroom.slug}`,
        description: def.description,
        mimeType: def.mimeType ?? 'application/json',
      });
    }
    return { resources };
  };
}

/**
 * Translate a tool's declared scope + `annotations` into the MCP
 * `ToolAnnotations` hint block (readOnlyHint/destructiveHint/idempotentHint/
 * openWorldHint). `readOnlyHint` comes straight from `scope`, so the read/write
 * split we already enforce is the single source of truth for the hint too.
 * destructiveHint/idempotentHint are only meaningful for writes (per the MCP
 * spec) and are omitted for reads. destructiveHint defaults to `true` for a
 * write that declares no annotation — the safety-biased default.
 */
export function toolAnnotations(def: ToolDefinition<never>): {
  readOnlyHint: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint: boolean;
} {
  const openWorldHint = def.annotations?.openWorld ?? false;
  if (def.scope === 'read') {
    return { readOnlyHint: true, openWorldHint };
  }
  return {
    readOnlyHint: false,
    destructiveHint: def.annotations?.destructive ?? true,
    idempotentHint: def.annotations?.idempotent ?? false,
    openWorldHint,
  };
}

/**
 * Build a per-request McpServer bound to the authenticated viewer
 * (locked decision 3: stateless — new server + transport per request).
 * Tools/resources whose scope the token was not granted are not registered at
 * all, so tools/list + resources/list only ever show what the token can
 * actually call (S7).
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
        annotations: { title: def.title, ...toolAnnotations(def) },
      },
      wrapHandler(def, viewer) as never
    );
  }

  // Memoized membership fetch shared by every template's list callback.
  let membershipsPromise: Promise<MembershipListing> | null = null;
  const fetchMemberships = () => {
    membershipsPromise ??= ClassmojiService.classroom.findByUserId(viewer.userId);
    return membershipsPromise;
  };

  for (const def of resourceDefinitions.values()) {
    if (!viewer.scopes.has(def.scope)) continue;
    const metadata = {
      title: def.title,
      description: def.description,
      mimeType: def.mimeType ?? 'application/json',
    };
    const read = wrapResourceRead(def, viewer);
    if (!UriTemplate.isTemplate(def.uriTemplate)) {
      // Static URI (identity/bootstrap resources like classmoji://me).
      server.registerResource(def.name, def.uriTemplate, metadata, (uri: URL) => read(uri, {}));
    } else {
      const template = new UriTemplate(def.uriTemplate);
      server.registerResource(
        def.name,
        new ResourceTemplate(def.uriTemplate, {
          list: makeListCallback(def, template, fetchMemberships),
        }),
        metadata,
        (uri: URL, variables: Record<string, string | string[]>) => read(uri, variables)
      );
    }
  }
  return server;
}
