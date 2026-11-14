/**
 * The one serialization of a JSON payload into a result's text: every tool
 * result (`ok()`, `withImages`, whoami, billing), every resource read, and the
 * class-zone rewrite (`localizeToolResult`) go through it, so a mirror tool and
 * its resource stay byte-identical.
 *
 * Compact on purpose. Results are read by models, not people, and indentation
 * was about a quarter of a large list (#932): clients cap what they read
 * (Ask Moji at a fixed number of characters), so whitespace pushed real rows
 * past the cut.
 */
export function jsonText(payload: unknown): string {
  return JSON.stringify(payload);
}
