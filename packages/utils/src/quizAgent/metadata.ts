/**
 * Quiz message metadata the server keeps for itself. A stored assistant row
 * carries `usage` (the turn's model usage, the Ask Moji usage shape,
 * `AskMojiUsageSchema`); no viewer ever receives it, live or stored. Every
 * other key (`action` on a user row; `hidden` and `hiddenPartIndexes`, which
 * the projection consumes) is left as it is.
 *
 * No server imports: this module reaches the client bundle.
 */

/** Keys only the server reads. Never sent to a browser or an MCP client. */
export const QUIZ_SERVER_METADATA_KEYS = ['usage'] as const;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * A message without its server-only metadata keys: the message itself when it
 * has none, its metadata dropped when nothing else is left in it.
 */
export function withoutServerMetadata<M extends { metadata?: unknown }>(m: M): M {
  if (!isRecord(m.metadata)) return m;
  if (!QUIZ_SERVER_METADATA_KEYS.some(k => k in (m.metadata as object))) return m;
  const kept: Record<string, unknown> = { ...m.metadata };
  for (const key of QUIZ_SERVER_METADATA_KEYS) delete kept[key];
  const { metadata: _all, ...rest } = m;
  return (Object.keys(kept).length > 0 ? { ...rest, metadata: kept } : rest) as M;
}
