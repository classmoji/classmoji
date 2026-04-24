import { Drawer, Button, Alert, Table, Tag, Input } from 'antd';
import { useState, useMemo } from 'react';
import { PlusOutlined, CheckCircleOutlined, CloseCircleOutlined } from '@ant-design/icons';
import { IconUserPlus } from '@tabler/icons-react';

import { useParams } from 'react-router';
import { useGlobalFetcher, useRouteDrawer } from '~/hooks';
import { ClassmojiService } from '@classmoji/services';
import { SectionHeader } from '~/components';
import { action } from './action';
import { parseStudentInput } from './utils';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';
import type { Route } from './+types/route';

export const loader = async ({ params, request }: Route.LoaderArgs) => {
  const classSlug = params.class!;

  const { classroom } = await requireClassroomAdmin(request, classSlug!, {
    resourceType: 'STUDENT_ROSTER',
    action: 'view_add_form',
  });

  const students = await ClassmojiService.classroomMembership.findUsersByRole(
    classroom.id,
    'STUDENT'
  );

  return { students };
};

const AddStudents = ({ loaderData }: Route.ComponentProps) => {
  const { opened, close } = useRouteDrawer({ initialOpen: true });
  const { students: currentStudents } = loaderData;
  const { fetcher, notify } = useGlobalFetcher();
  const { class: classSlug } = useParams();

  const [inputText, setInputText] = useState('');
  const [parsed, setParsed] = useState<{ name?: string; email?: string; error?: string }[] | null>(
    null
  );

  // Create lookup set for duplicate detection
  const currentByEmail = useMemo(
    () => new Set(currentStudents.map((s: { email?: string | null }) => s.email?.toLowerCase())),
    [currentStudents]
  );

  // Categorize parsed students
  const categorized = useMemo(() => {
    if (!parsed) return { valid: [], skipped: [] };

    const valid = [];
    const skipped = [];
    const seenEmails = new Set();

    for (const student of parsed) {
      if (student.error) {
        skipped.push({ ...student, reason: student.error });
      } else if (currentByEmail.has(student.email)) {
        skipped.push({ ...student, reason: 'Already enrolled' });
      } else if (seenEmails.has(student.email)) {
        skipped.push({ ...student, reason: 'Duplicate in input' });
      } else {
        valid.push(student);
        seenEmails.add(student.email);
      }
    }

    return { valid, skipped };
  }, [parsed, currentByEmail]);

  const handleParse = () => {
    const result = parseStudentInput(inputText);
    setParsed(result);
  };

  const handleSubmit = () => {
    if (categorized.valid.length === 0) return;

    notify('ADD_STUDENTS', 'Inviting students...');

    fetcher!.submit(
      { students: categorized.valid },
      {
        method: 'post',
        action: `/admin/${classSlug}/students/add`,
        encType: 'application/json',
      }
    );

    close();
  };

  const handleReset = () => {
    setInputText('');
    setParsed(null);
  };

  const columns = [
    {
      title: 'Name',
      dataIndex: 'name',
      render: (name: string) => (
        <span className="font-medium text-gray-800 dark:text-neutral-100">{name || '-'}</span>
      ),
    },
    {
      title: 'Email',
      dataIndex: 'email',
      render: (email: string) => (
        <span className="text-gray-600 dark:text-neutral-400">{email || '-'}</span>
      ),
    },
  ];

  const validColumns = [
    ...columns,
    {
      title: 'Status',
      width: 80,
      render: () => (
        <Tag color="green" icon={<CheckCircleOutlined />}>
          OK
        </Tag>
      ),
    },
  ];

  const skippedColumns = [
    ...columns,
    {
      title: 'Reason',
      dataIndex: 'reason',
      width: 180,
      render: (reason: string) => (
        <Tag color="red" icon={<CloseCircleOutlined />}>
          {reason}
        </Tag>
      ),
    },
  ];

  const submitting = fetcher!.state === 'submitting';
  const canAdd = parsed !== null && categorized.valid.length > 0;

  return (
    <Drawer
      onClose={close}
      open={opened}
      width={800}
      title={null}
      closable={false}
      styles={{
        body: { padding: 0 },
        header: { display: 'none' },
        footer: { padding: 0, border: 'none' },
        content: { borderRadius: 0 },
      }}
      footer={
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-stone-200 dark:border-white/[0.08] bg-stone-50/60 dark:bg-[#2a2a2a]">
          {parsed !== null && (
            <Button onClick={handleReset} type="text">
              Start over
            </Button>
          )}
          <Button onClick={close} type="text">
            Discard
          </Button>
          {parsed === null ? (
            <Button
              type="primary"
              onClick={handleParse}
              disabled={!inputText.trim()}
              style={{ backgroundColor: '#619462', borderColor: '#619462' }}
            >
              Parse students
            </Button>
          ) : (
            <Button
              type="primary"
              icon={<PlusOutlined />}
              onClick={handleSubmit}
              disabled={!canAdd}
              loading={submitting}
              style={{ backgroundColor: '#619462', borderColor: '#619462' }}
            >
              Add {categorized.valid.length} student{categorized.valid.length !== 1 && 's'}
            </Button>
          )}
        </div>
      }
    >
      {/* Gmail-style header */}
      <div className="flex items-center justify-between gap-3 px-5 py-3 bg-stone-50 dark:bg-[#2a2a2a] border-b border-stone-200 dark:border-white/[0.08]">
        <div className="flex items-center gap-2.5 min-w-0">
          <IconUserPlus
            size={18}
            strokeWidth={1.75}
            className="shrink-0 text-gray-500 dark:text-neutral-400"
          />
          <div className="min-w-0">
            <div className="text-sm font-semibold text-gray-900 dark:text-neutral-100 truncate">
              Add students
            </div>
            <div className="text-xs text-gray-500 dark:text-neutral-400 truncate">
              Bulk add students to your class
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={close}
          aria-label="Close"
          className="p-1 rounded hover:bg-stone-200 dark:hover:bg-white/[0.08] text-gray-500 dark:text-neutral-400 transition-colors"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path
              d="M4 4l8 8M12 4l-8 8"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>

      {/* Body */}
      <div className="px-5 pt-4 pb-4 space-y-4">
        <SectionHeader
          title="Paste student information"
          subtitle="One student per line — name, email"
          size="sm"
        />

        <Input.TextArea
          value={inputText}
          onChange={e => setInputText(e.target.value)}
          placeholder={`John Doe, john@school.edu\nJane Smith, jane@school.edu`}
          rows={6}
          className="font-mono text-sm"
          disabled={parsed !== null}
        />

        {parsed !== null && (
          <>
            {categorized.valid.length > 0 && (
              <>
                <div className="h-px bg-stone-200 dark:bg-white/[0.08]" />
                <SectionHeader
                  title="Ready to add"
                  subtitle="These students will be enrolled"
                  size="sm"
                  count={categorized.valid.length}
                />
                <Table
                  columns={validColumns}
                  dataSource={categorized.valid}
                  size="small"
                  rowKey="key"
                  pagination={false}
                  rowClassName="bg-green-50 dark:bg-emerald-500/[0.06]"
                />
              </>
            )}

            {categorized.skipped.length > 0 && (
              <>
                <div className="h-px bg-stone-200 dark:bg-white/[0.08]" />
                <SectionHeader
                  title="Skipped"
                  subtitle="These students will not be added"
                  size="sm"
                  count={categorized.skipped.length}
                />
                <Table
                  columns={skippedColumns}
                  dataSource={categorized.skipped}
                  size="small"
                  rowKey="key"
                  pagination={false}
                  rowClassName="bg-gray-50 dark:bg-white/[0.04] opacity-70"
                />
              </>
            )}

            {categorized.valid.length === 0 && categorized.skipped.length > 0 && (
              <Alert
                message="No new students to add"
                description="All students in your input are either already enrolled or have invalid data."
                type="warning"
                showIcon
              />
            )}
          </>
        )}
      </div>
    </Drawer>
  );
};

export { action };

export default AddStudents;
