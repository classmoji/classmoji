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
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <h1
        className="display"
        style={{ margin: 0, fontSize: 28, fontWeight: 500, letterSpacing: -0.4 }}
      >
        {title}
      </h1>
      <div
        className="card"
        style={{ padding: 24, color: 'var(--ink-2)', fontSize: 13.5, lineHeight: 1.6 }}
      >
        {body}
      </div>
    </div>
  );
}
