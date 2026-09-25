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
    spent building the main model.
  - `message` appears only with `MODEL_INVALID`. It says why and names IR entries by index.

Exit codes:

- `0` for every solver outcome, including `INFEASIBLE` and `MODEL_INVALID`.
- `2` for malformed input, with a `{"type":"error","code":"bad_input","message":…}` line. An integer
  beyond ±(2^53 − 1) anywhere in the IR counts as malformed.
- `1` for an unexpected engine crash, with a `{"type":"error","code":"engine_error"}` line; the traceback goes to stderr.

What gets printed matters for privacy. On a non-zero exit, `python.runScript` puts stdout and
stderr into the error it throws, and its trace span records that error in the Trigger dashboard.
So the script never prints a user id, a name or an answer. It prints integers, person and slot
indices, and `src` strings (rule ids, `pin:<id>`, `option:<id>`). It counts the `people` array and
never reads it.

## What the engine guarantees

- **The objective matches `scoreAssignment` exactly.** For the teams it returns, `objective` equals
  `scoreAssignment(problem, teams).objective` in `teamSetScore.ts`, even for a `FEASIBLE`
  (timed-out) answer. Every indicator in the model is fully reified to make this hold.
  `--selftest` checks it on first-found solutions as well as optimal ones.
- **Balance is `weight × |Σ c_m|` per open team.** Each `balance[].values` entry is the person's
  c_p in [−100, 100]: the answer centred on the mean and scaled by the field's range. The term
  has no N factor. An empty slot adds 0.
- **Magnitudes are checked before building.** A balance value outside [−100, 100] returns
  `MODEL_INVALID` with a `message`. So does a problem whose objective could exceed 2^53, the range
  where the TypeScript rescoring stays exact. Neither case overflows inside CP-SAT.
- **Infeasibility names the colliding sources.** The main solve treats hard constraints as
  unconditional. If it proves `INFEASIBLE`, the engine re-solves on one worker with one
  assumption literal per distinct `src`. Every `hard[].src` gets one, and so does `option:<id>`
  for each option with `open: 'open'`. The engine then shrinks the core by deletion, so
  removing any single src from it makes the problem feasible (`core_status: complete`). If time
  runs out first, `core_status` is `timeout`.
- **Symmetry breaking.** Slots of the same option are interchangeable. Open slots come first, and
  slots are ordered by their lowest member index. This keeps free mode and `teams_per_option > 1` fast.
- **Two-phase search.** With 2 workers, CP-SAT runs exactly one full-problem worker. Below
  20,000 people×slots, the engine runs the default LP worker for 20% of the time limit (at least
  2 s). If that doesn't prove optimality, it runs the `max_lp` worker (linearization level 2) from
  scratch for the rest of the time and keeps the better answer. At 20,000 or more it uses `max_lp`
  alone. The measurements behind these choices are in the comment above `MAX_LP_ONLY_CELLS`.

## Fixtures (`fixtures/`, synthetic only)

Expected results are with `--workers 2`.

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
