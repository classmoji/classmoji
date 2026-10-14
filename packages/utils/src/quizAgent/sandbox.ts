/**
 * Code sandbox questions: the contract between the quiz agent, the server and
 * the chat. The agent attaches starter files to a question
 * (`present_question`'s `sandbox`); the student edits and runs them in a
 * Sandpack sandbox in the question card and submits a `code_submission`
 * (`data-code-submission` on their message); after Try again the server
 * attaches a fresh sandbox under the hint (`data-sandbox`), seeded from the
 * student's last submission. Which sandbox is open is worked out from the
 * messages alone (`openSandboxOf`, sandboxState.ts).
 *
 * Shared, client-safe Zod with no server imports: this reaches the client
 * bundle. Nothing here imports the other quiz modules but the limits and the
 * reserved-text rule, so schemas.ts can build on it without a cycle.
 */
import { z } from 'zod';
import {
  MAX_CONSOLE_LINE_CHARS,
  MAX_CONSOLE_LINES,
  MAX_SANDBOX_FILE_CHARS,
  MAX_SANDBOX_FILES,
  MAX_SANDBOX_TOTAL_CHARS,
  MAX_SUBMISSION_FILE_CHARS,
  MAX_SUBMISSION_TOTAL_CHARS,
} from './limits.ts';
import { LINE_BREAK } from './reserved.ts';

// ─── Templates ──────────────────────────────────────────────────────────────

/** Sandpack template names a sandbox may use. */
export const SANDBOX_TEMPLATES = ['vanilla', 'vanilla-ts', 'react', 'react-ts'] as const;
export type SandboxTemplate = (typeof SANDBOX_TEMPLATES)[number];

/**
 * The file each template runs, which every sandbox of that template must
 * carry. From the template definitions in sandpack-react 2.20.0
 * (`VANILLA_TEMPLATE`, `VANILLA_TYPESCRIPT_TEMPLATE`, `REACT_TEMPLATE`,
 * `REACT_TYPESCRIPT_TEMPLATE` in `dist/index.mjs`): the vanilla templates' own
 * `main`, and for React the component the template's entry renders (its
 * `main`, while its package.json's `main` is the entry below).
 */
export const SANDBOX_ENTRY_FILE = {
  vanilla: '/index.js',
  'vanilla-ts': '/index.ts',
  react: '/App.js',
  'react-ts': '/App.tsx',
} as const satisfies Record<SandboxTemplate, string>;

/**
 * Files the template owns, which the agent may never supply: supplying one
 * replaces the template's own. `/package.json` carries the template's
 * dependencies and `main`; `tsconfig.json` (unrooted in Sandpack's own
 * templates) its compiler options; `/sandbox.config.json` the bundler's
 * settings; and the React templates' `/index.js` or `/index.tsx` and
 * `/public/index.html` mount the student's component. They stay hidden in the
 * editor (`visibleFiles` is always the seed's paths).
 */
export const SANDBOX_TEMPLATE_OWNED_FILES = {
  vanilla: ['/package.json', '/tsconfig.json', '/sandbox.config.json'],
  'vanilla-ts': ['/package.json', '/tsconfig.json', '/sandbox.config.json'],
  react: [
    '/package.json',
    '/tsconfig.json',
    '/sandbox.config.json',
    '/index.js',
    '/public/index.html',
  ],
  'react-ts': [
    '/package.json',
    '/tsconfig.json',
    '/sandbox.config.json',
    '/index.tsx',
    '/public/index.html',
  ],
} as const satisfies Record<SandboxTemplate, readonly string[]>;

/** The templates that are TypeScript: transpiled, never type-checked. */
export const isTypeScriptTemplate = (template: SandboxTemplate): boolean =>
  template === 'vanilla-ts' || template === 'react-ts';

// ─── Paths ──────────────────────────────────────────────────────────────────

/** The longest path a sandbox file may have. */
export const MAX_SANDBOX_PATH_CHARS = 100;

/** A sandbox path: "/" then segments of letters, digits, "_", "." and "-". */
const SANDBOX_PATH = /^\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/;
const DOTS_ONLY = /^\.+$/;

/**
 * Whether a path may name a sandbox file: rooted, at most
 * `MAX_SANDBOX_PATH_CHARS`, plain segments only (no "." or ".." segment).
 * Checked in `superRefine`, never as a key pattern: the tool's JSON schema
 * gives `files` plain string keys.
 */
export const isSandboxPath = (path: string): boolean =>
  path.length <= MAX_SANDBOX_PATH_CHARS &&
  SANDBOX_PATH.test(path) &&
  !path
    .slice(1)
    .split('/')
    .some(segment => DOTS_ONLY.test(segment));

const PATH_RULE =
  'a path starts with "/" and uses letters, digits, "_", "." and "-" (at most 100 characters)';

const chars = (files: Record<string, string>) =>
  Object.values(files).reduce((sum, code) => sum + code.length, 0);

/** The path rule and the size caps shared by starter files and submitted files. */
function checkFiles(
  files: Record<string, string>,
  caps: { file: number; total: number },
  ctx: z.RefinementCtx
): void {
  const paths = Object.keys(files);
  if (paths.length < 1 || paths.length > MAX_SANDBOX_FILES) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['files'],
      message: `files must hold 1 to ${MAX_SANDBOX_FILES} files`,
    });
  }
  for (const path of paths) {
    if (!isSandboxPath(path)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['files', path],
        message: `"${path.slice(0, MAX_SANDBOX_PATH_CHARS)}" is not a valid path: ${PATH_RULE}`,
      });
    } else if (files[path].length > caps.file) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['files', path],
        message: `${path} is longer than ${caps.file} characters`,
      });
    }
  }
  if (chars(files) > caps.total) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['files'],
      message: `the files hold more than ${caps.total} characters in all`,
    });
  }
}

// ─── present_question's `sandbox` ───────────────────────────────────────────

/**
 * The model-facing description of `present_question`'s `sandbox` field. It
 * exists only on a sandbox attempt's schema, so the fleet-wide tool
 * descriptions (`TOOL_DESCRIPTIONS`) stay as they are.
 */
export const SANDBOX_FIELD_DESCRIPTION =
  'Only for a question the student answers by writing or fixing code: an editable sandbox in the card. ' +
  'template "vanilla" (/index.js, /index.html, /styles.css; index.js runs as a strict-mode ES module, so import CSS from it), ' +
  '"vanilla-ts" (the same with /index.ts), "react" (/App.js default export) or "react-ts" (/App.tsx). ' +
  'TypeScript is transpiled, never type-checked. Paths start with "/". Starter code only, never the answer. ' +
  'Leave code_snippet out.';

const SandboxSpecObject = z.object({
  template: z.enum(SANDBOX_TEMPLATES),
  // Plain string keys: no key pattern in the tool's JSON schema. The path
  // rule is in the superRefine below.
  files: z.record(z.string(), z.string()).describe('The starter files: path → file content.'),
  active_file: z.string().describe('The path of the file the editor opens on.'),
});

/**
 * A sandbox the agent attaches to a question: its template, starter files
 * and the file the editor opens on. The path rule, the caps
 * (`MAX_SANDBOX_FILES`, `MAX_SANDBOX_FILE_CHARS`, `MAX_SANDBOX_TOTAL_CHARS`),
 * the template's entry file and the template-owned files are all checked
 * here, so the stored card (`QuestionCardSchema`) enforces them too.
 */
export const SandboxSpecSchema = SandboxSpecObject.superRefine((spec, ctx) => {
  checkFiles(spec.files, { file: MAX_SANDBOX_FILE_CHARS, total: MAX_SANDBOX_TOTAL_CHARS }, ctx);
  const has = (path: string) => Object.prototype.hasOwnProperty.call(spec.files, path);
  if (!has(spec.active_file)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['active_file'],
      message: 'active_file must be one of the paths in files',
    });
  }
  const entry = SANDBOX_ENTRY_FILE[spec.template];
  if (!has(entry)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['files'],
      message: `a "${spec.template}" sandbox must include ${entry}`,
    });
  }
  for (const owned of SANDBOX_TEMPLATE_OWNED_FILES[spec.template]) {
    if (has(owned)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['files', owned],
        message: `leave ${owned} out: the "${spec.template}" template provides it`,
      });
    }
  }
});
export type SandboxSpec = z.infer<typeof SandboxSpecSchema>;

// ─── Ids (set by the server) ────────────────────────────────────────────────

const SANDBOX_ID = /^q([1-9][0-9]{0,3})-([1-9][0-9]{0,3})$/;

/**
 * The id of question `questionNumber`'s sandbox for attempt `attempt`:
 * `q{n}-1` is the card's, `q{n}-{k}` (k ≥ 2) the hint sandbox for attempt k.
 * Always the server's derivation: an id the browser sends is only a
 * reference, checked against it.
 */
export const sandboxId = (questionNumber: number, attempt: number): string =>
  `q${questionNumber}-${attempt}`;

/** The question and attempt a sandbox id names, or null for anything else. */
export function parseSandboxId(id: unknown): { question_number: number; attempt: number } | null {
  if (typeof id !== 'string') return null;
  const match = SANDBOX_ID.exec(id);
  return match ? { question_number: Number(match[1]), attempt: Number(match[2]) } : null;
}

// ─── data-sandbox: the hint sandbox ─────────────────────────────────────────

/**
 * The sandbox the server attaches under the hint after a Try again click
 * (`data-sandbox`, registry key `sandbox`). The task's loop writes it, never
 * the model. Shape only: its files come from the student's last submission,
 * whose caps are not the starter's.
 */
export const SandboxDataSchema = z.object({
  id: z.string(),
  question_number: z.number().int().min(1),
  attempt: z.number().int().min(2),
  /** The attempt whose files it holds; null = the starter. */
  seeded_from: z.number().int().min(1).nullable(),
  template: z.enum(SANDBOX_TEMPLATES),
  files: z.record(z.string(), z.string()),
  active_file: z.string(),
});
export type SandboxData = z.infer<typeof SandboxDataSchema>;

// ─── data-code-submission: the student's code ───────────────────────────────

export const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;
export const SUBMISSION_ERROR_KINDS = ['compile', 'runtime'] as const;
/** The most errors one submission reports. */
export const MAX_SUBMISSION_ERRORS = 3;

const ConsoleLineSchema = z.object({
  method: z.enum(CONSOLE_METHODS),
  text: z.string().max(MAX_CONSOLE_LINE_CHARS),
});
export type SubmissionConsoleLine = z.infer<typeof ConsoleLineSchema>;

const SubmissionErrorSchema = z.object({
  kind: z.enum(SUBMISSION_ERROR_KINDS),
  title: z.string().max(100),
  message: z.string().max(500),
  path: z.string().max(MAX_SANDBOX_PATH_CHARS).nullable(),
  line: z.number().int().min(1).nullable(),
  column: z.number().int().min(0).nullable(),
});
export type SubmissionError = z.infer<typeof SubmissionErrorSchema>;

const submissionFields = {
  sandbox_id: z.string().max(20),
  files: z.record(z.string(), z.string()),
  console: z.array(ConsoleLineSchema).max(MAX_CONSOLE_LINES),
  errors: z.array(SubmissionErrorSchema).max(MAX_SUBMISSION_ERRORS),
  timed_out: z.literal(true).optional(),
};

/** The fields only the server sets, from the attempt's own rows. */
const serverFields = {
  question_number: z.number().int().min(1),
  attempt: z.number().int().min(1),
  /** The attempt the files were compared with; null = the starter. */
  base_attempt: z.number().int().min(1).nullable(),
  template: z.enum(SANDBOX_TEMPLATES),
  changed_files: z.array(z.string()).max(MAX_SANDBOX_FILES),
};

const checkSubmissionFiles = (s: { files: Record<string, string> }, ctx: z.RefinementCtx) =>
  checkFiles(s.files, { file: MAX_SUBMISSION_FILE_CHARS, total: MAX_SUBMISSION_TOTAL_CHARS }, ctx);

/**
 * What the browser may send as a code submission, and nothing else: every
 * level is strict. The path rule and the caps (`MAX_SUBMISSION_FILE_CHARS`,
 * `MAX_SUBMISSION_TOTAL_CHARS`, `MAX_CONSOLE_LINES`, `MAX_CONSOLE_LINE_CHARS`)
 * are checked here; that the files are exactly the open sandbox's is the
 * server's check, against its own rows.
 */
export const CodeSubmissionInputSchema = z
  .object({
    ...submissionFields,
    console: z.array(ConsoleLineSchema.strict()).max(MAX_CONSOLE_LINES),
    errors: z.array(SubmissionErrorSchema.strict()).max(MAX_SUBMISSION_ERRORS),
  })
  .strict()
  .superRefine(checkSubmissionFiles);
export type CodeSubmissionInput = z.infer<typeof CodeSubmissionInputSchema>;

/**
 * The submission as the server stores it: the browser's input plus the
 * fields it derives (question, attempt, base, template, changed files). What
 * admission validates before it writes the part.
 */
export const CodeSubmissionPartSchema = z
  .object({ ...submissionFields, ...serverFields })
  .superRefine(checkSubmissionFiles);
export type CodeSubmissionPart = z.infer<typeof CodeSubmissionPartSchema>;

/**
 * `data-code-submission` as the chat's UI part type and the projection's
 * registry entry (registry key `code-submission`): the server's fields are
 * optional, as `OfferNextStepPartSchema`'s are, so the browser's optimistic
 * message (its input only) typechecks. Shape only, with unknown keys
 * stripped: every read re-validates stored parts, and a caps check here would
 * drop a stored submission from the transcript if a cap ever came down.
 */
export const CodeSubmissionDataSchema = z.object({ ...submissionFields, ...serverFields }).partial({
  question_number: true,
  attempt: true,
  base_attempt: true,
  template: true,
  changed_files: true,
});
export type CodeSubmissionData = z.infer<typeof CodeSubmissionDataSchema>;

// ─── What the model reads ───────────────────────────────────────────────────

/**
 * A student string as lines, split on the reserved-text check's own line
 * breaks. One line break at the very end ends the last line; it opens no
 * empty line of its own.
 */
function linesOf(text: string): string[] {
  const lines = text.split(LINE_BREAK);
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

const sortedPaths = (paths: Iterable<string>) => [...paths].sort();

/** One file: its path, then each line as "N| " and the line. */
const renderFile = (path: string, code: string): string[] => [
  `--- ${path}`,
  ...linesOf(code).map((line, i) => `${i + 1}| ${line}`),
];

/** Each console line as "[method] " and its text, a line of text at a time. */
const renderConsoleLines = (lines: readonly SubmissionConsoleLine[]): string[] =>
  lines.flatMap(l => linesOf(l.text).map(text => `[${l.method}] ${text}`));

/** Where an error happened: "(path:line:col)", or as much of it as is known. */
function errorLocation(e: SubmissionError): string {
  const position = e.line === null ? '' : e.column === null ? `${e.line}` : `${e.line}:${e.column}`;
  if (e.path !== null) return ` (${position ? `${e.path}:${position}` : e.path})`;
  return position ? ` (line ${position})` : '';
}

/** Each error as "[kind] title: message (path:line:col)", a line of text at a time. */
const renderErrorLines = (errors: readonly SubmissionError[]): string[] =>
  errors.flatMap(e => {
    const text = [e.title, e.message].filter(s => s !== '').join(': ') + errorLocation(e);
    return linesOf(text).map(line => `[${e.kind}] ${line}`);
  });

/**
 * A code submission as the model reads it, stored once at admission as a
 * hidden text part of the student's message, so the history is the same bytes
 * every turn. Deterministic: paths are sorted, whatever order the stored
 * object's keys come back in.
 *
 * Every line that comes from the student is prefixed: code lines with "N| "
 * (the convention explore_codebase uses), console lines with "[method] ",
 * errors with "[kind] ". No line of it can open with the server's framing,
 * and the text checked at admission (`reservedCheckText`) holds every one of
 * these lines. Unchanged files appear by name only: the model wrote the
 * starter and read every earlier submission.
 */
export function renderSubmissionForModel(part: CodeSubmissionPart): string {
  const paths = sortedPaths(Object.keys(part.files));
  const changedSet = new Set(part.changed_files);
  const changed = paths.filter(p => changedSet.has(p));
  const unchanged = paths.filter(p => !changedSet.has(p));
  const base = part.base_attempt === null ? 'the starter code' : `attempt ${part.base_attempt}`;

  const lines = [
    `Code submission: question ${part.question_number}, attempt ${part.attempt} ` +
      `(changes vs ${base}), template ${part.template}`,
  ];
  if (isTypeScriptTemplate(part.template)) {
    lines.push('TypeScript was transpiled without type-checking: type errors are not reported.');
  }
  lines.push(
    `Changed: ${changed.length > 0 ? changed.join(', ') : 'none'}.` +
      (unchanged.length > 0 ? ` Unchanged: ${unchanged.join(', ')}.` : '')
  );
  for (const path of changed) lines.push(...renderFile(path, part.files[path]));
  if (part.timed_out) lines.push('Run: did not finish; console may be partial.');
  const count = part.console.length;
  lines.push(
    count === 0
      ? "Console: nothing logged in the student's browser."
      : `Console (${count} ${count === 1 ? 'line' : 'lines'}, from the student's browser):`,
    ...renderConsoleLines(part.console)
  );
  lines.push(
    part.errors.length === 0 ? 'Errors: none' : 'Errors:',
    ...renderErrorLines(part.errors)
  );
  return lines.join('\n');
}

/**
 * The text admission runs the reserved-text check on (`containsReservedText`)
 * before it knows which files changed: every file, console line and error,
 * rendered exactly as `renderSubmissionForModel` renders them, prefixes
 * included. Whatever the model later reads of the student's text is a subset
 * of these lines. Also takes starter files alone (`{ files }`), for the
 * agent's starter check.
 */
export function reservedCheckText(input: {
  files: Record<string, string>;
  console?: readonly SubmissionConsoleLine[];
  errors?: readonly SubmissionError[];
}): string {
  return [
    ...sortedPaths(Object.keys(input.files)).flatMap(p => renderFile(p, input.files[p])),
    ...renderConsoleLines(input.console ?? []),
    ...renderErrorLines(input.errors ?? []),
  ].join('\n');
}
