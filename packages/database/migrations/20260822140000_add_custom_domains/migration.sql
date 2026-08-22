-- Custom domains for public course websites (PRO-gated).
--
-- A site already answers at {subdomain}.classmoji.io. This lets a PRO
-- instructor point a hostname they own (cs52.me) at the same content. One
-- hostname per site in v1 — hence a column on classroom_sites rather than a
-- child table; a second hostname (the www twin) would want the table, and this
-- column is the thing that gets migrated into it when that day comes.
--
-- Stored as a BARE lowercase domain: no scheme, no port, no trailing dot, no
-- path. That is not a style choice — it is the exact normal form
-- `parseHostHeader` in apps/pages/server/siteHost.ts reduces an inbound Host
-- header to, and this column is compared against that output on every request.
-- Any other shape here is a row that can never match a real request.
-- ---------------------------------------------------------------------------

-- AlterTable
ALTER TABLE "classroom_sites"
  ADD COLUMN "custom_domain" TEXT,
  -- Set the first time the claim actually SERVES over its own hostname. A
  -- completed TLS handshake on a certificate we asked Fly to issue is the
  -- ownership proof; nothing else in this system has one. Deliberately NOT a
  -- serving gate (a live TLS host that 404s forever is worse than a duplicate
  -- canonical) — it gates the rel=canonical/og:url flip and the admin status
  -- chip.
  ADD COLUMN "custom_domain_verified_at" TIMESTAMP(3);

-- CreateIndex
-- Globally unique, for the same reason `subdomain` is: the request host is the
-- ONLY thing the edge has to resolve a tenant by, so two rows sharing a
-- hostname would mean one classroom serving another's content depending on
-- which row the planner returned. Postgres treats NULLs as distinct in a unique
-- index, so the overwhelming majority of sites — which have no custom domain —
-- are unaffected.
CREATE UNIQUE INDEX "classroom_sites_custom_domain_key" ON "classroom_sites"("custom_domain");

-- ---------------------------------------------------------------------------
-- Hostname shape, enforced in the database.
--
-- Two or more RFC 1123 labels, lowercase only, 253 bytes max. The lowercase
-- rule is load-bearing exactly as it is for `subdomain`: hostnames are
-- case-insensitive but this unique index is byte-comparing, so `CS52.ME`
-- alongside `cs52.me` would be two rows for one hostname. Callers normalize
-- (trim + lowercase + strip a trailing dot) before writing; see
-- normalizeCustomDomain in packages/utils/src/subdomains.ts.
--
-- The label pattern is byte-identical to BARE_DOMAIN in
-- apps/pages/server/siteHost.ts and to CUSTOM_DOMAIN_REGEX in
-- packages/utils/src/subdomains.ts. Three copies, and they must stay in sync:
-- the util produces a friendly error, siteHost is the read-side shape check on
-- the request hot path, and this CHECK is what makes it TRUE for writes that
-- never pass through either (a psql session, a data fix, a future service).
--
-- The platform's own domains are refused here rather than left to the service,
-- because getting one into this column is not a validation slip — it is a
-- hijack of the canonical host. `(^|\.)classmoji\.io$` catches both the apex
-- and every subdomain of it, so no row can ever claim a hostname the wildcard
-- certificate already answers for. `lvh.me` (dev's SITE_BASE_DOMAIN) and
-- `fly.dev` (every Fly app's default hostname, including our own) are refused
-- on the same principle.
--
-- Reserved-domain policy beyond these three — a blocklist of, say, competitor
-- or lookalike domains — deliberately does NOT live here. That is product
-- policy that changes without a migration, and belongs with RESERVED_SUBDOMAINS
-- in packages/utils/src/subdomains.ts.
-- ---------------------------------------------------------------------------
ALTER TABLE "classroom_sites" ADD CONSTRAINT "classroom_sites_custom_domain_check"
  CHECK (
    "custom_domain" IS NULL
    OR (
      "custom_domain" ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
      AND length("custom_domain") <= 253
      AND "custom_domain" !~ '(^|\.)classmoji\.io$'
      AND "custom_domain" !~ '(^|\.)lvh\.me$'
      AND "custom_domain" !~ '(^|\.)fly\.dev$'
    )
  );

-- ---------------------------------------------------------------------------
-- A verification stamp with no domain under it is meaningless, and worse than
-- meaningless if a later claim reads it: it would present a brand-new,
-- unproven hostname as already verified. The service clears the stamp on every
-- re-claim; this makes the invariant true for writes that skip the service.
-- ---------------------------------------------------------------------------
ALTER TABLE "classroom_sites" ADD CONSTRAINT "classroom_sites_custom_domain_verified_check"
  CHECK ("custom_domain" IS NOT NULL OR "custom_domain_verified_at" IS NULL);
