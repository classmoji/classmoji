/**
 * Limits on what one POST /mcp may carry, applied in this order (before any
 * of them, while the body is still arriving, its bytes count against the
 * in-flight body budget, bodyBudget.ts):
 *
 *   1. Before the body is parsed (routes/mcp.ts JSON parser): a body whose raw
 *      text carries more than MAX_BODY_JSON_VALUES JSON values is refused
 *      with a 413, so JSON.parse never builds it. Counted on the string
 *      (`jsonValueBound`), without allocating.
 *   2. After parsing, per `tools/call` (routes/mcp.ts handler): one token from
 *      the caller's tools/call rate bucket, then the exact element count of
 *      `arguments` (`countJsonElements`, the SDK's own measure). Over
 *      MAX_TOOL_INPUT_ELEMENTS, the call is answered with a tool error asking
 *      for smaller calls; the SDK and the tool never see it.
 *   3. A call above LIGHT_CALL_ELEMENTS takes its element count from
 *      `ToolInputBudget` (per user and server-wide) until its response ends.
 *      No room → a tool error asking to retry shortly.
 *   4. In the SDK: the same MAX_TOOL_INPUT_ELEMENTS (`maxToolInputElements`,
 *      registry.ts), and validation messages cut to a bounded size
 *      (`boundedValidate`, boundedIssues.ts, through toolInputSchema.ts).
 *
 * Real inputs stay far below the element limit: the largest page fixture in
 * the repo is 904 elements (62 blocks, ~14.6 elements per block), so 25,000 is
 * a page of roughly 1,700 blocks in one call. Larger edits are split into
 * several calls.
 */

/** Most array elements + object members one tools/call `arguments` may carry. */
export const MAX_TOOL_INPUT_ELEMENTS = 25_000;

/**
 * Most JSON values a POST /mcp body may carry before it is parsed. A request
 * within MAX_TOOL_INPUT_ELEMENTS never comes near it (the raw-text bound is at
 * most about twice the element count); it bounds what JSON.parse builds.
 */
export const MAX_BODY_JSON_VALUES = 4 * MAX_TOOL_INPUT_ELEMENTS;

/** Calls at or below this many elements take no in-flight budget. */
export const LIGHT_CALL_ELEMENTS = 2_000;

/**
 * Elements in flight (validating or running) per user and server-wide: two
 * maximal calls per user, four on the server.
 */
export const USER_INFLIGHT_ELEMENTS = 2 * MAX_TOOL_INPUT_ELEMENTS;
export const SERVER_INFLIGHT_ELEMENTS = 4 * MAX_TOOL_INPUT_ELEMENTS;

/**
 * Array elements plus object members in `value`, recursively — the measure
 * the MCP SDK applies for `maxToolInputElements` — iteratively, stopping once
 * the count passes `stopAfter`.
 */
export function countJsonElements(value: unknown, stopAfter = Infinity): number {
  let count = 0;
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (const child of node) {
        if (++count > stopAfter) return count;
        if (child !== null && typeof child === 'object') stack.push(child);
      }
    } else {
      for (const key in node) {
        if (!Object.prototype.hasOwnProperty.call(node, key)) continue;
        if (++count > stopAfter) return count;
        const child = (node as Record<string, unknown>)[key];
        if (child !== null && typeof child === 'object') stack.push(child);
      }
    }
  }
  return count;
}

/**
 * An upper bound on the JSON values in a JSON text, read off the raw string:
 * every `,`, `[` and `{` outside a string. A container of k ≥ 1 values has
 * k − 1 commas and one opening bracket, so the bound is at least the element
 * count `countJsonElements` would give once parsed (an empty container adds
 * one). Stops once it passes `stopAfter`. Allocates nothing.
 */
export function jsonValueBound(text: string, stopAfter = Infinity): number {
  let count = 0;
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (inString) {
      if (c === 0x5c /* \ */) i++;
      else if (c === 0x22 /* " */) inString = false;
      continue;
    }
    if (c === 0x22) inString = true;
    else if (c === 0x2c /* , */ || c === 0x5b /* [ */ || c === 0x7b /* { */) {
      if (++count > stopAfter) return count;
    }
  }
  return count;
}

/** Releases what `ToolInputBudget.tryAcquire` reserved; safe to call twice. */
export type Release = () => void;

/**
 * Elements reserved by calls in flight, per user and in total. `tryAcquire`
 * reserves `units` for a user when both the user's and the server's remaining
 * budget allow it, and returns a release; otherwise it returns null.
 */
export class ToolInputBudget {
  private readonly byUser = new Map<string, number>();
  private total = 0;
  // Plain fields, not parameter properties: the server runs on Node's type
  // stripping, which does not support them.
  private readonly perUser: number;
  private readonly perServer: number;

  constructor(perUser = USER_INFLIGHT_ELEMENTS, perServer = SERVER_INFLIGHT_ELEMENTS) {
    this.perUser = perUser;
    this.perServer = perServer;
  }

  tryAcquire(userId: string, units: number): Release | null {
    const mine = this.byUser.get(userId) ?? 0;
    if (mine + units > this.perUser || this.total + units > this.perServer) return null;
    this.byUser.set(userId, mine + units);
    this.total += units;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.byUser.get(userId) ?? 0) - units;
      if (left > 0) this.byUser.set(userId, left);
      else this.byUser.delete(userId);
      this.total -= units;
    };
  }

  /** What is reserved now (tests and logs). */
  inFlight(userId?: string): number {
    return userId === undefined ? this.total : (this.byUser.get(userId) ?? 0);
  }
}

/**
 * A request's tool handlers, counted by `wrapHandler` (registry.ts) around
 * each one it runs. `enter` answers false once the request's response has
 * closed: the result could not be sent any more, so the handler is not run.
 */
export interface HandlerTracker {
  enter(): boolean;
  exit(): void;
}

/**
 * Holds `release` until the request's response has closed AND every tool
 * handler the request started has returned, so a reservation lasts as long as
 * the work it covers, also when the client leaves before that work ends.
 * `close` goes on the response's 'close' event and `tracker` to
 * `buildMcpServer`. A call the SDK refuses before its handler starts is
 * released by `close` alone.
 */
export function releaseWhenSettled(release: Release): {
  tracker: HandlerTracker;
  close: () => void;
} {
  let running = 0;
  let closed = false;
  const settle = () => {
    if (closed && running === 0) release();
  };
  return {
    tracker: {
      enter: () => {
        if (closed) return false;
        running += 1;
        return true;
      },
      exit: () => {
        running -= 1;
        settle();
      },
    },
    close: () => {
      closed = true;
      settle();
    },
  };
}
