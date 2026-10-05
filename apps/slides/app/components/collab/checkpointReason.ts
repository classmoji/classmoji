/**
 * The short reason the header's "Not saved to GitHub yet" line gives, from
 * the checkpoint's stored outcome (`<code or status>: <detail>`, written by
 * the content checkpoint task). Never the raw worker text.
 */
const REASONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^outside-edit-pending\b/, 'The file changed on GitHub'],
  [
    /^(?:schema-mismatch|empty-render|dropped-content|short-columns|not-a-deck)\b/,
    "The deck couldn't be written as a file",
  ],
  [/^(?:unsafe-path|path-conflict)\b/, "The deck's file path isn't usable"],
  [/^doc-missing\b/, 'The deck was not found'],
  [/^(?:converter-unavailable|unknown-kind|skipped)\b/, 'Saving to GitHub is unavailable'],
  [
    /permission denied|\b40[13]\b|forbidden|bad credentials|not authorized|write access/i,
    'No write access to the repository',
  ],
];

export const DEFAULT_CHECKPOINT_REASON = "Couldn't save to GitHub";

export function checkpointErrorReason(error: string): string {
  const text = error.trim();
  for (const [pattern, reason] of REASONS) if (pattern.test(text)) return reason;
  return DEFAULT_CHECKPOINT_REASON;
}
