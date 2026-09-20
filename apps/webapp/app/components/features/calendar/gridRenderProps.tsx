/**
 * The two seams the shared grids leave for their callers.
 *
 * `WeekGrid`, `MonthGrid` and `AllDayStrip` decide WHERE everything sits and
 * WHAT it looks like; they know nothing about dragging. The staff calendar
 * wraps each cell in a dnd-kit droppable and each block in a draggable by
 * passing these two render props, which is the whole reason `@dnd-kit` can stay
 * out of the student bundle. Left out, the defaults below render a plain div
 * with exactly the same geometry.
 */

import type { CSSProperties, ReactNode } from 'react';
import type { CalendarEventWithLinks } from './types';

export interface CalendarCellArgs {
  /**
   * The droppable id for this cell, from `geometry`'s builders
   * (`month-YYYY-MM-DD` / `week-YYYY-MM-DD-HH`). Present even when nothing is
   * droppable, so the producer and `parseDropId` can never drift apart.
   */
  dropId: string;
  date: Date;
  /** Week grid only: the cell's ABSOLUTE clock hour, never a row index. */
  hour?: number;
  /** Week grid only: which of the seven columns this is, 0-based. */
  dayIndex?: number;
  /** The grid's own classes — a caller adds to these, it does not replace them. */
  className: string;
  style?: CSSProperties;
  children?: ReactNode;
}

export type RenderCell = (args: CalendarCellArgs) => ReactNode;

export const defaultRenderCell: RenderCell = ({ className, style, children }) => (
  <div className={className} style={style}>
    {children}
  </div>
);

/** Where a block is being drawn, for callers that treat the three differently. */
export type EventPlacement = 'month' | 'allDay' | 'week';

export interface CalendarEventArgs {
  event: CalendarEventWithLinks;
  placement: EventPlacement;
  /** Positioning the grid owns: the week block's absolute top/height lives here. */
  className: string;
  style?: CSSProperties;
  /** The block itself — already a non-interactive container with a button inside. */
  children: ReactNode;
}

export type RenderEvent = (args: CalendarEventArgs) => ReactNode;

export const defaultRenderEvent: RenderEvent = ({ className, style, children }) => (
  <div className={className} style={style}>
    {children}
  </div>
);
