/**
 * classroomImport.ts — the background half of "create a classroom from an
 * existing one".
 *
 * The create-classroom action keeps only what finishes in seconds (the
 * classroom/settings/membership transaction, the settings+scales+calendar copy,
 * and the repository/assignment/quiz clone — all pure DB), then hands every
 * GitHub-bound phase to this orchestrator and returns immediately. Before this
 * existed the whole copy ran inside the request: a real course spent 40+
 * minutes in it, with the browser watching a spinner and no way to tell a slow
 * import from a dead one.
 *
 * Topology — one orchestrator, four children, each awaited in order:
 *
 *   classroom-import (orchestrator, maxAttempts 1, maxDuration 3600)
 *     ├─ import-content-repo   provision the target content repo   (before templates)
 *     ├─ import-templates      duplicate + relink template repos
 *     ├─ import-content        clone/push the content repo, then Page/Slide rows
 *     └─ import-modules        module containers, remapped onto every earlier id
 *
 * Children rather than inline steps because each is a separately retryable unit
 * of work with its own failure surface, and because a child's output is visible
 * per-phase in the Trigger.dev run tree. Every task is `maxAttempts: 1`: none of
 * these phases is idempotent enough to replay blindly, so recovery is the
 * explicit user-driven retry (which resumes, skipping phases already `done`).
 *
 * ALL task input comes from the `ImportJob` row, never the payload — the
 * payload is a bare `{ importJobId }`. That is what makes a run replayable and
 * what lets the retry endpoint resume a half-finished import by editing the row.
 */

import { task, logger } from '@trigger.dev/sdk';
import getPrisma from '@classmoji/database';
import { ClassmojiService, describeTokenMintError, getGitProvider } from '@classmoji/services';
/*
 * The zero-import progress module, via its package subpath export. The eslint
 * resolver here does not follow "exports" subpaths (the same reason
 * trigger.config.js disables this rule); tsc and the bundler both resolve it.
 */
import {
  applyPhaseUpdates,
  buildSummaryParts,
  importedSourceIds,
  overallPercent,
  withCounts,
  withIdMaps,
  withSummaryParts,
  CONTENT_PHASE_KEYS,
  type ImportIdMaps,
  type ImportJobSelections,
  type ImportPhaseUpdate,
  type ImportProgress,
  type ImportSummaryCounts,
} from '@classmoji/services/import-progress'; // eslint-disable-line import/no-unresolved
import { titleToIdentifier } from '@classmoji/utils';
import { cloneContentRepo } from '../helpers/cloneContentRepo.ts';

/**
 * Minimum spacing between `progress` writes.
 *
 * The per-item callbacks fire far faster than anything needs to be persisted (a
 * page-row loop can tick dozens of times a second), and every write is a row
 * update the banner polls at 2s anyway. Debouncing to 1s keeps the bar live
 * without turning progress reporting into the job's dominant DB load.
 */
const PROGRESS_WRITE_INTERVAL_MS = 1000;

/** Cap on retained warnings, mirroring the services' own bound. */
const MAX_WARNINGS = 50;

type PrismaClient = ReturnType<typeof getPrisma>;

/** The ImportJob row as every task here reads it, with the Json columns typed. */
interface LoadedImportJob {
  id: string;
  classroom_id: string;
  source_classroom_id: string;
  requested_by: string;
  status: string;
  phase: string | null;
  selections: ImportJobSelections;
  progress: ImportProgress;
  warnings: string[];
}

/**
 * Load the job row and give its Json columns their real shapes. Throws when the
 * row is gone — a run whose job was deleted (the classroom was removed
 * mid-import) has nothing to do and nowhere to report.
 */
async function loadJob(prisma: PrismaClient, importJobId: string): Promise<LoadedImportJob> {
  const job = await prisma.importJob.findUnique({ where: { id: importJobId } });
  if (!job) {
    throw new Error(`ImportJob ${importJobId} no longer exists`);
  }
  return {
    id: job.id,
    classroom_id: job.classroom_id,
    source_classroom_id: job.source_classroom_id,
    requested_by: job.requested_by,
    status: job.status,
    phase: job.phase,
    selections: (job.selections ?? {}) as unknown as ImportJobSelections,
    progress: (job.progress ?? {}) as unknown as ImportProgress,
    warnings: (job.warnings ?? []) as unknown as string[],
  };
}

/**
 * Debounced, WHOLESALE writer for one job's `progress`.
 *
 * Owns the canonical progress object in memory and persists it entire, never
 * read-modify-write: the pure reducer already guarantees a new object per
 * patch, and a wholesale write cannot lose a field to a racing read. That is
 * safe here because exactly one task writes a given job at a time —
 * `triggerAndWait` serializes the children, and the orchestrator re-reads the
 * row after each child returns rather than keeping a stale copy.
 *
 * Writes are spaced by PROGRESS_WRITE_INTERVAL_MS on a TRAILING timer, so a
 * single late patch (a rate-limit note posted just after a write) still lands
 * about a second later instead of waiting for the next patch — which for a 15s
 * pacing sleep would be the whole point of the note, lost.
 */
class ProgressWriter {
  readonly #prisma: PrismaClient;
  readonly #jobId: string;
  #progress: ImportProgress;
  #warnings: string[];
  #timer: ReturnType<typeof setTimeout> | null = null;
  #lastWriteAt = 0;
  #dirty = false;
  #chain: Promise<void> = Promise.resolve();

  constructor(prisma: PrismaClient, job: LoadedImportJob) {
    this.#prisma = prisma;
    this.#jobId = job.id;
    this.#progress = job.progress;
    this.#warnings = job.warnings;
  }

  get progress(): ImportProgress {
    return this.#progress;
  }

  /** Patch one or more phases (counts, status, note). */
  patch(...updates: ImportPhaseUpdate[]): void {
    this.#progress = applyPhaseUpdates(this.#progress, updates);
    this.#schedule();
  }

  /** Record ids this phase minted, for the modules hand-off and for resume. */
  mergeIdMaps(maps: ImportIdMaps): void {
    this.#progress = withIdMaps(this.#progress, maps);
    this.#schedule();
  }

  /** Record what this phase imported, for the final success line. */
  mergeCounts(counts: ImportSummaryCounts): void {
    this.#progress = withCounts(this.#progress, counts);
    this.#schedule();
  }

  /** Append best-effort per-item failures (bounded, same cap as the services). */
  addWarnings(warnings: readonly string[]): void {
    if (warnings.length === 0) return;
    this.#warnings = [...this.#warnings, ...warnings].slice(0, MAX_WARNINGS);
    this.#schedule();
  }

  #schedule(): void {
    this.#dirty = true;
    if (this.#timer) return;
    const wait = Math.max(0, PROGRESS_WRITE_INTERVAL_MS - (Date.now() - this.#lastWriteAt));
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#write();
    }, wait);
  }

  /** Serialized so a timer write and a flush can never interleave. */
  #write(): Promise<void> {
    this.#chain = this.#chain.then(() => this.#persist());
    return this.#chain;
  }

  async #persist(): Promise<void> {
    if (!this.#dirty) return;
    this.#dirty = false;
    this.#lastWriteAt = Date.now();
    const progress = this.#progress;
    const warnings = this.#warnings;
    try {
      await this.#prisma.importJob.update({
        where: { id: this.#jobId },
        data: {
          progress: progress as unknown as object,
          warnings: warnings as unknown as object,
        },
      });
    } catch (error: unknown) {
      // Progress must never fail the import it is describing. Stay dirty so the
      // next tick (or the awaited final flush) retries the same snapshot.
      this.#dirty = true;
      logger.warn('import progress write failed', { jobId: this.#jobId, error });
    }
  }

  /**
   * Persist immediately and await it. Every child calls this before returning,
   * so the row is never left describing a phase that already finished.
   */
  async flush(): Promise<void> {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
    this.#dirty = true;
    await this.#write();
  }
}

/**
 * Fire-and-forget progress callback plumbing for the services, which invoke
 * `onProgress` without awaiting it. Patching is synchronous (the writer batches
 * the DB work itself), so nothing here can slow or fail an import.
 */
function phaseProgress(
  writer: ProgressWriter,
  phase: ImportPhaseUpdate['phase']
): (update: { done: number; total: number; note?: string | null }) => void {
  return ({ done, total, note }) => {
    writer.patch({ phase, status: 'running', done, total, note });
  };
}

/**
 * Re-verify that the requester still OWNS the source classroom, at the moment
 * the copy actually happens.
 *
 * Defense in depth: the create-classroom action already checked this before
 * creating the row, but the copy now runs later, in a different process, from
 * data on a row. Ownership can be revoked in between, and settings can carry
 * API keys — so the task refuses rather than trusting its own input.
 */
async function assertSourceOwnership(prisma: PrismaClient, job: LoadedImportJob): Promise<void> {
  const membership = await prisma.classroomMembership.findFirst({
    where: {
      classroom_id: job.source_classroom_id,
      user_id: job.requested_by,
      role: 'OWNER',
    },
    select: { id: true },
  });
  if (!membership) {
    throw new Error('Requester no longer owns the source classroom — import refused');
  }
}

/** A classroom's org login + content repo, or null when either is unconfigured. */
async function contentRepoCoordinates(
  prisma: PrismaClient,
  classroomId: string
): Promise<{ orgLogin: string; repo: string; token: string } | null> {
  const classroom = await prisma.classroom.findUnique({
    where: { id: classroomId },
    include: { git_organization: true },
  });
  const org = classroom?.git_organization;
  if (!classroom || !org?.login || !classroom.content_repo) return null;

  // Name the org on a mint failure. The provider's own error is a bare "Failed
  // to retrieve GitHub installation token (404)", which as a phase error in the
  // banner tells the user nothing — least of all that the real cause is an
  // installation id belonging to a different environment's GitHub App. Both the
  // source and target org come through here, so the org login is what
  // identifies which side is unreachable. getGitProvider is inside the try: it
  // throws synchronously when the row has no installation id.
  try {
    const token = await getGitProvider(org).getAccessToken();
    return { orgLogin: org.login, repo: classroom.content_repo, token };
  } catch (error: unknown) {
    throw new Error(describeTokenMintError(org.login, error));
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Children
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Provision the TARGET content repo, before anything wants to write to it.
 *
 * Runs ahead of templates deliberately: repo creation is the operation GitHub's
 * secondary rate limit punishes, and the content repo is the one the rest of
 * the import cannot proceed without. Idempotent (ensureContentRepo adopts an
 * existing repo), so a resumed run simply re-confirms it.
 */
export const importContentRepoTask = task({
  id: 'import-content-repo',
  retry: { maxAttempts: 1 },
  maxDuration: 600,
  run: async ({ importJobId }: { importJobId: string }) => {
    const prisma = getPrisma();
    const job = await loadJob(prisma, importJobId);
    const writer = new ProgressWriter(prisma, job);

    // The content phases own this step: it has no chip of its own, and a
    // failure here is a content failure as far as the user is concerned.
    const running = CONTENT_PHASE_KEYS.filter(
      key => job.progress.phases[key]?.status !== 'skipped'
    );
    writer.patch(
      ...running.map(phase => ({
        phase,
        status: 'running' as const,
        note: 'preparing the content repository',
      }))
    );
    await writer.flush();

    try {
      const { repoName } = await ClassmojiService.page.ensureContentRepo(job.classroom_id);
      logger.info('import: content repo ready', { repo: repoName });
      return { repo: repoName };
    } finally {
      writer.patch(...running.map(phase => ({ phase, note: null })));
      await writer.flush();
    }
  },
});

/**
 * Duplicate the template repos the imported assignments point at, into the
 * target org, and repoint the imported rows at the copies.
 *
 * The slowest phase by design: creates are paced 15s apart to stay under
 * GitHub's secondary content-creation limit (see templateImport.service), and
 * that pacing surfaces as a phase note so the wait reads as a wait.
 */
export const importTemplatesTask = task({
  id: 'import-templates',
  retry: { maxAttempts: 1 },
  // Pacing alone costs 15s per template, and a tripped secondary limit adds up
  // to 3 backoffs of up to 2 minutes each — well past the 900s config default.
  maxDuration: 3600,
  run: async ({ importJobId }: { importJobId: string }) => {
    const prisma = getPrisma();
    const job = await loadJob(prisma, importJobId);
    const writer = new ProgressWriter(prisma, job);

    const importedRepositoryIds = Object.values(job.progress.id_maps?.repositories ?? {});
    writer.patch({ phase: 'templates', status: 'running' });

    const summary = await ClassmojiService.templateImport.duplicateImportedTemplates(
      job.source_classroom_id,
      job.classroom_id,
      importedRepositoryIds,
      {
        onProgress: phaseProgress(writer, 'templates'),
        // Resume: templates a previous attempt already duplicated are relinked,
        // not made a second time.
        knownTemplateMap: job.progress.id_maps?.templates ?? {},
      }
    );

    writer.mergeIdMaps({ templates: summary.template_map });
    writer.mergeCounts({
      duplicated_templates: Object.keys({
        ...job.progress.id_maps?.templates,
        ...summary.template_map,
      }).length,
    });
    writer.addWarnings(summary.warnings);
    writer.patch({ phase: 'templates', status: 'done', note: null });
    await writer.flush();

    return { duplicated: summary.duplicated, relinked: summary.relinked };
  },
});

/**
 * Copy the source classroom's page + slide-deck content.
 *
 * Two halves: one git clone+force-push of the whole content repo (see
 * helpers/cloneContentRepo — minutes rather than the 40+ the file-by-file
 * Contents API path cost), then the Page/Slide rows that point into it.
 *
 * Because the target repo is FRESH, every item keeps its source `content_path`
 * verbatim — no dedupe, no suffixing, no path rewriting. That is what lets the
 * bulk copy be a single tree push instead of a per-item staged commit.
 */
export const importContentTask = task({
  id: 'import-content',
  retry: { maxAttempts: 1 },
  maxDuration: 3600,
  run: async ({ importJobId }: { importJobId: string }) => {
    const prisma = getPrisma();
    const job = await loadJob(prisma, importJobId);
    const writer = new ProgressWriter(prisma, job);

    const wantPages = job.progress.phases.pages?.status !== 'skipped';
    const wantSlides = job.progress.phases.slides?.status !== 'skipped';
    const activePhases = CONTENT_PHASE_KEYS.filter(key =>
      key === 'pages' ? wantPages : wantSlides
    );

    const [source, target] = await Promise.all([
      contentRepoCoordinates(prisma, job.source_classroom_id),
      contentRepoCoordinates(prisma, job.classroom_id),
    ]);
    if (!source) {
      // A source with no content repo has no content — zeros and a warning,
      // exactly as the per-file importer behaved.
      writer.addWarnings(['source: source classroom has no configured content repository']);
      writer.patch(...activePhases.map(phase => ({ phase, status: 'done' as const, note: null })));
      await writer.flush();
      return { pages: 0, slides: 0, pushed: false };
    }
    if (!target) {
      throw new Error('Target classroom content repository is not configured');
    }

    writer.patch(
      ...activePhases.map(phase => ({
        phase,
        status: 'running' as const,
        note: 'copying the content repository',
      }))
    );
    await writer.flush();

    const clone = await cloneContentRepo({
      source,
      target,
      keepPages: wantPages,
      keepSlides: wantSlides,
      commitMessage: `Import content from ${source.repo}`,
      onStep: note => writer.patch(...activePhases.map(phase => ({ phase, note }))),
    });
    writer.patch(...activePhases.map(phase => ({ phase, note: null })));
    await writer.flush();

    if (!clone.pushed) {
      // Nothing reached the target repo (an empty source, or everything pruned
      // away). Creating rows now would point every page and deck at a path that
      // does not exist — a classroom full of broken content, which is worse
      // than an empty one. Say so and stop.
      writer.addWarnings(['content: no files were copied — no pages or decks were created']);
      writer.patch(...activePhases.map(phase => ({ phase, status: 'done' as const, note: null })));
      await writer.flush();
      return { pages: 0, slides: 0, pushed: false, files: clone.files };
    }

    const counts = { pages: 0, slides: 0 };
    if (wantPages) {
      counts.pages = await importPageRows({ prisma, job, writer, source, target });
    }
    if (wantSlides) {
      counts.slides = await importSlideRows({ prisma, job, writer });
    }

    // Rebuilt wholesale from the TARGET's rows — the source's manifest was
    // deliberately dropped from the pushed tree.
    if (counts.pages > 0 || counts.slides > 0) {
      try {
        await ClassmojiService.contentManifest.saveManifest(job.classroom_id);
      } catch (error: unknown) {
        writer.addWarnings([`manifest: failed to refresh target manifest: ${errText(error)}`]);
      }
    }

    writer.patch(...activePhases.map(phase => ({ phase, status: 'done' as const, note: null })));
    writer.mergeCounts(counts);
    await writer.flush();

    return { ...counts, pushed: clone.pushed, files: clone.files };
  },
});

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Create the target Page rows for every source page not already imported.
 *
 * `content_path` is copied VERBATIM: the git push already put the files at
 * exactly those paths in the fresh target repo. Only the header image URL is
 * rewritten, with the same pure helper that rewrote the pushed files, so a
 * deleted source repo cannot 404 the imported page's banner.
 */
async function importPageRows({
  prisma,
  job,
  writer,
  source,
  target,
}: {
  prisma: PrismaClient;
  job: LoadedImportJob;
  writer: ProgressWriter;
  source: { orgLogin: string; repo: string };
  target: { orgLogin: string; repo: string };
}): Promise<number> {
  const { rewriteContentUrls } = ClassmojiService.contentImport;
  const sourcePages = await prisma.page.findMany({
    where: { classroom_id: job.source_classroom_id },
    orderBy: { created_at: 'asc' },
  });
  const already = importedSourceIds(writer.progress, 'pages');
  const total = sourcePages.length;
  writer.patch({ phase: 'pages', status: 'running', done: already.size, total });

  let done = already.size;
  let created = 0;
  const warnings: string[] = [];
  for (const page of sourcePages) {
    // Resume: this page's row already exists from an earlier attempt. It still
    // counts as done — it IS imported — and it is not warned about.
    if (already.has(page.id)) continue;
    try {
      const row = await prisma.page.create({
        data: {
          classroom_id: job.classroom_id,
          title: page.title,
          slug: titleToIdentifier(page.title),
          content_path: page.content_path,
          created_by: job.requested_by,
          is_draft: true,
          is_public: false,
          width: page.width,
          show_in_student_menu: page.show_in_student_menu,
          menu_order: page.menu_order,
          header_image_url: page.header_image_url
            ? rewriteContentUrls(page.header_image_url, {
                sourceLogin: source.orgLogin,
                sourceRepo: source.repo,
                sourcePath: '',
                targetLogin: target.orgLogin,
                targetRepo: target.repo,
                targetPath: '',
              })
            : page.header_image_url,
          header_image_position: page.header_image_position,
        },
      });
      writer.mergeIdMaps({ pages: { [page.id]: row.id } });
      created++;
    } catch (error: unknown) {
      warnings.push(`pages: DB row failed for "${page.title}": ${errText(error)}`);
    } finally {
      done++;
      writer.patch({ phase: 'pages', status: 'running', done, total });
    }
  }

  writer.addWarnings(warnings);
  return created;
}

/**
 * Slide-deck equivalent of importPageRows. Takes no repo coordinates: a deck
 * carries no URL-bearing column of its own (its asset URLs live inside
 * deck.json, which the push already rewrote), and `slug` is copied verbatim
 * because it IS the content path segment.
 */
async function importSlideRows({
  prisma,
  job,
  writer,
}: {
  prisma: PrismaClient;
  job: LoadedImportJob;
  writer: ProgressWriter;
}): Promise<number> {
  const sourceSlides = await prisma.slide.findMany({
    where: { classroom_id: job.source_classroom_id },
    orderBy: { created_at: 'asc' },
  });
  const already = importedSourceIds(writer.progress, 'slides');
  const total = sourceSlides.length;
  writer.patch({ phase: 'slides', status: 'running', done: already.size, total });

  let done = already.size;
  let created = 0;
  const warnings: string[] = [];
  for (const slide of sourceSlides) {
    if (already.has(slide.id)) continue;
    try {
      const row = await prisma.slide.create({
        data: {
          classroom_id: job.classroom_id,
          title: slide.title,
          slug: slide.slug,
          content_path: slide.content_path,
          created_by: job.requested_by,
          is_draft: true,
          is_public: false,
          allow_team_edit: slide.allow_team_edit,
          show_speaker_notes: slide.show_speaker_notes,
        },
      });
      writer.mergeIdMaps({ slides: { [slide.id]: row.id } });
      created++;
    } catch (error: unknown) {
      warnings.push(`slides: DB row failed for "${slide.title}": ${errText(error)}`);
    } finally {
      done++;
      writer.patch({ phase: 'slides', status: 'running', done, total });
    }
  }

  writer.addWarnings(warnings);
  return created;
}

/**
 * Copy the module containers LAST: their items reference repositories, quizzes,
 * pages and slides by id, and every one of those maps was minted by an earlier
 * phase and carried here on the job row.
 */
export const importModulesTask = task({
  id: 'import-modules',
  retry: { maxAttempts: 1 },
  maxDuration: 900,
  run: async ({ importJobId }: { importJobId: string }) => {
    const prisma = getPrisma();
    const job = await loadJob(prisma, importJobId);
    const writer = new ProgressWriter(prisma, job);

    writer.patch({ phase: 'modules', status: 'running' });
    await writer.flush();

    const idMaps = job.progress.id_maps ?? {};
    const summary = await ClassmojiService.classroomConfigImport.importModules(
      job.source_classroom_id,
      job.classroom_id,
      {
        repositories: idMaps.repositories ?? {},
        quizzes: idMaps.quizzes ?? {},
        pages: idMaps.pages ?? {},
        slides: idMaps.slides ?? {},
      }
    );

    writer.mergeCounts({ modules: summary.modules });
    if (summary.skipped_items > 0) {
      writer.addWarnings([
        `modules: ${summary.skipped_items} item${summary.skipped_items === 1 ? '' : 's'} could not be remapped and were skipped`,
      ]);
    }
    writer.patch({
      phase: 'modules',
      status: 'done',
      summary: `${summary.modules} module${summary.modules === 1 ? '' : 's'}, ${summary.items} item${summary.items === 1 ? '' : 's'}`,
    });
    await writer.flush();

    return summary;
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Orchestrator
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every child takes the same bare payload and the orchestrator only reads
 * `.ok`/`.error` off the result, so the plan is typed on that shape alone —
 * the children's differing outputs would otherwise have no common type.
 */
type ImportChildTask = {
  triggerAndWait: (payload: {
    importJobId: string;
  }) => Promise<{ ok: true } | { ok: false; error: unknown }>;
};

/** One phase of the run: which child performs it, and which chips it owns. */
interface PhasePlan {
  /** Value written to the coarse `ImportJob.phase` column. */
  name: string;
  child: ImportChildTask;
  /** Progress phase keys marked failed if the child fails. */
  keys: ImportPhaseUpdate['phase'][];
}

export const classroomImportTask = task({
  id: 'classroom-import',
  // A partial import must never be replayed from the top: the per-item creates
  // are not idempotent. Recovery is the user-driven retry, which resumes.
  retry: { maxAttempts: 1 },
  maxDuration: 3600,
  run: async ({ importJobId }: { importJobId: string }) => {
    const prisma = getPrisma();
    try {
      return await runImport(prisma, importJobId);
    } catch (error: unknown) {
      // A throw ANYWHERE in the orchestrator itself — the ownership re-check, a
      // row re-read, a status write, the finalize — would otherwise leave the
      // job stuck RUNNING (or PENDING). The banner would poll that forever and
      // the retry endpoint refuses anything that is not FAILED, so the user
      // would have no way out at all. Record the failure, then rethrow so the
      // Trigger run is still marked failed.
      await prisma.importJob
        .update({
          where: { id: importJobId },
          data: { status: 'FAILED', error: errText(error) },
        })
        .catch(() => {});
      throw error;
    }
  },
});

/** The orchestrator's body, extracted so one catch can cover all of it. */
async function runImport(prisma: PrismaClient, importJobId: string) {
  {
    let job = await loadJob(prisma, importJobId);

    await assertSourceOwnership(prisma, job);

    await prisma.importJob.update({
      where: { id: job.id },
      data: { status: 'RUNNING', error: null },
    });

    const selections = job.selections.content ?? {};
    const wantsContent =
      job.progress.phases.pages?.status !== 'skipped' ||
      job.progress.phases.slides?.status !== 'skipped';

    const plan: PhasePlan[] = [];
    // Content repo first: it is what the content push needs, and doing its repo
    // creation before the paced template creates keeps it out of their backoff.
    if (wantsContent) {
      plan.push({ name: 'content', child: importContentRepoTask, keys: [...CONTENT_PHASE_KEYS] });
    }
    if (selections.duplicateTemplates) {
      plan.push({ name: 'templates', child: importTemplatesTask, keys: ['templates'] });
    }
    if (wantsContent) {
      plan.push({ name: 'content', child: importContentTask, keys: [...CONTENT_PHASE_KEYS] });
    }
    if (selections.modules) {
      plan.push({ name: 'modules', child: importModulesTask, keys: ['modules'] });
    }

    for (const step of plan) {
      // Re-read every time: the previous child wrote id maps and counts this
      // one needs, and an in-memory copy from before it ran would clobber them.
      job = await loadJob(prisma, importJobId);

      // Resume: a phase already finished stays finished. The content-repo step
      // has no chip of its own, so it re-runs (idempotent) whenever the content
      // phases have not both completed.
      const allDone = step.keys.every(key => job.progress.phases[key]?.status === 'done');
      if (allDone) {
        logger.info('import: phase already complete, skipping', { phase: step.name });
        continue;
      }

      await prisma.importJob.update({ where: { id: job.id }, data: { phase: step.name } });

      const result = await step.child.triggerAndWait({ importJobId });
      if (!result.ok) {
        return failJob(prisma, importJobId, step, result.error);
      }
    }

    // ── Finalize ──────────────────────────────────────────────────────────
    job = await loadJob(prisma, importJobId);
    const finished = withSummaryParts(job.progress, buildSummaryParts(job.progress.counts ?? {}));
    await prisma.importJob.update({
      where: { id: job.id },
      data: {
        status: 'COMPLETED',
        phase: null,
        error: null,
        progress: finished as unknown as object,
      },
    });

    logger.info('import: completed', {
      importJobId,
      percent: overallPercent(finished),
      parts: finished.parts,
    });
    return { status: 'COMPLETED', parts: finished.parts };
  }
}

/**
 * Record a failed phase and stop: the chips it owns go `failed`, the job goes
 * FAILED with the error, and every LATER phase is left `pending` — untouched,
 * so a retry resumes there rather than starting over. Everything already
 * imported stays imported; nothing is rolled back.
 */
async function failJob(
  prisma: PrismaClient,
  importJobId: string,
  step: PhasePlan,
  error: unknown
): Promise<{ status: string; phase: string; error: string }> {
  const message = errText(error);
  logger.error('import: phase failed', { phase: step.name, error: message });

  const job = await loadJob(prisma, importJobId);
  const progress = applyPhaseUpdates(
    job.progress,
    step.keys
      .filter(key => job.progress.phases[key]?.status !== 'skipped')
      .map(key => ({ phase: key, status: 'failed' as const, note: null }))
  );

  await prisma.importJob.update({
    where: { id: importJobId },
    data: {
      status: 'FAILED',
      phase: step.name,
      error: message,
      progress: progress as unknown as object,
    },
  });

  return { status: 'FAILED', phase: step.name, error: message };
}
