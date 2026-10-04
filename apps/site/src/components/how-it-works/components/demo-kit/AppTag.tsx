import React from 'react';
import type { ReactNode } from 'react';
import { Tag } from 'antd';
import { AppAntd } from './AppAntd';

/** The webapp's status pill: an Ant Design `Tag` under the webapp's theme. */
export function AppTag({
  color,
  className = 'm-0 shrink-0 font-medium',
  children,
}: {
  color: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <AppAntd>
      <Tag color={color} className={className}>
        {children}
      </Tag>
    </AppAntd>
  );
}
