#!/usr/bin/env python3
"""Team-set engine: solves one TeamSetProblem (see packages/services/src/classmoji/teamSetProblem.ts)
with OR-Tools CP-SAT and prints one JSON result line.

WHY this shape:
- The problem IR is ids-free integers only, compiled in TypeScript. This file knows nothing about forms,
  rules or names; it only understands slots, people, costs and hard constraints tagged with a `src`.
- The objective MUST equal the TypeScript `scoreAssignment` of the returned teams, bit for bit, or the
  run fails with `score_mismatch`. So every indicator in the model is FULLY reified (never the cheaper
  half-reification that is only tight at optimum): a timed-out FEASIBLE answer is scored exactly too.
  `score()` below is an independent re-implementation of that formula, used by --selftest only.
- Hard constraints carry a `src` (rule id or pin id). The main solve adds them unconditionally so
  presolve and parallel workers get full strength. Only when that solve proves INFEASIBLE do we rebuild
  the model with one assumption literal per distinct src, solve single-worker (CP-SAT computes cores
  only without parallelism), and shrink the returned core by deletion so it names the srcs that collide.
  An empty core with INFEASIBLE means the structure itself (sizes, slot count, team_count) can't fit.
  Options with open='open' are forced open under src `option:<id>` (the src the compiler already uses
  for a closed option's forbid_place), so a forced-open option can show up in a core too.
- Slots of the same option are interchangeable, so we break that symmetry (open slots first, then
  slots ordered by their lowest person index). Without it, free mode and teams_per_option > 1 explore
  k! copies of every solution.
- The search runs in up to two phases with different LP workers; see MAX_LP_ONLY_CELLS for why.
- Balance: each person carries c_p in [-100, 100] (the compiler centres and scales the answer); the
  term is weight * |sum of c_m over the team| per OPEN team. No N factor, no mean: it is already an
  exact integer, and it is 0 for an empty slot, so it needs no open-gating.
- Coefficient magnitudes are checked before the model is built (`magnitude_problem`). A balance
  value outside [-100, 100], or a problem whose objective could leave the exact-integer range the
  TypeScript scorer works in (2**53), is answered with status MODEL_INVALID and a `message` naming
  the offending entry by index, instead of an overflow deep inside CP-SAT.

What this process prints, and why that matters for privacy: `python.runScript` in @trigger.dev/python
puts stdout AND stderr into its thrown error on a non-zero exit, and its trace span records that
error, so both streams can land in the Trigger dashboard whatever the task does with the error. This
file therefore never prints a user id, a name or an answer: stdout carries only integers, person and
slot indices, and `src` strings (rule ids `<field id>:<job>`, pin ids `pin:<id>`, `option:<option id>`);
`message` and error lines name entries by index; stderr carries tracebacks of this code and CP-SAT's
own diagnostics, which speak of variable and constraint indices. The `people` array (user ids) is only
ever counted, never read.

CLI:  python team_set_solver.py <problem.json> [--workers N]
      python team_set_solver.py --selftest
stdout: optional {"type":"progress",...} lines, then exactly one {"type":"result",...} line:
  status, teams, objective, bound, wall_s, core,
  core_status  'complete' (INFEASIBLE and the core is proven minimal; an empty core then means the
               structure itself cannot fit) | 'timeout' (INFEASIBLE but core extraction ran out of
               time: `core` is whatever sufficient set was found, possibly empty, possibly not minimal;
               an empty core here says nothing about structure) | 'n/a' (not INFEASIBLE),
  engine       'cpsat@<ortools version>',
  stats        {people, slots, pairs (pair-cost entries after merging), build_s (main model build)},
  message      only with MODEL_INVALID: why, naming entries by index.
Exit 0 for every solver outcome (INFEASIBLE and MODEL_INVALID included); 2 for malformed input
({"type":"error","code":"bad_input"}); 1 for an engine crash ({"type":"error","code":"engine_error"},
traceback on stderr).
"""

import argparse
import itertools
import json
import math
import random
import sys
import time
import traceback

import ortools
from ortools.sat.python import cp_model

T0 = time.monotonic()
ENGINE = f'cpsat@{ortools.__version__}'
STATUS_NAMES = {'OPTIMAL', 'FEASIBLE', 'INFEASIBLE', 'UNKNOWN', 'MODEL_INVALID'}
HARD_KINDS = {'forbid_place', 'require_place', 'forbid_pair', 'require_pair', 'team_count'}
PROGRESS_MIN_INTERVAL_S = 0.5
# Every integer in the IR comes from JavaScript, so anything beyond this is malformed input.
MAX_SAFE_INT = 2 ** 53 - 1
# Balance values are c_p = round(100 * (answer - mean) / range), so within this bound.
BALANCE_VALUE_MAX = 100
# The TypeScript scorer re-scores every answer in doubles; beyond 2**53 it can no longer be exact.
MAX_OBJECTIVE_MAGNITUDE = 2 ** 53 - 1


class BadInput(Exception):
    pass


def emit(obj):
    sys.stdout.write(json.dumps(obj, separators=(',', ':')) + '\n')
    sys.stdout.flush()


# --------------------------------------------------------------------------------------------------
# Input validation / normalization
# --------------------------------------------------------------------------------------------------

def _int(v, what, lo=None, hi=None):
    if not isinstance(v, int) or isinstance(v, bool):
        raise BadInput(f'{what} must be an integer')
    if abs(v) > MAX_SAFE_INT:
        raise BadInput(f'{what} is beyond the safe integer range')
    if lo is not None and v < lo:
        raise BadInput(f'{what} must be >= {lo}')
    if hi is not None and v > hi:
        raise BadInput(f'{what} must be <= {hi}')
    return v


def _obj(v, what):
    if not isinstance(v, dict):
        raise BadInput(f'{what} must be an object')
    return v


def _list(v, what):
    if not isinstance(v, list):
        raise BadInput(f'{what} must be an array')
    return v


def _src(v, what):
    if not isinstance(v, str) or not v:
        raise BadInput(f'{what}.src must be a non-empty string')
    return v


class Problem:
    """Validated, normalized view of the IR. Duplicate place/pair entries are summed; zeros dropped."""

    def __init__(self, raw):
        raw = _obj(raw, 'problem')
        if raw.get('version') != 1:
            raise BadInput('version must be 1')
        people = _list(raw.get('people'), 'people')
        self.n = N = len(people)
        options = _list(raw.get('options'), 'options')
        self.option_ids = []
        self.option_open = []
        for i, o in enumerate(options):
            _obj(o, f'options[{i}]')
            if not isinstance(o.get('id'), str):
                raise BadInput(f'options[{i}].id must be a string')
            if o.get('open') not in ('auto', 'open', 'closed'):
                raise BadInput(f'options[{i}].open must be auto|open|closed')
            self.option_ids.append(o['id'])
            self.option_open.append(o['open'])
        O = len(options)
        slots = _list(raw.get('slots'), 'slots')
        self.slot_opt = [_int(_obj(s, f'slots[{i}]').get('option'), f'slots[{i}].option', 0, O - 1)
                         for i, s in enumerate(slots)]
        self.n_slots = len(slots)
        self.slots_of = [[] for _ in range(O)]
        for s, o in enumerate(self.slot_opt):
            self.slots_of[o].append(s)

        size = _obj(raw.get('size'), 'size')
        self.size_min = _int(size.get('min'), 'size.min', 1)
        self.size_max = _int(size.get('max'), 'size.max', self.size_min)
        self.larger = _int(size.get('larger'), 'size.larger', 0)
        tc = _obj(raw.get('team_count'), 'team_count')
        self.tc_min = _int(tc.get('min'), 'team_count.min', 0)
        self.tc_max = _int(tc.get('max'), 'team_count.max', 0)

        self.cost = [dict() for _ in range(N)]  # p -> {o: summed cost}
        for i, e in enumerate(_list(raw.get('place'), 'place')):
            _obj(e, f'place[{i}]')
            p = _int(e.get('p'), f'place[{i}].p', 0, N - 1)
            o = _int(e.get('o'), f'place[{i}].o', 0, O - 1)
            c = _int(e.get('cost'), f'place[{i}].cost')
            self.cost[p][o] = self.cost[p].get(o, 0) + c
        for d in self.cost:
            for o in [o for o, c in d.items() if c == 0]:
                del d[o]

        pairs = {}
        for i, e in enumerate(_list(raw.get('pair'), 'pair')):
            _obj(e, f'pair[{i}]')
            p = _int(e.get('p'), f'pair[{i}].p', 0, N - 1)
            q = _int(e.get('q'), f'pair[{i}].q', 0, N - 1)
            if p == q:
                raise BadInput(f'pair[{i}] has p == q')
            k = (min(p, q), max(p, q))
            pairs[k] = pairs.get(k, 0) + _int(e.get('cost'), f'pair[{i}].cost')
        self.pairs = sorted((p, q, c) for (p, q), c in pairs.items() if c != 0)

        self.hard = []
        self.srcs = []  # distinct srcs in first-appearance order (stable core ordering)
        seen = set()

        def add_src(s):
            if s not in seen:
                seen.add(s)
                self.srcs.append(s)

        for i, h in enumerate(_list(raw.get('hard'), 'hard')):
            _obj(h, f'hard[{i}]')
            kind = h.get('kind')
            if kind not in HARD_KINDS:
                raise BadInput(f'hard[{i}].kind is not a known kind')
            src = _src(h.get('src'), f'hard[{i}]')
            if kind in ('forbid_place', 'require_place'):
                entry = (kind, src, _int(h.get('p'), f'hard[{i}].p', 0, N - 1),
                         _int(h.get('o'), f'hard[{i}].o', 0, O - 1))
            elif kind in ('forbid_pair', 'require_pair'):
                p = _int(h.get('p'), f'hard[{i}].p', 0, N - 1)
                q = _int(h.get('q'), f'hard[{i}].q', 0, N - 1)
                if p == q:
                    raise BadInput(f'hard[{i}] has p == q')
                entry = (kind, src, min(p, q), max(p, q))
            else:
                members = sorted({_int(m, f'hard[{i}].members[]', 0, N - 1)
                                  for m in _list(h.get('members'), f'hard[{i}].members')})
                not_one = h.get('not_one') is True
                mx = h.get('max')
                if mx is not None:
                    _int(mx, f'hard[{i}].max', 0)
                entry = (kind, src, members, not_one, mx)
            self.hard.append(entry)
            add_src(src)
        # 'open' options are forced open under the same src the compiler uses for 'closed' ones.
        self.forced_open = [o for o in range(O) if self.option_open[o] == 'open']
        for o in self.forced_open:
            add_src(self.open_src(o))

        self.soft = []
        for i, e in enumerate(_list(raw.get('soft_counts'), 'soft_counts')):
            _obj(e, f'soft_counts[{i}]')
            _src(e.get('src'), f'soft_counts[{i}]')
            members = sorted({_int(m, f'soft_counts[{i}].members[]', 0, N - 1)
                              for m in _list(e.get('members'), f'soft_counts[{i}].members')})
            mx = e.get('max')
            if mx is not None:
                _int(mx, f'soft_counts[{i}].max', 0)
            w = _int(e.get('weight'), f'soft_counts[{i}].weight')
            self.soft.append((members, e.get('not_one') is True, mx, w))

        self.balance = []
        for i, e in enumerate(_list(raw.get('balance'), 'balance')):
            _obj(e, f'balance[{i}]')
            _src(e.get('src'), f'balance[{i}]')
            vals = _list(e.get('values'), f'balance[{i}].values')
            if len(vals) != N:
                raise BadInput(f'balance[{i}].values must have one value per person')
            vals = [_int(v, f'balance[{i}].values[]') for v in vals]
            self.balance.append((vals, _int(e.get('weight'), f'balance[{i}].weight')))

        self.worst_off_weight = _int(raw.get('worst_off_weight'), 'worst_off_weight')
        tl = raw.get('time_limit_s')
        if not isinstance(tl, (int, float)) or isinstance(tl, bool) or not tl > 0:
            raise BadInput('time_limit_s must be a positive number')
        self.time_limit_s = float(tl)
        self.seed = _int(raw.get('seed'), 'seed')

    def open_src(self, o):
        return f'option:{self.option_ids[o]}'


def magnitude_problem(pb):
    """None when every coefficient is in range, else a message naming the entry by index.

    The bound is on the objective of ANY assignment: each person pays at most their largest |place|
    cost, a pair cost is paid at most once, a soft count at most once per slot, a balance entry at
    most weight * sum|c_p| (the teams partition the people), worst-off at most its weight times the
    largest per-person cost. Within 2**53 the TypeScript rescoring stays exact, and CP-SAT's own
    (looser) int64 overflow check has room to spare."""
    for i, (vals, _w) in enumerate(pb.balance):
        for j, v in enumerate(vals):
            if abs(v) > BALANCE_VALUE_MAX:
                return (f'balance[{i}].values[{j}] is {v}; balance values must be within '
                        f'[-{BALANCE_VALUE_MAX}, {BALANCE_VALUE_MAX}]')
    person_max = [max((abs(c) for c in d.values()), default=0) for d in pb.cost]
    bound = sum(person_max)
    bound += sum(abs(c) for _p, _q, c in pb.pairs)
    bound += pb.n_slots * sum(abs(w) for _m, _n, _x, w in pb.soft)
    bound += sum(abs(w) * sum(abs(v) for v in vals) for vals, w in pb.balance)
    bound += abs(pb.worst_off_weight) * max(person_max, default=0)
    if bound > MAX_OBJECTIVE_MAGNITUDE:
        return (f'the objective could reach {float(bound):.3g}, beyond the exact-integer limit '
                f'2**53; the costs or weights are too large')
    return None


# --------------------------------------------------------------------------------------------------
# Model
# --------------------------------------------------------------------------------------------------

class Built:
    pass


def build(pb, *, assume, with_objective):
    """assume=False: hard constraints are unconditional (main solve).
    assume=True: each distinct src gets one literal enforcing its constraints; returned in b.lits."""
    m = cp_model.CpModel()
    N, S = pb.n, pb.n_slots
    b = Built()
    b.model = m
    x = [[m.new_bool_var(f'x{p}_{s}') for s in range(S)] for p in range(N)]
    b.x = x
    for p in range(N):
        m.add_exactly_one(x[p])

    lits = {}
    if assume:
        for src in pb.srcs:
            lits[src] = m.new_bool_var(f'a:{src}')
    b.lits = lits

    def enf(ct, src, extra=()):
        conds = ([lits[src]] if assume else []) + list(extra)
        if conds:
            ct.only_enforce_if(conds)
        return ct

    # --- structure: sizes, open, larger, team_count ---------------------------------------------
    opn = [m.new_bool_var(f'open{s}') for s in range(S)]
    big = [m.new_bool_var(f'big{s}') for s in range(S)] if pb.larger > 0 else None
    for s in range(S):
        col = [x[p][s] for p in range(N)]
        size = cp_model.LinearExpr.sum(col)
        m.add(size >= pb.size_min * opn[s])
        if big:
            m.add(size <= pb.size_max * opn[s] + big[s])
            m.add_implication(big[s], opn[s])
        else:
            m.add(size <= pb.size_max * opn[s])
    if big:
        m.add(sum(big) <= pb.larger)
    m.add(sum(opn) >= pb.tc_min)
    m.add(sum(opn) <= pb.tc_max)
    b.opn = opn

    for o in pb.forced_open:
        enf(m.add_bool_or([opn[s] for s in pb.slots_of[o]]), pb.open_src(o))

    # --- symmetry breaking among slots of one option ---------------------------------------------
    # Open slots come first, and each open slot's lowest member index is larger than the previous
    # slot's. seen[j][p] = "slot j has a member with index <= p" (prefix OR chain, O(N) per slot).
    for group in pb.slots_of:
        if len(group) < 2:
            continue
        for j in range(len(group) - 1):
            a, nxt = group[j], group[j + 1]
            m.add_implication(opn[nxt], opn[a])
            prev = x[0][a] if N else None
            if N:
                m.add(x[0][nxt] == 0)
            for p in range(1, N):
                # person p may sit in slot nxt only if slot a already has someone with a lower index
                m.add_implication(x[p][nxt], prev)
                if p == N - 1:
                    break
                cur = m.new_bool_var('')
                m.add_implication(prev, cur)
                m.add_implication(x[p][a], cur)
                m.add_bool_or([prev, x[p][a]]).only_enforce_if(cur)
                prev = cur

    # --- hard constraints ------------------------------------------------------------------------
    for h in pb.hard:
        kind, src = h[0], h[1]
        if kind == 'forbid_place':
            _, _, p, o = h
            if pb.slots_of[o]:
                enf(m.add_bool_and([~x[p][s] for s in pb.slots_of[o]]), src)
        elif kind == 'require_place':
            _, _, p, o = h
            enf(m.add_bool_or([x[p][s] for s in pb.slots_of[o]]), src)
        elif kind == 'forbid_pair':
            _, _, p, q = h
            for s in range(S):
                enf(m.add_bool_or([~x[p][s], ~x[q][s]]), src)
        elif kind == 'require_pair':
            _, _, p, q = h
            for s in range(S):
                enf(m.add(x[p][s] == x[q][s]), src)
        else:  # team_count, per open team
            _, _, members, not_one, mx = h
            if not members:
                continue
            for s in range(S):
                cnt = cp_model.LinearExpr.sum([x[v][s] for v in members])
                if not_one:
                    present = m.new_bool_var('')
                    for v in members:
                        m.add_implication(x[v][s], present)
                    enf(m.add(cnt >= 2), src, [present])
                if mx is not None and mx < len(members):
                    enf(m.add(cnt <= mx), src)

    # --- objective (exact: every indicator fully reified) -----------------------------------------
    b.objective = None
    if with_objective:
        terms_v, terms_c = [], []
        person_cost = []
        for p in range(N):
            pv, pc = [], []
            for o, c in pb.cost[p].items():
                for s in pb.slots_of[o]:
                    pv.append(x[p][s])
                    pc.append(c)
            terms_v += pv
            terms_c += pc
            person_cost.append((pv, pc))

        # z[p,q,s] <=> p and q both on slot s (exact). The two redundant families below exist only for
        # the LP relaxation, which otherwise never sees the z<->x link (CP-SAT keeps those clauses out of
        # the default LP) and would count every pair bonus once per slot: measured on 27 people x 20
        # options, the proof went from >30 s to 0.25 s.
        #   - at most one slot per pair;  - per (person, slot): partners there <= K * x[p,s].
        z_at = {}
        for p, q, c in pb.pairs:
            zs = []
            for s in range(S):
                z = m.new_bool_var('')
                m.add_bool_and([x[p][s], x[q][s]]).only_enforce_if(z)
                m.add_bool_or([~x[p][s], ~x[q][s], z])
                zs.append(z)
                z_at.setdefault((p, s), []).append(z)
                z_at.setdefault((q, s), []).append(z)
                terms_v.append(z)
                terms_c.append(c)
            m.add_at_most_one(zs)
        K = pb.size_max - 1 + (1 if pb.larger > 0 else 0)
        for (p, s), zl in z_at.items():
            m.add(cp_model.LinearExpr.sum(zl) <= K * x[p][s])

        for members, not_one, mx, w in pb.soft:
            if w == 0 or not members:
                continue
            M = len(members)
            bad = []
            if not_one:
                bad.append([1, 1])
            if mx is not None and mx + 1 <= M:
                bad.append([mx + 1, M])
            if not bad:
                continue
            bad_dom = cp_model.Domain.from_intervals(bad)
            good_dom = bad_dom.complement().intersection_with(cp_model.Domain(0, M))
            for s in range(S):
                cnt = cp_model.LinearExpr.sum([x[v][s] for v in members])
                viol = m.new_bool_var('')
                m.add_linear_expression_in_domain(cnt, bad_dom).only_enforce_if(viol)
                m.add_linear_expression_in_domain(cnt, good_dom).only_enforce_if(~viol)
                terms_v.append(viol)
                terms_c.append(w)

        # balance: weight * |sum of c_m on the team| per slot. An empty slot sums to 0, so the term
        # needs no link to open[s].
        for vals, w in pb.balance:
            if w == 0:
                continue
            B = sum(abs(v) for v in vals)
            if B == 0:
                continue
            for s in range(S):
                d = m.new_int_var(-B, B, '')
                m.add(d == cp_model.LinearExpr.weighted_sum([x[p][s] for p in range(N)], vals))
                a = m.new_int_var(0, B, '')
                m.add_abs_equality(a, d)
                terms_v.append(a)
                terms_c.append(w)

        if pb.worst_off_weight != 0 and N > 0:
            all_c = [c for d in pb.cost for c in d.values()]
            lo, hi = min(all_c + [0]), max(all_c + [0])
            worst = m.new_int_var(lo, hi, 'worst')
            exprs = []
            has_zero = False
            for pv, pc in person_cost:
                if pv:
                    exprs.append(cp_model.LinearExpr.weighted_sum(pv, pc))
                else:
                    has_zero = True
            if has_zero:
                exprs.append(0)
            m.add_max_equality(worst, exprs)
            terms_v.append(worst)
            terms_c.append(pb.worst_off_weight)

        if terms_v:
            obj = cp_model.LinearExpr.weighted_sum(terms_v, terms_c)
            m.minimize(obj)
            b.objective = obj
    return b


# --------------------------------------------------------------------------------------------------
# Solve
# --------------------------------------------------------------------------------------------------

class Progress(cp_model.CpSolverSolutionCallback):
    """Emits throttled progress lines. `shared` carries the best objective across search phases so a
    later phase restarting from scratch never reports a worse objective than one already shown."""

    def __init__(self, out, stop_after_first, shared):
        super().__init__()
        self.out = out
        self.stop_after_first = stop_after_first
        self.shared = shared

    def on_solution_callback(self):
        if self.stop_after_first:
            self.stop_search()
            return
        if self.out is None:
            return
        obj = _int_or_none(self.objective_value, round)
        if obj is None or (self.shared['best'] is not None and obj >= self.shared['best']):
            return
        self.shared['best'] = obj
        now = time.monotonic()
        if now - self.shared['last'] < PROGRESS_MIN_INTERVAL_S:
            return
        self.shared['last'] = now
        self.out({'type': 'progress', 'objective': obj,
                  'bound': _int_or_none(self.best_objective_bound - 1e-6, math.ceil),
                  'elapsed': round(now - T0, 3)})


def _int_or_none(v, fn):
    return int(fn(v)) if math.isfinite(v) else None


# Search plan. With 2 workers CP-SAT runs exactly ONE full-problem worker (plus a thread shared by
# feasibility-jump and LNS), so which LP that worker uses decides a lot. Measured at 2 workers
# (synthetic instances, M-series laptop):
#   - default_lp proves small instances fast (27x20 and 60x30 pairs: < 0.3 s; 40x90: 0.65 s; free 60:
#     0.5 s) where max_lp (linearization level 2) needs 3-15 s to prove the same optimum;
#   - max_lp wins by ~3x on mid-size by-option pairs where default_lp stalls with someone on an
#     unranked option (50x100 at 15 s: 11.6k vs 32.1k) and on everything large (300x150 at 30 s:
#     32.3k vs 38.2k, bound 28.2k vs 4.4k);
#   - no size cut-off separates the two (free 150 with a balance field: default 18.6k vs max_lp 26.3k).
# So below MAX_LP_ONLY_CELLS we run default_lp for a slice, and if that did not prove optimality we
# run max_lp from scratch for the rest and keep the better answer and bound. At 30 s this was never
# the 3x-worse choice (50x100: 11.6k; 90x45x2 slots: 7.3k vs 30.6k/29.4k for either alone; free 150
# balance: 19.8k vs 18.6k default-only). Hinting max_lp with the phase-1 solution was tried and is
# worse: it stays near that solution (50x100: 31.6k). Above the cut-off a second presolve costs too
# much and max_lp alone was better in every measurement.
MAX_LP_ONLY_CELLS = 20000   # people x slots
PHASE1_SHARE = 0.2          # of time_limit_s ...
PHASE1_MIN_S = 2.0          # ... but at least this long
PHASE1_STOP_AFTER_FIRST = False  # selftest only: force the two-phase hand-off on tiny problems


def _solver(pb, workers, time_limit, lp=None):
    solver = cp_model.CpSolver()
    prm = solver.parameters
    prm.num_workers = workers
    prm.random_seed = pb.seed % 2147483647
    prm.max_time_in_seconds = max(0.1, time_limit)
    # Presolve's repeated probing took 5.5 of the first 8.5 s on 300 people x 150 options; one pass
    # with a short probing budget brings first-feasible there from ~10 s to ~3 s and costs nothing on
    # small instances.
    prm.max_presolve_iterations = 1
    prm.probing_deterministic_time_limit = 0.25
    if lp:
        prm.subsolvers.append(lp)
    return solver


def _run_phase(pb, b, workers, limit, lp, progress_out, stop_after_first, shared):
    solver = _solver(pb, workers, limit, lp)
    status = solver.status_name(solver.solve(b.model, Progress(progress_out, stop_after_first, shared)))
    if status not in ('OPTIMAL', 'FEASIBLE'):
        return status, None, None, None
    slot_of = []
    for p in range(pb.n):
        row = b.x[p]
        slot_of.append(next(s for s in range(pb.n_slots) if solver.boolean_value(row[s])))
    if b.objective is None:
        return status, slot_of, 0, 0
    obj = int(solver.value(b.objective))
    bound = obj if status == 'OPTIMAL' else _int_or_none(solver.best_objective_bound - 1e-6, math.ceil)
    return status, slot_of, obj, bound


def solve(pb, workers=2, progress_out=None, stop_after_first=False):
    res = {'type': 'result', 'status': 'UNKNOWN', 'teams': [], 'objective': None, 'bound': None,
           'wall_s': 0.0, 'core': [], 'core_status': 'n/a', 'engine': ENGINE,
           'stats': {'people': pb.n, 'slots': pb.n_slots, 'pairs': len(pb.pairs), 'build_s': 0.0}}
    too_big = magnitude_problem(pb)
    if too_big is not None:
        res['status'] = 'MODEL_INVALID'
        res['message'] = too_big
        res['wall_s'] = round(time.monotonic() - T0, 3)
        return res
    built_at = time.monotonic()
    b = build(pb, assume=False, with_objective=True)
    res['stats']['build_s'] = round(time.monotonic() - built_at, 3)
    if b.objective is None or stop_after_first or workers > 2:
        # More than 2 workers already gets CP-SAT's own portfolio (which includes max_lp); appending a
        # subsolver would REPLACE that portfolio, so the tuned plan below is a 2-worker plan only.
        plan = [None]
    elif pb.n * pb.n_slots >= MAX_LP_ONLY_CELLS:
        plan = ['max_lp']
    else:
        plan = [None, 'max_lp']
    start = time.monotonic()
    limit = pb.time_limit_s
    best = None       # (objective, slot_of)
    bound = None      # best lower bound across phases (all are bounds on the same model)
    status = 'UNKNOWN'
    shared = {'best': None, 'last': -1e9}  # progress-line state across phases
    for i, lp in enumerate(plan):
        left = limit - (time.monotonic() - start)
        last = i == len(plan) - 1
        if i > 0 and left < 0.5:
            break
        phase_limit = left if last else min(left, max(PHASE1_MIN_S, PHASE1_SHARE * limit))
        first_only = stop_after_first or (PHASE1_STOP_AFTER_FIRST and not last)
        st, slot_of, obj, bd = _run_phase(pb, b, workers, phase_limit, lp, progress_out, first_only, shared)
        if slot_of is not None:
            if best is None or obj < best[0]:
                best = (obj, slot_of)
            if bd is not None:
                bound = bd if bound is None else max(bound, bd)
        if st == 'OPTIMAL' or (st in ('INFEASIBLE', 'MODEL_INVALID') and best is None):
            status = st
            break
        if st == 'FEASIBLE' or best is not None:
            status = 'FEASIBLE'
        if stop_after_first:
            break
    if best is not None:
        obj, slot_of = best
        if status != 'OPTIMAL' and bound is not None and bound >= obj and not stop_after_first:
            status = 'OPTIMAL'
        teams = {}
        for p, s in enumerate(slot_of):
            teams.setdefault(s, []).append(p)
        res['teams'] = [{'slot': s, 'members': teams[s]} for s in sorted(teams)]
        res['objective'] = obj
        res['bound'] = obj if status == 'OPTIMAL' else (None if bound is None else min(obj, bound))
    res['status'] = status if status in STATUS_NAMES else 'UNKNOWN'
    if status == 'INFEASIBLE':
        budget = max(5.0, pb.time_limit_s - (time.monotonic() - T0))
        res['core'], res['core_status'] = explain_infeasible(pb, budget)
    elif status == 'MODEL_INVALID':
        detail = b.model.validate()
        sys.stderr.write('model invalid: ' + detail + '\n')
        res['message'] = 'CP-SAT rejected the model' + (': ' + detail[:300] if detail else '')
    res['wall_s'] = round(time.monotonic() - T0, 3)
    return res


def explain_infeasible(pb, budget_s):
    """Returns (core, core_status): the srcs that together make the problem infeasible, and
    'complete' when that core is proven minimal ([] then = the structure itself cannot fit) or
    'timeout' when the budget ran out first (the core found so far, possibly [] and possibly not
    minimal; an empty one then proves nothing about structure)."""
    if not pb.srcs:
        return [], 'complete'
    deadline = time.monotonic() + budget_s
    b = build(pb, assume=True, with_objective=False)
    by_index = {lit.index: src for src, lit in b.lits.items()}

    def attempt(srcs, limit):
        b.model.clear_assumptions()
        b.model.add_assumptions([b.lits[s] for s in srcs])
        solver = _solver(pb, 1, limit)
        st = solver.status_name(solver.solve(b.model))
        if st != 'INFEASIBLE':
            return st, None
        got = {by_index[i] for i in solver.sufficient_assumptions_for_infeasibility() if i in by_index}
        return st, [s for s in srcs if s in got]

    st, core = attempt(pb.srcs, deadline - time.monotonic())
    if st != 'INFEASIBLE':
        sys.stderr.write(f'core extraction: assumption solve returned {st}\n')
        return [], 'timeout'
    # Deletion-based shrink: drop each src whose removal keeps the problem infeasible. A trial that
    # times out (UNKNOWN) keeps its src, so the core stays sufficient but may not be minimal.
    i = 0
    per_try = max(1.0, pb.time_limit_s / 10)
    complete = True
    while i < len(core):
        left = deadline - time.monotonic()
        if left <= 0.05:
            complete = False
            break
        trial = core[:i] + core[i + 1:]
        st, sub = attempt(trial, min(per_try, left))
        if st == 'INFEASIBLE':
            core = sub  # subset of trial; keep i (next candidate slid into position i)
        else:
            if st != 'OPTIMAL' and st != 'FEASIBLE':
                complete = False
            i += 1
    return core, 'complete' if complete else 'timeout'


# --------------------------------------------------------------------------------------------------
# Independent scorer (selftest only): mirrors teamSetScore.ts scoreAssignment on the RAW problem.
# --------------------------------------------------------------------------------------------------

def score(problem, teams):
    people = problem['people']
    N = len(people)
    slot_of = {}
    for t in teams:
        for v in t['members']:
            slot_of[v] = t['slot']
    opt = [problem['slots'][slot_of[p]]['option'] for p in range(N)]
    place = {}
    for e in problem['place']:
        place[(e['p'], e['o'])] = place.get((e['p'], e['o']), 0) + e['cost']
    pc = [place.get((p, opt[p]), 0) for p in range(N)]
    total = sum(pc)
    for e in problem['pair']:
        if slot_of[e['p']] == slot_of[e['q']]:
            total += e['cost']
    for e in problem['soft_counts']:
        ms = set(e['members'])
        for t in teams:
            if not t['members']:
                continue
            cnt = sum(1 for v in t['members'] if v in ms)
            if (e.get('not_one') and cnt == 1) or (e.get('max') is not None and cnt > e['max']):
                total += e['weight']
    for e in problem['balance']:
        for t in teams:
            if t['members']:
                total += e['weight'] * abs(sum(e['values'][v] for v in t['members']))
    if N:
        total += problem['worst_off_weight'] * max(pc)
    return total


def violations(problem, teams, srcs=None):
    """Structural + hard violations. srcs: when given, only hard/forced-open constraints whose src is in
    it are checked (used to verify cores)."""
    out = []
    N = len(problem['people'])
    slot_of = {}
    for t in teams:
        for v in t['members']:
            if v in slot_of:
                return ['person twice']
            slot_of[v] = t['slot']
    if len(slot_of) != N:
        return ['person unassigned']
    size = problem['size']
    over = 0
    for t in teams:
        n = len(t['members'])
        if n == 0:
            continue
        if n < size['min'] or n > size['max'] + 1:
            return ['size']
        if n == size['max'] + 1:
            over += 1
    if over > size['larger']:
        return ['larger']
    open_slots = {t['slot'] for t in teams if t['members']}
    if not problem['team_count']['min'] <= len(open_slots) <= problem['team_count']['max']:
        return ['team_count']
    open_opts = {problem['slots'][s]['option'] for s in open_slots}
    for o, opt in enumerate(problem['options']):
        src = f"option:{opt['id']}"
        if opt['open'] == 'open' and o not in open_opts and (srcs is None or src in srcs):
            out.append(src)
    for h in problem['hard']:
        if srcs is not None and h['src'] not in srcs:
            continue
        k = h['kind']
        if k == 'forbid_place' and problem['slots'][slot_of[h['p']]]['option'] == h['o']:
            out.append(h['src'])
        elif k == 'require_place' and problem['slots'][slot_of[h['p']]]['option'] != h['o']:
            out.append(h['src'])
        elif k == 'forbid_pair' and slot_of[h['p']] == slot_of[h['q']]:
            out.append(h['src'])
        elif k == 'require_pair' and slot_of[h['p']] != slot_of[h['q']]:
            out.append(h['src'])
        elif k == 'team_count':
            ms = set(h['members'])
            for t in teams:
                cnt = sum(1 for v in t['members'] if v in ms)
                if (h.get('not_one') and cnt == 1) or (h.get('max') is not None and cnt > h['max']):
                    out.append(h['src'])
                    break
    return out


# --------------------------------------------------------------------------------------------------
# Selftest
# --------------------------------------------------------------------------------------------------

def _base(n, options, slots, mn, mx, larger=0, tc=None):
    return {'version': 1, 'people': [f'u{i}' for i in range(n)],
            'options': [{'id': o, 'open': 'auto'} for o in options],
            'slots': [{'option': o} for o in slots],
            'size': {'min': mn, 'max': mx, 'larger': larger},
            'team_count': tc or {'min': 1, 'max': len(slots)},
            'place': [], 'pair': [], 'hard': [], 'soft_counts': [], 'balance': [],
            'worst_off_weight': 0, 'time_limit_s': 10, 'seed': 7}


def fixture_pairs():
    """7 people, 4 topics, pairs (one trio allowed), ranked costs, a mutual request, an apart pin."""
    pb = _base(7, ['t0', 't1', 't2', 't3'], [0, 1, 2, 3], 2, 2, larger=1)
    ranks = {0: [0, 1], 1: [0, 2], 2: [1, 0], 3: [2, 3], 4: [3, 2], 5: [1, 3], 6: []}
    for p, picks in ranks.items():
        if not picks:
            continue  # no answer: flexible filler, costs 0 everywhere
        for o in range(4):
            d = [0, 10][picks.index(o)] if o in picks else 100
            c = 8 * round(100 * (d / 100) ** 2)
            if c:
                pb['place'].append({'p': p, 'o': o, 'cost': c})
    pb['pair'] = [{'p': 0, 'q': 3, 'cost': -1000}, {'p': 1, 'q': 2, 'cost': -250}]
    pb['hard'] = [{'kind': 'forbid_pair', 'src': 'pin:p1', 'p': 0, 'q': 1}]
    pb['soft_counts'] = [{'src': 'non_respondents', 'members': [5, 6], 'max': 1, 'weight': 50}]
    pb['worst_off_weight'] = 40
    return pb


def fixture_infeasible():
    """A must-together rule and an apart pin on the same pair; an unrelated owner pin is fine."""
    pb = _base(6, ['a', 'b', 'c'], [0, 1, 2], 2, 2)
    pb['hard'] = [
        {'kind': 'require_pair', 'src': 'f1:together', 'p': 0, 'q': 1},
        {'kind': 'require_place', 'src': 'pin:p2', 'p': 4, 'o': 2},
        {'kind': 'forbid_pair', 'src': 'pin:p1', 'p': 0, 'q': 1},
    ]
    return pb, ['f1:together', 'pin:p1']


def fixture_capacity():
    """7 people cannot fill pairs with no larger team allowed: structural, empty core."""
    pb = _base(7, ['a', 'b', 'c', 'd'], [0, 1, 2, 3], 2, 2)
    pb['hard'] = [{'kind': 'forbid_pair', 'src': 'pin:p1', 'p': 0, 'q': 1}]
    return pb


def fixture_free():
    """Free mode: 8 people into ceil(8/2)=4 interchangeable slots of 2..3, with requests, an apart
    rule, a no-one-alone group, a balance field and a spread of non-respondents. The balance values
    are c_p for answers [1,5,3,3,2,4,5,1] on a 1..5 scale: round(100 * (a - 3) / 4)."""
    pb = _base(8, ['__free__'], [0, 0, 0, 0], 2, 3, tc={'min': 1, 'max': 4})
    pb['pair'] = [{'p': 0, 'q': 1, 'cost': -500}, {'p': 2, 'q': 3, 'cost': -250},
                  {'p': 3, 'q': 4, 'cost': -250}, {'p': 5, 'q': 6, 'cost': 500}]
    pb['hard'] = [{'kind': 'forbid_pair', 'src': 'f2:apart', 'p': 1, 'q': 2},
                  {'kind': 'team_count', 'src': 'f3:no_one_alone', 'members': [0, 4, 7], 'not_one': True}]
    pb['soft_counts'] = [{'src': 'non_respondents', 'members': [5, 7], 'max': 1, 'weight': 50}]
    pb['balance'] = [{'src': 'f4:balance', 'values': [-50, 50, 0, 0, -25, 25, 50, -50], 'weight': 4}]
    return pb


def fixture_balance():
    """Balance alone, hand-computed: 4 people into 2 pairs, c = [100, -100, 50, -50], weight 3.
    {0,1}+{2,3} sums to 0 and 0 (objective 0); {0,2}+{1,3} to 150 and -150 (3 * 300 = 900);
    {0,3}+{1,2} to 50 and -50 (3 * 100 = 300)."""
    pb = _base(4, ['__free__'], [0, 0], 2, 2)
    pb['balance'] = [{'src': 'f5:balance', 'values': [100, -100, 50, -50], 'weight': 3}]
    return pb


def random_problem(rng):
    """Tiny random problem touching every IR feature (enumerable: slots**people <= ~4k)."""
    n_opt = rng.randint(1, 3)
    tpo = rng.randint(1, 2) if n_opt <= 2 else 1
    slots = [o for o in range(n_opt) for _ in range(tpo)]
    S = len(slots)
    n = rng.randint(3, {1: 8, 2: 8, 3: 7, 4: 6}[S])
    mn = rng.randint(1, 2)
    mx = max(mn + rng.randint(0, 2), math.ceil(n / S))
    need = math.ceil(n / mx)                 # fewest teams that fit everyone
    cap = max(need, min(S, n // mn))         # most teams that can each reach size.min
    pb = _base(n, [f'o{i}' for i in range(n_opt)], slots, mn, mx, larger=rng.randint(0, 1),
               tc={'min': rng.randint(1, need), 'max': rng.randint(need, cap)})
    pb['seed'] = rng.randint(0, 10 ** 9)
    for o in range(n_opt):
        r = rng.random()
        if r < 0.15:
            pb['options'][o]['open'] = 'open'
        elif r < 0.25:
            pb['options'][o]['open'] = 'closed'
            pb['hard'] += [{'kind': 'forbid_place', 'src': f'option:o{o}', 'p': p, 'o': o} for p in range(n)]
    for _ in range(rng.randint(0, n * n_opt)):
        pb['place'].append({'p': rng.randrange(n), 'o': rng.randrange(n_opt), 'cost': rng.randint(-60, 100)})
    for _ in range(rng.randint(0, n)):
        p, q = rng.sample(range(n), 2)
        pb['pair'].append({'p': min(p, q), 'q': max(p, q), 'cost': rng.randint(-80, 80)})
    srcs = ['r1:together', 'r2:apart', 'pin:p1', 'pin:p2', 'r3:no_one_alone']
    for _ in range(rng.randint(0, 2)):
        src = rng.choice(srcs)
        k = rng.choice(['forbid_place', 'require_place', 'forbid_pair', 'require_pair', 'team_count'])
        if k in ('forbid_place', 'require_place'):
            pb['hard'].append({'kind': k, 'src': src, 'p': rng.randrange(n), 'o': rng.randrange(n_opt)})
        elif k in ('forbid_pair', 'require_pair'):
            p, q = sorted(rng.sample(range(n), 2))
            pb['hard'].append({'kind': k, 'src': src, 'p': p, 'q': q})
        else:
            h = {'kind': k, 'src': src, 'members': sorted(rng.sample(range(n), rng.randint(1, n)))}
            if rng.random() < 0.7:
                h['not_one'] = True
            if rng.random() < 0.5:
                h['max'] = rng.randint(1, 3)
            pb['hard'].append(h)
    if n >= 3 and rng.random() < 0.2:  # a chain that collides across three srcs
        a, b, c = rng.sample(range(n), 3)
        pb['hard'] += [{'kind': 'require_pair', 'src': 'r1:together', 'p': min(a, b), 'q': max(a, b)},
                       {'kind': 'require_pair', 'src': 'pin:p3', 'p': min(b, c), 'q': max(b, c)},
                       {'kind': 'forbid_pair', 'src': 'r2:apart', 'p': min(a, c), 'q': max(a, c)}]
    for _ in range(rng.randint(0, 2)):
        e = {'src': 'soft', 'members': sorted(rng.sample(range(n), rng.randint(1, n))),
             'weight': rng.randint(-20, 90)}
        if rng.random() < 0.6:
            e['not_one'] = True
        if rng.random() < 0.6:
            e['max'] = rng.randint(0, 3)
        pb['soft_counts'].append(e)
    for _ in range(rng.randint(0, 1)):
        # Centred like the compiler's c_p (mixed signs; an all-positive vector would make the term
        # the same for every assignment and hide a sign or per-team bug).
        vals = ([rng.randint(-4, 4) * 25 for _ in range(n)] if rng.random() < 0.5
                else [rng.randint(-BALANCE_VALUE_MAX, BALANCE_VALUE_MAX) for _ in range(n)])
        pb['balance'].append({'src': 'bal', 'values': vals, 'weight': rng.randint(1, 3)})
    pb['worst_off_weight'] = rng.choice([0, 0, 3, 10])
    return pb


def brute(problem, srcs=None, find_any=False):
    """Exhaustive optimum over slot assignments (tiny problems only). None = infeasible."""
    N, S = len(problem['people']), len(problem['slots'])
    best = None
    for assign in itertools.product(range(S), repeat=N):
        groups = {}
        for p, s in enumerate(assign):
            groups.setdefault(s, []).append(p)
        teams = [{'slot': s, 'members': groups[s]} for s in sorted(groups)]
        if violations(problem, teams, srcs):
            continue
        if find_any:
            return 0
        v = score(problem, teams)
        if best is None or v < best:
            best = v
    return best


def selftest():
    global MAX_LP_ONLY_CELLS, PHASE1_STOP_AFTER_FIRST, _run_phase
    default_cells = MAX_LP_ONLY_CELLS
    failures = []

    def check(cond, msg):
        if not cond:
            failures.append(msg)

    def check_fields(name, r):
        check(r['engine'] == ENGINE and r['engine'].startswith('cpsat@'), f'{name}: engine {r["engine"]}')
        st = r['stats']
        check(sorted(st) == ['build_s', 'pairs', 'people', 'slots']
              and all(isinstance(v, (int, float)) and v >= 0 for v in st.values()),
              f'{name}: stats {st}')
        want_cs = ('complete', 'timeout') if r['status'] == 'INFEASIBLE' else ('n/a',)
        check(r['core_status'] in want_cs, f'{name}: core_status {r["core_status"]} for {r["status"]}')
        check(('message' in r) == (r['status'] == 'MODEL_INVALID'), f'{name}: message presence')

    def run(raw, workers=2, first=False, name='run'):
        r = solve(Problem(json.loads(json.dumps(raw))), workers=workers, stop_after_first=first)
        check_fields(name, r)
        return r

    def verify_feasible(name, raw, expect_opt=True):
        r = run(raw, name=name)
        check(r['status'] == 'OPTIMAL' if expect_opt else r['status'] in ('OPTIMAL', 'FEASIBLE'),
              f'{name}: status {r["status"]}')
        if r['teams']:
            check(not violations(raw, r['teams']), f'{name}: violations {violations(raw, r["teams"])}')
            check(score(raw, r['teams']) == r['objective'],
                  f'{name}: objective {r["objective"]} != rescored {score(raw, r["teams"])}')
        f = run(raw, first=True)  # first solution only: indicators must be exact off-optimum too
        if f['teams']:
            check(score(raw, f['teams']) == f['objective'],
                  f'{name}: first-solution objective {f["objective"]} != rescored {score(raw, f["teams"])}')
        return r

    fp = fixture_pairs()
    r = verify_feasible('pairs', fp)
    check(r['objective'] == brute(fp), f'pairs: objective {r["objective"]} != brute {brute(fp)}')

    ff = fixture_free()
    r = verify_feasible('free', ff)
    check(r['objective'] == brute(ff), f'free: objective {r["objective"]} != brute {brute(ff)}')

    fb = fixture_balance()
    for members, want_score in [([[0, 2], [1, 3]], 900), ([[0, 3], [1, 2]], 300), ([[0, 1], [2, 3]], 0),
                                ([[0, 1, 2, 3], []], 0)]:  # an empty slot adds nothing
        got = score(fb, [{'slot': s, 'members': ms} for s, ms in enumerate(members)])
        check(got == want_score, f'balance: score({members}) = {got}, want {want_score}')
    r = verify_feasible('balance', fb)
    check(r['objective'] == 0 and sorted(sorted(t['members']) for t in r['teams']) == [[0, 1], [2, 3]],
          f'balance: {r["objective"]} {r["teams"]}')
    check(r['stats'] == {'people': 4, 'slots': 2, 'pairs': 0, 'build_s': r['stats']['build_s']},
          f'balance: stats {r["stats"]}')

    fi, want = fixture_infeasible()
    r = run(fi, name='infeasible')
    check(r['status'] == 'INFEASIBLE' and sorted(r['core']) == sorted(want) and r['core_status'] == 'complete',
          f'infeasible: {r["status"]} core {r["core"]} {r["core_status"]}')
    # Out of time before the core is proven minimal: say so, never pass it off as complete.
    core, core_status = explain_infeasible(Problem(json.loads(json.dumps(fi))), 0.0)
    check(core_status == 'timeout' and (core == [] or set(want) <= set(core)),
          f'infeasible, no budget: {core_status} core {core}')

    r = run(fixture_capacity(), name='capacity')
    check(r['status'] == 'INFEASIBLE' and r['core'] == [] and r['core_status'] == 'complete',
          f'capacity: {r["status"]} core {r["core"]} {r["core_status"]}')

    # Magnitudes: answered as MODEL_INVALID with a message naming the entry, not a crash.
    bad = fixture_balance()
    bad['balance'][0]['values'][2] = BALANCE_VALUE_MAX + 1
    r = run(bad, name='balance-range')
    check(r['status'] == 'MODEL_INVALID' and 'balance[0].values[2]' in r.get('message', ''),
          f'balance-range: {r["status"]} {r.get("message")}')
    huge = fixture_pairs()
    huge['place'] += [{'p': 0, 'o': 0, 'cost': 2 ** 52}, {'p': 1, 'o': 0, 'cost': 2 ** 52}]
    r = run(huge, name='huge-objective')
    check(r['status'] == 'MODEL_INVALID' and '2**53' in r.get('message', '') and r['teams'] == [],
          f'huge-objective: {r["status"]} {r.get("message")}')
    beyond = fixture_pairs()
    beyond['pair'][0]['cost'] = 2 ** 53
    try:
        Problem(beyond)
        check(False, 'beyond-safe-integer: accepted')
    except BadInput:
        pass

    # Two-phase merge: keep the better answer and the better bound whatever order they arrive in.
    real_run_phase = _run_phase
    small = Problem(json.loads(json.dumps(fp)))
    a, b2 = [0] * small.n, [1] * small.n
    for script, want in [
        ([('FEASIBLE', a, 10, 0), ('FEASIBLE', b2, 20, 5)], ('FEASIBLE', 10, 5, 0)),
        ([('FEASIBLE', a, 10, 0), ('FEASIBLE', b2, 12, 10)], ('OPTIMAL', 10, 10, 0)),
        ([('UNKNOWN', None, None, None), ('FEASIBLE', b2, 7, 3)], ('FEASIBLE', 7, 3, 1)),
        ([('FEASIBLE', a, 10, 6), ('FEASIBLE', b2, 12, 4)], ('FEASIBLE', 10, 6, 0)),
    ]:
        seq = iter(script)
        _run_phase = lambda *args, _seq=seq: next(_seq)  # noqa: E731
        saved = MAX_LP_ONLY_CELLS
        MAX_LP_ONLY_CELLS = 10 ** 12  # force the two-phase plan
        r = solve(small, workers=2)
        MAX_LP_ONLY_CELLS = saved
        got = (r['status'], r['objective'], r['bound'], r['teams'][0]['slot'] if r['teams'] else None)
        check(got == want, f'merge: {script} -> {got}, want {want}')
    _run_phase = real_run_phase

    rng = random.Random(20260924)
    n_feas = n_inf = 0
    for i in range(300):
        raw = random_problem(rng)
        # Exercise every search plan: default then max_lp (i%3==0), a forced hand-off where phase 1 stops
        # at its first solution and max_lp continues from the hint (1), and max_lp alone (2).
        PHASE1_STOP_AFTER_FIRST = i % 3 == 1
        MAX_LP_ONLY_CELLS = 0 if i % 3 == 2 else default_cells
        opt = brute(raw)
        tag = f'random#{i}'
        r = run(raw, workers=rng.choice([1, 2]), name=tag)
        if opt is None:
            n_inf += 1
            check(r['status'] == 'INFEASIBLE', f'{tag}: brute infeasible, solver {r["status"]}')
            if r['status'] == 'INFEASIBLE':
                check(r['core_status'] == 'complete', f'{tag}: core_status {r["core_status"]}')
                core = set(r['core'])
                check(brute(raw, core, find_any=True) is None, f'{tag}: core {sorted(core)} not infeasible')
                for c in core:
                    check(brute(raw, core - {c}, find_any=True) is not None,
                          f'{tag}: core {sorted(core)} not minimal ({c})')
        else:
            n_feas += 1
            check(r['status'] == 'OPTIMAL', f'{tag}: status {r["status"]} (brute {opt})')
            if r['teams']:
                check(not violations(raw, r['teams']), f'{tag}: violations')
                check(score(raw, r['teams']) == r['objective'], f'{tag}: objective != rescored')
                check(r['objective'] == opt, f'{tag}: objective {r["objective"]} != brute {opt}')
            f = run(raw, first=True, name=tag)
            if f['teams']:
                check(score(raw, f['teams']) == f['objective'], f'{tag}: first-solution objective != rescored')

    for m in failures:
        sys.stderr.write('FAIL ' + m + '\n')
    print(json.dumps({'type': 'selftest', 'ok': not failures, 'failures': len(failures),
                      'random_feasible': n_feas, 'random_infeasible': n_inf,
                      'wall_s': round(time.monotonic() - T0, 2)}))
    return 0 if not failures else 1


# --------------------------------------------------------------------------------------------------

def main(argv):
    ap = argparse.ArgumentParser(description='Team-set CP-SAT engine')
    ap.add_argument('problem', nargs='?')
    ap.add_argument('--workers', type=int, default=2)
    ap.add_argument('--selftest', action='store_true')
    args = ap.parse_args(argv)
    if args.selftest:
        return selftest()
    if not args.problem:
        emit({'type': 'error', 'code': 'bad_input', 'message': 'problem file path required'})
        return 2
    try:
        with open(args.problem, 'r', encoding='utf-8') as f:
            raw = json.load(f)
        pb = Problem(raw)
    except (OSError, ValueError, BadInput) as e:
        msg = str(e) if isinstance(e, BadInput) else 'problem file unreadable or not JSON'
        emit({'type': 'error', 'code': 'bad_input', 'message': msg})
        return 2
    try:
        emit(solve(pb, workers=max(1, args.workers), progress_out=emit))
    except Exception:  # noqa: BLE001 - one closed error line for the task; details to stderr
        traceback.print_exc(file=sys.stderr)
        emit({'type': 'error', 'code': 'engine_error', 'message': 'engine failed'})
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
