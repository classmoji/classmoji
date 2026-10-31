/**
 * Ask Moji's message metadata: which keys a stored row carries, and which of
 * them any viewer receives (an allow-list, R8). Applied on every read of a
 * stored transcript (`projectAskMojiTranscript`) and to every chunk the task
 * sends (`createAskMojiChunkProjector`), so a reload shows exactly what the
 * live view showed.
 *
 *   user rows       `viewing` (as the widget sent it) passes; nothing else
 *   assistant rows  `rateable` (boolean) passes; nothing else. The server
 *                   sets it on every assistant row it reads
 *                   (`withRateable`: final, `provenance = 'model'`), so a
 *                   stored value never reaches a viewer. Live chunks carry no
 *                   assistant metadata at all (a streaming row is not final).
 *
 * Server-only keys (`ASK_MOJI_SERVER_METADATA_KEYS`): the acting role, the
 * resolved viewing and the settled marker on user rows; usage, model and cites
 * on assistant rows. Insights and the review list read these, never the raw
 * client `viewing`.
 *
 * No server imports: this module reaches the client bundle.
 */
import type { UIMessage, UIMessageChunk } from 'ai';
import { z } from 'zod';
import { createChunkProjector, projectMessage } from '../agents/projection.ts';
import { CITE_CONTENT_TOOL, type AskMojiRole } from './tools.ts';
import {
  AskMojiViewingSchema,
  CiteContentOutputSchema,
  VIEWING_KINDS,
  type AskMojiMessageMetadata,
  type AskMojiViewingKind,
} from './uiTypes.ts';
import { askMojiVisibility } from './visibility.ts';

/** The metadata keys a viewer may receive, by row role. */
export const ASK_MOJI_PROJECTED_METADATA_KEYS = {
  user: ['viewing'],
  assistant: ['rateable'],
} as const;

/** Keys only the server reads. Never sent to a browser, live or stored. */
export const ASK_MOJI_SERVER_METADATA_KEYS = [
  'acting_role',
  'resolved_viewing',
  'settled',
  'usage',
  'model',
  'cites',
] as const;

/** How a turn ended (the settled marker on its user row). */
export const TURN_OUTCOMES = ['final', 'failed', 'stopped'] as const;
export type AskMojiTurnOutcome = (typeof TURN_OUTCOMES)[number];

/** The settled marker: written once a turn ends, cleared when the same message runs again. */
export type AskMojiSettled = { outcome: AskMojiTurnOutcome; at: string };

/** What a user row's viewing resolved to on the server: a kind and an id, nothing else. */
export type AskMojiViewingRef = { kind: AskMojiViewingKind; id: string | null };

export const AskMojiViewingRefSchema = z
  .object({ kind: z.enum(VIEWING_KINDS), id: z.string().min(1).max(128).nullable() })
  .strict();

/** One turn's model usage, summed over its calls (the summarizer's included). */
export const AskMojiUsageSchema = z
  .object({
    input: z.number().int().min(0),
    output: z.number().int().min(0),
    cacheRead: z.number().int().min(0),
    cacheWrite: z.number().int().min(0),
    reasoning: z.number().int().min(0),
    calls: z.number().int().min(0),
    model: z.string().max(200).nullable(),
  })
  .strict();

export type AskMojiUsage = z.infer<typeof AskMojiUsageSchema>;

/** A citation the server resolved (an ok `cite_content` result), as stored for insights. */
export type AskMojiCiteRef = {
  type: 'page' | 'slides' | 'platform_docs';
  id?: string;
  path?: string;
  title?: string;
};

/** A user row's stored metadata. */
export type AskMojiUserRowMetadata = {
  viewing?: z.infer<typeof AskMojiViewingSchema>;
  acting_role?: AskMojiRole;
  resolved_viewing?: AskMojiViewingRef | null;
  settled?: AskMojiSettled;
};

/** An assistant row's stored metadata. */
export type AskMojiAssistantRowMetadata = {
  usage?: AskMojiUsage;
  model?: string;
  cites?: AskMojiCiteRef[];
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The metadata a viewer receives for a stored row of this role: `{ viewing }`
 * for a user row whose stored viewing still parses, `{ rateable }` for an
 * assistant row carrying a boolean one, else undefined (no key).
 */
export function projectAskMojiMetadata(
  role: string,
  metadata: unknown
): AskMojiMessageMetadata | undefined {
  if (!isRecord(metadata)) return undefined;
  if (role === 'assistant') {
    return typeof metadata.rateable === 'boolean' ? { rateable: metadata.rateable } : undefined;
  }
  if (role !== 'user') return undefined;
  const viewing = AskMojiViewingSchema.safeParse(metadata.viewing);
  return viewing.success ? { viewing: viewing.data } : undefined;
}

/** The stored row facts `rateable` is decided by. */
export type AskMojiRateableRow = { role: string; final: boolean; provenance: string | null };

/** Whether a viewer may rate a stored row: a final ASSISTANT row written by the model. */
export const isRateableRow = (row: AskMojiRateableRow): boolean =>
  row.role === 'ASSISTANT' && row.final === true && row.provenance === 'model';

/**
 * Stored metadata with the server's `rateable` decision written over any
 * stored value: on an ASSISTANT row, `rateable` is `isRateableRow(row)`; any
 * other row's metadata is returned as it is. Apply before projecting.
 */
export function withRateable<T extends AskMojiRateableRow & { metadata: unknown }>(row: T): T {
  if (row.role !== 'ASSISTANT') return row;
  const metadata = isRecord(row.metadata) ? row.metadata : {};
  return { ...row, metadata: { ...metadata, rateable: isRateableRow(row) } };
}

/** A stored message as a viewer sees it: parts through the registry, metadata through the allow-list. */
export function projectAskMojiMessage<M extends UIMessage<any, any, any>>(m: M): M | null {
  const projected = projectMessage(m, askMojiVisibility);
  if (!projected) return null;
  const { metadata: _all, ...rest } = projected;
  const metadata = projectAskMojiMetadata(m.role, m.metadata);
  return (metadata ? { ...rest, metadata } : rest) as M;
}

export function projectAskMojiTranscript<M extends UIMessage<any, any, any>>(
  ms: readonly M[]
): M[] {
  const out: M[] = [];
  for (const m of ms) {
    const projected = projectAskMojiMessage(m);
    if (projected) out.push(projected);
  }
  return out;
}

/** Chunks that carry `messageMetadata`. */
const METADATA_CHUNKS = new Set(['start', 'finish', 'message-metadata']);

/**
 * The metadata rule on one outgoing chunk: the task streams assistant
 * messages only, which keep no metadata, so `messageMetadata` is cut from
 * `start` and `finish`, and a `message-metadata` chunk is dropped (null).
 * Every other chunk passes unchanged.
 */
export function filterAskMojiChunkMetadata<CHUNK extends UIMessageChunk<any, any>>(
  chunk: CHUNK
): CHUNK | null {
  const type = (chunk as { type: string }).type;
  if (!METADATA_CHUNKS.has(type)) return chunk;
  if (type === 'message-metadata') return null;
  if (!('messageMetadata' in (chunk as object))) return chunk;
  const { messageMetadata: _dropped, ...rest } = chunk as CHUNK & { messageMetadata?: unknown };
  return rest as CHUNK;
}

/**
 * The full outgoing filter for one Ask Moji reply stream: the registry's part
 * rule (`askMojiVisibility`), then the metadata rule. Returns the chunk to
 * send, or null to drop it. One per stream (it tracks tool call ids).
 */
export function createAskMojiChunkProjector<
  CHUNK extends UIMessageChunk<any, any> = UIMessageChunk,
>(): (chunk: CHUNK) => CHUNK | null {
  const parts = createChunkProjector<CHUNK>(askMojiVisibility);
  return chunk => {
    const passed = parts(chunk);
    return passed === null ? null : filterAskMojiChunkMetadata(passed);
  };
}

// ─── Parts the server reads ─────────────────────────────────────────────────

type AnyPart = { type?: unknown; state?: unknown; output?: unknown; input?: unknown };

/**
 * The citations a reply's parts resolved: every `tool-cite_content` call
 * whose output is `ok: true`, deduplicated by target, in order. What persist
 * stores as `metadata.cites`.
 */
export function citesFromParts(parts: readonly unknown[]): AskMojiCiteRef[] {
  const out: AskMojiCiteRef[] = [];
  const seen = new Set<string>();
  for (const raw of parts) {
    const part = raw as AnyPart;
    if (!isRecord(part) || part.type !== `tool-${CITE_CONTENT_TOOL}`) continue;
    if (part.state !== 'output-available') continue;
    const output = CiteContentOutputSchema.safeParse(part.output);
    if (!output.success || !output.data.ok) continue;
    const input = isRecord(part.input) ? part.input : {};
    const type = output.data.type ?? input.type;
    if (type !== 'page' && type !== 'slides' && type !== 'platform_docs') continue;
    const id = output.data.id ?? (typeof input.id === 'string' ? input.id : undefined);
    const path = output.data.path ?? (typeof input.path === 'string' ? input.path : undefined);
    const key = `${type}:${id ?? ''}:${path ?? ''}`;
    if ((!id && !path) || seen.has(key)) continue;
    seen.add(key);
    out.push({
      type,
      ...(id ? { id } : {}),
      ...(path ? { path } : {}),
      ...(output.data.title ? { title: output.data.title } : {}),
    });
  }
  return out;
}

/** What a stored MCP tool output becomes once it can no longer reach the model. */
export const TOOL_OUTPUT_STUB = '[output removed]';

/** Whether a part is a course lookup (an MCP tool call): any tool part but `cite_content`. */
export function isLookupPart(part: unknown): boolean {
  if (!isRecord(part) || typeof part.type !== 'string') return false;
  if (part.type === 'dynamic-tool') return true;
  return part.type.startsWith('tool-') && part.type !== `tool-${CITE_CONTENT_TOOL}`;
}

/**
 * Parts with every course lookup's output replaced by `stub` (inputs kept),
 * and whether anything changed. Text, `cite_content`, `data-*` and every
 * other part are kept as they are. A stored output is a string (the task's
 * joined text); an object one, from older rows, is replaced too.
 */
export function stubLookupOutputs(
  parts: readonly unknown[],
  stub: string = TOOL_OUTPUT_STUB
): { parts: unknown[]; changed: boolean } {
  let changed = false;
  const out = parts.map(part => {
    if (!isLookupPart(part)) return part;
    const p = part as Record<string, unknown>;
    if (!('output' in p) || p.output === stub) return part;
    changed = true;
    return { ...p, output: stub };
  });
  return { parts: out, changed };
}
