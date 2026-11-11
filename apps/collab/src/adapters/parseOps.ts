import { boundIssues } from '@classmoji/utils/input-caps';

type Issues = Parameters<typeof boundIssues>[0];

interface SafeParser<T> {
  safeParse(
    raw: unknown
  ): { success: true; data: T } | { success: false; error: { issues: Issues } };
}

/**
 * An ops payload parsed with its service schema, for `/internal/.../ops`.
 * A refusal carries at most the first issues, each cut short
 * (`boundIssues`), and a parse that throws is a refusal too.
 */
export function parseOpsPayload<T>(
  schema: SafeParser<T>,
  raw: unknown
): { success: true; data: T } | { success: false; issues: Issues } {
  try {
    const parsed = schema.safeParse(raw);
    if (parsed.success) return { success: true, data: parsed.data };
    return { success: false, issues: boundIssues(parsed.error.issues) };
  } catch {
    return {
      success: false,
      issues: [{ code: 'custom', path: [], message: 'The ops could not be checked' }],
    };
  }
}
