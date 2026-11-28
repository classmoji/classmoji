/**
 * What collab reports to the error tracker, and what it never does: hook
 * failures once each with the room's ids, the internal API's 500s, a lost
 * checkpoint trigger (a failed audit write is the audit service's to report). Typed refusals (auth refusals,
 * 4xx / 501 answers) and a caller that hung up are never reported, and with
 * no reporter registered nothing changes. No server, no port, no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { COLLAB_SECRET_HEADER } from '@classmoji/collab';
import {
  setErrorReporter,
  type ErrorReporter,
  type ReportContext,
} from '@classmoji/utils/error-report';

import { CollabHttpError } from '../src/adapters/types.ts';
import { asAuthError, CollabAuthError } from '../src/auth.ts';
import { recordAudit } from '../src/audit.ts';
import { createTaskCheckpointTrigger } from '../src/checkpoint.ts';
import { handleRequest } from '../src/http.ts';
import { handleInternal } from '../src/internal.ts';
import { SingleInstanceError } from '../src/instanceLock.ts';
import { isTypedRefusal, reportBootFailure, reportingHook, roomTags } from '../src/report.ts';
import type { CollabRuntime } from '../src/server.ts';
import { SECRET, startServer } from './helpers.ts';

const ROOM = 'page:page-1:3';

let captured: Array<{ error: unknown; context: ReportContext }>;

const fakeReporter = (): ErrorReporter => ({
  capture: (error, context) => {
    captured.push({ error, context });
  },
  flush: async () => true,
});

beforeEach(() => {
  captured = [];
  setErrorReporter(fakeReporter());
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  setErrorReporter(null);
  vi.restoreAllMocks();
});

describe('roomTags / isTypedRefusal', () => {
  it('tags a room by its ids only, and nothing for a name that is not a room', () => {
    expect(roomTags(ROOM)).toEqual({ kind: 'page', doc_id: 'page-1', epoch: 3 });
    expect(roomTags('not a room')).toEqual({});
  });

  it('treats auth refusals and typed HTTP answers as refusals, anything else as a failure', () => {
    expect(isTypedRefusal(new CollabAuthError('forbidden', 'no session'))).toBe(true);
    expect(isTypedRefusal(new CollabHttpError(501, { error: 'not-implemented' }))).toBe(true);
    expect(isTypedRefusal(new Error('db down'))).toBe(false);
    expect(isTypedRefusal('a string')).toBe(false);
  });
});

describe('reportingHook', () => {
  it('reports an unexpected failure once, tagged with the hook and the room, and rethrows it unchanged', async () => {
    const failure = new Error('db down');
    const hook = reportingHook('store', async (_payload: { documentName: string }) => {
      throw failure;
    });
    await expect(hook({ documentName: ROOM })).rejects.toBe(failure);
    await expect(hook({ documentName: ROOM })).rejects.toBe(failure);
    expect(captured).toHaveLength(1);
    expect(captured[0].error).toBe(failure);
    expect(captured[0].context).toEqual({
      surface: 'collab.hook',
      tags: { hook: 'store', kind: 'page', doc_id: 'page-1', epoch: 3 },
    });
  });

  it('never reports a typed refusal, and still rethrows it', async () => {
    const refusal = new CollabAuthError('stale-epoch', 'moved');
    const answer = new CollabHttpError(409, { error: 'unpushed-edits' });
    await expect(
      reportingHook('connected', async () => {
        throw refusal;
      })({ documentName: ROOM })
    ).rejects.toBe(refusal);
    await expect(
      reportingHook('store', async () => {
        throw answer;
      })({ documentName: ROOM })
    ).rejects.toBe(answer);
    expect(captured).toEqual([]);
  });

  it('passes the result through when the hook succeeds', async () => {
    const hook = reportingHook(
      'after_load',
      async (payload: { documentName: string }) => payload.documentName.length
    );
    await expect(hook({ documentName: ROOM })).resolves.toBe(ROOM.length);
    expect(captured).toEqual([]);
  });

  it('without a reporter, rethrows exactly as before and sends nothing', async () => {
    setErrorReporter(null);
    const failure = new Error('db down');
    await expect(
      reportingHook('store', async () => {
        throw failure;
      })({ documentName: ROOM })
    ).rejects.toBe(failure);
    expect(captured).toEqual([]);
  });
});

describe('reportBootFailure', () => {
  it('reports the lock error as collab.instance_lock and anything else as collab.boot, fatal', () => {
    const lock = new SingleInstanceError('another collab server holds the instance lock');
    const unreachable = Object.assign(new Error('Connection failed while connecting'), {
      cause: new Error('connect ECONNREFUSED 127.0.0.1:1'),
    });
    const config = new Error('COLLAB_INTERNAL_SECRET must be set');
    for (const err of [lock, unreachable, config]) reportBootFailure(err);
    expect(captured.map(c => [c.error, c.context])).toEqual([
      [lock, { surface: 'collab.instance_lock', level: 'fatal', tags: { stage: 'boot' } }],
      [unreachable, { surface: 'collab.boot', level: 'fatal', tags: { stage: 'boot' } }],
      [config, { surface: 'collab.boot', level: 'fatal', tags: { stage: 'boot' } }],
    ]);
    // It prints nothing itself: the boot code's own lines are unchanged.
    expect(console.error).not.toHaveBeenCalled();
  });
});

describe('asAuthError', () => {
  it('reports the unexpected cause (not the wrapper) once, with the stage and room ids', () => {
    const cause = new Error('connection terminated');
    const wrapped = asAuthError(cause, `loading ${ROOM}`, { stage: 'load', documentName: ROOM });
    expect(wrapped).toBeInstanceOf(CollabAuthError);
    expect(wrapped.reason).toBe('unavailable');
    expect(captured).toHaveLength(1);
    expect(captured[0].error).toBe(cause);
    expect(captured[0].context).toEqual({
      surface: 'collab.hook',
      tags: { hook: 'load', kind: 'page', doc_id: 'page-1', epoch: 3 },
    });
  });

  it('never reports a refusal', () => {
    const refusal = new CollabAuthError('forbidden', 'origin not allowed');
    expect(
      asAuthError(refusal, `authenticating ${ROOM}`, {
        stage: 'authenticate',
        documentName: ROOM,
      })
    ).toBe(refusal);
    expect(captured).toEqual([]);
  });
});

describe('the checkpoint trigger', () => {
  const config = { checkpointDelay: '10s', checkpointMaxDelay: '30s' };

  it('reports a failed send with the classroom and reason; a warm-up only as a warning', async () => {
    const failure = new Error('trigger.dev unavailable');
    const t = createTaskCheckpointTrigger(config, { TRIGGER_SECRET_KEY: 'k' }, async () => {
      return async () => {
        throw failure;
      };
    });
    await t.trigger({ classroomId: 'c1', reason: 'store' }, { now: false });
    const warmFailure = new Error('warm-up refused');
    const w = createTaskCheckpointTrigger(config, { TRIGGER_SECRET_KEY: 'k' }, async () => {
      return async () => {
        throw warmFailure;
      };
    });
    await w.warm?.('c1');
    expect(captured.map(c => c.error)).toEqual([failure, warmFailure]);
    expect(captured[0].context).toEqual({
      surface: 'collab.checkpoint_trigger',
      level: 'error',
      tags: { stage: 'send', classroom_id: 'c1', reason: 'store', warm: false },
    });
    expect(captured[1].context.level).toBe('warning');
  });

  it('reports a missing TRIGGER_SECRET_KEY once per process, like its log line', async () => {
    const t = createTaskCheckpointTrigger(config, {});
    expect(await t.trigger({ classroomId: 'c1', reason: 'store' }, { now: false })).toBe(false);
    expect(await t.trigger({ classroomId: 'c1', reason: 'store' }, { now: true })).toBe(false);
    expect(captured).toHaveLength(1);
    expect(captured[0].context).toMatchObject({
      surface: 'collab.checkpoint_trigger',
      tags: { stage: 'unconfigured' },
    });
  });
});

describe('recordAudit', () => {
  it('sends nothing itself: the audit service reports a row it finally could not write', async () => {
    const failure = new Error('audit insert failed');
    const sink = {
      record: vi.fn(async () => Promise.reject(failure)),
      recordNonMemberRefusal: vi.fn(async () => undefined),
    };
    const entry = {
      userId: 'u1',
      classroomId: 'c1',
      role: 'TEACHER',
      action: 'COLLAB_JOIN' as const,
      resourceType: 'PAGE',
      resourceId: 'page-1',
      data: { tool: 'collab' },
    };
    recordAudit(sink, entry);
    await new Promise(resolve => setImmediate(resolve));
    expect(sink.record).toHaveBeenCalledTimes(1);
    expect(captured).toHaveLength(0);
  });
});

/** A ServerResponse stand-in that records what was written. */
function fakeResponse() {
  const written: { status?: number; body?: string } = {};
  const response = {
    headersSent: false,
    writableEnded: false,
    setHeader() {},
    writeHead(status: number) {
      written.status = status;
      response.headersSent = true;
    },
    end(body?: string) {
      written.body = body;
      response.writableEnded = true;
    },
  };
  return { response: response as unknown as ServerResponse, written };
}

/**
 * A POST to the internal API, shaped as Node leaves one: a body read to its
 * end is `complete` and also `destroyed`; a caller that hung up mid-body
 * leaves it incomplete and the body stream fails.
 */
function post(path: string, body: unknown, { hungUp = false } = {}) {
  return {
    method: 'POST',
    url: path,
    headers: { [COLLAB_SECRET_HEADER]: 'secret' },
    complete: !hungUp,
    destroyed: true,
    async *[Symbol.asyncIterator]() {
      if (hungUp) throw Object.assign(new Error('aborted'), { code: 'ECONNRESET' });
      yield Buffer.from(JSON.stringify(body));
    },
  } as unknown as IncomingMessage;
}

const url = (pathname: string) => ({ pathname, searchParams: new URLSearchParams() });

describe('the internal API', () => {
  const failure = new Error('broadcast exploded');
  const runtime = {
    deps: { config: { internalSecret: 'secret' } },
    broadcast: () => {
      throw failure;
    },
    requestsAnswered: () => {},
  } as unknown as CollabRuntime;
  const checkpointResult = { docs: [{ kind: 'page', id: 'page-1' }] };

  it('reports a failure after the body was read once, and still answers 500 internal-error', async () => {
    const { response, written } = fakeResponse();
    await handleInternal(
      post('/internal/checkpoint-result', checkpointResult),
      response,
      url('/internal/checkpoint-result'),
      runtime
    );
    expect(written.status).toBe(500);
    expect(JSON.parse(written.body ?? '')).toEqual({ error: 'internal-error' });
    expect(captured).toHaveLength(1);
    expect(captured[0].error).toBe(failure);
    expect(captured[0].context).toEqual({
      surface: 'collab.internal',
      handled: false,
      tags: {
        method: 'POST',
        scope: 'global',
        kind: undefined,
        action: 'checkpoint-result',
      },
    });
  });

  it('does not report a caller that hung up mid-body (same 500 answer)', async () => {
    const { response, written } = fakeResponse();
    await handleInternal(
      post('/internal/checkpoint-result', checkpointResult, { hungUp: true }),
      response,
      url('/internal/checkpoint-result'),
      runtime
    );
    expect(written.status).toBe(500);
    expect(captured).toEqual([]);
  });

  it('does not report typed answers (401, 400 invalid-json)', async () => {
    const unauthorized = fakeResponse();
    await handleInternal(
      { method: 'GET', headers: {}, complete: true } as unknown as IncomingMessage,
      unauthorized.response,
      url('/internal/checkpoint-result'),
      runtime
    );
    expect(unauthorized.written.status).toBe(401);

    const invalid = fakeResponse();
    const badJson = {
      method: 'POST',
      headers: { [COLLAB_SECRET_HEADER]: 'secret' },
      complete: true,
      async *[Symbol.asyncIterator]() {
        yield Buffer.from('{not json');
      },
    } as unknown as IncomingMessage;
    await handleInternal(badJson, invalid.response, url('/internal/checkpoint-result'), runtime);
    expect(invalid.written.status).toBe(400);
    expect(captured).toEqual([]);
  });
});

describe('the HTTP entry', () => {
  it('reports a request that failed outside the internal API, and answers 500 as before', async () => {
    const failure = new Error('health check broke');
    const { response, written } = fakeResponse();
    const broken = {
      dbHealth: () => Promise.reject(failure),
    } as unknown as CollabRuntime;
    await expect(
      handleRequest(
        { request: { url: '/health', method: 'GET' } as IncomingMessage, response },
        broken
      )
    ).rejects.toBeNull();
    expect(written.status).toBe(500);
    expect(written.body).toBe('internal error');
    expect(captured).toHaveLength(1);
    expect(captured[0].error).toBe(failure);
    expect(captured[0].context).toEqual({
      surface: 'collab.http',
      handled: false,
      tags: { method: 'GET' },
    });
  });

  it('does not report the 404 and handled answers', async () => {
    const { response, written } = fakeResponse();
    await expect(
      handleRequest(
        { request: { url: '/nope', method: 'GET' } as IncomingMessage, response },
        {} as CollabRuntime
      )
    ).rejects.toBeNull();
    expect(written.status).toBe(404);
    expect(captured).toEqual([]);
  });
});

describe('the internal API over a real socket', () => {
  it('reports a failure after a fully read body (a read body leaves the request destroyed, not incomplete)', async () => {
    const server = await startServer();
    const failure = new Error('broadcast exploded');
    const runtime = server.runtime as unknown as { broadcast: () => never };
    runtime.broadcast = () => {
      throw failure;
    };
    try {
      const res = await fetch(`${server.httpUrl}/internal/checkpoint-result`, {
        method: 'POST',
        headers: { [COLLAB_SECRET_HEADER]: SECRET, 'content-type': 'application/json' },
        body: JSON.stringify({ docs: [{ kind: 'page', id: 'page-1' }] }),
      });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ error: 'internal-error' });
      expect(captured.map(c => c.error)).toEqual([failure]);
    } finally {
      await server.close();
    }
  });
});
