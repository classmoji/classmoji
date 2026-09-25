-- The course's time zone becomes a CLASSROOM setting.
--
-- Until now the only stored zone was classroom_sites.timezone, which exists only
-- for classrooms that claimed a public-site subdomain, and few of those set one.
-- Ask Moji and the MCP server need a zone for EVERY
-- classroom, so the value moves to classroom_settings, where the general
-- Settings page, classroom creation and the MCP classroom_settings_update tool
-- can all reach it. The public schedule reads the new column too, so there is
-- one control and one value.
--
-- Nullable: null means "not set". Readers fall back to the asking user's browser
-- zone (Ask Moji only) and otherwise to UTC, labelled as UTC.
-- ---------------------------------------------------------------------------

-- AlterTable
ALTER TABLE "classroom_settings"
  ADD COLUMN "timezone" TEXT;

-- Shape floor only, identical to classroom_sites_timezone_check: the authority
-- on whether a string is a real zone is the runtime's Intl data, checked in
-- classroom.updateSettings. This refuses only shapes no IANA release has used.
ALTER TABLE "classroom_settings" ADD CONSTRAINT "classroom_settings_timezone_check"
  CHECK (
    "timezone" IS NULL
    OR (
      "timezone" ~ '^[A-Za-z0-9+_/-]+$'
      AND length("timezone") <= 64
    )
  );

-- ---------------------------------------------------------------------------
-- Backfill from the site zone, where one was chosen.
--
-- Upsert rather than UPDATE: a classroom can lack a classroom_settings row
-- (every settings writer upserts), and an UPDATE alone would silently drop that
-- classroom's zone. A row created here takes the column defaults, which is the
-- same row classroom.updateSettings would create on the first settings save.
-- An existing non-null classroom zone is never overwritten.
--
-- classroom_sites.timezone is NOT dropped here: a process still on the previous
-- release selects it until the rollout finishes. A later migration drops it.
-- ---------------------------------------------------------------------------
INSERT INTO "classroom_settings" ("classroom_id", "timezone", "updated_at")
SELECT s."classroom_id", s."timezone", CURRENT_TIMESTAMP
FROM "classroom_sites" s
WHERE s."timezone" IS NOT NULL
ON CONFLICT ("classroom_id") DO UPDATE
  SET "timezone" = EXCLUDED."timezone",
      "updated_at" = CURRENT_TIMESTAMP
  WHERE "classroom_settings"."timezone" IS NULL;
