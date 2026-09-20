-- One numeric score per grader per submission.
--
-- Before the score field, the badge picker let a grader stack several
-- `score-N` badges on one submission, which the gradebook then averaged.
-- Keep each grader's newest score on each submission and drop the rest,
-- recording what was dropped in the coursework ledger.

CREATE TEMP TABLE stale_scores ON COMMIT DROP AS
SELECT ag.id,
       ag.git_repo_assignment_id,
       ag.grader_id,
       ag.emoji,
       ag.created_at,
       gr.classroom_id
FROM assignment_grades ag
JOIN git_repo_assignments gra ON gra.id = ag.git_repo_assignment_id
JOIN git_repos gr ON gr.id = gra.git_repo_id
WHERE ag.emoji ~ '^score-[0-9]{1,3}$'
  AND ag.grader_id IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM assignment_grades newer
    WHERE newer.git_repo_assignment_id = ag.git_repo_assignment_id
      AND newer.grader_id = ag.grader_id
      AND newer.emoji ~ '^score-[0-9]{1,3}$'
      AND (newer.created_at > ag.created_at
           OR (newer.created_at = ag.created_at AND newer.id > ag.id))
  );

INSERT INTO coursework_migration_report (id, kind, classroom_id, subject_id, details)
SELECT gen_random_uuid()::text,
       'stale_numeric_score_dropped',
       classroom_id,
       git_repo_assignment_id,
       jsonb_build_object(
         'grade_id', id,
         'grader_id', grader_id,
         'emoji', emoji,
         'created_at', created_at
       )
FROM stale_scores;

DELETE FROM assignment_grades WHERE id IN (SELECT id FROM stale_scores);
