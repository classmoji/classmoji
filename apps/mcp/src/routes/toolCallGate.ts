/**
 * What POST /mcp checks on the `tools/call` messages of a parsed body before
 * the SDK sees them (the numbers are in mcp/inputLimits.ts):
 *
 *   1. one token per tools/call from the caller's tools/call rate bucket, for
 *      every call, including the ones refused below or later by the SDK
 *      (a status poll, POLL_TOOLS, takes none);
 *   2. the element count of each call's `arguments` (and, for a batch, of all
 *      of them together) against MAX_TOOL_INPUT_ELEMENTS;
 *   3. room in the in-flight budget for a call above LIGHT_CALL_ELEMENTS.
 *
 * A refusal is answered the way a refused tool answers (registry.ts
 * `toErrorResult`): a JSON-RPC result with `isError` and a JSON `{ error, code,
 * message }`, so the model reads why and what to do (split the call, or retry
 * shortly). Only the user, client, tool and count are logged, never arguments.
 */

import type { FastifyBaseLogger } from 'fastify';
import {
  countJsonElements,
  LIGHT_CALL_ELEMENTS,
  MAX_TOOL_INPUT_ELEMENTS,
  type Release,
  type ToolInputBudget,
} from '../mcp/inputLimits.ts';
import { toolCallBucketKey, tryConsume, TOOL_CALL_RATE_LIMIT } from '../mcp/rateLimit.ts';

interface Message {
  id?: unknown;
  method?: unknown;
  params?: { name?: unknown; arguments?: unknown };
}

interface ToolCall {
  message: Message;
  tool: string;
  elements: number;
}

export type GateOutcome =
  | { ok: true; release: Release }
  | { ok: false; status: number; body: unknown };

const noop: Release = () => {};

/**
 * Status polls clients are told to repeat every few seconds until an upload
 * is placed, with the most elements such a poll's arguments carry (`classroom`
 * and `upload_id`). A poll that small takes no token from the shared
 * tools/call bucket; its tool's own per-tool limit (registry.ts) still
 * applies. A call to the same tool with larger arguments is counted like any
 * other.
 */
export const POLL_TOOLS: ReadonlyMap<string, number> = new Map([['file_upload_status', 2]]);

const isPoll = (call: ToolCall): boolean => {
  const most = POLL_TOOLS.get(call.tool);
  return most !== undefined && call.elements <= most;
};

const asMessages = (body: unknown): Message[] =>
  (Array.isArray(body) ? body : [body]).filter(
    (m): m is Message => Boolean(m) && typeof m === 'object'
  );

/** The tool-error result a refused call gets (registry.ts `toErrorResult` shape). */
export function toolErrorResult(kind: string, code: string, message: string) {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: kind, code, message }) }],
  };
}

/**
 * The response refusing every tools/call of this body: one JSON-RPC response
 * for a single message; for a batch, one per request message in it (its other
 * requests get a JSON-RPC error, since the batch is refused as a whole).
 */
function refusal(
  body: unknown,
  kind: string,
  code: string,
  message: string
): { ok: false; status: number; body: unknown } {
  const answer = (m: Message) =>
    m.method === 'tools/call'
      ? { jsonrpc: '2.0', id: m.id, result: toolErrorResult(kind, code, message) }
      : { jsonrpc: '2.0', id: m.id, error: { code: -32600, message: `Batch refused: ${message}` } };
  if (!Array.isArray(body)) return { ok: false, status: 200, body: answer(body as Message) };
  const answers = asMessages(body)
    .filter(m => m.id !== undefined && m.id !== null)
    .map(answer);
  return answers.length > 0
    ? { ok: false, status: 200, body: answers }
    : { ok: false, status: 202, body: '' };
}

export function gateToolCalls(
  body: unknown,
  ctx: {
    userId: string;
    clientId: string | null;
    log: FastifyBaseLogger;
    budget: ToolInputBudget;
  }
): GateOutcome {
  const calls: ToolCall[] = asMessages(body)
    .filter(m => m.method === 'tools/call')
    .map(message => ({
      message,
      tool: typeof message.params?.name === 'string' ? message.params.name : '(unnamed)',
      // Bounded before parsing (MAX_BODY_JSON_VALUES), so a full count is cheap.
      elements: countJsonElements(message.params?.arguments),
    }));
  if (calls.length === 0) return { ok: true, release: noop };
  const { userId, clientId, log } = ctx;
  const tools = calls.map(c => c.tool);

  // 1. Rate: every call takes a token, so none is free whatever happens next;
  //    only a status poll is left to its own per-tool limit.
  let limited = false;
  for (const call of calls) {
    if (isPoll(call)) continue;
    if (!tryConsume(toolCallBucketKey(userId), TOOL_CALL_RATE_LIMIT)) limited = true;
  }
  if (limited) {
    log.warn({ userId, clientId, tools }, '[mcp] tool calls over the rate limit');
    return refusal(
      body,
      'rate_limited',
      'RATE_LIMITED',
      'Too many tool calls in a short time — wait a few seconds and retry.'
    );
  }

  // 2. Size.
  const elements = calls.reduce((sum, c) => sum + c.elements, 0);
  if (elements > MAX_TOOL_INPUT_ELEMENTS) {
    const largest = calls.reduce((a, b) => (b.elements > a.elements ? b : a));
    log.warn(
      { userId, clientId, tools, elements, limit: MAX_TOOL_INPUT_ELEMENTS },
      '[mcp] tool input over the element limit'
    );
    const what = calls.length === 1 ? `'${largest.tool}'` : `this batch of ${calls.length} calls`;
    return refusal(
      body,
      'invalid_params',
      'INPUT_TOO_LARGE',
      `The arguments of ${what} contain ${elements} elements (array items plus object ` +
        `members); at most ${MAX_TOOL_INPUT_ELEMENTS} are accepted per request. Split the ` +
        'change into several smaller calls.'
    );
  }

  // 3. In flight.
  if (elements <= LIGHT_CALL_ELEMENTS) return { ok: true, release: noop };
  const release = ctx.budget.tryAcquire(userId, elements);
  if (!release) {
    log.warn(
      { userId, clientId, tools, elements, inFlight: ctx.budget.inFlight() },
      '[mcp] no room for a large tool call; asked to retry'
    );
    return refusal(
      body,
      'rate_limited',
      'BUSY',
      'Too many large tool calls are being processed right now — retry in a few seconds.'
    );
  }
  return { ok: true, release };
}
