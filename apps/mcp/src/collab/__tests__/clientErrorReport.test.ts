/**
 * Live-editing failures and the error reporter: a write or read the collab
 * server could not serve (down, a document it cannot read, a status nothing
 * maps) is reported once, with its status and code; an expected refusal (a
 * lock, a conflict, bad ops, a reload in progress) is not, neither here nor
 * by the registry afterwards. Every mapped refusal keeps the collab error as
 * its cause and answers exactly as before.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  setErrorReporter,
  type ErrorReporter,
  type ReportContext,
} from '@classmoji/utils/error-report';

vi.mock('@classmoji/services', () => ({ ClassmojiService: {} }));

const { CollabRequestError, liveReadError, liveWriteError } = await import('../client.ts');
const { reportSurfaceFailure } = await import('../../mcp/registry.ts');
const { ToolError } = await import('../../mcp/errors.ts');

const captured: Array<{ error: unknown; context: ReportContext }> = [];
const fakeReporter: ErrorReporter = {
  capture: (error, context) => captured.push({ error, context }),
  flush: async () => true,
};

beforeEach(() => {
  captured.length = 0;
  setErrorReporter(fakeReporter);
});

afterEach(() => {
  setErrorReporter(null);
});

/** What the registry does with the refusal once the tool throws it. */
const throughRegistry = (mapped: unknown) =>
  reportSurfaceFailure(mapped, { kind: 'tool', name: 'page_content_apply' });

describe('liveWriteError', () => {
  it('reports the service being down once, and the refusal carries it as its cause', () => {
    const down = new CollabRequestError('Live editing service unreachable: ECONNREFUSED', 0);
    const mapped = liveWriteError(down, 'page');
    expect(mapped).toBeInstanceOf(ToolError);
    expect(mapped).toMatchObject({ kind: 'internal', code: 'LIVE_UNAVAILABLE' });
    expect(mapped.cause).toBe(down);
    throughRegistry(mapped);
    expect(captured).toEqual([
      {
        error: down,
        context: { surface: 'mcp.collab.write', tags: { status: 0, kind: 'page' } },
      },
    ]);
  });

  it('reports an unmapped status with its code', () => {
    const odd = new CollabRequestError('Live editing service refused: teapot', 418, {
      error: 'teapot',
    });
    throughRegistry(liveWriteError(odd, 'deck'));
    expect(captured).toEqual([
      {
        error: odd,
        context: {
          surface: 'mcp.collab.write',
          tags: { status: 418, code: 'teapot', kind: 'deck' },
        },
      },
    ]);
  });

  it.each([
    [409, 'block-changed', { changedIds: ['b1'] }],
    [409, 'slide-locked', { slideId: 's1', holder: { name: 'Ada' } }],
    [409, 'stale-epoch', {}],
    [409, 'unknown-version', {}],
    [409, 'collab-disabled', {}],
    [400, 'bad-ops', { message: 'op 2 has no id' }],
    [404, 'not-found', {}],
    [413, 'body-too-large', {}],
  ])('never reports an expected refusal (%s %s)', (status, code, body) => {
    const refusal = new CollabRequestError(`Live editing service refused: ${code}`, status, {
      error: code,
      ...body,
    });
    const mapped = liveWriteError(refusal, 'page');
    expect(mapped).toBeInstanceOf(ToolError);
    expect((mapped as InstanceType<typeof ToolError>).kind).not.toBe('internal');
    throughRegistry(mapped);
    expect(captured).toEqual([]);
  });

  it('passes a non-collab error through untouched', () => {
    const other = new Error('boom');
    expect(liveWriteError(other, 'page')).toBe(other);
    expect(captured).toEqual([]);
  });
});

describe('liveReadError', () => {
  it('reports a refused read once', () => {
    const refused = new CollabRequestError('Live editing service refused: HTTP 400', 400);
    const mapped = liveReadError(refused, 'page');
    expect(mapped).toMatchObject({ kind: 'internal', code: 'LIVE_READ_FAILED' });
    throughRegistry(mapped);
    expect(captured).toEqual([
      {
        error: refused,
        context: { surface: 'mcp.collab.read', tags: { status: 400, kind: 'page' } },
      },
    ]);
  });

  it('never reports a read during a reload, here or in the registry', () => {
    const reloading = new CollabRequestError('Live editing service refused: stale-epoch', 409, {
      error: 'stale-epoch',
    });
    const mapped = liveReadError(reloading, 'deck');
    expect(mapped).toMatchObject({ kind: 'internal', code: 'LIVE_UNAVAILABLE' });
    expect(mapped.cause).toBe(reloading);
    throughRegistry(mapped);
    expect(captured).toEqual([]);
  });
});
