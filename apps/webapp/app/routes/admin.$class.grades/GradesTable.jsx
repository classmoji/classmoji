import { useState, useMemo } from 'react';
import { Table, Checkbox, ConfigProvider, Radio, FloatButton, Card } from 'antd';
import { IconSettings, IconMessagePlus } from '@tabler/icons-react';
import { useParams, useNavigate } from 'react-router';
import { mean, median } from 'simple-statistics';
import './styles.css';

import { PageHeader, UserThumbnailView, TableActionButtons, SearchInput } from '~/components';
import GradeSettings from './GradeSettings';
import { createAssignmentColumns } from './columns/assignmentColumns';
import { createStudentGradeColumns } from './columns/studentGradeColumns';
import { calculateStudentFinalGrade } from '@classmoji/utils';
import { useGlobalFetcher } from '~/hooks';

const GradesTable = props => {
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
    return students.filter(student => {
      const name = student.name?.toLowerCase() || '';
      const login = student.login?.toLowerCase() || '';
      const email = student.email?.toLowerCase() || '';
      return name.includes(query) || login.includes(query) || email.includes(query);
    });
  }, [students, searchQuery]);

  const handleUpdateLetterGrade = (membershipId, letterGrade) => {
    fetcher.submit(
      { membership_id: membershipId, letter_grade: letterGrade },
      {
        method: 'post',
        action: '?/updateLetterGrade',
        encType: 'application/json',
      }
    );
  };

  const changeLetterGradeMapping = async (letterGrade, grade) => {
    setLetterGradeMappings(
      letterGradeMappings.map(mapping => {
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
      render: (_, student) => {
        return <UserThumbnailView user={student} truncate />;
      },
    },
    ...studentGradeColumns,
    ...assignmentColumns,
    {
      title: 'Actions',
      key: 'actions',
      fixed: 'right',
      width: 100,
      render: (_, student) => {
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

  const summary = pageData => {
    // Return null if no data to prevent mean/median errors
    if (!pageData || pageData.length === 0) {
      return null;
    }

    const finalIndividualNumericGrades = pageData.map(student => {
      return calculateStudentFinalGrade(student.repositories, emojiMappings, settings, true, false);
    });
    const finalNumericGrades = pageData.map(student => {
      return calculateStudentFinalGrade(student.repositories, emojiMappings, settings);
    });

    // Filter out invalid grades for statistics
    const validIndividualGrades = finalIndividualNumericGrades.filter(g => g >= 0);
    const validFinalGrades = finalNumericGrades.filter(g => g >= 0);

    return (
      <Table.Summary fixed className="bg-yellow-50">
        <Table.Summary.Row>
          <Table.Summary.Cell></Table.Summary.Cell>
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
    <div className="space-y-6 min-w-0">
      <PageHeader title="Grades" routeName="grades">
        <div className="flex items-center gap-3">
          <Checkbox checked={showIssues} onChange={() => setShowIssues(!showIssues)}>
            Show Assignments
          </Checkbox>
          <Checkbox checked={showComments} onChange={() => setShowComments(!showComments)}>
            Show Comments
          </Checkbox>
          <div className="h-[30px] w-[1px] bg-gray-300" />
          <Radio.Group value={view} onChange={e => setView(e.target.value)} size="small">
            <Radio.Button value="Emoji">🎨 Emoji</Radio.Button>
            <Radio.Button value="Numeric">🔢 Numeric</Radio.Button>
          </Radio.Group>
        </div>
      </PageHeader>

      {/* Grades Table */}
      <Card className="shadow-sm overflow-x-auto">
        <div className="flex items-center justify-between gap-4 mb-4">
          <div className="flex items-center gap-3">
            {searchQuery && (
              <span className="text-sm text-gray-500 bg-gray-100 px-3 py-1 rounded-full">
                {filteredStudents.length} of {students.length}
              </span>
            )}
          </div>
          <SearchInput
            query={searchQuery}
            setQuery={setSearchQuery}
            placeholder="Search by name, username, or email..."
            className="w-80"
          />
        </div>

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
                columns={columns.filter(col => !col.hidden)}
                rowHoverable={true}
                size="small"
                bordered={true}
                rowKey="id"
                scroll={{ x: 1500 }}
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
      </Card>

      <FloatButton.Group
        trigger="hover"
        style={{ right: 24, bottom: 94, width: 56, height: 56 }}
        icon={<IconSettings size={28} className="relative -left-[3.75px]" />}
        className="grades-float-button"
        position="topLeft"
      >
        <GradeSettings
          letterGradeMappings={letterGradeMappings}
          changeLetterGradeMapping={changeLetterGradeMapping}
        />
      </FloatButton.Group>
    </div>
  );
};

export default GradesTable;
