import React from 'react';
import { Checkbox, Table, Tag } from 'antd';
import type { TableColumnsType } from 'antd';
import { IconBrandGithub } from '@tabler/icons-react';
import { demoUsers } from '../../data/appNav';
import { useDemoTimeline } from '../../hooks/useDemoTimeline';
import type { DemoBase, Step } from '../../types/demo';
import { clickAnd, moveTo } from '../../utils/timeline';
import {
  AssignmentCompact,
  AssignmentFacts,
  AssignmentToolbar,
  Stat,
  assignmentLink as link,
} from '../demo-kit/AssignmentPage';
import { AppShell } from '../demo-kit/AppShell';
import { DemoFrame } from '../demo-kit/DemoFrame';

/*
 * A copy of the webapp's assignment grading page
 * (routes/admin.$class.assignments_.$id: header facts, Stat tiles, search and
 * filter toolbar, SubmissionsTable). Grading goes through EmojiGrader's hover
 * picker; graders through the Change popover of checkboxes.
 */

type State = DemoBase & {
  /** Bob's grades, the row being graded. */
  bobGrades: string[];
  pickerOpen: boolean;
  /** The emoji that just popped in the picker. */
  popped: string | null;
  gradersOpen: boolean;
  /** Alice's graders, the row being reassigned. */
  aliceGraders: string[];
};

const STAFF = ['Ava', 'Diego', 'Mina', 'Theo', 'Sam'];
const SCALE = ['🌟', '🔥', '👍', '🤔', '😬'];

const initial: State = {
  cursor: null,
  click: 0,
  bobGrades: [],
  pickerOpen: false,
  popped: null,
  gradersOpen: false,
  aliceGraders: ['Ava'],
};

const steps: Step<State>[] = [
  { at: 600, action: moveTo<State>('grade-bob') },
  { at: 1200, action: s => ({ ...s, pickerOpen: true }) },
  { at: 1700, action: moveTo<State>('emoji-🔥') },
  {
    at: 2300,
    action: clickAnd<State>(s => ({ ...s, bobGrades: ['🔥'], popped: '🔥' })),
  },
  { at: 2800, action: s => ({ ...s, popped: null }) },
  { at: 3200, action: s => ({ ...s, pickerOpen: false }) },
  { at: 3600, action: moveTo<State>('change-alice') },
  { at: 4200, action: clickAnd<State>(s => ({ ...s, gradersOpen: true })) },
  { at: 4800, action: moveTo<State>('grader-Sam') },
  {
    at: 5400,
    action: clickAnd<State>(s => ({ ...s, aliceGraders: ['Ava', 'Sam'] })),
  },
  { at: 6400, action: s => ({ ...s, gradersOpen: false }) },
  { at: 6600, action: moveTo<State>(null) },
];

type Row = {
  key: string;
  name: string;
  login: string;
  graders: string[];
  grades: string[];
  late?: boolean;
};

const ROWS: Row[] = [
  { key: 'alice', name: 'Alice Wong', login: 'alicewong', graders: ['Ava'], grades: ['🌟'] },
  {
    key: 'bob',
    name: 'Bob Kim',
    login: 'bobkim',
    graders: ['Sam'],
    grades: [],
  },
  { key: 'chen', name: 'Chen Li', login: 'chenli', graders: ['Theo'], grades: ['👍'] },
  { key: 'dana', name: 'Dana Ortiz', login: 'dortiz', graders: ['Mina'], grades: ['🔥'] },
  {
    key: 'eli',
    name: 'Eli Brooks',
    login: 'elibrooks',
    graders: ['Diego'],
    grades: ['🌟'],
  },
];

const TOTAL = 42;

/** A floating antd-style popover card; the demo positions it by hand. */
function Popover({ className, children }: { className: string; children: React.ReactNode }) {
  return (
    <div
      className={`absolute z-20 rounded-lg bg-white shadow-[0_6px_16px_0_rgba(0,0,0,0.08),0_3px_6px_-4px_rgba(0,0,0,0.12),0_9px_28px_8px_rgba(0,0,0,0.05)] ${className}`}
    >
      {children}
    </div>
  );
}

export function GradingDemo() {
  const demo = useDemoTimeline({ initial, steps, duration: 7400 });
  const { state: s } = demo;

  const rows = ROWS.map(r =>
    r.key === 'bob'
      ? { ...r, grades: s.bobGrades }
      : r.key === 'alice'
        ? { ...r, graders: s.aliceGraders }
        : r
  );
  const graded = 40 + rows.filter(r => r.grades.length > 0).length - 4;
  const ungraded = TOTAL - graded;

  const columns: TableColumnsType<Row> = [
    {
      title: 'Student',
      key: 'student',
      width: 116,
      render: (_, r) => (
        <div className="flex min-w-0 items-center gap-2">
          <div
            aria-hidden
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-stone-100 text-[11px] font-semibold text-stone-600 ring-1 ring-stone-200"
          >
            {r.name.charAt(0)}
          </div>
          <div className="flex min-w-0 flex-col gap-[2px]">
            <div className="truncate text-[11px] font-bold text-ink-1">{r.name}</div>
            <div className="truncate text-[11px] text-ink-3">@{r.login}</div>
          </div>
        </div>
      ),
    },
    {
      title: 'Repository',
      key: 'repo',
      width: 100,
      render: (_, r) => (
        <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 text-[#21883d]">
          <IconBrandGithub size={13} className="shrink-0 text-gray-900" />
          <span className="truncate">hw3-hashing-{r.login}</span>
        </span>
      ),
    },
    {
      title: 'Submission',
      key: 'submission',
      width: 78,
      className: 'border-l border-line',
      render: (_, r) => (
        <div className="flex flex-wrap gap-1">
          <Tag color="green" bordered={false} className="m-0">
            Submitted
          </Tag>
          {r.late && (
            <Tag color="orange" bordered={false} className="m-0">
              Late
            </Tag>
          )}
        </div>
      ),
    },
    {
      title: 'Graders',
      key: 'graders',
      width: 128,
      render: (_, r) => (
        <div className="relative flex items-center gap-2 whitespace-nowrap">
          {r.graders.length > 0 && (
            <span className="max-w-[76px] truncate text-[12px] text-ink-1">
              {r.graders.join(', ')}
            </span>
          )}
          <span
            data-cursor={r.key === 'alice' ? 'change-alice' : undefined}
            className={`${link} ${r.key === 'alice' && s.gradersOpen ? 'underline underline-offset-2' : ''}`}
          >
            {r.graders.length ? 'Change' : 'Assign'}
          </span>
          {r.key === 'alice' && s.gradersOpen && (
            <Popover className="left-0 top-full mt-1 px-3 py-2">
              <div className="flex min-w-32 flex-col gap-1.5">
                {STAFF.map(name => (
                  <span key={name} data-cursor={`grader-${name}`}>
                    <Checkbox checked={s.aliceGraders.includes(name)}>
                      <span className="text-[12px]">{name}</span>
                    </Checkbox>
                  </span>
                ))}
              </div>
            </Popover>
          )}
        </div>
      ),
    },
    {
      title: 'Grade',
      key: 'grade',
      width: 96,
      render: (_, r) =>
        r.grades.length > 0 ? (
          <div className="flex items-center gap-2">
            {r.grades.map((e, i) => (
              <span key={i} className="p-0.5 text-[16px] leading-none">
                {e}
              </span>
            ))}
          </div>
        ) : (
          <span className="whitespace-nowrap text-[10.5px] italic text-gray-400">
            No grades yet
          </span>
        ),
    },
    {
      title: 'Actions',
      key: 'actions',
      className: 'border-l border-line',
      render: (_, r) => (
        <div className="relative flex items-center gap-3 whitespace-nowrap">
          <span
            data-cursor={r.key === 'bob' ? 'grade-bob' : undefined}
            className={`${link} ${r.key === 'bob' && s.pickerOpen ? 'text-ink-1 underline underline-offset-2' : ''}`}
          >
            Grade
          </span>
          <span className={link}>View</span>
          {r.key === 'bob' && s.pickerOpen && (
            <Popover className="bottom-full right-0 mb-2 px-3 py-2.5">
              <div className="flex gap-2">
                {SCALE.map(e => {
                  const selected = s.bobGrades.includes(e);
                  return (
                    <span
                      key={e}
                      data-cursor={`emoji-${e}`}
                      className={`rounded-md px-2 py-1 text-[16px] leading-none transition-transform duration-300 ${
                        s.popped === e ? 'scale-125' : ''
                      }`}
                      style={{ backgroundColor: selected ? '#ffebc2' : 'transparent' }}
                    >
                      {e}
                    </span>
                  );
                })}
              </div>
            </Popover>
          )}
        </div>
      ),
    },
  ];

  return (
    <DemoFrame
      controller={demo}
      address="app.classmoji.io/admin/cs52-26f/assignments/hw3"
      label="Demo: on the HW3 grading page, a TA hovers Grade on Bob's row and picks the fire emoji, then adds Sam as a grader on Alice's row; the Graded and Ungraded tiles update."
      rest={{ x: 0.9, y: 0.45 }}
    >
      <AppShell active="modules" role="staff" user={demoUsers.teacher} title="HW3: Hashing">
        <AssignmentCompact>
          <div className="flex h-full flex-col gap-2.5">
            <AssignmentFacts mode="issue" repository="hw3-hashing" total={TOTAL} />
            <div className="grid grid-cols-4 gap-2">
              <Stat label="Submitted">
                {TOTAL} <span className="text-[11px] font-medium text-ink-3">of {TOTAL}</span>
              </Stat>
              <Stat label="Late">
                <span className="text-amber-600">3</span>
              </Stat>
              <Stat label="Graded">
                {graded} <span className="text-[11px] font-medium text-ink-3">of {TOTAL}</span>
              </Stat>
              <Stat label="Ungraded">{ungraded}</Stat>
            </div>
            <AssignmentToolbar />
            <div className="min-h-0 flex-1 overflow-visible rounded-2xl bg-panel p-2 ring-1 ring-line [&_th]:whitespace-nowrap">
              <Table<Row>
                columns={columns}
                dataSource={rows}
                rowKey="key"
                rowHoverable={false}
                tableLayout="fixed"
                pagination={false}
              />
            </div>
          </div>
        </AssignmentCompact>
      </AppShell>
    </DemoFrame>
  );
}
