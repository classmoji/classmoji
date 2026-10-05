import React from 'react';
import { Button, Card, ConfigProvider, Input, Select, Table, Tag } from 'antd';
import type { TableColumnsType } from 'antd';
import {
  IconAlertCircleFilled,
  IconChevronDown,
  IconChevronLeft,
  IconFileText,
  IconFolder,
  IconLoader2,
  IconPlus,
  IconSearch,
} from '@tabler/icons-react';
import { demoUsers } from '../../data/appNav';
import { useDemoTimeline } from '../../hooks/useDemoTimeline';
import type { DemoBase, Step } from '../../types/demo';
import { clickAnd, moveTo, offset, typeSteps } from '../../utils/timeline';
import { AppAntd } from '../demo-kit/AppAntd';
import { AppCallout } from '../demo-kit/AppCallout';
import { AppShell } from '../demo-kit/AppShell';
import { DemoFrame } from '../demo-kit/DemoFrame';

/*
 * A copy of the webapp's Repositories flow:
 * - the list (components/features/repositories/RepositoriesTable.tsx): folders
 *   open by default, a repository with no assignment tagged "No assignment";
 * - the New repository page (routes/admin.$class.repos_.form/FormModule.tsx);
 * - Publish's confirm (useRepositoryActions.confirmPublish), then the row's
 *   "Publishing" and the progress callout (OperationProgress).
 * Publishing a repository does not publish its assignments; they keep their own
 * status.
 */

type State = DemoBase & {
  scene: 'list' | 'form';
  title: string;
  templateQuery: string;
  templateOpen: boolean;
  template: string | null;
  /** The form page scrolled down to its Create button. */
  scrolled: boolean;
  created: boolean;
  confirmOpen: boolean;
  publishing: boolean;
  published: boolean;
  count: number;
  done: boolean;
};

const STUDENTS = 42;
const NEW_REPO = 'hw3-heaps';
const TEMPLATE = 'cs52-26f/hw3-heaps-template';

const initial: State = {
  cursor: null,
  click: 0,
  scene: 'list',
  title: '',
  templateQuery: '',
  templateOpen: false,
  template: null,
  scrolled: false,
  created: false,
  confirmOpen: false,
  publishing: false,
  published: false,
  count: 0,
  done: false,
};

/** Publishing, as the webapp reports it: the row busy, the callout counting. */
const publishStory: Step<State>[] = [
  { at: 0, action: s => ({ ...s, confirmOpen: false, publishing: true }) },
  ...[5, 11, 18, 24, 31, 37, STUDENTS].map((count, i) => ({
    at: 350 + i * 300,
    action: (s: State) => ({ ...s, count }),
  })),
  { at: 2500, action: s => ({ ...s, publishing: false, published: true, done: true }) },
  { at: 4300, action: s => ({ ...s, done: false }) },
];

const PUBLISH_AT = 9000;

const steps: Step<State>[] = [
  { at: 500, action: moveTo<State>('new') },
  { at: 1100, action: clickAnd<State>(s => ({ ...s, scene: 'form' })) },
  { at: 1500, action: moveTo<State>('title') },
  { at: 1900, action: clickAnd<State>() },
  ...typeSteps<State>(2000, NEW_REPO, 70, (s, title) => ({ ...s, title })),
  { at: 3000, action: moveTo<State>('template') },
  { at: 3500, action: clickAnd<State>(s => ({ ...s, templateOpen: true })) },
  ...typeSteps<State>(3700, 'hash', 90, (s, templateQuery) => ({ ...s, templateQuery })),
  { at: 4300, action: moveTo<State>('template-option') },
  {
    at: 4800,
    action: clickAnd<State>(s => ({ ...s, templateOpen: false, template: TEMPLATE })),
  },
  { at: 5300, action: s => ({ ...s, scrolled: true }) },
  { at: 5800, action: moveTo<State>('create') },
  { at: 6400, action: clickAnd<State>(s => ({ ...s, scene: 'list', created: true })) },
  { at: 7200, action: moveTo<State>('publish') },
  { at: 7800, action: clickAnd<State>(s => ({ ...s, confirmOpen: true })) },
  { at: 8300, action: moveTo<State>('confirm') },
  { at: PUBLISH_AT, action: clickAnd<State>() },
  ...offset(publishStory, PUBLISH_AT),
  { at: 13500, action: moveTo<State>(null) },
];

type Row = {
  key: string;
  name: string;
  kind: 'repository' | 'assignment';
  mode?: 'issue' | 'push';
  type: string;
  weight?: number;
  published: boolean;
  children?: Row[];
};

const assignment = (key: string, name: string, weight: number): Row => ({
  key,
  name,
  kind: 'assignment',
  type: 'Individual',
  weight,
  published: true,
});

/** The app's antd theme at the demo's scale: the stage is smaller than a real page. */
function Compact({ children }: { children: React.ReactNode }) {
  return (
    <AppAntd>
      <ConfigProvider
        theme={{
          token: { fontSize: 12, controlHeight: 28 },
          components: {
            Table: { cellPaddingBlockMD: 8, cellPaddingInlineMD: 6 },
            Card: { bodyPadding: 14 },
          },
        }}
      >
        {children}
      </ConfigProvider>
    </AppAntd>
  );
}

/** The webapp's action link (RepositoriesTable's ActionLink). */
function ActionLink({ children, cursor }: { children: React.ReactNode; cursor?: string }) {
  return (
    <span data-cursor={cursor} className="text-[12px] font-medium text-sky-600">
      {children}
    </span>
  );
}

/** SectionHeader at size md: title and subtitle on one line. */
function SectionHeader({ title, subtitle }: { title: string; subtitle: string }) {
  return (
    <div className="mb-3 flex items-center gap-3">
      <h3 className="text-[13px] font-semibold text-ink-0">{title}</h3>
      <p className="text-[11.5px] text-ink-2">{subtitle}</p>
    </div>
  );
}

/** A form label the way antd's vertical Form draws it. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[12px] text-ink-1">{label}</span>
      {children}
    </div>
  );
}

const popoverShadow =
  'shadow-[0_6px_16px_0_rgba(0,0,0,0.08),0_3px_6px_-4px_rgba(0,0,0,0.12),0_9px_28px_8px_rgba(0,0,0,0.05)]';

function RepositoryForm({ s }: { s: State }) {
  return (
    <div className="h-full overflow-hidden">
      <div
        className="flex flex-col gap-3 transition-transform duration-700 ease-out"
        style={{ transform: s.scrolled ? 'translateY(-300px)' : 'none' }}
      >
        <Card className="shadow-xs">
          <SectionHeader
            title="Basic Information"
            subtitle="Set up the core details for this repository"
          />
          <div className="grid grid-cols-2 gap-3">
            <Field label="Repository title">
              <span data-cursor="title">
                <Input value={s.title} placeholder="React fundamentals" readOnly />
              </span>
            </Field>
            <Field label="Type">
              <Select
                value="INDIVIDUAL"
                className="w-full"
                open={false}
                options={[{ value: 'INDIVIDUAL', label: 'Individual' }]}
              />
            </Field>
          </div>
        </Card>

        <Card className="shadow-xs">
          <SectionHeader
            title="Learning Objectives"
            subtitle="Add a description for the learning objective of this repository"
          />
          <Input.TextArea rows={2} placeholder="Enter learning objective..." readOnly />
        </Card>

        <Card className="relative z-10 shadow-xs">
          <SectionHeader title="Template Repository" subtitle="Provide starter code for students" />
          <Field label="Search template repositories">
            <div data-cursor="template" className="relative">
              <Select
                className="w-full"
                open={false}
                showSearch
                value={s.template ?? undefined}
                searchValue={s.templateOpen ? s.templateQuery : undefined}
                placeholder="Type to search template repositories..."
                options={[{ value: TEMPLATE, label: TEMPLATE }]}
              />
              {s.templateOpen && (
                <div
                  className={`absolute inset-x-0 top-full z-20 mt-1 rounded-lg bg-white p-1 ${popoverShadow}`}
                >
                  <div
                    data-cursor="template-option"
                    className="flex items-center justify-between rounded bg-black/[0.04] px-3 py-1.5"
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-ink-1">{TEMPLATE}</span>
                      <Tag color="gold" className="m-0">
                        Private
                      </Tag>
                    </div>
                    <span className="text-[11px] text-gray-400">Python</span>
                  </div>
                </div>
              )}
            </div>
          </Field>
        </Card>

        <Card className="shadow-xs">
          <div className="flex items-start justify-between">
            <SectionHeader
              title="Autograding tests"
              subtitle="Run tests on every push using Github Actions"
            />
            <Button type="primary" icon={<IconPlus size={14} />}>
              Add test
            </Button>
          </div>
          <div className="py-4 text-center text-gray-500">
            <div className="font-medium">No tests added yet</div>
            <div className="text-[11.5px]">Add a test to enable autograding</div>
          </div>
        </Card>

        <Card className="shadow-xs">
          <SectionHeader
            title="Linked Content"
            subtitle="Link pages and slides to this repository"
          />
          <p className="mb-1 text-[12px] font-medium text-gray-700">Pages</p>
          <Select
            className="mb-3 w-full"
            mode="multiple"
            placeholder="Select pages to link"
            open={false}
          />
          <p className="mb-1 text-[12px] font-medium text-gray-700">Slides</p>
          <Select
            className="w-full"
            mode="multiple"
            placeholder="Select slides to link"
            open={false}
          />
        </Card>

        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button type="text">Discard</Button>
          <span data-cursor="create">
            <Button type="primary" style={{ backgroundColor: '#1f883d', borderColor: '#1f883d' }}>
              Create repository
            </Button>
          </span>
        </div>
      </div>
    </div>
  );
}

export function PublishDemo() {
  const demo = useDemoTimeline({ initial, steps, duration: 14200 });
  const { state: s } = demo;

  const rows: Row[] = [
    {
      key: 'hw1',
      name: 'hw1-arrays',
      kind: 'repository',
      mode: 'push',
      type: 'Individual',
      published: true,
      children: [assignment('hw1-a', 'HW1: Arrays', 10)],
    },
    {
      key: 'hw2',
      name: 'hw2-lists',
      kind: 'repository',
      mode: 'issue',
      type: 'Individual',
      published: true,
      children: [assignment('hw2-a', 'HW2: Linked lists', 10)],
    },
    ...(s.created
      ? [
          {
            key: 'new',
            name: NEW_REPO,
            kind: 'repository' as const,
            type: 'Individual',
            published: s.published,
          },
        ]
      : []),
  ];

  const columns: TableColumnsType<Row> = [
    {
      title: 'Repository',
      key: 'name',
      className: 'whitespace-nowrap',
      render: (_, r) =>
        r.kind === 'assignment' ? (
          <span className="inline-flex items-center gap-2 align-middle">
            <IconFileText size={16} className="shrink-0 text-gray-400" />
            <span className="text-ink-1">{r.name}</span>
          </span>
        ) : (
          <span className="inline-flex items-center gap-2 align-middle">
            <IconFolder size={18} className="shrink-0 text-gray-400" />
            <span className="font-semibold text-ink-1">{r.name}</span>
            {r.mode && (
              <Tag
                color={r.mode === 'push' ? 'geekblue' : 'purple'}
                className="m-0 shrink-0 font-medium"
              >
                {r.mode}
              </Tag>
            )}
            {!r.children?.length && (
              <Tag className="m-0 shrink-0 font-medium text-gray-600!">No assignment</Tag>
            )}
          </span>
        ),
    },
    {
      title: 'Type',
      key: 'type',
      width: 74,
      render: (_, r) => <span className="text-ink-2">{r.type}</span>,
    },
    {
      title: 'Weight (%)',
      key: 'weight',
      width: 74,
      render: (_, r) =>
        r.weight !== undefined ? (
          <span className="tabular-nums text-ink-2">{r.weight} %</span>
        ) : null,
    },
    {
      title: 'Status',
      key: 'status',
      width: 76,
      render: (_, r) => (
        <Tag color={r.published ? 'green' : 'orange'} className="font-semibold">
          {r.published ? 'Published' : 'Draft'}
        </Tag>
      ),
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 162,
      render: (_, r) =>
        r.kind === 'assignment' ? (
          <ActionLink>Edit</ActionLink>
        ) : (
          <div className="flex items-center gap-x-3 whitespace-nowrap">
            <ActionLink>View</ActionLink>
            <ActionLink>Edit</ActionLink>
            {r.key === 'new' && s.publishing ? (
              <span className="inline-flex items-center gap-1.5 text-[12px] text-ink-3">
                <IconLoader2 size={14} className="animate-spin" />
                Publishing
              </span>
            ) : r.published ? (
              <ActionLink>Sync</ActionLink>
            ) : (
              <ActionLink cursor={r.key === 'new' ? 'publish' : undefined}>Publish</ActionLink>
            )}
          </div>
        ),
    },
  ];

  const legend = (
    <div className="flex shrink-0 items-center gap-3 text-[12px] text-ink-3" aria-label="Legend">
      <span className="inline-flex items-center gap-1">
        <IconFolder size={14} className="text-gray-400" />
        repository
      </span>
      <span className="inline-flex items-center gap-1">
        <IconFileText size={14} className="text-gray-400" />
        issue
      </span>
    </div>
  );

  const breadcrumb = (
    <div className="flex items-center gap-2 text-[13px] text-ink-2">
      <IconChevronLeft size={16} />
      <IconFolder size={16} className="text-gray-400" />
      <span>Repositories</span>
      <span className="text-ink-3">/</span>
      <span className="font-semibold text-ink-1">New repository</span>
    </div>
  );

  const listActions = (
    <Compact>
      <div className="flex items-center gap-3">
        <Input
          prefix={<IconSearch size={14} className="text-gray-400" />}
          placeholder="Search by title"
          className="w-32"
          readOnly
        />
        <span data-cursor="new">
          <Button type="primary" icon={<IconPlus size={14} />}>
            New repository
          </Button>
        </span>
      </div>
    </Compact>
  );

  return (
    <DemoFrame
      controller={demo}
      address={
        s.scene === 'form'
          ? 'app.classmoji.io/admin/cs52-26f/repos/form'
          : 'app.classmoji.io/admin/cs52-26f/repos'
      }
      label="Demo: an instructor creates the hw3-heaps repository from a template, then publishes it; Classmoji creates a private repository for each of 42 students."
      rest={{ x: 0.5, y: 0.92 }}
    >
      <AppShell
        active="repositories"
        role="staff"
        user={demoUsers.teacher}
        title={s.scene === 'form' ? '' : 'Repositories'}
        titleExtra={s.scene === 'form' ? breadcrumb : legend}
        actions={s.scene === 'list' ? listActions : undefined}
      >
        <Compact>
          {s.scene === 'form' ? (
            <RepositoryForm s={s} />
          ) : (
            <div className="h-full overflow-hidden rounded-2xl bg-panel p-3 ring-1 ring-line [&_th]:whitespace-nowrap">
              <Table<Row>
                columns={columns}
                dataSource={rows}
                rowKey="key"
                rowHoverable={false}
                tableLayout="fixed"
                size="middle"
                pagination={false}
                expandable={{
                  // Folders open by default, as on the real page.
                  expandedRowKeys: rows.filter(r => r.children?.length).map(r => r.key),
                  expandIcon: ({ record }) =>
                    record.children?.length ? (
                      <span className="float-left mr-2 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded align-middle text-ink-3">
                        <IconChevronDown size={16} />
                      </span>
                    ) : (
                      <span className="float-left mr-2 inline-block h-5 w-5 shrink-0" />
                    ),
                }}
              />
            </div>
          )}
        </Compact>
      </AppShell>

      {s.confirmOpen && (
        <div className="absolute inset-0 z-20 flex items-start justify-center bg-black/45 pt-[110px]">
          <div className={`w-[340px] rounded-lg bg-white p-5 ${popoverShadow}`}>
            <div className="flex gap-3">
              <IconAlertCircleFilled size={20} className="shrink-0 text-[#faad14]" />
              <div>
                <div className="text-[14px] font-semibold text-ink-0">Publish repository</div>
                <div className="mt-2 text-[12.5px] text-ink-1">
                  This makes the repository available to all students.
                </div>
              </div>
            </div>
            <Compact>
              <div className="mt-5 flex justify-end gap-2">
                <Button>Cancel</Button>
                <span data-cursor="confirm">
                  <Button type="primary">Publish</Button>
                </span>
              </div>
            </Compact>
          </div>
        </div>
      )}

      {(s.publishing || s.done) && (
        <div className="absolute inset-x-0 top-3 z-10">
          {s.publishing ? (
            <AppCallout
              variant="progress"
              title="Creating student repositories"
              message={`${s.count} of ${STUDENTS} repositories`}
              progress={s.count / STUDENTS}
            />
          ) : (
            <AppCallout
              variant="success"
              title="Student repositories created"
              message={`${STUDENTS} repositories`}
            />
          )}
        </div>
      )}
    </DemoFrame>
  );
}
