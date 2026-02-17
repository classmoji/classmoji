import { Drawer, Button, Card, Alert, Table, Tag, Input } from 'antd';
import { useState, useMemo } from 'react';
import { PlusOutlined, CheckCircleOutlined, CloseCircleOutlined } from '@ant-design/icons';

import { useParams } from 'react-router';
import { useGlobalFetcher, useRouteDrawer } from '~/hooks';
import { ClassmojiService } from '@classmoji/services';
import { SectionHeader } from '~/components';
import { action } from './action';
import { parseStudentInput } from './utils';
import { requireClassroomAdmin } from '~/utils/routeAuth.server';

export const loader = async ({ params, request }) => {
  const { class: classSlug } = params;

  const { classroom } = await requireClassroomAdmin(request, classSlug, {
    resourceType: 'STUDENT_ROSTER',
    action: 'view_add_form',
  });

  const students = await ClassmojiService.classroomMembership.findUsersByRole(
    classroom.id,
    'STUDENT'
  );

  return { students };
};

const AddStudents = ({ loaderData }) => {
  const { opened, close } = useRouteDrawer({ initialOpen: true });
  const { students: currentStudents } = loaderData;
  const { fetcher, notify } = useGlobalFetcher();
  const { class: classSlug } = useParams();

  const [inputText, setInputText] = useState('');
  const [parsed, setParsed] = useState(null);

  // Create lookup sets for duplicate detection
  const currentByStudentId = useMemo(
    () => new Set(currentStudents.map(s => s.student_id?.toUpperCase())),
    [currentStudents]
  );
  const currentByEmail = useMemo(
    () => new Set(currentStudents.map(s => s.email?.toLowerCase())),
    [currentStudents]
  );

  // Categorize parsed students
  const categorized = useMemo(() => {
    if (!parsed) return { valid: [], skipped: [] };

    const valid = [];
    const skipped = [];
    const seenIds = new Set();
    const seenEmails = new Set();

    for (const student of parsed) {
      if (student.error) {
        skipped.push({ ...student, reason: student.error });
      } else if (currentByStudentId.has(student.student_id)) {
        skipped.push({ ...student, reason: 'Already enrolled (by ID)' });
      } else if (currentByEmail.has(student.email)) {
        skipped.push({ ...student, reason: 'Already enrolled (by email)' });
      } else if (seenIds.has(student.student_id)) {
        skipped.push({ ...student, reason: 'Duplicate in input (by ID)' });
      } else if (seenEmails.has(student.email)) {
        skipped.push({ ...student, reason: 'Duplicate in input (by email)' });
      } else {
        valid.push(student);
        seenIds.add(student.student_id);
        seenEmails.add(student.email);
      }
    }

    return { valid, skipped };
  }, [parsed, currentByStudentId, currentByEmail]);

  const handleParse = () => {
    const result = parseStudentInput(inputText);
    setParsed(result);
  };

  const handleSubmit = () => {
    if (categorized.valid.length === 0) return;

    notify('ADD_STUDENTS', 'Inviting students...');

    fetcher.submit(
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
      render: name => <span className="font-medium text-gray-800">{name || '-'}</span>,
    },
    {
      title: 'Student ID',
      dataIndex: 'student_id',
      width: 120,
      render: id => <span className="font-mono text-sm text-gray-700">{id || '-'}</span>,
    },
    {
      title: 'Email',
      dataIndex: 'email',
      render: email => <span className="text-gray-600">{email || '-'}</span>,
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
      render: reason => (
        <Tag color="red" icon={<CloseCircleOutlined />}>
          {reason}
        </Tag>
      ),
    },
  ];

  return (
    <Drawer
      onClose={close}
      open={opened}
      width={800}
      title={
        <div className="flex items-center gap-3">
          <div>
            <h2 className="text-xl font-semibold text-gray-900">Add Students</h2>
            <p className="text-sm text-gray-600 font-normal">Bulk add students to your class</p>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-6">
        {/* Input Section */}
        <Card className="shadow-xs">
          <div className="space-y-4">
            <SectionHeader title="Paste Student Information" subtitle="One student per line" />

            <Input.TextArea
              value={inputText}
              onChange={e => setInputText(e.target.value)}
              placeholder={`John Doe, ABC123, john@school.edu\nJane Smith, DEF456, jane@school.edu`}
              rows={6}
              className="font-mono text-sm"
              disabled={parsed !== null}
            />

            <div className="flex gap-3 mt-4">
              {parsed === null ? (
                <Button type="primary" onClick={handleParse} disabled={!inputText.trim()}>
                  Parse Students
                </Button>
              ) : (
                <Button onClick={handleReset}>Start Over</Button>
              )}
            </div>
          </div>
        </Card>

        {/* Preview Section */}
        {parsed !== null && (
          <>
            {/* Valid Students */}
            {categorized.valid.length > 0 && (
              <Card className="shadow-xs">
                <div className="flex items-center justify-between mb-4">
                  <SectionHeader
                    title="Ready to Add"
                    subtitle="These students will be enrolled"
                    count={categorized.valid.length}
                  />
                  <Button
                    type="primary"
                    icon={<PlusOutlined />}
                    onClick={handleSubmit}
                    loading={fetcher.state === 'submitting'}
                  >
                    Add {categorized.valid.length} Student{categorized.valid.length !== 1 && 's'}
                  </Button>
                </div>

                <Table
                  columns={validColumns}
                  dataSource={categorized.valid}
                  size="small"
                  rowKey="key"
                  pagination={false}
                  rowClassName="bg-green-50"
                />
              </Card>
            )}

            {/* Skipped Students */}
            {categorized.skipped.length > 0 && (
              <Card className="shadow-xs">
                <SectionHeader
                  title="Skipped"
                  subtitle="These students will not be added"
                  count={categorized.skipped.length}
                />

                <Table
                  columns={skippedColumns}
                  dataSource={categorized.skipped}
                  size="small"
                  rowKey="key"
                  pagination={false}
                  rowClassName="bg-gray-50 opacity-60"
                  className="mt-4"
                />
              </Card>
            )}

            {/* All duplicates message */}
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
