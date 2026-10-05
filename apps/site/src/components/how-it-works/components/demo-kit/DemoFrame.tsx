import React, { useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import type { DemoController } from '../../hooks/useDemoTimeline';
import type { DemoBase } from '../../types/demo';
import { ui } from '../../utils/classes';
import { STAGE } from '../../utils/timeline';
import { FakeCursor } from './FakeCursor';

type DemoFrameProps<S extends DemoBase> = {
  controller: DemoController<S>;
  /** The browser address bar text; unused when `bare`. */
  address?: string;
  /**
   * No browser window of its own: the demo draws its own windows (e.g. a
   * desktop app beside a browser) on a transparent stage.
   */
  bare?: boolean;
  label: string;
  rest?: { x: number; y: number };
  children: ReactNode;
};

export function DemoFrame<S extends DemoBase>({
  controller,
  address = '',
  bare = false,
  label,
  rest = { x: 0.82, y: 0.8 },
  children,
}: DemoFrameProps<S>) {
  const { state, mode, containerRef } = controller;
  const stageRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const update = () => setScale(el.clientWidth / STAGE.width);
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const showCursor = mode !== 'static';

  return (
    <figure
      ref={containerRef}
      className={
        bare
          ? 'relative'
          : 'overflow-hidden rounded-2xl bg-panel shadow-[0_1px_2px_rgba(20,10,40,0.04),0_18px_40px_-22px_rgba(20,25,50,0.28)] ring-1 ring-edge dark:bg-panel-dark dark:shadow-[0_18px_40px_-20px_rgba(0,0,0,0.7)] dark:ring-edge-dark'
      }
    >
      <figcaption className="sr-only">{label}</figcaption>
      {!bare && (
        <div
          className={`grid h-10 grid-cols-[1fr_auto_1fr] items-center gap-3 border-b px-3.5 ${ui.divider}`}
        >
          <div className="flex gap-1.5" aria-hidden>
            <span className="h-2.5 w-2.5 rounded-full bg-stone-200 dark:bg-line-2-dark" />
            <span className="h-2.5 w-2.5 rounded-full bg-stone-200 dark:bg-line-2-dark" />
            <span className="h-2.5 w-2.5 rounded-full bg-stone-200 dark:bg-line-2-dark" />
          </div>
          <div
            className={`max-w-[190px] truncate rounded-md bg-app px-3 py-0.5 text-center text-[11px] ring-1 ring-edge dark:bg-app-dark dark:ring-edge-dark sm:max-w-none ${ui.ink3}`}
          >
            {address}
          </div>
          <div aria-hidden />
        </div>
      )}
      <div
        ref={stageRef}
        inert
        className={`pointer-events-none relative aspect-[14/9] w-full ${bare ? 'overflow-visible' : `overflow-hidden ${ui.app}`}`}
      >
        <div
          ref={innerRef}
          className="absolute left-0 top-0 origin-top-left"
          style={{ width: STAGE.width, height: STAGE.height, transform: `scale(${scale})` }}
        >
          {children}
          {showCursor && (
            <FakeCursor
              innerRef={innerRef}
              scale={scale}
              target={state.cursor}
              click={state.click}
              rest={rest}
              stateKey={state}
            />
          )}
        </div>
      </div>
    </figure>
  );
}
