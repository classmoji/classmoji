/**
 * Quiz source material: the pages and slide decks a quiz is about.
 *
 * A quiz links documents through the shared link tables (`page_links`,
 * `slide_links`, target column `quiz_id`), one ordered list across both tables
 * (`order`). This module is everything the quiz needs from that list:
 *
 *   - `setQuizSourceMaterial` — the write the quiz form makes, inside the quiz's
 *     own transaction (quiz.service create/update).
 *   - `loadQuizSourceMaterial` (`load`) — the full text of each linked document
 *     AS THE ATTEMPT'S USER MAY SEE IT, budgeted for a prompt. The ai-agent calls
 *     it at attempt start and again on session recovery.
 *   - `countStartableSourceMaterial` (`countStartable`) — the cheap pre-check the
 *     webapp runs before creating an attempt: how many linked documents would
 *     reach the prompt for this user, without reading any text.
 *   - `applyMaterialBudget` — the pure budget/truncation step `load` ends with.
 *   - `listSourceMaterialOptions` — what the quiz form's picker offers.
 *
 * ── Visibility is the viewer's, never a fixed role ─────────────────────────
 * The user's real membership role in the classroom (highest role wins, as every
 * gate resolves it) goes through `contentVisibility(role)`, the one rule the
 * content_* reads use. A student never gets a draft; staff previewing a quiz do.
 *
 * The check runs on the LIVE page/deck rows FIRST, and only a visible record
 * goes on to `getContentText`. That order is required: `getContentText` throws
 * the same `ContentNotFoundError` for "missing", "not visible" and "not indexed"
 * (so it cannot be used as a probe), and this module has to tell them apart for
 * the staff diagnostics in `omitted`.
 *
 * ── `omitted` is staff diagnostics ────────────────────────────────────────
 * Titles and reasons of documents that did not reach the prompt. For logs and
 * staff views only: a student's prompt must never learn that a draft exists.
 */
import getPrisma from '@classmoji/database';
import { Prisma } from '@prisma/client';
import type { Role } from '@prisma/client';

import {
  ContentNotFoundError,
  contentVisibility,
  getContentText,
} from './contentSearch.service.ts';
import { ResourceLinkServiceError } from './resourceLink.service.ts';

// ─── Types ─────────────────────────────────────────────────────────────────

/** The two kinds of document a quiz can link. */
export type SourceDocKind = 'page' | 'slide';

/** One entry of a quiz's material list, as the quiz form and service write it. */
export interface SourceMaterialRef {
  kind: SourceDocKind;
  id: string;
}

/** A document that goes into the prompt, in material order. */
export interface SourceDoc {
  kind: SourceDocKind;
  id: string;
  title: string;
  /** The indexed text, with a truncation marker line appended when it was cut. */
  text: string;
  truncated: boolean;
  /** `content_index.source_sha` at read time; logged so drift is visible. */
  sourceSha: string | null;
}

/** Why a linked document did not reach the prompt. */
export type OmittedReason = 'not_visible' | 'not_indexed' | 'budget' | 'empty';

/** STAFF DIAGNOSTICS ONLY — never placed in a student's prompt. */
export interface OmittedDoc {
  kind: SourceDocKind;
  id: string;
  title: string;
  reason: OmittedReason;
}

export interface QuizSourceMaterial {
  /** How many documents are linked to the quiz. */
  configured: number;
  /** What goes into the prompt, in material order. */
  docs: SourceDoc[];
  /** What did not, and why. Staff diagnostics only. */
  omitted: OmittedDoc[];
  /** Whether any document was cut or left out for budget. */
  truncated: boolean;
  /** Sum of `docs[].text.length`, markers included. */
  totalChars: number;
}

export interface QuizSourceMaterialArgs {
  quizId: string;
  classroomId: string;
  /** The attempt's user: whose visibility the material is read under. */
  userId: string;
}

export interface StartableSourceMaterial {
  configured: number;
  /** Linked documents this user can see AND that have indexed text. */
  startable: number;
}

// ─── Budget ────────────────────────────────────────────────────────────────

/** Most documents placed in one prompt. */
export const MAX_DOCS = 12;
/** Most characters of one document's text. */
export const MAX_CHARS_PER_DOC = 60_000;
/** Most characters of document text across the whole material. */
export const MAX_CHARS_TOTAL = 160_000;

export interface MaterialBudget {
  maxDocs: number;
  maxCharsPerDoc: number;
  maxCharsTotal: number;
}

export const DEFAULT_MATERIAL_BUDGET: MaterialBudget = {
  maxDocs: MAX_DOCS,
  maxCharsPerDoc: MAX_CHARS_PER_DOC,
  maxCharsTotal: MAX_CHARS_TOTAL,
};

export interface BudgetedMaterial {
  docs: SourceDoc[];
  /** Only `budget` omissions; the caller merges them with its own. */
  omitted: OmittedDoc[];
  truncated: boolean;
  totalChars: number;
}

/** The fraction of the limit a paragraph cut may search back into. */
const PARAGRAPH_CUT_WINDOW = 0.2;

const formatCount = (n: number): string => n.toLocaleString('en-US');

/** The one line appended to a cut document, e.g. `[… 12,400 of 71,900 characters omitted]`. */
export const truncationMarker = (cut: number, total: number): string =>
  `[… ${formatCount(cut)} of ${formatCount(total)} characters omitted]`;

/**
 * Cut `text` to at most `limit` characters of content.
 *
 * At the last blank line inside the final 20% before the limit, so the cut
 * lands between paragraphs; otherwise exactly at the limit. Returns how many
 * characters were cut (0 when the text already fits).
 */
export function cutText(text: string, limit: number): { kept: string; cut: number } {
  if (text.length <= limit) return { kept: text, cut: 0 };

  const windowStart = Math.floor(limit * (1 - PARAGRAPH_CUT_WINDOW));
  const head = text.slice(0, limit);
  let cutAt = -1;
  // A blank line: a newline, optional spaces or tabs, a newline.
  const blankLine = /\n[ \t]*\n/g;
  for (let match = blankLine.exec(head); match; match = blankLine.exec(head)) {
    if (match.index >= windowStart) cutAt = match.index;
  }
  if (cutAt < 0) cutAt = limit;

  return { kept: text.slice(0, cutAt), cut: text.length - cutAt };
}

/**
 * Fit the material to the prompt budget. Pure: no database, no clock.
 *
 * Documents are taken in order. Each is cut to `maxCharsPerDoc`, then to what
 * is left of `maxCharsTotal`; a cut document ends with one marker line naming
 * how many characters were cut. Once `maxDocs` documents are in, or the total
 * is spent, every remaining document is omitted with reason `budget`. The
 * limits count document text only; marker lines ride on top.
 */
export function applyMaterialBudget(
  docs: readonly SourceDoc[],
  limits: MaterialBudget = DEFAULT_MATERIAL_BUDGET
): BudgetedMaterial {
  const kept: SourceDoc[] = [];
  const omitted: OmittedDoc[] = [];
  let contentChars = 0;
  let truncated = false;

  for (const doc of docs) {
    const room = limits.maxCharsTotal - contentChars;
    if (kept.length >= limits.maxDocs || room <= 0) {
      omitted.push({ kind: doc.kind, id: doc.id, title: doc.title, reason: 'budget' });
      truncated = true;
      continue;
    }

    const { kept: text, cut } = cutText(doc.text, Math.min(limits.maxCharsPerDoc, room));
    contentChars += text.length;
    if (cut > 0) {
      truncated = true;
      kept.push({
        ...doc,
        text: `${text}\n\n${truncationMarker(cut, doc.text.length)}`,
        truncated: true,
      });
    } else {
      kept.push({ ...doc, text, truncated: doc.truncated });
    }
  }

  return {
    docs: kept,
    omitted,
    truncated,
    totalChars: kept.reduce((sum, doc) => sum + doc.text.length, 0),
  };
}

// ─── Shared reads ──────────────────────────────────────────────────────────

/**
 * Ids arrive from other services and a WebSocket payload. Prisma DROPS an
 * `undefined` from a `where`, which would widen a quiz-scoped read to the whole
 * classroom, so anything that is not a non-empty string is refused up front.
 */
function assertId(value: unknown, what: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`[quizSourceMaterial] ${what} is required`);
  }
}

/** Privilege order for multi-role resolution (highest first), as the auth gates use it. */
const ROLE_PRIORITY: readonly Role[] = ['OWNER', 'TEACHER', 'ASSISTANT', 'STUDENT'];

/**
 * The user's role in this classroom, or null for a non-member. One person can
 * hold several membership rows in one classroom; the highest role wins.
 */
async function viewerRole(classroomId: string, userId: string): Promise<Role | null> {
  const rows = await getPrisma().classroomMembership.findMany({
    where: { classroom_id: classroomId, user_id: userId },
    select: { role: true },
  });
  return ROLE_PRIORITY.find(role => rows.some(row => row.role === role)) ?? null;
}

/** A linked document's live record, in material order. */
interface LinkedDocument {
  kind: SourceDocKind;
  id: string;
  title: string;
  is_draft: boolean;
  is_public: boolean;
}

/**
 * The quiz's linked documents, live rows, in material order (`order`, then
 * link creation, then kind and id so ties are stable). Both the quiz and the
 * document are held to `classroomId`.
 */
async function linkedDocuments(quizId: string, classroomId: string): Promise<LinkedDocument[]> {
  const docSelect = { id: true, title: true, is_draft: true, is_public: true } as const;
  const quizScope = { quiz_id: quizId, quiz: { classroom_id: classroomId } };

  const [pageLinks, slideLinks] = await Promise.all([
    getPrisma().pageLink.findMany({
      where: { ...quizScope, page: { classroom_id: classroomId } },
      select: { order: true, created_at: true, page: { select: docSelect } },
    }),
    getPrisma().slideLink.findMany({
      where: { ...quizScope, slide: { classroom_id: classroomId } },
      select: { order: true, created_at: true, slide: { select: docSelect } },
    }),
  ]);

  const rows = [
    ...pageLinks.map(link => ({ ...link, kind: 'page' as const, doc: link.page })),
    ...slideLinks.map(link => ({ ...link, kind: 'slide' as const, doc: link.slide })),
  ];
  rows.sort(
    (a, b) =>
      a.order - b.order ||
      a.created_at.getTime() - b.created_at.getTime() ||
      a.kind.localeCompare(b.kind) ||
      a.doc.id.localeCompare(b.doc.id)
  );

  return rows.map(row => ({
    kind: row.kind,
    id: row.doc.id,
    title: row.doc.title,
    is_draft: row.doc.is_draft,
    is_public: row.doc.is_public,
  }));
}

/** Non-whitespace anywhere. The same test the SQL below applies per chunk. */
const hasText = (text: string): boolean => /\S/.test(text);

// ─── load ──────────────────────────────────────────────────────────────────

/**
 * The quiz's source material as `userId` may read it, budgeted for a prompt.
 *
 * Each linked document is, in order: `not_visible` when the user may not see
 * the live record; `not_indexed` when it has no indexed text (the index is
 * warmed on every save and reconciled nightly, so this is rare); `empty` when
 * the indexed text is blank; otherwise a candidate for the budget, which may
 * cut it or leave it out (`budget`).
 */
export async function loadQuizSourceMaterial({
  quizId,
  classroomId,
  userId,
}: QuizSourceMaterialArgs): Promise<QuizSourceMaterial> {
  assertId(quizId, 'quizId');
  assertId(classroomId, 'classroomId');
  assertId(userId, 'userId');

  const [role, linked] = await Promise.all([
    viewerRole(classroomId, userId),
    linkedDocuments(quizId, classroomId),
  ]);
  const visibility = contentVisibility(role);

  type Outcome = { doc: SourceDoc } | { omitted: OmittedDoc };
  const outcomes: Outcome[] = await Promise.all(
    linked.map(async (record): Promise<Outcome> => {
      const base = { kind: record.kind, id: record.id, title: record.title };
      if (!visibility.allows(record)) return { omitted: { ...base, reason: 'not_visible' } };

      try {
        const document = await getContentText({
          classroomId,
          role,
          docKind: record.kind,
          docId: record.id,
        });
        if (!hasText(document.text)) return { omitted: { ...base, reason: 'empty' } };
        return {
          doc: {
            ...base,
            text: document.text,
            truncated: false,
            sourceSha: document.sourceSha ?? null,
          },
        };
      } catch (error) {
        if (error instanceof ContentNotFoundError) {
          return { omitted: { ...base, reason: 'not_indexed' } };
        }
        throw error;
      }
    })
  );

  const candidates = outcomes.flatMap(outcome => ('doc' in outcome ? [outcome.doc] : []));
  const budgeted = applyMaterialBudget(candidates);

  // Omissions in material order, whichever step decided them.
  const budgetOmitted = new Set(budgeted.omitted.map(doc => `${doc.kind}:${doc.id}`));
  const omitted = outcomes.flatMap(outcome => {
    if ('omitted' in outcome) return [outcome.omitted];
    const key = `${outcome.doc.kind}:${outcome.doc.id}`;
    return budgetOmitted.has(key)
      ? [
          {
            kind: outcome.doc.kind,
            id: outcome.doc.id,
            title: outcome.doc.title,
            reason: 'budget' as const,
          },
        ]
      : [];
  });

  return {
    configured: linked.length,
    docs: budgeted.docs,
    omitted,
    truncated: budgeted.truncated,
    totalChars: budgeted.totalChars,
  };
}

// ─── countStartable ────────────────────────────────────────────────────────

/**
 * How many of the quiz's linked documents would reach `userId`'s prompt,
 * without reading their text: the same live-record visibility step as `load`,
 * then one query for which of the visible documents have non-blank indexed
 * text. `startable > 0` exactly when `load` would return at least one doc (the
 * first usable document always fits the budget).
 */
export async function countStartableSourceMaterial({
  quizId,
  classroomId,
  userId,
}: QuizSourceMaterialArgs): Promise<StartableSourceMaterial> {
  assertId(quizId, 'quizId');
  assertId(classroomId, 'classroomId');
  assertId(userId, 'userId');

  const [role, linked] = await Promise.all([
    viewerRole(classroomId, userId),
    linkedDocuments(quizId, classroomId),
  ]);
  const visibility = contentVisibility(role);
  const visible = linked.filter(record => visibility.allows(record));
  if (visible.length === 0) return { configured: linked.length, startable: 0 };

  const idsOf = (kind: SourceDocKind) =>
    visible.filter(record => record.kind === kind).map(record => record.id);
  const branches: Prisma.Sql[] = [];
  for (const kind of ['page', 'slide'] as const) {
    const ids = idsOf(kind);
    if (ids.length > 0) {
      branches.push(Prisma.sql`(ci.doc_kind = ${kind} AND ci.doc_id IN (${Prisma.join(ids)}))`);
    }
  }

  const rows = await getPrisma().$queryRaw<Array<{ docKind: string; docId: string }>>`
    SELECT ci.doc_kind AS "docKind", ci.doc_id AS "docId"
    FROM content_index ci
    WHERE ci.classroom_id = ${classroomId}
      AND (${Prisma.join(branches, ' OR ')})
    GROUP BY ci.doc_kind, ci.doc_id
    HAVING bool_or(ci.text ~ '[^[:space:]]')`;

  return { configured: linked.length, startable: rows.length };
}

// ─── write ─────────────────────────────────────────────────────────────────

const refusal = (message: string) =>
  new ResourceLinkServiceError('resource_not_found', `[quizSourceMaterial] ${message}`);

/**
 * Validate a caller's material list: an array of `{ kind: 'page' | 'slide',
 * id: string }`. Anything else is refused as the same not-found an unknown id
 * gets. Duplicates collapse, first position wins.
 */
export function normalizeSourceMaterial(input: unknown): SourceMaterialRef[] {
  if (!Array.isArray(input)) throw refusal('sourceMaterial must be a list');

  const seen = new Set<string>();
  const refs: SourceMaterialRef[] = [];
  for (const entry of input) {
    const { kind, id } = (entry ?? {}) as { kind?: unknown; id?: unknown };
    if ((kind !== 'page' && kind !== 'slide') || typeof id !== 'string' || id.length === 0) {
      throw refusal('each sourceMaterial entry needs a kind (page or slide) and an id');
    }
    const key = `${kind}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push({ kind, id });
  }
  return refs;
}

/**
 * Replace a quiz's material with `material`, in order, on the caller's
 * transaction client.
 *
 * Every id is proven to be in `classroomId` up front (one query per kind), so an
 * unknown or foreign id throws BEFORE anything is deleted and the caller's
 * transaction rolls back the quiz write with it. The quiz itself must already
 * be proven to be in `classroomId` by the caller. The content manifest is not
 * rebuilt: it has no quiz section.
 */
export async function setQuizSourceMaterial(
  tx: Prisma.TransactionClient,
  { quizId, classroomId, material }: { quizId: string; classroomId: string; material: unknown }
): Promise<SourceMaterialRef[]> {
  assertId(quizId, 'quizId');
  assertId(classroomId, 'classroomId');
  const refs = normalizeSourceMaterial(material);

  const pageIds = refs.filter(ref => ref.kind === 'page').map(ref => ref.id);
  const slideIds = refs.filter(ref => ref.kind === 'slide').map(ref => ref.id);

  // Sequential on purpose: one interactive transaction, one connection.
  const pages = pageIds.length
    ? await tx.page.findMany({
        where: { id: { in: pageIds }, classroom_id: classroomId },
        select: { id: true },
      })
    : [];
  const slides = slideIds.length
    ? await tx.slide.findMany({
        where: { id: { in: slideIds }, classroom_id: classroomId },
        select: { id: true },
      })
    : [];
  if (pages.length !== pageIds.length || slides.length !== slideIds.length) {
    throw refusal(`a source material document is not in classroom ${classroomId}`);
  }

  await tx.pageLink.deleteMany({ where: { quiz_id: quizId } });
  await tx.slideLink.deleteMany({ where: { quiz_id: quizId } });

  const rows = refs.map((ref, order) => ({ ...ref, order }));
  const pageRows = rows.filter(row => row.kind === 'page');
  const slideRows = rows.filter(row => row.kind === 'slide');
  if (pageRows.length > 0) {
    await tx.pageLink.createMany({
      data: pageRows.map(row => ({ page_id: row.id, quiz_id: quizId, order: row.order })),
    });
  }
  if (slideRows.length > 0) {
    await tx.slideLink.createMany({
      data: slideRows.map(row => ({ slide_id: row.id, quiz_id: quizId, order: row.order })),
    });
  }

  return refs;
}

// ─── Read shapes for quiz rows ─────────────────────────────────────────────

/** One entry of `source_material` on a quiz row (staff lists, MCP, the form). */
export interface QuizSourceMaterialEntry {
  kind: SourceDocKind;
  id: string;
  title: string;
  is_draft: boolean;
  order: number;
}

/**
 * The include that loads a quiz's material links with their documents. Pair it
 * with `sourceMaterialOf`, which folds the two relations into one list.
 */
export const SOURCE_MATERIAL_INCLUDE = {
  page_links: {
    select: {
      order: true,
      created_at: true,
      page: { select: { id: true, title: true, is_draft: true, classroom_id: true } },
    },
  },
  slide_links: {
    select: {
      order: true,
      created_at: true,
      slide: { select: { id: true, title: true, is_draft: true, classroom_id: true } },
    },
  },
} as const;

interface MaterialLinkRow {
  order: number;
  created_at: Date;
}
type MaterialDoc = { id: string; title: string; is_draft: boolean; classroom_id: string };

/**
 * Fold a quiz row's `page_links` / `slide_links` into one ordered
 * `source_material` list. A document outside the quiz's classroom is dropped
 * (no writer produces one; the read does not trust that). `publishedOnly`
 * drops drafts: the student view of a quiz names published documents only.
 */
export function sourceMaterialOf(
  quiz: {
    classroom_id: string;
    page_links?: ReadonlyArray<MaterialLinkRow & { page: MaterialDoc }>;
    slide_links?: ReadonlyArray<MaterialLinkRow & { slide: MaterialDoc }>;
  },
  { publishedOnly = false }: { publishedOnly?: boolean } = {}
): QuizSourceMaterialEntry[] {
  const rows = [
    ...(quiz.page_links ?? []).map(link => ({ link, kind: 'page' as const, doc: link.page })),
    ...(quiz.slide_links ?? []).map(link => ({ link, kind: 'slide' as const, doc: link.slide })),
  ]
    .filter(row => row.doc.classroom_id === quiz.classroom_id)
    .filter(row => !publishedOnly || !row.doc.is_draft);

  rows.sort(
    (a, b) =>
      a.link.order - b.link.order ||
      a.link.created_at.getTime() - b.link.created_at.getTime() ||
      a.kind.localeCompare(b.kind) ||
      a.doc.id.localeCompare(b.doc.id)
  );

  return rows.map(row => ({
    kind: row.kind,
    id: row.doc.id,
    title: row.doc.title,
    is_draft: row.doc.is_draft,
    order: row.link.order,
  }));
}

// ─── Picker ────────────────────────────────────────────────────────────────

export interface SourceMaterialOption {
  id: string;
  title: string;
  is_draft: boolean;
}

/**
 * What the quiz form's source-material picker offers: every page, and every
 * reveal.js DECK (a FILE or LINK slide has no indexed text, so it could never
 * reach a prompt). Drafts included; the form marks them.
 */
export async function listSourceMaterialOptions(
  classroomId: string
): Promise<{ pages: SourceMaterialOption[]; decks: SourceMaterialOption[] }> {
  assertId(classroomId, 'classroomId');
  const select = { id: true, title: true, is_draft: true } as const;
  const [pages, decks] = await Promise.all([
    getPrisma().page.findMany({
      where: { classroom_id: classroomId },
      select,
      orderBy: { title: 'asc' },
    }),
    getPrisma().slide.findMany({
      where: { classroom_id: classroomId, kind: 'DECK' },
      select,
      orderBy: { title: 'asc' },
    }),
  ]);
  return { pages, decks };
}

// Short names for the `ClassmojiService.quizSourceMaterial` namespace, which is
// how the ai-agent and the webapp call these.
export const load = loadQuizSourceMaterial;
export const countStartable = countStartableSourceMaterial;
