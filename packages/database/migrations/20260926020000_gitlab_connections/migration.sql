-- A GitLab OAuth grant (api scope) Classmoji uses to act on GitLab groups: the
-- counterpart of a Github App installation. Groups point at it the way Github
-- orgs carry an installation id.

-- CreateTable
CREATE TABLE "gitlab_connections" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "gitlab_user_id" TEXT NOT NULL,
    "gitlab_username" TEXT NOT NULL,
    "access_token" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token_expires_at" TIMESTAMP(3),
    "scope" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gitlab_connections_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "gitlab_connections_user_id_key" ON "gitlab_connections"("user_id");

-- AddForeignKey
ALTER TABLE "gitlab_connections" ADD CONSTRAINT "gitlab_connections_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "git_organizations" ADD COLUMN "gitlab_connection_id" TEXT;

-- AddForeignKey
ALTER TABLE "git_organizations" ADD CONSTRAINT "git_organizations_gitlab_connection_id_fkey" FOREIGN KEY ("gitlab_connection_id") REFERENCES "gitlab_connections"("id") ON DELETE SET NULL ON UPDATE CASCADE;
