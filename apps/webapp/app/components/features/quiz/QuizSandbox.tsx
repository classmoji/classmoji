import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Button, Tag } from 'antd';
import { CaretRightOutlined, LockOutlined, SendOutlined, UndoOutlined } from '@ant-design/icons';
import {
  DEFAULT_CAPTURE_LIMITS,
  SANDBOX_SUPPORT_FILES,
  SandpackEmbed,
  filesDiffer,
  useSandboxCapture,
  type CaptureLimits,
  type SandboxCapture,
} from '@classmoji/ui-components/sandpack';
import {
  MAX_CONSOLE_LINE_CHARS,
  MAX_CONSOLE_LINES,
  MAX_SANDBOX_PATH_CHARS,
  MAX_SUBMISSION_ERRORS,
  type SandboxTemplate,
} from '@classmoji/utils/quiz-agent';

/**
 * QuizSandbox: a code sandbox in the quiz chat (layout A of the design: in
 * the question card, or at the foot of the hint after Try again).
 *
 * One SandpackProvider per sandbox id for its whole life. Sandpack resets its
 * file state (the student's edits) whenever the `files` it was given change
 * identity, and a different component tree would mount a new provider, so
 * the three states are props of this one tree, never a swap:
 * - `live`: editable, with Reset to starter and Submit code;
 * - `locked`: read-only, controls disabled (a reply is running, a typed side
 *   question's included, or a capture is);
 * - `frozen`: read-only; the preview is unmounted, with a Run button in its
 *   place, so no bundler runs until Run (which only mounts the preview).
 * Its files are built once, at mount (the caller keys it by sandbox id): the
 * standing submission's files when it was answered by then, else its seed,
 * plus the template's hidden support file. Frozen with a submission, it
 * shows the submitted files.
 *
 * Submit is enabled only once the bundler has run the code (`ready`), the
 * files differ from the seed, and the chat can take a message
 * (`canSubmit`). It captures through `useSandboxCapture` (which always runs
 * the code again) and hands the capture to `onSubmit`, which locks the chat
 * while it runs and sends it. A bundler that never loads leaves the line
 * that the student can answer in a message instead.
 *
 * The wrapper is `aria-live="off"`: the transcript is a polite live region,
 * and typing in the editor must not be read out.
 */

export type SandboxMode = 'live' | 'locked' | 'frozen';

/** The submission schema's caps (`CodeSubmissionInputSchema`), for the capture. */
export const SUBMISSION_CAPTURE_LIMITS: CaptureLimits = {
  ...DEFAULT_CAPTURE_LIMITS,
  maxConsoleLines: MAX_CONSOLE_LINES,
  maxConsoleLineChars: MAX_CONSOLE_LINE_CHARS,
  maxErrors: MAX_SUBMISSION_ERRORS,
  maxErrorPathChars: MAX_SANDBOX_PATH_CHARS,
};

export const LOAD_FAILED_LINE = "The code runner didn't load. You can answer in a message instead.";

/** What the live sandbox's Submit does: capture, then send. Returns a line to show, or null. */
export type SandboxSubmit = (
  sandboxId: string,
  capture: () => Promise<SandboxCapture>
) => Promise<string | null>;

export interface QuizSandboxProps {
  sandboxId: string;
  template: SandboxTemplate;
  /** The files it starts from: the card's starter, or the last submission's for a hint. */
  seed: Record<string, string>;
  activeFile: string;
  /** The card's starter files, which Reset to starter writes (on a hint sandbox too). */
  starter: Record<string, string>;
  /** The attempt a submission from it is. */
  attempt: number;
  /** The attempt its seed holds (a hint sandbox); null = the starter. */
  seededFrom: number | null;
  mode: SandboxMode;
  /** The standing submission from it, if answered. */
  submitted?: { attempt: number; files: Record<string, string> } | null;
  /** The chat can take a submission now (the live instance only). */
  canSubmit?: boolean;
  onSubmit?: SandboxSubmit | null;
  /** A frozen earlier instance of the live sandbox: a link to the live one. */
  liveElsewhere?: boolean;
  isDarkMode: boolean;
  /** Narrow screens: editor above preview, at the column's full width. */
  narrow?: boolean;
}

/** Scrolls the live sandbox into view. */
const goToLive = () =>
  document
    .querySelector('[data-sandbox-live="true"]')
    ?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });

export default function QuizSandbox({
  sandboxId,
  template,
  seed,
  activeFile,
  starter,
  attempt,
  seededFrom,
  mode,
  submitted = null,
  canSubmit = false,
  onSubmit = null,
  liveElsewhere = false,
  isDarkMode,
  narrow = false,
}: QuizSandboxProps) {
  // Built once: a new object would reset Sandpack, edits and all.
  const [files] = useState(() => ({
    ...(submitted?.files ?? seed),
    ...(SANDBOX_SUPPORT_FILES[template] ?? {}),
  }));
  const [paths] = useState(() => Object.keys(seed));
  const [running, setRunning] = useState(false);
  const previewMounted = mode !== 'frozen' || running;
  const height = narrow ? (mode === 'frozen' ? 330 : 460) : mode === 'frozen' ? 230 : 320;

  const placeholder = (
    <div
      className="flex h-full min-w-0 flex-1 flex-col items-center justify-center gap-2"
      style={{ background: isDarkMode ? '#151515' : '#f8f9fb' }}
    >
      <Button
        size="small"
        icon={<CaretRightOutlined />}
        onClick={() => setRunning(true)}
        data-testid="quiz-sandbox-run"
      >
        Run
      </Button>
    </div>
  );

  return (
    <div
      className="mt-3 min-w-0"
      aria-live="off"
      data-testid="quiz-sandbox"
      data-state={mode}
      data-sandbox-id={sandboxId}
      data-sandbox-live={mode === 'frozen' ? undefined : 'true'}
    >
      <SandpackEmbed
        template={template}
        theme={isDarkMode ? 'dark' : 'light'}
        layout={narrow ? 'preview-bottom' : 'preview-right'}
        files={files}
        activeFile={activeFile}
        // Not 'immediate': under StrictMode the preview mounts twice, and an
        // immediate provider creates a client on each mount for the same
        // iframe. It keeps the one whose status never reaches `done`, so edits
        // and refreshes are silently dropped (no recompile, every capture
        // times out on the first run's console). 'lazy' only registers the
        // iframe and creates one client after the mounts settle; no layout
        // here sets Sandpack's lazy anchor, so it still boots straight away.
        initMode="lazy"
        options={{
          visibleFiles: paths,
          showTabs: true,
          showLineNumbers: true,
          showConsole: previewMounted,
        }}
        readOnly={mode !== 'live'}
        showPreview={previewMounted}
        previewPlaceholder={placeholder}
        height={height}
        consoleProps={{ defaultExpanded: true, maxHeight: narrow ? 110 : 100 }}
        className={`sandpack-embed-auto-height sandpack-follows-page-theme${narrow ? ' sandpack-embed-column' : ''}`}
      >
        <SandboxFooter
          sandboxId={sandboxId}
          mode={mode}
          previewMounted={previewMounted}
          seed={seed}
          starter={starter}
          paths={paths}
          attempt={attempt}
          seededFrom={seededFrom}
          submitted={submitted}
          canSubmit={canSubmit}
          onSubmit={onSubmit}
          liveElsewhere={liveElsewhere}
        />
      </SandpackEmbed>
    </div>
  );
}

interface FooterProps {
  sandboxId: string;
  mode: SandboxMode;
  previewMounted: boolean;
  seed: Record<string, string>;
  starter: Record<string, string>;
  paths: readonly string[];
  attempt: number;
  seededFrom: number | null;
  submitted: QuizSandboxProps['submitted'];
  canSubmit: boolean;
  onSubmit: SandboxSubmit | null;
  liveElsewhere: boolean;
}

/** Under the editor, inside the provider: the attempt line and the controls. */
function SandboxFooter({
  sandboxId,
  mode,
  previewMounted,
  seed,
  starter,
  paths,
  attempt,
  seededFrom,
  submitted,
  canSubmit,
  onSubmit,
  liveElsewhere,
}: FooterProps) {
  const { capture, ready, loadFailed, files, updateFiles } = useSandboxCapture({
    enabled: previewMounted,
    limits: SUBMISSION_CAPTURE_LIMITS,
  });
  const [submitting, setSubmitting] = useState(false);
  const [line, setLine] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    []
  );

  // Frozen with a submission: the editor shows the submitted files. Only a
  // sandbox answered in this session can hold anything else (its files were
  // built from the seed); they are the same files, unless something changed
  // them after the capture.
  const submittedFiles = submitted?.files ?? null;
  useEffect(() => {
    if (mode === 'frozen' && submittedFiles && filesDiffer(submittedFiles, files)) {
      updateFiles(submittedFiles);
    }
  }, [mode, submittedFiles, files, updateFiles]);

  // A line from the last Submit stays until the code changes.
  const codeNow = JSON.stringify(paths.map(path => files[path]?.code ?? null));
  const codeAtLine = useRef(codeNow);
  useEffect(() => {
    if (codeAtLine.current !== codeNow) {
      codeAtLine.current = codeNow;
      setLine(null);
    }
  }, [codeNow]);

  if (mode === 'frozen') {
    return (
      <div className="mt-3 flex flex-wrap items-center gap-2" data-testid="quiz-sandbox-frozen">
        {submitted ? (
          <Tag icon={<LockOutlined />} style={{ margin: 0 }}>
            Attempt {submitted.attempt} submitted
          </Tag>
        ) : (
          <Tag style={{ margin: 0 }}>Not submitted</Tag>
        )}
        {seededFrom !== null ? (
          <span className="text-xs text-gray-500 dark:text-gray-400">
            Starts from attempt {seededFrom}
          </span>
        ) : null}
        {liveElsewhere ? (
          <Button
            type="link"
            size="small"
            className="!px-0"
            onClick={goToLive}
            data-testid="quiz-sandbox-go-live"
          >
            Continue in the sandbox below
          </Button>
        ) : null}
      </div>
    );
  }

  const live = mode === 'live';
  const edited = filesDiffer(seed, files);
  const submitEnabled = live && canSubmit && ready && edited && !submitting && Boolean(onSubmit);
  const label =
    seededFrom !== null
      ? `Attempt ${attempt} · starts from attempt ${seededFrom}`
      : `Attempt ${attempt}`;

  const submit = async () => {
    if (!onSubmit || !submitEnabled) return;
    setSubmitting(true);
    setLine(null);
    try {
      const shown = await onSubmit(sandboxId, () => capture(paths));
      if (mounted.current) setLine(shown);
    } finally {
      if (mounted.current) setSubmitting(false);
    }
  };

  return (
    <>
      {loadFailed ? (
        <p
          className="mt-2 mb-0 text-sm text-gray-600 dark:text-gray-400"
          data-testid="quiz-sandbox-load-failed"
        >
          {LOAD_FAILED_LINE}
        </p>
      ) : null}
      {line ? (
        <p
          className="mt-2 mb-0 text-sm text-gray-600 dark:text-gray-400"
          data-testid="quiz-sandbox-line"
        >
          {line}
        </p>
      ) : null}
      <div
        className="mt-3 flex flex-wrap items-center justify-between gap-2"
        data-testid="quiz-sandbox-actions"
      >
        <span className="text-xs text-gray-500 dark:text-gray-400">{label}</span>
        <div className="ml-auto flex flex-wrap justify-end gap-2">
          <Button
            size="small"
            icon={<UndoOutlined />}
            disabled={!live || submitting}
            onClick={() => updateFiles(starter)}
            data-testid="quiz-sandbox-reset"
          >
            Reset to starter
          </Button>
          <Button
            type="primary"
            size="small"
            icon={<SendOutlined />}
            loading={submitting}
            disabled={!submitEnabled && !submitting}
            onClick={submit}
            data-testid="quiz-sandbox-submit"
          >
            Submit code
          </Button>
        </div>
      </div>
    </>
  );
}

/** The narrow query: below Tailwind's `md`. */
const NARROW_QUERY = '(max-width: 767px)';
const noSubscribe = () => () => {};

/**
 * Whether the chat lays sandboxes out for a narrow screen, decided once per
 * mount and never on resize: the narrow layout renders a sandbox under its
 * bubble instead of inside it, a different parent, which would mount a new
 * provider and lose the student's edits. On the server, and while hydrating,
 * it reads false (no mismatch); a client render reads the screen at once.
 */
export function useNarrowLayout(): boolean {
  const decided = useRef<boolean | null>(null);
  return useSyncExternalStore(
    noSubscribe,
    () =>
      (decided.current ??=
        typeof window !== 'undefined' && typeof window.matchMedia === 'function'
          ? window.matchMedia(NARROW_QUERY).matches
          : false),
    () => false
  );
}
