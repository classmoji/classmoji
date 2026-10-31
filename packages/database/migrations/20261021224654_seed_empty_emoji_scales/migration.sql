-- Every classroom has a real, editable grading scale (E10).
--
-- A classroom with no emoji_mappings rows gets exactly the rows a new
-- classroom gets from `emojiMapping.ensureDefaultScale`: SCORE_EMOJI_MAPPINGS
-- in @classmoji/utils (emojis.ts), the 0–100 number scale in tens, each
-- `score-N` worth N with no extra tokens and the description "N / 100". The
-- values below are copied from that constant; keep them in step with it.
--
-- Idempotent: a classroom with any row at all is left exactly as it is, and
-- re-running inserts nothing (NOT EXISTS, then ON CONFLICT on the
-- (classroom_id, emoji) unique key). `id` has no database default (Prisma
-- makes the uuid client-side), so it is generated here.
--
-- (The `_page_slug_repairs` log table from 20260821003300 is not in the Prisma
-- schema on purpose; the DROP that `migrate dev` generated for it is removed.)

INSERT INTO "emoji_mappings" ("id", "classroom_id", "emoji", "grade", "extra_tokens", "description", "created_at", "updated_at")
SELECT gen_random_uuid()::text, c."id", s."emoji", s."grade", 0, s."description", NOW(), NOW()
FROM "classrooms" c
CROSS JOIN (
  VALUES
    ('score-100', 100, '100 / 100'),
    ('score-90', 90, '90 / 100'),
    ('score-80', 80, '80 / 100'),
    ('score-70', 70, '70 / 100'),
    ('score-60', 60, '60 / 100'),
    ('score-50', 50, '50 / 100'),
    ('score-40', 40, '40 / 100'),
    ('score-30', 30, '30 / 100'),
    ('score-20', 20, '20 / 100'),
    ('score-10', 10, '10 / 100'),
    ('score-0', 0, '0 / 100')
) AS s("emoji", "grade", "description")
WHERE NOT EXISTS (
  SELECT 1 FROM "emoji_mappings" e WHERE e."classroom_id" = c."id"
)
ON CONFLICT ("classroom_id", "emoji") DO NOTHING;
