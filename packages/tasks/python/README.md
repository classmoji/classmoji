# Team-set solver (Python engine)

`team_set_solver.py` solves one compiled team-set problem (`TeamSetProblem`, built by
`packages/services/src/classmoji/teamSetProblem.ts`) with OR-Tools CP-SAT. The Trigger task
`team-set-solve` runs it through `@trigger.dev/python`. In a deployed image the build extension
installs `requirements.txt`. Locally, the task uses the venv described below.

## Local venv

Python 3.11 matches the deployed image (Debian bookworm's `python3`, 3.11.2).

```bash
python3.11 -m venv packages/tasks/python/.venv
packages/tasks/python/.venv/bin/pip install -r packages/tasks/python/requirements.txt
packages/tasks/python/.venv/bin/python packages/tasks/python/team_set_solver.py --selftest
```

`.venv/` is git-ignored.

`requirements.txt` pins OR-Tools and every package it pulls in, exactly as `pip freeze` resolved
them. All of them install as binary wheels on the Trigger image (linux/amd64, Python 3.11). To move
OR-Tools, install the new version in the venv, replace the pins with its `pip freeze` (OR-Tools and
its dependencies only), rerun `--selftest` and the cross-check test
(`TEAM_SET_CROSSCHECK=required npm run test --prefix packages/tasks`), and update
`TEAM_SET_ENGINE` in `teamSet.service.ts`.

## CLI

```bash
python team_set_solver.py <problem.json> [--workers N]   # N defaults to 2
python team_set_solver.py --selftest
```

The script writes JSON lines to stdout:

- Zero or more `{"type":"progress","objective":…,"bound":…,"elapsed":…}` lines, at most one every 0.5 s.
- Exactly one final `{"type":"result",…}` line with these fields:
  - `status` is one of `OPTIMAL`, `FEASIBLE`, `INFEASIBLE`, `UNKNOWN` or `MODEL_INVALID`.
  - `teams` (`[{"slot":s,"members":[p,…]}]`) lists non-empty slots only.
  - `objective` and `bound` are integers, or null when there is no solution.
  - `wall_s` includes model building.
  - `core` is filled only when the status is `INFEASIBLE`.
  - `core_status` says how far the infeasibility explanation got:
    - `complete`: the core is proven minimal. An **empty** core with `complete` means the structure
      itself cannot fit: sizes, slot count or `team_count`.
    - `timeout`: extraction ran out of time. `core` holds what was found, which may be empty or not
      minimal. An empty core with `timeout` says nothing about the structure.
    - `n/a`: the status is not `INFEASIBLE`.
  - `engine` is `cpsat@<OR-Tools version>`, for the run row.
  - `stats` is `{people, slots, pairs, build_s}`: pair-cost entries after merging, and the seconds
    spent building the main model (both stages' models for a two-stage solve). `people`, `slots` and
    `pairs` always describe the whole problem.
  - `message` appears only with `MODEL_INVALID`. It says why and names IR entries by index.
  - `stages` appears only when the problem has a `group` (see [Two-stage solve](#two-stage-solve-group)):
    `{"first":{"status","objective","bound"},"second":{"status","objective"}|null}`. `second` is
    `null` when stage 2 never ran. When the result has an `objective`, it equals
    `first.objective + second.objective`. The TypeScript type is `TeamSetSolveStages`
    (`teamSetProblem.ts`). A problem without a `group`, version 1 or 2, prints no `stages` key, so
    its line is exactly what it was before version 2.

Exit codes:

- `0` for every solver outcome, including `INFEASIBLE` and `MODEL_INVALID`.
- `2` for malformed input, with a `{"type":"error","code":"bad_input","message":…}` line. An integer
  beyond ±(2^53 − 1) anywhere in the IR counts as malformed.
- `1` for an unexpected engine crash, with a `{"type":"error","code":"engine_error"}` line; the traceback goes to stderr.

What gets printed matters for privacy. On a non-zero exit, `python.runScript` puts stdout and
stderr into the error it throws, and its trace span records that error in the Trigger dashboard.
So the script never prints a user id, a name or an answer. It prints integers, person and slot
indices, and `src` strings: rule ids `<field id>:<job>`, optionally with person indices
(`<rule>@<p>`, `<rule>@<p>+<q>`) or an option (`<rule>#<option id>`, the owner rule at Must),
`pin:<id>`, `option:<id>`, `size:<option id>` and
`non_respondents`. Every src is opaque to the engine; `p` and `q` are indices into `people`, never
ids. It counts the `people` array and never reads it.

## Problem versions

`version` is `1` or `2` (anything else, including `true`, is `bad_input`). Version 2 adds three
fields; a version-1 problem that carries any of them is `bad_input`, so an engine can never ignore
them:

- `options[i].size: {min, max}` (`min ≥ 1`, `max ≥ min`): this option's own team size, present
  only when it differs from the set's. See [Team sizes per option](#team-sizes-per-option).
- `group: {src, members, option_cost, larger, smaller}`: people who didn't answer, seated in a
  second solve with their own size caps. See [Two-stage solve](#two-stage-solve-group).
- `size.smaller` above 0: teams one under their min. See
  [Remainder flex](#remainder-flex-sizelarger-sizesmaller-grouplarger-groupsmaller).

A version-2 problem without them solves exactly as version 1 does.

The hard kind `owner_if_open` is accepted in both versions. An engine that predates it answers
`bad_input` ("hard[i].kind is not a known kind"), so it fails closed without a version bump.

## Hard kind `owner_if_open`

```json
{ "kind": "owner_if_open", "src": "<field id>:owner#<option id>", "o": 3, "members": [4, 17] }
```

If option `o` is open in the solution (any slot of `o` has a member), at least one person in
`members` is placed on option `o` (on any of its slots, not necessarily every team). `members` are
the person indices who pitched `o`; an empty list means `o` may not open at all. The constraint
takes part in the infeasibility core like every other hard entry: its `src` gets one assumption
literal. In the model it is one clause per slot `s` of `o`: `open[s] → OR(x[p][s'] for p in
members, s' in slots of o)`.

## Team sizes per option

A team on an option with its own `size` uses those bounds; every other team uses the set's `size`.

## Remainder flex (`size.larger`, `size.smaller`, `group.larger`, `group.smaller`)

When the sizes don't fit a population's count, the compiler (`teamSetFlex.ts`, `minimalFlex`) allows
the fewest teams one person off their size: `larger` teams of their max + 1, or `smaller` teams of
their min − 1, whichever changes fewer teams (ties to larger; the compiler sets at most one of the
two). A team never shrinks below 2, so only a slot whose own min − 1 ≥ 2 may be one of the smaller.
This file only enforces the caps: `big[s]` (`size ≤ max·open + big`) and `small[s]` (`size ≥
min·open − small`, created only where the slot's tight min ≥ 3 and applied only to a bound ≥ 3, so
a relaxed core build never admits a team of 1), with `Σbig ≤ larger` and `Σsmall ≤ smaller`.
`size.*` are the caps of everyone, or of stage 1 when there is a `group`; stage 2 uses
`group.larger` / `group.smaller`, whatever stage 1 used. Absent caps are 0; `size.smaller > 0` needs
version 2. For example 27 people in pairs get `larger: 1` (12 pairs and a team of 3), 27 in teams of
4 get `smaller: 1` (6 of 4 and one of 3), and 26 in teams of 4 get `larger: 2` (a tie).

In the model every slot gets its option's **loose** bounds unconditionally: `min(own min, set
min)` to `max(own max, set max)`. Where the option's own bounds are narrower than that, they are
added under the src `size:<option id>`. The main solve enforces them unconditionally, as always,
so the answer is the same. When the problem is infeasible, core extraction can drop an option's
size and fall back to the loose bounds, so a core can name `size:<option id>`: for example
`fixtures/size-infeasible.json` ("teams on A are 3" with pairs elsewhere and 4 people) has core
`['size:A']`. An option whose own size matches the loose bounds, or that has no slots, gets no src.

The LP-strengthening inequality over pair indicators (`Σ partners of p on slot s ≤ K[s]·x[p][s]`)
uses each slot's own max: `K[s] = max[s] − 1 + (1 if larger > 0)` (a smaller team never has more
partners than its max allows). With the set-wide max it would cut
off real solutions whenever an option allows teams larger than the set's max
(`fixtures/sizes-over-max.json`: −600 with per-slot K, −200 with the set-wide K). The selftest
shows both.

## Two-stage solve (`group`)

```json
"group": { "src": "non_respondents", "members": [5, 6], "option_cost": [0, 1, 2, null], "larger": 0, "smaller": 0 }
```

`members` are person indices (G); everyone else is R. `option_cost[o]` (index-aligned with
`options`, integers ≥ 0) is added once per member placed on `o`; `null` means members may not go on
`o`. Compile (`compileProblem`) orders the options by demand — the options someone ranked first,
most wanted first, then every other option in option order, as the last choice — and gives `null`
only to an option that can't open (closed, or an `owner_if_open` option none of whose pitchers can
be on it). The engine runs two CP-SAT solves in one process and never revisits a stage-1 placement.

Before either stage: a `require_pair` with one person in G and one in R can never hold, so the
result is `INFEASIBLE` with core `[its src, group.src]` (`complete`) and no solve runs. Compile
never emits one; it places such people in R.

**Reservation.** Let the eligible options be those with a non-null `option_cost`, less the
owner-only ones: an `owner_if_open` on the option names nobody in G, and stage 1 doesn't surely open
it (it isn't forced open, and no `require_place` puts someone outside G on it), so it opens in stage
2 only if stage 1 happened to open it (see Stage 2). Let `gmax` be the largest max and `gmin` the
smallest min of their sizes (own size, else the set's), and L / S the group's own caps
(`group.larger`, `group.smaller`). Then:

```
k2_min = max(ceil(|G| / (gmax + 1)), ceil((|G| − L) / gmax))      k2_max = floor((|G| + S) / gmin)
                                                (both 0 if G is empty or no option is eligible)
stage-1 teams ∈ [max(0, team_count.min − k2_max), team_count.max − k2_min]
```

k2_min is the fewest teams that hold G with L of them one over; k2_max is wide on purpose (it only
loosens the reservation). With L = S = 0 this is `ceil(|G| / gmax)` and `floor(|G| / gmin)`.
`compileProblem` (`groupTeamCounts`, `ownerOnlyOptions`) and the TypeScript cross-check use the same formula. With R non-empty,
`max(1, …)` as the lower bound is equivalent (any stage-1 solution has at least one team);
`max(0, …)` also covers an empty R. The reservation is enforced under `group.src`
(stage 1's unconditional range is `0 … team_count.max`), so when the reservation is what makes stage
1 infeasible, the core names `non_respondents` instead of coming back empty
(`fixture_group_reserve` in the selftest). Compile sets `team_count.max` to at most the number of
slots of options that can open, so the reservation binds when those are few, and when the set has an
exact team count (`fixtures/group-exact-count.json`).

**Stage 1** solves R alone on every slot with the problem's own terms and worst-off weight. Pairs,
counts and balance entries are restricted to R (exact: no team mixes the stages, so a split pair
never shares a team and a count on a team only sees that team's stage). `owner_if_open` keeps its
members in R, so a stage-1 option can only open with a pitcher from R. Stage 1 gets the time limit
minus `max(1 s, 10%)`, and at least half of it. Progress lines are stage 1's. If stage 1 is not
`OPTIMAL`/`FEASIBLE`, that is the result: its status, its core (srcs of the whole problem, plus
`non_respondents` for the reservation) and `stages.second = null`.

**Stage 2** seats G only, only on slots stage 1 left empty whose option has a non-null
`option_cost`, minimising each member's own place cost plus `option_cost`, plus pairs, counts and
balance among G. Forced-open options become `auto` (stage 1 opened them). `team_count` becomes
`[max(0, min − used), max − used]`. The size caps become the group's own (`group.larger`,
`group.smaller`), whatever stage 1 used. There is no worst-off term. An `owner_if_open` whose
option already has one of its members from stage 1 is dropped; otherwise it keeps its members in G, which means the option
cannot open in stage 2 if G has none of them. Stage 2 gets the time left, and at least 1 s.

**Result.** `teams` holds both stages' teams. `objective` is the sum of the two stage objectives.
`bound` is stage 1's bound plus stage 2's objective when stage 2 is `OPTIMAL`, and null otherwise.
The status is `OPTIMAL` only when both stages are, else `FEASIBLE`. If stage 2 is `INFEASIBLE`, the
result is `INFEASIBLE`, with no teams, core `[group.src]` and core_status `complete`. If stage 2 finds
nothing in time (`UNKNOWN`), the result is `UNKNOWN`, not `INFEASIBLE`, because nothing was proven.
The service maps that to `no_solution_in_time`.

Scoring a group problem (what `teamSetScore.ts` must match): the worst-off term is the max over R
only (0 when R is empty), and each member of G adds the `option_cost` of the option they are on. A
team that mixes G and R, or a member of G on an option with a null `option_cost`, breaks the
`group.src`. Split per stage (the selftest's `score_parts`): each open team's own terms (place, pairs
inside it, counts, balance) go to its stage, the worst-off term to stage 1, `option_cost` to stage 2;
those are `stages.first.objective` and `stages.second.objective`.

Stage 1 can use up the options G could go on even when a single solve would fit everyone
(`fixtures/pairs-60x30-group.json`: respondents take 28 of 30 one-slot options, and one of the two
left has a null `option_cost`). The engine reports this as stage 2 `INFEASIBLE`. When stage 1 has
several optimal answers, which one CP-SAT returns can decide whether stage 2 fits. The same goes for
two narrower cases. The group's caps (`group.larger`, `group.smaller`) are the fewest teams off their
size over the slots G can take as far as compile can tell (`groupSlotIndices`: the slots of options
with an `option_cost` that can open, less one slot of each option stage 1 surely opens — forced open,
or a `require_place` — and less every slot of an owner-only option), so the slots stage 1 actually
leaves can need a different flex than the caps allow. An owner-only option keeps its `option_cost`:
when stage 1 does open it, stage 2 may take a slot it left there. The service's
stage-2 sentence says what holds in every case: G can't be seated within the size and count limits
on the options that can still take a team.

## What the engine guarantees

- **The objective matches `scoreAssignment` exactly.** For the teams it returns, `objective` equals
  `scoreAssignment(problem, teams).objective` in `teamSetScore.ts`, even for a `FEASIBLE`
  (timed-out) answer. Every indicator in the model is fully reified to make this hold.
  `--selftest` checks it on first-found solutions as well as optimal ones, and for two-stage
  answers also checks each stage's objective against the per-stage split.
- **Balance is `weight × |Σ c_m|` per open team.** Each `balance[].values` entry is the person's
  c_p in [−100, 100]: the answer centred on the mean and scaled by the field's range. The term
  has no N factor. An empty slot adds 0.
- **Magnitudes are checked before building.** A balance value outside [−100, 100] returns
  `MODEL_INVALID` with a `message`. So does a problem whose objective could exceed 2^53, the range
  where the TypeScript rescoring stays exact. Neither case overflows inside CP-SAT.
- **Infeasibility names the colliding sources.** The main solve treats hard constraints as
  unconditional. If it proves `INFEASIBLE`, the engine re-solves on one worker with one
  assumption literal per distinct `src`. Every `hard[].src` gets one, and so do `option:<id>`
  for each option with `open: 'open'`, `size:<id>` for each option whose own size is narrower
  than its loose bounds, and, in stage 1 of a two-stage solve, `group.src` for the team-count
  reservation. The engine then shrinks the core by deletion, so removing any single src from it
  makes the problem feasible (`core_status: complete`). If time runs out first, `core_status` is
  `timeout`.
- **Symmetry breaking.** Slots of the same option are interchangeable. Open slots come first, and
  slots are ordered by their lowest member index. This keeps free mode and `teams_per_option > 1` fast.
- **Two-phase search.** With 2 workers, CP-SAT runs exactly one full-problem worker. Below
  20,000 people×slots, the engine runs the default LP worker for 20% of the time limit (at least
  2 s). If that doesn't prove optimality, it runs the `max_lp` worker (linearization level 2) from
  scratch for the rest of the time and keeps the better answer. At 20,000 or more it uses `max_lp`
  alone. The measurements behind these choices are in the comment above `MAX_LP_ONLY_CELLS`.

## Selftest

`--selftest` prints one line, `{"type":"selftest","ok":…,"failures":…, <counts>, "wall_s":…}`, and
exits 1 on any failure (each one on stderr as `FAIL …`). It runs:

- the hand-built `fixture_*` problems against brute force or hand-computed results, including
  first-found solutions;
- 300 random version-1 problems (the same seeded stream as before version 2) and 300 random
  version-2 problems (own sizes, `size.smaller`, `owner_if_open`) against brute force: optimum,
  rescored objective, and for infeasible ones a core that is sufficient and minimal;
- smaller teams (`fixture_smaller`: 7 in teams of 4 → 4 + 3, never a team of 1 in pairs) and each
  stage's own team of 3 (`fixture_group_larger` solves; without the group's cap it doesn't);
- every fixture file in the table below except `free-60-balance.json` against its expected result
  (the version-1 files give what they gave before version 2);
- `bad_input` for malformed version-2 fields;
- per-slot K: `sizes-over-max` reaches −600, and the set-wide K (`SELFTEST_GLOBAL_K`) only −200;
- the two-stage cases (hand-built and 300 random): stage 1 against brute force on the problem
  without the group (`stage1_problem`, written apart from the engine's `_stage_raw`), stage 2
  against brute force over the slots the engine's own stage 1 left empty, the stage-1 teams kept as
  they were, and the per-stage split of the objective.

## Fixtures (`fixtures/`, synthetic only)

Expected results are with `--workers 2`. The version-2 files mirror the selftest's `fixture_*`
functions; the two `-group` files are `pairs-27x20`/`pairs-60x30` with the people without place
entries (plus a few whose entries were dropped) as the group, the spread count removed and
`option_cost` ranked by (#1st, #top 3, #ranked) over the rest, `null` for an option nobody ranked
(a group kept off options that can open, which compile never emits: it gives `null` only to an
option that can't open).

| file                        | what                                                                                 | expected                                                                                                                                                 |
| --------------------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pairs-small.json`          | 7 people, 4 topics, pairs + one trio, ranks, requests, apart pin, worst-off          | OPTIMAL 94                                                                                                                                               |
| `free-small.json`           | free mode, 8 people in 4 slots of 2–3, no-one-alone, balance                         | OPTIMAL 750                                                                                                                                              |
| `balance-small.json`        | 4 people into 2 pairs, balance only, c = [100, −100, 50, −50], weight 3              | OPTIMAL 0 ({0,1} and {2,3})                                                                                                                              |
| `infeasible-must-pair.json` | must-together vs apart pin on the same pair                                          | INFEASIBLE, core `f1:together`, `pin:p1`, `complete`                                                                                                     |
| `capacity-structural.json`  | 7 people into pairs with no larger team allowed                                      | INFEASIBLE, core `[]`, `complete`                                                                                                                        |
| `pairs-27x20.json`          | 27 people, 20 options, pairs (default rank/fairness weights)                         | OPTIMAL 10200, < 1 s                                                                                                                                     |
| `pairs-60x30.json`          | 60 people, 30 options, pairs                                                         | OPTIMAL 13322, < 1 s                                                                                                                                     |
| `free-60-teams-of-4.json`   | free mode, 60 people in teams of 4, together/apart                                   | OPTIMAL −11668, < 1 s                                                                                                                                    |
| `free-60-balance.json`      | same people with a balance field (answers 1–5, c_p centred) and a no-one-alone group | FEASIBLE at the 10 s limit (−9632, bound −12216 on an M-series laptop). 8 workers for 120 s reach −9784 with bound −10087, so the optimum is not proven. |
| `sizes-over-max.json`       | v2: pairs, but option A takes 2–4; four people who all want each other               | OPTIMAL −600 (a team of 4 on A)                                                                                                                          |
| `size-infeasible.json`      | v2: pairs, option A's own size 3, 4 people                                           | INFEASIBLE, core `size:A`, `complete`                                                                                                                    |
| `owner-if-open.json`        | v2: X pitched only by a person pinned to Y                                           | OPTIMAL 110 (X closed; 30 without the rule)                                                                                                              |
| `owner-if-open-infeasible.json` | v2: the same with X forced open                                                  | INFEASIBLE, core `f7:owner`, `pin:p1`, `option:X`, `complete`                                                                                            |
| `group-small.json`          | v2 group: 5 respondents, 2 in the group, one option with a null cost, teams of 2–3   | OPTIMAL 17, stages 10 + 7                                                                                                                                |
| `group-exact-count.json`    | v2 group: exactly 2 teams, so the 4 respondents share one                            | OPTIMAL 102, stages 100 + 2                                                                                                                              |
| `group-no-room.json`        | v2 group: the only empty slot is on an option with a null `option_cost`              | INFEASIBLE, core `non_respondents`, stages 0 + INFEASIBLE                                                                                                |
| `pairs-27x20-group.json`    | v2 group: `pairs-27x20` with 3 people in the group (the group's own team of 3)       | OPTIMAL 10483, stages 10468 + 15, < 1 s. Stage 2's 15 was the same over 12 seeds but depends on which optimal stage 1 CP-SAT returns, so the selftest pins stage 1 only. |
| `pairs-60x30-group.json`    | v2 group: `pairs-60x30` with 4 people in the group                                   | INFEASIBLE, core `non_respondents`, stages 13192 + INFEASIBLE: one option with an `option_cost` is left for two pairs. Every optimal stage 1 leaves it this way, because stage 1 with the null-cost option forced open is proven worse (32414). |
