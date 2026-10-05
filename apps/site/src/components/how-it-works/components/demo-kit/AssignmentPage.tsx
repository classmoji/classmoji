import React from 'react';
import { ConfigProvider, Input } from 'antd';
import { IconSearch } from '@tabler/icons-react';
import { AppAntd } from './AppAntd';

/*
 * Pieces of the webapp's assignment page (routes/admin.$class.assignments_.$id)
 * at the demo's scale, shared by every demo that shows it so they draw the same
 * screen.
 */

/** The app's antd theme at the demo's scale: the stage is smaller than a real page. */
export function AssignmentCompact({ children }: { children: React.ReactNode }) {
  return (
    <AppAntd>
      <ConfigProvider
        theme={{
          token: { fontSize: 12, controlHeight: 28 },
          components: { Table: { cellPaddingBlock: 8, cellPaddingInline: 8 } },
        }}
      >
        {children}
      </ConfigProvider>
    </AppAntd>
  );
}

/** The webapp's quiet text link (Change, Grade, View). */
export const assignmentLink = 'text-[12px] font-medium text-ink-2';

/** A Stat tile from the assignment page. */
export function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-xl bg-panel px-3 py-2 ring-1 ring-line">
      <span className="text-[11px] font-medium text-ink-3">{label}</span>
      <span className="text-[16px] font-bold tabular-nums text-ink-1">{children}</span>
    </div>
  );
}

/** The header's facts line. */
export function AssignmentFacts({
  mode,
  repository,
  total,
}: {
  mode: 'issue' | 'push';
  repository: string;
  total: number;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] text-ink-3">
      <span>
        Repo · <span className="font-medium text-ink-1">{mode}</span>
      </span>
      <span>
        Repository <span className="font-medium text-[#21883d]">{repository}</span>
      </span>
      <span>
        Due <span className="font-medium text-ink-1">Fri Oct 9, 11:59 PM</span>
      </span>
      <span>
        Weight <span className="font-medium text-ink-1">10%</span>
      </span>
      <span>
        Student repos{' '}
        <span className="font-medium text-ink-1">
          {total} of {total}
        </span>
      </span>
    </div>
  );
}

/** Search and the submission filter, "All" selected. */
export function AssignmentToolbar() {
  return (
    <div className="flex items-center gap-2">
      <Input
        prefix={<IconSearch size={14} className="text-gray-400" />}
        placeholder="Search students"
        className="w-36"
        readOnly
      />
      <div className="flex gap-1 rounded-lg bg-stone-100 p-1">
        {['All', 'Ungraded', 'Late', 'Not submitted'].map((f, i) => (
          <span
            key={f}
            className={`flex h-6 items-center whitespace-nowrap rounded-md px-2 text-[11px] font-medium ${
              i === 0 ? 'bg-white text-ink-1 ring-1 ring-line' : 'text-ink-2'
            }`}
          >
            {f}
          </span>
        ))}
      </div>
    </div>
  );
}
