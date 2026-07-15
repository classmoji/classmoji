/**
 * Shared helpers for the MCP integration suites (plan §8.1 layer 2).
 *
 * Extracted from tests/phase1-auth.integration.test.ts so the Phase 2 matrix
 * files (S1 / S4 / behavior) reuse one server-spawn + dev-mint + JSON-RPC
 * toolkit. Each test FILE spawns its own server on PORT (files run strictly
 * sequentially per vitest.integration.config.ts, so the port never clashes).
 *
 * Identity discipline (plan §8.1 critical guard): timofei7 holds
 * OWNER+ASSISTANT+STUDENT and passes EVERY role gate — use it ONLY for
 * OWNER-allow paths. ALL denial assertions use the single-role identities
 * (fake-teacher / fake-ta / fake-student-* / fake-other-*).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { expect } from 'vitest';

export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = path.resolve(APP_DIR, '../..');

// DATABASE_URL comes from the repo-root .env (see .dev-context) when the
// runner didn't provide one. loadEnvFile never overrides existing vars.
if (!process.env.DATABASE_URL) {
  process.loadEnvFile(path.join(REPO_ROOT, '.env'));
}

// Ports 8100 (dev default) and 8101–8103 are reserved by Phase-1 work; the
// Phase-2 matrix owns 8104.
export const PORT = 8104;
export const BASE = `http://localhost:${PORT}`;
export const EXPECTED_CHALLENGE = `Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource"`;

// Composite org/slug references (locked decision 1).
export const DEV_REF = 'classmoji-development/classmoji-dev-winter-2025';
export const TWIN_REF = 'dev-org/classmoji-dev-winter-2025';
export const FOREIGN_REF = 'dev-org/classmoji-other-class';

// Deferred so the .env load above happens before Prisma is constructed.
const { default: getPrisma } = await import('@classmoji/database');
export { getPrisma };

// ─── Server lifecycle ────────────────────────────────────────────────────────

export interface ServerHandle {
  process: ChildProcess;
  output: () => string;
  stop: () => Promise<void>;
}

async function spawnOnce(): Promise<{ proc: ChildProcess; output: () => string }> {
  let output = '';
  const proc = spawn(process.execPath, ['--experimental-strip-types', 'src/index.ts'], {
    cwd: APP_DIR,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      ENABLE_TEST_LOGIN: 'true', // S8 double gate — both flags required
      MCP_PORT: String(PORT),
      MCP_PUBLIC_URL: BASE,
      WEBAPP_URL: 'http://localhost:3000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stdout?.on('data', chunk => (output += chunk));
  proc.stderr?.on('data', chunk => (output += chunk));
  return { proc, output: () => output };
}

async function waitForHealth(proc: ChildProcess, getOutput: () => string, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`MCP server exited early (code ${proc.exitCode}).\n${getOutput()}`);
    }
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`MCP server did not become healthy within ${timeoutMs}ms.\n${getOutput()}`);
}

async function killServer(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null) return;
  proc.kill('SIGTERM');
  await Promise.race([once(proc, 'exit'), new Promise(r => setTimeout(r, 5_000))]);
  if (proc.exitCode === null) proc.kill('SIGKILL');
}

/**
 * Spawn the MCP server and wait for /health. A sibling agent is editing
 * apps/mcp/src/tools/** concurrently, so a startup crash may be a transient
 * half-written file — retry after a pause before giving up.
 */
export async function startServer({
  attempts = 3,
  retryDelayMs = 75_000,
} = {}): Promise<ServerHandle> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const { proc, output } = await spawnOnce();
    try {
      await waitForHealth(proc, output);
      return {
        process: proc,
        output,
        stop: () => killServer(proc),
      };
    } catch (error) {
      lastError = error;
      await killServer(proc);
      if (attempt < attempts) {
        console.warn(
          `[helpers] MCP server failed to start (attempt ${attempt}/${attempts}); ` +
            `retrying in ${retryDelayMs / 1000}s (concurrent edits?)...\n${String(error).slice(0, 2000)}`
        );
        await new Promise(r => setTimeout(r, retryDelayMs));
      }
    }
  }
  throw lastError;
}

// ─── Dev token minting (S8 double-gated endpoint) ───────────────────────────

export interface MintedToken {
  access_token: string;
  user_id: string;
  login: string;
}

export interface MintOptions {
  login: string;
  scopes?: string[];
  expiresInSeconds?: number;
}

/** Tokens minted through this helper, tracked by value for precise cleanup. */
export const mintedTokens: string[] = [];

export async function mintToken({ login, scopes, expiresInSeconds }: MintOptions) {
  const res = await fetch(`${BASE}/dev/mint-token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login, scopes, expiresInSeconds }),
  });
  expect(res.status, `mint-token failed for '${login}' — is the DB seeded?`).toBe(201);
  const body = (await res.json()) as MintedToken;
  mintedTokens.push(body.access_token);
  return body;
}

/** Delete ONLY the token rows this run minted (tracked by value). */
export async function deleteMintedTokens(): Promise<void> {
  if (mintedTokens.length === 0) return;
  await getPrisma().oauthAccessToken.deleteMany({
    where: { accessToken: { in: mintedTokens.splice(0) } },
  });
}

// ─── JSON-RPC plumbing ───────────────────────────────────────────────────────

export interface JsonRpcEnvelope {
  jsonrpc: string;
  id: number | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string; data?: unknown };
}

let rpcId = 0;

export async function rpcRaw(token: string | null, method: string, params: unknown = {}) {
  rpcId += 1;
  return fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: rpcId, method, params }),
  });
}

export async function rpc(token: string | null, method: string, params: unknown = {}) {
  const res = await rpcRaw(token, method, params);
  expect(res.status).toBe(200);
  return (await res.json()) as JsonRpcEnvelope;
}

export interface ToolCallOutcome {
  /** true when the registry serialized a ToolError (S5 isError result). */
  isError: boolean;
  /** Parsed JSON payload from content[0].text (success or error body). */
  payload: Record<string, unknown>;
}

/** Call a tool; both success and error bodies are JSON in content[0].text. */
export async function callTool(
  token: string,
  name: string,
  args: Record<string, unknown> = {}
): Promise<ToolCallOutcome> {
  const envelope = await rpc(token, 'tools/call', { name, arguments: args });
  expect(envelope.error, `tools/call ${name} failed at JSON-RPC level`).toBeUndefined();
  const result = envelope.result as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
  return {
    isError: Boolean(result.isError),
    payload: JSON.parse(result.content[0].text) as Record<string, unknown>,
  };
}

export interface ResourceReadOutcome {
  /** Parsed JSON payload (present on success). */
  payload?: Record<string, unknown>;
  /** JSON-RPC error (present on failure — resources map ToolError to codes). */
  error?: { code: number; message: string; data?: unknown };
}

/** Read a resource by URI; failures surface as JSON-RPC errors (registry doc). */
export async function readResource(token: string, uri: string): Promise<ResourceReadOutcome> {
  const envelope = await rpc(token, 'resources/read', { uri });
  if (envelope.error) return { error: envelope.error };
  const result = envelope.result as { contents: Array<{ text: string }> };
  return { payload: JSON.parse(result.contents[0].text) as Record<string, unknown> };
}

// ─── Assertion helpers ───────────────────────────────────────────────────────

/** The uniform S1 rejection: isError + kind 'not_found' (never 'forbidden'). */
export function expectScopedNotFound(outcome: ToolCallOutcome, context: string): void {
  expect(outcome.isError, `${context}: expected an error result`).toBe(true);
  expect(outcome.payload.error, `${context}: expected the uniform not_found`).toBe('not_found');
}

export function expectForbidden(
  outcome: ToolCallOutcome,
  context: string,
  code?: 'INSUFFICIENT_ROLE' | 'NOT_A_MEMBER'
): void {
  expect(outcome.isError, `${context}: expected an error result`).toBe(true);
  expect(outcome.payload.error, `${context}: expected forbidden`).toBe('forbidden');
  if (code) expect(outcome.payload.code, `${context}: expected code ${code}`).toBe(code);
}

/** MCP resource error codes (mirrors RESOURCE_ERROR_CODES in the registry). */
export const RESOURCE_FORBIDDEN = -32003;
export const RESOURCE_NOT_FOUND = -32002;

/** Poll until `probe` resolves truthy — for fire-and-forget side effects
 * (HelperService token minting is intentionally not awaited). */
export async function waitUntil<T>(
  probe: () => Promise<T | null | undefined | false>,
  { timeoutMs = 15_000, intervalMs = 300, label = 'condition' } = {}
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value as T;
    if (Date.now() > deadline) throw new Error(`waitUntil timed out waiting for ${label}`);
    await new Promise(r => setTimeout(r, intervalMs));
  }
}

// ─── Seeded fixture resolution (stable keys, never hardcoded UUIDs) ─────────

export interface Fixtures {
  dev: { id: string };
  twin: { id: string };
  foreign: { id: string };
  users: Record<
    | 'timofei7'
    | 'fake-teacher'
    | 'fake-ta'
    | 'fake-student-1'
    | 'fake-student-2'
    | 'fake-student-3'
    | 'fake-other-owner'
    | 'fake-other-student',
    { id: string; login: string }
  >;
  /** Team Alpha GROUP submission in the dev classroom (ungraded fixture). */
  teamGra: { id: string; git_repo: { team_id: string | null } };
  /** Foreign-classroom submission (S1 target). */
  foreignGra: { id: string };
  /** fake-student-1's individual submission on the released assignment. */
  student1Gra: { id: string };
  /** fake-student-3's individual submission (has a seeded 🔴 grade). */
  student3Gra: { id: string };
  /** 'Hello World Part 1' in dev — grades_released=true in the seed. */
  releasedAssignment: { id: string; title: string };
  /** 'Other Assignment 1' in the foreign classroom (S1 target). */
  foreignAssignment: { id: string };
  /** 'hello-world' container in dev (module-item target). */
  devRepository: { id: string };
  /** 'other-hello-world' container in the foreign classroom (S1 item target). */
  foreignRepository: { id: string };
}

export async function loadFixtures(): Promise<Fixtures> {
  const prisma = getPrisma();

  const classroomBy = (org: string, slug: string) =>
    prisma.classroom.findFirstOrThrow({
      where: { slug, git_organization: { login: org } },
      select: { id: true },
    });
  const [dev, twin, foreign] = await Promise.all([
    classroomBy('classmoji-development', 'classmoji-dev-winter-2025'),
    classroomBy('dev-org', 'classmoji-dev-winter-2025'),
    classroomBy('dev-org', 'classmoji-other-class'),
  ]);

  const logins = [
    'timofei7',
    'fake-teacher',
    'fake-ta',
    'fake-student-1',
    'fake-student-2',
    'fake-student-3',
    'fake-other-owner',
    'fake-other-student',
  ] as const;
  const userRows = await prisma.user.findMany({
    where: { login: { in: [...logins] } },
    select: { id: true, login: true },
  });
  const users = Object.fromEntries(
    logins.map(login => {
      const row = userRows.find(u => u.login === login);
      if (!row) throw new Error(`Seed user '${login}' missing — run npm run db:seed`);
      return [login, { id: row.id, login }];
    })
  ) as Fixtures['users'];

  const graBy = (providerId: string) =>
    prisma.gitRepoAssignment.findUniqueOrThrow({
      where: { provider_provider_id: { provider: 'GITHUB', provider_id: providerId } },
      select: { id: true, git_repo: { select: { team_id: true } } },
    });
  const [teamGra, foreignGra, student1Gra, student3Gra] = await Promise.all([
    graBy('fake-issue-team-alpha'),
    graBy('fake-issue-fake-other-student'),
    graBy('fake-issue-fake-student-1'),
    graBy('fake-issue-fake-student-3'),
  ]);

  const releasedAssignment = await prisma.assignment.findFirstOrThrow({
    where: { title: 'Hello World Part 1', repository: { classroom_id: dev.id } },
    select: { id: true, title: true },
  });
  const foreignAssignment = await prisma.assignment.findFirstOrThrow({
    where: { title: 'Other Assignment 1', repository: { classroom_id: foreign.id } },
    select: { id: true },
  });
  const devRepository = await prisma.repository.findFirstOrThrow({
    where: { classroom_id: dev.id, title: 'hello-world' },
    select: { id: true },
  });
  const foreignRepository = await prisma.repository.findFirstOrThrow({
    where: { classroom_id: foreign.id, title: 'other-hello-world' },
    select: { id: true },
  });

  return {
    dev,
    twin,
    foreign,
    users,
    teamGra,
    foreignGra,
    student1Gra,
    student3Gra,
    releasedAssignment,
    foreignAssignment,
    devRepository,
    foreignRepository,
  };
}

// ─── Cleanup stack (LIFO, error-tolerant) ────────────────────────────────────

export class CleanupStack {
  private steps: Array<{ label: string; run: () => Promise<unknown> }> = [];

  add(label: string, run: () => Promise<unknown>): void {
    this.steps.push({ label, run });
  }

  /** Run every step in reverse order; collect failures and throw at the end. */
  async run(): Promise<void> {
    const failures: string[] = [];
    for (const step of this.steps.splice(0).reverse()) {
      try {
        await step.run();
      } catch (error) {
        failures.push(`${step.label}: ${String(error)}`);
      }
    }
    if (failures.length > 0) {
      throw new Error(`Cleanup failures:\n${failures.join('\n')}`);
    }
  }
}

// ─── Audit helpers ───────────────────────────────────────────────────────────

/** Every write tool stamps data.tool — the precise key for audit assertions
 * and for deleting ONLY the audit rows this suite generated. */
export const MCP_TOOL_NAMES = new Set([
  'grade_add',
  'grade_remove',
  'grade_remove_all',
  'grader_assign',
  'grader_unassign',
  'emoji_mapping_upsert',
  'letter_grade_mapping_upsert',
  'assignment_update',
  'regrade_create',
  'regrade_resolve',
  'module_create',
  'module_update',
  'module_publish',
  'module_item_add',
  'calendar_event_create',
  'calendar_event_update',
  'calendar_event_delete',
  'page_update',
  'page_delete',
  'token_grant',
]);

export interface AuditExpectation {
  userId: string;
  classroomId: string;
  role: 'OWNER' | 'TEACHER' | 'ASSISTANT' | 'STUDENT';
  resourceType: string;
  action: 'CREATE' | 'UPDATE' | 'DELETE';
  resourceId?: string;
  tool: string;
  since: Date;
}

/**
 * Assert an audit row exists for a successful write. NOTE the audit service's
 * 5-second same-shape dedup window: rows are deduped on (user, classroom,
 * role, resource_type, resource_id, action) — assertions here always pin the
 * distinguishing fields so a deduped sibling can't satisfy the wrong test.
 */
export async function expectAuditRow(expected: AuditExpectation): Promise<void> {
  const row = await getPrisma().auditLog.findFirst({
    where: {
      user_id: expected.userId,
      classroom_id: expected.classroomId,
      role: expected.role,
      resource_type: expected.resourceType,
      action: expected.action,
      ...(expected.resourceId ? { resource_id: expected.resourceId } : {}),
      timestamp: { gte: expected.since },
    },
    orderBy: { timestamp: 'desc' },
  });
  expect(
    row,
    `audit row missing: ${expected.tool} → ${expected.resourceType}/${expected.action} by ${expected.userId}`
  ).toBeTruthy();
  const data = row?.data as { tool?: string } | null;
  expect(data?.tool, 'audit row data.tool mismatch').toBe(expected.tool);
}

/** Delete audit rows created by THIS suite: since `since`, by our test users,
 * and stamped with an MCP tool name in data.tool. */
export async function deleteMcpAuditRows(since: Date, userIds: string[]): Promise<void> {
  const prisma = getPrisma();
  const candidates = await prisma.auditLog.findMany({
    where: { timestamp: { gte: since }, user_id: { in: userIds } },
    select: { id: true, data: true },
  });
  const ids = candidates
    .filter(row => {
      const data = row.data as { tool?: string } | null;
      return Boolean(data?.tool && MCP_TOOL_NAMES.has(data.tool));
    })
    .map(row => row.id);
  if (ids.length > 0) await prisma.auditLog.deleteMany({ where: { id: { in: ids } } });
}

/** Delete in-app notifications generated as side effects of test writes:
 * created since `since` inside the test classrooms only. */
export async function deleteTestNotifications(since: Date, classroomIds: string[]): Promise<void> {
  await getPrisma().notification.deleteMany({
    where: { created_at: { gte: since }, classroom_id: { in: classroomIds } },
  });
}
