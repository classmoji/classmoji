/** A `?from=` value is only honoured when it is a path inside this app. */
export const safeReturn = (from: string | null, fallback: string) =>
  from && from.startsWith('/') && !from.startsWith('//') && !from.startsWith('/\\')
    ? from
    : fallback;
