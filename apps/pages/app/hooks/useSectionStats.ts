import { createContext, useContext } from 'react';

import type { SectionStats } from './useReaderSections.tsx';

/**
 * Counts for the editor's chips: "Unlocked by X of Y" on locked sections,
 * "Done by X of Y" on checkable headings.
 *
 * A context for the same reason `MediaDownloadContext` is one: BlockNote
 * portals every block render into the `BlockNoteView` tree, so a provider
 * above the view is what reaches the locked section's render (and the
 * heading chips' host, `DoneChips`). No provider, or `stats: null` (the
 * loader sends counts to OWNER/TEACHER only), means no chip.
 */
export interface SectionStatsValue {
  pageId: string;
  stats: SectionStats | null;
}

export const SectionStatsContext = createContext<SectionStatsValue>({ pageId: '', stats: null });

export function useSectionStats(): SectionStatsValue {
  return useContext(SectionStatsContext);
}
