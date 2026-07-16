/**
 * Integration coverage for the read tools (tools/reads.ts) — the tool mirror of
 * the MCP read-resource surface, plus the two non-mirror tools
 * (list_submissions filters, list_teaching_team staff-id resolution).
 *
 * Scope (representative slice, per the task): one allow + one deny at the
 * adjacent role boundary for each distinct tier —
 *   teaching-team (list_submissions, list_teaching_team, get_roster),
 *   OWNER-only   (get_leaderboard),
 *   member       (get_classroom_info),
 *   STUDENT-self (my_tokens),
 * one gated case (roster OWNER-field split), and — the central requirement — a
 * live NO-DRIFT check: the mirror tool payload equals its resource payload.
 *
 * Identity discipline (S10): timofei7 holds OWNER+ASSISTANT+STUDENT and is used
 * ONLY for OWNER-allow paths. Every denial uses a single-role identity
 * (fake-teacher / fake-ta / fake-student-1 / fake-other-owner). Reads only — no
 * fixtures created, no cleanup beyond minted tokens.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  callTool,
  deleteMintedTokens,
  DEV_REF,
  expectForbidden,
  getPrisma,
  loadFixtures,
  mintToken,
  readResource,
  startServer,
  type Fixtures,
  type MintedToken,
  type ServerHandle,
} from './helpers.ts';

const prisma = getPrisma();

let server: ServerHandle;
let fx: Fixtures;

let ownerMint: MintedToken; // timofei7 — OWNER-allow paths ONLY
let teacherMint: MintedToken; // fake-teacher — TEACHER (single role)
let taMint: MintedToken; // fake-ta — ASSISTANT (single role)
let student1Mint: MintedToken; // fake-student-1 — STUDENT (single role)
let otherOwnerMint: MintedToken; // fake-other-owner — not a dev-classroom member

let owner: string;
let teacher: string;
let ta: string;
let student1: string;
let otherOwner: string;

beforeAll(async () => {
  fx = await loadFixtures();
  server = await startServer();

  [ownerMint, teacherMint, taMint, student1Mint, otherOwnerMint] = await Promise.all([
    mintToken({ login: 'timofei7' }),
    mintToken({ login: 'fake-teacher' }),
    mintToken({ login: 'fake-ta' }),
    mintToken({ login: 'fake-student-1' }),
    mintToken({ login: 'fake-other-owner' }),
  ]);
  owner = ownerMint.access_token;
  teacher = teacherMint.access_token;
  ta = taMint.access_token;
  student1 = student1Mint.access_token;
  otherOwner = otherOwnerMint.access_token;
}, 300_000);

afterAll(async () => {
  try {
    await deleteMintedTokens();
  } finally {
    await server?.stop();
    await prisma.$disconnect();
  }
}, 120_000);

// ─── teaching-team tier ──────────────────────────────────────────────────────

describe('list_submissions (teaching team)', () => {
  it('returns submissions with ids for teaching team; STUDENT denied', async () => {
    const allowed = await callTool(ta, 'list_submissions', { classroom: DEV_REF });
    expect(allowed.isError).toBe(false);
    const submissions = allowed.payload.submissions as Array<{ id: string }>;
    expect(submissions.length).toBeGreaterThan(0);
    // The team submission fixture is present and its id (what grade_add consumes).
    expect(submissions.some(s => s.id === fx.teamGra.id)).toBe(true);
    expect(Array.isArray(allowed.payload.emoji_scale)).toBe(true);

    expectForbidden(
      await callTool(student1, 'list_submissions', { classroom: DEV_REF }),
      'list_submissions as student',
      'INSUFFICIENT_ROLE'
    );
  });

  it('filters by assignment_id server-side', async () => {
    const filtered = await callTool(ta, 'list_submissions', {
      classroom: DEV_REF,
      assignment_id: fx.releasedAssignment.id,
    });
    expect(filtered.isError).toBe(false);
    const rows = filtered.payload.submissions as Array<{ assignment: { id: string } | null }>;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.assignment?.id).toBe(fx.releasedAssignment.id);
  });
});

describe('list_teaching_team (teaching team; NEW capability)', () => {
  it('lists staff with ids for teaching team; STUDENT denied', async () => {
    const allowed = await callTool(ta, 'list_teaching_team', { classroom: DEV_REF });
    expect(allowed.isError).toBe(false);
    const members = allowed.payload.members as Array<{ id: string; roles: string[] }>;
    // fake-ta is resolvable as a grader_id for grader_assign.
    const taRow = members.find(m => m.id === fx.users['fake-ta'].id);
    expect(taRow).toBeDefined();
    expect(taRow!.roles).toContain('ASSISTANT');
    // No STUDENT appears in the teaching-team listing.
    const studentRow = members.find(m => m.id === fx.users['fake-student-1'].id);
    expect(studentRow).toBeUndefined();

    expectForbidden(
      await callTool(student1, 'list_teaching_team', { classroom: DEV_REF }),
      'list_teaching_team as student',
      'INSUFFICIENT_ROLE'
    );
  });
});

// ─── OWNER-only tier ─────────────────────────────────────────────────────────

describe('get_leaderboard (OWNER only)', () => {
  it('OWNER allowed; TEACHER (adjacent) denied', async () => {
    const allowed = await callTool(owner, 'get_leaderboard', { classroom: DEV_REF });
    expect(allowed.isError).toBe(false);
    expect(typeof allowed.payload.count).toBe('number');
    expect(Array.isArray(allowed.payload.leaderboard)).toBe(true);

    expectForbidden(
      await callTool(teacher, 'get_leaderboard', { classroom: DEV_REF }),
      'get_leaderboard as teacher',
      'INSUFFICIENT_ROLE'
    );
  });
});

// ─── member tier ─────────────────────────────────────────────────────────────

describe('get_classroom_info (any member)', () => {
  it('member allowed; non-member denied', async () => {
    const allowed = await callTool(student1, 'get_classroom_info', { classroom: DEV_REF });
    expect(allowed.isError).toBe(false);
    expect(allowed.payload.id).toBe(fx.dev.id);
    expect(allowed.payload.viewer_role).toBe('STUDENT');
    // Sanitized: no raw keys ever.
    expect(JSON.stringify(allowed.payload)).not.toMatch(/anthropic_api_key|openai_api_key/);

    expectForbidden(
      await callTool(otherOwner, 'get_classroom_info', { classroom: DEV_REF }),
      'get_classroom_info as non-member',
      'NOT_A_MEMBER'
    );
  });
});

// ─── STUDENT-self tier ───────────────────────────────────────────────────────

describe('my_tokens (STUDENT self)', () => {
  it('STUDENT allowed; teaching team denied', async () => {
    const allowed = await callTool(student1, 'my_tokens', { classroom: DEV_REF });
    expect(allowed.isError).toBe(false);
    expect(typeof allowed.payload.balance).toBe('number');
    expect(Array.isArray(allowed.payload.transactions)).toBe(true);

    expectForbidden(
      await callTool(ta, 'my_tokens', { classroom: DEV_REF }),
      'my_tokens as assistant',
      'INSUFFICIENT_ROLE'
    );
  });
});

// ─── gated case: roster OWNER-only field split ──────────────────────────────

describe('get_roster (teaching team; OWNER-only field split)', () => {
  it('TA sees identity-only; OWNER additionally sees contact + grade fields; STUDENT denied', async () => {
    const taRoster = await callTool(ta, 'get_roster', { classroom: DEV_REF });
    expect(taRoster.isError).toBe(false);
    const taStudents = taRoster.payload.students as Array<Record<string, unknown>>;
    expect(taStudents.length).toBeGreaterThan(0);
    for (const s of taStudents) {
      expect(s).toHaveProperty('login');
      expect(s).not.toHaveProperty('email');
      expect(s).not.toHaveProperty('school_id');
      expect(s).not.toHaveProperty('letter_grade');
    }

    // timofei7 (OWNER) sees the OWNER-only fields — proves the tool preserves
    // the resource's role-conditional field split.
    const ownerRoster = await callTool(owner, 'get_roster', { classroom: DEV_REF });
    expect(ownerRoster.isError).toBe(false);
    const ownerStudents = ownerRoster.payload.students as Array<Record<string, unknown>>;
    expect(ownerStudents[0]).toHaveProperty('email');
    expect(ownerStudents[0]).toHaveProperty('school_id');
    expect(ownerStudents[0]).toHaveProperty('letter_grade');

    expectForbidden(
      await callTool(student1, 'get_roster', { classroom: DEV_REF }),
      'get_roster as student',
      'INSUFFICIENT_ROLE'
    );
  });
});

// ─── live NO-DRIFT: mirror tool payload == resource payload ─────────────────

describe('no-drift: tool payloads equal their resource payloads', () => {
  it('get_leaderboard tool == leaderboard resource (OWNER)', async () => {
    const tool = await callTool(owner, 'get_leaderboard', { classroom: DEV_REF });
    const resource = await readResource(owner, `classmoji://${DEV_REF}/leaderboard`);
    expect(resource.error).toBeUndefined();
    expect(tool.payload).toEqual(resource.payload);
  });

  it('list_submissions rows == grading-queue resource `all` rows (teaching team)', async () => {
    const tool = await callTool(ta, 'list_submissions', { classroom: DEV_REF });
    const resource = await readResource(ta, `classmoji://${DEV_REF}/grading-queue`);
    expect(resource.error).toBeUndefined();
    // The per-submission shape (queueRow) and emoji_scale are shared code.
    expect(tool.payload.submissions).toEqual(resource.payload!.all);
    expect(tool.payload.emoji_scale).toEqual(resource.payload!.emoji_scale);
  });
});
