/**
 * Everything one quiz turn needs, resolved from Neon by the chat id (the
 * attempt id). Nothing here comes from the browser: `clientData` is a hint at
 * most and is never read for identity, model, key or repository.
 *
 * `AttemptContext` is the contract the tools (prompt/, tools/) consume.
 */
import getPrisma from '@classmoji/database';
import { ClassmojiService, getGitProvider } from '@classmoji/services';
import type { AttemptProgress } from '@classmoji/utils/quiz-agent';
import { buildQuizPrompt, quizWelcome, usableMaterial } from './prompt/index.ts';
import { resolveQuizRunSettings, type Effort } from './settings.ts';

export type GitOrgLike = Parameters<typeof getGitProvider>[0];

/** What admission hands the turn: the fence it set and the message it admitted. */
export type TurnAdmission = {
  fence: string;
  /** The admitted student message id; null for the `begin` action's turn. */
  inputMessageId: string | null;
  runId: string;
  /** Set when the admitted text was one of the two button texts. */
  action?: 'next' | 'try_again';
};

/**
 * The course-material lookups an attempt may make (tools/content.ts), fixed
 * for the attempt: through the Classmoji MCP server, as the attempt's user.
 */
export type ContentScope = {
  /** The MCP endpoint, `${MCP_PUBLIC_URL}/mcp`. */
  mcpUrl: string;
  /** `org/slug`. Every call names this classroom; the model never does. */
  classroomRef: string;
  /** Whole-course search (`quiz.course_search_enabled`). */
  courseSearchEnabled: boolean;
  /** The linked documents that reached the prompt, in material order. */
  docs: Array<{ kind: string; id: string; title: string }>;
};

export type AttemptContext = {
  attemptId: string;
  userId: string;
  classroomId: string;
  quizId: string;
  questionCount: number;
  isCodeAware: boolean;
  fence: string;
  inputMessageId: string | null;
  runId: string;
  lastAction?: 'next' | 'try_again';
  model: string;
  questionEffort: Effort;
  gradingEffort: Effort;
  apiKey: string;
  keySource: 'platform' | 'classroom';
  exploration: {
    model: string;
    effort: Effort | null;
    owner: string;
    repo: string;
    gitOrganization: GitOrgLike;
    /**
     * The quiz's "Paths to exclude" (`quiz.excluded_paths`): .gitignore-style
     * patterns whose files exploration never lists or reads and a code quote
     * refuses. None when absent or empty.
     */
    excludedPaths?: string[];
  } | null;
  prompt: { staticPrompt: string; dynamicPrompt: string };
  progress: AttemptProgress;
  /** Linked material is configured but none of it could be loaded for this user. */
  sourceMaterialUnavailable?: boolean;
  /**
   * content_get and content_search for this attempt, or null (absent) when it
   * has none: no linked material and no course search, no classroom
   * reference, or no MCP server configured (`MCP_PUBLIC_URL`).
   */
  content?: ContentScope | null;
  /**
   * The quiz is code-aware but no repository was found for this attempt: the
   * turn runs the standard instructions without explore_codebase, and the
   * loop adds a fixed hidden notice (`CODE_UNAVAILABLE_NOTICE`). The opening
   * welcome says so (`NO_REPOSITORY_WELCOME`), and the quiz runs on the
   * concepts, as in the previous runtime.
   */
  codeUnavailable?: boolean;
  /**
   * The fixed welcome (`quizWelcome`). The loop writes it first on the opening
   * turn only: the `begin` action's turn, before any question.
   */
  welcome?: string;
};

const PREVIEW_ROLES = ['OWNER', 'TEACHER', 'ASSISTANT'] as const;

type LoadedAttempt = NonNullable<Awaited<ReturnType<typeof ClassmojiService.quizAttempt.findById>>>;

/**
 * The per-attempt parts that do not change between turns (prompt, repository,
 * material state), kept for the life of this process so a warm run builds the
 * cached prompt once and sends byte-identical system blocks every turn.
 */
type StableParts = {
  prompt: { staticPrompt: string; dynamicPrompt: string };
  sourceMaterialUnavailable: boolean;
  content: ContentScope | null;
  exploration: AttemptContext['exploration'];
  isCodeAware: boolean;
  codeUnavailable: boolean;
};
const stableCache = new Map<string, StableParts>();
const STABLE_CACHE_MAX = 20;

/** `org/slug`, the classroom reference the content tools take; null when either half is missing. */
function classroomRefFor(classroom: LoadedAttempt['quiz']['classroom']): string | null {
  const login = classroom?.git_organization?.login;
  const slug = classroom?.slug;
  return typeof login === 'string' && login && typeof slug === 'string' && slug
    ? `${login}/${slug}`
    : null;
}

/**
 * The attempt's content lookups, or null when it has none. Registered exactly
 * when the MCP server is configured, the classroom has an `org/slug`, and the
 * quiz has linked material that reached the prompt or course search on (the
 * previous runtime's rule): a quiz with neither could only ever be refused.
 */
export function contentScopeFor(o: {
  mcpBaseUrl: string | undefined;
  classroomRef: string | null;
  courseSearchEnabled: boolean;
  docs: ReadonlyArray<{ kind: string; id: string | number; title?: string | null }>;
}): ContentScope | null {
  const base = typeof o.mcpBaseUrl === 'string' ? o.mcpBaseUrl.trim() : '';
  if (!base || !o.classroomRef) return null;
  if (o.docs.length === 0 && !o.courseSearchEnabled) return null;
  return {
    mcpUrl: `${base.replace(/\/+$/, '')}/mcp`,
    classroomRef: o.classroomRef,
    courseSearchEnabled: o.courseSearchEnabled,
    docs: o.docs.map(doc => ({
      kind: doc.kind,
      id: String(doc.id),
      title: typeof doc.title === 'string' ? doc.title : '',
    })),
  };
}

/** The quiz's stored excluded paths, strings only (the column is `String[]`). */
function storedExcludedPaths(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((p): p is string => typeof p === 'string' && p.trim() !== '')
    : [];
}

/**
 * The repository a code-aware attempt explores: a staff preview's chosen
 * repository when the attempt's own user holds a teaching-team role in the
 * classroom, else that user's own repository for the quiz's assignment.
 */
async function explorationRepoName(attempt: LoadedAttempt): Promise<string | null> {
  const config = attempt.agent_config as Record<string, unknown> | null;
  const previewRepo = config?.instructorRepoName;
  if (typeof previewRepo === 'string' && previewRepo) {
    const staff = await getPrisma().classroomMembership.findFirst({
      where: {
        classroom_id: attempt.quiz.classroom_id,
        user_id: attempt.user_id,
        role: { in: [...PREVIEW_ROLES] },
      },
      select: { id: true },
    });
    if (staff) return previewRepo;
  }
  if (!attempt.quiz.repository_id) return null;
  const repo = await ClassmojiService.gitRepo.findByStudent(
    attempt.quiz.repository_id,
    attempt.user_id
  );
  return repo?.name ?? null;
}

async function loadStableParts(
  attempt: LoadedAttempt,
  questionCount: number,
  log: (line: string, fields: Record<string, unknown>) => void,
  env: Record<string, string | undefined>
): Promise<StableParts> {
  const cached = stableCache.get(attempt.id);
  if (cached) return cached;

  const quiz = attempt.quiz;
  const quizIsCodeAware = Boolean(quiz.repository_id && quiz.include_code_context);

  let exploration: AttemptContext['exploration'] = null;
  if (quizIsCodeAware) {
    const gitOrganization = quiz.classroom?.git_organization;
    const repo = await explorationRepoName(attempt);
    if (repo && gitOrganization?.login) {
      exploration = {
        model: '', // filled per turn from settings
        effort: null,
        owner: gitOrganization.login,
        repo,
        gitOrganization: gitOrganization as GitOrgLike,
        excludedPaths: storedExcludedPaths(quiz.excluded_paths),
      };
    } else {
      log('[quiz-agent] code-aware attempt has no repository to explore', {
        attemptId: attempt.id,
        hasOrg: Boolean(gitOrganization?.login),
      });
    }
  }
  const isCodeAware = quizIsCodeAware && exploration !== null;
  const codeUnavailable = quizIsCodeAware && exploration === null;

  const material = await ClassmojiService.quizSourceMaterial.load({
    quizId: quiz.id,
    classroomId: quiz.classroom_id,
    userId: attempt.user_id,
  });
  const docs = Array.isArray(material?.docs) ? material.docs : [];
  const configured = Number.isFinite(material?.configured) ? material.configured : 0;
  const sourceMaterialUnavailable = configured > 0 && docs.length === 0;
  if (configured > 0 || docs.length > 0) {
    log('[quiz-agent] source material', {
      attemptId: attempt.id,
      configured,
      docs: docs.length,
      chars: material?.totalChars ?? 0,
      truncated: Boolean(material?.truncated),
    });
  }

  const classroomRef = classroomRefFor(quiz.classroom);
  const courseSearchEnabled = quiz.course_search_enabled === true;
  const content = contentScopeFor({
    mcpBaseUrl: env.MCP_PUBLIC_URL,
    classroomRef,
    courseSearchEnabled,
    docs: usableMaterial(docs),
  });
  if (content) {
    log('[quiz-agent] content tools', {
      attemptId: attempt.id,
      linkedDocs: content.docs.length,
      courseSearch: courseSearchEnabled ? 1 : 0,
    });
  }

  const prompt = buildQuizPrompt({
    quizSystemPrompt: quiz.system_prompt ?? null,
    rubricPrompt: quiz.rubric_prompt ?? null,
    questionCount,
    subject: quiz.subject ?? null,
    difficultyLevel: quiz.difficulty_level ?? null,
    isCodeAware,
    sourceMaterial: docs.length > 0 ? docs : null,
    classroomRef,
    courseSearchEnabled,
    contentToolsAvailable: content !== null,
  });

  const parts: StableParts = {
    prompt,
    sourceMaterialUnavailable,
    content,
    exploration,
    isCodeAware,
    codeUnavailable,
  };
  // A turn that found no material, or no repository for a code-aware quiz,
  // does not pin that result: the next turn looks again.
  if (sourceMaterialUnavailable || codeUnavailable) return parts;
  if (stableCache.size >= STABLE_CACHE_MAX) {
    const oldest = stableCache.keys().next().value;
    if (oldest !== undefined) stableCache.delete(oldest);
  }
  stableCache.set(attempt.id, parts);
  return parts;
}

/** Test seam: forget cached per-attempt parts. */
export function clearAttemptContextCache(): void {
  stableCache.clear();
}

/**
 * Build the turn's context. Throws when the attempt is gone; admission has
 * already refused every other state that must not reach the model.
 */
export async function loadAttemptContext(
  chatId: string,
  admission: TurnAdmission,
  opts: {
    log?: (line: string, fields: Record<string, unknown>) => void;
    env?: Record<string, string | undefined>;
  } = {}
): Promise<AttemptContext> {
  const log = opts.log ?? ((line, fields) => console.log(line, fields));
  const attempt = await ClassmojiService.quizAttempt.findById(chatId);
  if (!attempt) {
    const error = new Error('Attempt not found');
    (error as Error & { code?: string }).code = 'ATTEMPT_NOT_FOUND';
    throw error;
  }

  const progress = await ClassmojiService.quizGrading.getProgress(chatId);
  const questionCount = progress.questionCount;
  const stable = await loadStableParts(attempt, questionCount, log, opts.env ?? process.env);

  const settings = resolveQuizRunSettings(
    attempt.quiz.classroom?.settings ?? null,
    { isCodeAware: stable.isCodeAware },
    opts.env
  );
  if (settings.fallbacks.length > 0) {
    log('[quiz-agent] settings not used', {
      attemptId: attempt.id,
      settings: settings.fallbacks.join(','),
    });
  }

  return {
    attemptId: attempt.id,
    userId: attempt.user_id,
    classroomId: attempt.quiz.classroom_id,
    quizId: attempt.quiz_id,
    questionCount,
    isCodeAware: stable.isCodeAware,
    fence: admission.fence,
    inputMessageId: admission.inputMessageId,
    runId: admission.runId,
    lastAction: admission.action,
    model: settings.model,
    questionEffort: settings.questionEffort,
    gradingEffort: settings.gradingEffort,
    apiKey: settings.apiKey,
    keySource: settings.keySource,
    exploration: stable.exploration
      ? {
          ...stable.exploration,
          model: settings.exploration.model,
          effort: settings.exploration.effort,
        }
      : null,
    prompt: stable.prompt,
    progress,
    sourceMaterialUnavailable: stable.sourceMaterialUnavailable,
    content: stable.content,
    codeUnavailable: stable.codeUnavailable,
    welcome: quizWelcome({
      subject: attempt.quiz.subject ?? null,
      quizName: attempt.quiz.name ?? null,
      questionCount,
      isCodeAware: stable.isCodeAware,
      codeUnavailable: stable.codeUnavailable,
    }),
  };
}

/** Whether the attempt has presented any question yet (the `begin` action runs only before). */
export async function attemptHasQuestion(chatId: string): Promise<boolean> {
  const progress = await ClassmojiService.quizGrading.getProgress(chatId);
  return progress.presented > 0;
}

/** Whether the attempt is completed (the session then closes). */
export async function attemptCompleted(chatId: string): Promise<boolean> {
  const progress = await ClassmojiService.quizGrading.getProgress(chatId);
  return Boolean(progress.completed);
}
