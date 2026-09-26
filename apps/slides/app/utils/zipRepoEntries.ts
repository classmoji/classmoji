/**
 * zipRepoEntries.ts — which entries of an imported ZIP the course repository
 * can take.
 *
 * The slides.com import commits everything it keeps in ONE `uploadBatch`, and
 * GitHub refuses a single file over the REST ceiling by refusing the whole
 * commit. So each entry is measured as it is read, and one over
 * `REPO_REST_MAX_BYTES` is left out with a warning that names it, instead of
 * taking the import down with it.
 *
 * Its own module, with nothing but JSZip's types and the shared limit, so the
 * rule can be unit tested without the importer's database and GitHub imports.
 */

import type JSZip from 'jszip';
import { REPO_REST_MAX_BYTES, repoFileSkippedWarning } from '@classmoji/utils/repo-limits';

export class RepoEntryGate {
  /** One sentence per entry left out, in the order they were met. */
  readonly warnings: string[] = [];

  /** True when `bytes` fit; otherwise records the warning for `name`. */
  admit(name: string, bytes: number): boolean {
    if (bytes <= REPO_REST_MAX_BYTES) return true;
    this.warnings.push(repoFileSkippedWarning(name, bytes));
    return false;
  }

  /** The entry's bytes when they fit, or null (with a warning) when not. */
  async read(entry: JSZip.JSZipObject, name: string): Promise<Buffer | null> {
    const buffer = await entry.async('nodebuffer');
    return this.admit(name, buffer.length) ? buffer : null;
  }
}
