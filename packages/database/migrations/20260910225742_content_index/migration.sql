-- Semantic index over course content: one row and one vector per chunk.
--
-- CREATE EXTENSION is the first statement on purpose. Neon carries pgvector on
-- every plan, but a local docker postgres does not unless the image provides it
-- (the compose image is `pgvector/pgvector:pg16-*`), and Prisma's shadow
-- database replays this file too — the column type `vector(1024)` does not
-- parse until the extension exists. IF NOT EXISTS keeps it a no-op everywhere
-- it is already present.
--
-- The table is a CACHE over the content repo, never the content of record.
-- Bodies are still read through the delivery layer; a row here only decides
-- what is findable, and losing the whole table costs a re-index, not content.
--
-- PRIMARY KEY (classroom_id, doc_kind, doc_id, chunk_ix) rather than the path,
-- because `pages.content_path` carries no unique constraint and is mutable —
-- keying on the record id is what makes the permission join in the search query
-- an equality on a primary key instead of a fuzzy path match.
--
-- `doc_kind` is 'page' | 'slide' | 'file'. For 'page' and 'slide', `doc_id` is
-- the `pages.id` / `slides.id` the row describes. For 'file', `doc_id` IS the
-- repo-relative path: `bot-context/` files are searchable by decision and have
-- no Page or Slide row to point at, so the path is their identity. That is also
-- why there is no foreign key on `doc_id` — it is polymorphic, and for 'file'
-- it references nothing at all.
--
-- The consequence of that missing FK, stated so nobody looks for a cascade that
-- is not here: DELETING A PAGE OR A DECK LEAVES ITS INDEX ROW BEHIND. Cleaning
-- those up is the nightly reconcile's job. The search query is written to be
-- safe in the meantime — it joins to the live `pages`/`slides` row and requires
-- it to exist, so an orphan is unreachable before it is ever removed. Only the
-- classroom FK cascades, because a deleted classroom leaves nothing here worth
-- keeping.
--
-- Freshness is the triple (source_sha, extract_version, embed_model), not the
-- sha alone. A sha match only proves the bytes are unchanged; it says nothing
-- about a renamed title, a changed extractor, a different embedding model, or
-- the same blob appearing at a new path — each of which needs a re-index and
-- none of which moves the sha. `extract_version` and `embed_model` are NOT NULL
-- with no default so a writer is forced to state what produced the row, and so
-- an extractor or model upgrade rolls out by comparison rather than by a manual
-- purge.
--
-- `embedding` is nullable twice over: Prisma requires `Unsupported()` fields to
-- be optional, and a row can legitimately be written before its embedding call
-- succeeds. The search query filters `embedding IS NOT NULL` so a half-written
-- row cannot sort first by accident.
--
-- 1,024 dimensions is `@cf/qwen/qwen3-embedding-0.6b`, verified live, and is
-- comfortably under pgvector's 2,000-dimension ceiling for the `vector` type.
--
-- ── WHY THE ROW IS A CHUNK AND NOT ALWAYS A DOCUMENT ────────────────────────
-- The Workers AI embedding client enforces a maximum input size and REFUSES
-- over-cap text rather than truncating it, which is the right default: a
-- silently truncated document is an index that lies about what it contains.
-- Measured against a real classroom's content repo, pages fit comfortably but
-- roughly half of the larger slide decks do not. So the policy is one vector
-- per document when it fits — the common case — and paragraph-boundary chunks,
-- one row and one vector each, when it does not.
--
-- `chunk_ix` DEFAULT 0 and `chunk_count` DEFAULT 1 describe the unchunked case,
-- so no writer has to think about chunking to be correct.
--
-- `chunk_count` is stamped on EVERY row of a document, not stored once. It is
-- what lets the reconcile recognise a partially indexed document — rows exist,
-- but fewer than `chunk_count` of them — from the rows themselves, without a
-- second query or a separate per-document table. `title`, `source_path`,
-- `source_sha`, `extract_version` and `embed_model` are likewise repeated per
-- chunk: freshness is compared per row, and a row that could not say what
-- produced it would need a join before it could be re-indexed.
--
-- CONSEQUENCE FOR THE SEARCH QUERY, stated here because the table cannot
-- enforce it: a multi-chunk document can match on several of its chunks at
-- once. The query must collapse those to one hit per document — DISTINCT ON
-- (doc_kind, doc_id) ordered by distance, or an equivalent windowed rank — so a
-- document appears once, represented by its best-matching chunk. De-duplication
-- must happen BEFORE the LIMIT; applied after, one long deck could fill the
-- entire result set with itself.
--
-- `chunk_ix` and `chunk_count` are declared LAST rather than beside `doc_id`,
-- which is where the Prisma model lists them. This file squashes a CREATE and a
-- follow-up ALTER that added them, and the ordinals the ALTER produced are the
-- ones every database that ran the pair already has. Matching them here keeps a
-- fresh database physically identical to an upgraded one. Column order is
-- presentation only — Prisma diffs by name — so nothing else depends on it.

CREATE EXTENSION IF NOT EXISTS vector;

-- CreateTable
CREATE TABLE "content_index" (
    "classroom_id" TEXT NOT NULL,
    "doc_kind" TEXT NOT NULL,
    "doc_id" TEXT NOT NULL,
    "source_path" TEXT NOT NULL,
    "source_sha" TEXT NOT NULL,
    "extract_version" INTEGER NOT NULL,
    "embed_model" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "embedding" vector(1024),
    "indexed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "chunk_ix" INTEGER NOT NULL DEFAULT 0,
    "chunk_count" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "content_index_pkey" PRIMARY KEY ("classroom_id","doc_kind","doc_id","chunk_ix")
);

-- THERE IS DELIBERATELY NO HNSW (OR IVFFLAT) INDEX HERE.
--
-- pgvector's approximate indexes scan for candidates FIRST and apply the SQL
-- filter to what they found. With one shared index across every classroom, a
-- search scoped to one classroom's documents — and, for a student, to its
-- published ones — can exhaust `ef_search` (default 40) candidates on rows the
-- viewer is not allowed to see and return short. That failure is silent: fewer
-- or worse results, no error, and nothing in the plan that says recall was
-- lost. A security-filtered search is exactly the shape where approximate
-- search degrades worst.
--
-- Exact search is the right answer at this size. A classroom's corpus is on the
-- order of 72 documents; after `classroom_id` (+ `doc_kind`) narrows the scan
-- via the B-tree below, `ORDER BY embedding <=> $1` over that handful is a
-- trivial sequential pass and is exactly correct by construction.
--
-- What would justify revisiting, all three together and not one of them alone:
--   1. Per-classroom corpora large enough that the exact scan actually shows up
--      in query time (thousands of documents, not tens).
--   2. A verified pgvector >= 0.8.0 on BOTH Neon and the local image, so
--      `hnsw.iterative_scan = 'relaxed_order'` is available — that is the
--      setting that lets the index keep fetching candidates until the filter is
--      satisfied instead of giving up at ef_search.
--   3. Partitioning or a partial-index scheme that keeps one classroom's
--      vectors out of another's candidate pool.
-- Adding the index without (2) trades correctness for speed that is not needed.

-- CreateIndex
-- The search query's only filter ahead of the exact vector scan; it is what
-- keeps that scan over a classroom's own documents instead of the whole table.
CREATE INDEX "content_index_classroom_id_doc_kind_idx" ON "content_index"("classroom_id", "doc_kind");

-- CreateIndex
-- The nightly reconcile's join back to `content_assets` to compare shas.
CREATE INDEX "content_index_classroom_id_source_path_idx" ON "content_index"("classroom_id", "source_path");

-- AddForeignKey
ALTER TABLE "content_index" ADD CONSTRAINT "content_index_classroom_id_fkey" FOREIGN KEY ("classroom_id") REFERENCES "classrooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
