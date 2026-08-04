/**
 * conflictChooser.ts — pure helpers for the side-by-side preview-conflict
 * chooser (plan §3b Phase 7).
 *
 * No JSX/React imports here: PreviewControls renders these, and the Playwright
 * runner unit-tests them directly (tests/unit/conflict-chooser.spec.ts)
 * without a browser.
 */

/** A per-conflict choice: `ours` = the live (main) side, `theirs` = the preview side. */
export type MergeChoice = 'ours' | 'theirs';

/** One chooser decision, keyed by the conflict id from the accept report. */
export interface MergeResolution {
  id: string;
  choose: MergeChoice;
}

/** Sentinel unit id for a top-level ordering conflict (service twin). */
export const ORDER_CONFLICT_ID = '__order__';

/**
 * One conflicted unit from the accept 409 payload (the service's
 * BlockMergeConflict shape). Absent ours/theirs = deleted on that side; the
 * `__order__` sentinel carries id arrays instead of blocks.
 */
export interface ConflictUnit {
  id: string;
  index: number;
  reason?: 'content' | 'delete_vs_edit' | 'both_added' | 'order' | string;
  ours?: unknown;
  theirs?: unknown;
  base?: unknown;
}

const REASON_LABELS: Record<string, string> = {
  content: 'Edited in both versions',
  delete_vs_edit: 'Deleted in one version, edited in the other',
  both_added: 'Added in both versions',
  order: 'Blocks reordered differently in both versions',
};

/** Human label for a conflict reason (fallback for future reasons). */
export function reasonLabel(reason: string | undefined): string {
  return (reason && REASON_LABELS[reason]) || 'Changed in both versions';
}

/** Readable structural summary of a BlockNote block — never mounts an editor. */
export interface BlockSummary {
  type: string;
  text: string;
  childCount: number;
}

interface InlineNode {
  type?: string;
  text?: string;
  content?: unknown;
}

/** Flatten BlockNote inline content (styled text, links, table rows) to plain text. */
function inlineText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(node => {
        const inline = node as InlineNode;
        if (typeof inline.text === 'string') return inline.text;
        if (inline.content !== undefined) return inlineText(inline.content);
        return '';
      })
      .join('');
  }
  // Table content: { type: 'tableContent', rows: [{ cells: [...] }] }
  const rows = (content as { rows?: { cells?: unknown[] }[] } | null | undefined)?.rows;
  if (Array.isArray(rows)) {
    return rows
      .map(row => (Array.isArray(row?.cells) ? row.cells.map(inlineText).join(' · ') : ''))
      .join('\n');
  }
  return '';
}

/** Summarize a block side for the chooser card (type badge + text + child count). */
export function blockSummary(block: unknown): BlockSummary {
  const node = (block ?? {}) as { type?: unknown; content?: unknown; children?: unknown };
  return {
    type: typeof node.type === 'string' ? node.type : 'block',
    text: inlineText(node.content).trim(),
    childCount: Array.isArray(node.children) ? node.children.length : 0,
  };
}

// ─── Chooser copy variants (preview accepts vs editor saves, Phase 7.5) ──────

/**
 * Which flow mounted the chooser. `preview` = a preview-branch accept
 * (ours = the live page, theirs = the agent's preview). `save` = an editor
 * save whose conflict token was stale (ours = what's saved on the server,
 * theirs = the editor's unsaved version) — same machinery, flipped framing.
 */
export type ChooserVariant = 'preview' | 'save';

export interface ChooserCopy {
  heading: string;
  sideTitle: Record<MergeChoice, string>;
  sideAction: Record<MergeChoice, string>;
  tombstone: Record<MergeChoice, string>;
  /** Label of the escape-hatch button (discard the preview / reload latest). */
  secondaryAction: string;
  /** Trailing footer sentence after the apply hint. */
  footerNote: string;
  /** Progress-strip copy while the apply submit is in flight. */
  busyLabel: string;
}

const CHOOSER_COPY: Record<ChooserVariant, ChooserCopy> = {
  preview: {
    heading: 'Changes conflict with edits made on the live page',
    sideTitle: { ours: 'Live version (yours)', theirs: "Preview version (agent's)" },
    sideAction: { ours: 'Keep live', theirs: 'Take preview' },
    tombstone: { ours: 'Deleted in the live version', theirs: 'Deleted in the preview' },
    secondaryAction: 'Discard preview',
    footerNote: 'Or re-apply from the current version (via your agent).',
    busyLabel: 'Publishing your choices — this can take a few seconds…',
  },
  save: {
    heading: 'Your save collided with changes saved by someone else',
    sideTitle: { ours: 'Saved on the server', theirs: 'Your unsaved version' },
    sideAction: { ours: "Keep server's", theirs: 'Keep yours' },
    tombstone: { ours: 'Deleted on the server', theirs: 'Deleted in your version' },
    secondaryAction: 'Reload latest',
    footerNote: 'Or reload the latest version and discard your unsaved changes.',
    busyLabel: 'Saving the merged version — this can take a few seconds…',
  },
};

/** The chooser's variant-dependent labels. */
export function chooserCopy(variant: ChooserVariant): ChooserCopy {
  return CHOOSER_COPY[variant];
}

/** The subtitle under the heading (mentions the auto-merged count when > 0). */
export function chooserSubtitle(variant: ChooserVariant, autoMerged: number): string {
  if (autoMerged <= 0) return 'Choose which version to keep for each conflict:';
  const merged = `${autoMerged} change${autoMerged === 1 ? '' : 's'} merged automatically`;
  return variant === 'save' ? `${merged}; choose per block:` : `${merged}; these need you:`;
}

/** The conflict ids that must each carry a choice before Apply enables. */
export function conflictIds(units: ConflictUnit[]): string[] {
  return units.map(unit => unit.id);
}

/** true when every listed conflict id has an ours/theirs choice. */
export function allResolved(ids: string[], choices: Record<string, MergeChoice>): boolean {
  return ids.length > 0 && ids.every(id => choices[id] === 'ours' || choices[id] === 'theirs');
}

/** Build the resolutions payload the accept intent posts (one entry per id). */
export function buildResolutions(
  ids: string[],
  choices: Record<string, MergeChoice>
): MergeResolution[] {
  return ids.map(id => ({ id, choose: choices[id] }));
}
