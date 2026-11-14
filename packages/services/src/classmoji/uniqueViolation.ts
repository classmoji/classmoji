/**
 * What a Prisma unique violation (P2002) names, across client versions.
 *
 * Prisma 6's engine put it in `meta.target` (field names, or the constraint
 * name). Prisma 7 on a driver adapter puts it in
 * `meta.driverAdapterError.cause.constraint` instead: `{ fields: [...] }` or
 * `{ index: '<constraint name>' }`, with no `meta.target` at all. Callers
 * already treat a lone constraint name as one token, so either shape works.
 */
export function uniqueViolationTarget(error: unknown): unknown {
  const meta = (error as { meta?: Record<string, unknown> } | null)?.meta;
  if (!meta) return undefined;
  // `!= null`: a null target says nothing, so the adapter's constraint decides.
  if (meta.target != null) return meta.target;
  const constraint = (
    meta.driverAdapterError as { cause?: { constraint?: { fields?: unknown; index?: unknown } } }
  )?.cause?.constraint;
  return constraint?.fields ?? constraint?.index;
}
