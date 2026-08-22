-- Public course websites: one optional site per classroom, served at
-- {subdomain}.classmoji.io.
--
-- Two uniques, both load-bearing and for different reasons:
--   * classroom_id — a classroom has at most one site. Modelled as a unique FK
--     column rather than making it the PK so the row keeps a stable id of its
--     own that admin URLs and audit rows can reference.
--   * subdomain — the request host is the ONLY thing the edge has to resolve a
--     site by. Two rows sharing a label would resolve to whichever the planner
--     returned first, i.e. one classroom serving another's content.
--
-- There is deliberately no `nav` column. Site navigation is authored content (a
-- "Page directory" block inside a page), not configuration; a JSON nav column
-- would be a second, silently-diverging copy of the page list.
--
-- `is_enabled` has no DB-level dependency on `home_page_id` even though the
-- product rule is "a site can only be enabled once it has a home page". That is
-- a cross-column invariant with a "was already true" escape hatch (clearing the
-- home page of a live site must be refused, not cascade it offline), which is
-- service-layer work — see validateAndClaimSubdomain/upsertSiteSettings in
-- packages/services/src/classmoji/site.service.ts (error code
-- HOME_PAGE_REQUIRED).
-- ---------------------------------------------------------------------------

-- CreateTable
CREATE TABLE "classroom_sites" (
    "id" TEXT NOT NULL,
    "classroom_id" TEXT NOT NULL,
    "subdomain" TEXT NOT NULL,
    "is_enabled" BOOLEAN NOT NULL DEFAULT false,
    "home_page_id" TEXT,
    "show_schedule" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "classroom_sites_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "classroom_sites_classroom_id_key" ON "classroom_sites"("classroom_id");

-- CreateIndex
CREATE UNIQUE INDEX "classroom_sites_subdomain_key" ON "classroom_sites"("subdomain");

-- AddForeignKey
-- CASCADE: a deleted classroom has no site, and the freed subdomain becomes
-- claimable again.
ALTER TABLE "classroom_sites" ADD CONSTRAINT "classroom_sites_classroom_id_fkey" FOREIGN KEY ("classroom_id") REFERENCES "classrooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
-- SET NULL, not CASCADE: deleting the page that happens to be a site's home
-- page must take the site offline for repair, never delete the site row — that
-- would silently release a subdomain someone else could then claim, and any
-- link to the old site would start resolving to a different course.
ALTER TABLE "classroom_sites" ADD CONSTRAINT "classroom_sites_home_page_id_fkey" FOREIGN KEY ("home_page_id") REFERENCES "pages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Subdomain shape, enforced in the database.
--
-- One RFC 1123 DNS label: starts and ends alphanumeric, may contain hyphens
-- inside, 1-63 characters. Case is NOT normalized here — the regex simply
-- rejects uppercase, because the unique index above is byte-comparing and
-- `CS52` alongside `cs52` would be two rows for one hostname. Callers normalize
-- (trim + lowercase) before writing; see normalizeSubdomain().
--
-- This pattern is duplicated as SUBDOMAIN_REGEX in
-- packages/utils/src/subdomains.ts and the two MUST stay byte-identical: the
-- service validates for a friendly error, the CHECK is what makes it true. A
-- raw SQL write or a psql session bypasses the service; nothing bypasses this.
--
-- Reserved labels (app, www, api, …) are deliberately NOT encoded here. That
-- list is product policy that changes as we add subdomains, and re-listing it
-- in a CHECK would mean a migration every time — RESERVED_SUBDOMAINS in
-- packages/utils/src/subdomains.ts is the single authority.
-- ---------------------------------------------------------------------------
ALTER TABLE "classroom_sites" ADD CONSTRAINT "classroom_sites_subdomain_check"
  CHECK ("subdomain" ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$');

-- ---------------------------------------------------------------------------
-- Module visibility on the public site.
--
-- Separate from `is_published` on purpose. `is_published` governs the in-app
-- student view; `is_public` governs the anonymous web. The site shows a module
-- only when BOTH are true, so turning a course website on can never publish
-- coursework that was only ever meant for enrolled students. Defaults false for
-- exactly that reason: every existing module stays off the web.
-- ---------------------------------------------------------------------------
-- AlterTable
ALTER TABLE "modules" ADD COLUMN "is_public" BOOLEAN NOT NULL DEFAULT false;
