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
 * (`boundIssues`), and a parse that throws is a refusal too, logged as one
 * line naming `label` and the error's class (never the ops or the error's
 * text, which can quote them).
 */
export function parseOpsPayload<T>(
  schema: SafeParser<T>,
  raw: unknown,
  label: string
): { success: true; data: T } | { success: false; issues: Issues } {
  try {
    const parsed = schema.safeParse(raw);
    if (parsed.success) return { success: true, data: parsed.data };
    return { success: false, issues: boundIssues(parsed.error.issues) };
  } catch (error: unknown) {
    console.warn(
      `[collab] ${label} check threw:`,
      error instanceof Error ? error.name : typeof error
    );
    return {
      success: false,
      issues: [{ code: 'custom', path: [], message: 'The ops could not be checked' }],
    };
  }
}
