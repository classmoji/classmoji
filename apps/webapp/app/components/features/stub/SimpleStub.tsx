import type { ReactNode } from 'react';

/**
 * SimpleStub — placeholder screen used for routes whose real implementation
 * lands in a later phase of the redesign. Mirrors the design-bundle
 * `SimpleStub` function in `classmoji/project/components/screens.jsx`.
 */
export interface SimpleStubProps {
  title: string;
  body: ReactNode;
}

export function SimpleStub({ title, body }: SimpleStubProps) {
  return (
    <div className="flex flex-col gap-3.5">
      <h1 className="display m-0 text-[28px] font-medium tracking-[-0.4px] text-ink-1">{title}</h1>
      <div className="panel">
        <div className="panel-body text-[13.5px] leading-[1.6] text-ink-2">{body}</div>
      </div>
    </div>
  );
}
