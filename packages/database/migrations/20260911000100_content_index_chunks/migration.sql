-- Chunked documents: the index gains a chunk ordinal in its identity.
--
-- This is a second migration rather than an edit to 20260911000000 because that
-- one was already applied locally; a modified applied migration fails Prisma's
-- checksum on the next deploy, and the alternative — a `migrate reset` — would
-- wipe the shared local development database.
--
-- WHY. The Workers AI embedding client enforces a maximum input size and
-- REFUSES over-cap text rather than truncating it, which is the right default:
-- a silently truncated document is an index that lies about what it contains.
-- Measured against a real classroom's content repo, pages fit comfortably but
-- roughly half of the larger slide decks do not. So the policy is one vector
-- per document when it fits — the common case — and paragraph-boundary chunks,
-- one row and one vector each, when it does not.
--
-- `chunk_ix` DEFAULT 0 and `chunk_count` DEFAULT 1 mean a whole-document row is
-- written exactly as it was before this migration: the defaults describe the
-- unchunked case, so no writer has to think about chunking to be correct. The
-- table is empty at this point, so the defaults are a statement of intent
-- rather than a backfill.
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
-- The primary key is dropped and recreated to admit the new column. Nothing
-- else about the table changes: same B-tree on (classroom_id, doc_kind), same
-- classroom cascade, still no approximate vector index (see 20260911000000 for
-- why, and what would justify one).

-- AlterTable
ALTER TABLE "content_index" DROP CONSTRAINT "content_index_pkey",
ADD COLUMN     "chunk_ix" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "chunk_count" INTEGER NOT NULL DEFAULT 1,
ADD CONSTRAINT "content_index_pkey" PRIMARY KEY ("classroom_id", "doc_kind", "doc_id", "chunk_ix");
