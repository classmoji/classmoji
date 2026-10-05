-- Live collaborative editing, per classroom. Off by default: a classroom
-- without it keeps today's editors and save paths untouched.
ALTER TABLE "classrooms" ADD COLUMN "collab_enabled" BOOLEAN NOT NULL DEFAULT false;

-- The live document of a page ('page', doc_id = Page.id) or deck ('deck',
-- doc_id = Slide.id) being edited collaboratively: the buffer between the
-- collab service and git. `state` is the full Yjs state (first bytea column in
-- the schema). `version` is bumped on each store, `pushed_version` records the
-- version the content-checkpoint worker last pushed; equal means clean.
-- `epoch` is part of the room name and is bumped when the doc is reseeded from
-- git, so a stale browser reloads instead of syncing old content back in.
-- No foreign keys: doc_id names a Page or a Slide depending on kind, and the
-- row must outlive a racing delete long enough for a final checkpoint.
CREATE TABLE "collab_docs" (
    "kind" TEXT NOT NULL,
    "doc_id" TEXT NOT NULL,
    "classroom_id" TEXT NOT NULL,
    "epoch" INTEGER NOT NULL DEFAULT 1,
    "state" BYTEA NOT NULL,
    "schema_version" INTEGER NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "pushed_version" INTEGER NOT NULL DEFAULT 0,
    "source_sha" TEXT,
    "pushed_commit" TEXT,
    "dirty_since" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "collab_docs_pkey" PRIMARY KEY ("kind","doc_id")
);

-- The worker gathers a classroom's dirty docs: one content repo, one commit.
CREATE INDEX "collab_docs_classroom_id_idx" ON "collab_docs"("classroom_id");
