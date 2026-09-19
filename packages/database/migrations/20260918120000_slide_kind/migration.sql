-- A slide is no longer always a deck.
--
-- Three kinds share the `slides` table, one id, and one `${SLIDES_URL}/{id}`
-- link: DECK (the reveal.js deck this table has always held), FILE (a document
-- students download — PDF/PPT/PPTX/KEY), and LINK (an external https URL the
-- viewer is redirected to). One table rather than three because every module
-- item, calendar link, resource link and public-site reference already points
-- at a Slide id, and splitting the row would mean teaching all of them a second
-- shape for no gain a column does not already give.
--
-- `kind` is NOT NULL DEFAULT 'DECK', which backfills every existing row to
-- exactly what it is. Nothing else needs a backfill: the source_* columns below
-- describe content a deck does not have, and NULL across the board is the
-- truthful reading for one.
--
-- `content_path` stays NOT NULL for all three kinds and keeps meaning
-- `slides/<slug>`. For a DECK it is the folder holding `deck.json` and
-- `index.html`; for a FILE it is the folder the uploaded document sits in; for
-- a LINK nothing is committed there at all, but the path is still the row's
-- stable identity in the content repo and is what `deleteSlide` removes. Making
-- it nullable would have meant auditing every reader that appends `/index.html`
-- to it — the readers that MATTER are being taught about `kind` instead, which
-- is the check that actually holds.
--
-- ── WHY THE FILE'S NAME IS TWO COLUMNS ──────────────────────────────────────
-- `source_path` ends in a sanitized ASCII storage name, because it is a git
-- path in a shared repo. `source_filename` is the ORIGINAL name the browser
-- must save the download under, kept verbatim (after
-- `normalizeDownloadFilename` refuses control characters, separators, bidi
-- overrides and anything over 200 UTF-8 bytes). They are different strings for
-- any file whose name has a space, an accent or a capital letter in it, and
-- collapsing them would either put unsanitized bytes into a path or hand the
-- student a download called `lecture-1-intro.pdf` when the instructor uploaded
-- `Lecture 1 — Intro.pdf`.
--
-- No URL is stored for a FILE. A download URL is signed per request from the
-- blob sha the asset map holds, for the same reasons the delivery layer already
-- documents: signatures expire, and a stored one stops following its file the
-- moment the document is replaced.
--
-- `source_size` is INTEGER: the cap is 75 MB, three orders of magnitude under
-- the 2^31 ceiling.
CREATE TYPE "SlideKind" AS ENUM ('DECK', 'FILE', 'LINK');

ALTER TABLE "slides" ADD COLUMN "kind" "SlideKind" NOT NULL DEFAULT 'DECK';
ALTER TABLE "slides" ADD COLUMN "source_path" TEXT;
ALTER TABLE "slides" ADD COLUMN "source_filename" TEXT;
ALTER TABLE "slides" ADD COLUMN "source_mime" TEXT;
ALTER TABLE "slides" ADD COLUMN "source_size" INTEGER;
ALTER TABLE "slides" ADD COLUMN "source_url" TEXT;
