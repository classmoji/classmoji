> **Status:** Planned, not started. Saved 2026-06-20 for later implementation.
> Open question intentionally left undecided: the "issue philosophy" (whether grading should ever skip creating a GitHub issue). This plan keeps the existing always-create-the-issue behavior; "just grade the repo" is handled by using a single assignment.

# Modular grading: emoji or numeric (per classroom)

## Context

Today grading is emoji-only at the UI level, but the system is already **numeric underneath**: every emoji maps to a `Float` grade via `EmojiMapping`, and the whole engine (weighting, drop-lowest, late penalty, letter grades) works on numbers in `packages/utils/src/grades.ts`. Quizzes already store a numeric `partial_credit_percentage` and only *derive* an emoji for display.

So "add numeric grading" is **not** a rewrite. Emoji is an input + display skin over an existing numeric core. The real work is: a per-classroom mode toggle, a numeric input/storage path for manual grades, and conditional display at the render sites. **Effort: moderate but shallow and broad** (one migration, one small engine branch, and many small UI/type touch-ups).

### Decisions (confirmed with user)
- **Granularity:** per classroom (one setting). The whole classroom is emoji OR numeric.
- **Numeric meaning:** **free-form entry of any value.** The whole point is that an instructor types an arbitrary number (87, 91, 73), instead of being limited to the discrete presets the emoji mapping forces today (heart=100, +1=90, eyes=80, ...). The input is a plain number field, not another fixed picker. The grade is "points out of a max" with `max_points` defaulting to 100, so by default typing 87 just means 87%; set the max to 20 and you get "18/20". One design, both behaviors.
- **Scope:** both manual grading and quiz display. Quiz side is cheap (number already exists, just swap the emoji for the %). Manual side is the heavy part.
- **Approach:** a simple `grading_mode` flag, encapsulated in small input/display components that branch internally. No plugin SDK, no strategy registry (only ever emoji-or-numeric).
- **Repo-level grading:** a grade always anchors to a `GitRepoAssignment` (one per assignment, created as a GitHub issue on publish). "Just grade the repo" needs no new feature: it is simply a repo with a single assignment, graded with one value (the average of one item is that value). We keep always creating the issue as the grade anchor; there is no separate no-issue path.

### Key principle
`grading_mode` is **UI-only**. Each `AssignmentGrade` row is self-describing (carries `emoji` XOR `numeric_grade`), and the engine converts per-row to 0-100 before weighting. So the engine never branches on classroom mode, mixed old/new data always computes, and classrooms can flip modes freely.

## 1. Schema + migration (`packages/database/schema.prisma`)

Add:
- `enum GradingMode { EMOJI NUMERIC }`
- `ClassroomSettings.grading_mode GradingMode @default(EMOJI)` (preserves current behavior for all existing classrooms)
- `Assignment.max_points Float? @default(100)`
- `AssignmentGrade.numeric_grade Float?` and make `AssignmentGrade.emoji` optional (`String?`), a row is emoji XOR numeric

Workflow: edit schema, run `npm run db:generate`, then hand-write `packages/database/migrations/<timestamp>_add_numeric_grading/migration.sql` (CREATE TYPE, three ADD COLUMN, one `ALTER COLUMN "emoji" DROP NOT NULL`, plus an optional CHECK constraint `("emoji" IS NOT NULL) <> ("numeric_grade" IS NOT NULL)`, the repo already uses CHECK migrations). Apply with `npm run db:deploy`. Never `db push`. **Use the DATABASE_URL from `.dev-context`.**

Regenerating the client will surface every `emoji: string` type break as a compiler error. That error list is the worklist for null-guards.

## 2. Grade engine (`packages/utils/src/grades.ts`)

- Widen `GradeEntry` to `{ emoji?: string | null; numeric_grade?: number | null }` and add `max_points?: number | null` to the `assignment` shape on `GitRepoAssignment`.
- Add a row converter: numeric rows return `(numeric_grade / (max_points || 100)) * 100`; emoji rows use the existing `convertEmojiToNumber`.
- Add `calculateGradeEntries(entries, emojiMap, maxPoints)` (a new function rather than changing `calculateNumericGrade`'s signature, to avoid rippling into the 2-3 direct callers). Have `calculateRepositoryGrade` and `getDroppedRepositoryAssignments` use it in their per-row loops.
- **No change** to drop-lowest, late penalty, `should_be_zero`, extra-credit, or letter-grade logic. They all operate on the resolved 0-100 number.
- Extend the existing `packages/utils` grade tests with numeric + mixed-mode cases.

## 3. Manual grade input (the new path)

- **Component:** branch `apps/webapp/app/components/features/grading/EmojiGrader.tsx` on `grading_mode`. Keep the emoji popover for EMOJI; for NUMERIC render a **free-form numeric input** (an antd `InputNumber`, `min=0 max=max_points`, decimals allowed) where the instructor types any value like 87, with the max shown beside it (`/ 100`). It is a typed value, not a list of preset buttons. Take `grading_mode` + `max_points` as props. Pre-fill with the current grade so editing/overwriting works.
- **Render sites** (pass the new props): the admin repo table `admin.$class.repos_.$title/AssignmentTable.tsx`, TA grading `assistant.$class_.grading/RepositoryAssignmentsTable.tsx`, `admin.$class.students.$login/SingleStudentView.tsx`, and `components/shared/views/RegradeRequestsTable.tsx`.
- **API + service:** `apps/webapp/app/routes/api.gitRepoAssignment.$class/route.ts` (`addGrade`) routes numeric values to a new `setNumericGrade(repoAssignmentId, graderId, numeric_grade)` in `packages/services/src/classmoji/assignmentGrade.service.ts` that **replaces** any existing rows for the assignment in a transaction (numeric = single row, unlike emoji which is additive). The numeric path bypasses the emoji-keyed `doesGradeExist`. In `packages/services/src/helper/index.ts`, skip token logic on the numeric path (see Edge cases).

## 4. Display (assignment grades)

Centralize the per-row branch in the most-reused component, `apps/webapp/app/components/features/grading/EmojisDisplay.tsx`: render an emoji chip when the row has `emoji`, render the number (e.g. `18/20`) when it has `numeric_grade`. That covers most read surfaces.

A handful of sites render `<Emoji>` directly and need their own branch + widened types: `student.$class.assignments/AssignmentsTabsCard.tsx`, `student.$class.dashboard/RetroTabsCard.tsx`, and the admin gradebook cell logic in `admin.$class.grades/columns/assignmentColumns.tsx` (it already has an Emoji/Numeric `view` toggle in `GradesTable.tsx`, default/lock it to the classroom mode). Student-final columns (`studentGradeColumns.tsx`) and the repo summary/module tables consume the engine and need no UI change once the engine + loaders carry the new fields.

## 5. Quiz display (presentational only)

Thread `grading_mode` to the quiz components and show the percent instead of the emoji in NUMERIC mode: `components/ui/display/QuizEvaluation.tsx` (per-question grid, currently `gradeToEmoji(...)` then emoji), `components/features/quiz/ProgressDivider.tsx`, and the emoji it receives from `components/features/quiz/QuizMessageList.tsx`. Overall quiz score is already numeric. The server-side emoji derivation can stay (harmless extra field); the branch is purely in the view.

## 6. Loaders

Most grade loaders use full includes, so `numeric_grade` and `assignment.max_points` flow automatically (`gitRepo.service.ts`, `gitRepoAssignment.service.ts`, `regradeRequest.service.ts`, `gitRepoAssignmentGrader.service.ts`). Two explicit edits:
- `packages/services/src/classmoji/dashboard.service.ts` partial select, add `numeric_grade: true`.
- Any partial `assignment: { select: { weight } }` that the engine touches, add `max_points`.
- `admin.$class.grades/route.tsx` loader, also expose `grading_mode` to the gradebook so columns can lock the view.

## 7. Settings UI

In `admin.$class.settings.grades/GradingSettingsOptions.tsx` add a `grading_mode` select (Emoji / Numeric) to the form, the interface, and the submit payload. `action.ts` `saveGradingSettings` passes it through generically (validate it is a valid enum value first). The loader already returns full settings. Optionally hide the emoji-mapping panel in NUMERIC mode (it stays relevant for quizzes' emoji derivation, so this is cosmetic).

## Edge cases (decided)

- **Tokens:** `extra_tokens` are emoji-driven via `EmojiMapping`. **No token rewards in numeric mode** (simplest; tokens are an emoji affordance). Skip `assignTokensToStudent/Team` on the numeric add path; removal already no-ops when `token_transaction_id` is null.
- **Regrade snapshots:** `RegradeRequest.previous_grade` stays `String[]` but stores type-agnostic display strings (e.g. `"85"` / `"18/20"` in numeric mode). Update the write site and make `RegradeRequestsTable` render plain text when an entry is not a known emoji shortcode. No schema change.
- **Mode switching mid-semester:** safe by design. Old emoji grades keep rendering as emoji (per-row branch in `EmojisDisplay`), new ones come in numeric, the engine averages both correctly. Add a short note on the settings toggle saying existing grades remain valid.

## Open question (parked)

Whether grading should ever skip creating a GitHub issue ("grade-only" assignments). This was discussed and intentionally left for later. It is **orthogonal** to numeric grading and does not block it. If revisited, the shape would be: a per-assignment `creates_github_issue` flag (default true), nullable `GitRepoAssignment.provider_id` / `provider_issue_number`, and skipping the `gitProvider.createIssue()` call on publish. Two pure-UI niceties for the "I just grade repos" persona were also noted: auto-creating a default assignment when a repo has none, and rendering the grading UI as "grade the repo" when a repo has exactly one assignment.

## Sequencing

1. Schema + migration + `db:generate` (surfaces the type-break worklist).
2. Engine (`grades.ts`) + tests (pure, isolated).
3. Service/API (`setNumericGrade`, token bypass, null-guards flagged by the compiler).
4. Loaders (mostly auto; one explicit select).
5. UI input, display, quiz, settings.

## Verification

- **Engine:** `npm run test` for `packages/utils` with new numeric + mixed-mode cases (max=100 acts as percentage; max=20 gives 18/20 -> 90%; drop-lowest and late penalty still apply).
- **Migration:** apply against the local DB (DATABASE_URL from `.dev-context`), confirm existing classrooms read `grading_mode = EMOJI` and `max_points = 100`.
- **End to end (Chrome tools, both light and dark mode):**
  - Set a classroom to NUMERIC in Settings -> Grading. Confirm the manual grader shows a numeric input, grading an assignment persists a single `numeric_grade` row, and the gradebook + student views show numbers.
  - Confirm a quiz attempt shows percentages instead of emojis.
  - Flip back to EMOJI and confirm prior numeric grades still display correctly alongside emoji grades (mixed data).
  - File a regrade request in numeric mode and confirm the previous-grade snapshot renders as text.
- Run `npm run web:build` to catch any remaining `emoji: string` type breaks.
