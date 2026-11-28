import { describe, it, expect, vi } from 'vitest';
import {
  ImportOrganizationNotVerifiedError,
  buildImportedMetadata,
  deriveTeamSlug,
  isGithubLogin,
  organizationRefusalMessage,
  resolveImportedClassroom,
} from '../githubClassroomImport.service.ts';
import { classroomSlugCandidates } from '../classroomSlug.ts';
import type { ImportAcceptance } from '../githubClassroomImport.service.ts';

const baseAcc = (over: Partial<ImportAcceptance> = {}): ImportAcceptance => ({
  type: 'individual',
  students: [{ providerId: '1', login: 'alice', name: 'Alice' }],
  repo: { providerId: '500', name: 'hw1-alice', htmlUrl: 'https://github.com/org/hw1-alice' },
  commitCount: 12,
  submitted: true,
  passing: false,
  grade: null,
  ...over,
});

describe('buildImportedMetadata', () => {
  it('records points and export info when a grade is present', () => {
    const meta = buildImportedMetadata(baseAcc(), {
      pointsAwarded: '80',
      pointsAvailable: '100',
      submissionTimestamp: '2025-01-02T00:00:00Z',
    })!;
    expect(meta).toMatchObject({
      source: 'github_classroom',
      points_awarded: '80',
      points_available: '100',
      submission_timestamp: '2025-01-02T00:00:00Z',
      commit_count: 12,
      submitted: true,
      passing: false,
      original_url: 'https://github.com/org/hw1-alice',
    });
  });

  it('still records export info (commit count etc.) when there is no grade', () => {
    const meta = buildImportedMetadata(baseAcc(), null)!;
    expect(meta.source).toBe('github_classroom');
    expect(meta.commit_count).toBe(12);
    expect(meta).not.toHaveProperty('points_awarded');
  });

  it('omits fields that are absent (no points / no url) but keeps what it has', () => {
    const meta = buildImportedMetadata(
      // commit count present, but no grade and repo has no html_url.
      {
        type: 'individual',
        students: [],
        repo: null,
        commitCount: 3,
        submitted: false,
        passing: false,
      },
      null
    )!;
    expect(meta.commit_count).toBe(3);
    expect(meta).not.toHaveProperty('points_awarded');
    expect(meta).not.toHaveProperty('original_url');
  });

  it('returns null when there is nothing beyond the source tag', () => {
    expect(
      buildImportedMetadata({ type: 'individual', students: [], repo: null }, null)
    ).toBeNull();
  });

  it('handles a group acceptance (multiple students, shared grade) unchanged', () => {
    const groupAcc: ImportAcceptance = {
      type: 'group',
      students: [
        { providerId: '1', login: 'alice', name: 'Alice' },
        { providerId: '2', login: 'bob', name: 'Bob' },
      ],
      repo: {
        providerId: '900',
        name: 'proj1-avengers',
        htmlUrl: 'https://github.com/org/proj1-avengers',
      },
      commitCount: 7,
      submitted: true,
      passing: true,
    };
    const meta = buildImportedMetadata(groupAcc, { pointsAwarded: '18', pointsAvailable: '20' })!;
    expect(meta).toMatchObject({
      source: 'github_classroom',
      points_awarded: '18',
      points_available: '20',
      commit_count: 7,
      passing: true,
      original_url: 'https://github.com/org/proj1-avengers',
    });
  });
});

describe('deriveTeamSlug', () => {
  it('strips the assignment-slug prefix from the repo name', () => {
    expect(deriveTeamSlug('proj1-avengers', 'proj1', ['alice', 'bob'])).toBe('avengers');
  });

  it('strips only the leading prefix once (team name may contain the slug)', () => {
    expect(deriveTeamSlug('proj-proj-team-a', 'proj', ['x'])).toBe('proj-team-a');
  });

  it('is case-insensitive on the prefix', () => {
    expect(deriveTeamSlug('Proj1-Avengers', 'proj1', ['x'])).toBe('avengers');
  });

  it('returns the stripped slug verbatim (does not re-slugify)', () => {
    // A slug titleToIdentifier would leave alone, but we assert verbatim passthrough.
    expect(deriveTeamSlug('hw2-team-99', 'hw2', ['x'])).toBe('team-99');
  });

  it('falls back to a sorted member-set signature when the prefix does not match', () => {
    expect(deriveTeamSlug('hw-old-name', 'newslug', ['bob', 'alice'])).toBe('team-alice-bob');
  });

  it('falls back when the assignment slug is empty', () => {
    expect(deriveTeamSlug('whatever', '', ['carol', 'bob'])).toBe('team-bob-carol');
  });

  it('fallback is order-independent (deterministic for re-import)', () => {
    expect(deriveTeamSlug('x', 'y', ['bob', 'alice', 'carol'])).toBe(
      deriveTeamSlug('x', 'y', ['carol', 'bob', 'alice'])
    );
  });

  it('caps a very long member-set slug deterministically', () => {
    const many = Array.from({ length: 30 }, (_, i) => `student-with-a-long-login-${i}`);
    const slug = deriveTeamSlug('no-match', 'zzz', many)!;
    expect(slug.length).toBeLessThanOrEqual(64);
    expect(slug).toBe(deriveTeamSlug('no-match', 'zzz', [...many].reverse()));
  });

  it('guards against an empty result when the prefix equals the whole name', () => {
    // "proj1-" with slug "proj1" would strip to "" → must not return empty string.
    const slug = deriveTeamSlug('proj1-', 'proj1', ['alice']);
    expect(slug).toBe('team-alice');
  });

  it('returns null when there is no repo name and no members', () => {
    expect(deriveTeamSlug('', '', [])).toBeNull();
  });
});

describe('resolveImportedClassroom', () => {
  type Tx = Parameters<typeof resolveImportedClassroom>[0];

  const makeTx = (rows: { byCourse?: unknown; legacy?: unknown; ownSuffixed?: unknown[] }) => {
    const findUnique = vi.fn(async () => rows.byCourse ?? null);
    const findFirst = vi.fn(async () => rows.legacy ?? null);
    const findMany = vi.fn(async () => rows.ownSuffixed ?? []);
    const update = vi.fn(async (args: { where: { id: string } }) => ({ id: args.where.id }));
    const create = vi.fn(async () => ({ id: 'created' }));
    const tx = { classroom: { findUnique, findFirst, findMany, update, create } } as unknown as Tx;
    return { tx, findUnique, findFirst, findMany, update, create };
  };

  // A course-id match the importer owns (an accepted OWNER membership).
  const owned = (id: string) => ({ id, memberships: [{ id: `m-${id}` }] });
  // A course-id match the importer holds no accepted OWNER membership in.
  const notOwned = (id: string) => ({ id, memberships: [] });
  const ownedByImporter = {
    memberships: { some: { user_id: 'user-1', role: 'OWNER', has_accepted_invite: true } },
  };

  const args = {
    gitOrgId: 'org-1',
    githubClassroomId: 222,
    requestedSlug: 'cs-52',
    candidateSlug: 'cs-52',
    orgLogin: 'Dartmouth',
    name: 'CS 52 Full Stack',
    ownerUserId: 'user-1',
    // The Free-plan rule says there is room (its own tests are the lifecycle's).
    mayCreateActive: async () => true,
    // The importer was verified as an administrator of the organization.
    mayCreateClassroom: true,
  };

  it('matches on the course id first and never touches the slug', async () => {
    const { tx, findUnique, findFirst, update, create } = makeTx({ byCourse: owned('existing') });

    await resolveImportedClassroom(tx, args);

    expect(findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { github_classroom_id: 222 },
        select: expect.objectContaining({
          memberships: expect.objectContaining({
            where: { user_id: 'user-1', role: 'OWNER', has_accepted_invite: true },
          }),
        }),
      })
    );
    expect(findFirst).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ where: { id: 'existing' }, data: { name: args.name } })
    );
  });

  it('creates a new classroom, without the course id, when the course matches a classroom the importer does not own', async () => {
    const { tx, findFirst, update, create } = makeTx({ byCourse: notOwned('someone-else') });
    const onReimported = vi.fn();

    await resolveImportedClassroom(tx, { ...args, onReimported });

    // The legacy probe still runs, for the importer's own rows only.
    expect(findFirst).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
    expect(onReimported).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        data: expect.objectContaining({ github_classroom_id: null, created_by: 'user-1' }),
      })
    );
  });

  it("updates the importer's own legacy row, without the course id another classroom holds", async () => {
    const { tx, update, create } = makeTx({
      byCourse: notOwned('someone-else'),
      legacy: { id: 'legacy-row' },
    });

    await resolveImportedClassroom(tx, args);

    expect(create).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ where: { id: 'legacy-row' }, data: { name: args.name } })
    );
  });

  it('restricts the legacy probe to rows with no github_classroom_id', async () => {
    const { tx, findFirst } = makeTx({});

    await resolveImportedClassroom(tx, args);

    // The predicate is the fix: without `github_classroom_id: null`, a second
    // course whose name slugifies to an already-imported slug would match that
    // classroom's row and overwrite its name and course id.
    expect(findFirst).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        where: {
          git_org_id: 'org-1',
          slug: 'cs-52',
          github_classroom_id: null,
          ...ownedByImporter,
        },
      })
    );
  });

  it('creates on the candidate slug when no legacy row matches', async () => {
    const { tx, update, create } = makeTx({});

    await resolveImportedClassroom(tx, { ...args, candidateSlug: 'cs-52-2' });

    expect(update).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        data: expect.objectContaining({
          git_org_id: 'org-1',
          slug: 'cs-52-2',
          github_classroom_id: 222,
          status: 'ACTIVE',
          // The importer creates it, and it uses their plan slot.
          created_by: 'user-1',
          plan_owner_id: 'user-1',
        }),
      })
    );
  });

  it('creates a NEW classroom LOCKED, and says so, when the importer has no free active slot', async () => {
    const { tx, create } = makeTx({});
    const onCreatedLocked = vi.fn();

    await resolveImportedClassroom(tx, {
      ...args,
      mayCreateActive: async () => false,
      onCreatedLocked,
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'LOCKED' }) })
    );
    expect(onCreatedLocked).toHaveBeenCalledTimes(1);
  });

  it('says when it matched a classroom that already exists, and only then', async () => {
    const onReimported = vi.fn();
    await resolveImportedClassroom(makeTx({ byCourse: owned('existing') }).tx, {
      ...args,
      onReimported,
    });
    await resolveImportedClassroom(makeTx({ legacy: { id: 'legacy' } }).tx, {
      ...args,
      onReimported,
    });
    expect(onReimported).toHaveBeenCalledTimes(2);

    onReimported.mockClear();
    await resolveImportedClassroom(makeTx({}).tx, { ...args, onReimported });
    expect(onReimported).not.toHaveBeenCalled();
  });

  it('never asks about the slot on a re-import', async () => {
    const { tx } = makeTx({ byCourse: owned('existing') });
    const mayCreateActive = vi.fn(async () => false);

    await resolveImportedClassroom(tx, { ...args, mayCreateActive });

    expect(mayCreateActive).not.toHaveBeenCalled();
  });

  it('self-heals a legacy row by stamping the course id onto it', async () => {
    const { tx, update, create } = makeTx({ legacy: { id: 'legacy-row' } });

    await resolveImportedClassroom(tx, args);

    expect(create).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        where: { id: 'legacy-row' },
        data: { name: args.name, github_classroom_id: 222 },
      })
    );
  });

  it('skips the course-id lookup, but still filters the legacy probe, without a course id', async () => {
    const { tx, findUnique, findFirst, update } = makeTx({ legacy: { id: 'legacy-row' } });

    await resolveImportedClassroom(tx, { ...args, githubClassroomId: null });

    expect(findUnique).not.toHaveBeenCalled();
    expect(findFirst).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        where: {
          git_org_id: 'org-1',
          slug: 'cs-52',
          github_classroom_id: null,
          ...ownedByImporter,
        },
      })
    );
    expect(update).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ where: { id: 'legacy-row' }, data: { name: args.name } })
    );
  });

  it("matches the importer's own classroom on a slug candidate when another classroom holds the course id", async () => {
    const { tx, findMany, update, create } = makeTx({
      byCourse: notOwned('someone-else'),
      // Returned out of order: the earliest candidate wins.
      ownSuffixed: [
        { id: 'own-2', slug: 'cs-52-2' },
        { id: 'own-org', slug: 'cs-52-dartmouth' },
      ],
    });
    const onReimported = vi.fn();

    await resolveImportedClassroom(tx, { ...args, candidateSlug: 'cs-52-3', onReimported });

    expect(findMany).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        where: {
          git_org_id: 'org-1',
          slug: { in: classroomSlugCandidates('cs-52', 'Dartmouth') },
          github_classroom_id: null,
          created_by: 'user-1',
          ...ownedByImporter,
        },
      })
    );
    expect(create).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ where: { id: 'own-org' }, data: { name: args.name } })
    );
    expect(onReimported).toHaveBeenCalledTimes(1);
  });

  it('looks at slug candidates only when another classroom holds the course id', async () => {
    for (const rows of [{}, { byCourse: owned('existing') }, { legacy: { id: 'legacy-row' } }]) {
      const { tx, findMany } = makeTx({ ...rows, ownSuffixed: [{ id: 'own', slug: 'cs-52-2' }] });
      await resolveImportedClassroom(tx, args);
      expect(findMany).not.toHaveBeenCalled();
    }
    const { tx, findMany } = makeTx({ ownSuffixed: [{ id: 'own', slug: 'cs-52-2' }] });
    await resolveImportedClassroom(tx, { ...args, githubClassroomId: null });
    expect(findMany).not.toHaveBeenCalled();
  });

  it("prefers the importer's legacy row on the requested slug over a slug candidate", async () => {
    const { tx, findMany, update } = makeTx({
      byCourse: notOwned('someone-else'),
      legacy: { id: 'legacy-row' },
      ownSuffixed: [{ id: 'own', slug: 'cs-52-2' }],
    });

    await resolveImportedClassroom(tx, args);

    expect(findMany).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ where: { id: 'legacy-row' } })
    );
  });

  it('refuses to create, before any write, unless the importer was verified for the organization', async () => {
    const { mayCreateClassroom: _verified, ...unverified } = args;
    for (const over of [{}, { mayCreateClassroom: false }]) {
      const { tx, create, update } = makeTx({});
      const mayCreateActive = vi.fn(async () => true);

      await expect(
        resolveImportedClassroom(tx, {
          ...unverified,
          ...over,
          mayCreateActive,
          refusal:
            'You need to be an owner of the Github organization Dartmouth to import this classroom.',
        })
      ).rejects.toThrow(
        new ImportOrganizationNotVerifiedError(
          'You need to be an owner of the Github organization Dartmouth to import this classroom.'
        )
      );
      expect(create).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      expect(mayCreateActive).not.toHaveBeenCalled();
    }
  });

  it("still updates the importer's own classroom without verification", async () => {
    const { mayCreateClassroom: _verified, ...unverified } = args;
    for (const rows of [{ byCourse: owned('existing') }, { legacy: { id: 'legacy-row' } }]) {
      const { tx, update, create } = makeTx(rows);
      await resolveImportedClassroom(tx, unverified);
      expect(create).not.toHaveBeenCalled();
      expect(update).toHaveBeenCalledTimes(1);
    }
    const { tx, update } = makeTx({
      byCourse: notOwned('someone-else'),
      ownSuffixed: [{ id: 'own', slug: 'cs-52-2' }],
    });
    await resolveImportedClassroom(tx, unverified);
    expect(update).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ where: { id: 'own' } })
    );
  });

  it("also tries the slug candidates of the organization row's own login", async () => {
    const { tx, findMany } = makeTx({ byCourse: notOwned('someone-else') });

    await resolveImportedClassroom(tx, { ...args, storedOrgLogin: 'Dartmouth-Old' });

    const where = (findMany.mock.calls[0] as unknown as [{ where: { slug: { in: string[] } } }])[0]
      .where;
    expect(where.slug.in).toEqual([
      ...new Set([
        ...classroomSlugCandidates('cs-52', 'Dartmouth'),
        ...classroomSlugCandidates('cs-52', 'Dartmouth-Old'),
      ]),
    ]);
  });
});

describe('organizationRefusalMessage', () => {
  const installed = { appInstalled: true };
  const notInstalled = { appInstalled: false };
  const install = (login: string) =>
    `Install the Classmoji Github app on ${login} first (an organization owner can), then import again.`;

  it('names the export login as plain text, and adds what to do for the reason', () => {
    expect(organizationRefusalMessage('cs52-org', 'not_admin', installed)).toBe(
      'You need to be an owner of the Github organization cs52-org to import this classroom.'
    );
    expect(organizationRefusalMessage('cs52-org', 'no_github', installed)).toBe(
      'You need to be an owner of the Github organization cs52-org to import this classroom. ' +
        'Sign in with Github, then try again.'
    );
    expect(organizationRefusalMessage('cs52-org', 'no_access', installed)).toMatch(
      /grant Classmoji access to the organization on Github/
    );
    expect(organizationRefusalMessage('cs52-org', 'unreachable', installed)).toMatch(
      /could not reach Github/
    );
    expect(organizationRefusalMessage('cs52-org', 'token_rejected', installed)).toMatch(
      /sign in with Github again/
    );
  });

  it('asks for the Classmoji Github app first on an organization without it', () => {
    for (const reason of ['not_admin', 'no_access', 'token_rejected', 'mismatch', null] as const) {
      expect(organizationRefusalMessage('cs52-org', reason, notInstalled)).toBe(
        install('cs52-org')
      );
    }
    expect(organizationRefusalMessage('a\u0000b\nc', 'not_admin', notInstalled)).toBe(
      install('abc')
    );
    expect(organizationRefusalMessage(undefined, null, notInstalled)).toBe(
      'Install the Classmoji Github app on the Github organization of this classroom first (an organization owner can), then import again.'
    );
  });

  it('says what to do when the check could not be made, with or without the app', () => {
    expect(organizationRefusalMessage('cs52-org', 'no_github', notInstalled)).toBe(
      'You need to be an owner of the Github organization cs52-org to import this classroom. ' +
        'Sign in with Github, then try again.'
    );
    expect(organizationRefusalMessage('cs52-org', 'unreachable', notInstalled)).toMatch(
      /could not reach Github/
    );
  });

  it('drops control characters, bounds the length, and copes with no login', () => {
    expect(organizationRefusalMessage('a\u0000b\nc', null, installed)).toBe(
      'You need to be an owner of the Github organization abc to import this classroom.'
    );
    expect(organizationRefusalMessage('x'.repeat(500), null, installed).length).toBeLessThan(200);
    expect(organizationRefusalMessage('x'.repeat(500), null, notInstalled).length).toBeLessThan(
      200
    );
    expect(organizationRefusalMessage(undefined, null, installed)).toBe(
      'You need to be an owner of the Github organization of this classroom to import it.'
    );
  });
});

describe('isGithubLogin', () => {
  it('accepts what Github allows and nothing else', () => {
    for (const ok of ['a', 'cs52-org', 'A1-b2', 'x'.repeat(39)])
      expect(isGithubLogin(ok)).toBe(true);
    for (const bad of ['', '-a', 'a-', 'a--b', 'a b', 'a_b', 'x'.repeat(40), 7, null, '<b>']) {
      expect(isGithubLogin(bad)).toBe(false);
    }
  });
});
