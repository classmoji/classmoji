/**
 * The identity mask: which questions' answers every staff and agent surface
 * hides by default (the pages responses page and CSV, the MCP response tools,
 * team sets).
 *
 * The pure half is tested on its own; `identityMaskForForm` against a REAL
 * Postgres, with the same guards as forms.integration.test.ts: fixtures are
 * namespaced with a fresh uuid and torn down by deleting the git organization
 * (which cascades classroom → forms → revisions), and the suite is skipped
 * unless DATABASE_URL names a local, non-shared database.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';

import getPrisma from '@classmoji/database';
import {
  identityMaskForForm,
  identityMaskFromDefinitions,
  nameIsMaskedAnswer,
  responseNames,
} from '../formIdentity.service.ts';

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const isLocal = /@(localhost|127\.0\.0\.1)[:/]/.test(DATABASE_URL);
const isSharedDevDb = /\/classmoji(\?|$)/.test(DATABASE_URL);
const RUN = Boolean(DATABASE_URL) && isLocal && !isSharedDevDb;

const SELF = '11111111-1111-4111-8111-111111111111';
const CHOICE = '22222222-2222-4222-8222-222222222222';
const REASON = '33333333-3333-4333-8333-333333333333';

const reason = { id: REASON, type: 'long_text', label: 'Why this class?', required: false };
const self = (flagged: boolean) => ({
  id: SELF,
  type: 'short_text',
  label: 'Self-description',
  required: false,
  ...(flagged ? { identity_question: true } : {}),
});
const choice = {
  id: CHOICE,
  type: 'dropdown',
  label: 'Which describes you?',
  required: false,
  identity_question: true,
  options: [{ id: 'opt-a', label: 'A' }],
};

/** A stored definition, as FormRevision.fields and Form.draft_fields hold it. */
const def = (...fields: object[]) => ({ definition_version: 1, fields });

const sorted = (mask: Set<string>) => [...mask].sort();

/** The error `code` a thrown call carries, or undefined. */
const codeOf = (call: () => unknown): string | undefined => {
  try {
    call();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
};

describe('identityMaskFromDefinitions', () => {
  it('masks what is flagged in the current revision or in the draft', () => {
    // Flagged only in the draft: hidden as soon as the flag is saved.
    expect(
      sorted(identityMaskFromDefinitions(def(reason, self(false)), def(reason, self(true)), []))
    ).toEqual([SELF]);
    // Flagged only in the current revision: an un-flag waits for publish.
    expect(
      sorted(identityMaskFromDefinitions(def(reason, self(true)), def(reason, self(false)), []))
    ).toEqual([SELF]);
    // Both lists count, and the result is their union.
    expect(
      sorted(identityMaskFromDefinitions(def(reason, self(true)), def(reason, choice), []))
    ).toEqual([SELF, CHOICE].sort());
  });

  it('keeps a flagged field deleted since an older revision masked', () => {
    const v1 = def(reason, self(true));
    const v2 = def(reason);
    expect(sorted(identityMaskFromDefinitions(v2, v2, [v1]))).toEqual([SELF]);
  });

  it('honours an un-flag once it is published', () => {
    const v1 = def(reason, self(true));
    const v2 = def(reason, self(false));
    expect(identityMaskFromDefinitions(v2, v2, [v1]).size).toBe(0);
  });

  it('does not let an unpublished draft copy un-mask a field the current revision dropped', () => {
    // v1 flagged it, v2 (current) removed it, and the draft holds it un-flagged.
    // Nothing published un-flagged it, so v1's answers stay hidden.
    const v1 = def(reason, self(true));
    const v2 = def(reason);
    expect(sorted(identityMaskFromDefinitions(v2, def(reason, self(false)), [v1]))).toEqual([SELF]);
  });

  it('takes plain field lists as well as stored definitions', () => {
    expect(sorted(identityMaskFromDefinitions([reason, self(true)], null, [[choice]]))).toEqual(
      [SELF, CHOICE].sort()
    );
  });

  it('a never-published, never-edited form masks nothing', () => {
    expect(identityMaskFromDefinitions(null, null, []).size).toBe(0);
    expect(identityMaskFromDefinitions(undefined, undefined, []).size).toBe(0);
  });

  it('throws on a definition it cannot read, wherever it is', () => {
    const bad = { nope: true };
    expect(codeOf(() => identityMaskFromDefinitions(bad, null, []))).toBe(
      'FORM_DEFINITION_INVALID'
    );
    expect(codeOf(() => identityMaskFromDefinitions(null, bad, []))).toBe(
      'FORM_DEFINITION_INVALID'
    );
    expect(codeOf(() => identityMaskFromDefinitions(def(reason), null, [bad]))).toBe(
      'FORM_DEFINITION_INVALID'
    );
    // `{}` is what a hand-written or truncated draft would look like: still no.
    expect(codeOf(() => identityMaskFromDefinitions(null, {}, []))).toBe('FORM_DEFINITION_INVALID');
  });
});

/**
 * A public fill copies a short-text "name" answer into the response's `name`.
 * Responses stored before that question was flagged keep it there, and `name`
 * is on every list surface: the name that equals a masked answer is not shown.
 */
describe('nameIsMaskedAnswer', () => {
  const mask = new Set([SELF]);

  it("is true when the name is the response's answer to a masked question", () => {
    expect(nameIsMaskedAnswer('Sam', { [SELF]: 'Sam', [REASON]: 'Curious' }, mask)).toBe(true);
    // The fill path stored the answer trimmed.
    expect(nameIsMaskedAnswer('Sam', { [SELF]: '  Sam ' }, mask)).toBe(true);
  });

  it('is false when the name matches only an unmasked answer', () => {
    expect(nameIsMaskedAnswer('Sam', { [REASON]: 'Sam', [SELF]: 'Other' }, mask)).toBe(false);
  });

  it('is false with no mask, no name, or no string answer to compare', () => {
    expect(nameIsMaskedAnswer('Sam', { [SELF]: 'Sam' }, new Set())).toBe(false);
    expect(nameIsMaskedAnswer(null, { [SELF]: '' }, mask)).toBe(false);
    expect(nameIsMaskedAnswer('', { [SELF]: '' }, mask)).toBe(false);
    expect(nameIsMaskedAnswer('Sam', { [SELF]: ['Sam'] }, mask)).toBe(false);
    expect(nameIsMaskedAnswer('Sam', null, mask)).toBe(false);
    expect(nameIsMaskedAnswer('Sam', ['Sam'], mask)).toBe(false);
  });
});

describe('responseNames without a database', () => {
  it('keeps every stored name, and reads no account, when none is a masked answer', async () => {
    const rows = [
      { id: 'r1', name: 'Sam', user_id: 'u1', answers: { [SELF]: 'Other' } },
      { id: 'r2', name: null, user_id: null, answers: {} },
    ];
    expect(await responseNames(rows, new Set([SELF]))).toEqual(
      new Map([
        ['r1', 'Sam'],
        ['r2', null],
      ])
    );
  });

  it('gives a replaced name without an account null', async () => {
    const rows = [{ id: 'r1', name: 'Sam', user_id: null, answers: { [SELF]: 'Sam' } }];
    expect((await responseNames(rows, new Set([SELF]))).get('r1')).toBeNull();
  });
});

describe.skipIf(!RUN)('identityMaskForForm (integration)', () => {
  const suite = randomUUID().slice(0, 8);
  const prisma = getPrisma();
  let orgId: string;
  let classroomId: string;
  let ownerId: string;

  /** A form with the given revisions (in version order) and draft. */
  const makeForm = async ({
    revisions,
    current = revisions.length > 0 ? revisions.length - 1 : null,
    draft = null,
  }: {
    revisions: object[];
    current?: number | null;
    draft?: object | null;
  }) => {
    const form = await prisma.form.create({
      data: {
        classroom_id: classroomId,
        title: `Identity ${suite}`,
        slug: `identity-${suite}-${randomUUID().slice(0, 8)}`,
        access: 'CLASSROOM',
        status: 'OPEN',
        created_by: ownerId,
        ...(draft ? { draft_fields: draft } : {}),
      },
    });
    const ids: string[] = [];
    for (const [index, fields] of revisions.entries()) {
      const revision = await prisma.formRevision.create({
        data: { form_id: form.id, version: index + 1, fields },
      });
      ids.push(revision.id);
    }
    if (current !== null) {
      await prisma.form.update({
        where: { id: form.id },
        data: { current_revision_id: ids[current] },
      });
    }
    return form.id;
  };

  beforeAll(async () => {
    const org = await prisma.gitOrganization.create({
      data: {
        provider: 'GITHUB',
        provider_id: `identitytest-${suite}`,
        login: `identitytest-org-${suite}`,
      },
    });
    orgId = org.id;
    const classroom = await prisma.classroom.create({
      data: {
        slug: `identitytest-${suite}`,
        git_org_id: orgId,
        name: `Identity Test ${suite}`,
        content_namespace: `identitytest-${suite}`,
        content_repo: `content-identitytest-${suite}`,
      },
    });
    classroomId = classroom.id;
    const owner = await prisma.user.create({
      data: {
        accounts: {
          create: {
            provider_id: 'github',
            account_id: `identitytest-${suite}-owner`,
            username: `identitytest-${suite}-owner`,
          },
        },
        email: `identitytest-${suite}-owner@example.test`,
        name: 'Identity Test Owner',
      },
    });
    ownerId = owner.id;
  });

  afterAll(async () => {
    if (orgId) await prisma.gitOrganization.delete({ where: { id: orgId } }).catch(() => {});
    await prisma.user
      .deleteMany({
        where: {
          accounts: {
            some: { provider_id: 'github', username: { startsWith: `identitytest-${suite}-` } },
          },
        },
      })
      .catch(() => {});
  });

  it('reads the current revision, the draft and the older revisions', async () => {
    const formId = await makeForm({
      revisions: [def(reason, self(true)), def(reason)],
      draft: def(reason, choice),
    });
    expect(sorted(await identityMaskForForm({ formId }))).toEqual([SELF, CHOICE].sort());
  });

  it('uses the revision current_revision_id names, not the newest', async () => {
    // v2 un-flagged it, but the form still points at v1, where it is flagged.
    const formId = await makeForm({
      revisions: [def(reason, self(true)), def(reason, self(false))],
      current: 0,
    });
    expect(sorted(await identityMaskForForm({ formId }))).toEqual([SELF]);
  });

  it('falls back to the newest revision when nothing is current', async () => {
    const formId = await makeForm({
      revisions: [def(reason, self(true)), def(reason, self(false))],
      current: null,
    });
    // The newest (v2) un-flagged it and still has it: nothing hidden.
    expect((await identityMaskForForm({ formId })).size).toBe(0);
  });

  it('a never-published draft-only form uses the draft', async () => {
    const formId = await makeForm({ revisions: [], draft: def(reason, self(true)) });
    expect(sorted(await identityMaskForForm({ formId }))).toEqual([SELF]);
  });

  it('fails closed on an unreadable stored definition', async () => {
    const formId = await makeForm({ revisions: [def(reason)], draft: { nope: true } });
    await expect(identityMaskForForm({ formId })).rejects.toMatchObject({
      code: 'FORM_DEFINITION_INVALID',
    });
  });

  it('refuses an unknown form', async () => {
    await expect(identityMaskForForm({ formId: randomUUID() })).rejects.toMatchObject({
      code: 'FORM_NOT_FOUND',
    });
  });

  it('responseNames falls back to the account name, or the login, for a replaced name', async () => {
    const named = await prisma.user.create({
      data: {
        accounts: {
          create: {
            provider_id: 'github',
            account_id: `identitytest-${suite}-named`,
            username: `identitytest-${suite}-named`,
          },
        },
        email: `identitytest-${suite}-named@example.test`,
        name: 'Account Name',
      },
    });
    const unnamed = await prisma.user.create({
      data: {
        accounts: {
          create: {
            provider_id: 'github',
            account_id: `identitytest-${suite}-login`,
            username: `identitytest-${suite}-login`,
          },
        },
        email: `identitytest-${suite}-login@example.test`,
      },
    });
    const mask = new Set([SELF]);
    const names = await responseNames(
      [
        { id: 'r-named', name: 'Chosen', user_id: named.id, answers: { [SELF]: 'Chosen' } },
        { id: 'r-login', name: 'Chosen', user_id: unnamed.id, answers: { [SELF]: 'Chosen' } },
        { id: 'r-gone', name: 'Chosen', user_id: randomUUID(), answers: { [SELF]: 'Chosen' } },
        { id: 'r-kept', name: 'Stored', user_id: named.id, answers: { [SELF]: 'Other' } },
      ],
      mask
    );
    expect(Object.fromEntries(names)).toEqual({
      'r-named': 'Account Name',
      'r-login': `identitytest-${suite}-login`,
      // An account that no longer exists: nothing to fall back to.
      'r-gone': null,
      'r-kept': 'Stored',
    });
  });
});
