import { describe, expect, it } from 'vitest';

import { blobCanonicalString, renderCanonicalString } from '../canonical.ts';
import { deriveKey, signCanonical, verifyCanonical } from '../derive.ts';
import { RENDER_TOKEN_TTL_SECONDS, signRenderToken, verifyRenderToken } from '../render.ts';
import {
  CLASSROOM_A,
  CLASSROOM_B,
  HOST,
  MASTER,
  NOW,
  ORIGIN,
  OTHER_MASTER,
  OTHER_ORIGIN,
  SHA,
} from './fixtures.ts';

const SLIDE_A = '22222222-3333-4444-8555-666666666666';
const SLIDE_B = '77777777-8888-4999-8aaa-bbbbbbbbbbbb';

function fields(overrides: Record<string, unknown> = {}) {
  return {
    origin: ORIGIN,
    classroomId: CLASSROOM_A,
    slideId: SLIDE_A,
    keyVersion: 0,
    now: NOW,
    ...overrides,
  } as Parameters<typeof signRenderToken>[1];
}

describe('renderCanonicalString', () => {
  it('pins the shape', () => {
    expect(
      renderCanonicalString({
        host: HOST,
        classroomId: CLASSROOM_A,
        slideId: SLIDE_A,
        exp: 1767225600,
      })
    ).toBe(`cm1|render|${HOST}|${CLASSROOM_A}|${SLIDE_A}|1767225600`);
  });

  it('uses a discriminator no other canonical string uses', () => {
    const render = renderCanonicalString({
      host: HOST,
      classroomId: CLASSROOM_A,
      slideId: SLIDE_A,
      exp: NOW,
    });
    expect(render.split('|')[1]).toBe('render');
    expect(
      blobCanonicalString({
        host: HOST,
        classroomId: CLASSROOM_A,
        sha: SHA,
        ext: 'webp',
        tier: 'week',
        keyVersion: 0,
        exp: NOW,
      }).split('|')[1]
    ).toBe('blob');
  });
});

describe('signRenderToken', () => {
  it('mints `{exp}.{sig}` with an exact 120s TTL, not a bucket', async () => {
    const token = await signRenderToken(MASTER, fields());
    const [exp, sig] = token.split('.');
    expect(Number(exp)).toBe(NOW + RENDER_TOKEN_TTL_SECONDS);
    expect(RENDER_TOKEN_TTL_SECONDS).toBe(120);
    expect(sig).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('is deterministic for one clock and moves with it', async () => {
    const a = await signRenderToken(MASTER, fields());
    const b = await signRenderToken(MASTER, fields());
    const later = await signRenderToken(MASTER, fields({ now: NOW + 1 }));
    expect(a).toBe(b);
    expect(later).not.toBe(a);
  });

  it('refuses ids that are not UUIDs', async () => {
    await expect(signRenderToken(MASTER, fields({ slideId: 'not-a-uuid' }))).rejects.toThrow(
      TypeError
    );
    await expect(signRenderToken(MASTER, fields({ classroomId: 'nope' }))).rejects.toThrow(
      TypeError
    );
  });
});

describe('verifyRenderToken', () => {
  it('accepts a token minted for the same deck, host and key', async () => {
    const token = await signRenderToken(MASTER, fields());
    await expect(verifyRenderToken(MASTER, token, fields())).resolves.toEqual({
      ok: true,
      exp: NOW + RENDER_TOKEN_TTL_SECONDS,
    });
  });

  it('accepts right up to exp and refuses one second past it — no grace', async () => {
    const token = await signRenderToken(MASTER, fields());
    const exp = NOW + RENDER_TOKEN_TTL_SECONDS;

    await expect(verifyRenderToken(MASTER, token, fields({ now: exp }))).resolves.toMatchObject({
      ok: true,
    });
    await expect(verifyRenderToken(MASTER, token, fields({ now: exp + 1 }))).resolves.toEqual({
      ok: false,
      reason: 'expired',
    });
  });

  it('refuses a token minted for another slide', async () => {
    const token = await signRenderToken(MASTER, fields());
    await expect(verifyRenderToken(MASTER, token, fields({ slideId: SLIDE_B }))).resolves.toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('refuses a token minted for another classroom', async () => {
    const token = await signRenderToken(MASTER, fields());
    await expect(
      verifyRenderToken(MASTER, token, fields({ classroomId: CLASSROOM_B }))
    ).resolves.toEqual({ ok: false, reason: 'bad-signature' });
  });

  it('refuses a token minted for another host', async () => {
    const token = await signRenderToken(MASTER, fields({ origin: OTHER_ORIGIN }));
    await expect(verifyRenderToken(MASTER, token, fields())).resolves.toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('refuses a token whose classroom key version has moved on', async () => {
    const token = await signRenderToken(MASTER, fields());
    await expect(verifyRenderToken(MASTER, token, fields({ keyVersion: 1 }))).resolves.toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('refuses a token signed with a different master', async () => {
    const token = await signRenderToken(OTHER_MASTER, fields());
    await expect(verifyRenderToken(MASTER, token, fields())).resolves.toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('refuses a rewritten expiry', async () => {
    const token = await signRenderToken(MASTER, fields());
    const [, sig] = token.split('.');
    const stretched = `${NOW + 86400}.${sig}`;
    await expect(verifyRenderToken(MASTER, stretched, fields())).resolves.toEqual({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('reads anything that is not `{exp}.{sig}` as malformed', async () => {
    for (const token of [
      '',
      'abc',
      'abc.def',
      '123',
      '123.',
      '.sig',
      '-1.sig',
      '123.sig=',
      '01.sig',
    ]) {
      await expect(verifyRenderToken(MASTER, token, fields())).resolves.toEqual({
        ok: false,
        reason: 'malformed',
      });
    }
  });

  it('refuses a signature minted in the blob namespace for the same key', async () => {
    // The cross-namespace case that matters: same master, same classroom, same
    // key version, same expiry — only the discriminator differs.
    const exp = NOW + RENDER_TOKEN_TTL_SECONDS;
    const key = await deriveKey(MASTER, CLASSROOM_A, 0);
    const blobSig = await signCanonical(
      key,
      blobCanonicalString({
        host: HOST,
        classroomId: CLASSROOM_A,
        sha: SHA,
        ext: 'webp',
        tier: 'week',
        keyVersion: 0,
        exp,
      })
    );
    const forged = `${exp}.${Buffer.from(blobSig)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')}`;

    await expect(verifyRenderToken(MASTER, forged, fields())).resolves.toEqual({
      ok: false,
      reason: 'bad-signature',
    });

    // …and the mirror: a render signature is not a blob signature either.
    const token = await signRenderToken(MASTER, fields());
    const renderSig = Uint8Array.from(Buffer.from(token.split('.')[1], 'base64url'));
    await expect(
      verifyCanonical(
        key,
        renderSig as Uint8Array<ArrayBuffer>,
        blobCanonicalString({
          host: HOST,
          classroomId: CLASSROOM_A,
          sha: SHA,
          ext: 'webp',
          tier: 'week',
          keyVersion: 0,
          exp,
        })
      )
    ).resolves.toBe(false);
  });
});
