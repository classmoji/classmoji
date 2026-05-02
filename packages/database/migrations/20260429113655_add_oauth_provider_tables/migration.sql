-- CreateTable
CREATE TABLE "oauth_clients" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "client_secret" TEXT,
    "disabled" BOOLEAN DEFAULT false,
    "skip_consent" BOOLEAN,
    "enable_end_session" BOOLEAN,
    "subject_type" TEXT,
    "scopes" TEXT[],
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
    "token_endpoint_auth_method" TEXT,
    "grant_types" TEXT[],
    "response_types" TEXT[],
    "public" BOOLEAN,
    "type" TEXT,
    "require_pkce" BOOLEAN,
    "reference_id" TEXT,
    "metadata" JSONB,

    CONSTRAINT "oauth_clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_refresh_tokens" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "session_id" TEXT,
    "user_id" TEXT NOT NULL,
    "reference_id" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revoked" TIMESTAMP(3),
    "auth_time" TIMESTAMP(3),
    "scopes" TEXT[],

    CONSTRAINT "oauth_refresh_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_access_tokens" (
    "id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "session_id" TEXT,
    "user_id" TEXT,
    "reference_id" TEXT,
    "refresh_id" TEXT,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "scopes" TEXT[],

    CONSTRAINT "oauth_access_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_consents" (
    "id" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "user_id" TEXT,
    "reference_id" TEXT,
    "scopes" TEXT[],
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jwks" (
    "id" TEXT NOT NULL,
    "public_key" TEXT NOT NULL,
    "private_key" TEXT NOT NULL,
    "alg" TEXT,
    "crv" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),

    CONSTRAINT "jwks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "oauth_clients_client_id_key" ON "oauth_clients"("client_id");

-- CreateIndex
CREATE INDEX "oauth_clients_user_id_idx" ON "oauth_clients"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_refresh_tokens_token_key" ON "oauth_refresh_tokens"("token");

-- CreateIndex
CREATE INDEX "oauth_refresh_tokens_client_id_idx" ON "oauth_refresh_tokens"("client_id");

-- CreateIndex
CREATE INDEX "oauth_refresh_tokens_user_id_idx" ON "oauth_refresh_tokens"("user_id");

-- CreateIndex
CREATE INDEX "oauth_refresh_tokens_expires_at_idx" ON "oauth_refresh_tokens"("expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_access_tokens_token_key" ON "oauth_access_tokens"("token");

-- CreateIndex
CREATE INDEX "oauth_access_tokens_client_id_idx" ON "oauth_access_tokens"("client_id");

-- CreateIndex
CREATE INDEX "oauth_access_tokens_user_id_idx" ON "oauth_access_tokens"("user_id");

-- CreateIndex
CREATE INDEX "oauth_access_tokens_expires_at_idx" ON "oauth_access_tokens"("expires_at");

-- CreateIndex
CREATE INDEX "oauth_consents_client_id_idx" ON "oauth_consents"("client_id");

-- CreateIndex
CREATE INDEX "oauth_consents_user_id_idx" ON "oauth_consents"("user_id");

-- AddForeignKey
ALTER TABLE "oauth_clients" ADD CONSTRAINT "oauth_clients_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_refresh_tokens" ADD CONSTRAINT "oauth_refresh_tokens_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "oauth_clients"("client_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_refresh_tokens" ADD CONSTRAINT "oauth_refresh_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "oauth_clients"("client_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_access_tokens" ADD CONSTRAINT "oauth_access_tokens_refresh_id_fkey" FOREIGN KEY ("refresh_id") REFERENCES "oauth_refresh_tokens"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_consents" ADD CONSTRAINT "oauth_consents_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "oauth_clients"("client_id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_consents" ADD CONSTRAINT "oauth_consents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
