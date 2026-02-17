import { Switch, Table, Tag, Tabs } from 'antd';
import { useEffect, useState } from 'react';
import { openRepositoryAssignmentInGithub } from '~/utils/helpers.client';
import { emojis } from '@classmoji/utils';
import dayjs from 'dayjs';
import useStore from '~/store';
import {
  EmojiGrader,
  UserThumbnailView,
  SearchInput,
  Countdown,
  TableActionButtons,
  EmojisDisplay,
} from '~/components';

const RepositoryAssignmentsTable = ({
  allRepositoryAssignments,
  repositoryAssignments,
  modules,
  emojiMappings,
}) => {
  const [userQuery, setUserQuery] = useState('');
  const [assignmentsList, setAssignmentsList] = useState(repositoryAssignments);
  const [showMyAssignments, setShowMyAssignments] = useState(true);
  const [activeTab, setActiveTab] = useState('overview');
  const { classroom } = useStore(state => state);

  useEffect(() => {
    if (showMyAssignments) {
      setAssignmentsList(repositoryAssignments);
    } else {
      setAssignmentsList(allRepositoryAssignments);
    }
  }, [showMyAssignments, repositoryAssignments, allRepositoryAssignments]);

  // Filter functions for different tabs
  const filterAssignments = (assignments, tab) => {
    switch (tab) {
      case 'submitted':
        return assignments.filter(assignment => assignment.status === 'CLOSED');
      case 'unsubmitted':
        return assignments.filter(assignment => assignment.status === 'OPEN');
      case 'graded':
        return assignments.filter(assignment => assignment.grades && assignment.grades.length > 0);
      case 'ungraded':
        return assignments.filter(assignment => !assignment.grades || assignment.grades.length === 0);
      case 'overdue':
        return assignments.filter(
          assignment =>
            dayjs().isAfter(dayjs(assignment.assignment.grader_deadline)) &&
            (!assignment.grades || assignment.grades.length === 0)
        );
      case 'all':
        return assignments;
      case 'overview':
      default:
        // Show urgent items: ungraded submitted assignments or overdue grading
        return assignments
          .filter(
            assignment =>
              (assignment.status === 'CLOSED' && (!assignment.grades || assignment.grades.length === 0)) ||
              (dayjs().isAfter(dayjs(assignment.assignment.grader_deadline)) &&
                (!assignment.grades || assignment.grades.length === 0))
          )
          .slice(0, 10);
    }
  };

  const columns = [
    {
      title: 'Owner',
      dataIndex: ['repository'],
      key: 'student',
      render: repo => {
        const user = repo.student ? repo.student : repo.team;
        return <UserThumbnailView user={user} />;
      },
    },
    {
      title: 'Module',
      dataIndex: ['repository', 'module', 'title'],
      key: 'module',
      filters:
        activeTab === 'all'
          ? modules.map(({ title }) => ({ text: title, value: title }))
          : undefined,
      onFilter: (value, record) => {
        return record.repository.module.title === value;
      },
    },
    {
      title: 'Assignment',
      dataIndex: ['assignment', 'title'],
      key: 'assignment',
    },
    {
      title: 'Grade',
      key: 'grades',
      dataIndex: ['grades'],
      filters:
        activeTab === 'all'
          ? [
              ...Object.keys(emojis).map(key => ({
                text: emojis[key].emoji,
                value: key,
              })),
              { text: 'No Grade', value: 'NO_GRADE' },
            ]
          : undefined,
      onFilter: (value, record) => {
        if (value === 'NO_GRADE') {
          return !record.grades.length;
        }
        return record.grades.some(grade => grade.emoji === value);
      },
      render: grades => {
        return <EmojisDisplay grades={grades} />;
      },
    },
    {
      title: 'Status',
      dataIndex: ['status'],
      key: 'status',
      filters:
        activeTab === 'all'
          ? [
              { text: 'Not Submitted', value: 'OPEN' },
              { text: 'Submitted', value: 'CLOSED' },
            ]
          : undefined,
      onFilter: (value, record) => {
        return record.status === value;
      },
      render: status => {
        let color = '';
        let text = '';
        if (status === 'OPEN') {
          color = 'red';
          text = 'Not Submitted';
        } else if (status === 'CLOSED') {
          color = 'green';
          text = 'Submitted';
        }
        return (
          <Tag color={color} bordered={false}>
            {text}
          </Tag>
        );
      },
    },
    {
      title: 'Grading Deadline',
      dataIndex: ['assignment', 'grader_deadline'],
      key: 'deadline',
      render: (deadline, record) => {
        const isOverdue = dayjs().isAfter(dayjs(deadline));
        return (
          <div>
            <Countdown deadline={deadline} />
            {isOverdue && (!record.grades || record.grades.length === 0) && (
              <p className="pt-2 text-sm font-semibold text-red-600">⚠️ Grading overdue</p>
            )}
          </div>
        );
      },
    },
    {
      title: 'Actions',
      key: 'actions',
      render: (_, repoAssignment) => {
        return (
          <TableActionButtons
            onView={
              classroom?.git_organization?.login
                ? () => openRepositoryAssignmentInGithub(classroom.git_organization.login, repoAssignment)
                : undefined
            }
          >
            <EmojiGrader
              repositoryAssignment={{ ...repoAssignment, studentId: repoAssignment.repository.student_id }}
              emojiMappings={emojiMappings}
            />
          </TableActionButtons>
        );
      },
    },
  ];

  // Calculate counts for different categories
  const submittedAssignments = assignmentsList.filter(a => a.status === 'CLOSED');
  const unsubmittedAssignments = assignmentsList.filter(a => a.status === 'OPEN');
  const gradedAssignments = assignmentsList.filter(a => a.grades && a.grades.length > 0);
  const ungradedAssignments = assignmentsList.filter(a => !a.grades || a.grades.length === 0);
  const overdueGrading = assignmentsList.filter(
    a =>
      dayjs().isAfter(dayjs(a.assignment.grader_deadline)) &&
      (!a.grades || a.grades.length === 0)
  );

  const tabItems = [
    {
      key: 'overview',
      label: `📊 Overview`,
      children: (
        <>
          {filterAssignments(assignmentsList, 'overview').length > 0 ? (
            <>
              <div className="mb-4 p-4 bg-orange-50 border border-orange-200 rounded-lg">
                <p className="text-orange-600 text-sm">
                  🚨 Assignments that need grading attention - submitted work or overdue grading
                  deadlines
                </p>
              </div>
              <Table
                columns={columns}
                dataSource={filterAssignments(assignmentsList, activeTab)}
                rowKey={record => record.id}
                rowHoverable={false}
                size="small"
                pagination={false}
              />
            </>
          ) : (
            <div className="text-center py-8 text-gray-500">
              <div className="text-6xl mb-4">🎉</div>
              <h3 className="text-xl font-semibold text-gray-700 mb-2">All caught up!</h3>
              <p>No urgent grading tasks at the moment.</p>
            </div>
          )}
        </>
      ),
    },
    {
      key: 'submitted',
      label: `📝 Submitted (${submittedAssignments.length})`,
      children: (
        <>
          <div className="mb-4 p-4 bg-green-50 border border-green-200 rounded-lg">
            <p className="text-green-600 text-sm">
              ✅ Student work that has been submitted and is ready for grading
            </p>
          </div>
          {filterAssignments(assignmentsList, 'submitted').length > 0 ? (
            <Table
              columns={columns}
              dataSource={filterAssignments(assignmentsList, activeTab)}
              rowKey={record => record.id}
              rowHoverable={false}
              size="small"
              pagination={{ pageSize: 50 }}
            />
          ) : (
            <div className="text-center py-12 text-gray-500">
              <div className="text-6xl mb-4">📝</div>
              <h3 className="text-xl font-semibold text-gray-700 mb-2">No submitted assignments</h3>
              <p>Submitted assignments will appear here</p>
            </div>
          )}
        </>
      ),
    },
    {
      key: 'unsubmitted',
      label: `⏳ Unsubmitted (${unsubmittedAssignments.length})`,
      children: (
        <>
          <div className="mb-4 p-4 bg-blue-50 border border-blue-200 rounded-lg">
            <p className="text-blue-600 text-sm">
              📚 Assignments that students are still working on
            </p>
          </div>
          {filterAssignments(assignmentsList, 'unsubmitted').length > 0 ? (
            <Table
              columns={columns}
              dataSource={filterAssignments(assignmentsList, activeTab)}
              rowKey={record => record.id}
              rowHoverable={false}
              size="small"
              pagination={{ pageSize: 50 }}
            />
          ) : (
            <div className="text-center py-12 text-gray-500">
              <div className="text-6xl mb-4">📚</div>
              <h3 className="text-xl font-semibold text-gray-700 mb-2">
                No unsubmitted assignments
              </h3>
              <p>All assignments have been submitted</p>
            </div>
          )}
        </>
      ),
    },
    {
      key: 'ungraded',
      label: `🔄 Needs Grading (${ungradedAssignments.length})`,
      children: (
        <>
          <div className="mb-4 p-4 bg-yellow-50 border border-yellow-200 rounded-lg">
            <p className="text-yellow-600 text-sm">📋 Assignments that have not been graded yet</p>
          </div>
          {filterAssignments(assignmentsList, 'ungraded').length > 0 ? (
            <Table
              columns={columns}
              dataSource={filterAssignments(assignmentsList, activeTab)}
              rowKey={record => record.id}
              rowHoverable={false}
              size="small"
              pagination={{ pageSize: 50 }}
            />
          ) : (
            <div className="text-center py-12 text-gray-500">
              <div className="text-6xl mb-4">✨</div>
              <h3 className="text-xl font-semibold text-gray-700 mb-2">All assignments graded!</h3>
              <p>Great job staying on top of grading!</p>
            </div>
          )}
        </>
      ),
    },
    {
      key: 'graded',
      label: `✅ Graded (${gradedAssignments.length})`,
      children: (
        <>
          <div className="mb-4 p-4 bg-green-50 border border-green-200 rounded-lg">
            <p className="text-green-600 text-sm">
              🎯 Assignments that have been graded and completed
            </p>
          </div>
          {filterAssignments(assignmentsList, 'graded').length > 0 ? (
            <Table
              columns={columns}
              dataSource={filterAssignments(assignmentsList, activeTab)}
              rowKey={record => record.id}
              rowHoverable={false}
              size="small"
              pagination={{ pageSize: 50 }}
            />
          ) : (
            <div className="text-center py-12 text-gray-500">
              <div className="text-6xl mb-4">📝</div>
              <h3 className="text-xl font-semibold text-gray-700 mb-2">
                No graded assignments yet
              </h3>
              <p>Graded assignments will appear here</p>
            </div>
          )}
        </>
      ),
    },
    {
      key: 'overdue',
      label: `⏰ Overdue Grading (${overdueGrading.length})`,
      children: (
        <>
          <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-lg">
            <p className="text-red-600 text-sm">
              ⚠️ Grading deadlines that have passed and need immediate attention
            </p>
          </div>
          {filterAssignments(assignmentsList, 'overdue').length > 0 ? (
            <Table
              columns={columns}
              dataSource={filterAssignments(assignmentsList, activeTab)}
              rowKey={record => record.id}
              rowHoverable={false}
              size="small"
              pagination={{ pageSize: 50 }}
            />
          ) : (
            <div className="text-center py-12 text-gray-500">
              <div className="text-6xl mb-4">✨</div>
              <h3 className="text-xl font-semibold text-gray-700 mb-2">No overdue grading!</h3>
              <p>You are staying on top of grading deadlines!</p>
            </div>
          )}
        </>
      ),
    },
    {
      key: 'all',
      label: `📋 All (${assignmentsList.length})`,
      children: (
        <>
          <div className="mb-4 p-4 bg-gray-50 border border-gray-200 rounded-lg">
            <p className="text-gray-600 text-sm">
              📊 Complete list of all assignments across all statuses
            </p>
          </div>
          <Table
            columns={columns}
            dataSource={filterAssignments(assignmentsList, activeTab)}
            rowKey={record => record.id}
            rowHoverable={false}
            size="small"
            pagination={{ pageSize: 50 }}
          />
        </>
      ),
    },
  ];

  return (
    <div>
      <div className="flex justify-between items-center pb-4">
        <SearchInput
          query={userQuery}
          setQuery={setUserQuery}
          placeholder="Search by login or name"
        />
        <div className="flex items-start gap-2">
          <p className="font-semibold">Show my assigned only:</p>
          <Switch size="small" onChange={value => setShowMyAssignments(value)} value={showMyAssignments} />
        </div>
      </div>

      <Tabs activeKey={activeTab} onChange={setActiveTab} items={tabItems} size="large" />
    </div>
  );
};

export default RepositoryAssignmentsTable;
