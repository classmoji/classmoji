import { createHash } from 'node:crypto';
import { logger, schemaTask } from '@trigger.dev/sdk';
import getPrisma from '@classmoji/database';
import { ClassmojiService, ContentService } from '@classmoji/services';
import {
  applyDeckOps,
  ensureSlideBlockIds,
  isDeckSlide,
  mintHtmlBlockFileSrc,
  prepareDeckForSave,
  readSlideBlocks,
  recordDeckCommit,
  resolveSharedThemeUrls,
  type DeckJson,
  type DeckOp,
  type DeckSlide,
  type SlideContentTarget,
} from '@classmoji/services/slides'; // eslint-disable-line import/no-unresolved

/**
 * `html-block-convert` — move the code of html blocks made before blocks were
 * files out of the slide and into the deck's `blocks/<8 hex>.html` files.
 * Operator-run; never triggered by the app.
 *
 * For every deck (of one classroom, or all) whose deck.json holds an html
 * block with its code in `srcdoc`: each such block's code (the storage shim
 * taken out) becomes a new file, the block becomes
 * `data-cm-src="blocks/<name>.html" data-cm-rev="<blob sha>"`, and the files,
 * deck.json and the regenerated index.html land in ONE commit, compare-and-
 * swapped on deck.json's sha (a deck saved meanwhile is skipped and reported).
 * The commit carries no live-editing trailer: for a deck open live, the push
 * reaches the room as an outside change and is merged there.
 *
 * A deck with no deck.json (an index.html-only deck) is not converted; it is
 * listed in the result as `no-deck-json` so it can be opened and saved first.
 *
 * Payload `{ dryRun = true, classroomId?, limit? }`: the dry run reads and
 * plans, writes nothing. `limit` caps the decks converted (or planned).
 * Only classrooms the content service delivers are touched. Idempotent: a
 * converted deck has no srcdoc block left.
 *
 * Not in `src/index.ts` (Trigger finds it through `dirs`): nothing in the apps
 * triggers it.
 */

export const HTML_BLOCK_CONVERT_TASK_ID = 'html-block-convert';

export interface HtmlBlockConvertPayload {
  dryRun: boolean;
  classroomId?: string;
  limit?: number;
}

const PAYLOAD_KEYS = ['dryRun', 'classroomId', 'limit'] as const;

const reject = (message: string): never => {
  throw new Error(`[${HTML_BLOCK_CONVERT_TASK_ID}] ${message}`);
};

/** Strict payload validation, run by `schemaTask` before `run`; a dry run is the default. */
export function parseConvertPayload(input: unknown): HtmlBlockConvertPayload {
  if (input === undefined || input === null) return { dryRun: true };
  if (typeof input !== 'object' || Array.isArray(input)) reject('payload must be an object');
  const raw = input as Record<string, unknown>;
  const unknown = Object.keys(raw).filter(
    key => !(PAYLOAD_KEYS as readonly string[]).includes(key)
  );
  if (unknown.length > 0) {
    reject(
      `unknown payload key(s): ${unknown.join(', ')} — expected only ${PAYLOAD_KEYS.join(', ')}`
    );
  }
  if (raw.dryRun !== undefined && typeof raw.dryRun !== 'boolean')
    reject('dryRun must be a boolean');
  const payload: HtmlBlockConvertPayload = { dryRun: raw.dryRun !== false };
  if (raw.classroomId !== undefined) {
    if (typeof raw.classroomId !== 'string' || !raw.classroomId)
      reject('classroomId must be a string');
    payload.classroomId = raw.classroomId as string;
  }
  if (raw.limit !== undefined) {
    const value = raw.limit;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      reject('limit must be a positive integer');
    }
    payload.limit = value as number;
  }
  return payload;
}

// ─── The plan for one deck (pure) ────────────────────────────────────────────

/** The git blob sha of `content` (what the commit will record for the file). */
export function gitBlobSha(content: string): string {
  const bytes = Buffer.from(content, 'utf8');
  return createHash('sha1')
    .update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes]))
    .digest('hex');
}

export interface PlannedBlockFile {
  slideId: string;
  blockId: string;
  /** Relative to the deck folder: `blocks/<8 hex>.html`. */
  src: string;
  html: string;
  rev: string;
}

function eachSlide(slides: DeckSlide[], visit: (slide: DeckSlide) => void): void {
  for (const slide of slides) {
    visit(slide);
    if (slide.children) eachSlide(slide.children, visit);
  }
}

/**
 * The deck with every legacy (srcdoc) html block pointed at a new file, and
 * the files; null when it has none. `taken` holds the `blocks/` names the deck
 * folder already has; new names avoid them (and each other).
 */
export function planDeckConversion(
  deck: DeckJson,
  taken: ReadonlySet<string>,
  mint: () => string = mintHtmlBlockFileSrc
): { deck: DeckJson; files: PlannedBlockFile[] } | null {
  const used = new Set(taken);
  const files: PlannedBlockFile[] = [];
  eachSlide(deck.slides, slide => {
    const html = slide.html;
    if (!html || !/data-block-type/i.test(html) || !/srcdoc/i.test(html)) return;
    for (const block of readSlideBlocks(ensureSlideBlockIds(html))) {
      if (block.type !== 'html' || block.src !== undefined || block.source === undefined) continue;
      let src = mint();
      while (used.has(src)) src = mint();
      used.add(src);
      files.push({
        slideId: slide.id,
        blockId: block.id as string,
        src,
        html: block.source,
        rev: gitBlobSha(block.source),
      });
    }
  });
  if (files.length === 0) return null;
  const ops: DeckOp[] = files.map(file => ({
    op: 'block_update',
    slide: file.slideId,
    block_id: file.blockId,
    src: file.src,
    rev: file.rev,
  }));
  return { deck: applyDeckOps(deck, ops).deck, files };
}

// ─── The run ─────────────────────────────────────────────────────────────────

/** A deck row with the classroom chain the content repo lives under. */
export interface ConvertDeck extends SlideContentTarget {
  id: string;
  classroom_id: string;
  created_by: string;
  classroom: NonNullable<SlideContentTarget['classroom']> & { id: string };
}

export interface ConvertDeps {
  /** Deck slides of delivered classrooms (one classroom when given), oldest first. */
  listDecks(opts: { classroomId?: string }): Promise<ConvertDeck[]>;
  content: Pick<
    typeof ContentService,
    'getMeta' | 'getContent' | 'getLargeContent' | 'listFolder' | 'uploadBatch'
  >;
  branchOf(deck: ConvertDeck): Promise<string>;
  /** deck.json + index.html bytes, exactly as a save writes them. */
  prepare(
    deck: ConvertDeck,
    json: DeckJson
  ): Promise<{ deckPath: string; htmlPath: string; deckJson: string; html: string }>;
  /** After the commit: asset map rows (files and folders), thumbnail, index, updated_at. */
  record(
    deck: ConvertDeck,
    committed: { commit: string; treeSha?: string; files: Array<{ path: string; sha: string }> },
    written: Array<{ path: string; content: string }>
  ): Promise<void>;
  audit(deck: ConvertDeck, data: Record<string, unknown>): Promise<void>;
  log(message: string, detail?: Record<string, unknown>): void;
}

export interface DeckConversionReport {
  slideId: string;
  classroomId: string;
  path: string;
  blocks: number;
  status: 'planned' | 'converted' | 'conflict' | 'failed' | 'no-deck-json';
  commit?: string;
  error?: string;
}

export interface HtmlBlockConvertResult {
  mode: 'dry-run' | 'execute';
  counts: {
    scanned: number;
    noDeckJson: number;
    withLegacyBlocks: number;
    blocks: number;
    converted: number;
    conflicts: number;
    failed: number;
  };
  decks: DeckConversionReport[];
}

/** deck.json changed since it was read: the commit is refused. */
class DeckChangedError extends Error {
  constructor() {
    super('deck.json changed since it was read');
    this.name = 'DeckChangedError';
  }
}

const ONE_MB = 1024 * 1024;

async function readDeckJson(
  deps: ConvertDeps,
  deck: ConvertDeck
): Promise<{ sha: string; text: string } | null> {
  const args = {
    gitOrganization: deck.classroom.git_organization as never,
    repo: deck.classroom.content_repo ?? '',
    path: `${deck.content_path}/deck.json`,
  };
  const meta = await deps.content.getMeta({ ...args, skipCache: true });
  if (!meta) return null;
  if (meta.size > ONE_MB) {
    const large = await deps.content.getLargeContent(args);
    return large
      ? { sha: large.sha, text: Buffer.from(large.content, 'base64').toString('utf8') }
      : null;
  }
  const file = await deps.content.getContent({ ...args, skipCache: true });
  return file ? { sha: file.sha, text: file.content } : null;
}

/** The `blocks/<name>` refs the deck folder already holds. */
async function takenBlockNames(deps: ConvertDeps, deck: ConvertDeck): Promise<Set<string>> {
  const listing = await deps.content.listFolder({
    gitOrganization: deck.classroom.git_organization as never,
    repo: deck.classroom.content_repo ?? '',
    path: `${deck.content_path}/blocks`,
    skipCache: true,
  });
  return new Set(listing.map(entry => `blocks/${entry.name}`));
}

/** One deck: plan, and (not a dry run) commit, record and audit. */
async function convertDeck(
  deps: ConvertDeps,
  deck: ConvertDeck,
  dryRun: boolean,
  counts: HtmlBlockConvertResult['counts']
): Promise<DeckConversionReport | null> {
  const stored = await readDeckJson(deps, deck);
  if (!stored) {
    counts.noDeckJson++;
    return {
      slideId: deck.id,
      classroomId: deck.classroom_id,
      path: deck.content_path,
      blocks: 0,
      status: 'no-deck-json',
    };
  }
  const json = JSON.parse(stored.text) as DeckJson;
  if (!JSON.stringify(json.slides ?? []).includes('srcdoc')) return null;
  const plan = planDeckConversion(json, await takenBlockNames(deps, deck));
  if (!plan) return null;

  counts.withLegacyBlocks++;
  counts.blocks += plan.files.length;
  const report: DeckConversionReport = {
    slideId: deck.id,
    classroomId: deck.classroom_id,
    path: deck.content_path,
    blocks: plan.files.length,
    status: 'planned',
  };
  if (dryRun) return report;

  const prepared = await deps.prepare(deck, plan.deck);
  const written = [
    ...plan.files.map(file => ({ path: `${deck.content_path}/${file.src}`, content: file.html })),
    { path: prepared.deckPath, content: prepared.deckJson },
    { path: prepared.htmlPath, content: prepared.html },
  ];
  let committed: Awaited<ReturnType<ConvertDeps['content']['uploadBatch']>>;
  try {
    committed = await deps.content.uploadBatch({
      gitOrganization: deck.classroom.git_organization as never,
      repo: deck.classroom.content_repo ?? '',
      branch: await deps.branchOf(deck),
      message: `Move html block code into files: ${deck.title}`,
      files: written.map(file => ({ ...file, encoding: 'utf-8' as const })),
      verifyBaseTree: async ({ getFileSha }) => {
        if ((await getFileSha(prepared.deckPath)) !== stored.sha) throw new DeckChangedError();
      },
    });
  } catch (error) {
    if (error instanceof DeckChangedError) {
      counts.conflicts++;
      return { ...report, status: 'conflict' };
    }
    throw error;
  }

  for (const file of plan.files) {
    const sha = committed.files.find(f => f.path === `${deck.content_path}/${file.src}`)?.sha;
    if (sha && sha !== file.rev) {
      deps.log('html-block-convert: a block file sha differs from the one stored', {
        slideId: deck.id,
        src: file.src,
      });
    }
  }
  await deps.record(deck, committed, written);
  await deps.audit(deck, {
    tool: 'task:html_block.convert',
    slide_id: deck.id,
    commit: committed.commit,
    blocks: plan.files.map(file => ({
      block_id: file.blockId,
      path: `${deck.content_path}/${file.src}`,
    })),
  });
  counts.converted++;
  return { ...report, status: 'converted', commit: committed.commit };
}

/** The run, with its effects injected (tests drive it with fakes). */
export async function runHtmlBlockConvert(
  payload: HtmlBlockConvertPayload,
  deps: ConvertDeps
): Promise<HtmlBlockConvertResult> {
  const counts: HtmlBlockConvertResult['counts'] = {
    scanned: 0,
    noDeckJson: 0,
    withLegacyBlocks: 0,
    blocks: 0,
    converted: 0,
    conflicts: 0,
    failed: 0,
  };
  const decks: DeckConversionReport[] = [];
  // Decks planned, converted, refused or failed: what `limit` caps.
  let handled = 0;
  const list = await deps.listDecks(
    payload.classroomId ? { classroomId: payload.classroomId } : {}
  );
  for (const deck of list) {
    if (payload.limit !== undefined && handled >= payload.limit) break;
    counts.scanned++;
    try {
      const report = await convertDeck(deps, deck, payload.dryRun, counts);
      if (report) decks.push(report);
      if (report && report.status !== 'no-deck-json') handled++;
    } catch (error) {
      handled++;
      counts.failed++;
      const message = error instanceof Error ? error.message : String(error);
      deps.log('html-block-convert: deck failed', { slideId: deck.id, error: message });
      decks.push({
        slideId: deck.id,
        classroomId: deck.classroom_id,
        path: deck.content_path,
        blocks: 0,
        status: 'failed',
        error: message,
      });
    }
  }
  return { mode: payload.dryRun ? 'dry-run' : 'execute', counts, decks };
}

// ─── Live deps ───────────────────────────────────────────────────────────────

const ROLE_RANK: Record<string, number> = { OWNER: 4, TEACHER: 3, ASSISTANT: 2, STUDENT: 1 };

/**
 * Who the audit row names: the deck's creator (their highest role in the
 * classroom) when they are still a member, else the classroom's owner. A
 * task has no user of its own, and the audit log needs one.
 */
async function auditActor(deck: ConvertDeck): Promise<{ userId: string; role: string } | null> {
  const prisma = getPrisma();
  const own = await prisma.classroomMembership.findMany({
    where: { classroom_id: deck.classroom_id, user_id: deck.created_by },
    select: { role: true },
  });
  const best = own.map(row => row.role).sort((a, b) => ROLE_RANK[b] - ROLE_RANK[a])[0];
  if (best) return { userId: deck.created_by, role: best };
  const owner = await prisma.classroomMembership.findFirst({
    where: { classroom_id: deck.classroom_id, role: 'OWNER' },
    select: { user_id: true },
  });
  return owner ? { userId: owner.user_id, role: 'OWNER' } : null;
}

export function liveConvertDeps(): ConvertDeps {
  return {
    listDecks: async ({ classroomId }) => {
      const rows = await getPrisma().slide.findMany({
        where: { kind: 'DECK', ...(classroomId ? { classroom_id: classroomId } : {}) },
        include: { classroom: { include: { git_organization: true } } },
        orderBy: { created_at: 'asc' },
      });
      return rows.filter(
        row =>
          isDeckSlide(row) && ClassmojiService.contentAssets.isDeliverableClassroom(row.classroom)
      ) as unknown as ConvertDeck[];
    },
    content: ContentService,
    branchOf: deck =>
      ClassmojiService.contentAssets.resolveContentBranch(
        deck.classroom.git_organization as never,
        deck.classroom.git_organization?.login ?? '',
        deck.classroom.content_repo ?? ''
      ),
    prepare: async (deck, json) => {
      const themeUrls = await resolveSharedThemeUrls(deck, json);
      const prepared = await prepareDeckForSave(deck, json, themeUrls ? { themeUrls } : {});
      return {
        deckPath: prepared.deckPath,
        htmlPath: prepared.htmlPath,
        deckJson: prepared.deckJson,
        html: prepared.html,
      };
    },
    record: async (deck, committed, written) => {
      await recordDeckCommit(deck, committed.files, written, { awaitTail: true });
      await ClassmojiService.contentAssets.recordFolderTreesAfterCommit({
        classroomId: deck.classroom_id,
        commit: committed.commit,
        rootTreeSha: committed.treeSha,
        folders: [deck.content_path, `${deck.content_path}/blocks`],
      });
    },
    audit: async (deck, data) => {
      const actor = await auditActor(deck);
      if (!actor) return;
      await ClassmojiService.audit.create(
        {
          classroom_id: deck.classroom_id,
          user_id: actor.userId,
          role: actor.role,
          resource_type: 'SLIDES',
          resource_id: deck.id,
          action: 'UPDATE',
          data: data as never,
        },
        { dedupe: false }
      );
    },
    log: (message, detail) => logger.info(message, detail ?? {}),
  };
}

export const htmlBlockConvert = schemaTask({
  id: HTML_BLOCK_CONVERT_TASK_ID,
  schema: parseConvertPayload,
  maxDuration: 60 * 60,
  // One run at a time: two runs would both plan the same decks.
  queue: { concurrencyLimit: 1 },
  retry: { maxAttempts: 1 },
  run: async (payload: HtmlBlockConvertPayload) => {
    const result = await runHtmlBlockConvert(payload, liveConvertDeps());
    logger.info(`html-block-convert ${result.mode}`, { counts: result.counts });
    return result;
  },
});
