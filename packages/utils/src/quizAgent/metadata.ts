/**
 * Quiz message metadata: which keys a viewer receives, and which the server
 * keeps for itself.
 *
 * Viewers (an allow-list, applied after the projection): `action` on a user
 * row (the button a student's text named), which the chat reads to rebuild
 * the Next/Try again state on reload and MCP's transcript reports. Nothing
 * else: the projection consumes `hidden` and `hiddenPartIndexes` before this
 * runs.
 *
 * Server-only (`QUIZ_SERVER_METADATA_KEYS`): `usage` on an assistant row, the
 * turn's model usage (the Ask Moji usage shape, `AskMojiUsageSchema`). Also
 * cut from the raw rows the attempt reads return.
 *
 * No server imports: this module reaches the client bundle.
 */

/** The metadata keys a viewer may receive on a projected quiz message. */
export const QUIZ_VIEWER_METADATA_KEYS = ['action'] as const;

/** Keys only the server reads. Never sent to a browser or an MCP client. */
export const QUIZ_SERVER_METADATA_KEYS = ['usage'] as const;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A projected message with only the viewer keys of its metadata
 * (`QUIZ_VIEWER_METADATA_KEYS`), and no metadata at all when none is left.
 */
export function withViewerMetadata<M extends { metadata?: unknown }>(m: M): M {
  const { metadata, ...rest } = m;
  if (!isRecord(metadata)) return rest as M;
  const kept: Record<string, unknown> = {};
  for (const key of QUIZ_VIEWER_METADATA_KEYS) {
    if (metadata[key] !== undefined) kept[key] = metadata[key];
  }
  return (Object.keys(kept).length > 0 ? { ...rest, metadata: kept } : rest) as M;
}

/**
 * Stored metadata without its server-only keys (`QUIZ_SERVER_METADATA_KEYS`):
 * the same value when it has none, null when nothing else is left.
 */
export function withoutServerMetadataKeys<T>(metadata: T): T | null {
  if (!isRecord(metadata)) return metadata;
  if (!QUIZ_SERVER_METADATA_KEYS.some(k => k in metadata)) return metadata;
  const kept: Record<string, unknown> = { ...metadata };
  for (const key of QUIZ_SERVER_METADATA_KEYS) delete kept[key];
  return Object.keys(kept).length > 0 ? (kept as T) : null;
}
