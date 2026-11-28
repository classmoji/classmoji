/**
 * An asymmetric matcher for one exact object: `toBe` inside `toEqual` and
 * `toHaveBeenCalledWith`. `toEqual` alone finds any two `Request`s equal (they
 * have no own enumerable fields), so a test that the audit funnel was handed
 * the route's own request (the key its gate's session read is remembered by)
 * needs identity.
 */
export const sameObject = <T>(expected: T) => ({
  asymmetricMatch: (actual: unknown) => actual === expected,
  toString: () => 'SameObject',
  toAsymmetricMatcher: () => 'SameObject',
});
