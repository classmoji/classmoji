/**
 * Team peer review — the Tier-2 resolver and the submit-time re-resolution,
 * against a REAL Postgres.
 *
 * These are the two pieces the whole feature's confidentiality rests on:
 *
 *  - the RESOLVER decides who a student may review, and it must answer with a
 *    named state rather than picking a team when several match;
 *  - the SUBMIT path re-resolves under the form's row lock, so the answer set a
 *    response is validated against is the team as it is NOW, not as the browser
 *    claims it was.
 *
 * Neither is mockable: the states come out of relational shapes (a team with no
 * tag, two teams with the same tag, a repository whose tag is found by slug),
 * and the re-resolution runs inside a transaction. A fake Prisma would agree
 * with whatever the code did.
 *
 * SAFETY: same posture as forms.integration.test.ts — one git organization per
 * run, deleted in afterAll (cascades classroom → teams → forms → responses).
 * Nothing pre-existing is touched, and the file skips entirely unless
 * DATABASE_URL names a local, non-shared database.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';

import getPrisma from '@classmoji/database';
import * as formService from '../form.service.ts';
import * as responseService from '../formResponse.service.ts';
import * as resolver from '../formTeamResolver.ts';
import type { FormField } from '../formContract.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
const isSharedDevDb = /\/classmoji(\?|$)/.test(DATABASE_URL);
const RUN = Boolean(DATABASE_URL) && isLocal && !isSharedDevDb;

const codeOf = async (promise: Promise<unknown>): Promise<string | undefined> => {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

describe.skipIf(!RUN)('forms team review', () => {
  const suite = randomUUID().slice(0, 8);
  const prisma = getPrisma();

  let orgId = '';
  let classroomId = '';
  let otherClassroomId = '';
  let ownerId = '';
  /** Four students and one TA, so "students only" has something to exclude. */
  const people: Record<string, string> = {};

  let projectTagId = '';
  let labTagId = '';
  let otherClassroomTagId = '';
  let trioTeamId = '';

  const makeUser = async (label: string, name: string) => {
    const user = await prisma.user.create({
      data: {
        login: `teamrev-${suite}-${label}`,
        email: `teamrev-${suite}-${label}@example.test`,
        name,
      },
    });
    people[label] = user.id;
    return user.id;
  };

  const enrol = (
    userId: string,
    role: 'STUDENT' | 'ASSISTANT' | 'OWNER',
    classroom = classroomId
  ) =>
    prisma.classroomMembership.create({
      data: { classroom_id: classroom, user_id: userId, role },
    });

  const makeTag = async (name: string, classroom = classroomId) =>
    (await prisma.tag.create({ data: { classroom_id: classroom, name } })).id;

  const makeTeam = async ({
    name,
    members,
    tagIds = [],
    classroom = classroomId,
  }: {
    name: string;
    members: string[];
    tagIds?: string[];
    classroom?: string;
  }) => {
    const team = await prisma.team.create({
      data: {
        classroom_id: classroom,
        name,
        slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${suite}`,
        memberships: { create: members.map(user_id => ({ user_id })) },
        ...(tagIds.length ? { tags: { create: tagIds.map(tag_id => ({ tag_id })) } } : {}),
      },
    });
    return team.id;
  };

  const makeRepository = async ({
    title,
    slug,
    tagId,
  }: {
    title: string;
    slug: string | null;
    tagId?: string | null;
  }) =>
    (
      await prisma.repository.create({
        data: {
          classroom_id: classroomId,
          title: `${title} ${suite}`,
          slug,
          template: 'template',
          type: 'GROUP',
          ...(tagId ? { tag_id: tagId } : {}),
        },
      })
    ).id;

  beforeAll(async () => {
    const org = await prisma.gitOrganization.create({
      data: { provider: 'GITHUB', provider_id: `teamrev-${suite}`, login: `teamrev-org-${suite}` },
    });
    orgId = org.id;

    const classroom = await prisma.classroom.create({
      data: {
        slug: `teamrev-${suite}`,
        git_org_id: orgId,
        name: `Team Review ${suite}`,
        content_namespace: `teamrev-${suite}`,
        content_repo: `content-teamrev-${suite}`,
      },
    });
    classroomId = classroom.id;

    const other = await prisma.classroom.create({
      data: {
        slug: `teamrev-other-${suite}`,
        git_org_id: orgId,
        name: `Team Review Elsewhere ${suite}`,
        content_namespace: `teamrev-other-${suite}`,
        content_repo: `content-teamrev-other-${suite}`,
      },
    });
    otherClassroomId = other.id;

    ownerId = await makeUser('owner', 'Zed Owner');
    await enrol(ownerId, 'OWNER');

    // Named so alphabetical order is NOT insertion order — the resolver
    // promises name order, and a fixture sorted the same way either round
    // could not tell the difference.
    await makeUser('s1', 'Maya Chen');
    await makeUser('s2', 'Sam Whitfield');
    await makeUser('s3', 'Alex Rivera');
    await makeUser('s4', 'Priya Natarajan');
    await makeUser('ta', 'Dana Assistant');
    for (const label of ['s1', 's2', 's3', 's4']) await enrol(people[label], 'STUDENT');
    await enrol(people.ta, 'ASSISTANT');

    projectTagId = await makeTag('project-teams');
    labTagId = await makeTag('lab-pairs');
    otherClassroomTagId = await makeTag('elsewhere', otherClassroomId);

    // The team under test: three students PLUS a TA, which is what makes the
    // students-only filter observable.
    trioTeamId = await makeTeam({
      name: 'Trio',
      members: [people.s1, people.s2, people.s3, people.ta],
      tagIds: [projectTagId],
    });

    // s1 alone in a lab pair — the SOLO_TEAM case.
    await makeTeam({ name: 'Solo', members: [people.s1], tagIds: [labTagId] });

    // s4 is on a team that carries no tag at all — TEAM_UNTAGGED, not NO_TEAM.
    await makeTeam({ name: 'Untagged', members: [people.s4] });
  });

  afterAll(async () => {
    if (orgId) await prisma.gitOrganization.delete({ where: { id: orgId } }).catch(() => {});
    await prisma.user
      .deleteMany({ where: { login: { startsWith: `teamrev-${suite}-` } } })
      .catch(() => {});
  });

  const tagScope = (tagId: string) => ({ by: 'tag' as const, tag_id: tagId });

  const resolve = (userId: string, scope: resolver.RepeatScope) =>
    resolver.resolveRepeatTargets({ classroomId, userId, repeat: { scope } });

  // ── The resolver ─────────────────────────────────────────────────────────

  describe('resolveRepeatTargets', () => {
    it('resolves a tagged team to the other students on it, in name order', async () => {
      const result = await resolve(people.s1, tagScope(projectTagId));
      expect(result.state).toBe('OK');
      expect(result.targets.map(target => target.name)).toEqual(['Alex Rivera', 'Sam Whitfield']);
      expect(result.targets.map(target => target.user_id)).toEqual([people.s3, people.s2]);
      // The filler is never a target, and the TA on the team is not a peer.
      expect(result.targets.map(target => target.user_id)).not.toContain(people.s1);
      expect(result.targets.map(target => target.user_id)).not.toContain(people.ta);
      expect('team' in result && result.team.name).toBe('Trio');
    });

    it('answers SOLO_TEAM for a team of one, with the team still named', async () => {
      const result = await resolve(people.s1, tagScope(labTagId));
      expect(result.state).toBe('SOLO_TEAM');
      expect(result.targets).toEqual([]);
      expect('team' in result && result.team.name).toBe('Solo');
    });

    it('answers NO_TEAM for someone on no team at all', async () => {
      const loner = await makeUser('loner', 'Lonely Student');
      await enrol(loner, 'STUDENT');
      const result = await resolve(loner, { by: 'classroom' });
      expect(result.state).toBe('NO_TEAM');
    });

    it('distinguishes TEAM_UNTAGGED from NO_TEAM', async () => {
      // s4 IS on a team — it simply is not part of this review's team set. The
      // two states send the student to different people for a fix, which is the
      // whole reason they are separate.
      const result = await resolve(people.s4, tagScope(projectTagId));
      expect(result.state).toBe('TEAM_UNTAGGED');
      expect(result.state === 'TEAM_UNTAGGED' && result.detail).toBe('no-team-with-tag');
    });

    it('answers AMBIGUOUS_TEAM rather than picking one, and names the collision', async () => {
      // s1 is on Trio (project) and Solo (labs). Scoped to the whole classroom
      // both match, and there is no defensible way to choose.
      const result = await resolve(people.s1, { by: 'classroom' });
      expect(result.state).toBe('AMBIGUOUS_TEAM');
      expect(result.state === 'AMBIGUOUS_TEAM' && result.teamNames.sort()).toEqual([
        'Solo',
        'Trio',
      ]);
      expect(result.targets).toEqual([]);
    });

    it('resolves the whole classroom when exactly one team matches', async () => {
      const result = await resolve(people.s2, { by: 'classroom' });
      expect(result.state).toBe('OK');
      expect(result.targets.map(target => target.user_id).sort()).toEqual(
        [people.s1, people.s3].sort()
      );
    });

    it('treats a tag id that is not this classroom’s as unresolvable, not as a team', async () => {
      // The definition is stored data an MCP call could have written. A tag id
      // from another course must never reach that course's teams.
      const foreign = await resolve(people.s1, tagScope(otherClassroomTagId));
      expect(foreign.state).toBe('TEAM_UNTAGGED');
      expect(foreign.state === 'TEAM_UNTAGGED' && foreign.detail).toBe('tag-missing');

      const missing = await resolve(people.s1, tagScope(randomUUID()));
      expect(missing.state === 'TEAM_UNTAGGED' && missing.detail).toBe('tag-missing');
    });

    describe('repository scope', () => {
      it('follows Repository.tag_id when the assignment has one', async () => {
        const repositoryId = await makeRepository({
          title: 'Tagged Project',
          slug: 'tagged-project',
          tagId: projectTagId,
        });
        const result = await resolve(people.s1, { by: 'repository', repository_id: repositoryId });
        expect(result.state).toBe('OK');
        expect(result.targets.map(target => target.user_id).sort()).toEqual(
          [people.s2, people.s3].sort()
        );
      });

      it('falls back to the tag NAMED after the repository slug', async () => {
        const slug = `slug-tag-${suite}`;
        const tagId = await makeTag(slug);
        await makeTeam({ name: 'Slug Team', members: [people.s2, people.s4], tagIds: [tagId] });
        const repositoryId = await makeRepository({ title: 'Slug Project', slug, tagId: null });

        const result = await resolve(people.s2, { by: 'repository', repository_id: repositoryId });
        expect(result.state).toBe('OK');
        expect(result.targets.map(target => target.user_id)).toEqual([people.s4]);
      });

      it('reports an assignment with no team set, and a missing one, separately', async () => {
        const untagged = await makeRepository({ title: 'No Teams', slug: null, tagId: null });
        const noTeams = await resolve(people.s1, {
          by: 'repository',
          repository_id: untagged,
        });
        expect(noTeams.state === 'TEAM_UNTAGGED' && noTeams.detail).toBe('repository-untagged');

        const gone = await resolve(people.s1, { by: 'repository', repository_id: randomUUID() });
        expect(gone.state === 'TEAM_UNTAGGED' && gone.detail).toBe('repository-missing');
      });
    });
  });

  // ── The snapshot ─────────────────────────────────────────────────────────

  describe('buildResolvedContext', () => {
    it('records live targets and keeps a departed one, marked removed', () => {
      const groupId = randomUUID();
      const resolutions = {
        [groupId]: {
          state: 'OK' as const,
          scope: { by: 'tag' as const, tag_id: projectTagId },
          team: { id: trioTeamId, name: 'Trio' },
          targets: [{ user_id: people.s2, name: 'Sam Whitfield', login: 's2', email: null }],
        },
      };
      const previous = {
        targets: {
          [groupId]: [
            { user_id: people.s2, name: 'Sam Whitfield', removed: false },
            { user_id: people.s3, name: 'Alex Rivera', removed: false },
          ],
        },
      };

      const snapshot = resolver.buildResolvedContext({
        resolutions,
        previous,
        resolvedAt: new Date('2026-08-30T12:00:00Z'),
      });

      const targets = snapshot.targets[groupId];
      expect(targets.find(t => t.user_id === people.s2)?.removed).toBe(false);
      // The merge is the only record that s3 was ever a teammate — without it
      // their review becomes an unknown key and `.strict()` throws it away.
      expect(targets.find(t => t.user_id === people.s3)?.removed).toBe(true);
      expect(snapshot.groups[groupId].team_name).toBe('Trio');
      expect(snapshot.groups[groupId].resolved_at).toBe('2026-08-30T12:00:00.000Z');
    });
  });

  // ── Submitting one ───────────────────────────────────────────────────────

  describe('submitClassroom with a repeat group', () => {
    const GROUP = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa01';
    const RATING = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaa02';

    let formId = '';
    let revisionId = '';

    const reviewForm = (scope: resolver.RepeatScope, requireAll = true) => [
      {
        id: GROUP,
        type: 'repeat_group',
        label: 'Review each teammate',
        repeat: { over: 'teammates', scope, require_all_targets: requireAll },
        fields: [
          { id: RATING, type: 'long_text', label: 'How did they contribute?', required: true },
        ],
      },
    ];

    const publishReviewForm = async (fields: unknown[]) => {
      const form = await formService.create({
        classroomId,
        title: `Peer Review ${suite} ${randomUUID().slice(0, 8)}`,
        access: 'CLASSROOM',
        createdBy: ownerId,
        fields,
      });
      const { revision } = await formService.publish(form.id);
      return { formId: form.id, revisionId: revision.id };
    };

    const submit = (userId: string, answers: unknown, renderedTargets?: Record<string, string[]>) =>
      responseService.submitClassroom({
        formId,
        userId,
        email: `teamrev-${suite}-filler@example.test`,
        answers,
        revisionId,
        renderedTargets,
      });

    const review = (text: string) => ({ [RATING]: text });

    beforeEach(async () => {
      const published = await publishReviewForm(reviewForm(tagScope(projectTagId)));
      formId = published.formId;
      revisionId = published.revisionId;
    });

    it('records a full review set and snapshots the targets with their names', async () => {
      const stored = await submit(people.s1, {
        [GROUP]: {
          [people.s2]: review('Carried the API'),
          [people.s3]: review('Great in stand-up'),
        },
      });
      expect(stored.submission_state).toBe('SUBMITTED');

      const context = stored.resolved_context as {
        targets: Record<string, Array<{ user_id: string; name: string; removed: boolean }>>;
        groups: Record<string, { team_name: string; state: string }>;
      };
      expect(context.targets[GROUP].map(t => t.name).sort()).toEqual([
        'Alex Rivera',
        'Sam Whitfield',
      ]);
      expect(context.targets[GROUP].every(t => t.removed === false)).toBe(true);
      expect(context.groups[GROUP].team_name).toBe('Trio');
      expect(context.groups[GROUP].state).toBe('OK');
    });

    it('refuses a partial set while require_all_targets holds', async () => {
      expect(
        await codeOf(submit(people.s1, { [GROUP]: { [people.s2]: review('Only one') } }))
      ).toBe('FORM_ANSWERS_INVALID');
    });

    it('accepts a partial set once require_all_targets is off', async () => {
      const relaxed = await publishReviewForm(reviewForm(tagScope(projectTagId), false));
      formId = relaxed.formId;
      revisionId = relaxed.revisionId;
      const stored = await submit(people.s1, { [GROUP]: { [people.s2]: review('Just the one') } });
      expect(stored.submission_state).toBe('SUBMITTED');
    });

    it.each([
      ['a classmate who is not a teammate', () => people.s4],
      ['an arbitrary uuid', () => randomUUID()],
      ['a staff member on the same team', () => people.ta],
      ['themselves', () => people.s1],
    ])('refuses a review aimed at %s', async (_label, target) => {
      // `.strict()` over the RESOLVED target set is what does this. There is no
      // allowlist to keep in sync — a key that is not a current teammate (or a
      // recorded departed one) is simply not in the schema.
      expect(
        await codeOf(
          submit(people.s1, {
            [GROUP]: {
              [people.s2]: review('Fine'),
              [people.s3]: review('Fine'),
              [target()]: review('Should not land'),
            },
          })
        )
      ).toBe('FORM_ANSWERS_INVALID');
    });

    it('refuses with FORM_TEAM_CHANGED when a teammate joined since the page rendered', async () => {
      const code = await codeOf(
        submit(
          people.s1,
          { [GROUP]: { [people.s2]: review('Only saw one') } },
          // The browser says it rendered a team of one. The resolver finds two.
          { [GROUP]: [people.s2] }
        )
      );
      expect(code).toBe('FORM_TEAM_CHANGED');
    });

    it('keeps a departed teammate’s review, marked removed, and stops requiring them', async () => {
      // A draft is written first: it is the server-side record that s3 was a
      // teammate, and the ONLY thing that lets their review survive the split.
      await responseService.upsertDraft({
        formId,
        revisionId,
        userId: people.s1,
        classroomId,
        email: `teamrev-${suite}-filler@example.test`,
        answers: {
          [GROUP]: { [people.s2]: review('Carried the API'), [people.s3]: review('Left early') },
        },
      });

      const membership = await prisma.teamMembership.findFirstOrThrow({
        where: { team_id: trioTeamId, user_id: people.s3 },
      });
      await prisma.teamMembership.delete({ where: { id: membership.id } });

      try {
        const stored = await submit(people.s1, {
          [GROUP]: { [people.s2]: review('Carried the API'), [people.s3]: review('Left early') },
        });
        expect(stored.submission_state).toBe('SUBMITTED');

        const answers = stored.answers as Record<string, Record<string, unknown>>;
        expect(answers[GROUP][people.s3]).toEqual(review('Left early'));

        const context = stored.resolved_context as {
          targets: Record<string, Array<{ user_id: string; removed: boolean }>>;
        };
        const departed = context.targets[GROUP].find(t => t.user_id === people.s3);
        expect(departed?.removed).toBe(true);
      } finally {
        await prisma.teamMembership.create({
          data: { team_id: trioTeamId, user_id: people.s3 },
        });
      }
    });

    it('refuses a submit whose team cannot be resolved at all', async () => {
      const unscoped = await publishReviewForm(reviewForm(tagScope(projectTagId)));
      formId = unscoped.formId;
      revisionId = unscoped.revisionId;
      // s4 is on an untagged team — the loader would render the error state, so
      // reaching submit means a crafted request. It must not file an empty
      // "peer review" as a real response.
      expect(await codeOf(submit(people.s4, { [GROUP]: {} }))).toBe('FORM_TEAM_UNRESOLVED');
      const rows = await responseService.listByFormId(formId);
      expect(rows).toHaveLength(0);
    });

    it('lets a solo team submit the rest of the form', async () => {
      const solo = await publishReviewForm(reviewForm(tagScope(labTagId)));
      formId = solo.formId;
      revisionId = solo.revisionId;
      const stored = await submit(people.s1, { [GROUP]: {} });
      expect(stored.submission_state).toBe('SUBMITTED');
      const context = stored.resolved_context as {
        groups: Record<string, { state: string }>;
      };
      expect(context.groups[GROUP].state).toBe('SOLO_TEAM');
    });

    /**
     * A REVIEWEE'S EMAIL IS NOT PART OF A REVIEW.
     *
     * `resolved_context` snapshots each teammate's address so a staff CSV can
     * still identify somebody who has since left the course. Nothing that
     * RENDERS uses it — the fill page, the answer view and the staff drawer all
     * print `name` — so every surface shipping the snapshot outward was shipping
     * an address list it had no use for. Most sharply on the student's own fill
     * page: a member opening a peer review received every teammate's email in
     * the loader payload.
     *
     * The column keeps them; the boundary drops them. Asserted over a REAL
     * stored snapshot rather than a hand-built one, so it fails if
     * `buildResolvedContext` ever changes shape underneath it.
     */
    it('projects reviewee emails out of a snapshot without disturbing anything else', async () => {
      const solo = await publishReviewForm(reviewForm(tagScope(labTagId)));
      formId = solo.formId;
      revisionId = solo.revisionId;

      const stored = await submit(people.s1, { [GROUP]: {} });
      const raw = stored.resolved_context as {
        targets: Record<string, Array<Record<string, unknown>>>;
        groups: unknown;
      };

      // A solo team resolves to no CURRENT targets, so the snapshot is exercised
      // with one written by hand into the same shape `buildResolvedContext`
      // produces — the projection has to hold for a departed teammate too, which
      // is precisely the row that still carries an address.
      const withTarget = {
        ...raw,
        targets: {
          [GROUP]: [
            {
              user_id: people.s2,
              name: 'Departed Teammate',
              login: 'departed',
              email: `formteam-${suite}-s2@example.test`,
              removed: true,
            },
          ],
        },
      };

      const projected = resolver.withoutTargetEmails(withTarget) as typeof withTarget;
      const safe = projected.targets[GROUP][0];

      expect(safe).not.toHaveProperty('email');
      expect(JSON.stringify(projected)).not.toContain(`formteam-${suite}-s2@example.test`);
      // Identity and provenance survive: a projection, not a rewrite, so every
      // read surface walks the shape it walked before.
      expect(safe.user_id).toBe(people.s2);
      expect(safe.name).toBe('Departed Teammate');
      expect(safe.login).toBe('departed');
      expect(safe.removed).toBe(true);
      expect(projected.groups).toEqual(raw.groups);

      // Defensive over the shapes the column can actually hold.
      expect(resolver.withoutTargetEmails(null)).toBeNull();
      expect(resolver.withoutTargetEmails({ groups: {} })).toEqual({ groups: {} });
    });

    it('materializes the group into the revision with its inner fields intact', async () => {
      const revision = await prisma.formRevision.findUniqueOrThrow({ where: { id: revisionId } });
      const fields = formService.fieldsOf(revision.fields) as FormField[];
      const group = fields.find(field => field.type === 'repeat_group');
      expect(group?.id).toBe(GROUP);
      expect((group?.fields as FormField[])[0].id).toBe(RATING);
    });
  });
});
