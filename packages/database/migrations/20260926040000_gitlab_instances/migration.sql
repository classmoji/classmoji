-- Self-managed GitLab instances: one OAuth application per instance, so one
-- deployment serves gitlab.com and any number of school GitLabs. Connections
-- and groups record which instance they are on (null: the default instance).

-- AlterTable
ALTER TABLE "gitlab_connections" ADD COLUMN     "gitlab_instance_id" TEXT;

-- AlterTable
ALTER TABLE "git_organizations" ADD COLUMN     "gitlab_instance_id" TEXT;

-- CreateTable
CREATE TABLE "gitlab_instances" (
    "id" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "client_id" TEXT NOT NULL,
    "client_secret" TEXT NOT NULL,
    "created_by_user_id" TEXT,
    "disabled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "gitlab_instances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "gitlab_instances_host_key" ON "gitlab_instances"("host");

-- AddForeignKey
ALTER TABLE "gitlab_connections" ADD CONSTRAINT "gitlab_connections_gitlab_instance_id_fkey" FOREIGN KEY ("gitlab_instance_id") REFERENCES "gitlab_instances"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "gitlab_instances" ADD CONSTRAINT "gitlab_instances_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "git_organizations" ADD CONSTRAINT "git_organizations_gitlab_instance_id_fkey" FOREIGN KEY ("gitlab_instance_id") REFERENCES "gitlab_instances"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

