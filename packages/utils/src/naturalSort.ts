// `numeric` so a2 precedes a10; `sensitivity: 'base'` so `Group-A1` and
// `group-a8` sort in one run. Built once — constructing it is the costly part.
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** Compare two strings in human order. Missing values sort last. */
export const compareNatural = (
  a: string | null | undefined,
  b: string | null | undefined
): number => {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return collator.compare(a, b);
};

/** The same comparison, reading a key off each item, for `array.sort()`. */
export const sortNaturallyBy =
  <T>(key: (item: T) => string | null | undefined) =>
  (a: T, b: T): number =>
    compareNatural(key(a), key(b));
