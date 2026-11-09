import { useEffect, useRef, useState } from 'react';
import { Button, ConfigProvider, Drawer, Input, Tag, theme } from 'antd';
import { IconX } from '@tabler/icons-react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import dayjs from 'dayjs';

import { useDarkMode, useGitWeb, useGlobalFetcher, useUser } from '~/hooks';
import Emoji from '~/components/ui/display/Emoji';
import EmojiGradeOptions from '~/components/features/grading/EmojiGradeOptions';
import {
  walkPosition,
  type SubmissionPanelOutletContext,
} from '../admin.$class.grades/gradingWalk';
import type { SubmissionPanelData } from './panel.server';

type Dateish = Date | string | null | undefined;

export type SubmissionPanelProps = {
  data: SubmissionPanelData & { canMutate: boolean };
  context: SubmissionPanelOutletContext;
};

const when = (value: Dateish) => (value ? dayjs(value).format('MMM D, h:mm A') : null);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Keys typed into a field are the field's, not the walk's. */
const isTyping = (target: EventTarget | null) => {
  const el = target as HTMLElement | null;
  if (!el) return false;
  // A radio or checkbox (antd's Segmented) takes no letters.
  const textInput =
    el.tagName === 'INPUT' &&
    !['radio', 'checkbox', 'button', 'submit'].includes((el as HTMLInputElement).type);
  return (
    el.isContentEditable ||
    textInput ||
    ['TEXTAREA', 'SELECT'].includes(el.tagName) ||
    Boolean(el.closest?.('[contenteditable="true"]'))
  );
};

const Section = ({ label, children }: { label?: string; children: React.ReactNode }) => (
  <section className="flex flex-col gap-2">
    {label && (
      <h3 className="text-[11px] font-semibold uppercase tracking-wide text-ink-3">{label}</h3>
    )}
    {children}
  </section>
);

/**
 * Link colours: antd's global anchor colour (the accent green) outranks a
 * plain utility, and is low contrast on the dark panel, so the ink tokens are
 * forced. They switch with the theme.
 */
const LINK = 'text-ink-1! hover:text-ink-0! hover:underline underline-offset-2';
const QUIET_LINK = 'text-ink-2! hover:text-ink-0! hover:underline underline-offset-2';

const ExternalLink = ({ href, children }: { href: string; children: React.ReactNode }) => (
  <a href={href} target="_blank" rel="noreferrer" className={`${LINK} truncate`}>
    {children}
  </a>
);

/**
 * One submission beside the gradebook: who and what, the submission on its
 * git host, autograding, an open regrade request, and the grade picker.
 * Previous / "Next to grade" (J / K) walk the gradebook's queue; Esc closes.
 */
const SubmissionPanel = ({ data, context }: SubmissionPanelProps) => {
  const { submission, who, assignment, analytics, autograding } = data;
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { class: classSlug } = useParams();
  const { isDarkMode } = useDarkMode();
  const web = useGitWeb();
  const { user } = useUser();
  const { fetcher } = useGlobalFetcher();
  // Grading waits while a regrade resolution for this panel is in flight.
  const regradeBusy = Boolean(
    fetcher && fetcher.state !== 'idle' && fetcher.formAction?.includes('updateRegradeRequest')
  );
  const base = `/${pathname.split('/')[1]}/${classSlug}`;

  const position = walkPosition(context.walk, submission.id);
  const close = () => navigate(context.gradesHref, { preventScrollReset: true });
  // The walk replaces the entry, so Back closes the panel rather than
  // stepping back through every submission graded.
  const go = (submissionId: string | undefined) => {
    if (submissionId)
      navigate(context.panelHref(submissionId), { replace: true, preventScrollReset: true });
  };

  // Read through a ref, so the listener is bound once.
  const keys = useRef({ next: () => {}, previous: () => {}, close: () => {} });
  keys.current = {
    next: () => go(position.next?.submissionId),
    previous: () => go(position.previous?.submissionId),
    close,
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
      if (e.key === 'j' || e.key === 'J') keys.current.next();
      else if (e.key === 'k' || e.key === 'K') keys.current.previous();
      else if (e.key === 'Escape') keys.current.close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const graded = submission.grades.length > 0;
  const submitted = submission.status === 'CLOSED';
  const late = submission.is_late && !submission.is_late_override;
  const isPush = assignment.submission_mode === 'REPO';
  const otherGrades = submission.grades.filter(g => g.grader_id !== user?.id);

  const status = data.open_regrade
    ? { color: 'purple', text: 'Regrade requested' }
    : graded
      ? { color: 'green', text: 'Graded' }
      : submitted
        ? { color: late ? 'gold' : 'blue', text: late ? 'Late · to grade' : 'To grade' }
        : { color: 'default', text: 'Not submitted' };

  // Late hours count to "now" until there is a submission, so they show only
  // once there is one.
  const lateLine = [
    submitted && late && submission.num_late_hours > 0
      ? `Late by ${plural(submission.num_late_hours, 'hour')}`
      : null,
    submission.is_late_override ? 'Late penalty waived' : null,
    submission.extension_hours > 0
      ? `${plural(submission.extension_hours, 'hour')} extension`
      : null,
  ].filter(Boolean);

  const repoUrl = web.repo(submission.repo_name);
  const issueNumber = submission.provider_issue_number;
  const commit = data.submitted_commit;

  const passed = autograding?.passed_tests ?? 0;
  const total = autograding?.total_tests ?? 0;
  const allPassed = total > 0 && passed === total;

  const title = who.kind === 'team' ? who.name : (who.name ?? who.login ?? 'Student');
  const subtitle =
    who.kind === 'team'
      ? who.members
          .map(m => m.name ?? m.login ?? '')
          .filter(Boolean)
          .join(', ')
      : who.login
        ? `@${who.login}`
        : null;

  return (
    <ConfigProvider
      theme={{ algorithm: isDarkMode ? theme.darkAlgorithm : theme.defaultAlgorithm }}
    >
      <Drawer
        open
        onClose={close}
        // The gradebook stays usable beside the panel: clicking another cell
        // switches the panel.
        mask={false}
        // Esc is handled with J / K below, so it works wherever focus is.
        keyboard={false}
        width="min(420px, 100vw)"
        closeIcon={<IconX className="text-ink-1" size={18} />}
        data-testid="submission-panel"
        title={
          <div className="flex items-start justify-between gap-3 min-w-0">
            <div className="flex items-center gap-2.5 min-w-0">
              {who.kind === 'student' && who.avatar_url && (
                <img
                  src={who.avatar_url}
                  alt=""
                  className="h-8 w-8 shrink-0 rounded-full ring-1 ring-line"
                />
              )}
              <div className="flex flex-col min-w-0">
                <span className="truncate text-sm font-semibold text-ink-0">{title}</span>
                {subtitle && (
                  <span className="truncate text-xs font-normal text-ink-3">{subtitle}</span>
                )}
              </div>
            </div>
            <span
              className="shrink-0 pt-0.5 text-xs font-medium text-ink-3 tabular-nums"
              data-testid="submission-panel-position"
            >
              {position.index !== null
                ? `${position.index} of ${position.total} · ${position.left} left`
                : `${position.left} left`}
            </span>
          </div>
        }
        footer={
          <div className="flex items-center justify-between gap-3">
            <Button
              onClick={keys.current.previous}
              disabled={!position.previous}
              data-testid="submission-panel-previous"
            >
              Previous
            </Button>
            <span className="text-xs text-ink-3">J / K</span>
            <ConfigProvider theme={{ token: { colorPrimary: '#16a34a' } }}>
              <Button
                type="primary"
                onClick={keys.current.next}
                disabled={!position.next}
                data-testid="submission-panel-next"
              >
                Next to grade
              </Button>
            </ConfigProvider>
          </div>
        }
      >
        <div className="flex flex-col gap-5" key={submission.id}>
          <Section>
            <div className="flex flex-col gap-1">
              <span className="text-base font-semibold text-ink-0">{assignment.title}</span>
              <span className="text-xs text-ink-3">
                {assignment.module_title ? `${assignment.module_title} · ` : ''}
                {assignment.weight}%{assignment.is_extra_credit ? ' extra credit' : ''}
                {assignment.student_deadline ? ` · due ${when(assignment.student_deadline)}` : ''}
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs text-ink-2">
              <Tag color={status.color} className="m-0" data-testid="submission-panel-status">
                {status.text}
              </Tag>
              {submitted && submission.closed_at && (
                <span>Submitted {when(submission.closed_at)}</span>
              )}
            </div>
            {lateLine.length > 0 && (
              <span
                className={`text-xs ${late ? 'text-amber-700 dark:text-amber-300' : 'text-ink-3'}`}
              >
                {lateLine.join(' · ')}
              </span>
            )}
          </Section>

          <Section label="Submission">
            <div className="flex flex-col gap-1.5 rounded-lg ring-1 ring-line p-3 text-sm">
              {!isPush && issueNumber != null ? (
                <ExternalLink href={web.issue(submission.repo_name, issueNumber)}>
                  {web.terms.Issue} #{issueNumber} · {submission.repo_name}
                </ExternalLink>
              ) : (
                <ExternalLink href={repoUrl}>{submission.repo_name}</ExternalLink>
              )}
              {isPush && commit && (
                <span className="flex items-baseline gap-2 min-w-0 text-xs">
                  <a
                    href={web.commit(submission.repo_name, commit.sha)}
                    target="_blank"
                    rel="noreferrer"
                    className={`font-mono shrink-0 ${LINK}`}
                    data-testid="submission-panel-commit"
                  >
                    {commit.sha.slice(0, 7)}
                  </a>
                  {commit.message && (
                    <span className="truncate text-ink-2">{commit.message.split('\n')[0]}</span>
                  )}
                </span>
              )}
              {analytics && (
                <span className="text-xs text-ink-3">
                  {plural(analytics.total_commits, 'commit')} · +{analytics.total_additions} −
                  {analytics.total_deletions}
                  {analytics.last_commit_at ? ` · last ${when(analytics.last_commit_at)}` : ''}
                </span>
              )}
              {who.kind === 'team' && analytics && analytics.contributors.length > 0 && (
                <span className="text-xs text-ink-3">
                  {(() => {
                    // Authors known by name or login; the rest (an address
                    // in place of a login) summed as "others".
                    const nameOf = (c: (typeof analytics.contributors)[number]) =>
                      who.members.find(m => m.id === c.user_id)?.name ?? c.login;
                    const named = analytics.contributors.flatMap(c =>
                      nameOf(c) ? [`${nameOf(c)} ${c.commits}`] : []
                    );
                    const others = analytics.contributors
                      .filter(c => !nameOf(c))
                      .reduce((n, c) => n + c.commits, 0);
                    return [...named, ...(others > 0 ? [`others ${others}`] : [])].join(' · ');
                  })()}
                </span>
              )}
            </div>
            <div className="flex items-center gap-4 text-xs font-medium">
              {assignment.instructions && (
                <Link to={`${base}/pages/${assignment.instructions.id}`} className={QUIET_LINK}>
                  Instructions
                </Link>
              )}
              <Link to={`${base}/submissions/${submission.id}`} className={QUIET_LINK}>
                All activity
              </Link>
            </div>
          </Section>

          {autograding && (
            <Section label="Autograding">
              <div className="flex items-center gap-3" data-testid="submission-panel-autograding">
                <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-stone-200 dark:bg-neutral-700">
                  <div
                    className={`h-full rounded-full ${allPassed ? 'bg-green-500' : 'bg-red-500'}`}
                    style={{ width: total > 0 ? `${(passed / total) * 100}%` : '0%' }}
                  />
                </div>
                <span className="text-xs font-semibold tabular-nums text-ink-1">
                  {total > 0 ? `${passed}/${total}` : autograding.conclusion}
                </span>
                {/* The commit the run tested. */}
                <span
                  className="font-mono text-xs text-ink-3"
                  data-testid="submission-panel-autograding-sha"
                >
                  {autograding.commit_sha.slice(0, 7)}
                </span>
                {autograding.run_id && (
                  <a
                    href={web.actionsRun(submission.repo_name, autograding.run_id)}
                    target="_blank"
                    rel="noreferrer"
                    className={`text-xs ${QUIET_LINK}`}
                  >
                    View run
                  </a>
                )}
              </div>
            </Section>
          )}

          {data.open_regrade && (
            <RegradeBox
              key={data.open_regrade.id}
              request={data.open_regrade}
              currentGrades={submission.grades.map(g => g.emoji)}
              canMutate={data.canMutate}
            />
          )}

          <Section label="Grade">
            {otherGrades.length > 0 && (
              <div className="flex flex-wrap items-center gap-3 text-xs text-ink-2">
                {otherGrades.map(g => (
                  <span key={g.id} className="inline-flex items-center gap-1">
                    <Emoji emoji={g.emoji} fontSize={16} />
                    {g.grader?.name ?? ''}
                  </span>
                ))}
              </div>
            )}
            {data.canMutate ? (
              <EmojiGradeOptions
                repositoryAssignment={{
                  id: submission.id,
                  assignment_id: assignment.id,
                  studentId: submission.student_id ?? undefined,
                  teamId: submission.team_id ?? undefined,
                  grades: submission.grades,
                  repository: { name: submission.repo_name },
                }}
                emojiMappings={context.emojiMappings}
                testId="submission-panel-grade-options"
                className="flex flex-wrap gap-1.5"
                // The other graders' grades are listed above: a click here
                // selects or removes the viewer's own only.
                viewerGradesOnly
                disabled={regradeBusy}
              />
            ) : (
              !graded && <span className="text-xs text-ink-3">No grade yet</span>
            )}
          </Section>
        </div>
      </Drawer>
    </ConfigProvider>
  );
};

/** An open regrade request: the student's comment, a reply, and the two resolutions. */
const RegradeBox = ({
  request,
  currentGrades,
  canMutate,
}: {
  request: NonNullable<SubmissionPanelData['open_regrade']>;
  currentGrades: string[];
  canMutate: boolean;
}) => {
  const { fetcher } = useGlobalFetcher();
  const [reply, setReply] = useState('');
  const busy = Boolean(fetcher && fetcher.state !== 'idle');

  const resolve = (status: 'APPROVED' | 'DENIED') => {
    if (busy) return;
    fetcher!.submit(
      {
        request: { id: request.id },
        status,
        ...(reply.trim() ? { comment: reply.trim() } : {}),
      },
      {
        method: 'post',
        action: `/api/operation/?action=updateRegradeRequest`,
        encType: 'application/json',
      }
    );
  };

  return (
    <section
      className="flex flex-col gap-2 rounded-lg p-3 ring-1 ring-violet-200 bg-violet-50/60 dark:ring-violet-900 dark:bg-violet-950/30"
      data-testid="submission-panel-regrade"
    >
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="font-semibold text-violet-700 dark:text-violet-300">
          Regrade requested {dayjs(request.created_at).format('MMM D')}
        </span>
        {request.previous_grade.length > 0 && (
          <span className="inline-flex items-center gap-1 text-ink-3">
            was
            {request.previous_grade.map((emoji, i) => (
              <Emoji key={`${emoji}-${i}`} emoji={emoji} fontSize={14} />
            ))}
            {currentGrades.length > 0 && (
              <>
                {' '}
                now
                {currentGrades.map((emoji, i) => (
                  <Emoji key={`now-${emoji}-${i}`} emoji={emoji} fontSize={14} />
                ))}
              </>
            )}
          </span>
        )}
      </div>
      {request.student_comment && (
        <p className="m-0 whitespace-pre-wrap text-sm text-ink-1">{request.student_comment}</p>
      )}
      {canMutate && (
        <>
          <Input.TextArea
            value={reply}
            onChange={e => setReply(e.target.value)}
            placeholder="Reply to the student"
            autoSize={{ minRows: 2, maxRows: 6 }}
            data-testid="submission-panel-regrade-reply"
          />
          <div className="flex items-center gap-2">
            <Button
              type="primary"
              size="small"
              loading={busy}
              onClick={() => resolve('APPROVED')}
              data-testid="submission-panel-regrade-approve"
            >
              Approve
            </Button>
            <Button
              size="small"
              disabled={busy}
              onClick={() => resolve('DENIED')}
              data-testid="submission-panel-regrade-deny"
            >
              Deny, keep grade
            </Button>
          </div>
        </>
      )}
    </section>
  );
};

export default SubmissionPanel;
