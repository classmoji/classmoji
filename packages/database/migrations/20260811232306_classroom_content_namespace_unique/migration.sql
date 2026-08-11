-- The content repo name is content-{orgLogin}-{content_namespace}: two
-- classrooms in one org sharing a namespace would share (and could adopt,
-- overwrite, or delete) each other's content repo. Enforce per-org uniqueness.

-- Repair pre-existing duplicates first: keep the OLDEST row in each
-- [git_org_id, content_namespace] group, repoint newer rows to their slug
-- (slug is already unique per org). Verified: all duplicate rows in prod have
-- zero pages/slides, so no content repo exists for them and repointing is safe.
UPDATE "classrooms" c SET "content_namespace" = c."slug"
WHERE EXISTS (
  SELECT 1 FROM "classrooms" other
  WHERE other."git_org_id" = c."git_org_id"
    AND other."content_namespace" = c."content_namespace"
    AND other."id" <> c."id"
    AND (other."created_at" < c."created_at"
         OR (other."created_at" = c."created_at" AND other."id" < c."id"))
);

-- Defensive second pass: if a repointed namespace still collides (another
-- classroom already used this slug as its namespace), suffix with the id prefix.
UPDATE "classrooms" c SET "content_namespace" = c."content_namespace" || '-' || substr(c."id", 1, 8)
WHERE EXISTS (
  SELECT 1 FROM "classrooms" other
  WHERE other."git_org_id" = c."git_org_id"
    AND other."content_namespace" = c."content_namespace"
    AND other."id" <> c."id"
    AND (other."created_at" < c."created_at"
         OR (other."created_at" = c."created_at" AND other."id" < c."id"))
);

-- CreateIndex
CREATE UNIQUE INDEX "classrooms_git_org_id_content_namespace_key" ON "classrooms"("git_org_id", "content_namespace");
