/**
 * Reading the ops of an editor's ops save (the page action, `intent: 'save'`
 * with `ops`). Kept out of the route so it can be tested without the
 * database the route needs.
 */
import { DOCUMENT_SAVE_MAX_BYTES } from '@classmoji/utils/repo-limits';
import { parseJsonWithin } from '@classmoji/utils/upload-limit';

/**
 * The answer to ops that cannot be read. Its `code` makes the editor fall back
 * to ONE whole-document save, which needs no base to replay against.
 */
export const OPS_MALFORMED_ANSWER = {
  error: 'Malformed ops payload — retrying as a full-document save',
  code: 'OPS_MALFORMED',
} as const;

/** The part of a zod schema this needs (zod 3 and zod 4 both fit). */
type OpsSchema<T> = { safeParse(value: unknown): { success: boolean; data?: T } };

/**
 * The ops the editor posted, or null when they cannot be read: JSON text over
 * `DOCUMENT_SAVE_MAX_BYTES` (refused before it is parsed), text that is not
 * JSON, ops the schema refuses, or a schema check that throws.
 *
 * The editor posts the ops as JSON text. Ops sent as an array were parsed with
 * the request body, which the route bounds.
 */
export function readSaveOps<T>(raw: unknown, schema: OpsSchema<T>): T | null {
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try {
      value = parseJsonWithin(raw, DOCUMENT_SAVE_MAX_BYTES);
    } catch {
      return null;
    }
  }
  try {
    const parsed = schema.safeParse(value);
    return parsed.success ? (parsed.data as T) : null;
  } catch {
    return null;
  }
}

/**
 * The ops of an ops save, read with `readSaveOps` and then passed through
 * `canonicalize` (the route's asset pass), or null when either step fails. A
 * pass that throws is answered like ops that cannot be read, so the editor
 * falls back to one whole-document save.
 */
export async function readCanonicalSaveOps<T>(
  raw: unknown,
  schema: OpsSchema<T>,
  canonicalize: (ops: T) => Promise<T>
): Promise<T | null> {
  const ops = readSaveOps(raw, schema);
  if (ops === null) return null;
  try {
    return await canonicalize(ops);
  } catch (error: unknown) {
    logOpsRefusal(error);
    return null;
  }
}

/**
 * One line for ops refused because reading them threw: where, and the error's
 * class. Never the ops, and never the error's text, which can quote them.
 */
function logOpsRefusal(error: unknown): void {
  console.warn(
    '[pages] page save: ops refused:',
    error instanceof Error ? error.name : typeof error
  );
}
