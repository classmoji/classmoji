/**
 * The settings services write the audit row of each change they make, against
 * a REAL Postgres: one row with exactly the actor's fields (a web actor, and
 * an MCP one under View as), written after the change; old and new values for
 * the columns the allow-list marks safe (settingsAudit.ts), a key by name and
 * a set/cleared marker only, owner text by name and length only (their values
 * appear nowhere in the row); no row when nothing changed; none and no throw
 * for `actor: null`; and a saved change that reports `missed` when its row
 * could not be written (an actor with no user row, which the
 * `audit_logs.user_id` foreign key refuses), whose `audit_miss` line carries
 * no key. Rows are scoped to the classroom changed and to its actor: owner A
 * in classroom X and owner B in classroom Y never see each other's rows or
 * settings.
 *
 * Covers classroom.updateClassroomSettings / updateSettings, the grading
 * scale (emojiMapping, letterGradeMapping), contentDelivery's cache reset,
 * orgRepoSettings, the class site and tags.
 *
 * GitHub (org settings), the Fly certificate calls and the Pro lookup behind
 * custom domains are faked; everything else is the database. SAFETY: fixtures
 * are namespaced with a fresh uuid and torn down in afterAll (deleting the git
 * organization cascades classrooms, settings, sites, scales, tags and audit
 * rows). Skipped unless DATABASE_URL names a LOCAL, non-shared database, like
 * the other integration tests here.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

import getPrisma from '@classmoji/database';
import { Prisma } from '@classmoji/database/client';
import type { AuditActor } from '../audit.service.ts';

const github = vi.hoisted(() => ({
  org: { default_repository_permission: 'none', members_can_create_repositories: false } as Record<
    string,
    unknown
  >,
}));

vi.mock('../../git/index.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('../../git/index.ts')>()),
  GitHubProvider: {
    getImmediateUserOctokit: () => ({
      request: async (route: string, params: Record<string, unknown>) => {
        if (route === 'PATCH /orgs/{org}') {
          const { org: _org, request: _request, ...changes } = params;
          Object.assign(github.org, changes);
        }
        return { data: { ...github.org } };
      },
    }),
  },
}));
const fly = vi.hoisted(() => ({
  configured: false,
  removeCert: vi.fn(async (_domain: string) => undefined),
}));
vi.mock('../../fly/index.ts', () => ({
  removeCert: (domain: string) => fly.removeCert(domain),
  isFlyCertsConfigured: () => fly.configured,
}));
vi.mock('../subscription.service.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('../subscription.service.ts')>()),
  getProStateForClassroomId: async () => ({ isPro: true }),
}));

const classroom = await import('../classroom.service.ts');
const emojiMapping = await import('../emojiMapping.service.ts');
const letterGradeMapping = await import('../letterGradeMapping.service.ts');
const contentDelivery = await import('../contentDelivery.service.ts');
const orgRepoSettings = await import('../orgRepoSettings.service.ts');
const site = await import('../site.service.ts');
const organizationTag = await import('../organizationTag.service.ts');

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
const isSharedDevDb = /\/classmoji(\?|$)/.test(DATABASE_URL);
const RUN = Boolean(DATABASE_URL) && isLocal && !isSharedDevDb;

/** A key no row or log line may ever carry. */
const KEY = `sk-ant-api03-${randomUUID()}-SECRETVALUE`;
const OTHER_KEY = `sk-ant-api03-${randomUUID()}-OTHERSECRET`;
/** Owner text that only its length may describe. */
const INSTRUCTIONS = 'Point students at the lecture notes, never at full solutions.';

describe.skipIf(!RUN)('settings services write their audit rows (integration)', () => {
  const suite = randomUUID().slice(0, 8);
  const prisma = getPrisma();
  const userIds: string[] = [];
  let orgId: string;
  let serial = 0;

  interface Fixture {
    label: string;
    classroomId: string;
    ownerId: string;
  }
  let X: Fixture;
  let Y: Fixture;

  const makeUser = async (label: string) => {
    const user = await prisma.user.create({
      data: { email: `settingsaudit-${label}-${++serial}-${suite}@example.test` },
      select: { id: true },
    });
    userIds.push(user.id);
    return user.id;
  };

  const makeClassroom = async (label: string): Promise<Fixture> => {
    const row = await prisma.classroom.create({
      data: {
        slug: `settingsaudit-${label}-${suite}`,
        git_org_id: orgId,
        name: `Settings audit ${label} ${suite}`,
        content_namespace: `settingsaudit-${label}-${suite}`,
        content_repo: `content-settingsaudit-${label}-${suite}`,
      },
      select: { id: true },
    });
    await prisma.classroomSettings.create({ data: { classroom_id: row.id } });
    const ownerId = await makeUser(`owner-${label}`);
    await prisma.classroomMembership.create({
      data: { classroom_id: row.id, user_id: ownerId, role: 'OWNER', has_accepted_invite: true },
    });
    return { label, classroomId: row.id, ownerId };
  };

  const SELECT = {
    user_id: true,
    classroom_id: true,
    role: true,
    resource_type: true,
    resource_id: true,
    action: true,
    data: true,
  } as const;
  /** Rows in a classroom since `since` (a row count), oldest first. */
  const rowsIn = (classroomId: string) =>
    prisma.auditLog.findMany({
      where: { classroom_id: classroomId },
      orderBy: { timestamp: 'asc' },
      select: SELECT,
    });
  /** The rows a call wrote in `f`'s classroom. */
  const newRows = async <T>(f: Fixture, fn: () => Promise<T>) => {
    const before = (await rowsIn(f.classroomId)).length;
    const value = await fn();
    return { value, rows: (await rowsIn(f.classroomId)).slice(before) };
  };

  const webActor = (f: Fixture, tool: string): AuditActor => ({
    userId: f.ownerId,
    role: 'OWNER',
    tool,
    impersonatedBy: null,
  });
  const ADMIN = randomUUID();
  const mcpActor = (f: Fixture, tool: string): AuditActor => ({
    userId: f.ownerId,
    role: 'OWNER',
    tool,
    impersonatedBy: ADMIN,
    clientId: 'client-1',
    via: 'mcp',
  });
  /** An actor whose user row does not exist: the foreign key refuses its row. */
  const ghost = (tool: string): AuditActor => ({ userId: randomUUID(), role: 'OWNER', tool });

  const quietly = async <T>(fn: () => Promise<T>) => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const value = await fn();
      const misses = logged.mock.calls.filter(c => c[0] === 'audit_miss');
      return { value, misses, text: JSON.stringify(logged.mock.calls) };
    } finally {
      logged.mockRestore();
    }
  };

  const settingsOf = (f: Fixture) =>
    prisma.classroomSettings.findUniqueOrThrow({ where: { classroom_id: f.classroomId } });

  beforeAll(async () => {
    const org = await prisma.gitOrganization.create({
      data: {
        provider: 'GITHUB',
        provider_id: `settingsaudit-${suite}`,
        login: `sa-${suite}`,
        github_installation_id: `inst-${suite}`,
      },
    });
    orgId = org.id;
    X = await makeClassroom('x');
    Y = await makeClassroom('y');
  });

  afterAll(async () => {
    if (orgId) await prisma.gitOrganization.delete({ where: { id: orgId } }).catch(() => {});
    await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  });

  // ─── classroom settings ────────────────────────────────────────────────────

  describe('classroom.updateSettings / updateClassroomSettings', () => {
    it('one row for a web actor: the changed fields, their new and old values', async () => {
      const { value, rows } = await newRows(X, () =>
        classroom.updateSettings(
          X.classroomId,
          // show_modules is already true: not a change.
          { show_pages: false, show_modules: true, theme: 'sand', timezone: 'europe/paris' },
          webActor(X, 'web:settings.general.time_zone')
        )
      );
      expect(value.audit).toEqual({ written: 1, missed: 0 });
      expect(value.settings).toMatchObject({ show_pages: false, timezone: 'Europe/Paris' });
      expect(rows).toEqual([
        {
          user_id: X.ownerId,
          classroom_id: X.classroomId,
          role: 'OWNER',
          resource_type: 'SETTINGS',
          resource_id: X.classroomId,
          action: 'UPDATE',
          data: {
            tool: 'web:settings.general.time_zone',
            fields: ['show_pages', 'theme', 'timezone'],
            values: { show_pages: false, theme: 'sand', timezone: 'Europe/Paris' },
            previous: { show_pages: true, theme: 'stone', timezone: null },
          },
        },
      ]);
    });

    it('an MCP actor under View as: settings and name as ONE row, the name by name only', async () => {
      const { value, rows } = await newRows(X, () =>
        classroom.updateClassroomSettings(
          X.classroomId,
          { settings: { default_tokens_per_hour: 4 }, classroom: { name: `Renamed ${suite}` } },
          mcpActor(X, 'classroom_settings_update')
        )
      );
      expect(value.audit).toEqual({ written: 1, missed: 0 });
      // The classroom's id and name only: nothing else of the row (its git
      // organization carries credentials).
      expect(value.classroom).toEqual({ id: X.classroomId, name: `Renamed ${suite}` });
      expect(rows).toEqual([
        {
          user_id: X.ownerId,
          classroom_id: X.classroomId,
          role: 'OWNER',
          resource_type: 'SETTINGS',
          resource_id: X.classroomId,
          action: 'UPDATE',
          data: {
            via: 'mcp',
            tool: 'classroom_settings_update',
            fields: ['default_tokens_per_hour', 'name'],
            values: { default_tokens_per_hour: 4 },
            previous: { default_tokens_per_hour: 0 },
            client_id: 'client-1',
            impersonated_by: ADMIN,
          },
        },
      ]);
      expect(JSON.stringify(rows)).not.toContain('Renamed');
    });

    it('a key set, replaced and cleared: by name and marker only, its value nowhere', async () => {
      const actor = webActor(X, 'web:settings.ai');
      const set = await newRows(X, () =>
        classroom.updateSettings(X.classroomId, { anthropic_api_key: KEY }, actor)
      );
      const replaced = await newRows(X, () =>
        classroom.updateSettings(
          X.classroomId,
          { anthropic_api_key: OTHER_KEY, llm_model: 'claude-opus-5-5' },
          actor
        )
      );
      const cleared = await newRows(X, () =>
        classroom.updateSettings(X.classroomId, { anthropic_api_key: null, llm_model: null }, actor)
      );
      expect((await settingsOf(X)).anthropic_api_key).toBeNull();

      expect(set.rows.map(r => r.data)).toEqual([
        {
          tool: 'web:settings.ai',
          fields: ['anthropic_api_key'],
          values: {},
          previous: {},
          anthropic_api_key_set: true,
        },
      ]);
      expect(replaced.rows.map(r => r.data)).toEqual([
        {
          tool: 'web:settings.ai',
          fields: ['anthropic_api_key', 'llm_model'],
          values: { llm_model: 'claude-opus-5-5' },
          previous: { llm_model: null },
          anthropic_api_key_set: true,
        },
      ]);
      expect(cleared.rows.map(r => r.data)).toEqual([
        {
          tool: 'web:settings.ai',
          fields: ['anthropic_api_key', 'llm_model'],
          values: { llm_model: null },
          previous: { llm_model: 'claude-opus-5-5' },
          anthropic_api_key_cleared: true,
        },
      ]);
      const all = JSON.stringify([set.rows, replaced.rows, cleared.rows]);
      expect(all).not.toContain('SECRETVALUE');
      expect(all).not.toContain('OTHERSECRET');
    });

    it('owner text by name and its stored length only (0 when cleared)', async () => {
      const actor = webActor(X, 'web:settings.ai');
      const saved = await newRows(X, () =>
        classroom.updateSettings(
          X.classroomId,
          { syllabus_bot_instructions: `   ${INSTRUCTIONS}  ` },
          actor
        )
      );
      const clearedText = await newRows(X, () =>
        classroom.updateSettings(X.classroomId, { syllabus_bot_instructions: '  ' }, actor)
      );
      expect(saved.rows.map(r => r.data)).toEqual([
        {
          tool: 'web:settings.ai',
          fields: ['syllabus_bot_instructions'],
          values: {},
          previous: {},
          instructions_length: INSTRUCTIONS.length,
        },
      ]);
      expect(clearedText.rows.map(r => r.data)).toEqual([
        {
          tool: 'web:settings.ai',
          fields: ['syllabus_bot_instructions'],
          values: {},
          previous: {},
          instructions_length: 0,
        },
      ]);
      expect(JSON.stringify([saved.rows, clearedText.rows])).not.toContain('lecture notes');
    });

    it('a listed field whose value is not its shape goes in by name only', async () => {
      const { rows } = await newRows(X, () =>
        classroom.updateSettings(
          X.classroomId,
          { default_student_page: KEY },
          webActor(X, 'web:settings.general.default_page')
        )
      );
      expect(rows.map(r => r.data)).toEqual([
        {
          tool: 'web:settings.general.default_page',
          fields: ['default_student_page'],
          values: {},
          previous: {},
        },
      ]);
      expect(JSON.stringify(rows)).not.toContain('SECRETVALUE');
      // Put back, recording nothing.
      await classroom.updateSettings(X.classroomId, { default_student_page: 'dashboard' }, null);
    });

    it('the gradebook release keeps its GRADES row and its key, with old and new', async () => {
      const { rows } = await newRows(X, () =>
        classroom.updateSettings(
          X.classroomId,
          { final_grades_released: true },
          webActor(X, 'web:grades.release_final_grades'),
          { resourceType: 'GRADES', topLevelFields: ['final_grades_released'] }
        )
      );
      expect(rows).toEqual([
        expect.objectContaining({
          resource_type: 'GRADES',
          resource_id: X.classroomId,
          action: 'UPDATE',
          data: {
            tool: 'web:grades.release_final_grades',
            final_grades_released: true,
            fields: ['final_grades_released'],
            values: { final_grades_released: true },
            previous: { final_grades_released: false },
          },
        }),
      ]);
    });

    it('top-level fields go through the allow-list: a key and owner text add nothing', async () => {
      const { rows } = await newRows(X, () =>
        classroom.updateSettings(
          X.classroomId,
          {
            anthropic_api_key: OTHER_KEY,
            syllabus_bot_instructions: INSTRUCTIONS,
            show_pages: false,
          },
          webActor(X, 'web:settings.top_level'),
          { topLevelFields: ['anthropic_api_key', 'syllabus_bot_instructions', 'show_pages'] }
        )
      );
      expect(rows).toHaveLength(1);
      const data = rows[0].data as Record<string, unknown>;
      // Unchanged, so not among `fields`, but asked for at the top level.
      expect(data).toMatchObject({ show_pages: false });
      expect(data).not.toHaveProperty('anthropic_api_key');
      expect(data).not.toHaveProperty('syllabus_bot_instructions');
      expect(JSON.stringify(rows)).not.toContain('OTHERSECRET');
      expect(JSON.stringify(rows)).not.toContain(INSTRUCTIONS);
      await classroom.updateSettings(
        X.classroomId,
        { anthropic_api_key: null, syllabus_bot_instructions: null },
        null
      );
    });

    it('writes no row when nothing changed', async () => {
      const { value, rows } = await newRows(X, () =>
        classroom.updateClassroomSettings(
          X.classroomId,
          { settings: { show_pages: false }, classroom: { name: `Renamed ${suite}` } },
          webActor(X, 'web:settings.general.profile')
        )
      );
      expect(value.audit).toEqual({ written: 0, missed: 0 });
      expect(rows).toEqual([]);
    });

    it('writes no row for actor: null, and saves all the same', async () => {
      const { value, rows } = await newRows(X, () =>
        classroom.updateSettings(X.classroomId, { show_repos: false }, null)
      );
      expect(value.audit).toEqual({ written: 0, missed: 0 });
      expect(rows).toEqual([]);
      expect((await settingsOf(X)).show_repos).toBe(false);
    });

    it('a row it cannot write: the change stands, `missed`, and the miss line has no key', async () => {
      const { value, misses, text } = await quietly(() =>
        classroom.updateSettings(
          X.classroomId,
          { anthropic_api_key: KEY, show_repos: true },
          ghost('web:settings.ai')
        )
      );
      expect(value.audit).toEqual({ written: 0, missed: 1 });
      expect(misses).toHaveLength(1);
      expect(text).toContain('anthropic_api_key_set');
      expect(text).not.toContain('SECRETVALUE');
      const stored = await settingsOf(X);
      expect(stored.show_repos).toBe(true);
      expect(stored.anthropic_api_key).toBe(KEY);
      await classroom.updateSettings(X.classroomId, { anthropic_api_key: null }, null);
    });

    it("owner A's save in X and owner B's in Y: each row in its classroom, for its owner", async () => {
      const a = await newRows(X, () =>
        classroom.updateSettings(
          X.classroomId,
          { late_penalty_points_per_hour: 2.5 },
          webActor(X, 'web:settings.grades.grading')
        )
      );
      const yBefore = await settingsOf(Y);
      const b = await newRows(Y, () =>
        classroom.updateSettings(
          Y.classroomId,
          { slides_enabled: false },
          webActor(Y, 'web:settings.content.features')
        )
      );
      expect(a.rows).toEqual([
        expect.objectContaining({
          user_id: X.ownerId,
          classroom_id: X.classroomId,
          data: expect.objectContaining({ fields: ['late_penalty_points_per_hour'] }),
        }),
      ]);
      expect(b.rows).toEqual([
        expect.objectContaining({
          user_id: Y.ownerId,
          classroom_id: Y.classroomId,
          data: expect.objectContaining({ fields: ['slides_enabled'] }),
        }),
      ]);
      // Y's settings moved only where B changed them.
      expect(await settingsOf(Y)).toMatchObject({
        ...yBefore,
        slides_enabled: false,
        updated_at: expect.any(Date),
      });
      expect((await rowsIn(Y.classroomId)).every(r => r.user_id === Y.ownerId)).toBe(true);
      expect((await settingsOf(X)).slides_enabled).toBe(true);
    });
  });

  // ─── grading scale ─────────────────────────────────────────────────────────

  describe('the grading scale', () => {
    it('saveEmojiMapping: a new emoji, a change, and no change', async () => {
      const actor = webActor(X, 'web:settings.grades.emoji_mapping_upsert');
      const created = await newRows(X, () =>
        emojiMapping.saveEmojiMapping(
          X.classroomId,
          { emoji: '⭐', grade: 90, description: 'Excellent work, Ada' },
          actor
        )
      );
      const changed = await newRows(X, () =>
        emojiMapping.saveEmojiMapping(
          X.classroomId,
          { emoji: '⭐', grade: 95, extra_tokens: 2, description: 'Excellent work, Ada' },
          mcpActor(X, 'emoji_mapping_upsert')
        )
      );
      const same = await newRows(X, () =>
        emojiMapping.saveEmojiMapping(X.classroomId, { emoji: '⭐', grade: 95 }, actor)
      );
      const id = created.value.mapping.id;
      expect(created.rows).toEqual([
        {
          user_id: X.ownerId,
          classroom_id: X.classroomId,
          role: 'OWNER',
          resource_type: 'SETTINGS',
          resource_id: id,
          action: 'UPDATE',
          data: {
            tool: 'web:settings.grades.emoji_mapping_upsert',
            emoji: '⭐',
            grade: 90,
            fields: ['emoji', 'grade', 'description'],
            values: { emoji: '⭐', grade: 90 },
            previous: {},
            created: true,
          },
        },
      ]);
      expect(changed.rows).toEqual([
        expect.objectContaining({
          resource_id: id,
          data: {
            via: 'mcp',
            tool: 'emoji_mapping_upsert',
            emoji: '⭐',
            grade: 95,
            fields: ['grade', 'extra_tokens'],
            values: { grade: 95, extra_tokens: 2 },
            previous: { grade: 90, extra_tokens: 0 },
            client_id: 'client-1',
            impersonated_by: ADMIN,
          },
        }),
      ]);
      expect(same.rows).toEqual([]);
      expect(same.value.audit).toEqual({ written: 0, missed: 0 });
      expect(JSON.stringify([created.rows, changed.rows])).not.toContain('Ada');
    });

    it('a label with a space is recorded on its create row as on its delete row', async () => {
      const actor = webActor(X, 'web:settings.grades.labels');
      const emoji = await newRows(X, () =>
        emojiMapping.saveEmojiMapping(X.classroomId, { emoji: 'a b', grade: 61 }, actor)
      );
      const letter = await newRows(X, () =>
        letterGradeMapping.save(X.classroomId, { letter_grade: 'A +', min_grade: 97 }, actor)
      );
      const emojiGone = await newRows(X, () =>
        emojiMapping.deleteEmojiMapping(X.classroomId, 'a b', actor)
      );
      const letterGone = await newRows(X, () =>
        letterGradeMapping.delete(X.classroomId, 'A +', actor)
      );
      expect(emoji.rows.map(r => r.data)).toEqual([
        expect.objectContaining({ emoji: 'a b', values: { emoji: 'a b', grade: 61 } }),
      ]);
      expect(letter.rows.map(r => r.data)).toEqual([
        expect.objectContaining({
          letter_grade: 'A +',
          values: { letter_grade: 'A +', min_grade: 97 },
        }),
      ]);
      expect(emojiGone.rows.map(r => r.data)).toEqual([expect.objectContaining({ emoji: 'a b' })]);
      expect(letterGone.rows.map(r => r.data)).toEqual([
        expect.objectContaining({ letter_grade: 'A +' }),
      ]);
    });

    it('deleteEmojiMapping: one DELETE row with what was there; none for nothing', async () => {
      const { value: saved } = await newRows(X, () =>
        emojiMapping.saveEmojiMapping(X.classroomId, { emoji: '🍕', grade: 50 }, null)
      );
      const actor = webActor(X, 'web:settings.grades.emoji_mapping_delete');
      const gone = await newRows(X, () =>
        emojiMapping.deleteEmojiMapping(X.classroomId, '🍕', actor)
      );
      const again = await newRows(X, () =>
        emojiMapping.deleteEmojiMapping(X.classroomId, '🍕', actor)
      );
      // Another classroom's emoji is not deleted from here.
      await emojiMapping.saveEmojiMapping(Y.classroomId, { emoji: '🍕', grade: 1 }, null);
      const foreign = await newRows(X, () =>
        emojiMapping.deleteEmojiMapping(X.classroomId, '🍕', actor)
      );
      expect(gone.rows).toEqual([
        expect.objectContaining({
          resource_type: 'SETTINGS',
          resource_id: saved.mapping.id,
          action: 'DELETE',
          data: {
            tool: 'web:settings.grades.emoji_mapping_delete',
            emoji: '🍕',
            previous: { grade: 50, extra_tokens: 0 },
          },
        }),
      ]);
      expect(again.rows).toEqual([]);
      expect(foreign.rows).toEqual([]);
      expect(
        await prisma.emojiMapping.count({ where: { classroom_id: Y.classroomId, emoji: '🍕' } })
      ).toBe(1);
    });

    it('replaceScale: one row when the scale changes, none when it is the same', async () => {
      const actor = webActor(X, 'web:settings.grades.populate_score_scale');
      const scale = [
        { emoji: 'score-100', grade: 100 },
        { emoji: 'score-50', grade: 50 },
      ];
      const before = await prisma.emojiMapping.count({ where: { classroom_id: X.classroomId } });
      const replaced = await newRows(X, () =>
        emojiMapping.replaceScale(X.classroomId, scale, actor)
      );
      const same = await newRows(X, () => emojiMapping.replaceScale(X.classroomId, scale, actor));
      expect(replaced.rows).toEqual([
        expect.objectContaining({
          resource_id: X.classroomId,
          action: 'UPDATE',
          data: {
            tool: 'web:settings.grades.populate_score_scale',
            count: 2,
            previous_count: before,
          },
        }),
      ]);
      expect(same.rows).toEqual([]);
    });

    it('replaceScale: a changed description is a change (one row, the text nowhere); the same scale none', async () => {
      const actor = webActor(X, 'web:settings.grades.populate_emoji_scale');
      const DESCRIPTION = `Strong work on the ${randomUUID()} project`;
      const scale = [
        { emoji: '⭐', grade: 100, description: 'Excellent' },
        { emoji: '👍', grade: 80 },
      ];
      await emojiMapping.replaceScale(X.classroomId, scale, null);
      const edited = [{ ...scale[0], description: DESCRIPTION }, scale[1]];
      const changed = await newRows(X, () =>
        emojiMapping.replaceScale(X.classroomId, edited, actor)
      );
      const same = await newRows(X, () => emojiMapping.replaceScale(X.classroomId, edited, actor));
      expect(changed.rows).toEqual([
        expect.objectContaining({
          action: 'UPDATE',
          data: { tool: 'web:settings.grades.populate_emoji_scale', count: 2, previous_count: 2 },
        }),
      ]);
      expect(JSON.stringify(changed.rows)).not.toContain(DESCRIPTION);
      expect(same.rows).toEqual([]);
      // A left-out description is stored as ''; an explicit '' is the same scale.
      const blank = await newRows(X, () =>
        emojiMapping.replaceScale(
          X.classroomId,
          [edited[0], { ...scale[1], description: '' }],
          actor
        )
      );
      expect(blank.rows).toEqual([]);
    });

    it('letter grades: save, change, delete and replace, one row each that changed', async () => {
      const save = webActor(X, 'web:settings.grades.letter_grade_mapping_upsert');
      const created = await newRows(X, () =>
        letterGradeMapping.save(X.classroomId, { letter_grade: 'A', min_grade: 90 }, save)
      );
      const changed = await newRows(X, () =>
        letterGradeMapping.save(
          X.classroomId,
          { letter_grade: 'A', min_grade: 93 },
          mcpActor(X, 'letter_grade_mapping_upsert')
        )
      );
      const same = await newRows(X, () =>
        letterGradeMapping.save(X.classroomId, { letter_grade: 'A', min_grade: 93 }, save)
      );
      const deleted = await newRows(X, () =>
        letterGradeMapping.delete(
          X.classroomId,
          'A',
          webActor(X, 'web:settings.grades.letter_grade_mapping_delete')
        )
      );
      const defaults = [
        { letter_grade: 'A', min_grade: 90 },
        { letter_grade: 'B', min_grade: 80 },
      ];
      const replaced = await newRows(X, () =>
        letterGradeMapping.replaceAll(
          X.classroomId,
          defaults,
          webActor(X, 'web:settings.grades.populate_default_letter_grades')
        )
      );
      const replacedAgain = await newRows(X, () =>
        letterGradeMapping.replaceAll(
          X.classroomId,
          defaults,
          webActor(X, 'web:settings.grades.populate_default_letter_grades')
        )
      );

      expect(created.rows.map(r => r.data)).toEqual([
        {
          tool: 'web:settings.grades.letter_grade_mapping_upsert',
          letter_grade: 'A',
          min_grade: 90,
          fields: ['letter_grade', 'min_grade'],
          values: { letter_grade: 'A', min_grade: 90 },
          previous: {},
          created: true,
        },
      ]);
      expect(changed.rows.map(r => r.data)).toEqual([
        {
          via: 'mcp',
          tool: 'letter_grade_mapping_upsert',
          letter_grade: 'A',
          min_grade: 93,
          fields: ['min_grade'],
          values: { min_grade: 93 },
          previous: { min_grade: 90 },
          client_id: 'client-1',
          impersonated_by: ADMIN,
        },
      ]);
      expect(same.rows).toEqual([]);
      expect(deleted.rows).toEqual([
        expect.objectContaining({
          action: 'DELETE',
          resource_id: created.value.mapping.id,
          data: {
            tool: 'web:settings.grades.letter_grade_mapping_delete',
            letter_grade: 'A',
            previous: { min_grade: 93 },
          },
        }),
      ]);
      expect(replaced.rows).toEqual([
        expect.objectContaining({
          resource_id: X.classroomId,
          data: {
            tool: 'web:settings.grades.populate_default_letter_grades',
            count: 2,
            previous_count: 0,
          },
        }),
      ]);
      expect(replacedAgain.rows).toEqual([]);
    });
  });

  // ─── content cache, org repo settings ──────────────────────────────────────

  describe('contentDelivery.bumpContentKeyVersion', () => {
    it('one CONTENT_SETTINGS row with the new and previous version', async () => {
      const { value, rows } = await newRows(X, () =>
        contentDelivery.bumpContentKeyVersion(
          X.classroomId,
          webActor(X, 'web:settings.content.reset_cache')
        )
      );
      expect(value.audit).toEqual({ written: 1, missed: 0 });
      expect(rows).toEqual([
        expect.objectContaining({
          resource_type: 'CONTENT_SETTINGS',
          resource_id: X.classroomId,
          action: 'UPDATE',
          data: {
            tool: 'web:settings.content.reset_cache',
            fields: ['content_key_version'],
            values: { content_key_version: value.content_key_version },
            previous: { content_key_version: value.content_key_version - 1 },
          },
        }),
      ]);
    });
  });

  describe('orgRepoSettings.updateOrgRepoSettings', () => {
    const gitOrganization = () => ({
      login: `sa-${suite}`,
      provider: 'GITHUB',
      github_installation_id: `inst-${suite}`,
    });

    it('one REPO_SETTINGS row after GitHub applied it; none when GitHub had those values', async () => {
      const actor = mcpActor(X, 'org_repo_settings_update');
      const changed = await newRows(X, () =>
        orgRepoSettings.updateOrgRepoSettings({
          gitOrganization: gitOrganization(),
          userToken: 'ghu_token',
          input: { default_repository_permission: 'read' },
          classroomId: X.classroomId,
          actor,
        })
      );
      const same = await newRows(X, () =>
        orgRepoSettings.updateOrgRepoSettings({
          gitOrganization: gitOrganization(),
          userToken: 'ghu_token',
          input: { default_repository_permission: 'read' },
          classroomId: X.classroomId,
          actor,
        })
      );
      expect(changed.rows).toEqual([
        {
          user_id: X.ownerId,
          classroom_id: X.classroomId,
          role: 'OWNER',
          resource_type: 'REPO_SETTINGS',
          resource_id: X.classroomId,
          action: 'UPDATE',
          data: {
            via: 'mcp',
            tool: 'org_repo_settings_update',
            org: `sa-${suite}`,
            changes: { default_repository_permission: { from: 'none', to: 'read' } },
            value: 'default_repository_permission=read',
            fields: ['default_repository_permission'],
            values: { default_repository_permission: 'read' },
            previous: { default_repository_permission: 'none' },
            client_id: 'client-1',
            impersonated_by: ADMIN,
          },
        },
      ]);
      expect(same.rows).toEqual([]);
      expect(same.value.audit).toEqual({ written: 0, missed: 0 });
    });
  });

  // ─── the class site ────────────────────────────────────────────────────────

  describe('the class site', () => {
    const sub = (s: string) => `sa-${s}-${suite}`;

    it('claim, re-point, settings, custom domain, removal: one row per change', async () => {
      const actor = webActor(X, 'web:settings.website.save');
      const claimed = await newRows(X, () =>
        site.validateAndClaimSubdomain(X.classroomId, sub('one'), actor)
      );
      const reclaimed = await newRows(X, () =>
        site.validateAndClaimSubdomain(X.classroomId, sub('one'), actor)
      );
      const repointed = await newRows(X, () =>
        site.validateAndClaimSubdomain(X.classroomId, sub('two'), actor)
      );
      const settings = await newRows(X, () =>
        site.upsertSiteSettings(X.classroomId, { show_schedule: false }, actor)
      );
      const sameSettings = await newRows(X, () =>
        site.upsertSiteSettings(X.classroomId, { show_schedule: false }, actor)
      );
      const domain = `${suite}.example-course.org`;
      const connected = await newRows(X, () => site.setCustomDomain(X.classroomId, domain, actor));
      const disconnected = await newRows(X, () => site.clearCustomDomain(X.classroomId, actor));
      const nothingToClear = await newRows(X, () => site.clearCustomDomain(X.classroomId, actor));
      const removed = await newRows(X, () => site.deleteSiteForClassroom(X.classroomId, actor));

      const siteId = claimed.value.site.id;
      const row = (action: string, data: Record<string, unknown>) => ({
        user_id: X.ownerId,
        classroom_id: X.classroomId,
        role: 'OWNER',
        resource_type: 'SITE_SETTINGS',
        resource_id: siteId,
        action,
        data: { tool: 'web:settings.website.save', ...data },
      });
      expect(claimed.rows).toEqual([
        row('CREATE', {
          fields: ['subdomain'],
          values: { subdomain: sub('one') },
          previous: {},
        }),
      ]);
      expect(reclaimed.rows).toEqual([]);
      expect(repointed.rows).toEqual([
        row('UPDATE', {
          fields: ['subdomain'],
          values: { subdomain: sub('two') },
          previous: { subdomain: sub('one') },
        }),
      ]);
      expect(settings.rows).toEqual([
        row('UPDATE', {
          fields: ['show_schedule'],
          values: { show_schedule: false },
          previous: { show_schedule: true },
        }),
      ]);
      expect(sameSettings.rows).toEqual([]);
      expect(connected.rows).toEqual([
        row('UPDATE', {
          fields: ['custom_domain'],
          values: { custom_domain: domain },
          previous: { custom_domain: null },
        }),
      ]);
      expect(disconnected.rows).toEqual([
        row('UPDATE', {
          fields: ['custom_domain'],
          values: { custom_domain: null },
          previous: { custom_domain: domain },
        }),
      ]);
      expect(nothingToClear.rows).toEqual([]);
      expect(removed.rows).toEqual([
        row('DELETE', { previous: { subdomain: sub('two'), custom_domain: null } }),
      ]);
      expect(await prisma.classroomSite.count({ where: { classroom_id: X.classroomId } })).toBe(0);
    });

    it('records nothing for actor: null, and a missed row leaves the claim standing', async () => {
      const none = await newRows(Y, () =>
        site.validateAndClaimSubdomain(Y.classroomId, sub('y'), null)
      );
      expect(none.rows).toEqual([]);
      expect(none.value.audit).toEqual({ written: 0, missed: 0 });

      const { value, misses } = await quietly(() =>
        site.validateAndClaimSubdomain(Y.classroomId, sub('y2'), ghost('web:settings.website'))
      );
      expect(value.audit).toEqual({ written: 0, missed: 1 });
      expect(misses).toHaveLength(1);
      expect(
        (await prisma.classroomSite.findUnique({ where: { classroom_id: Y.classroomId } }))
          ?.subdomain
      ).toBe(sub('y2'));
    });
  });

  // ─── tags ──────────────────────────────────────────────────────────────────

  describe('tags', () => {
    it('a created tag and a deleted one: one TAGS row each; an existing tag none', async () => {
      const created = await newRows(X, () =>
        organizationTag.findOrCreate(
          X.classroomId,
          'Section A',
          webActor(X, 'web:settings.team.create_tag')
        )
      );
      const existing = await newRows(X, () =>
        organizationTag.findOrCreate(X.classroomId, 'Section A', mcpActor(X, 'tag_create'))
      );
      // Another classroom's tag id deletes nothing here.
      const yTag = await organizationTag.findOrCreate(Y.classroomId, 'Section A', null);
      const foreign = await newRows(X, () =>
        organizationTag.deleteInClassroom(
          X.classroomId,
          yTag.tag.id,
          webActor(X, 'web:settings.team.delete_tag')
        )
      );
      const deleted = await newRows(X, () =>
        organizationTag.deleteInClassroom(
          X.classroomId,
          created.value.tag.id,
          webActor(X, 'web:settings.team.delete_tag')
        )
      );
      const tagId = created.value.tag.id;
      expect(created.rows).toEqual([
        expect.objectContaining({
          resource_type: 'TAGS',
          resource_id: tagId,
          action: 'CREATE',
          data: { tool: 'web:settings.team.create_tag', name: 'Section A', value: 'Section A' },
        }),
      ]);
      expect(existing.value.created).toBe(false);
      expect(existing.rows).toEqual([]);
      expect(foreign.value.tag).toBeNull();
      expect(foreign.rows).toEqual([]);
      expect(deleted.rows).toEqual([
        expect.objectContaining({
          resource_type: 'TAGS',
          resource_id: tagId,
          action: 'DELETE',
          data: { tool: 'web:settings.team.delete_tag', name: 'Section A' },
        }),
      ]);
      expect(await prisma.tag.findUnique({ where: { id: yTag.tag.id } })).not.toBeNull();
    });
  });
  // ─── two saves at once ─────────────────────────────────────────────────────

  describe('two overlapping saves each get their row', () => {
    /**
     * Hold `FOR UPDATE` on the rows `locks` names, from a connection of its
     * own, until `release` is called: the state of a save that has read its
     * row and not yet committed.
     */
    const holdLocks = async (locks: Prisma.Sql[]) => {
      let release!: () => void;
      const released = new Promise<void>(resolve => (release = resolve));
      let acquired!: () => void;
      const ready = new Promise<void>(resolve => (acquired = resolve));
      const done = prisma.$transaction(
        async tx => {
          for (const lock of locks) await tx.$queryRaw(lock);
          acquired();
          await released;
        },
        { timeout: 30_000 }
      );
      await ready;
      return { release, done };
    };
    /** Wait until `n` sessions on this database are waiting for a row lock on `table`. */
    const waitForWaiters = async (table: string, n: number) => {
      for (let i = 0; i < 200; i++) {
        const [{ waiting }] = await prisma.$queryRaw<{ waiting: number }[]>`
          SELECT count(*)::int AS waiting FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND query ILIKE ${`%${table}%`}`;
        if (waiting >= n) return;
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error(`fewer than ${n} sessions waited on ${table}`);
    };

    /**
     * The interleaving that loses a row when the previous value is read apart
     * from the write: A saves X over X (no change) and B saves Y, A's read
     * before B's write and A's write after it. Here both start while the rows
     * are held, B first, so each save's read must wait for the one before it:
     * B records X → Y and A then records Y → X.
     */
    const overlap = async <T>(
      locks: Prisma.Sql[],
      table: string,
      a: () => Promise<T>,
      b: () => Promise<T>
    ) => {
      const held = await holdLocks(locks);
      const saveB = b();
      await waitForWaiters(table, 1);
      const saveA = a();
      await waitForWaiters(table, 2);
      held.release();
      await held.done;
      return Promise.all([saveA, saveB]);
    };

    it('classroom settings: X → Y and Y → X, one row each', async () => {
      await classroom.updateSettings(X.classroomId, { show_modules: true }, null);
      const actor = webActor(X, 'web:settings.general.overlap');
      const { rows } = await newRows(X, () =>
        overlap(
          [
            Prisma.sql`SELECT id FROM classrooms WHERE id = ${X.classroomId} FOR UPDATE`,
            Prisma.sql`SELECT classroom_id FROM classroom_settings WHERE classroom_id = ${X.classroomId} FOR UPDATE`,
          ],
          'classroom',
          () => classroom.updateSettings(X.classroomId, { show_modules: true }, actor),
          () => classroom.updateSettings(X.classroomId, { show_modules: false }, actor)
        )
      );
      expect(rows.map(r => r.data)).toEqual([
        expect.objectContaining({
          fields: ['show_modules'],
          values: { show_modules: false },
          previous: { show_modules: true },
        }),
        expect.objectContaining({
          fields: ['show_modules'],
          values: { show_modules: true },
          previous: { show_modules: false },
        }),
      ]);
      expect((await settingsOf(X)).show_modules).toBe(true);
    });

    it('site settings: X → Y and Y → X, one row each', async () => {
      if (!(await prisma.classroomSite.findUnique({ where: { classroom_id: X.classroomId } }))) {
        await site.validateAndClaimSubdomain(X.classroomId, `sa-ov-${suite}`, null);
      }
      await site.upsertSiteSettings(X.classroomId, { show_schedule: true }, null);
      const actor = webActor(X, 'web:settings.website.overlap');
      const { rows } = await newRows(X, () =>
        overlap(
          [
            Prisma.sql`SELECT id FROM classroom_sites WHERE classroom_id = ${X.classroomId} FOR UPDATE`,
          ],
          'classroom_sites',
          () => site.upsertSiteSettings(X.classroomId, { show_schedule: true }, actor),
          () => site.upsertSiteSettings(X.classroomId, { show_schedule: false }, actor)
        )
      );
      expect(rows.map(r => r.data)).toEqual([
        expect.objectContaining({
          fields: ['show_schedule'],
          values: { show_schedule: false },
          previous: { show_schedule: true },
        }),
        expect.objectContaining({
          fields: ['show_schedule'],
          values: { show_schedule: true },
          previous: { show_schedule: false },
        }),
      ]);
    });
  });

  // ─── every function: no row for actor: null, `missed` for a row it cannot write ───

  describe('each settings function with actor: null and with a row it cannot write', () => {
    /**
     * One change per call, fresh each time, in classroom Y. `check` reads what
     * the change leaves: a different value after each call, or (`same`) the
     * same end state each time (a delete, a clear, a replace).
     */
    interface Case {
      name: string;
      run: (actor: AuditActor | null) => Promise<{ audit: { written: number; missed: number } }>;
      check: () => Promise<unknown>;
      same?: true;
    }
    let n = 0;
    const next = () => ++n;
    const cases: Case[] = [
      {
        name: 'emojiMapping.saveEmojiMapping',
        run: actor =>
          emojiMapping.saveEmojiMapping(Y.classroomId, { emoji: '🎯', grade: 70 + next() }, actor),
        check: async () =>
          (
            await prisma.emojiMapping.findFirst({
              where: { classroom_id: Y.classroomId, emoji: '🎯' },
            })
          )?.grade,
      },
      {
        name: 'emojiMapping.deleteEmojiMapping',
        same: true,
        run: async actor => {
          const emoji = `del-${next()}`;
          await emojiMapping.saveEmojiMapping(Y.classroomId, { emoji, grade: 1 }, null);
          return emojiMapping.deleteEmojiMapping(Y.classroomId, emoji, actor);
        },
        check: () =>
          prisma.emojiMapping.count({
            where: { classroom_id: Y.classroomId, emoji: { startsWith: 'del-' } },
          }),
      },
      {
        name: 'emojiMapping.replaceScale',
        same: true,
        run: actor =>
          emojiMapping.replaceScale(Y.classroomId, [{ emoji: `s-${next()}`, grade: 1 }], actor),
        check: () => prisma.emojiMapping.count({ where: { classroom_id: Y.classroomId } }),
      },
      {
        name: 'letterGradeMapping.save',
        run: actor =>
          letterGradeMapping.save(Y.classroomId, { letter_grade: 'C', min_grade: next() }, actor),
        check: async () =>
          (
            await prisma.letterGradeMapping.findFirst({
              where: { classroom_id: Y.classroomId, letter_grade: 'C' },
            })
          )?.min_grade,
      },
      {
        name: 'letterGradeMapping.delete',
        same: true,
        run: async actor => {
          const letter = `D${next()}`;
          await letterGradeMapping.save(
            Y.classroomId,
            { letter_grade: letter, min_grade: 1 },
            null
          );
          return letterGradeMapping.delete(Y.classroomId, letter, actor);
        },
        check: () =>
          prisma.letterGradeMapping.count({
            where: { classroom_id: Y.classroomId, letter_grade: { startsWith: 'D' } },
          }),
      },
      {
        name: 'letterGradeMapping.replaceAll',
        same: true,
        run: actor =>
          letterGradeMapping.replaceAll(
            Y.classroomId,
            [{ letter_grade: 'A', min_grade: next() }],
            actor
          ),
        check: () => prisma.letterGradeMapping.count({ where: { classroom_id: Y.classroomId } }),
      },
      {
        name: 'contentDelivery.bumpContentKeyVersion',
        run: actor => contentDelivery.bumpContentKeyVersion(Y.classroomId, actor),
        check: async () =>
          (await prisma.classroom.findUniqueOrThrow({ where: { id: Y.classroomId } }))
            .content_key_version,
      },
      {
        name: 'orgRepoSettings.updateOrgRepoSettings',
        run: actor =>
          orgRepoSettings.updateOrgRepoSettings({
            gitOrganization: {
              login: `sa-${suite}`,
              provider: 'GITHUB',
              github_installation_id: `inst-${suite}`,
            },
            userToken: 'ghu_token',
            input: { members_can_create_repositories: next() % 2 === 0 },
            classroomId: Y.classroomId,
            actor,
          }),
        check: async () => github.org.members_can_create_repositories,
      },
      {
        name: 'site.upsertSiteSettings',
        run: actor =>
          site.upsertSiteSettings(Y.classroomId, { show_schedule: next() % 2 === 0 }, actor),
        check: async () =>
          (await prisma.classroomSite.findUniqueOrThrow({ where: { classroom_id: Y.classroomId } }))
            .show_schedule,
      },
      {
        name: 'site.setCustomDomain',
        run: actor =>
          site.setCustomDomain(Y.classroomId, `d${next()}-${suite}.example-course.org`, actor),
        check: async () =>
          (await prisma.classroomSite.findUniqueOrThrow({ where: { classroom_id: Y.classroomId } }))
            .custom_domain,
      },
      {
        name: 'site.clearCustomDomain',
        same: true,
        run: async actor => {
          await site.setCustomDomain(Y.classroomId, `c${next()}-${suite}.example-course.org`, null);
          return site.clearCustomDomain(Y.classroomId, actor);
        },
        check: async () =>
          (await prisma.classroomSite.findUniqueOrThrow({ where: { classroom_id: Y.classroomId } }))
            .custom_domain,
      },
      {
        name: 'organizationTag.findOrCreate',
        run: actor => organizationTag.findOrCreate(Y.classroomId, `tag-${next()}`, actor),
        check: () => prisma.tag.count({ where: { classroom_id: Y.classroomId } }),
      },
      {
        name: 'organizationTag.deleteInClassroom',
        same: true,
        run: async actor => {
          const { tag } = await organizationTag.findOrCreate(Y.classroomId, `gone-${next()}`, null);
          return organizationTag.deleteInClassroom(Y.classroomId, tag.id, actor);
        },
        check: () =>
          prisma.tag.count({
            where: { classroom_id: Y.classroomId, name: { startsWith: 'gone-' } },
          }),
      },
    ];

    beforeAll(async () => {
      // Y has a site from the earlier claim test; make sure it does.
      if (!(await prisma.classroomSite.findUnique({ where: { classroom_id: Y.classroomId } }))) {
        await site.validateAndClaimSubdomain(Y.classroomId, `sa-yy-${suite}`, null);
      }
    });

    it.each(cases.map(c => [c.name, c] as const))(
      '%s: actor null writes no row; a row it cannot write is `missed`, the change stands',
      async (_name, c) => {
        const none = await newRows(Y, () => c.run(null));
        expect(none.value.audit).toEqual({ written: 0, missed: 0 });
        expect(none.rows).toEqual([]);
        const after = await c.check();

        const { value, misses } = await quietly(() => c.run(ghost(`ghost:${c.name}`)));
        expect(value.audit).toEqual({ written: 0, missed: 1 });
        expect(misses).toHaveLength(1);
        // The second change landed too.
        const now = await c.check();
        if (c.same) expect(now).toEqual(after);
        else expect(now).not.toEqual(after);
        expect(await rowsIn(Y.classroomId)).not.toContainEqual(
          expect.objectContaining({ data: expect.objectContaining({ tool: `ghost:${c.name}` }) })
        );
      }
    );

    it('site.deleteSiteForClassroom: the certificate is still released after a missed row', async () => {
      fly.configured = true;
      fly.removeCert.mockClear();
      try {
        await site.setCustomDomain(Y.classroomId, `rm-${suite}.example-course.org`, null);
        const { value, misses } = await quietly(() =>
          site.deleteSiteForClassroom(Y.classroomId, ghost('ghost:delete_site'))
        );
        expect(value.audit).toEqual({ written: 0, missed: 1 });
        expect(misses).toHaveLength(1);
        expect(fly.removeCert).toHaveBeenCalledWith(`rm-${suite}.example-course.org`);
        expect(await prisma.classroomSite.count({ where: { classroom_id: Y.classroomId } })).toBe(
          0
        );

        await site.validateAndClaimSubdomain(Y.classroomId, `sa-yz-${suite}`, null);
        const none = await newRows(Y, () => site.deleteSiteForClassroom(Y.classroomId, null));
        expect(none.value.audit).toEqual({ written: 0, missed: 0 });
        expect(none.rows).toEqual([]);
      } finally {
        fly.configured = false;
      }
    });
  });
});
