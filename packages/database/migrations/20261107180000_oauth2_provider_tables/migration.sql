-- The OAuth 2.1 authorization server for MCP clients moves from better-auth
-- 1.4's `mcp` plugin to better-auth 1.7's oauth-provider (through
-- @better-auth/mcp and @better-auth/cimd), with the jwt plugin's signing keys.
--
-- Additive only. The 1.7 tables are new (`oauth2_*`, `jwks`); the 1.4 tables
-- (`oauth_applications`, `oauth_access_tokens`, `oauth_consents`) are read and
-- left exactly as they are, so the previous release still runs against this
-- database. A later migration drops them.
--
-- Copied into the 1.7 tables, so connected apps keep working without a new
-- sign-in:
--   1. every client except the two Classmoji-owned ids (classmoji-ask-moji,
--      classmoji-dev-mint), keeping its id, client id, name, icon and
--      disabled flag, with no owner (1.7 gives a client's owner nothing, and
--      deleting the owner's account would take every user's connection to
--      the client with it). A public client (`type` public) authenticates with
--      `none` and keeps no secret; any other client authenticates with
--      `client_secret_basic` and keeps its secret as better-auth 1.7 stores
--      one: SHA-256, base64url without padding. `redirect_urls` was a
--      comma-joined list. A client is `native` when one of its redirect URIs
--      is a loopback http address or uses another scheme, else `web`. Grants:
--      authorization_code and refresh_token; response type: code; scopes:
--      the server's scope list, as a newly registered client gets. (Prisma
--      reads a NULL list column as an empty list, which better-auth takes as
--      "no scopes allowed", so the list is written out.)
--   2. one consent per (client, user) that holds a given consent or a refresh
--      token that has not expired: the newest consent row's id, the scopes
--      of all of them together, created now.
--   3. every refresh token that has not expired, of a user, on a copied
--      client, hashed the same way and keeping its id, expiry and creation
--      time; its scopes gain `offline_access`, without which 1.7 does not
--      rotate it. No resources: the MCP resource differs per environment, so
--      the token endpoint's before-hook (packages/auth/src/server.ts) writes
--      it onto a copied token the first time that token is presented. Access
--      tokens (one hour) are not copied.
--   4. the two Classmoji-owned client ids, as disabled clients with no grant
--      types, redirect URIs or secret, so no OAuth client can ever carry
--      them.
--
-- mcp_internal_tokens holds the MCP bearer tokens Classmoji mints itself
-- (Ask Moji's and the quiz agent's per-turn tokens, and the dev mint's),
-- stored hashed.
--
-- The time zone is UTC for this transaction: the timestamp columns have no
-- time zone, and the copies compare with and write CURRENT_TIMESTAMP, which
-- would otherwise be the session's local time.

BEGIN;

SET LOCAL TIME ZONE 'UTC';

-- CreateTable
CREATE TABLE "oauth2_clients" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "client_secret" TEXT,
    "client_discovery_id" TEXT,
    "disabled" BOOLEAN DEFAULT false,
    "skip_consent" BOOLEAN,
    "enable_end_session" BOOLEAN,
    "subject_type" TEXT,
    "scopes" TEXT[],
    "client_credentials_scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "user_id" TEXT,
    "created_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "name" TEXT,
    "uri" TEXT,
    "icon" TEXT,
    "contacts" TEXT[],
    "tos" TEXT,
    "policy" TEXT,
    "software_id" TEXT,
    "software_version" TEXT,
    "software_statement" TEXT,
    "redirect_uris" TEXT[],
    "post_logout_redirect_uris" TEXT[],
    "backchannel_logout_uri" TEXT,
    "backchannel_logout_session_required" BOOLEAN,
    "token_endpoint_auth_method" TEXT,
    "application_type" TEXT,
    "jwks" TEXT,
    "jwks_uri" TEXT,
    "grant_types" TEXT[],
    "response_types" TEXT[],
    "require_pkce" BOOLEAN,
    "dpop_bound_access_tokens" BOOLEAN DEFAULT false,
    "reference_id" TEXT,
    "metadata" JSONB,

    CONSTRAINT "oauth2_clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth2_resources" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "access_token_ttl" INTEGER,
    "refresh_token_ttl" INTEGER,
    "signing_algorithm" TEXT,
    "signing_key_id" TEXT,
    "allowed_scopes" TEXT[],
    "custom_claims" JSONB,
    "dpop_bound_access_tokens_required" BOOLEAN DEFAULT false,
    "disabled" BOOLEAN DEFAULT false,
    "created_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "policy_version" INTEGER DEFAULT 1,
    "metadata" JSONB,

    CONSTRAINT "oauth2_resources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth2_client_resources" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "resource_id" TEXT NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth2_client_resources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth2_refresh_tokens" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "session_id" TEXT,
    "user_id" TEXT NOT NULL,
    "reference_id" TEXT,
    "authorization_code_id" TEXT,
    "resources" TEXT[],
    "requested_user_info_claims" TEXT[],
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked" TIMESTAMP(3),
    "rotated_at" TIMESTAMP(3),
    "rotation_replay_response" TEXT,
    "rotation_replay_expires_at" TIMESTAMP(3),
    "auth_time" TIMESTAMP(3),
    "confirmation" JSONB,
    "scopes" TEXT[],

    CONSTRAINT "oauth2_refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth2_access_tokens" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "session_id" TEXT,
    "user_id" TEXT,
    "reference_id" TEXT,
    "authorization_code_id" TEXT,
    "resources" TEXT[],
    "requested_user_info_claims" TEXT[],
    "refresh_id" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked" TIMESTAMP(3),
    "confirmation" JSONB,
    "scopes" TEXT[],

    CONSTRAINT "oauth2_access_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth2_consents" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "user_id" TEXT,
    "reference_id" TEXT,
    "resources" TEXT[],
    "requested_user_info_claims" TEXT[],
    "scopes" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth2_consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth2_client_assertions" (
    "id" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "oauth2_client_assertions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jwks" (
    "id" TEXT NOT NULL,
    "public_key" TEXT NOT NULL,
    "private_key" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),
    "alg" TEXT,
    "crv" TEXT,

    CONSTRAINT "jwks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mcp_internal_tokens" (
    "id" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "scopes" TEXT[],
    "expires_at" TIMESTAMP(3) NOT NULL,
    "impersonation_session_id" TEXT,
    "impersonated_by" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mcp_internal_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "oauth2_clients_client_id_key" ON "oauth2_clients"("client_id");

-- CreateIndex
CREATE INDEX "oauth2_clients_user_id_idx" ON "oauth2_clients"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "oauth2_resources_identifier_key" ON "oauth2_resources"("identifier");

-- CreateIndex
CREATE INDEX "oauth2_client_resources_client_id_idx" ON "oauth2_client_resources"("client_id");

-- CreateIndex
CREATE INDEX "oauth2_client_resources_resource_id_idx" ON "oauth2_client_resources"("resource_id");

-- CreateIndex
CREATE UNIQUE INDEX "oauth2_client_resources_client_id_resource_id_key" ON "oauth2_client_resources"("client_id", "resource_id");

-- CreateIndex
CREATE UNIQUE INDEX "oauth2_refresh_tokens_token_key" ON "oauth2_refresh_tokens"("token");

-- CreateIndex
CREATE INDEX "oauth2_refresh_tokens_client_id_idx" ON "oauth2_refresh_tokens"("client_id");

-- CreateIndex
CREATE INDEX "oauth2_refresh_tokens_session_id_idx" ON "oauth2_refresh_tokens"("session_id");

-- CreateIndex
CREATE INDEX "oauth2_refresh_tokens_user_id_idx" ON "oauth2_refresh_tokens"("user_id");

-- CreateIndex
CREATE INDEX "oauth2_refresh_tokens_authorization_code_id_idx" ON "oauth2_refresh_tokens"("authorization_code_id");

-- CreateIndex
CREATE UNIQUE INDEX "oauth2_access_tokens_token_key" ON "oauth2_access_tokens"("token");

-- CreateIndex
CREATE INDEX "oauth2_access_tokens_client_id_idx" ON "oauth2_access_tokens"("client_id");

-- CreateIndex
CREATE INDEX "oauth2_access_tokens_session_id_idx" ON "oauth2_access_tokens"("session_id");

-- CreateIndex
CREATE INDEX "oauth2_access_tokens_user_id_idx" ON "oauth2_access_tokens"("user_id");

-- CreateIndex
CREATE INDEX "oauth2_access_tokens_authorization_code_id_idx" ON "oauth2_access_tokens"("authorization_code_id");

-- CreateIndex
CREATE INDEX "oauth2_access_tokens_refresh_id_idx" ON "oauth2_access_tokens"("refresh_id");

-- CreateIndex
CREATE INDEX "oauth2_consents_client_id_idx" ON "oauth2_consents"("client_id");

-- CreateIndex
CREATE INDEX "oauth2_consents_user_id_idx" ON "oauth2_consents"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "mcp_internal_tokens_token_hash_key" ON "mcp_internal_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "mcp_internal_tokens_user_id_client_id_idx" ON "mcp_internal_tokens"("user_id", "client_id");

-- AddForeignKey
ALTER TABLE "oauth2_clients" ADD CONSTRAINT "oauth2_clients_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth2_client_resources" ADD CONSTRAINT "oauth2_client_resources_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "oauth2_clients"("client_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth2_client_resources" ADD CONSTRAINT "oauth2_client_resources_resource_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "oauth2_resources"("identifier") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth2_refresh_tokens" ADD CONSTRAINT "oauth2_refresh_tokens_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "oauth2_clients"("client_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth2_refresh_tokens" ADD CONSTRAINT "oauth2_refresh_tokens_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth2_refresh_tokens" ADD CONSTRAINT "oauth2_refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth2_access_tokens" ADD CONSTRAINT "oauth2_access_tokens_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "oauth2_clients"("client_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth2_access_tokens" ADD CONSTRAINT "oauth2_access_tokens_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth2_access_tokens" ADD CONSTRAINT "oauth2_access_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth2_access_tokens" ADD CONSTRAINT "oauth2_access_tokens_refresh_id_fkey" FOREIGN KEY ("refresh_id") REFERENCES "oauth2_refresh_tokens"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth2_consents" ADD CONSTRAINT "oauth2_consents_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "oauth2_clients"("client_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth2_consents" ADD CONSTRAINT "oauth2_consents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mcp_internal_tokens" ADD CONSTRAINT "mcp_internal_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- 1. Clients.
INSERT INTO "oauth2_clients" (
    "id", "client_id", "client_secret", "disabled", "name", "icon", "user_id",
    "redirect_uris", "token_endpoint_auth_method", "application_type",
    "grant_types", "response_types", "scopes", "created_at", "updated_at"
)
SELECT
    a."id",
    a."client_id",
    CASE
        WHEN a."type" = 'public' OR COALESCE(a."client_secret", '') = '' THEN NULL
        ELSE rtrim(translate(encode(sha256(convert_to(a."client_secret", 'UTF8')), 'base64'), '+/', '-_'), '=')
    END,
    COALESCE(a."disabled", false),
    a."name",
    a."icon",
    NULL,
    string_to_array(a."redirect_urls", ','),
    CASE WHEN a."type" = 'public' THEN 'none' ELSE 'client_secret_basic' END,
    CASE
        WHEN EXISTS (
            SELECT 1
            FROM unnest(string_to_array(a."redirect_urls", ',')) AS u("uri")
            WHERE u."uri" !~* '^https?://'
               OR u."uri" ~* '^http://(localhost|127\.0\.0\.1|\[::1\])([:/?#]|$)'
        ) THEN 'native'
        ELSE 'web'
    END,
    ARRAY['authorization_code', 'refresh_token'],
    ARRAY['code'],
    ARRAY['openid', 'profile', 'email', 'offline_access', 'read', 'write'],
    a."created_at",
    a."updated_at"
FROM "oauth_applications" a
WHERE a."client_id" NOT IN ('classmoji-ask-moji', 'classmoji-dev-mint');

-- 2. Consents.
WITH "grants" AS (
    SELECT c."client_id", c."user_id", c."id" AS "consent_id", c."created_at", c."scopes"
    FROM "oauth_consents" c
    WHERE c."consent_given"
    UNION ALL
    SELECT t."client_id", t."user_id", NULL, NULL, t."scopes"
    FROM "oauth_access_tokens" t
    WHERE t."refresh_token_expires_at" > CURRENT_TIMESTAMP
      AND t."user_id" IS NOT NULL
),
"newest" AS (
    SELECT DISTINCT ON (g."client_id", g."user_id") g."client_id", g."user_id", g."consent_id"
    FROM "grants" g
    ORDER BY g."client_id", g."user_id", g."created_at" DESC NULLS LAST, g."consent_id" DESC NULLS LAST
),
"scopes" AS (
    SELECT g."client_id", g."user_id", array_agg(DISTINCT s."scope" ORDER BY s."scope") AS "scopes"
    FROM "grants" g
    CROSS JOIN LATERAL unnest(string_to_array(g."scopes", ' ')) AS s("scope")
    WHERE s."scope" <> ''
    GROUP BY g."client_id", g."user_id"
)
INSERT INTO "oauth2_consents" ("id", "client_id", "user_id", "scopes", "created_at", "updated_at")
SELECT
    COALESCE(n."consent_id", gen_random_uuid()::text),
    n."client_id",
    n."user_id",
    COALESCE(s."scopes", ARRAY[]::text[]),
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM "newest" n
JOIN "oauth2_clients" c ON c."client_id" = n."client_id"
    AND c."client_id" NOT IN ('classmoji-ask-moji', 'classmoji-dev-mint')
LEFT JOIN "scopes" s ON s."client_id" = n."client_id" AND s."user_id" = n."user_id";

-- 3. Refresh tokens.
INSERT INTO "oauth2_refresh_tokens" (
    "id", "token", "client_id", "user_id", "scopes", "expires_at", "created_at"
)
SELECT
    t."id",
    rtrim(translate(encode(sha256(convert_to(t."refresh_token", 'UTF8')), 'base64'), '+/', '-_'), '='),
    t."client_id",
    t."user_id",
    ARRAY(
        SELECT DISTINCT s."scope"
        FROM unnest(string_to_array(t."scopes", ' ') || ARRAY['offline_access']) AS s("scope")
        WHERE s."scope" <> ''
        ORDER BY s."scope"
    ),
    t."refresh_token_expires_at",
    t."created_at"
FROM "oauth_access_tokens" t
JOIN "oauth2_clients" c ON c."client_id" = t."client_id"
WHERE t."refresh_token_expires_at" > CURRENT_TIMESTAMP
  AND t."user_id" IS NOT NULL
  AND t."client_id" NOT IN ('classmoji-ask-moji', 'classmoji-dev-mint');

-- 4. The Classmoji-owned client ids, reserved. Last, so the joins on the
--    copied clients above can never pick them up.
INSERT INTO "oauth2_clients" (
    "id", "client_id", "disabled", "name", "redirect_uris", "token_endpoint_auth_method",
    "grant_types", "response_types", "created_at", "updated_at"
)
VALUES
    (gen_random_uuid()::text, 'classmoji-ask-moji', true, 'Ask Moji', ARRAY[]::text[],
     'client_secret_basic', ARRAY[]::text[], ARRAY[]::text[], CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
    (gen_random_uuid()::text, 'classmoji-dev-mint', true, 'Classmoji dev mint', ARRAY[]::text[],
     'client_secret_basic', ARRAY[]::text[], ARRAY[]::text[], CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

COMMIT;
