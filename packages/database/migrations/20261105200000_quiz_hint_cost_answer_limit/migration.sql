-- A quiz's hint cost (points off each answer given after a hint) and its answer
-- limit per question. Existing quizzes keep today's numbers: 15 and 5.
ALTER TABLE "quizzes" ADD COLUMN     "hint_cost" INTEGER NOT NULL DEFAULT 15,
ADD COLUMN     "max_answers" INTEGER NOT NULL DEFAULT 5;
