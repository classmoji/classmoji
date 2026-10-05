import { describe, expect, it } from 'vitest';

import { renderCanonicalString } from '../canonical.ts';
import { signRenderToken, verifyRenderToken } from '../render.ts';
import {
  VIEW_TOKEN_TTL_SECONDS,
  signViewToken,
  verifyViewToken,
  viewCanonicalString,
  type ViewTokenFields,
} from '../view.ts';
import {
  CLASSROOM_A,
  CLASSROOM_B,
  HOST,
  MASTER,
  NOW,
  ORIGIN,
  OTHER_MASTER,
  OTHER_ORIGIN,
} from './fixtures.ts';

const DOC_A = '22222222-3333-4444-8555-666666666666';
const DOC_B = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';

function fields(overrides: Partial<ViewTokenFields> = {}): ViewTokenFields {
  return {
    origin: ORIGIN,
    classroomId: CLASSROOM_A,
    kind: 'deck',
    docId: DOC_A,
    target: 'main:live:3.12',
    keyVersion: 0,
    now: NOW,
    ...overrides,
  };
}

describe('viewCanonicalString', () => {
  it('pins the shape and its own discriminator', () => {
    const s = viewCanonicalString({
      host: HOST,
      classroomId: CLASSROOM_A,
      kind: 'page',
      docId: DOC_A,
      target: 'preview:abc',
      exp: NOW,
    });
    expect(s).toBe(`cm1|view|${HOST}|${CLASSROOM_A}|page|${DOC_A}|preview:abc|${NOW}`);
    expect(
      renderCanonicalString({ host: HOST, classroomId: CLASSROOM_A, slideId: DOC_A, exp: NOW })
    ).not.toBe(s);
  });
});

describe('signViewToken / verifyViewToken', () => {
  it('round-trips and expires after exactly the TTL', async () => {
    const token = await signViewToken(MASTER, fields());
    expect(await verifyViewToken(MASTER, token, fields())).toEqual({
      ok: true,
      exp: NOW + VIEW_TOKEN_TTL_SECONDS,
    });
    const late = await verifyViewToken(
      MASTER,
      token,
      fields({ now: NOW + VIEW_TOKEN_TTL_SECONDS + 1 })
    );
    expect(late).toMatchObject({ ok: false, reason: 'expired', skewSeconds: 1 });
  });

  it.each([
    ['another doc', { docId: DOC_B }],
    ['another kind', { kind: 'page' as const }],
    ['another target', { target: 'preview:abc' }],
    ['another classroom', { classroomId: CLASSROOM_B }],
    ['another host', { origin: OTHER_ORIGIN }],
    ['a bumped key version', { keyVersion: 1 }],
  ])('refuses %s', async (_label, override) => {
    const token = await signViewToken(MASTER, fields());
    expect(await verifyViewToken(MASTER, token, fields(override))).toMatchObject({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('refuses another master and garbage', async () => {
    const token = await signViewToken(MASTER, fields());
    expect((await verifyViewToken(OTHER_MASTER, token, fields())).ok).toBe(false);
    expect(await verifyViewToken(MASTER, 'nope', fields())).toMatchObject({ reason: 'malformed' });
  });

  it('is not interchangeable with a thumbnail render token', async () => {
    const render = await signRenderToken(MASTER, {
      origin: ORIGIN,
      classroomId: CLASSROOM_A,
      slideId: DOC_A,
      keyVersion: 0,
      now: NOW,
    });
    expect((await verifyViewToken(MASTER, render, fields())).ok).toBe(false);
    const view = await signViewToken(MASTER, fields());
    const asRender = await verifyRenderToken(MASTER, view, {
      origin: ORIGIN,
      classroomId: CLASSROOM_A,
      slideId: DOC_A,
      keyVersion: 0,
      now: NOW,
    });
    expect(asRender.ok).toBe(false);
  });

  it('rejects a target with the separator in it', async () => {
    await expect(signViewToken(MASTER, fields({ target: 'main|x' }))).rejects.toThrow(TypeError);
  });
});
