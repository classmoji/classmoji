/**
 * Responses per person on the classroom fill page: what the loader decides for
 * ONE, REPLACE and MANY forms (the mode, what it prefills from, what it ships),
 * how the action treats an autosave and a submit around a MANY response, and
 * the builder's three choices.
 *
 * The real `resolveClassroomForm` and the real fill action run with their
 * database module stubbed (`importWithStubs`). The stub is a fake of the
 * service's OWN reads, so what is pinned here is the page's side: which read
 * it asks for, with which ids, and what it does with the answer. That those
 * reads are scoped in the database (user A gets nothing of user B's) is tested
 * against Postgres in packages/services `forms.integration.test.ts`
 * ("one response by id only for its own filler").
 */
import { test, expect } from '@playwright/test';

import { importWithStubs, stubModule } from '../helpers/dataRequest.helpers.ts';
import {
  publicSwitchBlockedReason,
  responsesPerPersonChoices,
  responsesPerPersonOf,
} from '../../app/components/forms/responsesPerPerson.ts';
import {
  canStartAnother,
  loaderDataAfterSubmit,
  seedForNewResponse,
} from '../../app/forms/fill/manyResponses.ts';

const FORM_ID = 'form-1';
const SESSION_USER = 'user-a';
const REVISION = 'rev-2';
const OLD_REVISION = 'rev-1';
const FIELD = { id: 'q-1', type: 'short_text', label: 'What did you do?', required: false };

type Row = {
  id: string;
  form_id: string;
  revision_id: string;
  user_id: string;
  email: string;
  name: string | null;
  answers: Record<string, unknown>;
  resolved_context: unknown;
  submission_state: 'DRAFT' | 'SUBMITTED';
  verified_at: Date | null;
  submitted_at: Date;
  updated_at: Date;
};

type Fakes = {
  session: { userId: string } | null;
  role: string | null;
  /** Every row of every user on the form; the fake reads below filter it as the service does. */
  rows: Row[];
  /** SUBMITTED + verified rows on the form, as the cap counts them. */
  verifiedCount: number;
  calls: { name: string; args: unknown[] }[];
  upserts: unknown[];
  submits: unknown[];
  loaded: unknown;
  /** What the fake upsertDraft answers; `{}` is a row. */
  upsertResult: unknown;
  /** Whether the fake member limiter lets a submit through. */
  memberAllowed: boolean;
  memberSubmits: unknown[];
  /** The fake list holds at most this many (the service's cap, smaller). */
  listMax: number;
};

const fakes: Fakes = {
  session: null,
  role: null,
  rows: [],
  verifiedCount: 0,
  calls: [],
  upserts: [],
  submits: [],
  loaded: null,
  upsertResult: {},
  memberAllowed: true,
  memberSubmits: [],
  listMax: 100,
};
(globalThis as unknown as { __perPersonFakes: Fakes }).__perPersonFakes = fakes;

const DB_SERVER = stubModule(`
const f = () => globalThis.__perPersonFakes;
const call = (name, args) => f().calls.push({ name, args });
const mine = (formId, userId) => f().rows.filter(r => r.form_id === formId && r.user_id === userId);
const newestFirst = (a, b) => b.submitted_at - a.submitted_at;
export const getAuthSession = async () => f().session;
export const prisma = {
  user: {
    findUnique: async ({ where }) =>
      where.id === '${SESSION_USER}'
        ? { id: '${SESSION_USER}', name: 'Ada', email: 'ada@example.test', accounts: [] }
        : null,
  },
  formResponse: {
    count: async args => {
      call('count', [args]);
      return f().verifiedCount;
    },
  },
  formRevision: {
    findFirst: async ({ where }) =>
      where.form_id === '${FORM_ID}' && where.id === '${OLD_REVISION}'
        ? { id: '${OLD_REVISION}', fields: [{ ...${JSON.stringify(FIELD)}, label: 'Old question' }] }
        : null,
  },
};
export const ClassmojiService = {
  form: {
    getCurrentRevision: async () => ({ id: '${REVISION}', fields: [${JSON.stringify(FIELD)}] }),
    fieldsOf: fields => (Array.isArray(fields) ? fields : (fields?.fields ?? [])),
  },
  formResponse: {
    findOwnResponse: async (formId, userId) => {
      call('findOwnResponse', [formId, userId]);
      const rows = mine(formId, userId);
      return rows.filter(r => r.submission_state === 'SUBMITTED').sort(newestFirst)[0] ?? rows[0] ?? null;
    },
    findOwnDraft: async (formId, userId) => {
      call('findOwnDraft', [formId, userId]);
      return mine(formId, userId).find(r => r.submission_state === 'DRAFT') ?? null;
    },
    listOwnResponseSummaries: async (formId, userId) => {
      call('listOwnResponseSummaries', [formId, userId]);
      const sent = mine(formId, userId).filter(r => r.submission_state === 'SUBMITTED').sort(newestFirst);
      return {
        total: sent.length,
        responses: sent.slice(0, f().listMax).map(r => ({ id: r.id, submitted_at: r.submitted_at })),
      };
    },
    ownResponseNumber: async (formId, userId, response) => {
      call('ownResponseNumber', [formId, userId, response.id]);
      return mine(formId, userId).filter(
        r => r.submission_state === 'SUBMITTED' && r.submitted_at <= response.submitted_at
      ).length;
    },
    findOwnSubmittedResponse: async (formId, userId, responseId) => {
      call('findOwnSubmittedResponse', [formId, userId, responseId]);
      return (
        mine(formId, userId).find(r => r.id === responseId && r.submission_state === 'SUBMITTED') ??
        null
      );
    },
    DRAFT_DECLINED: 'DRAFT_DECLINED',
    upsertDraft: async args => {
      f().upserts.push(args);
      return f().upsertResult;
    },
    submitClassroom: async args => {
      f().submits.push(args);
      return {};
    },
  },
  formTeam: {
    resolveRepeatGroups: async () => ({}),
    priorTargets: () => ({}),
    isBlockingRepeatState: () => false,
    withoutTargetEmails: context => (context ? { stripped: true } : null),
  },
};
`);

type Load = Record<string, unknown> & { view: string };
type Resolve = (args: {
  classroom: { id: string };
  form: Record<string, unknown>;
  theme: { background: string; darkBackground: string };
  classroomName: string;
  request: Request;
  loginUrl: string;
  viewResponseId?: string | null;
}) => Promise<Load>;

let resolveClassroomForm: Resolve;

test.beforeAll(async () => {
  ({ resolveClassroomForm } = await importWithStubs<{ resolveClassroomForm: Resolve }>(
    new URL('../../app/forms/fill/classroomForm.server.ts', import.meta.url),
    {
      '/app/utils/db.server.ts': DB_SERVER,
      '/app/utils/classroomRole.server.ts': stubModule(
        'export const findClassroomRole = async () => globalThis.__perPersonFakes.role;'
      ),
      '@classmoji/database': stubModule('export const GIT_IDENTITY = {};'),
    }
  ));
});

test.beforeEach(() => {
  fakes.session = { userId: SESSION_USER };
  fakes.role = 'STUDENT';
  fakes.rows = [];
  fakes.verifiedCount = 0;
  fakes.calls = [];
  fakes.upserts = [];
  fakes.submits = [];
  fakes.loaded = null;
  fakes.upsertResult = {};
  fakes.memberAllowed = true;
  fakes.memberSubmits = [];
  fakes.listMax = 100;
});

let seq = 0;
const row = (patch: Partial<Row> = {}): Row => {
  seq += 1;
  return {
    id: `resp-${seq}`,
    form_id: FORM_ID,
    revision_id: REVISION,
    user_id: SESSION_USER,
    email: 'ada@example.test',
    name: 'Ada',
    answers: { [FIELD.id]: `answer ${seq}` },
    resolved_context: null,
    submission_state: 'SUBMITTED',
    verified_at: new Date('2026-11-01T10:00:00.000Z'),
    submitted_at: new Date(Date.UTC(2026, 10, 1, 10, seq)),
    updated_at: new Date(Date.UTC(2026, 10, 1, 10, seq)),
    ...patch,
  };
};

const form = (patch: Record<string, unknown> = {}) => ({
  id: FORM_ID,
  title: 'Weekly check-in',
  description: null,
  status: 'OPEN',
  closes_at: null,
  response_cap: null,
  current_revision_id: REVISION,
  responses_per_person: 'ONE',
  ...patch,
});

const load = (formPatch: Record<string, unknown> = {}, viewResponseId: string | null = null) =>
  resolveClassroomForm({
    classroom: { id: 'class-1' },
    form: form(formPatch),
    theme: { background: '#fff', darkBackground: '#000' },
    classroomName: 'Intro',
    request: new Request('http://localhost/intro/forms/check-in'),
    loginUrl: 'http://localhost/login',
    viewResponseId,
  });

const called = (name: string) => fakes.calls.filter(entry => entry.name === name);
const CLOSED_AT = new Date('2020-01-01T00:00:00.000Z');

test.describe('ONE and REPLACE: unchanged', () => {
  test('ONE: nothing yet is a form to fill, with no responses list', async () => {
    const loaded = await load();
    expect(loaded).toMatchObject({
      view: 'classroom-fill',
      mode: 'fill',
      many: false,
      ownResponses: [],
      notAccepting: null,
      viewing: null,
      storedAnswers: null,
    });
    expect(called('findOwnResponse')).toHaveLength(1);
    expect(called('listOwnResponseSummaries')).toHaveLength(0);
  });

  test('ONE: a submitted response is final, and shown', async () => {
    const sent = row();
    fakes.rows = [sent];
    const loaded = await load();
    expect(loaded).toMatchObject({ mode: 'recorded', storedAnswers: sent.answers });
  });

  test('ONE: a submitted response inside a full cap is still recorded, not counted', async () => {
    fakes.rows = [row()];
    fakes.verifiedCount = 5;
    expect(await load({ response_cap: 5 })).toMatchObject({ mode: 'recorded' });
    expect(called('count')).toHaveLength(0);
  });

  test('ONE: a draft is brought back', async () => {
    const draft = row({ submission_state: 'DRAFT' });
    fakes.rows = [draft];
    expect(await load()).toMatchObject({
      mode: 'fill',
      storedAnswers: draft.answers,
      restoredDraft: true,
    });
  });

  test('REPLACE: a submitted response is editable while the form is open, final once shut', async () => {
    fakes.rows = [row()];
    expect(await load({ responses_per_person: 'REPLACE' })).toMatchObject({ mode: 'update' });
    expect(await load({ responses_per_person: 'REPLACE', status: 'CLOSED' })).toMatchObject({
      mode: 'recorded',
    });
  });

  test('ONE: `?response=` is not read', async () => {
    fakes.rows = [row()];
    const loaded = await load({}, 'resp-anything');
    expect(loaded).toMatchObject({ viewing: null });
    expect(called('findOwnSubmittedResponse')).toHaveLength(0);
  });

  test('ONE: closed with nothing sent is the closed page', async () => {
    expect(await load({ status: 'CLOSED' })).toMatchObject({ view: 'closed' });
  });
});

test.describe('MANY', () => {
  const MANY = { responses_per_person: 'MANY' };

  test('nothing yet: a form to fill, and no list', async () => {
    const loaded = await load(MANY);
    expect(loaded).toMatchObject({
      view: 'classroom-fill',
      mode: 'fill',
      many: true,
      ownResponses: [],
      ownResponseCount: 0,
      storedAnswers: null,
      restoredDraft: false,
    });
    // The page never reads "the" response of a MANY form.
    expect(called('findOwnResponse')).toHaveLength(0);
    expect(called('findOwnDraft')[0].args).toEqual([FORM_ID, SESSION_USER]);
    expect(called('listOwnResponseSummaries')[0].args).toEqual([FORM_ID, SESSION_USER]);
  });

  test('after a submit: still a NEW, empty form, and the responses as a list of ids and times', async () => {
    const first = row({ answers: { [FIELD.id]: 'first secret answer' } });
    const second = row({ answers: { [FIELD.id]: 'second secret answer' } });
    fakes.rows = [first, second];

    const loaded = await load(MANY);
    expect(loaded).toMatchObject({
      mode: 'fill',
      storedAnswers: null,
      restoredDraft: false,
      revisionChanged: false,
      ownResponses: [
        { id: second.id, submittedAt: second.submitted_at.toISOString() },
        { id: first.id, submittedAt: first.submitted_at.toISOString() },
      ],
      ownResponseCount: 2,
    });
    expect(Object.keys((loaded.ownResponses as object[])[0]).sort()).toEqual(['id', 'submittedAt']);

    // What reaches the browser carries none of the earlier answers.
    const { server: _server, ...client } = loaded;
    expect(JSON.stringify(client)).not.toContain('secret answer');
  });

  test('prefills from the draft only, never from an earlier response', async () => {
    const draft = row({ submission_state: 'DRAFT', answers: { [FIELD.id]: 'half typed' } });
    fakes.rows = [row({ answers: { [FIELD.id]: 'sent already' } }), draft];
    expect(await load(MANY)).toMatchObject({
      mode: 'fill',
      storedAnswers: { [FIELD.id]: 'half typed' },
      restoredDraft: true,
    });
  });

  test('a draft from an older revision is not poured into the new form', async () => {
    fakes.rows = [row(), row({ submission_state: 'DRAFT', revision_id: OLD_REVISION })];
    expect(await load(MANY)).toMatchObject({
      mode: 'fill',
      storedAnswers: null,
      revisionChanged: true,
      restoredDraft: false,
    });
  });

  test('another user’s rows are not this user’s responses', async () => {
    fakes.rows = [
      row({ user_id: 'user-b' }),
      row({ user_id: 'user-b', submission_state: 'DRAFT' }),
    ];
    expect(await load(MANY)).toMatchObject({ ownResponses: [], storedAnswers: null });
  });

  test('closed with responses: no new response, the list stays', async () => {
    const sent = row();
    fakes.rows = [sent, row({ submission_state: 'DRAFT' })];
    const loaded = await load({ ...MANY, closes_at: CLOSED_AT });
    expect(loaded).toMatchObject({
      view: 'classroom-fill',
      mode: 'listed',
      notAccepting: 'closed',
      ownResponses: [{ id: sent.id }],
      // Nothing to fill, so nothing to prefill.
      storedAnswers: null,
      restoredDraft: false,
      revisionChanged: false,
    });
  });

  test('closed with nothing sent is the closed page', async () => {
    expect(await load({ ...MANY, status: 'CLOSED' })).toMatchObject({ view: 'closed' });
  });

  test('the cap is checked for the next response even after one was sent', async () => {
    fakes.rows = [row()];
    fakes.verifiedCount = 3;
    const full = await load({ ...MANY, response_cap: 3 });
    expect(full).toMatchObject({ mode: 'listed', notAccepting: 'full' });
    expect(called('count')).toHaveLength(1);

    fakes.verifiedCount = 2;
    expect(await load({ ...MANY, response_cap: 3 })).toMatchObject({
      mode: 'fill',
      notAccepting: null,
    });
  });

  test('a full cap with nothing sent is the closed page', async () => {
    fakes.verifiedCount = 3;
    expect(await load({ ...MANY, response_cap: 3 })).toMatchObject({ view: 'closed' });
  });

  test('`?response=` opens one earlier response, asked for with the session user', async () => {
    const sent = row({
      revision_id: OLD_REVISION,
      answers: { [FIELD.id]: 'what I sent' },
      resolved_context: { groups: { emails: ['b@example.test'] } },
    });
    fakes.rows = [sent, row()];
    const loaded = await load(MANY, sent.id);

    expect(called('findOwnSubmittedResponse')[0].args).toEqual([FORM_ID, SESSION_USER, sent.id]);
    expect(loaded.viewing).toEqual({
      id: sent.id,
      // The first of two sent, numbered from the listed page.
      number: 1,
      submittedAt: sent.submitted_at.toISOString(),
      // The revision it answered, not the current one.
      fields: [{ ...FIELD, label: 'Old question' }],
      answers: { [FIELD.id]: 'what I sent' },
      resolvedContext: { stripped: true },
      revisionChanged: true,
    });
    // The page shows the response, not the form: no draft is shipped with it.
    expect(loaded).toMatchObject({ storedAnswers: null });
  });

  test('`?response=` naming another user’s response, a draft, or nothing is a 404', async () => {
    const theirs = row({ user_id: 'user-b' });
    const draft = row({ submission_state: 'DRAFT' });
    fakes.rows = [row(), theirs, draft];
    for (const id of [theirs.id, draft.id, 'no-such-response']) {
      const thrown = await load(MANY, id).then(
        () => null,
        error => error as Response
      );
      expect(thrown, id).toBeInstanceOf(Response);
      expect(thrown?.status, id).toBe(404);
    }
  });

  test('`?response=` still opens once the form is closed', async () => {
    const sent = row();
    fakes.rows = [sent];
    const loaded = await load({ ...MANY, status: 'CLOSED' }, sent.id);
    expect(loaded).toMatchObject({ mode: 'listed', viewing: { id: sent.id } });
  });

  test('a long list ships its newest page with the exact count, and numbers beyond it', async () => {
    fakes.listMax = 2;
    const oldest = row();
    fakes.rows = [oldest, row(), row(), row()];
    const loaded = await load(MANY);
    expect(loaded).toMatchObject({ ownResponseCount: 4 });
    expect(loaded.ownResponses as unknown[]).toHaveLength(2);

    // An earlier response the page does not list is still numbered from the first.
    const viewed = await load(MANY, oldest.id);
    expect(viewed.viewing).toMatchObject({ id: oldest.id, number: 1 });
    expect(called('ownResponseNumber').at(-1)?.args).toEqual([FORM_ID, SESSION_USER, oldest.id]);
  });

  test('a stranger is asked to sign in before any response is read', async () => {
    fakes.session = null;
    expect(await load(MANY, 'resp-1')).toMatchObject({ view: 'signin' });
    fakes.session = { userId: SESSION_USER };
    fakes.role = null;
    expect(await load(MANY, 'resp-1')).toMatchObject({ view: 'not-member' });
    expect(called('findOwnSubmittedResponse')).toHaveLength(0);
  });
});

// ─── The action ─────────────────────────────────────────────────────────────

type Action = (args: {
  params: Record<string, string>;
  request: Request;
  url: URL;
}) => Promise<unknown>;

let action: Action;

const STUB = (source: string) => stubModule(source);

test.describe('the fill action around a MANY response', () => {
  test.beforeAll(async () => {
    ({ action } = await importWithStubs<{ action: Action }>(
      new URL('../../app/forms/fill/fill.tsx', import.meta.url),
      {
        '.css': STUB(''),
        '/app/utils/db.server.ts': DB_SERVER,
        '/app/utils/originCheck.server.ts': STUB(`
export const checkOrigin = () => ({ ok: true });
export const readCappedBody = request => request.text();
`),
        '/app/utils/submissionRate.server.ts': STUB(`
export const clientIpFor = () => null;
export const recordAddressProbe = () => {};
export const recordSubmissionAttempt = () => ({ allowed: true });
export const recordMemberSubmission = (userId, formId) => {
  globalThis.__perPersonFakes.memberSubmits.push([userId, formId]);
  return { allowed: globalThis.__perPersonFakes.memberAllowed, retryAfterSeconds: 60 };
};
`),
        '/app/utils/formLinkCookie.server.ts': STUB(`
export const EDIT_LINK_COOKIE_MAX_AGE_SECONDS = 0;
export const formLinkCookie = () => '';
export const formWatchCookie = () => '';
export const readFormLinkCookie = () => null;
export const readFormWatchCookie = () => null;
`),
        '/app/utils/tasks.server.ts': STUB('export const dispatchVerifyEmail = async () => {};'),
        '/app/utils/emailDomain.server.ts': STUB(`
export const checkMailDomain = async () => 'ok';
export const domainOf = () => null;
export const suggestDomain = () => null;
`),
        '/app/forms/fill/publicForm.server.ts': STUB(
          'export const loadPublicForm = async () => globalThis.__perPersonFakes.loaded;'
        ),
      }
    ));
  });

  const loadedMany = (patch: Record<string, unknown> = {}) => ({
    view: 'classroom-fill',
    form: { id: FORM_ID, title: 'Weekly check-in', description: null },
    revisionId: REVISION,
    identity: { name: 'Ada', email: 'ada@example.test' },
    mode: 'fill',
    many: true,
    ownResponses: [{ id: 'resp-a', submittedAt: '2026-11-01T10:00:00.000Z' }],
    ownResponseCount: 1,
    server: { userId: SESSION_USER, classroomId: 'class-1', injected: {} },
    ...patch,
  });

  const post = (body: Record<string, unknown>) =>
    action({
      params: { classroomSlug: 'intro', formSlug: 'check-in' },
      request: new Request('http://localhost/intro/forms/check-in', {
        method: 'POST',
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json' },
      }),
      url: new URL('http://localhost/intro/forms/check-in'),
    });

  const autosave = (responsesSeen: unknown) =>
    post({
      intent: 'autosave',
      answers: { [FIELD.id]: 'typing' },
      revisionId: REVISION,
      responsesSeen,
    });

  test('an autosave rendered with the current count of responses is saved', async () => {
    fakes.loaded = loadedMany();
    expect(await autosave(1)).toMatchObject({ state: 'draft-saved' });
    expect(fakes.upserts).toHaveLength(1);
    // The count goes to the service too, which checks it again under the
    // form's lock before it creates a draft.
    expect(fakes.upserts[0]).toMatchObject({
      formId: FORM_ID,
      userId: SESSION_USER,
      expectedSubmittedCount: 1,
    });
  });

  test('a save the service declines (a submit landed first) is skipped, not saved', async () => {
    fakes.loaded = loadedMany();
    fakes.upsertResult = 'DRAFT_DECLINED';
    expect(await autosave(1)).toEqual({ state: 'draft-skipped' });
    expect(fakes.upserts).toHaveLength(1);
  });

  test('MANY submits are metered per session user and form; autosaves are not', async () => {
    fakes.loaded = loadedMany();
    await post({ intent: 'submit', answers: { [FIELD.id]: 'x' }, revisionId: REVISION });
    await autosave(1);
    expect(fakes.memberSubmits).toEqual([[SESSION_USER, FORM_ID]]);

    fakes.memberAllowed = false;
    const refused = (await post({
      intent: 'submit',
      answers: { [FIELD.id]: 'y' },
      revisionId: REVISION,
      userId: 'user-b',
    })) as { state: string; message: string };
    expect(refused.state).toBe('error');
    expect(refused.message).toContain('Wait a few minutes');
    // Counted under the session user, whatever the body says, and not written.
    expect(fakes.memberSubmits.at(-1)).toEqual([SESSION_USER, FORM_ID]);
    expect(fakes.submits).toHaveLength(1);
  });

  test('ONE and REPLACE submits are not metered', async () => {
    fakes.memberAllowed = false;
    fakes.loaded = loadedMany({ many: false, ownResponses: [], ownResponseCount: 0 });
    expect(
      await post({ intent: 'submit', answers: { [FIELD.id]: 'x' }, revisionId: REVISION })
    ).toEqual({ state: 'recorded' });
    expect(fakes.memberSubmits).toHaveLength(0);
  });

  test('an autosave rendered before the latest response is declined, and writes nothing', async () => {
    // The page knew of no responses; the submit it sent has since landed.
    fakes.loaded = loadedMany();
    expect(await autosave(0)).toEqual({ state: 'draft-skipped' });
    expect(await autosave(undefined)).toEqual({ state: 'draft-skipped' });
    expect(fakes.upserts).toHaveLength(0);
  });

  test('ONE and REPLACE autosaves do not need the count', async () => {
    fakes.loaded = loadedMany({ many: false, ownResponses: [], ownResponseCount: 0 });
    expect(await autosave(undefined)).toMatchObject({ state: 'draft-saved' });
    expect(fakes.upserts[0]).not.toHaveProperty('expectedSubmittedCount');
  });

  test('a MANY form taking no new response refuses a submit as closed', async () => {
    fakes.loaded = loadedMany({ mode: 'listed' });
    expect(
      await post({ intent: 'submit', answers: { [FIELD.id]: 'x' }, revisionId: REVISION })
    ).toEqual({ state: 'closed' });
    expect(await autosave(1)).toEqual({ state: 'draft-skipped' });
    expect(fakes.submits).toHaveLength(0);
    expect(fakes.upserts).toHaveLength(0);
  });

  test('a MANY submit goes through under the session user, whatever the body says', async () => {
    fakes.loaded = loadedMany();
    expect(
      await post({
        intent: 'submit',
        answers: { [FIELD.id]: 'x' },
        revisionId: REVISION,
        userId: 'user-b',
        responseId: 'resp-b',
      })
    ).toEqual({ state: 'recorded' });
    expect(fakes.submits).toHaveLength(1);
    expect(fakes.submits[0]).toMatchObject({ formId: FORM_ID, userId: SESSION_USER });
    expect(fakes.submits[0]).not.toHaveProperty('responseId');
  });

  test('ONE: a submit after the response is final stays already-recorded', async () => {
    fakes.loaded = loadedMany({
      many: false,
      ownResponses: [],
      ownResponseCount: 0,
      mode: 'recorded',
    });
    expect(
      await post({ intent: 'submit', answers: { [FIELD.id]: 'x' }, revisionId: REVISION })
    ).toEqual({ state: 'already-recorded' });
  });
});

// ─── The builder's choices ──────────────────────────────────────────────────

test.describe('responses per person in the builder', () => {
  const disabled = (args: Parameters<typeof responsesPerPersonChoices>[0]) =>
    responsesPerPersonChoices(args)
      .choices.filter(choice => choice.disabled)
      .map(choice => choice.value);

  const base = {
    access: 'CLASSROOM' as const,
    current: 'ONE' as const,
    hasResponseRows: false,
    hasTeamSets: false,
  };

  test('a new classroom form offers all three, with nothing to explain', () => {
    const { choices, reason } = responsesPerPersonChoices(base);
    expect(choices.map(choice => [choice.value, choice.label])).toEqual([
      ['ONE', 'One response'],
      ['REPLACE', 'One response, editable until the form closes'],
      ['MANY', 'Several responses'],
    ]);
    expect(reason).toBeNull();
  });

  test('a public form never offers several, and says why', () => {
    expect(disabled({ ...base, access: 'PUBLIC' })).toEqual(['MANY']);
    expect(responsesPerPersonChoices({ ...base, access: 'PUBLIC' }).reason).toBe(
      'Several responses needs a classroom form.'
    );
  });

  test('a form a team set uses never offers several', () => {
    expect(disabled({ ...base, hasTeamSets: true })).toEqual(['MANY']);
  });

  test('responses fix the switch to or from several, and only that', () => {
    expect(disabled({ ...base, hasResponseRows: true })).toEqual(['MANY']);
    expect(disabled({ ...base, current: 'REPLACE', hasResponseRows: true })).toEqual(['MANY']);
    expect(disabled({ ...base, current: 'MANY', hasResponseRows: true })).toEqual([
      'ONE',
      'REPLACE',
    ]);
    // A MANY form with no rows yet can still go back.
    expect(disabled({ ...base, current: 'MANY' })).toEqual([]);
  });

  test('a posted value is one of the three or refused', () => {
    expect(responsesPerPersonOf('MANY')).toBe('MANY');
    expect(responsesPerPersonOf('REPLACE')).toBe('REPLACE');
    for (const bad of ['many', 'TWO', true, 1, null, undefined, {}]) {
      expect(responsesPerPersonOf(bad)).toBeNull();
    }
  });
});

test.describe('the builder’s access switch on a form that takes several responses', () => {
  test('a classroom form taking several responses cannot switch to a public link, and says why', () => {
    expect(publicSwitchBlockedReason({ access: 'CLASSROOM', current: 'MANY' })).toBe(
      'A public link needs one response per person: change Per person first.'
    );
    for (const current of ['ONE', 'REPLACE'] as const) {
      expect(publicSwitchBlockedReason({ access: 'CLASSROOM', current })).toBeNull();
    }
    // Back to Classroom is always on offer.
    expect(publicSwitchBlockedReason({ access: 'PUBLIC', current: 'ONE' })).toBeNull();
  });
});

test.describe('the builder’s settings save, audited', () => {
  type Fakes = {
    form: Record<string, unknown>;
    updates: unknown[];
    audits: Array<{ data: object }>;
  };
  const builder: Fakes = { form: {}, updates: [], audits: [] };
  (globalThis as unknown as { __builderFakes: Fakes }).__builderFakes = builder;
  let builderAction: Action;

  test.beforeAll(async () => {
    ({ action: builderAction } = await importWithStubs<{ action: Action }>(
      new URL('../../app/forms/admin/builder.tsx', import.meta.url),
      {
        '.css': STUB(''),
        '/app/utils/db.server.ts': STUB(`
const f = () => globalThis.__builderFakes;
export const prisma = {};
export const ClassmojiService = {
  form: {
    findBySlug: async () => f().form,
    update: async (_id, updates) => { f().updates.push(updates); return {}; },
  },
  audit: { record: async row => { f().audits.push(row); return { written: true }; } },
};
`),
        '/app/utils/formAuth.server.ts': STUB(`
export const assertFormAdmin = async () => ({
  classroom: { id: 'class-1' },
  userId: 'staff-1',
  membership: { role: 'OWNER' },
});
export const formMutationBlocked = () => null;
`),
        '/app/forms/admin/adminLinks.server.ts': STUB(`
export const formsListUrl = () => '';
export const publicFormUrlFor = () => '';
`),
      }
    ));
  });

  const saveMeta = (body: Record<string, unknown>) =>
    builderAction({
      params: { classroomSlug: 'intro', formSlug: 'check-in' },
      request: new Request('http://localhost/intro/forms/check-in/edit', {
        method: 'POST',
        body: JSON.stringify({ intent: 'save-meta', ...body }),
        headers: { 'content-type': 'application/json' },
      }),
      url: new URL('http://localhost/intro/forms/check-in/edit'),
    });

  test.beforeEach(() => {
    builder.form = { id: FORM_ID, slug: 'check-in', responses_per_person: 'ONE' };
    builder.updates = [];
    builder.audits = [];
  });

  test('a change of responses per person records the new value', async () => {
    expect(await saveMeta({ responsesPerPerson: 'MANY' })).toMatchObject({ ok: true });
    expect(builder.audits[0].data).toEqual({
      tool: 'forms.builder.save-meta',
      slug: 'check-in',
      responses_per_person: 'MANY',
    });
  });

  test('a save that leaves it as it was, or does not touch it, records no value', async () => {
    await saveMeta({ responsesPerPerson: 'ONE' });
    await saveMeta({ title: 'Renamed' });
    for (const audit of builder.audits) {
      expect(audit.data).toEqual({ tool: 'forms.builder.save-meta', slug: 'check-in' });
    }
  });
});

// ─── Starting the next response on the page ─────────────────────────────────

test.describe('the next response after a MANY submit', () => {
  test('loader data counts as after the submit only once it shows the response sent', () => {
    expect(loaderDataAfterSubmit(null, 0)).toBe(true);
    // Sent with 2 on file: data still showing 2 is from before it.
    expect(loaderDataAfterSubmit(2, 2)).toBe(false);
    expect(loaderDataAfterSubmit(2, 3)).toBe(true);
    // Another tab's response landing too still counts as after.
    expect(loaderDataAfterSubmit(2, 5)).toBe(true);
  });

  test('"Submit another response" waits for the submit and the reload after it', () => {
    // The reply is in, the reload is not: still the pre-submit data.
    expect(canStartAnother({ submitterIdle: false, sentWithCount: 1, loadedCount: 1 })).toBe(false);
    expect(canStartAnother({ submitterIdle: true, sentWithCount: 1, loadedCount: 1 })).toBe(false);
    expect(canStartAnother({ submitterIdle: false, sentWithCount: 1, loadedCount: 2 })).toBe(false);
    expect(canStartAnother({ submitterIdle: true, sentWithCount: 1, loadedCount: 2 })).toBe(true);
  });

  test('a form started after a submit is never seeded from data older than it', () => {
    const justSent = { 'q-1': 'the answer just sent' };
    // The pre-submit data still carries the draft that submit turned into a response.
    expect(
      seedForNewResponse({
        startedAfterCount: 1,
        loadedCount: 1,
        storedAnswers: justSent,
        restoredDraft: true,
      })
    ).toEqual({ storedAnswers: null, restoredDraft: false });

    // Fresh data stands as it is, a draft of the next response included.
    const next = { 'q-1': 'the next one' };
    expect(
      seedForNewResponse({
        startedAfterCount: 1,
        loadedCount: 2,
        storedAnswers: next,
        restoredDraft: true,
      })
    ).toEqual({ storedAnswers: next, restoredDraft: true });

    // The page's first form takes the loader's draft.
    expect(
      seedForNewResponse({
        startedAfterCount: null,
        loadedCount: 0,
        storedAnswers: next,
        restoredDraft: true,
      })
    ).toEqual({ storedAnswers: next, restoredDraft: true });
  });
});
