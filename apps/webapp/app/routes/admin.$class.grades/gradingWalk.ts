/**
 * The gradebook's grading walk: the order the submission panel's Previous and
 * "Next to grade" follow. Pure, so the table and the panel read one answer.
 *
 * The order runs down each visible repo column in turn (column-major), rows in
 * the table's current order. A team submission shows on every member's row but
 * is one cell here, at its first row. A cell is to grade when it was submitted
 * and has no grade yet, or has an open regrade request.
 *
 * Next and Previous are taken from the current cell's place in the whole
 * order, not from the queue alone: grading the current cell drops it out of
 * the queue, and Next must still go on from where it stood.
 *
 * While the panel is open the order is frozen (`freezeWalk`): grading a cell
 * re-sorts the table (by Total, or by that column) and can drop its row from
 * the filter, and a walk rebuilt from the table would then skip cells.
 */

export interface WalkCell {
  submissionId: string;
  assignmentId: string;
  rowId: string;
  /** To grade now. */
  needsGrading: boolean;
  /** Was to grade when the walk was frozen: still counted in "N of M". */
  inWalk?: boolean;
}

/** What the gradebook hands its submission panel (the child route's outlet context). */
export interface SubmissionPanelOutletContext {
  /** The walk over the table as shown now (view, columns, search, filter, sort). */
  walk: WalkCell[];
  /** The classroom's scale (emoji → grade): the panel picker's options. */
  emojiMappings: Record<string, number>;
  /** The gradebook's URL, its search params kept: where closing the panel goes. */
  gradesHref: string;
  /** The panel's URL for a submission, the gradebook's search params kept. */
  panelHref: (submissionId: string) => string;
}

/** What a row holds in one column: its submission and whether it is to grade. */
export interface WalkCellInput {
  submissionId: string;
  needsGrading: boolean;
}

export const walkOrder = <Row extends { id: string }>(
  rows: readonly Row[],
  columnIds: readonly string[],
  cellOf: (row: Row, assignmentId: string) => WalkCellInput | null | undefined
): WalkCell[] => {
  const seen = new Set<string>();
  const order: WalkCell[] = [];
  for (const assignmentId of columnIds) {
    for (const row of rows) {
      const cell = cellOf(row, assignmentId);
      if (!cell || seen.has(cell.submissionId)) continue;
      seen.add(cell.submissionId);
      order.push({ ...cell, assignmentId, rowId: row.id });
    }
  }
  return order;
};

export interface WalkPosition {
  /** 1-based place in the queue; null when the open submission is not to grade. */
  index: number | null;
  /** Cells the walk set out to grade, plus any to grade now. */
  total: number;
  /** Cells to grade now, the open one included. */
  left: number;
  next: WalkCell | null;
  previous: WalkCell | null;
}

/**
 * A frozen walk read against the gradebook now: the snapshot's order, with
 * each cell's to-grade state looked up by submission id (false once it is
 * gone), and `inWalk` from the snapshot.
 */
export const freezeWalk = (
  snapshot: readonly WalkCell[],
  needsGradingNow: ReadonlyMap<string, boolean>
): WalkCell[] =>
  snapshot.map(c => ({
    ...c,
    needsGrading: needsGradingNow.get(c.submissionId) ?? false,
    inWalk: c.inWalk ?? c.needsGrading,
  }));

export const walkPosition = (
  order: readonly WalkCell[],
  currentId: string | null | undefined
): WalkPosition => {
  // "N of M" counts what the walk set out to grade, and what came up since.
  const queue = order.filter(c => c.needsGrading || c.inWalk);
  const at = currentId ? order.findIndex(c => c.submissionId === currentId) : -1;
  const queueIndex = currentId ? queue.findIndex(c => c.submissionId === currentId) : -1;
  const others = (c: WalkCell) => c.needsGrading && c.submissionId !== currentId;
  const toGrade = order.filter(c => c.needsGrading);

  let next: WalkCell | null = null;
  let previous: WalkCell | null = null;
  if (at === -1) {
    // Not in the walk (filtered out, or not a repo cell): start at either end.
    next = toGrade.find(others) ?? null;
    previous = [...toGrade].reverse().find(others) ?? null;
  } else {
    // Wrap around once, so the walk never dead-ends while cells are left.
    const after = [...order.slice(at + 1), ...order.slice(0, at)];
    next = after.find(others) ?? null;
    previous = [...after].reverse().find(others) ?? null;
  }

  return {
    index: queueIndex === -1 ? null : queueIndex + 1,
    total: queue.length,
    // Every cell still to grade, the open one included.
    left: toGrade.length,
    next,
    previous,
  };
};

/** The first cell to grade in one column, for its header's Start. */
export const firstInColumn = (order: readonly WalkCell[], assignmentId: string): WalkCell | null =>
  order.find(c => c.needsGrading && c.assignmentId === assignmentId) ?? null;

/** Cells to grade per column, each submission once. */
export const pendingByColumn = (order: readonly WalkCell[]): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const c of order) {
    if (c.needsGrading) counts.set(c.assignmentId, (counts.get(c.assignmentId) ?? 0) + 1);
  }
  return counts;
};
