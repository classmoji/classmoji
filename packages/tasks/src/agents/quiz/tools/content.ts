/**
 * `content_get` and `content_search`: the quiz's course-material lookups,
 * made through the Classmoji MCP server AS THE ATTEMPT'S USER, as the previous
 * runtime made them (the ai-agent's `utils/quizContentTools.js`).
 *
 * AUTHORIZATION. Each lookup carries the read-only MCP bearer that
 * `mintMcpAccessToken` (`@classmoji/auth/mcp-token`) mints, or reuses while
 * it has time left, for the attempt's own user: the token the webapp used to
 * hand the previous runtime on every turn. Here the task mints it itself, for
 * the user id on the attempt row (never anything the browser sent). The MCP
 * server re-resolves that user's membership and role in the named classroom
 * on every call and applies the content visibility rule itself, so a student
 * reads published material only. The bearer is kept in this closure for one
 * turn; it is never logged, stored or written to the stream.
 *
 * SCOPE, checked here before any call (the previous runtime's PreToolUse hook):
 *   - every call names this attempt's classroom (`org/slug`), added here; the
 *     model's input has no classroom;
 *   - without course search, content_get reads only the documents loaded as
 *     this attempt's source material (by kind and id), and content_search
 *     keeps only the hits among them;
 *   - with course search, content_get may open any document of the classroom
 *     (a search hit is only useful if it can be read; the MCP decides what
 *     this user may see) and content_search searches the whole course.
 * A refused call reads nothing and shows nothing.
 *
 * PER TURN: at most `MAX_LOOKUPS_PER_TURN` lookups, content_get and
 * content_search together, failed ones included (the set is built per turn);
 * after that a call is refused with `CONTENT_LIMIT_TEXT`, so a model that
 * keeps looking moves on. A content_get refused because the document is not
 * linked reads nothing and does not count.
 *
 * WHAT THE STUDENT SEES: one `course_material` step per lookup, as before: a
 * search shows no title (its query is the model's next question); a linked
 * document shows its material title as the call starts; any other document
 * shows the title the MCP returned, once it has returned it (a failed read
 * shows nothing). The tool parts are `label` in the projection, so the query,
 * the id and the text never leave the task.
 *
 * WHAT THE MODEL SEES: plain text. A document is capped at
 * `CONTENT_GET_MAX_CHARS`, the size the previous runtime's MCP results were
 * capped at, with the source-material loader's marker line when it is cut; a
 * search lists at most `SEARCH_RESULT_LIMIT` hits with their snippets.
 *
 * LOGS: ids and counts only; never the query, the text or the token. A
 * document id is logged only when it is one of the linked documents or has
 * the shape of a Classmoji id (a UUID); any other id the model sent is logged
 * as `UNLISTED_DOC_ID`.
 */
import { tool } from 'ai';
import {
  ContentGetSchema,
  ContentSearchSchema,
  ContentToolOutputSchema,
  COURSE_STEP_TITLE_MAX,
  TOOL_DESCRIPTIONS,
} from '@classmoji/utils/quiz-agent';
import { logDiagnostic } from '../../shared/sanitize.ts';
import type { AttemptContext, ContentScope } from '../context.ts';
import { aborted } from './errors.ts';
import type { QuizToolDeps } from './index.ts';

/**
 * Most characters of one document's text the model is handed: the previous
 * runtime's ceiling (the Agent SDK's default MCP result limit, 25,000 tokens,
 * about 100,000 characters). Above the source material's own per-document
 * limit (60,000), so re-reading a document cut in the prompt returns more.
 */
export const CONTENT_GET_MAX_CHARS = 100_000;
/** Hits a search returns to the model (the MCP's default). */
export const SEARCH_RESULT_LIMIT = 5;
/** Hits asked for when only the linked documents may be kept (the MCP's maximum). */
export const LINKED_SEARCH_LIMIT = 20;
/** One MCP request's ceiling, connection included. */
export const MCP_CALL_TIMEOUT_MS = 30_000;
/** Lookups one turn may make, content_get and content_search together. */
export const MAX_LOOKUPS_PER_TURN = 3;
/** What the log line carries in place of a document id that is neither linked nor UUID-shaped. */
export const UNLISTED_DOC_ID = 'unlisted';

/** A content_get step for a document whose result carries no title. */
export const CONTENT_STEP_FALLBACK_TITLE = 'a course document';

/** content_get refused before any call: without course search, only the linked documents. */
export const CONTENT_NOT_LINKED_TEXT =
  'content_get may only read the documents listed under SOURCE MATERIAL. Use a kind and id from a SOURCE MATERIAL header, or continue without it.';
/** The MCP found no such document for this user (missing, another classroom's, or not visible). */
export const CONTENT_NOT_FOUND_TEXT = 'That document is not in this course. Do not try it again.';
/** Anything else that stopped a lookup. */
export const CONTENT_FAILED_TEXT =
  'Course material could not be read just now. Continue with what you have; never tell the student about it.';
/** The search could not run (the MCP's `unavailable`): not an empty result. */
export const SEARCH_UNAVAILABLE_TEXT =
  'Search could not run just now: no search was run, so this is NOT an empty result. Continue with the material you have.';
export const SEARCH_NO_HITS_TEXT =
  'No matching course material. A miss does not prove the course does not cover it.';
export const CONTENT_STOPPED_TEXT = 'This turn was stopped. Nothing was read.';
/** Refused past `MAX_LOOKUPS_PER_TURN` in one turn. */
export const CONTENT_LIMIT_TEXT =
  'You have looked up enough course material this turn. Continue with what you have.';

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The id a log line may carry: a linked document's, a UUID-shaped one, or the fixed marker. */
export function loggableDocId(id: string, isLinked: boolean): string {
  return isLinked || UUID_SHAPE.test(id) ? id : UNLISTED_DOC_ID;
}

/** The part of an MCP client a lookup uses; `@ai-sdk/mcp`'s client fits. */
export type McpContentClient = {
  callTool(args: {
    name: string;
    arguments?: Record<string, unknown>;
    options?: { signal?: AbortSignal; timeout?: number };
  }): Promise<unknown>;
  close(): Promise<void>;
};

export type ConnectMcp = (o: {
  url: string;
  token: string;
  signal: AbortSignal;
}) => Promise<McpContentClient>;

export type ContentToolServices = {
  /** The attempt user's read-only MCP bearer (minted, or a live one reused). */
  mintToken: (userId: string) => Promise<string>;
  /** A connected client for one lookup, closed after it. */
  connect: ConnectMcp;
};

/** `mintMcpAccessToken` for the attempt's user, loaded on first use. */
export async function mintMcpToken(userId: string): Promise<string> {
  // eslint-disable-next-line import/no-unresolved -- package subpath export, resolved by the bundler
  const { mintMcpAccessToken } = await import('@classmoji/auth/mcp-token');
  const { accessToken } = await mintMcpAccessToken(userId);
  return accessToken;
}

/**
 * An `@ai-sdk/mcp` client on the Classmoji MCP server's Streamable HTTP
 * endpoint, authorized with the user's bearer. The server is stateless and
 * speaks the initialize handshake, so protocol discovery is skipped; a
 * redirect is refused rather than followed with the bearer attached.
 */
export const connectMcp: ConnectMcp = async ({ url, token, signal }) => {
  const { createMCPClient } = await import('@ai-sdk/mcp');
  return createMCPClient({
    transport: {
      type: 'http',
      url,
      headers: { Authorization: `Bearer ${token}` },
      redirect: 'error',
    },
    protocolVersionDiscovery: false,
    clientName: 'classmoji-quiz-agent',
    initializationOptions: { signal, timeout: MCP_CALL_TIMEOUT_MS },
  });
};

/** The key a document is known by in the scope: `kind:id`. */
export const materialKey = (kind: string, id: string) => `${kind}:${id}`;

type McpOutcome = { ok: true; payload: Record<string, unknown> } | { ok: false; kind: string };

/**
 * What an MCP tool result says: the JSON object of its first text block that
 * parses to one, or its error kind. The MCP answers a success with one text
 * block holding a JSON object, and a failure with `isError` and a JSON
 * `{ error, message }` (apps/mcp registry `toErrorResult`).
 */
export function readMcpResult(result: unknown): McpOutcome {
  const r = (result && typeof result === 'object' ? result : {}) as {
    content?: unknown;
    isError?: unknown;
  };
  const texts = Array.isArray(r.content)
    ? r.content
        .filter(
          (item): item is { type: 'text'; text: string } =>
            item?.type === 'text' && typeof item.text === 'string'
        )
        .map(item => item.text)
    : [];
  for (const text of texts) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
    const payload = parsed as Record<string, unknown>;
    if (r.isError === true || 'error' in payload) {
      return { ok: false, kind: typeof payload.error === 'string' ? payload.error : 'error' };
    }
    return { ok: true, payload };
  }
  return { ok: false, kind: r.isError === true ? 'error' : 'invalid_result' };
}

/** A step title: trimmed and bounded, or null when there is none. */
function stepTitle(title: unknown): string | null {
  if (typeof title !== 'string') return null;
  const trimmed = title.trim();
  return trimmed ? trimmed.slice(0, COURSE_STEP_TITLE_MAX) : null;
}

/** The loader's marker line for a cut document (quizSourceMaterial `truncationMarker`). */
const formatCount = (n: number) => n.toLocaleString('en-US');
export const truncationMarker = (cut: number, total: number) =>
  `[… ${formatCount(cut)} of ${formatCount(total)} characters omitted]`;

/** A document's text for the model: capped, with the marker line when cut. */
export function cappedText(text: string, limit = CONTENT_GET_MAX_CHARS): string {
  if (text.length <= limit) return text;
  let cutAt = limit;
  const last = text.charCodeAt(cutAt - 1);
  if (last >= 0xd800 && last <= 0xdbff) cutAt -= 1;
  return `${text.slice(0, cutAt)}\n\n${truncationMarker(text.length - cutAt, text.length)}`;
}

/** A document as the model reads it: the SOURCE MATERIAL header, then its text. */
function formatDocument(doc: { kind: string; id: string; title: string; text: string }): string {
  return (
    `=== ${doc.kind}: ${JSON.stringify(doc.title || 'Untitled')} (id: ${doc.id}) ===\n` +
    cappedText(doc.text.replace(/\s+$/, ''))
  );
}

type Hit = { kind: string; id: string; title: string; snippet: string };

/** The hits of a content_search payload, in rank order, with the fields the model reads. */
function hitsOf(payload: Record<string, unknown>): Hit[] {
  const hits = Array.isArray(payload.hits) ? payload.hits : [];
  return hits.flatMap(hit => {
    const h = (hit && typeof hit === 'object' ? hit : {}) as Record<string, unknown>;
    if (typeof h.kind !== 'string' || typeof h.id !== 'string' || !h.kind || !h.id) return [];
    return [
      {
        kind: h.kind,
        id: h.id,
        title: typeof h.title === 'string' ? h.title : '',
        snippet: typeof h.snippet === 'string' ? h.snippet : '',
      },
    ];
  });
}

function formatHits(hits: Hit[]): string {
  if (hits.length === 0) return SEARCH_NO_HITS_TEXT;
  return [
    `${hits.length} ${hits.length === 1 ? 'match' : 'matches'} (open one in full with content_get):`,
    ...hits.map(
      (hit, i) =>
        `${i + 1}. ${hit.kind}: ${JSON.stringify(hit.title || 'Untitled')} (id: ${hit.id})\n` +
        `   ${hit.snippet.replace(/\s+/g, ' ').trim()}`
    ),
  ].join('\n');
}

/**
 * The two content tools for one turn (the set is built per turn), in the
 * fixed order. `scope` is the attempt's, fixed for its life.
 */
export function contentTools(
  ctx: AttemptContext,
  scope: ContentScope,
  d: QuizToolDeps,
  services: ContentToolServices
) {
  const ids = { attemptId: ctx.attemptId, runId: ctx.runId };
  const diagIds = { chatId: ctx.attemptId, runId: ctx.runId };
  /** The linked documents' titles, by `kind:id`. */
  const linked = new Map<string, string>(
    scope.docs.map(doc => [materialKey(doc.kind, doc.id), doc.title])
  );

  // One bearer per turn; a failed mint or a refused bearer is tried afresh.
  let bearer: Promise<string> | null = null;
  const token = () => {
    bearer ??= services.mintToken(ctx.userId).catch((error: unknown) => {
      bearer = null;
      throw error;
    });
    return bearer;
  };

  /** Lookups started in this turn (the set is built per turn), failed ones included. */
  let lookups = 0;
  /** Takes one of the turn's lookups, or refuses the call once they are used up. */
  const takeLookup = () => {
    if (lookups >= MAX_LOOKUPS_PER_TURN) {
      d.log?.('[quiz-agent] content lookup refused', { ...ids, reason: 'turn_limit' });
      throw new Error(CONTENT_LIMIT_TEXT);
    }
    lookups += 1;
  };

  const signalFor = (abortSignal?: AbortSignal) =>
    abortSignal ? AbortSignal.any([d.signal, abortSignal]) : d.signal;

  const writeStep = (title: string | null) => {
    try {
      d.writer.write({
        type: 'data-step',
        data: { kind: 'course_material', ...(title ? { title } : {}) },
      });
    } catch (error) {
      logDiagnostic('content_step', error, diagIds, d.log);
    }
  };

  /** One MCP call on a fresh connection, closed after it. Throws only for transport faults. */
  const callMcp = async (
    name: 'content_get' | 'content_search',
    args: Record<string, unknown>,
    signal: AbortSignal
  ): Promise<McpOutcome> => {
    const client = await services.connect({ url: scope.mcpUrl, token: await token(), signal });
    try {
      const result = await client.callTool({
        name,
        arguments: { classroom: scope.classroomRef, ...args },
        options: { signal, timeout: MCP_CALL_TIMEOUT_MS },
      });
      return readMcpResult(result);
    } finally {
      await client.close().catch(() => undefined);
    }
  };

  /** The error to throw for a call that did not get through. */
  const failed = (
    label: 'content_get' | 'content_search',
    error: unknown,
    abortSignal?: AbortSignal
  ) => {
    if (aborted(d.signal, abortSignal)) return new Error(CONTENT_STOPPED_TEXT);
    // A refused bearer is minted afresh on the next call.
    bearer = null;
    logDiagnostic(label, error, diagIds, d.log);
    return new Error(CONTENT_FAILED_TEXT);
  };

  const content_get = tool({
    description: TOOL_DESCRIPTIONS.content_get,
    inputSchema: ContentGetSchema,
    outputSchema: ContentToolOutputSchema,
    execute: async (input, { abortSignal }): Promise<string> => {
      const key = materialKey(input.kind, input.id);
      const isLinked = linked.has(key);
      const docFields = input.kind === 'file' ? {} : { docId: loggableDocId(input.id, isLinked) };
      // Refused before it takes a lookup: it reads nothing.
      const notLinked = !isLinked && !scope.courseSearchEnabled;
      // Counted at entry, before the queue: the calls of one step start together.
      if (!notLinked) takeLookup();
      return d.queue(async () => {
        if (aborted(d.signal, abortSignal)) throw new Error(CONTENT_STOPPED_TEXT);
        if (notLinked) {
          d.log?.('[quiz-agent] content_get refused', {
            ...ids,
            kind: input.kind,
            reason: 'not_linked',
          });
          throw new Error(CONTENT_NOT_LINKED_TEXT);
        }
        // A linked document is named by the material, so its step shows at once.
        if (isLinked) writeStep(stepTitle(linked.get(key)) ?? CONTENT_STEP_FALLBACK_TITLE);

        let outcome: McpOutcome;
        try {
          outcome = await callMcp(
            'content_get',
            { kind: input.kind, id: input.id },
            signalFor(abortSignal)
          );
        } catch (error) {
          throw failed('content_get', error, abortSignal);
        }
        if (aborted(d.signal, abortSignal)) throw new Error(CONTENT_STOPPED_TEXT);

        const p = outcome.ok ? outcome.payload : null;
        // The document served must be the one asked for, with text.
        if (!p || p.kind !== input.kind || p.id !== input.id || typeof p.text !== 'string') {
          const reason = outcome.ok ? 'invalid_result' : outcome.kind;
          d.log?.('[quiz-agent] content_get', {
            ...ids,
            kind: input.kind,
            ...docFields,
            linked: isLinked ? 1 : 0,
            outcome: reason,
          });
          throw new Error(reason === 'not_found' ? CONTENT_NOT_FOUND_TEXT : CONTENT_FAILED_TEXT);
        }

        const title = stepTitle(p.title);
        // Any other document is named by what the MCP returned for this user.
        if (!isLinked) writeStep(title ?? CONTENT_STEP_FALLBACK_TITLE);
        d.log?.('[quiz-agent] content_get', {
          ...ids,
          kind: input.kind,
          ...docFields,
          linked: isLinked ? 1 : 0,
          outcome: 'ok',
          chars: p.text.length,
          cut: p.text.length > CONTENT_GET_MAX_CHARS ? 1 : 0,
        });
        return formatDocument({
          kind: input.kind,
          id: input.id,
          title: typeof p.title === 'string' ? p.title : '',
          text: p.text,
        });
      });
    },
  });

  const content_search = tool({
    description: TOOL_DESCRIPTIONS.content_search,
    inputSchema: ContentSearchSchema,
    outputSchema: ContentToolOutputSchema,
    execute: async (input, { abortSignal }): Promise<string> => {
      takeLookup();
      return d.queue(async () => {
        if (aborted(d.signal, abortSignal)) throw new Error(CONTENT_STOPPED_TEXT);
        // A search shows as it starts, with no title: its query is the next question.
        writeStep(null);

        const courseWide = scope.courseSearchEnabled;
        let outcome: McpOutcome;
        try {
          outcome = await callMcp(
            'content_search',
            {
              query: input.query,
              scope: 'course',
              limit: courseWide ? SEARCH_RESULT_LIMIT : LINKED_SEARCH_LIMIT,
            },
            signalFor(abortSignal)
          );
        } catch (error) {
          throw failed('content_search', error, abortSignal);
        }
        if (aborted(d.signal, abortSignal)) throw new Error(CONTENT_STOPPED_TEXT);

        const logFields = {
          ...ids,
          scope: courseWide ? 'course' : 'linked',
          queryChars: input.query.length,
        };
        if (!outcome.ok) {
          d.log?.('[quiz-agent] content_search', { ...logFields, outcome: outcome.kind });
          throw new Error(CONTENT_FAILED_TEXT);
        }
        if (typeof outcome.payload.unavailable === 'string') {
          d.log?.('[quiz-agent] content_search', { ...logFields, outcome: 'unavailable' });
          return SEARCH_UNAVAILABLE_TEXT;
        }

        const all = hitsOf(outcome.payload);
        const kept = (
          courseWide ? all : all.filter(hit => linked.has(materialKey(hit.kind, hit.id)))
        ).slice(0, SEARCH_RESULT_LIMIT);
        d.log?.('[quiz-agent] content_search', {
          ...logFields,
          outcome: 'ok',
          hits: all.length,
          kept: kept.length,
        });
        return formatHits(kept);
      });
    },
  });

  return { content_get, content_search };
}
