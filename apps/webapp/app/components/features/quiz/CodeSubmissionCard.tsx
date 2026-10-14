import { memo, useMemo } from 'react';
import { Tag } from 'antd';
import { CloseCircleOutlined, CodeOutlined } from '@ant-design/icons';
import type { CodeSubmissionData } from '@classmoji/utils/quiz-agent';

/**
 * CodeSubmissionCard: a student's code submission as their chat message (the
 * student's chat, the staff preview and the staff transcript alike).
 *
 * "Submitted code · Attempt k", then one diff per changed file against what
 * the sandbox started from (its seed, found by sandbox id: the card's starter
 * or, for a hint sandbox, the previous submission), with a line of context
 * around each change; a file of more than `DIFF_LINE_CAP` lines on either
 * side shows whole instead. Then the console the student's browser reported
 * and any error. What it shows comes from the part alone (and the seed), so
 * the browser's own copy and the stored one after a reload read the same.
 */

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';

/** Above this many lines on either side, a file shows whole instead of as a diff. */
export const DIFF_LINE_CAP = 400;

export type DiffRow =
  | { t: ' ' | '+' | '-'; s: string; ln: number }
  /** Unchanged lines left out. */
  | { t: '…' };

/** A line diff of `before` → `after` by longest common subsequence (Github's colours, the mockup's rows). */
export function lineDiff(before: string, after: string): Extract<DiffRow, { ln: number }>[] {
  const A = before.split('\n');
  const B = after.split('\n');
  const n = A.length;
  const m = B.length;
  const dp = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out: Extract<DiffRow, { ln: number }>[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      out.push({ t: ' ', s: B[j], ln: j + 1 });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      out.push({ t: '-', s: A[i], ln: i + 1 });
      i++;
    } else {
      out.push({ t: '+', s: B[j], ln: j + 1 });
      j++;
    }
  }
  while (i < n) out.push({ t: '-', s: A[i], ln: ++i });
  while (j < m) out.push({ t: '+', s: B[j], ln: ++j });
  return out;
}

/** The diff's changed lines with `context` lines around each; each run left out becomes one gap row. */
export function hunks(diff: Extract<DiffRow, { ln: number }>[], context = 1): DiffRow[] {
  const keep = diff.map(() => false);
  diff.forEach((d, k) => {
    if (d.t === ' ') return;
    for (let x = Math.max(0, k - context); x <= Math.min(diff.length - 1, k + context); x++) {
      keep[x] = true;
    }
  });
  const rows: DiffRow[] = [];
  let gap = false;
  diff.forEach((d, k) => {
    if (keep[k]) {
      rows.push(d);
      gap = false;
    } else if (!gap) {
      rows.push({ t: '…' });
      gap = true;
    }
  });
  return rows;
}

const lineCount = (text: string) => text.split('\n').length;

/** The rows a file shows: its diff, or the whole new file (no seed, or too long to diff). */
export function fileRows(
  before: string | null,
  after: string
): { rows: DiffRow[]; whole: boolean } {
  if (before === null || lineCount(before) > DIFF_LINE_CAP || lineCount(after) > DIFF_LINE_CAP) {
    return {
      rows: after.split('\n').map((s, i) => ({ t: ' ' as const, s, ln: i + 1 })),
      whole: true,
    };
  }
  return { rows: hunks(lineDiff(before, after)), whole: false };
}

const rowClass = (t: DiffRow['t']) =>
  t === '+'
    ? 'bg-[#e6ffec] text-[#1a7f37] dark:bg-[rgba(46,160,67,0.15)] dark:text-[#3fb950]'
    : t === '-'
      ? 'bg-[#ffebe9] text-[#cf222e] dark:bg-[rgba(248,81,73,0.15)] dark:text-[#f85149]'
      : t === '…'
        ? 'bg-[#f6f8fa] text-[#8c959f] dark:bg-[#161b22] dark:text-[#6e7681]'
        : '';

const FileDiff = memo(function FileDiff({
  path,
  before,
  after,
}: {
  path: string;
  before: string | null;
  after: string;
}) {
  const { rows, whole } = useMemo(() => fileRows(before, after), [before, after]);
  const added = whole ? 0 : rows.filter(r => r.t === '+').length;
  const removed = whole ? 0 : rows.filter(r => r.t === '-').length;
  return (
    <div
      className="overflow-hidden rounded-md border border-[#d0d7de] bg-white dark:border-[#30363d] dark:bg-[#0d1117]"
      data-testid="quiz-submission-file"
      data-path={path}
    >
      <div className="flex items-center justify-between gap-3 border-b border-[#d0d7de] px-2.5 py-1 text-xs dark:border-[#30363d]">
        <span className="truncate text-gray-700 dark:text-gray-300" style={{ fontFamily: MONO }}>
          {path.replace(/^\//, '')}
        </span>
        {whole ? null : (
          <span className="shrink-0" style={{ fontFamily: MONO }}>
            <span className="text-[#1a7f37] dark:text-[#3fb950]">+{added}</span>{' '}
            <span className="text-[#cf222e] dark:text-[#f85149]">−{removed}</span>
          </span>
        )}
      </div>
      <div
        className="overflow-x-auto py-1 text-[12px] leading-[1.55] text-gray-800 dark:text-gray-200"
        style={{ fontFamily: MONO }}
      >
        {rows.map((r, k) =>
          r.t === '…' ? (
            <div key={k} className={`flex whitespace-pre ${rowClass(r.t)}`}>
              <span className="w-[26px] flex-none pr-2 text-right opacity-45 select-none" />
              <span className="w-4 flex-none text-center opacity-80 select-none">⋯</span>
            </div>
          ) : (
            <div key={k} className={`flex whitespace-pre ${rowClass(r.t)}`} data-diff={r.t}>
              <span className="w-[26px] flex-none pr-2 text-right opacity-45 select-none">
                {r.ln}
              </span>
              <span className="w-4 flex-none text-center opacity-80 select-none">
                {r.t === '+' ? '+' : r.t === '-' ? '−' : ''}
              </span>
              <span>{r.s}</span>
            </div>
          )
        )}
      </div>
    </div>
  );
});

const BADGE =
  'inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-full px-1.5 text-[11px] font-semibold';

function ConsoleSummary({ lines }: { lines: CodeSubmissionData['console'] }) {
  const errors = lines.filter(l => l.method === 'error').length;
  const warns = lines.filter(l => l.method === 'warn').length;
  const logs = lines.length - errors - warns;
  return (
    <div
      className="overflow-hidden rounded-md border border-[#d0d7de] bg-white dark:border-[#30363d] dark:bg-[#0d1117]"
      data-testid="quiz-submission-console"
    >
      <div className="flex items-center justify-between border-b border-[#d0d7de] px-2.5 py-1 text-xs last:border-b-0 dark:border-[#30363d]">
        <span className="text-gray-700 dark:text-gray-300">Console</span>
        <span className="flex gap-1.5">
          {errors > 0 && (
            <span
              className={`${BADGE} bg-[#fee2e2] text-[#dc2626] dark:bg-[rgba(220,38,38,0.18)] dark:text-[#f87171]`}
            >
              {errors}
            </span>
          )}
          {warns > 0 && (
            <span
              className={`${BADGE} bg-[#fef3c7] text-[#d97706] dark:bg-[rgba(217,119,6,0.2)] dark:text-[#fbbf24]`}
            >
              {warns}
            </span>
          )}
          {logs > 0 && (
            <span
              className={`${BADGE} bg-[#e0e7ff] text-[#4f46e5] dark:bg-[rgba(99,102,241,0.2)] dark:text-[#a5b4fc]`}
            >
              {logs}
            </span>
          )}
          {lines.length === 0 && (
            <span className={`${BADGE} font-normal text-gray-400 dark:text-gray-500`}>
              No output
            </span>
          )}
        </span>
      </div>
      {lines.length > 0 && (
        <div
          className="overflow-x-auto px-2.5 py-1.5 text-[12px] leading-[1.5]"
          style={{ fontFamily: MONO }}
        >
          {lines.map((l, k) => (
            <div
              key={k}
              className={`whitespace-pre-wrap break-words ${
                l.method === 'error'
                  ? 'text-[#dc2626] dark:text-[#f87171]'
                  : l.method === 'warn'
                    ? 'text-[#b45309] dark:text-[#fbbf24]'
                    : 'text-gray-800 dark:text-gray-200'
              }`}
            >
              {l.text}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export interface CodeSubmissionCardProps {
  submission: CodeSubmissionData;
  /** Its attempt number (the stored one, or worked out from the transcript). */
  attempt: number;
  /** The files its sandbox started from; null when the transcript doesn't hold them. */
  seed: Record<string, string> | null;
  /** Narrow screens: the card takes the column's width. */
  narrow?: boolean;
}

/** The files that changed against the seed: the server's list once stored, else worked out. */
export function changedFilesOf(
  submission: CodeSubmissionData,
  seed: Record<string, string> | null
): string[] {
  if (submission.changed_files) return submission.changed_files;
  const paths = Object.keys(submission.files).sort();
  return seed ? paths.filter(p => seed[p] !== submission.files[p]) : paths;
}

function CodeSubmissionCard({
  submission,
  attempt,
  seed,
  narrow = false,
}: CodeSubmissionCardProps) {
  const changed = changedFilesOf(submission, seed);
  return (
    <div
      className={`flex min-w-0 flex-col gap-2 ${narrow ? '' : 'sm:min-w-[340px]'}`}
      data-testid="quiz-sandbox-submission"
    >
      <div className="flex flex-wrap items-center gap-x-2">
        <CodeOutlined />
        <span className="font-medium">Submitted code</span>
        <span className="text-sm text-gray-500 dark:text-gray-400">· Attempt {attempt}</span>
      </div>
      {changed.length === 0 ? (
        <div className="text-sm text-gray-500 dark:text-gray-400">No files changed</div>
      ) : (
        changed
          .filter(path => typeof submission.files[path] === 'string')
          .map(path => (
            <FileDiff
              key={path}
              path={path}
              before={seed && typeof seed[path] === 'string' ? seed[path] : null}
              after={submission.files[path]}
            />
          ))
      )}
      <ConsoleSummary lines={submission.console} />
      {submission.timed_out ? (
        <div
          className="text-xs text-gray-500 dark:text-gray-400"
          data-testid="quiz-submission-timed-out"
        >
          The code didn&apos;t finish running.
        </div>
      ) : null}
      {submission.errors.map((e, k) => (
        <div key={k} className="flex flex-col gap-1" data-testid="quiz-submission-error">
          <div>
            <Tag color="error" icon={<CloseCircleOutlined />} style={{ margin: 0 }}>
              {e.title}
              {e.path
                ? ` · ${e.path.replace(/^\//, '')}${e.line !== null ? `:${e.line}` : ''}`
                : ''}
            </Tag>
          </div>
          <div
            className="text-[12px] break-words text-[#dc2626] dark:text-[#f87171]"
            style={{ fontFamily: MONO }}
          >
            {e.message}
          </div>
        </div>
      ))}
    </div>
  );
}

export default memo(CodeSubmissionCard);
