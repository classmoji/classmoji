// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import useStore from '~/store';
import { useAskMojiAttempt, useAskMojiViewing, useHideAskMoji, viewingLabel } from '../viewing';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  useStore.setState({ askMojiViewing: null, askMojiViewingStack: [], askMojiHideCount: 0 });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function Publisher({
  children,
  ...props
}: {
  kind: 'page' | 'module';
  id: string;
  title?: string;
  children?: React.ReactNode;
}) {
  useAskMojiViewing(props);
  return <>{children}</>;
}

function Attempt(props: { readOnly: boolean; viewerOwnsAttempt: boolean }) {
  useAskMojiAttempt({ quizId: 'q1', quizName: 'Quiz 1', ...props });
  return null;
}

function Hider({ hide }: { hide: boolean }) {
  useHideAskMoji(hide);
  return null;
}

describe('useAskMojiViewing', () => {
  it('publishes while mounted and clears on unmount', () => {
    act(() => root.render(<Publisher kind="page" id="p1" title="Week 1" />));
    expect(useStore.getState().askMojiViewing).toMatchObject({
      kind: 'page',
      id: 'p1',
      title: 'Week 1',
    });
    act(() => root.render(<Publisher kind="page" id="p2" title="Week 2" />));
    expect(useStore.getState().askMojiViewing).toMatchObject({ id: 'p2' });
    act(() => root.render(<></>));
    expect(useStore.getState().askMojiViewing).toBeNull();
  });

  it('one publisher’s cleanup never clears another’s value', () => {
    act(() =>
      root.render(
        <>
          <Publisher kind="module" id="m1" />
          <Publisher kind="page" id="p1" />
        </>
      )
    );
    expect(useStore.getState().askMojiViewing).toMatchObject({ kind: 'page', id: 'p1' });
    act(() => root.render(<Publisher kind="page" id="p1" />));
    expect(useStore.getState().askMojiViewing).toMatchObject({ kind: 'page', id: 'p1' });
  });

  it('a drawer over a page: closing the drawer restores the page’s viewing, not nothing', () => {
    act(() => root.render(<Publisher kind="module" id="m1" title="Week 1" />));
    act(() =>
      root.render(
        <Publisher kind="module" id="m1" title="Week 1">
          <Publisher kind="page" id="p1" title="Reading" />
        </Publisher>
      )
    );
    expect(useStore.getState().askMojiViewing).toMatchObject({ kind: 'page', id: 'p1' });
    act(() => root.render(<Publisher kind="module" id="m1" title="Week 1" />));
    expect(useStore.getState().askMojiViewing).toMatchObject({ kind: 'module', id: 'm1' });
    expect(useStore.getState().askMojiViewingStack).toHaveLength(1);
  });

  it('a page and its drawer mounting together (a direct link) put the drawer on top', () => {
    act(() =>
      root.render(
        <Publisher kind="module" id="m1">
          <Publisher kind="page" id="p1" />
        </Publisher>
      )
    );
    expect(useStore.getState().askMojiViewing).toMatchObject({ kind: 'page', id: 'p1' });
    act(() => root.render(<Publisher kind="module" id="m1" />));
    expect(useStore.getState().askMojiViewing).toMatchObject({ kind: 'module', id: 'm1' });
  });

  it('a publisher whose viewing changes keeps its place under a drawer', () => {
    act(() =>
      root.render(
        <Publisher kind="module" id="m1">
          <Publisher kind="page" id="p1" />
        </Publisher>
      )
    );
    act(() =>
      root.render(
        <Publisher kind="module" id="m2">
          <Publisher kind="page" id="p1" />
        </Publisher>
      )
    );
    expect(useStore.getState().askMojiViewing).toMatchObject({ kind: 'page', id: 'p1' });
    act(() => root.render(<Publisher kind="module" id="m2" />));
    expect(useStore.getState().askMojiViewing).toMatchObject({ kind: 'module', id: 'm2' });
  });

  it('labels: the title, else the kind; a deck adds its slide', () => {
    expect(viewingLabel({ kind: 'page', title: 'Syllabus' })).toBe('Syllabus');
    expect(viewingLabel({ kind: 'calendar' })).toBe('the calendar');
    expect(viewingLabel({ kind: 'deck', slide: 2 })).toBe('these slides, slide 3');
  });
});

describe('quiz attempts', () => {
  function Results({ drawer }: { drawer: boolean }) {
    useAskMojiViewing({ kind: 'quiz', id: 'q1', title: 'Quiz 1' });
    return drawer ? <Attempt readOnly viewerOwnsAttempt={false} /> : null;
  }

  it('closing the attempt drawer on the results page keeps the quiz as what is open', () => {
    act(() => root.render(<Results drawer={false} />));
    act(() => root.render(<Results drawer />));
    expect(useStore.getState().askMojiViewingStack).toHaveLength(2);
    act(() => root.render(<Results drawer={false} />));
    expect(useStore.getState().askMojiViewing).toMatchObject({ kind: 'quiz', id: 'q1' });
    expect(useStore.getState().askMojiViewingStack).toHaveLength(1);
  });

  it('hides Ask Moji on the owner’s live attempt', () => {
    act(() => root.render(<Attempt readOnly={false} viewerOwnsAttempt />));
    expect(useStore.getState().askMojiHideCount).toBe(1);
    expect(useStore.getState().askMojiViewing).toBeNull();
    act(() => root.render(<></>));
    expect(useStore.getState().askMojiHideCount).toBe(0);
  });

  it('does not hide it for staff reading a student’s live attempt', () => {
    act(() => root.render(<Attempt readOnly={false} viewerOwnsAttempt={false} />));
    expect(useStore.getState().askMojiHideCount).toBe(0);
    expect(useStore.getState().askMojiViewing).toBeNull();
  });

  it('a completed attempt is viewing the quiz, for owner and staff alike', () => {
    act(() => root.render(<Attempt readOnly viewerOwnsAttempt />));
    expect(useStore.getState().askMojiHideCount).toBe(0);
    expect(useStore.getState().askMojiViewing).toMatchObject({
      kind: 'quiz',
      id: 'q1',
      title: 'Quiz 1',
    });
  });

  it('hides are counted, so two hiders need two unmounts', () => {
    act(() =>
      root.render(
        <>
          <Hider hide />
          <Hider hide />
        </>
      )
    );
    expect(useStore.getState().askMojiHideCount).toBe(2);
    act(() => root.render(<Hider hide />));
    expect(useStore.getState().askMojiHideCount).toBe(1);
    act(() => root.render(<Hider hide={false} />));
    expect(useStore.getState().askMojiHideCount).toBe(0);
  });
});
