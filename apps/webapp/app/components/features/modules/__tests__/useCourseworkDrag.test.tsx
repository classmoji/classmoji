// @vitest-environment jsdom
/**
 * The Modules page's coursework drag after the move comes back, MOUNTED in
 * jsdom with a harness component around the hook.
 *
 * A dropped row shows in its new module until the loader agrees. A refused
 * move never will, so the row goes back to where the server has it. A refusal
 * is watched by identity: one from an earlier move, still held when the next
 * drop lands, does not undo that one.
 */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCourseworkDrag, type CourseworkList, type CourseworkMove } from '../useCourseworkDrag';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Drag = ReturnType<typeof useCourseworkDrag>;
type Result = { success?: string; error?: string };

const FAILED: Result = { error: 'Failed to move the assignment. Please try again.' };

// Week 1 holds two assignments, Week 2 one; a-1 is dragged into Week 2.
const LISTS: CourseworkList[] = [
  { id: 'm-1', content: [], assignments: [{ id: 'a-1' }, { id: 'a-2' }] },
  { id: 'm-2', content: [], assignments: [{ id: 'a-3' }] },
];
const MOVED: CourseworkList[] = [
  { id: 'm-1', content: [], assignments: [{ id: 'a-2' }] },
  { id: 'm-2', content: [], assignments: [{ id: 'a-3' }, { id: 'a-1' }] },
];

let latest: Drag;
let root: Root;
let container: HTMLDivElement;
const onMove = vi.fn<(move: CourseworkMove) => void>();

const Harness = ({ lists, result }: { lists: CourseworkList[]; result?: Result }) => {
  latest = useCourseworkDrag({ lists, onMove, result });
  return null;
};

const render = (lists: CourseworkList[], result?: Result) =>
  act(() => root.render(<Harness lists={lists} result={result} />));

const assignmentIds = (moduleId: string) =>
  latest.forModule(moduleId).assignments.items.map(row => row.id);

/** Drag a-1 out of Week 1 and drop it on Week 2's card: it joins the end. */
const dropIntoWeek2 = async () => {
  const dragStart = latest.forModule('m-1').assignments.rowProps('a-1')?.onDragStart as (
    e: unknown
  ) => void;
  await act(() =>
    dragStart({
      stopPropagation: () => {},
      dataTransfer: { effectAllowed: '', setData: () => {} },
    })
  );
  const drop = latest.forModule('m-2').cardProps?.onDrop as (e: unknown) => void;
  await act(() => drop({ preventDefault: () => {}, stopPropagation: () => {} }));
};

beforeEach(() => {
  onMove.mockReset();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('useCourseworkDrag — a move that comes back', () => {
  it('shows the dropped row in its new module while the move is out', async () => {
    await render(LISTS);
    await dropIntoWeek2();

    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onMove).toHaveBeenCalledWith({
      scope: 'assignment',
      rowId: 'a-1',
      fromModuleId: 'm-1',
      toModuleId: 'm-2',
      orderedIds: ['a-3', 'a-1'],
    });
    expect(assignmentIds('m-1')).toEqual(['a-2']);
    expect(assignmentIds('m-2')).toEqual(['a-3', 'a-1']);
  });

  it('puts the row back where the server has it when the move is refused', async () => {
    await render(LISTS);
    await dropIntoWeek2();

    await render(LISTS, FAILED);

    expect(assignmentIds('m-1')).toEqual(['a-1', 'a-2']);
    expect(assignmentIds('m-2')).toEqual(['a-3']);
  });

  it('keeps showing a later move while an earlier refusal is still held', async () => {
    await render(LISTS);
    await dropIntoWeek2();
    await render(LISTS, FAILED);

    await dropIntoWeek2();
    await render(LISTS, FAILED);

    expect(onMove).toHaveBeenCalledTimes(2);
    expect(assignmentIds('m-1')).toEqual(['a-2']);
    expect(assignmentIds('m-2')).toEqual(['a-3', 'a-1']);

    // Once the loader agrees, nothing is overridden any more: a later change
    // on the server shows as it is.
    await render(MOVED, { success: 'Assignment moved' });
    await render(LISTS, { success: 'Assignment moved' });

    expect(assignmentIds('m-1')).toEqual(['a-1', 'a-2']);
    expect(assignmentIds('m-2')).toEqual(['a-3']);
  });
});
