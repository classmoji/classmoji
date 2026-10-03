/**
 * One allow-list projection for every chat agent: what any viewer (student or
 * staff) receives of an agent's messages, live and on every read.
 *
 * Each agent declares a registry: a visibility for every tool and a schema for
 * every data part it may send. The live UI stream is filtered chunk by chunk
 * (`createChunkProjector`), stored messages part by part (`projectMessage`), with
 * the same rule, so a reload shows exactly what the live view showed.
 *
 *   shown   the tool's parts pass as they are
 *   label   the tool's parts are dropped; its own code writes a data part instead
 *   hidden  the tool's parts are dropped
 *
 * A shown tool may also name input keys no viewer receives (`hiddenInputKeys`):
 * they are cut from its input, live and stored, and its streamed input text is
 * not sent at all, so the viewer has its input only once the call is complete.
 *
 * A tool with no entry is hidden; a data part with no schema is dropped; a
 * declared data part is re-validated and passes with its schema's fields only.
 * Reasoning, sources, files, custom parts and approvals never pass.
 *
 * No server imports: loaders and the task run the same code.
 */
import type { UIMessage, UIMessageChunk } from 'ai';

export type ToolVisibility = 'shown' | 'label' | 'hidden';

/** The part of a Zod schema the projection uses (object schemas strip unknown keys). */
export type DataPartSchema = {
  safeParse(value: unknown): { success: true; data: unknown } | { success: false; error: unknown };
};

export type Registry<TOOL extends string = string, DATA extends string = string> = {
  tools: Readonly<Record<TOOL, ToolVisibility>>;
  dataParts: Readonly<Record<DATA, DataPartSchema>>;
  /** Input keys of a tool that no viewer receives (see the header). */
  hiddenInputKeys?: Readonly<Partial<Record<TOOL, readonly string[]>>>;
};

// Registries are looked up with names from the stream, so only own keys count
// (a tool named "constructor" must not find Object.prototype.constructor).
const own = (o: object, key: string) => Object.prototype.hasOwnProperty.call(o, key);

export function toolVisibility(reg: Registry, toolName: string): ToolVisibility {
  return own(reg.tools, toolName)
    ? (reg.tools as Record<string, ToolVisibility>)[toolName]
    : 'hidden';
}

/** The input keys of a tool that no viewer receives (none for most tools). */
function hiddenInputKeys(reg: Registry, toolName: string): readonly string[] {
  const keys = reg.hiddenInputKeys;
  return keys && own(keys, toolName) ? (keys[toolName] ?? []) : [];
}

/**
 * A tool input without the given keys. An input that is not an object (the raw
 * text of a call whose JSON did not parse) cannot be cut, so none of it is sent.
 */
function withoutKeys(input: unknown, keys: readonly string[]): unknown {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const out: Record<string, unknown> = { ...(input as Record<string, unknown>) };
  for (const key of keys) delete out[key];
  return out;
}

/** The validated payload of a declared data part, or undefined when it must be dropped. */
function projectData(reg: Registry, type: string, data: unknown): { data: unknown } | undefined {
  const name = type.slice('data-'.length);
  if (!own(reg.dataParts, name)) return undefined;
  const parsed = (reg.dataParts as Record<string, DataPartSchema>)[name].safeParse(data);
  return parsed.success ? { data: parsed.data } : undefined;
}

const PASS_CHUNK_TYPES = new Set<string>([
  'start',
  'finish',
  'abort',
  'start-step',
  'finish-step',
  'reset-step',
  'message-metadata',
  'text-start',
  'text-delta',
  'text-end',
  'error',
]);

const NAMING_TOOL_CHUNKS = new Set<string>([
  'tool-input-start',
  'tool-input-available',
  'tool-input-error',
]);

const ID_ONLY_TOOL_CHUNKS = new Set<string>([
  'tool-input-delta',
  'tool-output-available',
  'tool-output-error',
  'tool-output-denied',
]);

/**
 * A stateful filter for one UI message stream: returns the chunk to send, or null
 * to drop it. A tool call's visibility is recorded from the chunks that name its
 * tool; a chunk whose toolCallId was never named is dropped.
 */
export function createChunkProjector<CHUNK extends UIMessageChunk<any, any> = UIMessageChunk>(
  reg: Registry
): (chunk: CHUNK) => CHUNK | null {
  const callVisibility = new Map<string, ToolVisibility>();
  /** The hidden input keys of each call, from every tool that named it. */
  const callHiddenKeys = new Map<string, readonly string[]>();

  return (chunk: CHUNK): CHUNK | null => {
    const type = chunk.type as string;
    if (PASS_CHUNK_TYPES.has(type)) return chunk;

    if (NAMING_TOOL_CHUNKS.has(type)) {
      const c = chunk as unknown as { toolCallId: string; toolName: string; input?: unknown };
      const named = toolVisibility(reg, c.toolName);
      const earlier = callVisibility.get(c.toolCallId);
      // A call id named twice stays shown only if every naming is a shown tool.
      const effective: ToolVisibility =
        earlier === undefined
          ? named
          : earlier === 'shown' && named === 'shown'
            ? 'shown'
            : 'hidden';
      callVisibility.set(c.toolCallId, effective);
      const keys = [
        ...(callHiddenKeys.get(c.toolCallId) ?? []),
        ...hiddenInputKeys(reg, c.toolName),
      ];
      if (keys.length > 0) callHiddenKeys.set(c.toolCallId, keys);
      if (effective !== 'shown') return null;
      if (keys.length === 0 || type === 'tool-input-start') return chunk;
      return { ...c, input: withoutKeys(c.input, keys) } as unknown as CHUNK;
    }

    if (ID_ONLY_TOOL_CHUNKS.has(type)) {
      const c = chunk as unknown as { toolCallId: string };
      if (callVisibility.get(c.toolCallId) !== 'shown') return null;
      // Deltas are raw JSON text that cannot be cut safely, so a call with hidden keys sends none.
      if (type === 'tool-input-delta' && callHiddenKeys.has(c.toolCallId)) return null;
      return chunk;
    }

    if (type.startsWith('data-')) {
      const c = chunk as unknown as { id?: string; data: unknown; transient?: boolean };
      const projected = projectData(reg, type, c.data);
      if (!projected) return null;
      const out: { type: string; id?: string; data: unknown; transient?: boolean } = {
        type,
        data: projected.data,
      };
      if (c.id !== undefined) out.id = c.id;
      if (c.transient !== undefined) out.transient = c.transient;
      return out as unknown as CHUNK;
    }

    // reasoning-*, reasoning-file, source-*, file, custom, tool approvals, unknown
    return null;
  };
}

type AnyPart = { type: string; toolName?: string; data?: unknown };

type ToolPartInput = { state?: unknown; input?: unknown; rawInput?: unknown };

/**
 * A shown tool's stored part as the live stream built it: hidden input keys
 * cut, no raw input text, and no input while it was still streaming (the live
 * stream sends none before the call is complete).
 */
function projectToolPart<P extends AnyPart>(part: P, reg: Registry, toolName: string): P | null {
  if (toolVisibility(reg, toolName) !== 'shown') return null;
  const keys = hiddenInputKeys(reg, toolName);
  if (keys.length === 0) return part;
  const { rawInput: _raw, ...rest } = part as P & ToolPartInput;
  const input = rest.state === 'input-streaming' ? undefined : withoutKeys(rest.input, keys);
  return { ...rest, input } as P;
}

function projectPart<P extends AnyPart>(part: P, reg: Registry): P | null {
  const type = part.type;
  if (type === 'text' || type === 'step-start') return part;
  if (type === 'dynamic-tool') {
    return typeof part.toolName === 'string' ? projectToolPart(part, reg, part.toolName) : null;
  }
  if (type.startsWith('tool-')) {
    return projectToolPart(part, reg, type.slice('tool-'.length));
  }
  if (type.startsWith('data-')) {
    const projected = projectData(reg, type, part.data);
    return projected ? { ...part, data: projected.data } : null;
  }
  // reasoning, reasoning-file, source-url, source-document, file, custom, unknown
  return null;
}

type ProjectionMetadata = { hidden?: unknown; hiddenPartIndexes?: unknown };

/**
 * A stored message as every viewer sees it, or null when the whole message is
 * internal (`metadata.hidden`, or a system message). Parts listed in
 * `metadata.hiddenPartIndexes` are removed, and that key with them.
 */
export function projectMessage<M extends UIMessage<any, any, any>>(m: M, reg: Registry): M | null {
  if (m.role === 'system') return null;
  const meta =
    m.metadata && typeof m.metadata === 'object' ? (m.metadata as ProjectionMetadata) : undefined;
  if (meta?.hidden) return null;

  const hiddenIndexes = new Set<number>(
    Array.isArray(meta?.hiddenPartIndexes) ? (meta.hiddenPartIndexes as number[]) : []
  );
  const parts: M['parts'] = [];
  m.parts.forEach((part: AnyPart, i: number) => {
    if (hiddenIndexes.has(i)) return;
    const projected = projectPart(part, reg);
    if (projected) parts.push(projected as M['parts'][number]);
  });

  const out = { ...m, parts };
  if (meta && own(meta, 'hiddenPartIndexes')) {
    const { hiddenPartIndexes: _dropped, ...rest } = meta;
    out.metadata = rest as M['metadata'];
  }
  return out;
}

export function projectTranscript<M extends UIMessage<any, any, any>>(
  ms: readonly M[],
  reg: Registry
): M[] {
  const out: M[] = [];
  for (const m of ms) {
    const projected = projectMessage(m, reg);
    if (projected) out.push(projected);
  }
  return out;
}
