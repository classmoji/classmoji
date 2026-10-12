import { createContext, useContext } from 'react';

import type { SectionStats } from './useReaderSections.tsx';

/**
 * Unlock counts for the editor's locked-section chips ("Unlocked by X of Y").
 *
 * A context for the same reason `MediaDownloadContext` is one: BlockNote
 * portals every block render into the `BlockNoteView` tree, so a provider
 * above the view is what reaches the locked section's render. No provider, or
 * `stats: null` (the loader sends counts to OWNER/TEACHER only), means no chip.
 */
export interface SectionStatsValue {
  pageId: string;
  stats: SectionStats | null;
}

export const SectionStatsContext = createContext<SectionStatsValue>({ pageId: '', stats: null });

export function useSectionStats(): SectionStatsValue {
  return useContext(SectionStatsContext);
}
