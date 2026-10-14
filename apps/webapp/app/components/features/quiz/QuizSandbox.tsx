import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Button, Tag } from 'antd';
import {
  CaretRightOutlined,
  ExpandAltOutlined,
  LockOutlined,
  SendOutlined,
  ShrinkOutlined,
  UndoOutlined,
} from '@ant-design/icons';
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
 *   place, so no bundler runs until Run (which only mounts the preview; a
 *   sandbox frozen in this session gets its bundler started again by
 *   useSandboxCapture).
 * Its files are built once, at mount (the caller keys it by sandbox id): the
 * standing submission's files when it was answered by then, else the edits
 * carried from an earlier live instance of the same id (`edits`, below),
 * else its seed, plus the template's hidden support file. Frozen with a
 * submission, it shows the submitted files.
 *
 * Carried edits: the agent may show a question's card again, and the shared
 * rule then makes the new instance live (its last), freezing the older one
 * with whatever it held. While live or locked, a sandbox writes its files to
 * the transcript's `edits` on every change; a new instance of the same id
 * that mounts live or locked starts from them, only for the paths its own
 * seed has. The older copy keeps showing what it showed. `seed` stays the
 * card's starter (or the hint's seed), so carried edits still count as an
 * edit for Submit, and Reset to starter still writes the starter. The map
 * lives as long as the transcript: a reload starts from the seed.
 *
 * Submit is enabled only once the bundler has run the code (`ready`), the
 * files differ from the seed, and the chat can take a message
 * (`canSubmit`). It captures through `useSandboxCapture` (which always runs
 * the code again) and hands the capture to `onSubmit`, which locks the chat
 * while it runs and sends it. A bundler that never loads leaves the line
 * that the student can answer in a message instead.
 *
 * Expand: the footer's toggle switches the layout between its usual height
 * and a tall one (`sandboxHeight`), on any sandbox, frozen included. Only the
 * layout's height changes, never the provider: edits and a running bundler
 * survive it. It starts collapsed on every mount.
 *
 * The wrapper is `aria-live="off"`: the transcript is a polite live region,
 * and typing in the editor must not be read out. The footer's lines (the
 * runner didn't load; what Submit reported) sit in their own always-mounted
 * `role="status"` region, which is read.
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
export const EXPAND_LABEL = 'Expand';
export const COLLAPSE_LABEL = 'Collapse';

/**
 * The layout's height in px: live (or locked) 320 beside the preview, 460 in
 * the narrow column (editor above preview); frozen, shorter. Expanded, one
 * tall height for every state: 640, and 920 in the narrow column (the same
 * 2× of the live height).
 */
export function sandboxHeight({
  mode,
  narrow,
  expanded,
}: {
  mode: SandboxMode;
  narrow: boolean;
  expanded: boolean;
}): number {
  if (expanded) return narrow ? 920 : 640;
  if (narrow) return mode === 'frozen' ? 330 : 460;
  return mode === 'frozen' ? 230 : 320;
}

/**
 * The latest files of each live sandbox, by id, for a later instance of the
 * same id to start from (see the header). The transcript owns one.
 */
export interface SandboxEdits {
  get(sandboxId: string): Record<string, string> | undefined;
  set(sandboxId: string, files: Record<string, string>): void;
}

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
  /**
   * The transcript's carried edits: written while live or locked, read once
   * at mount by an instance that mounts live or locked. Absent, nothing carries.
   */
  edits?: SandboxEdits | null;
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
  edits = null,
}: QuizSandboxProps) {
  // Built once: a new object would reset Sandpack, edits and all.
  const [files] = useState(() => ({
    ...(submitted?.files ??
      carriedOnto(seed, mode === 'frozen' ? undefined : edits?.get(sandboxId))),
    ...(SANDBOX_SUPPORT_FILES[template] ?? {}),
  }));
  const [paths] = useState(() => Object.keys(seed));
  const [running, setRunning] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const previewMounted = mode !== 'frozen' || running;
  const height = sandboxHeight({ mode, narrow, expanded });

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
        // iframe on mount; SandpackLayout is Sandpack's lazy anchor, so the
        // bundler starts once, with one client, when the sandbox first comes
        // within Sandpack's default margin (1000 px above or below) of the
        // viewport. A preview mounted again after its bundler went away is
        // started by useSandboxCapture.
        initMode="lazy"
        // The editor itself must not be lazy: a sandbox that mounts locked
        // (a reply still streaming) renders a static <pre>, and a lazy editor
        // then never builds CodeMirror once it unlocks.
        editorInitMode="immediate"
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
        // Run is ours (the placeholder's): Sandpack's own pill would show
        // over the editor whenever its bundler is idle.
        showRunButton={false}
        className={`sandpack-embed-auto-height sandpack-embed-wrap-read-only sandpack-follows-page-theme${narrow ? ' sandpack-embed-column' : ''}`}
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
          edits={edits}
          expanded={expanded}
          onToggleExpand={() => setExpanded(e => !e)}
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
  edits: SandboxEdits | null;
  expanded: boolean;
  onToggleExpand: () => void;
}

/** The seed with the carried files for its own paths over it; the seed when nothing carried. */
function carriedOnto(
  seed: Record<string, string>,
  carried: Record<string, string> | undefined
): Record<string, string> {
  if (!carried) return seed;
  const out = { ...seed };
  for (const path of Object.keys(seed)) {
    if (typeof carried[path] === 'string') out[path] = carried[path];
  }
  return out;
}

/** The Expand / Collapse toggle: only the layout's height changes. */
function ExpandToggle({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }) {
  return (
    <Button
      size="small"
      icon={expanded ? <ShrinkOutlined /> : <ExpandAltOutlined />}
      onClick={onToggle}
      data-testid="quiz-sandbox-expand"
      data-expanded={expanded ? 'true' : 'false'}
    >
      {expanded ? COLLAPSE_LABEL : EXPAND_LABEL}
    </Button>
  );
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
  edits,
  expanded,
  onToggleExpand,
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

  // Live or locked: the latest files, for a later instance of this id (the
  // card shown again) to start from. A frozen copy never writes: it only
  // shows what it showed.
  useEffect(() => {
    if (!edits || mode === 'frozen') return;
    const codes = JSON.parse(codeNow) as (string | null)[];
    const carried: Record<string, string> = {};
    paths.forEach((path, i) => {
      const code = codes[i];
      if (typeof code === 'string') carried[path] = code;
    });
    edits.set(sandboxId, carried);
  }, [edits, mode, sandboxId, paths, codeNow]);

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
        <div className="ml-auto">
          <ExpandToggle expanded={expanded} onToggle={onToggleExpand} />
        </div>
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
      {/* Mounted while the sandbox is live or locked, so a line that appears
          is announced: the wrapper above is aria-live="off", and the nearest
          aria-live decides. */}
      <div role="status" aria-live="polite" data-testid="quiz-sandbox-status">
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
      </div>
      <div
        className="mt-3 flex flex-wrap items-center justify-between gap-2"
        data-testid="quiz-sandbox-actions"
      >
        <span className="text-xs text-gray-500 dark:text-gray-400">{label}</span>
        <div className="ml-auto flex flex-wrap justify-end gap-2">
          <ExpandToggle expanded={expanded} onToggle={onToggleExpand} />
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
