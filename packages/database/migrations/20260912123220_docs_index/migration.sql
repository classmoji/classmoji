-- Semantic index over the PRODUCT DOCUMENTATION: one row and one vector per
-- chunk of a `classmoji.io/docs` page.
--
-- CREATE EXTENSION is the first statement for the same reason it is in
-- `20260910225742_content_index`: the column type `vector(1024)` does not parse
-- until pgvector exists, and Prisma's shadow database replays this file from
-- empty. IF NOT EXISTS makes it a no-op wherever it already ran — including on
-- a database that already carries `content_index`.
--
-- ── WHY A SECOND TABLE RATHER THAN A FOURTH doc_kind ────────────────────────
-- `content_index` is per classroom: every row carries `classroom_id`, every
-- statement filters on it, the FK cascades when a classroom is deleted, and the
-- read path joins `pages`/`slides` to apply a draft/publish visibility rule.
-- Documentation has none of that. It is one fleet-wide public website, so a row
-- here belongs to nobody, is visible to everybody, and outlives every classroom.
-- Putting it in `content_index` would mean a row that has to OPT OUT of the
-- tenancy filter those statements are built around — the one thing that file's
-- header says must never happen. Separate table, separate statements, no
-- classroom column to forget.
--
-- ── slug IS the identity AND the URL ────────────────────────────────────────
-- `docs/instructors/roster` is both the primary key and the path under
-- https://classmoji.io/. It is derived from the repo path under
-- `apps/site/src/content/docs` minus `.mdx` and minus a trailing `/index`, so
-- the id a search hit returns is also the link the chat widget renders. No
-- second mapping table, and no way for the two to disagree.
--
-- ── NO INDEX AT ALL, AND THE REASON IS NOT content_index's REASON ───────────
-- There is no HNSW/IVFFlat index and no secondary B-tree. The justification is
-- CORPUS SIZE ALONE: the documentation is 25 pages, so an exact
-- `ORDER BY embedding <=> $1` is a sequential pass over a couple of dozen rows
-- and is already the cheapest correct plan.
--
-- This is DELIBERATELY NOT the argument `content_index` makes. That table skips
-- an approximate index because an approximate scan returns candidates BEFORE
-- the per-classroom permission filter runs, so a filtered-away candidate is a
-- lost result. That reasoning is specific to filtering, and there is no filter
-- here — so it must not be copied across as though it were. If this corpus ever
-- grows by an order of magnitude, add an index on the size argument, and do not
-- inherit a justification that never applied.
--
-- ── Freshness, and why chunking survives a 25-page corpus ───────────────────
-- The freshness triple is the same as `content_index`'s —
-- (source_sha, extract_version, embed_model) — and the same `isFresh` function
-- reads it. `source_sha` is the git blob sha of the `.mdx`.
--
-- Every page fits in one chunk today: the largest is 7,976 characters against a
-- 24,576-character budget. `chunk_ix`/`chunk_count` are kept anyway because
-- (a) that budget is env-overridable DOWNWARD
-- (CLOUDFLARE_WORKERS_AI_EMBED_MAX_TOKENS), (b) `chunk_count` is what lets
-- `isFresh` tell a complete document from a write that died halfway, and
-- (c) the composite primary key is what makes the upsert idempotent. A
-- one-row-per-page variant would be MORE code, not less.
--
-- `embedding` is nullable twice over: Prisma requires `Unsupported()` fields to
-- be optional, and a row may legitimately exist before its embedding call
-- succeeded. Every read filters `embedding IS NOT NULL` so a half-written row
-- cannot sort first by accident.
--
-- The table is a CACHE over a public git repo. Losing it costs a re-index, not
-- content; the reconcile rebuilds it from `main`.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE "docs_index" (
    "slug" TEXT NOT NULL,
    "chunk_ix" INTEGER NOT NULL DEFAULT 0,
    "chunk_count" INTEGER NOT NULL DEFAULT 1,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "section" TEXT,
    "text" TEXT NOT NULL,
    "source_sha" TEXT NOT NULL,
    "extract_version" INTEGER NOT NULL,
    "embed_model" TEXT NOT NULL,
    "embedding" vector(1024),
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "docs_index_pkey" PRIMARY KEY ("slug","chunk_ix")
);
