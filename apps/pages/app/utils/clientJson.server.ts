import { markReported } from '@classmoji/utils/error-report';

/**
 * `JSON.parse` of text the client posted. A parse failure is the client's
 * input, not a fault, and its message quotes that input: it is thrown exactly
 * as `JSON.parse` throws it (the caller answers as before) but marked so that
 * no error report sends it.
 */
// Typed as `JSON.parse` is, so a call site reads exactly as it did before.
export function parseClientJson(text: string): ReturnType<typeof JSON.parse> {
  try {
    return JSON.parse(text);
  } catch (error) {
    markReported(error);
    throw error;
  }
}
