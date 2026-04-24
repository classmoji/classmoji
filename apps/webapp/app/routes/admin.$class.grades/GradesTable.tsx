import { useState, useMemo } from 'react';
import { Table, Checkbox, ConfigProvider, Segmented, Popover, Input } from 'antd';
import { IconInfoCircle, IconMessagePlus, IconSearch } from '@tabler/icons-react';
import { useParams, useNavigate } from 'react-router';
import { mean, median } from 'simple-statistics';

import { UserThumbnailView, TableActionButtons } from '~/components';
import GradeSettings from './GradeSettings';
import { createAssignmentColumns } from './columns/assignmentColumns';
import { createStudentGradeColumns } from './columns/studentGradeColumns';
import { calculateStudentFinalGrade } from '@classmoji/utils';
import type { TableProps } from 'antd';
import type { Repository, OrganizationSettings, LetterGradeMappingEntry } from '@classmoji/utils';
import { useGlobalFetcher } from '~/hooks';

interface ModuleData {
  id: string | number;
  title: string;
  weight: number;
  is_published: boolean;
  is_extra_credit?: boolean;
  assignments: Array<{ id: string | number; title: string; weight: number }>;
}

interface Student {
  id: string;
  name: string;
  login: string;
  email?: string;
  provider_email?: string;
  repositories: Repository[];
  [key: string]: unknown;
}

interface Membership {
  id: string | number;
  user_id: string | number;
  comment?: string | null;
  letter_grade?: string | null;
}

type EmojiMappings = Record<string, number>;

interface GradesTableProps {
  emojiMappings: EmojiMappings;
  modules: ModuleData[];
  students: Student[];
  settings: OrganizationSettings;
  letterGradeMappings: LetterGradeMappingEntry[];
  memberships: Membership[];
}

const GradesTable = (props: GradesTableProps) => {
  const {
    emojiMappings,
    modules: assignments,
    students,
    settings,
    letterGradeMappings: initialLetterGradeMappings,
    memberships,
  } = props;
  const [letterGradeMappings, setLetterGradeMappings] = useState(initialLetterGradeMappings);
  const [view, setView] = useState('Emoji');
  const [showIssues, setShowIssues] = useState(false);
  const [showComments, setShowComments] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const { class: classSlug } = useParams();
  const navigate = useNavigate();
  const { fetcher } = useGlobalFetcher();

  // Filter students based on search query
  const filteredStudents = useMemo(() => {
    if (!searchQuery.trim()) return students;

    const query = searchQuery.toLowerCase();
    return students.filter((student: Student) => {
      const name = student.name?.toLowerCase() || '';
      const login = student.login?.toLowerCase() || '';
      const email = student.email?.toLowerCase() || '';
      const providerEmail = student.provider_email?.toLowerCase() || '';
      return (
        name.includes(query) ||
        login.includes(query) ||
        email.includes(query) ||
        providerEmail.includes(query)
      );
    });
  }, [students, searchQuery]);

  const handleUpdateLetterGrade = (
    membershipId: string | number,
    letterGrade: string | number | null | undefined
  ) => {
    fetcher!.submit(
      { membership_id: String(membershipId), letter_grade: String(letterGrade ?? '') },
      {
        method: 'post',
        action: '?/updateLetterGrade',
        encType: 'application/json',
      }
    );
  };

  const changeLetterGradeMapping = async (letterGrade: string, grade: number) => {
    setLetterGradeMappings(
      letterGradeMappings.map((mapping: LetterGradeMappingEntry) => {
        if (mapping.letter_grade === letterGrade) {
          return { ...mapping, min_grade: grade };
        }
        return mapping;
      })
    );
  };

  const assignmentColumns = createAssignmentColumns(
    assignments || [],
    view,
    showIssues,
    emojiMappings,
    settings
  );

  const studentGradeColumns = createStudentGradeColumns(
    emojiMappings,
    settings,
    letterGradeMappings,
    memberships,
    handleUpdateLetterGrade,
    showComments
  );

  const columns = [
    {
      title: 'Student',
      key: 'student',
      dataIndex: 'name',
      fixed: 'left',
      ellipsis: true,
      width: 170,
      render: (_: unknown, student: Student) => {
        return <UserThumbnailView user={student} truncate />;
      },
    },
    ...studentGradeColumns,
    ...(assignmentColumns ?? []),
    {
      title: 'Actions',
      key: 'actions',
      fixed: 'right',
      width: 100,
      render: (_: unknown, student: Student) => {
        return (
          <div className="pl-2">
            <TableActionButtons
              onView={() => {
                navigate(`/admin/${classSlug}/students/${student.login}`);
              }}
            >
              <button
                className="cursor-pointer hover:text-blue-600"
                onClick={() => {
                  navigate(`/admin/${classSlug}/grades/${student.login}`);
                }}
                title="Add comment"
              >
                <IconMessagePlus size={16} />
              </button>
            </TableActionButtons>
          </div>
        );
      },
    },
  ];

  // Calculate scroll width dynamically based on visible columns
  const scrollX = useMemo(() => {
    const baseWidth = 170 + 100; // Student + Actions (fixed columns)
    const gradeColumnsWidth = studentGradeColumns.reduce(
      (sum: number, col) => sum + (Number(col.width) || 150),
      0
    );
    const cols = assignmentColumns ?? [];
    const assignmentColumnsWidth = cols.reduce((sum: number, module) => {
      const mod = module as { width?: number; children?: Array<{ width?: number }> };
      if (!mod.children?.length) return sum + (Number(mod.width) || 140);
      return (
        sum +
        mod.children.reduce((childSum: number, child) => childSum + (Number(child.width) || 140), 0)
      );
    }, 0);
    return Math.max(1500, baseWidth + gradeColumnsWidth + assignmentColumnsWidth);
  }, [studentGradeColumns, assignmentColumns]);

  const summary = (pageData: readonly Student[]) => {
    // Return null if no data to prevent mean/median errors
    if (!pageData || pageData.length === 0) {
      return null;
    }

    const finalIndividualNumericGrades = pageData.map((student: Student) => {
      return calculateStudentFinalGrade(student.repositories, emojiMappings, settings, true, false);
    });
    const finalNumericGrades = pageData.map((student: Student) => {
      return calculateStudentFinalGrade(student.repositories, emojiMappings, settings);
    });

    // Filter out invalid grades for statistics
    const validIndividualGrades = finalIndividualNumericGrades.filter((g: number) => g >= 0);
    const validFinalGrades = finalNumericGrades.filter((g: number) => g >= 0);

    return (
      <Table.Summary {...({ fixed: true, className: 'bg-yellow-50' } as Record<string, unknown>)}>
        <Table.Summary.Row>
          <Table.Summary.Cell index={-1}></Table.Summary.Cell>
          <Table.Summary.Cell index={0}></Table.Summary.Cell>
          <Table.Summary.Cell index={1}></Table.Summary.Cell>
          <Table.Summary.Cell index={2}></Table.Summary.Cell>
          <Table.Summary.Cell index={3}>
            <div className="font-semibold text-gray-900">
              <div>Final Grade (Individual)</div>
              <div className="flex gap-3 text-sm font-normal text-gray-600 mt-1">
                <span>
                  Mean:{' '}
                  {validIndividualGrades.length > 0
                    ? mean(validIndividualGrades).toFixed(1)
                    : 'N/A'}
                </span>
                <span>
                  Median:{' '}
                  {validIndividualGrades.length > 0
                    ? median(validIndividualGrades).toFixed(1)
                    : 'N/A'}
                </span>
              </div>
            </div>
          </Table.Summary.Cell>
          <Table.Summary.Cell index={4}>
            <div className="font-semibold text-gray-900">
              <div>Final Grade</div>
              <div className="flex gap-3 text-sm font-normal text-gray-600 mt-1">
                <span>
                  Mean: {validFinalGrades.length > 0 ? mean(validFinalGrades).toFixed(1) : 'N/A'}
                </span>
                <span>
                  Median:{' '}
                  {validFinalGrades.length > 0 ? median(validFinalGrades).toFixed(1) : 'N/A'}
                </span>
              </div>
            </div>
          </Table.Summary.Cell>
          <Table.Summary.Cell index={5}></Table.Summary.Cell>
        </Table.Summary.Row>
      </Table.Summary>
    );
  };

  return (
    <div className="min-h-full min-w-0">
      <div className="flex items-center justify-between gap-3 mt-2 mb-4 flex-wrap">
        <div className="flex items-center gap-3">
          <h1 className="text-base font-semibold text-gray-600 dark:text-gray-400">Grades</h1>
          {searchQuery && (
            <span className="text-xs text-gray-500 dark:text-gray-400 bg-stone-100 dark:bg-neutral-800 px-2.5 py-1 rounded-full">
              {filteredStudents.length} of {students.length}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <Checkbox checked={showIssues} onChange={() => setShowIssues(!showIssues)}>
            Show Assignments
          </Checkbox>
          <Checkbox checked={showComments} onChange={() => setShowComments(!showComments)}>
            Show Comments
          </Checkbox>
          <div className="h-6 w-px bg-stone-200 dark:bg-neutral-700" />
          <div className="flex items-center gap-1.5">
            <ConfigProvider
              theme={{
                token: {
                  borderRadius: 6,
                },
                components: {
                  Segmented: {
                    borderRadius: 6,
                    borderRadiusSM: 4,
                    itemSelectedBg: '#ffffff',
                    itemSelectedColor: '#1f2937',
                    trackPadding: 3,
                  },
                },
              }}
            >
              <Segmented
                value={view}
                onChange={val => setView(val as string)}
                options={['Emoji', 'Numeric']}
              />
            </ConfigProvider>
            <Popover
              trigger="click"
              placement="bottomRight"
              content={
                <GradeSettings
                  letterGradeMappings={letterGradeMappings}
                  changeLetterGradeMapping={changeLetterGradeMapping}
                />
              }
            >
              <button
                type="button"
                aria-label="Letter grade scale"
                className="flex items-center justify-center text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 cursor-pointer"
              >
                <IconInfoCircle size={18} />
              </button>
            </Popover>
          </div>
          <Input
            placeholder="Search by name, username, or email..."
            prefix={<IconSearch size={16} />}
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            style={{ width: 320 }}
          />
        </div>
      </div>

      <div className="rounded-2xl overflow-hidden bg-white dark:bg-neutral-900 min-h-[calc(100vh-10rem)] p-5 sm:p-6">
        {searchQuery && filteredStudents.length === 0 ? (
          <div className="text-center py-12 text-gray-500">
            <div className="text-4xl mb-2">🔍</div>
            <div className="text-lg mb-1">No students found</div>
            <div className="text-sm">
              No results for <span className="font-medium text-gray-900 italic">{searchQuery}</span>
            </div>
            <div className="text-sm mt-1">Try adjusting your search terms</div>
          </div>
        ) : (
          <div className="overflow-x-auto max-w-full">
            <ConfigProvider
              theme={{
                components: {
                  Table: {
                    headerBg: '#fafafa',
                    headerColor: '#374151',
                  },
                },
              }}
            >
              <Table
                dataSource={filteredStudents}
                columns={
                  columns.filter(
                    col => !(col as Record<string, unknown>).hidden
                  ) as TableProps<Student>['columns']
                }
                rowHoverable={true}
                size="small"
                bordered={true}
                rowKey="id"
                scroll={{ x: scrollX }}
                sticky
                pagination={{
                  pageSize: 50,
                  showSizeChanger: true,
                  showTotal: (total, range) => `${range[0]}-${range[1]} of ${total} students`,
                }}
                summary={summary}
                locale={{
                  emptyText: (
                    <div className="text-center py-8 text-gray-500">
                      <div className="text-4xl mb-2">📊</div>
                      <div>No student grades available</div>
                      <div className="text-sm">
                        Students will appear here once assignments are published
                      </div>
                    </div>
                  ),
                }}
                className="rounded-lg"
              />
            </ConfigProvider>
          </div>
        )}
      </div>

    </div>
  );
};

export default GradesTable;
