-- Whether Classmoji created a classroom's Gitlab subgroup. Existing rows are
-- left false: they may have adopted a group that already existed, so deleting
-- them removes Classmoji's projects one by one, never the whole group.
ALTER TABLE "classrooms" ADD COLUMN "git_namespace_created" BOOLEAN NOT NULL DEFAULT false;

-- When the Gitlab push poll last read a repo, so it rotates through all of them.
ALTER TABLE "git_repos" ADD COLUMN "push_polled_at" TIMESTAMP(3);
