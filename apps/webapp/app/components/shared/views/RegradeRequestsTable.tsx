import { useEffect, useRef, useState } from 'react';
import { Table, Button, Tag } from 'antd';
import dayjs from 'dayjs';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router';
import { IconEye } from '@tabler/icons-react';
import { useGitContext } from '~/hooks/useGitWeb';
import { useGlobalFetcher, useRole } from '~/hooks';
import Emoji from '~/components/ui/display/Emoji';
import EmojiGrader from '~/components/features/grading/EmojiGrader';
import TableActionButtons from '~/components/ui/buttons/TableActionButtons';
import UserThumbnailView from '~/components/features/profile/UserThumbnailView';
import { openRepositoryAssignmentInGithub } from '~/utils/helpers.client';
import GradeBadges from '~/components/features/grading/GradeBadges';
import ResolveQuizRegradeModal from '~/components/features/regrade/ResolveQuizRegradeModal';
import { quizRequestLabel, type RegradeRequestRowData } from '~/components/features/regrade/types';
import { QUIZ_STATUS_LABEL, QuizRemedy } from '~/components/features/regrade/QuizRemedy';

export type { RegradeRequestRowData } from '~/components/features/regrade/types';

interface RegradeRequestsTableProps {
  requests: RegradeRequestRowData[];
  /** The classroom's scale (emoji → grade). Staff views only. */
  emojiMappings?: Record<string, number>;
  /** `late_penalty_points_per_hour`, for the resolve modal's Counted line. */
  latePenaltyPerHour?: number;
  org?: string | null;
  /**
   * Staff: the classroom takes changes from this viewer (not LOCKED or
   * UNPUBLISHED for a non-owner). False hides Resolve and the grade picker.
   */
  canResolve?: boolean;
}

const STATUS_LABEL: Record<string, string> = {
  IN_REVIEW: 'In Review',
  APPROVED: 'Resolved',
  DENIED: 'Denied',
};

/** The text-link style of the repo row's own actions (View, Resolve). */
const viewLinkClass =
  'flex items-center gap-1 text-gray-600 hover:text-gray-800 dark:text-gray-300 dark:hover:text-gray-100 cursor-pointer';
const resolveLinkClass =
  'flex items-center gap-1 text-green-600 hover:text-green-700 dark:text-green-500 dark:hover:text-green-400 cursor-pointer whitespace-nowrap';

/**
 * What a request is on: a QUIZ attempt or a REPOSITORY submission. The design
 * system's `.chip` tones (mint / peach), which carry their own dark-mode
 * colours, at the small size the queue's mockup uses.
 */
const KindChip = ({ kind }: { kind: 'quiz' | 'repository' }) => (
  <span
    data-testid={`regrade-kind-${kind}`}
    className={`chip shrink-0 ${kind === 'quiz' ? 'chip-quiz' : 'chip-asgn'}`}
    style={{ fontSize: '0.625rem', padding: '0 6px' }}
  >
    {kind === 'quiz' ? 'Quiz' : 'Repository'}
  </span>
);

const fmtDate = (value: string | Date | null | undefined) =>
  value ? dayjs(value).format('MMM D') : null;

const RegradeRequestsTable = ({
  requests,
  emojiMappings,
  latePenaltyPerHour = 0,
  org,
  canResolve = true,
}: RegradeRequestsTableProps) => {
  const gitCtx = useGitContext();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { role } = useRole();
  const { class: classSlug } = useParams();
  const { fetcher } = useGlobalFetcher();
  const [resolving, setResolving] = useState<RegradeRequestRowData | null>(null);
  const [searchParams, setSearchParams] = useSearchParams();
  // The repo request whose Resolve is in flight: its link stays disabled
  // until the global fetcher settles, so a double click submits once.
  const [repoResolving, setRepoResolving] = useState<string | null>(null);
  const fetcherBusy = Boolean(fetcher && fetcher.state !== 'idle');
  const repoBusy = repoResolving !== null || fetcherBusy;
  const sawBusy = useRef(false);

  const isStudent = role === 'STUDENT';
  const staffCanResolve = !isStudent && canResolve;

  // `?resolve=<requestId>` (the attempt drawer's link) opens that open quiz
  // request's resolve modal on load; the param goes once it has been read.
  const resolveParam = searchParams.get('resolve');
  useEffect(() => {
    if (!resolveParam) return;
    const target = requests.find(r => r.id === resolveParam && r.quiz && r.status === 'IN_REVIEW');
    if (target && staffCanResolve) setResolving(target);
    setSearchParams(
      prev => {
        const next = new URLSearchParams(prev);
        next.delete('resolve');
        return next;
      },
      { replace: true }
    );
    // Runs when the param appears; `requests` is the loader's list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resolveParam]);

  // Clear the in-flight Resolve once the submission has run and settled.
  useEffect(() => {
    if (fetcherBusy) sawBusy.current = true;
    else if (sawBusy.current) {
      sawBusy.current = false;
      setRepoResolving(null);
    }
  }, [fetcherBusy]);
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
      render: (_: unknown, request: RegradeRequestRowData) => (
        <div className="flex items-center gap-2 min-w-0">
          <KindChip kind={request.quiz ? 'quiz' : 'repository'} />
          <span className="truncate font-medium text-ink-1">
            {request.quiz
              ? quizRequestLabel(request.quiz)
              : request.git_repo_assignment?.assignment.title}
          </span>
        </div>
      ),
    },
    {
      title: 'Status',
      dataIndex: 'status',
      key: 'status',
      width: 120,
      render: (status: RegradeRequestRowData['status'], request: RegradeRequestRowData) => {
        const labels = request.quiz ? QUIZ_STATUS_LABEL : STATUS_LABEL;
        return (
          <div>
            <Tag
              color={status === 'IN_REVIEW' ? 'orange' : status === 'APPROVED' ? 'green' : 'red'}
              className="font-semibold"
            >
              {labels[status] ?? status}
            </Tag>
            {request.quiz && status !== 'IN_REVIEW' && (
              <div className="text-xs text-ink-3 mt-1">
                <QuizRemedy
                  status={status}
                  previousEmoji={request.previous_grade[0] ?? null}
                  resolvedEmoji={request.quiz.resolvedEmoji}
                />
              </div>
            )}
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
            {request.status === 'APPROVED' && request.quiz.resolvedEmoji ? (
              // The repo row's GradeBadges size, so both rows read alike.
              <div className="p-0.5">
                <Emoji emoji={request.quiz.resolvedEmoji} fontSize={18} className="block" />
              </div>
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
            {/* The repo row's previous-grade size. */}
            {previousGrade[0] ? (
              <Emoji emoji={previousGrade[0]} size="lg" />
            ) : (
              <span className="text-gray-400 dark:text-gray-500">—</span>
            )}
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
        // Who resolved it and when, from the request itself. Rows resolved
        // before that was recorded name no one.
        const replyMeta = [request.resolved_by_name ?? null, fmtDate(request.resolved_at ?? null)]
          .filter(Boolean)
          .join(' · ');
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
              {staffCanResolve && request.status === 'IN_REVIEW' && (
                <div
                  role="button"
                  tabIndex={0}
                  data-testid="regrade-quiz-resolve"
                  onClick={() => setResolving(request)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      // Space would otherwise scroll the page.
                      e.preventDefault();
                      setResolving(request);
                    }
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
        const resolveRepo = () => {
          if (repoBusy || !submission) return;
          setRepoResolving(request.id);
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
        };
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
            {staffCanResolve && submission && (
              <EmojiGrader
                repositoryAssignment={{
                  ...submission,
                  studentId: request.student_id,
                }}
                emojiMappings={emojiMappings ?? {}}
              />
            )}
            {request.status === 'IN_REVIEW' && staffCanResolve && submission && (
              <div
                role="button"
                tabIndex={0}
                aria-disabled={repoBusy}
                data-testid="regrade-repo-resolve"
                onClick={resolveRepo}
                onKeyDown={e => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    // Space would otherwise scroll the page.
                    e.preventDefault();
                    resolveRepo();
                  }
                }}
                className={`${resolveLinkClass} ${repoBusy ? 'pointer-events-none opacity-50' : ''}`}
              >
                <span>{repoResolving === request.id && repoBusy ? 'Resolving…' : 'Resolve'}</span>
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

      {staffCanResolve && (
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
