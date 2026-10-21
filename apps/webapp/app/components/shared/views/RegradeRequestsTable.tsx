import { useState } from 'react';
import { Table, Button, Tag } from 'antd';
import dayjs from 'dayjs';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { IconEye } from '@tabler/icons-react';
import { useGitContext } from '~/hooks/useGitWeb';
import { useGlobalFetcher, useRole } from '~/hooks';
import Emoji from '~/components/ui/display/Emoji';
import EmojiGrader from '~/components/features/grading/EmojiGrader';
import TableActionButtons from '~/components/ui/buttons/TableActionButtons';
import UserThumbnailView from '~/components/features/profile/UserThumbnailView';
import { openRepositoryAssignmentInGithub } from '~/utils/helpers.client';
import GradeBadges from '~/components/features/grading/GradeBadges';
import QuizGradeEmoji from '~/components/features/quiz/QuizGradeEmoji';
import ResolveQuizRegradeModal from '~/components/features/regrade/ResolveQuizRegradeModal';
import { quizRequestLabel, type RegradeRequestRowData } from '~/components/features/regrade/types';

export type { RegradeRequestRowData } from '~/components/features/regrade/types';

interface RegradeRequestsTableProps {
  requests: RegradeRequestRowData[];
  /** The classroom's scale (emoji → grade). Staff views only. */
  emojiMappings?: Record<string, number>;
  /** `late_penalty_points_per_hour`, for the resolve modal's Counted line. */
  latePenaltyPerHour?: number;
  org?: string | null;
}

const STATUS_LABEL: Record<string, string> = {
  IN_REVIEW: 'In Review',
  APPROVED: 'Resolved',
  DENIED: 'Denied',
};

/** The remedy a resolved quiz request got, under its status tag. */
const quizRemedy = (status: string) =>
  status === 'APPROVED' ? 'Score adjusted' : status === 'DENIED' ? 'Score kept' : null;

/** The text-link style of the repo row's own actions (View, Resolve). */
const viewLinkClass =
  'flex items-center gap-1 text-gray-600 hover:text-gray-800 dark:text-gray-300 dark:hover:text-gray-100 cursor-pointer';
const resolveLinkClass =
  'flex items-center gap-1 text-green-600 hover:text-green-700 dark:text-green-500 dark:hover:text-green-400 cursor-pointer whitespace-nowrap';

const fmtDate = (value: string | Date | null | undefined) =>
  value ? dayjs(value).format('MMM D') : null;

const RegradeRequestsTable = ({
  requests,
  emojiMappings,
  latePenaltyPerHour = 0,
  org,
}: RegradeRequestsTableProps) => {
  const gitCtx = useGitContext();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { role } = useRole();
  const { class: classSlug } = useParams();
  const { fetcher } = useGlobalFetcher();
  const [resolving, setResolving] = useState<RegradeRequestRowData | null>(null);

  const isStudent = role === 'STUDENT';
  // The attempt drawer on the quiz results page, under the viewer's own
  // prefix (/admin, /teacher or /assistant); a student opens their attempt.
  const rolePrefix = isStudent ? 'student' : pathname.split('/')[1] || 'admin';
  const attemptHref = (quiz: NonNullable<RegradeRequestRowData['quiz']>) =>
    `/${rolePrefix}/${classSlug}/quizzes/${quiz.quizId}/attempt/${quiz.attemptId}`;

  const columns = [
    {
      title: 'Student',
      dataIndex: 'student',
      key: 'student',
      width: 220,
      fixed: 'left' as const,
      hidden: isStudent,
      render: (student: RegradeRequestRowData['student']) => (
        <UserThumbnailView user={{ ...student, avatar_url: student.image ?? null }} />
      ),
    },
    {
      title: 'Requests',
      dataIndex: 'student',
      key: 'student_count',
      width: 90,
      align: 'center' as const,
      hidden: isStudent,
      render: (student: RegradeRequestRowData['student']) => (
        <span className="font-semibold text-gray-700 dark:text-gray-300">
          {student._count.regrade_requests}
        </span>
      ),
    },
    {
      title: 'Assignment',
      key: 'assignment',
      width: 260,
      render: (_: unknown, request: RegradeRequestRowData) =>
        request.quiz ? (
          <div className="flex items-center gap-2 min-w-0">
            <Tag color="purple" className="uppercase text-[11px] m-0">
              Quiz
            </Tag>
            <span className="truncate font-medium text-ink-1">
              {quizRequestLabel(request.quiz)}
            </span>
          </div>
        ) : (
          <div className="truncate font-medium text-ink-1">
            {request.git_repo_assignment?.assignment.title}
          </div>
        ),
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 120,
      render: (status: RegradeRequestRowData['status'], request: RegradeRequestRowData) => {
        const remedy = request.quiz ? quizRemedy(status) : null;
        return (
          <div>
            <Tag
              color={status === 'IN_REVIEW' ? 'orange' : status === 'APPROVED' ? 'green' : 'red'}
              className="font-semibold"
            >
              {STATUS_LABEL[status] ?? status}
            </Tag>
            {remedy && <div className="text-xs text-ink-3 mt-1 whitespace-nowrap">{remedy}</div>}
          </div>
        );
      },
    },
    {
      title: 'New Grade',
      key: 'new_grade',
      width: 120,
      align: 'center' as const,
      render: (_: unknown, request: RegradeRequestRowData) =>
        request.quiz ? (
          <div className="flex justify-center">
            {request.status === 'APPROVED' ? (
              <QuizGradeEmoji emoji={request.quiz.effectiveEmoji} size="lg" />
            ) : (
              <span className="text-gray-400 dark:text-gray-500">—</span>
            )}
          </div>
        ) : (
          <div className="flex justify-center">
            <GradeBadges
              grades={request.git_repo_assignment?.grades}
              emojiMappings={emojiMappings ?? {}}
            />
          </div>
        ),
    },
    {
      title: 'Previous Grade',
      dataIndex: 'previous_grade',
      key: 'previous_grade',
      width: 130,
      align: 'center' as const,
      render: (previousGrade: string[], request: RegradeRequestRowData) =>
        request.quiz ? (
          <div className="flex justify-center">
            <QuizGradeEmoji emoji={previousGrade[0] ?? null} size="lg" />
          </div>
        ) : (
          <div className="flex gap-2 justify-center">
            {previousGrade.map((grade: string) => (
              <Emoji emoji={grade} size="lg" key={grade} />
            ))}
          </div>
        ),
    },
    {
      title: 'Student Comment',
      dataIndex: 'student_comment',
      key: 'student_comment',
      render: (comment: string | null, request: RegradeRequestRowData) => {
        const replyBy =
          request.status === 'APPROVED' ? (request.quiz?.adjustedByName ?? null) : null;
        const replyMeta = [replyBy, fmtDate(request.updated_at)].filter(Boolean).join(' · ');
        return (
          <div className="text-gray-700 dark:text-gray-300 max-w-md">
            {comment ? (
              <div className={isStudent ? 'whitespace-pre-wrap break-words' : 'truncate'}>
                {comment}
              </div>
            ) : (
              <span className="text-gray-400 italic">No comment</span>
            )}
            {/* The staff reply, for the student who asked. */}
            {isStudent && request.status !== 'IN_REVIEW' && request.grader_comment && (
              <div
                data-testid="regrade-staff-reply"
                className="mt-1.5 pl-2.5 border-l-2 border-stone-200 dark:border-neutral-700"
              >
                {replyMeta && <div className="text-xs text-ink-3">{replyMeta}</div>}
                <div className="text-ink-1 whitespace-pre-wrap break-words">
                  {request.grader_comment}
                </div>
              </div>
            )}
          </div>
        );
      },
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 200,
      render: (_: unknown, request: RegradeRequestRowData) => {
        if (request.quiz) {
          const quiz = request.quiz;
          return (
            <div className="flex gap-3 items-center whitespace-nowrap">
              <Link
                to={attemptHref(quiz)}
                className={viewLinkClass}
                data-testid="regrade-quiz-view"
              >
                <IconEye size={17} />
                <span>View</span>
              </Link>
              {!isStudent && request.status === 'IN_REVIEW' && (
                <div
                  role="button"
                  tabIndex={0}
                  data-testid="regrade-quiz-resolve"
                  onClick={() => setResolving(request)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') setResolving(request);
                  }}
                  className={resolveLinkClass}
                >
                  <span>Resolve</span>
                </div>
              )}
            </div>
          );
        }

        const submission = request.git_repo_assignment;
        return (
          <TableActionButtons
            onView={
              org && submission?.git_repo
                ? () =>
                    openRepositoryAssignmentInGithub(gitCtx, {
                      ...submission,
                      provider_issue_number: submission.provider_issue_number ?? undefined,
                    })
                : undefined
            }
          >
            {!isStudent && submission && (
              <EmojiGrader
                repositoryAssignment={{
                  ...submission,
                  studentId: request.student_id,
                }}
                emojiMappings={emojiMappings ?? {}}
              />
            )}
            {request.status === 'IN_REVIEW' && !isStudent && submission && (
              <div
                onClick={() => {
                  fetcher!.submit(
                    {
                      request: {
                        id: request.id,
                        student_id: request.student_id,
                        git_repo_assignment: {
                          id: submission.id,
                        },
                      },
                      status: 'APPROVED',
                    },
                    {
                      method: 'post',
                      action: `/api/operation/?action=updateRegradeRequest`,
                      encType: 'application/json',
                    }
                  );
                }}
                className={resolveLinkClass}
              >
                <span>Resolve</span>
              </div>
            )}
          </TableActionButtons>
        );
      },
    },
  ];

  return (
    <div className="min-h-full">
      <div className="flex items-center justify-between gap-3 mt-2 mb-4">
        <h1 className="text-base font-semibold text-ink-2">Regrade/Resubmit Requests</h1>
        {isStudent && (
          <Button
            onClick={() => navigate(`/student/${classSlug}/regrade-requests/new`)}
            type="primary"
            data-tour="regrade-new"
          >
            Request regrade/resubmit
          </Button>
        )}
      </div>

      <div className="rounded-2xl overflow-hidden bg-panel min-h-[calc(100vh-10rem)] p-5 sm:p-6">
        <Table
          rowKey="id"
          dataSource={requests}
          columns={columns.filter(col => !col.hidden)}
          size="middle"
          rowHoverable={false}
          scroll={{ x: 'max-content' }}
          pagination={{
            pageSize: 20,
            showSizeChanger: true,
            showQuickJumper: true,
            showTotal: (total, range) => `${range[0]}-${range[1]} of ${total} requests`,
          }}
          locale={{
            emptyText: (
              <div className="text-center py-12 text-gray-500">
                <div className="font-medium">No regrade/resubmit requests yet</div>
                <div className="text-sm">
                  {isStudent
                    ? 'Submit your first request to get started.'
                    : "Students haven't submitted any requests yet."}
                </div>
              </div>
            ),
          }}
        />
      </div>

      {!isStudent && (
        <ResolveQuizRegradeModal
          request={resolving}
          scale={emojiMappings ?? {}}
          latePenaltyPerHour={latePenaltyPerHour}
          onClose={() => setResolving(null)}
        />
      )}
    </div>
  );
};

export default RegradeRequestsTable;
