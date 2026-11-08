import { Readable } from 'node:stream';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MCP_BODY_LIMIT_BYTES } from '../../bodyLimit.ts';
import {
  BodyBudgetRefusal,
  BodyBytesBudget,
  COALESCED_CHUNK_BYTES,
  countedBody,
  LARGE_INFLIGHT_BODY_BYTES,
  SMALL_BODY_BYTES,
  TOTAL_INFLIGHT_BODY_BYTES,
  USER_INFLIGHT_BODY_BYTES,
} from '../bodyBudget.ts';

const MiB = 1024 * 1024;

describe('the in-flight body budget limits', () => {
  it('give a user room for three maximum-size bodies, large bodies four, and all bodies 64 MiB', () => {
    expect(MCP_BODY_LIMIT_BYTES).toBe(8 * MiB);
    expect(USER_INFLIGHT_BODY_BYTES).toBe(3 * MCP_BODY_LIMIT_BYTES);
    expect(LARGE_INFLIGHT_BODY_BYTES).toBe(4 * MCP_BODY_LIMIT_BYTES);
    expect(TOTAL_INFLIGHT_BODY_BYTES).toBe(64 * MiB);
    expect(SMALL_BODY_BYTES).toBe(MiB);
  });

  it('leave both large and small bodies more room than one user can hold', () => {
    expect(LARGE_INFLIGHT_BODY_BYTES).toBeGreaterThan(USER_INFLIGHT_BODY_BYTES);
    expect(TOTAL_INFLIGHT_BODY_BYTES - LARGE_INFLIGHT_BODY_BYTES).toBeGreaterThan(
      USER_INFLIGHT_BODY_BYTES
    );
  });

  it('let every body under the body limit fit on an idle server, so none is refused for its size alone', () => {
    expect(MCP_BODY_LIMIT_BYTES).toBeLessThanOrEqual(USER_INFLIGHT_BODY_BYTES);
    expect(USER_INFLIGHT_BODY_BYTES).toBeLessThanOrEqual(LARGE_INFLIGHT_BODY_BYTES);
    expect(LARGE_INFLIGHT_BODY_BYTES).toBeLessThan(TOTAL_INFLIGHT_BODY_BYTES);
    expect(SMALL_BODY_BYTES).toBeLessThan(MCP_BODY_LIMIT_BYTES);
  });

  it('admit three near-limit bodies from one user with the defaults', () => {
    const budget = new BodyBytesBudget();
    const bodies = [1, 2, 3].map(() => budget.open('u1'));
    for (const body of bodies) expect(body.add(MCP_BODY_LIMIT_BYTES)).toBeNull();
    expect(budget.largeInFlight()).toBe(3 * MCP_BODY_LIMIT_BYTES);
    expect(budget.open('u1').add(1)).toBe('user');
    for (const body of bodies) body.release();
    expect(budget.inFlight()).toBe(0);
    expect(budget.largeInFlight()).toBe(0);
  });
});

/** All three counts, and the user's. */
function counts(budget: BodyBytesBudget, user?: string) {
  return {
    total: budget.inFlight(),
    large: budget.largeInFlight(),
    ...(user === undefined ? {} : { user: budget.inFlight(user) }),
  };
}

describe('BodyBytesBudget', () => {
  it('counts a body against its user, the total and, once large, the large-body allowance', () => {
    const budget = new BodyBytesBudget(100, 300, 200, 50);
    const body = budget.open('u1');

    expect(body.add(40)).toBeNull();
    expect(counts(budget, 'u1')).toEqual({ total: 40, large: 0, user: 40 });
    expect(body.add(20)).toBeNull();
    expect(counts(budget, 'u1')).toEqual({ total: 60, large: 60, user: 60 });

    body.release();
    expect(counts(budget, 'u1')).toEqual({ total: 0, large: 0, user: 0 });
  });

  it('refuses a chunk that does not fit and keeps what was counted before it', () => {
    const budget = new BodyBytesBudget(100, 1_000, 1_000, 1);
    const body = budget.open('u1');

    for (let i = 0; i < 3; i++) expect(body.add(30)).toBeNull();
    expect(body.add(30)).toBe('user');
    expect(counts(budget, 'u1')).toEqual({ total: 90, large: 90, user: 90 });

    body.release();
    expect(counts(budget, 'u1')).toEqual({ total: 0, large: 0, user: 0 });
  });

  it('is safe to release twice, counts nothing after release, and never goes below 0', () => {
    const budget = new BodyBytesBudget(100, 250, 250, 1);
    const other = budget.open('u1');
    expect(other.add(40)).toBeNull();
    const body = budget.open('u1');
    expect(body.add(50)).toBeNull();

    body.release();
    body.release();
    expect(counts(budget, 'u1')).toEqual({ total: 40, large: 40, user: 40 });
    // A chunk arriving after the request has ended takes nothing.
    expect(body.add(50)).toBeNull();
    expect(counts(budget, 'u1')).toEqual({ total: 40, large: 40, user: 40 });

    other.release();
    other.release();
    expect(counts(budget, 'u1')).toEqual({ total: 0, large: 0, user: 0 });
    // Nothing is left behind for the user either.
    expect(budget.open('u1').add(100)).toBeNull();
  });

  it('releases a body that was refused before it counted anything', () => {
    const budget = new BodyBytesBudget(100, 1_000, 1_000, 1);
    const full = budget.open('u1');
    expect(full.add(100)).toBeNull();

    const refused = budget.open('u1');
    expect(refused.add(1)).toBe('user');
    refused.release();
    expect(counts(budget, 'u1')).toEqual({ total: 100, large: 100, user: 100 });
  });

  it('counts nothing for an empty body', () => {
    const budget = new BodyBytesBudget(100, 250, 250, 1);
    expect(budget.open('u1').add(100)).toBeNull();

    // A user at their allowance can still send a request without a body.
    expect(budget.open('u1').add(0)).toBeNull();
    expect(budget.inFlight('u1')).toBe(100);
  });

  it("refuses with 'user' at the user's allowance, and keeps each user's allowance separate", () => {
    const budget = new BodyBytesBudget(100, 1_000, 1_000, 1);
    const a = budget.open('a');
    expect(a.add(100)).toBeNull();

    expect(budget.open('a').add(1)).toBe('user');
    expect(budget.open('b').add(100)).toBeNull();
    expect(budget.inFlight('a')).toBe(100);
    expect(budget.inFlight('b')).toBe(100);

    a.release();
    expect(budget.open('a').add(100)).toBeNull();
  });

  it("refuses with 'server' when the total is full, though the user has room", () => {
    const budget = new BodyBytesBudget(100, 250, 1_000, 1_000);
    for (const user of ['a', 'b']) expect(budget.open(user).add(100)).toBeNull();
    const c = budget.open('c');
    expect(c.add(50)).toBeNull();

    expect(c.add(1)).toBe('server');
    expect(budget.open('d').add(1)).toBe('server');
    expect(counts(budget)).toEqual({ total: 250, large: 0 });

    c.release();
    expect(budget.open('d').add(50)).toBeNull();
  });

  it("refuses with 'server' when the large-body allowance is full, though the total has room", () => {
    const budget = new BodyBytesBudget(100, 1_000, 150, 10);
    expect(budget.open('a').add(100)).toBeNull();
    expect(budget.open('b').add(50)).toBeNull();
    expect(counts(budget)).toEqual({ total: 150, large: 150 });

    expect(budget.open('c').add(10)).toBe('server');
    expect(budget.inFlight('c')).toBe(0);
  });

  it('names the user allowance when both refuse', () => {
    const budget = new BodyBytesBudget(100, 150, 150, 1);
    expect(budget.open('a').add(100)).toBeNull();
    expect(budget.open('b').add(50)).toBeNull();

    expect(budget.open('a').add(10)).toBe('user');
  });
});

describe('small and large bodies', () => {
  /** The large-body allowance full with two users' large bodies. */
  function largeFull() {
    const budget = new BodyBytesBudget(100, 250, 150, 50);
    expect(budget.open('a').add(100)).toBeNull();
    expect(budget.open('b').add(50)).toBeNull();
    expect(counts(budget)).toEqual({ total: 150, large: 150 });
    return budget;
  }

  it('admits small bodies while the large-body allowance is full, up to the rest of the total', () => {
    const budget = largeFull();
    const smalls = ['c', 'd'].map(user => budget.open(user));

    for (const small of smalls) expect(small.add(49)).toBeNull();
    expect(counts(budget)).toEqual({ total: 248, large: 150 });
    expect(budget.open('e').add(3)).toBe('server');

    for (const small of smalls) small.release();
    expect(counts(budget)).toEqual({ total: 150, large: 150 });
  });

  it('refuses a body reaching the threshold while the large-body allowance is full', () => {
    const budget = largeFull();
    expect(budget.open('c').add(50)).toBe('server');
    expect(budget.inFlight('c')).toBe(0);
  });

  it('counts a body as large, all of it, from the chunk that reaches the threshold', () => {
    const budget = new BodyBytesBudget(1_000, 1_000, 1_000, 100);
    const body = budget.open('u1');

    expect(body.add(60)).toBeNull();
    expect(counts(budget)).toEqual({ total: 60, large: 0 });
    expect(body.add(60)).toBeNull();
    expect(counts(budget)).toEqual({ total: 120, large: 120 });
    expect(body.add(30)).toBeNull();
    expect(counts(budget)).toEqual({ total: 150, large: 150 });

    body.release();
    expect(counts(budget)).toEqual({ total: 0, large: 0 });
  });

  it('refuses the chunk that would make a body large while the large-body allowance is full, and keeps the rest', () => {
    const budget = largeFull();
    const body = budget.open('c');

    expect(body.add(30)).toBeNull();
    expect(body.add(30)).toBe('server');
    // The refused chunk took nothing; what the body had is still its own.
    expect(budget.inFlight('c')).toBe(30);
    expect(counts(budget)).toEqual({ total: 180, large: 150 });

    body.release();
    expect(counts(budget)).toEqual({ total: 150, large: 150 });
  });

  it('bounds small bodies by the total, however many users send them', () => {
    const budget = new BodyBytesBudget(100, 500, 300, 100);
    const admitted: string[] = [];
    for (let i = 0; i < 20; i++) {
      const user = `u${i}`;
      if (budget.open(user).add(99) === null) admitted.push(user);
    }
    expect(admitted).toHaveLength(5);
    expect(counts(budget)).toEqual({ total: 495, large: 0 });
  });

  it("counts small bodies against their user's allowance", () => {
    const budget = new BodyBytesBudget(100, 1_000, 1_000, 1_000);
    for (let i = 0; i < 5; i++) expect(budget.open('u1').add(20)).toBeNull();

    expect(budget.inFlight('u1')).toBe(100);
    expect(budget.largeInFlight()).toBe(0);
    expect(budget.open('u1').add(1)).toBe('user');
    expect(budget.open('u2').add(20)).toBeNull();
  });
});

/** Reads a stream the way Fastify's rawBody does: 'data', 'end', 'error', then resume(). */
function readLikeFastify(stream: Readable) {
  const chunks: Buffer[] = [];
  return {
    chunks,
    done: new Promise<{ error?: Error; body: Buffer }>(resolve => {
      const onData = (chunk: Buffer) => chunks.push(chunk);
      const onEnd = (error?: Error) => {
        stream.removeListener('data', onData);
        stream.removeListener('end', onEnd);
        stream.removeListener('error', onEnd);
        resolve({ error, body: Buffer.concat(chunks) });
      };
      stream.on('data', onData);
      stream.on('end', onEnd);
      stream.on('error', onEnd);
      stream.resume();
    }),
  };
}

const tick = () => new Promise(resolve => setImmediate(resolve));

describe('countedBody', () => {
  afterEach(() => vi.restoreAllMocks());

  it('copies tiny chunks together, byte for byte, into buffers of up to 64 KiB', async () => {
    const budget = new BodyBytesBudget(10 * MiB, 10 * MiB, 10 * MiB, MiB);
    const bytes = 200_000;
    const parts = Array.from({ length: bytes }, (_, i) => Buffer.from([i % 251]));
    const reader = readLikeFastify(countedBody(Readable.from(parts), budget.open('u1')));

    const { error, body } = await reader.done;
    expect(error).toBeUndefined();
    expect(body.equals(Buffer.concat(parts))).toBe(true);
    expect(reader.chunks).toHaveLength(Math.ceil(bytes / COALESCED_CHUNK_BYTES));
    for (const chunk of reader.chunks)
      expect(chunk.length).toBeLessThanOrEqual(COALESCED_CHUNK_BYTES);
    expect(budget.inFlight('u1')).toBe(bytes);
  });

  it('passes a chunk of 64 KiB or more on as it is, after what was waiting', async () => {
    const budget = new BodyBytesBudget(10 * MiB, 10 * MiB, 10 * MiB, MiB);
    const big = Buffer.alloc(COALESCED_CHUNK_BYTES + 1, 7);
    const parts = [Buffer.from('ab'), big, Buffer.from('c')];
    const reader = readLikeFastify(countedBody(Readable.from(parts), budget.open('u1')));

    const { body } = await reader.done;
    expect(body.equals(Buffer.concat(parts))).toBe(true);
    expect(reader.chunks.map(chunk => chunk.length)).toEqual([2, big.length, 1]);
    expect(reader.chunks[1]).toBe(big);
  });

  it('counts each chunk as it arrives', async () => {
    const budget = new BodyBytesBudget(10_000, 10_000, 10_000, 1_000);
    const source = new Readable({ read() {} });
    const reader = readLikeFastify(countedBody(source, budget.open('u1')));

    source.push(Buffer.alloc(300));
    await vi.waitFor(() => expect(budget.inFlight('u1')).toBe(300));
    source.push(Buffer.alloc(400));
    await vi.waitFor(() => expect(budget.inFlight('u1')).toBe(700));
    source.push(null);

    expect((await reader.done).body).toHaveLength(700);
  });

  it('does not read the source before it is read itself', async () => {
    const budget = new BodyBytesBudget(10, 10, 10, 5);
    const source = Readable.from([Buffer.alloc(100)]);
    const body = countedBody(source, budget.open('u1'));
    const errors = vi.fn();
    body.on('error', errors);

    for (let i = 0; i < 5; i++) await tick();
    expect(budget.inFlight()).toBe(0);
    expect(errors).not.toHaveBeenCalled();

    // Once read, the chunk is counted and refused, and the reader is told.
    const { error } = await readLikeFastify(body).done;
    expect(error).toBeInstanceOf(BodyBudgetRefusal);
    expect((error as BodyBudgetRefusal).limit).toBe('user');
  });

  it('ends with a refusal naming the allowance, then reads the rest of the source and drops it', async () => {
    const budget = new BodyBytesBudget(10_000, 1_500, 10_000, 100_000);
    const source = new Readable({ read() {} });
    const reservation = budget.open('u1');
    const reader = readLikeFastify(countedBody(source, reservation));

    source.push(Buffer.alloc(1_000));
    await vi.waitFor(() => expect(budget.inFlight('u1')).toBe(1_000));
    source.push(Buffer.alloc(1_000));
    const { error } = await reader.done;
    expect(error).toBeInstanceOf(BodyBudgetRefusal);
    expect((error as BodyBudgetRefusal).limit).toBe('server');
    // The refused chunk took nothing, and neither does the rest.
    expect(budget.inFlight('u1')).toBe(1_000);

    for (let i = 0; i < 10; i++) source.push(Buffer.alloc(1_000));
    source.push(null);
    await vi.waitFor(() => expect(source.readableEnded).toBe(true));
    expect(budget.inFlight('u1')).toBe(1_000);
    // It leaves the release to the request's end.
    reservation.release();
    expect(budget.inFlight()).toBe(0);
  });

  it("passes the source's error on to its reader", async () => {
    const budget = new BodyBytesBudget(10_000, 10_000, 10_000, 1_000);
    const source = new Readable({ read() {} });
    const reader = readLikeFastify(countedBody(source, budget.open('u1')));

    source.push(Buffer.alloc(10));
    await vi.waitFor(() => expect(budget.inFlight('u1')).toBe(10));
    source.destroy(new Error('aborted'));

    expect((await reader.done).error?.message).toBe('aborted');
  });

  it('does not throw when the source fails after its reader has stopped listening', async () => {
    const budget = new BodyBytesBudget(10_000, 10_000, 10_000, 1_000);
    const source = new Readable({ read() {} });
    const body = countedBody(source, budget.open('u1'));
    // What Fastify does once it has answered a body over its limit.
    const onData = () => {
      body.removeAllListeners('data');
      body.removeAllListeners('end');
    };
    body.on('data', onData);
    body.on('end', () => {});
    body.resume();

    source.push(Buffer.alloc(10));
    await vi.waitFor(() => expect(budget.inFlight('u1')).toBe(10));
    source.destroy(new Error('aborted'));
    await vi.waitFor(() => expect(body.destroyed).toBe(true));
  });
});

describe('countedBody without an async hook before it', () => {
  /**
   * A route with no async onRequest hook and an async preParsing hook, as the
   * MCP route's is: the request's own resume runs on the next tick, before
   * the hook's promise settles and Fastify attaches its listeners.
   */
  async function app(budget: BodyBytesBudget) {
    const fastify = Fastify({ logger: false });
    fastify.post(
      '/body',
      {
        preParsing: async (_request, reply, payload) => {
          const reservation = budget.open('u1');
          reply.raw.on('close', reservation.release);
          return countedBody(payload, reservation);
        },
        errorHandler: (error, _request, reply) => {
          if (!(error instanceof BodyBudgetRefusal)) throw error;
          reply.status(429).send({ refused: error.limit });
        },
      },
      async request => ({ size: JSON.stringify(request.body).length })
    );
    await fastify.listen({ port: 0, host: '127.0.0.1' });
    const address = fastify.server.address();
    if (!address || typeof address === 'string') throw new Error('no port');
    return { fastify, url: `http://127.0.0.1:${address.port}/body` };
  }

  it('answers a refused body, with or without a Content-Length, and serves the next one', async () => {
    const budget = new BodyBytesBudget(100, 1_000, 1_000, 1_000);
    const { fastify, url } = await app(budget);
    try {
      const big = JSON.stringify({ pad: 'x'.repeat(500) });
      const sized = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: big,
      });
      expect(sized.status).toBe(429);
      expect(await sized.json()).toEqual({ refused: 'user' });

      const chunked = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: Readable.toWeb(Readable.from([Buffer.from(big)])) as ReadableStream,
        duplex: 'half',
      } as RequestInit);
      expect(chunked.status).toBe(429);

      const fits = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pad: 'x' }),
      });
      expect(fits.status).toBe(200);
      await vi.waitFor(() => expect(budget.inFlight()).toBe(0));
    } finally {
      await fastify.close();
    }
  });
});
