-- The time zone a public course site renders its schedule dates in.
--
-- Why this column has to exist at all, since nothing else in the product stores
-- a zone: /schedule is the ONLY surface that formats a deadline on the server.
-- Every member-facing view hands the raw instant to the browser and lets it
-- format, so it lands in the reader's own zone for free. The public schedule
-- ships no JavaScript and is shared-cacheable for 60s, so one process's
-- rendering is what every visitor reads — and that process is UTC on Fly (an
-- alpine image with no TZ set). A `Sep 12, 23:59 America/New_York` deadline
-- therefore published as "Sep 13", one day later than what the enrolled
-- students in that course were looking at.
--
-- NULLABLE, and null is a real state rather than a hole to be backfilled:
-- existing sites have never had a zone, we cannot infer one (a classroom has no
-- location, and the owner's browser zone is not the course's), and guessing
-- would silently move every existing published date by up to a day. Null means
-- "fall back to UTC", which the renderer then LABELS as UTC — an honest
-- "Sep 13, 2026 (UTC)" instead of a bare date whose meaning depends on where
-- the server happened to be.
-- ---------------------------------------------------------------------------

-- AlterTable
ALTER TABLE "classroom_sites"
  ADD COLUMN "timezone" TEXT;

-- ---------------------------------------------------------------------------
-- Shape floor only — deliberately NOT a list of valid zones.
--
-- The authority on whether a string is a real zone is the runtime's own tz
-- data, checked in site.service by asking Intl to build a formatter with it
-- (which is exactly what dayjs.tz does downstream, so the check tests the thing
-- that has to work rather than a copy of it). Encoding the IANA registry in a
-- CHECK would be wrong twice over: the registry gains, renames and retires
-- zones several times a year without a migration, and a database that accepts a
-- zone Node cannot format is no safer than one that does not.
--
-- What the CHECK is for is the writes that never pass through the service — a
-- psql session, a data fix, a future importer. It refuses the shapes that are
-- not zone names under any tz release: empty or whitespace-padded strings, and
-- anything outside the character set IANA names have ever used (ASCII letters,
-- digits, `/`, `_`, `+` and `-`). 64 bytes is roughly twice the longest name in
-- the database today (`America/Argentina/ComodRivadavia`, 32).
-- ---------------------------------------------------------------------------
ALTER TABLE "classroom_sites" ADD CONSTRAINT "classroom_sites_timezone_check"
  CHECK (
    "timezone" IS NULL
    OR (
      "timezone" ~ '^[A-Za-z0-9+_/-]+$'
      AND length("timezone") <= 64
    )
  );
