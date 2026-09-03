-- Content delivery layer: the two pieces of state the signed-URL edge cache needs.
--
-- `classrooms.content_key_version` is the cache bust. Every signed content URL
-- carries it, so incrementing it changes ALL of a classroom's URLs at once and
-- the edge misses on every asset until it refills. It is NOT a revocation: URLs
-- minted under an older version still verify, they simply stop being the ones
-- the app hands out. DEFAULT 0 so every existing classroom starts at a defined
-- version rather than NULL — the value is concatenated into a signing input,
-- and a NULL there would sign as the string "null" for some callers and fail
-- for others.
--
-- `content_assets` is the path → git object map, one row per entry in the
-- content repo's tree. It exists so a page render can turn a repo path into a
-- content-addressed URL with a single indexed read instead of a GitHub API
-- call. It is a CACHE, not a source of truth: every row is derivable from the
-- repo, it is refreshed from push webhooks and a TTL sweep, and a classroom
-- with no rows at all is a normal state that the first render repairs.
--
-- The primary key is (classroom_id, path) rather than a synthetic id because
-- the path IS the identity — a sync upserts by it, and a surrogate key would
-- let the same path exist twice. ON DELETE CASCADE because a deleted classroom
-- leaves nothing here worth keeping.

-- AlterTable
ALTER TABLE "classrooms" ADD COLUMN     "content_key_version" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "content_assets" (
    "classroom_id" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "sha" TEXT NOT NULL,
    -- 'blob' | 'tree'. A plain string, matching the values GitHub's tree API
    -- returns, so an unfamiliar entry type becomes a row nothing looks up
    -- rather than a migration that blocks a sync.
    "type" TEXT NOT NULL,
    "size" INTEGER NOT NULL DEFAULT 0,
    -- Stamped per sync run, not per row write. The full sync sweeps everything
    -- older than its own stamp, which is what deletes paths removed from the
    -- repo; `ensureContentAssets` reads the newest value to decide staleness.
    "synced_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "content_assets_pkey" PRIMARY KEY ("classroom_id","path")
);

-- CreateIndex
-- Directory lookups: theme folders are served by their tree SHA, so the
-- resolver filters a classroom's rows by type.
CREATE INDEX "content_assets_classroom_id_type_idx" ON "content_assets"("classroom_id", "type");

-- CreateIndex
-- Reverse lookup, sha → path. The editor does this on save so a stored block
-- keeps the repo path instead of freezing a signed URL into the content. NOT
-- unique: content-addressed means two paths holding identical bytes share a
-- sha, and either answer is correct.
CREATE INDEX "content_assets_classroom_id_sha_idx" ON "content_assets"("classroom_id", "sha");

-- AddForeignKey
ALTER TABLE "content_assets" ADD CONSTRAINT "content_assets_classroom_id_fkey" FOREIGN KEY ("classroom_id") REFERENCES "classrooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CreateIndex
-- Freshness probe: the render path reads the newest `synced_at` for one
-- classroom to decide whether the map is stale. Without this it scans and sorts
-- every row that classroom has, on every render.
CREATE INDEX "content_assets_classroom_id_synced_at_idx" ON "content_assets"("classroom_id", "synced_at");
