-- CreateTable
CREATE TABLE "resource_views" (
    "id" TEXT NOT NULL,
    "resource_path" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "classroom_id" TEXT NOT NULL,
    "last_viewed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "resource_views_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "resource_views_classroom_id_resource_path_idx" ON "resource_views"("classroom_id", "resource_path");

-- CreateIndex
CREATE INDEX "resource_views_last_viewed_at_idx" ON "resource_views"("last_viewed_at");

-- CreateIndex
CREATE UNIQUE INDEX "resource_views_resource_path_user_id_classroom_id_key" ON "resource_views"("resource_path", "user_id", "classroom_id");

-- AddForeignKey
ALTER TABLE "resource_views" ADD CONSTRAINT "resource_views_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resource_views" ADD CONSTRAINT "resource_views_classroom_id_fkey" FOREIGN KEY ("classroom_id") REFERENCES "classrooms"("id") ON DELETE CASCADE ON UPDATE CASCADE;
