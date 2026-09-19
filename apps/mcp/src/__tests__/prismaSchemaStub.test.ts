/**
 * The DMMF-validating Prisma stand-in, testing itself (plan §5.8, P2-8).
 *
 * This harness is the only mechanism in the repo that catches Prisma schema
 * drift in tool code without a database, so its own failure modes have to be
 * pinned down: it must REJECT a misspelled field (at every nesting depth), a
 * nested select on a scalar, and an unknown model — and it must ACCEPT a
 * realistic nested query, or teams will route around it.
 *
 * Each rejection test was mutation-checked by making the harness accept the
 * bad input and watching the test fail; the mutations are named in the
 * comments above the relevant `describe` blocks.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createValidatingPrisma,
  databaseModuleMock,
  prismaCalls,
  prismaCallsFor,
  resetPrismaStub,
  setPrismaRaw,
  setPrismaRows,
  validatingPrisma,
} from './prismaSchemaStub.ts';

// The adoption line P2-7's tools test will copy, exercised here so the
// hoisting works before anyone depends on it. From `src/tools/__tests__` the
// specifier is '../../__tests__/prismaSchemaStub.ts'.
vi.mock('@classmoji/database', async () =>
  (await import('./prismaSchemaStub.ts')).databaseModuleMock()
);

beforeEach(() => {
  resetPrismaStub();
});

// ---------------------------------------------------------------------------
// Accepts valid queries
// ---------------------------------------------------------------------------

describe('valid queries', () => {
  it('accepts a flat select + where against real Page fields', async () => {
    const rows = await validatingPrisma.page.findMany({
      where: { classroom_id: 'class-1', is_draft: false },
      select: { id: true, title: true, is_draft: true },
    });
    expect(rows).toEqual([]);
  });

  /**
   * Mutation (proves this test bites): drop the `RELATION_FILTER_OPS` branch in
   * `assertRelationFilter` so `some` / `every` / `is` are treated as field
   * names -> this throws "Unknown field `is` ... on model `Classroom`" and the
   * test fails.
   */
  it('accepts a deeply nested query: relation filters, nested select, include, orderBy', async () => {
    await expect(
      validatingPrisma.page.findMany({
        where: {
          classroom_id: 'class-1',
          classroom: {
            is: {
              slug: 'cs52',
              memberships: { some: { role: 'STUDENT', user: { is: { email: 'a@b.c' } } } },
            },
          },
          module_items: { every: { module: { is_published: true } } },
          OR: [{ title: { contains: 'midterm' } }, { slug: 'midterm' }],
          NOT: { is_public: false },
        },
        select: {
          id: true,
          title: true,
          classroom: { select: { id: true, slug: true } },
          module_items: {
            select: { id: true, module: { select: { title: true, position: true } } },
            where: { item_type: 'PAGE' },
            orderBy: { position: 'asc' },
          },
          _count: { select: { links: true } },
        },
        orderBy: [{ menu_order: 'asc' }, { classroom: { name: 'desc' } }],
      })
    ).resolves.toEqual([]);
  });

  it('accepts include, distinct and cursor', async () => {
    await expect(
      validatingPrisma.moduleItem.findMany({
        where: { module: { is: { classroom_id: 'class-1' } } },
        include: { page: true, module: { include: { classroom: true } } },
        distinct: ['module_id'],
        cursor: { id: 'mi-1' },
      })
    ).resolves.toEqual([]);
  });

  it('accepts findFirst / findUnique / count / create / update', async () => {
    await validatingPrisma.page.findFirst({ where: { slug: 'syllabus' } });
    await validatingPrisma.page.findUnique({ where: { id: 'p1' }, select: { title: true } });
    await validatingPrisma.page.count({ where: { is_draft: true } });
    await validatingPrisma.page.create({
      data: {
        title: 'New',
        slug: 'new',
        content_path: 'pages/new',
        classroom: { connect: { id: 'class-1' } },
        creator: { connect: { id: 'user-1' } },
      },
    });
    await validatingPrisma.page.update({
      where: { id: 'p1' },
      data: { title: 'Renamed', module_items: { deleteMany: { module_id: 'm-1' } } },
    });
    expect(prismaCalls.map(c => c.method)).toEqual([
      'findFirst',
      'findUnique',
      'count',
      'create',
      'update',
    ]);
  });

  it('accepts a client-extension computed field in select', async () => {
    await expect(
      validatingPrisma.classroom.findMany({ select: { id: true, num_students: true } })
    ).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Rejects a misspelled / nonexistent field
//
// Mutation (proves these bite): delete the `assertWhere(model, args?.where)`
// call in `assertReadArgs` -> the `where` cases below pass when they must
// fail. Likewise delete `assertSelect(model, args?.select, 'select')` for the
// select cases.
// ---------------------------------------------------------------------------

describe('unknown field', () => {
  it('rejects a where on a field the model does not have, naming model and field', async () => {
    await expect(validatingPrisma.page.findMany({ where: { module_id: 'm-1' } })).rejects.toThrow(
      'Unknown field `module_id` for where statement on model `Page`.'
    );
  });

  it('rejects a select of a field the model does not have', async () => {
    // The shape of the bug that shipped: `Module` has neither `weight` nor an
    // `assignments` relation, and every call of the tool threw in production.
    await expect(
      validatingPrisma.module.findMany({ select: { id: true, weight: true } })
    ).rejects.toThrow('Unknown field `weight` for select statement on model `Module`.');
  });

  it('rejects a misspelled field inside a NESTED relation select', async () => {
    await expect(
      validatingPrisma.page.findMany({
        select: { id: true, classroom: { select: { id: true, nmae: true } } },
      })
    ).rejects.toThrow('Unknown field `nmae` for select statement on model `Classroom`.');
  });

  it('rejects a misspelled field inside a `some` relation filter', async () => {
    await expect(
      validatingPrisma.classroom.findMany({
        where: { memberships: { some: { roles: 'STUDENT' } } },
      })
    ).rejects.toThrow('Unknown field `roles` for where statement on model `ClassroomMembership`.');
  });

  it('rejects a misspelled field inside an `every` relation filter', async () => {
    await expect(
      validatingPrisma.page.findMany({
        where: { module_items: { every: { module: { is: { published: true } } } } },
      })
    ).rejects.toThrow('Unknown field `published` for where statement on model `Module`.');
  });

  it('rejects a misspelled field inside an `is` relation filter', async () => {
    await expect(
      validatingPrisma.page.findMany({ where: { classroom: { is: { sulg: 'cs52' } } } })
    ).rejects.toThrow('Unknown field `sulg` for where statement on model `Classroom`.');
  });

  it('rejects a misspelled field inside AND / OR', async () => {
    await expect(
      validatingPrisma.page.findMany({ where: { OR: [{ title: 'x' }, { titel: 'y' }] } })
    ).rejects.toThrow('Unknown field `titel` for where statement on model `Page`.');
  });

  it('rejects a misspelled field in include', async () => {
    await expect(
      validatingPrisma.page.findMany({ include: { modules_items: true } })
    ).rejects.toThrow('Unknown field `modules_items` for include statement on model `Page`.');
  });

  it('rejects a misspelled field in orderBy, including a nested one', async () => {
    await expect(
      validatingPrisma.page.findMany({ orderBy: { menu_ordering: 'asc' } })
    ).rejects.toThrow('Unknown field `menu_ordering` for orderBy statement on model `Page`.');

    await expect(
      validatingPrisma.page.findMany({ orderBy: { classroom: { nmae: 'asc' } } })
    ).rejects.toThrow('Unknown field `nmae` for orderBy statement on model `Classroom`.');
  });

  it('rejects a misspelled field in data, including inside a nested write', async () => {
    await expect(validatingPrisma.page.create({ data: { titel: 'New' } })).rejects.toThrow(
      'Unknown field `titel` for data statement on model `Page`.'
    );

    await expect(
      validatingPrisma.page.create({
        data: { title: 'New', classroom: { connect: { slugg: 'cs52' } } },
      })
    ).rejects.toThrow('Unknown field `slugg` for where statement on model `Classroom`.');

    await expect(
      validatingPrisma.classroom.update({
        where: { id: 'class-1' },
        data: { pages: { create: [{ title: 'ok' }, { titel: 'bad' }] } },
      })
    ).rejects.toThrow('Unknown field `titel` for data statement on model `Page`.');
  });

  it('rejects a computed field used as a filter (it is client-side, not SQL)', async () => {
    await expect(
      validatingPrisma.gitRepoAssignment.findMany({ where: { is_late: true } })
    ).rejects.toThrow(/`GitRepoAssignment.is_late` is a client-extension computed field/);
  });
});

// ---------------------------------------------------------------------------
// Rejects a nested select on a scalar
//
// Mutation (proves this bites): remove the `if (!related) throw ...` guard in
// `assertSelect` -> the nested select is walked as if `title` were a relation,
// nothing throws, and the test fails.
// ---------------------------------------------------------------------------

describe('nested select on a scalar', () => {
  it('rejects a nested select on a scalar field', async () => {
    await expect(
      validatingPrisma.page.findMany({ select: { title: { select: { id: true } } } })
    ).rejects.toThrow('`Page.title` is scalar and cannot take a nested select.');
  });

  it('rejects a nested select on a scalar reached through a relation', async () => {
    await expect(
      validatingPrisma.page.findMany({
        select: { classroom: { select: { slug: { select: { id: true } } } } },
      })
    ).rejects.toThrow('`Classroom.slug` is scalar and cannot take a nested select.');
  });

  it('rejects including a scalar', async () => {
    await expect(validatingPrisma.page.findMany({ include: { title: true } })).rejects.toThrow(
      '`Page.title` is scalar and cannot be included.'
    );
  });
});

// ---------------------------------------------------------------------------
// Rejects an unknown model
//
// Mutation (proves this bites): make the proxy's `get` return a delegate for an
// unrecognised key instead of throwing -> the call resolves and the test fails.
// ---------------------------------------------------------------------------

describe('unknown model', () => {
  it('rejects a model that does not exist, naming the accessor', () => {
    // `RepositoryAssignment` was read in production code for weeks; the model
    // is `GitRepoAssignment`.
    expect(() => validatingPrisma.repositoryAssignment.findMany({})).toThrow(
      'Unknown model `prisma.repositoryAssignment`.'
    );
  });

  it('rejects a model spelled with the wrong case', () => {
    expect(() => validatingPrisma.Page.findMany({})).toThrow('Unknown model `prisma.Page`.');
  });

  it('accepts the real model that bug should have used', async () => {
    await expect(
      validatingPrisma.gitRepoAssignment.findMany({ where: { assignment_id: 'a-1' } })
    ).resolves.toEqual([]);
  });

  it('rejects an unsupported delegate method rather than answering it', async () => {
    await expect(validatingPrisma.page.findManyOrSomething({})).rejects.toThrow(
      /Unsupported method `prisma.page.findManyOrSomething\(\)`/
    );
  });
});

// ---------------------------------------------------------------------------
// Canned rows and call recording
// ---------------------------------------------------------------------------

describe('canned rows', () => {
  it('returns the rows the test supplies, as a value or a function of the args', async () => {
    setPrismaRows({
      page: {
        findMany: [{ id: 'p1', title: 'Syllabus' }],
        findFirst: { id: 'p1' },
        count: 7,
      },
      classroom: {
        findUnique: (args: Record<string, unknown> | undefined) => ({
          id: (args?.where as { id?: string } | undefined)?.id,
        }),
      },
    });

    expect(await validatingPrisma.page.findMany({ where: { classroom_id: 'c1' } })).toEqual([
      { id: 'p1', title: 'Syllabus' },
    ]);
    expect(await validatingPrisma.page.findFirst({})).toEqual({ id: 'p1' });
    expect(await validatingPrisma.page.count({})).toBe(7);
    expect(await validatingPrisma.classroom.findUnique({ where: { id: 'c9' } })).toEqual({
      id: 'c9',
    });
  });

  it('defaults to empty answers when the test supplies nothing', async () => {
    expect(await validatingPrisma.page.findMany({})).toEqual([]);
    expect(await validatingPrisma.page.findFirst({})).toBeNull();
    expect(await validatingPrisma.page.count({})).toBe(0);
  });

  it('throws from findFirstOrThrow when no row is canned', async () => {
    await expect(validatingPrisma.page.findFirstOrThrow({})).rejects.toThrow(
      'No `Page` record found'
    );
  });

  it('records every call in order, with model, method and args', async () => {
    await validatingPrisma.page.findMany({ where: { classroom_id: 'c1' } });
    await validatingPrisma.classroom.count({});
    expect(prismaCalls).toEqual([
      {
        model: 'Page',
        clientKey: 'page',
        method: 'findMany',
        args: { where: { classroom_id: 'c1' } },
      },
      { model: 'Classroom', clientKey: 'classroom', method: 'count', args: {} },
    ]);
  });

  it('resets rows and calls between tests', () => {
    // `beforeEach` ran `resetPrismaStub()`, so the rows set two tests ago are gone.
    expect(prismaCalls).toEqual([]);
  });
});

describe('$queryRaw passthrough', () => {
  it('records the call and returns canned rows without validating SQL', async () => {
    setPrismaRaw([{ page_id: 'p1', distance: 0.12 }]);
    const rows = await (
      validatingPrisma.$queryRaw as unknown as (...a: unknown[]) => Promise<unknown>
    )(['SELECT 1 FROM content_index WHERE classroom_id = ', ''], 'class-1');
    expect(rows).toEqual([{ page_id: 'p1', distance: 0.12 }]);
    expect(prismaCalls[0]).toMatchObject({ model: '$raw', method: '$queryRaw', clientKey: null });
  });

  it('defaults to an empty result set', async () => {
    await expect(
      (validatingPrisma.$queryRawUnsafe as unknown as (...a: unknown[]) => Promise<unknown>)(
        'SELECT 1'
      )
    ).resolves.toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Adoption surface
// ---------------------------------------------------------------------------

describe('adoption surface', () => {
  it('exposes the @classmoji/database module shape both ways round', () => {
    const mod = databaseModuleMock();
    expect(mod.default()).toBe(validatingPrisma);
    expect(mod.getPrisma()).toBe(validatingPrisma);
  });

  it('stands in for @classmoji/database through the documented vi.mock line', async () => {
    const getPrisma = (await import('@classmoji/database')).default;
    expect(getPrisma() as unknown).toBe(validatingPrisma);

    setPrismaRows({ page: { findMany: [{ id: 'p1', title: 'Syllabus' }] } });
    await expect(getPrisma().page.findMany({ where: { classroom_id: 'c1' } })).resolves.toEqual([
      { id: 'p1', title: 'Syllabus' },
    ]);
    expect(prismaCallsFor('page', 'findMany')).toHaveLength(1);

    // ...and the validation still bites through the mocked module. The cast is
    // the point: `getPrisma()` is typed as the real client, so tsc rejects a
    // bad field LITERAL on its own. What it cannot see is a `where` assembled
    // at runtime, which is exactly the shape this harness covers.
    const dynamicWhere: Record<string, unknown> = { module_id: 'm-1' };
    const findMany = getPrisma().page.findMany as unknown as (a: unknown) => Promise<unknown>;
    await expect(findMany({ where: dynamicWhere })).rejects.toThrow(
      'Unknown field `module_id` for where statement on model `Page`.'
    );
  });

  it('supports isolated instances with their own rows and calls', async () => {
    const a = createValidatingPrisma({ page: { findMany: [{ id: 'a' }] } });
    const b = createValidatingPrisma();
    expect(await a.prisma.page.findMany({})).toEqual([{ id: 'a' }]);
    expect(await b.prisma.page.findMany({})).toEqual([]);
    expect(a.calls).toHaveLength(1);
    expect(b.callsFor('page', 'findMany')).toHaveLength(1);
    expect(prismaCalls).toHaveLength(0);
  });

  it('runs a $transaction callback against the same validating client', async () => {
    const result = await (
      validatingPrisma.$transaction as unknown as (
        fn: (tx: typeof validatingPrisma) => Promise<unknown>
      ) => Promise<unknown>
    )(async tx => tx.page.findMany({ where: { classroom_id: 'c1' } }));
    expect(result).toEqual([]);
    expect(prismaCalls.map(c => c.method)).toEqual(['$transaction', 'findMany']);
  });
});
