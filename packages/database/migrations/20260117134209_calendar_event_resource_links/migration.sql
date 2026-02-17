-- CreateTable
CREATE TABLE "calendar_event_page_links" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "page_id" TEXT NOT NULL,
    "occurrence_date" DATE,
    "order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "calendar_event_page_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendar_event_slide_links" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "slide_id" TEXT NOT NULL,
    "occurrence_date" DATE,
    "order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "calendar_event_slide_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "calendar_event_assignment_links" (
    "id" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "assignment_id" TEXT NOT NULL,
    "occurrence_date" DATE,
    "order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "calendar_event_assignment_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "calendar_event_page_links_event_id_idx" ON "calendar_event_page_links"("event_id");

-- CreateIndex
CREATE INDEX "calendar_event_page_links_event_id_occurrence_date_idx" ON "calendar_event_page_links"("event_id", "occurrence_date");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_event_page_links_event_id_page_id_occurrence_date_key" ON "calendar_event_page_links"("event_id", "page_id", "occurrence_date");

-- CreateIndex
CREATE INDEX "calendar_event_slide_links_event_id_idx" ON "calendar_event_slide_links"("event_id");

-- CreateIndex
CREATE INDEX "calendar_event_slide_links_event_id_occurrence_date_idx" ON "calendar_event_slide_links"("event_id", "occurrence_date");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_event_slide_links_event_id_slide_id_occurrence_dat_key" ON "calendar_event_slide_links"("event_id", "slide_id", "occurrence_date");

-- CreateIndex
CREATE INDEX "calendar_event_assignment_links_event_id_idx" ON "calendar_event_assignment_links"("event_id");

-- CreateIndex
CREATE INDEX "calendar_event_assignment_links_event_id_occurrence_date_idx" ON "calendar_event_assignment_links"("event_id", "occurrence_date");

-- CreateIndex
CREATE UNIQUE INDEX "calendar_event_assignment_links_event_id_assignment_id_occu_key" ON "calendar_event_assignment_links"("event_id", "assignment_id", "occurrence_date");

-- AddForeignKey
ALTER TABLE "calendar_event_page_links" ADD CONSTRAINT "calendar_event_page_links_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "calendar_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_event_page_links" ADD CONSTRAINT "calendar_event_page_links_page_id_fkey" FOREIGN KEY ("page_id") REFERENCES "pages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_event_slide_links" ADD CONSTRAINT "calendar_event_slide_links_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "calendar_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_event_slide_links" ADD CONSTRAINT "calendar_event_slide_links_slide_id_fkey" FOREIGN KEY ("slide_id") REFERENCES "slides"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_event_assignment_links" ADD CONSTRAINT "calendar_event_assignment_links_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "calendar_events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "calendar_event_assignment_links" ADD CONSTRAINT "calendar_event_assignment_links_assignment_id_fkey" FOREIGN KEY ("assignment_id") REFERENCES "assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Partial unique indexes for NULL occurrence_date (non-recurring events)
-- These are needed because PostgreSQL's unique constraint treats NULL as distinct
CREATE UNIQUE INDEX "calendar_event_page_links_null_date" ON "calendar_event_page_links"("event_id", "page_id") WHERE "occurrence_date" IS NULL;

CREATE UNIQUE INDEX "calendar_event_slide_links_null_date" ON "calendar_event_slide_links"("event_id", "slide_id") WHERE "occurrence_date" IS NULL;

CREATE UNIQUE INDEX "calendar_event_assignment_links_null_date" ON "calendar_event_assignment_links"("event_id", "assignment_id") WHERE "occurrence_date" IS NULL;
