/**
 * Bytes of POST /mcp request bodies held in memory, per user and server-wide,
 * counted as they arrive.
 *
 * A body takes memory from its first byte: Fastify buffers it while it
 * arrives, then it is parsed and its tool calls run with it. The limits in
 * inputLimits.ts only see a body once it has been parsed; this budget counts
 * its bytes as they are received, before Fastify keeps them (`countedBody`,
 * wired in routes/mcp.ts):
 *
 *   - every byte counts against its user's allowance and the server's total;
 *   - once a body reaches SMALL_BODY_BYTES, all of it also counts against the
 *     large-body allowance, a part of the total, so large uploads can never
 *     take the room smaller calls need;
 *   - the bytes are held until the response has closed and every tool handler
 *     of the request has returned (`releaseWhenSettled`), including when the
 *     client leaves or the request times out (serverOptions.ts).
 *
 * A chunk that does not fit ends the request: 429 when the user's allowance
 * refuses it, 503 when the server's does (the total or the large-body
 * allowance), both with Retry-After. The rest of the body is read and dropped.
 *
 * A body over the body limit (8 MiB) is refused by Fastify before a byte is
 * read; every smaller one fits on an idle server (see the test of the limits).
 */

import { Readable } from 'node:stream';
import { MCP_BODY_LIMIT_BYTES } from '../bodyLimit.ts';
import type { Release } from './inputLimits.ts';

const MiB = 1024 * 1024;

/**
 * Per user: room for three bodies of the maximum size at once. The largest
 * bodies are files sent to page_asset_upload as base64; the calls a model
 * makes in one turn are far smaller, however many run in parallel.
 */
export const USER_INFLIGHT_BODY_BYTES = 3 * MCP_BODY_LIMIT_BYTES;

/**
 * Server-wide, every body (64 MiB): bounds the memory request bodies hold at
 * once, however many accounts send them, including while they are parsed.
 */
export const TOTAL_INFLIGHT_BODY_BYTES = 8 * MCP_BODY_LIMIT_BYTES;

/**
 * Within the total, bodies of SMALL_BODY_BYTES or more (files sent to
 * page_asset_upload): four maximum-size bodies. The other half of the total
 * is left to smaller bodies, so ordinary calls never wait behind large
 * uploads. Each half is larger than one user's allowance.
 */
export const LARGE_INFLIGHT_BODY_BYTES = 4 * MCP_BODY_LIMIT_BYTES;

/** From this size on, a body counts against the large-body allowance. */
export const SMALL_BODY_BYTES = MiB;

/** Seconds a refused client is asked to wait; bodies in flight end in seconds. */
export const BODY_BUDGET_RETRY_AFTER_SECONDS = 5;

/**
 * Chunks smaller than this are copied together into buffers of up to this
 * size before Fastify keeps them, so a body's memory stays close to its size
 * however it is framed.
 */
export const COALESCED_CHUNK_BYTES = 64 * 1024;

/** Which allowance refused a chunk: the user's, or the server's. */
export type BodyLimit = 'user' | 'server';

/** One request's bytes. */
export interface BodyReservation {
  /** Counts `bytes` more; the allowance that refused them, or null once counted. */
  add(bytes: number): BodyLimit | null;
  /** Releases all of it; safe to call twice. Nothing is counted after it. */
  release: Release;
}

export class BodyBytesBudget {
  private readonly byUser = new Map<string, number>();
  private total = 0;
  private large = 0;
  // Plain fields, not parameter properties (Node's type stripping).
  private readonly perUser: number;
  private readonly totalLimit: number;
  private readonly largeLimit: number;
  private readonly small: number;

  constructor(
    perUser = USER_INFLIGHT_BODY_BYTES,
    totalLimit = TOTAL_INFLIGHT_BODY_BYTES,
    largeLimit = LARGE_INFLIGHT_BODY_BYTES,
    small = SMALL_BODY_BYTES
  ) {
    this.perUser = perUser;
    this.totalLimit = totalLimit;
    this.largeLimit = largeLimit;
    this.small = small;
  }

  /** A reservation for one request of `userId`, holding nothing yet. */
  open(userId: string): BodyReservation {
    let mine = 0; // this body's bytes, all against the user and the total
    let large = 0; // the part also against the large-body allowance
    let released = false;
    return {
      add: bytes => {
        if (released || bytes <= 0) return null;
        const user = this.byUser.get(userId) ?? 0;
        if (user + bytes > this.perUser) return 'user';
        // From SMALL_BODY_BYTES on, the whole body counts as large.
        const next = mine + bytes;
        const largeAdded = next >= this.small ? next - large : 0;
        if (this.total + bytes > this.totalLimit) return 'server';
        if (this.large + largeAdded > this.largeLimit) return 'server';
        this.byUser.set(userId, user + bytes);
        this.total += bytes;
        this.large += largeAdded;
        mine = next;
        large += largeAdded;
        return null;
      },
      release: () => {
        if (released) return;
        released = true;
        const left = (this.byUser.get(userId) ?? 0) - mine;
        if (left > 0) this.byUser.set(userId, left);
        else this.byUser.delete(userId);
        this.total -= mine;
        this.large -= large;
      },
    };
  }

  /** Bytes held now, by one user or by everyone (tests and logs). */
  inFlight(userId?: string): number {
    return userId === undefined ? this.total : (this.byUser.get(userId) ?? 0);
  }

  /** Bytes held now against the large-body allowance (tests and logs). */
  largeInFlight(): number {
    return this.large;
  }
}

/** A chunk the budget had no room for; routes/mcp.ts answers it. */
export class BodyBudgetRefusal extends Error {
  readonly limit: BodyLimit;

  constructor(limit: BodyLimit) {
    super(`No room for the request body (the ${limit} allowance)`);
    this.name = 'BodyBudgetRefusal';
    this.limit = limit;
  }
}

/**
 * The request body as Fastify reads it: every chunk of `source` counted
 * against `reservation` as it arrives, and chunks under COALESCED_CHUNK_BYTES
 * copied together into buffers of up to that size. The buffer grows with what
 * has arrived, so a request that has sent little holds little.
 *
 * It starts reading `source` only once it is read itself. Fastify attaches its
 * 'data', 'end' and 'error' listeners before it starts reading, so a refusal or
 * an error of the source always reaches it, whether the hooks before it were
 * synchronous or not. Once Fastify has stopped listening (it answered a body
 * over its limit), an error goes to a listener that ignores it instead of
 * ending the process.
 *
 * A chunk the reservation refuses ends this stream with a BodyBudgetRefusal,
 * and the rest of the body is read and dropped, so the client gets the answer.
 * It never releases the reservation: the request's end does.
 */
export function countedBody(source: Readable, reservation: BodyReservation): Readable {
  let pending: Buffer | null = null; // small chunks copied together
  let filled = 0;
  let started = false;

  const body = new Readable({
    read() {
      if (started) {
        source.resume();
        return;
      }
      started = true;
      source.on('data', onData);
      source.on('end', onEnd);
      source.on('error', onError);
    },
    destroy(error, callback) {
      stop();
      callback(error);
    },
  });
  // Fastify reports the error while it reads; after it has answered, nobody needs it.
  body.on('error', () => {});

  function stop() {
    source.removeListener('data', onData);
    source.removeListener('end', onEnd);
    source.removeListener('error', onError);
  }

  function forward(buffer: Buffer) {
    if (!body.push(buffer)) source.pause();
  }

  function flush() {
    if (!pending) return;
    const out = pending.subarray(0, filled);
    pending = null;
    filled = 0;
    forward(out);
  }

  function onData(chunk: Buffer) {
    const refused = reservation.add(chunk.length);
    if (refused) {
      stop();
      source.resume();
      body.destroy(new BodyBudgetRefusal(refused));
      return;
    }
    if (filled + chunk.length > COALESCED_CHUNK_BYTES) flush();
    if (chunk.length >= COALESCED_CHUNK_BYTES) {
      forward(chunk);
      return;
    }
    if (!pending || filled + chunk.length > pending.length) {
      const size = Math.min(
        COALESCED_CHUNK_BYTES,
        Math.max(filled + chunk.length, 2 * (pending?.length ?? 0))
      );
      const grown = Buffer.allocUnsafeSlow(size);
      pending?.copy(grown, 0, 0, filled);
      pending = grown;
    }
    chunk.copy(pending, filled);
    filled += chunk.length;
  }

  function onEnd() {
    stop();
    flush();
    body.push(null);
  }

  function onError(error: Error) {
    body.destroy(error);
  }

  return body;
}
