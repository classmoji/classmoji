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
- IR version 1 or 2. Version 2 adds `options[].size` (an option's own team size), `group` (people
  who didn't answer, seated in a second solve) and `size.smaller`; a version-1 problem carrying any
  of them is malformed.
  A team on an option with its own size uses it; the set's `size` holds everywhere else. In the model
  every slot gets the LOOSE bounds (the wider of the two) unconditionally and the option's TIGHT
  bounds under src `size:<option id>`, so a core can name an option's size.
- Remainder flex (compiled in TypeScript, teamSetFlex.ts; this file only enforces it): `size.larger`
  teams may hold their max + 1 (big[s]) and `size.smaller` teams their min - 1 (small[s], only on a
  slot whose min - 1 >= 2). Those are the caps of everyone, or of stage 1 when there is a `group`;
  stage 2 has its own, `group.larger` / `group.smaller`. Absent caps are 0.
- Hard kind `owner_if_open` {src, o, members}: if any slot of option o is open, someone in `members`
  (the people who pitched o) is on option o. Empty `members` = o may not open.
- `group` (two-stage solve, see solve_group): stage 1 solves everyone NOT in group.members; stage 2
  seats the members only with each other, only on slots stage 1 left empty and only on options whose
  option_cost is not null, minimising the summed option_cost. Stage 1's placements are never
  revisited. The result then carries `stages`.

What this process prints, and why that matters for privacy: `python.runScript` in @trigger.dev/python
puts stdout AND stderr into its thrown error on a non-zero exit, and its trace span records that
error, so both streams can land in the Trigger dashboard whatever the task does with the error. This
file therefore never prints a user id, a name or an answer: stdout carries only integers, person and
slot indices, and `src` strings (rule ids `<field id>:<job>`, optionally with person indices
`@<p>` / `@<p>+<q>` or an option `#<option id>`, pin ids `pin:<id>`, `option:<option id>`,
`size:<option id>`,
`non_respondents`); `message` and error lines name entries by index; stderr carries tracebacks of
this code and CP-SAT's own diagnostics, which speak of variable and constraint indices. The `people`
array (user ids) is only ever counted, never read.

CLI:  python team_set_solver.py <problem.json> [--workers N]
      python team_set_solver.py --selftest
stdout: optional {"type":"progress",...} lines, then exactly one {"type":"result",...} line:
  status, teams, objective, bound, wall_s, core,
  core_status  'complete' (INFEASIBLE and the core is proven minimal; an empty core then means the
               structure itself cannot fit) | 'timeout' (INFEASIBLE but core extraction ran out of
               time: `core` is whatever sufficient set was found, possibly empty, possibly not minimal;
               an empty core here says nothing about structure) | 'n/a' (not INFEASIBLE),
  engine       'cpsat@<ortools version>',
  stats        {people, slots, pairs (pair-cost entries after merging), build_s (main model build;
               both stages' builds for a two-stage solve)},
  message      only with MODEL_INVALID: why, naming entries by index,
  stages       only when the problem has a `group`: {first: {status, objective, bound},
               second: {status, objective} | null (stage 2 never ran)}.
Exit 0 for every solver outcome (INFEASIBLE and MODEL_INVALID included); 2 for malformed input
({"type":"error","code":"bad_input"}); 1 for an engine crash ({"type":"error","code":"engine_error"},
traceback on stderr).
"""

import argparse
import itertools
import json
import math
import os
import random
import sys
import time
import traceback

import ortools
from ortools.sat.python import cp_model

T0 = time.monotonic()
ENGINE = f'cpsat@{ortools.__version__}'
STATUS_NAMES = {'OPTIMAL', 'FEASIBLE', 'INFEASIBLE', 'UNKNOWN', 'MODEL_INVALID'}
HARD_KINDS = {'forbid_place', 'require_place', 'forbid_pair', 'require_pair', 'team_count',
              'owner_if_open'}
VERSIONS = (1, 2)
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
        version = raw.get('version')
        if type(version) is not int or version not in VERSIONS:
            raise BadInput('version must be 1 or 2')
        self.version = version
        self.raw = raw  # the two-stage solve builds its stages from it
        people = _list(raw.get('people'), 'people')
        self.n = N = len(people)
        options = _list(raw.get('options'), 'options')
        self.option_ids = []
        self.option_open = []
        self.option_size = []  # per option: (min, max) of its own size, or None
        for i, o in enumerate(options):
            _obj(o, f'options[{i}]')
            if not isinstance(o.get('id'), str):
                raise BadInput(f'options[{i}].id must be a string')
            if o.get('open') not in ('auto', 'open', 'closed'):
                raise BadInput(f'options[{i}].open must be auto|open|closed')
            self.option_ids.append(o['id'])
            self.option_open.append(o['open'])
            own = o.get('size')
            if own is None:
                self.option_size.append(None)
                continue
            if version < 2:
                raise BadInput(f'options[{i}].size needs version 2')
            _obj(own, f'options[{i}].size')
            # min >= 1 keeps open[s] exact (an open slot has a member), which owner_if_open relies on.
            own_min = _int(own.get('min'), f'options[{i}].size.min', 1)
            self.option_size.append((own_min, _int(own.get('max'), f'options[{i}].size.max', own_min)))
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
        self.smaller = _int(size.get('smaller', 0), 'size.smaller', 0)
        if self.smaller > 0 and version < 2:
            raise BadInput('size.smaller needs version 2')
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
        self._seen_srcs = set()
        add_src = self._add_src

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
            elif kind == 'owner_if_open':
                o = _int(h.get('o'), f'hard[{i}].o', 0, O - 1)
                members = sorted({_int(m, f'hard[{i}].members[]', 0, N - 1)
                                  for m in _list(h.get('members'), f'hard[{i}].members')})
                entry = (kind, src, o, members)
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
        # An option's own size gets a src only where it is narrower than the loose bounds (otherwise
        # it constrains nothing beyond them) and the option has slots.
        self.size_src = {}  # option -> 'size:<id>'
        for o in range(O):
            if self.option_size[o] is not None and self.slots_of[o] and self.tight(o) != self.loose(o):
                self.size_src[o] = f'size:{self.option_ids[o]}'
                add_src(self.size_src[o])

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

        self.group = None  # (src, members, option_cost)
        self.group_larger = self.group_smaller = 0  # stage 2's remainder flex
        group = raw.get('group')
        if group is not None:
            if version < 2:
                raise BadInput('group needs version 2')
            _obj(group, 'group')
            gsrc = _src(group.get('src'), 'group')
            members = sorted({_int(m, 'group.members[]', 0, N - 1)
                              for m in _list(group.get('members'), 'group.members')})
            costs = _list(group.get('option_cost'), 'group.option_cost')
            if len(costs) != O:
                raise BadInput('group.option_cost must have one entry per option')
            costs = [None if c is None else _int(c, f'group.option_cost[{i}]', 0)
                     for i, c in enumerate(costs)]
            self.group = (gsrc, members, costs)
            self.group_larger = _int(group.get('larger', 0), 'group.larger', 0)
            self.group_smaller = _int(group.get('smaller', 0), 'group.smaller', 0)

        # Stage 1 of a two-stage solve only: (lo, hi, src) bounds on the number of open slots,
        # enforced under src (see solve_group). Never read from the IR.
        self.count_reserve = None

    def _add_src(self, s):
        if s not in self._seen_srcs:
            self._seen_srcs.add(s)
            self.srcs.append(s)

    def reserve_count(self, lo, hi, src):
        self.count_reserve = (lo, hi, src)
        self._add_src(src)

    def open_src(self, o):
        return f'option:{self.option_ids[o]}'

    def tight(self, o):
        """(min, max) for a team on option o: its own size when it has one, else the set's."""
        return self.option_size[o] or (self.size_min, self.size_max)

    def loose(self, o):
        """(min, max) that holds for option o even with its own size relaxed: the wider of the two."""
        lo, hi = self.tight(o)
        return min(lo, self.size_min), max(hi, self.size_max)


def magnitude_problem(pb):
    """None when every coefficient is in range, else a message naming the entry by index.

    The bound is on the objective of ANY assignment: each person pays at most their largest |place|
    cost, a pair cost is paid at most once, a soft count at most once per slot, a balance entry at
    most weight * sum|c_p| (the teams partition the people), worst-off at most its weight times the
    largest per-person cost, and each group member at most the largest option_cost. Within 2**53 the
    TypeScript rescoring stays exact, and CP-SAT's own (looser) int64 overflow check has room to
    spare. A stage of a two-stage solve is a restriction of the problem, so this bound covers it."""
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
    if pb.group is not None:
        _src, members, costs = pb.group
        bound += len(members) * max((c for c in costs if c is not None), default=0)
    if bound > MAX_OBJECTIVE_MAGNITUDE:
        return (f'the objective could reach {float(bound):.3g}, beyond the exact-integer limit '
                f'2**53; the costs or weights are too large')
    return None


# --------------------------------------------------------------------------------------------------
# Model
# --------------------------------------------------------------------------------------------------

class Built:
    pass


def shrinks(bound):
    """Whether a team whose min is `bound` may hold one fewer (never below 2)."""
    return bound - 1 >= 2


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

    # --- structure: sizes, open, larger, smaller, team_count --------------------------------------
    # Each slot: the loose bounds of its option unconditionally (for an option without its own size
    # they are the set's size, so a version-1 model is exactly what it always was); an option's own
    # size, where narrower, under its size src. big[s] lets slot s hold one more than its max;
    # small[s] one fewer than its min, only where that min - 1 >= 2 (the tight min decides whether a
    # slot may shrink; a loose bound below 3 never shrinks, so a relaxed core build can't make a team
    # of 1).
    opn = [m.new_bool_var(f'open{s}') for s in range(S)]
    big = [m.new_bool_var(f'big{s}') for s in range(S)] if pb.larger > 0 else None
    small = ([m.new_bool_var(f'small{s}') if shrinks(pb.tight(pb.slot_opt[s])[0]) else None
              for s in range(S)] if pb.smaller > 0 else None)

    def less(s, bound):
        return small[s] if small and small[s] is not None and shrinks(bound) else 0

    for s in range(S):
        col = [x[p][s] for p in range(N)]
        size = cp_model.LinearExpr.sum(col)
        o = pb.slot_opt[s]
        lo, hi = pb.loose(o)
        m.add(size >= lo * opn[s] - less(s, lo))
        if big:
            m.add(size <= hi * opn[s] + big[s])
            m.add_implication(big[s], opn[s])
        else:
            m.add(size <= hi * opn[s])
        if small and small[s] is not None:
            m.add_implication(small[s], opn[s])
        if o in pb.size_src:
            own_lo, own_hi = pb.tight(o)
            if own_lo > lo:
                enf(m.add(size >= own_lo * opn[s] - less(s, own_lo)), pb.size_src[o])
            if own_hi < hi:
                enf(m.add(size <= own_hi * opn[s] + (big[s] if big else 0)), pb.size_src[o])
    if big:
        m.add(sum(big) <= pb.larger)
    if small:
        shrinkers = [v for v in small if v is not None]
        if shrinkers:
            m.add(sum(shrinkers) <= pb.smaller)
    m.add(sum(opn) >= pb.tc_min)
    m.add(sum(opn) <= pb.tc_max)
    if pb.count_reserve is not None:
        lo, hi, src = pb.count_reserve
        enf(m.add(cp_model.LinearExpr.sum(opn) >= lo), src)
        enf(m.add(cp_model.LinearExpr.sum(opn) <= hi), src)
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
        elif kind == 'owner_if_open':
            # Any open slot of o needs one of `members` somewhere on o (not necessarily that slot).
            _, _, o, members = h
            on_o = [x[p][s] for p in members for s in pb.slots_of[o]]
            for s in pb.slots_of[o]:
                if on_o:
                    enf(m.add_bool_or(on_o), src, [opn[s]])
                else:
                    enf(m.add_bool_and([~opn[s]]), src)
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
        #   - at most one slot per pair;  - per (person, slot): partners there <= K[s] * x[p,s].
        # K[s] must be at least the most partners anyone can have on slot s, or the inequality cuts
        # off real solutions: slot s's max - 1 (+1 if a larger team is allowed), where the max is the
        # option's own size when it has one, which may be ABOVE the set's max. The tight max is valid
        # only while the option's size is enforced unconditionally (assume=False).
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
        extra = 1 if pb.larger > 0 else 0
        for (p, s), zl in z_at.items():
            o = pb.slot_opt[s]
            slot_max = pb.size_max if SELFTEST_GLOBAL_K else (pb.loose(o) if assume else pb.tight(o))[1]
            m.add(cp_model.LinearExpr.sum(zl) <= (slot_max - 1 + extra) * x[p][s])

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
SELFTEST_GLOBAL_K = False        # selftest only: the old set-wide K, to show a case that needs K[s]


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
    if pb.group is None:
        return solve_single(pb, workers, progress_out, stop_after_first)
    return solve_group(pb, workers, progress_out, stop_after_first)[0]


def _result(pb):
    return {'type': 'result', 'status': 'UNKNOWN', 'teams': [], 'objective': None, 'bound': None,
            'wall_s': 0.0, 'core': [], 'core_status': 'n/a', 'engine': ENGINE,
            'stats': {'people': pb.n, 'slots': pb.n_slots, 'pairs': len(pb.pairs), 'build_s': 0.0}}


def solve_single(pb, workers=2, progress_out=None, stop_after_first=False, explain=True):
    """One CP-SAT solve of the whole problem. explain=False skips core extraction on INFEASIBLE and
    leaves core/core_status for the caller to set (stage 2 of solve_group)."""
    res = _result(pb)
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
        if explain:
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
# Two-stage solve (problem.group)
# --------------------------------------------------------------------------------------------------

def group_team_counts(pb):
    """(k2_min, k2_max): how many teams stage 2 can need. G = group.members; the eligible options are
    those with a non-null option_cost, less the owner-only ones: an owner_if_open on o names nobody
    in G, and stage 1 doesn't surely open o (not forced open, and no require_place for someone
    outside G puts anyone on it), so o opens in stage 2 only if stage 1 happened to open it. gmax /
    gmin = the largest max / smallest min of their sizes (own size, else the set's). With stage 2's
    own flex (group.larger L, group.smaller S): k2_min = max(ceil(|G| / (gmax + 1)),
    ceil((|G| - L) / gmax)), the fewest teams that hold G with L of them one over, and
    k2_max = floor((|G| + S) / gmin) (wide on purpose: it only loosens the reservation); (0, 0) when
    G is empty or no option is eligible. compileProblem (groupTeamCounts, ownerOnlyOptions) and the
    TypeScript cross-check apply the same formula, so any change here is a change there too."""
    _src, members, costs = pb.group
    in_group = set(members)
    opened = set(pb.forced_open) | {h[3] for h in pb.hard
                                    if h[0] == 'require_place' and h[2] not in in_group}
    owner_only = {h[2] for h in pb.hard
                  if h[0] == 'owner_if_open' and h[2] not in opened and not in_group.intersection(h[3])}
    eligible = [o for o, c in enumerate(costs) if c is not None and o not in owner_only]
    if not members or not eligible:
        return 0, 0
    gmax = max(pb.tight(o)[1] for o in eligible)
    gmin = min(pb.tight(o)[0] for o in eligible)
    g = len(members)
    return (max(-(-g // (gmax + 1)), -(-(g - pb.group_larger) // gmax)),
            (g + pb.group_smaller) // gmin)


def _stage_raw(pb, keep, slots, owner_members):
    """pb's IR restricted to the people `keep` and the slots `slots` (original indices, ascending),
    both renumbered. An entry naming anyone outside `keep` is dropped; a count or balance entry keeps
    only its members in `keep`. That is exact for one stage of a two-stage solve because no team mixes
    the stages: a pair split across them never shares a team, and a count or balance term on a team
    only ever sees that team's own stage. owner_members(entry) gives an owner_if_open entry's members
    (original indices) for this stage, or None to drop it. Structure (team_count, the size caps --
    stage 1's, `size.larger/smaller`), time limit and worst-off weight are copied for the caller to
    adjust."""
    raw = pb.raw
    pi = {p: i for i, p in enumerate(keep)}
    options = []
    for o in raw['options']:
        opt = {'id': o['id'], 'open': o['open']}
        if o.get('size') is not None:
            opt['size'] = {'min': o['size']['min'], 'max': o['size']['max']}
        options.append(opt)
    hard = []
    for h in raw['hard']:
        kind = h['kind']
        if kind in ('forbid_place', 'require_place'):
            if h['p'] in pi:
                hard.append({**h, 'p': pi[h['p']]})
        elif kind in ('forbid_pair', 'require_pair'):
            if h['p'] in pi and h['q'] in pi:
                hard.append({**h, 'p': pi[h['p']], 'q': pi[h['q']]})
        elif kind == 'owner_if_open':
            members = owner_members(h)
            if members is not None:
                hard.append({**h, 'members': [pi[v] for v in members if v in pi]})
        else:
            members = [pi[v] for v in h['members'] if v in pi]
            if members:
                hard.append({**h, 'members': members})
    soft = []
    for e in raw['soft_counts']:
        members = [pi[v] for v in e['members'] if v in pi]
        if members:
            soft.append({**e, 'members': members})
    return {
        'version': 2,
        'people': [None] * len(keep),  # counted, never read
        'options': options,
        'slots': [{'option': pb.slot_opt[s]} for s in slots],
        'size': {'min': pb.size_min, 'max': pb.size_max, 'larger': pb.larger, 'smaller': pb.smaller},
        'team_count': {'min': pb.tc_min, 'max': pb.tc_max},
        'place': [{'p': pi[e['p']], 'o': e['o'], 'cost': e['cost']}
                  for e in raw['place'] if e['p'] in pi],
        'pair': [{'p': pi[e['p']], 'q': pi[e['q']], 'cost': e['cost']}
                 for e in raw['pair'] if e['p'] in pi and e['q'] in pi],
        'hard': hard,
        'soft_counts': soft,
        'balance': [{**e, 'values': [e['values'][p] for p in keep]} for e in raw['balance']],
        'worst_off_weight': pb.worst_off_weight,
        'time_limit_s': pb.time_limit_s,
        'seed': pb.seed,
    }


def solve_group(pb, workers=2, progress_out=None, stop_after_first=False):
    """Two CP-SAT solves in sequence; returns (result, stage-1 teams in original indices or None).

    Stage 1: everyone NOT in group.members (R), alone, on every slot, with the problem's own terms,
      worst-off weight and size caps (size.larger / size.smaller). Its number of open slots is
      reserved for stage 2 under the group's src: at least tc_min - k2_max, at most tc_max - k2_min
      (group_team_counts; unconditionally 0..tc_max), so an exact team count can't be used up by R,
      and a core can say so. owner_if_open keeps its members in R (someone in the group can't make a
      stage-1 option open). Progress lines are stage 1's. Time: the limit minus a reserve of
      max(1 s, 10%), at least half the limit.
    Stage 2: the group members (G) only, only on slots stage 1 left empty whose option has a non-null
      option_cost, with option_cost added to each member's place cost. Forced-open options become
      'auto' (stage 1 opened them); team_count = [max(0, tc_min - used), tc_max - used]; size caps =
      group.larger / group.smaller (the group's own, whatever stage 1 used); no worst-off term; an
      owner_if_open that stage 1 met (one of its members on o) is dropped, otherwise it keeps its
      members in G (none: o can't open in stage 2). Time: what is left, at least 1 s. Nothing stage 1
      placed is revisited.
    Result: teams of both stages; objective = both objectives; bound = stage 1's bound + stage 2's
    objective when stage 2 is OPTIMAL, else null; OPTIMAL only when both are. Stage 2 INFEASIBLE ->
    INFEASIBLE with core [group src], 'complete'. A require_pair between G and R can never hold ->
    INFEASIBLE with core [its src, group src] before any solve."""
    start = time.monotonic()
    gsrc, G, costs = pb.group
    in_group = set(G)
    res = _result(pb)
    first = {'status': 'UNKNOWN', 'objective': None, 'bound': None}
    res['stages'] = {'first': first, 'second': None}

    def done(status, core=None, core_status='n/a'):
        res['status'] = status
        if core is not None:
            res['core'], res['core_status'] = core, core_status
        res['wall_s'] = round(time.monotonic() - T0, 3)
        return res

    too_big = magnitude_problem(pb)
    if too_big is not None:
        first['status'] = 'MODEL_INVALID'
        res['message'] = too_big
        return done('MODEL_INVALID'), None
    for h in pb.hard:
        if h[0] == 'require_pair' and (h[2] in in_group) != (h[3] in in_group):
            first['status'] = 'INFEASIBLE'
            return done('INFEASIBLE', [h[1]] + ([gsrc] if h[1] != gsrc else []), 'complete'), None

    # ---- stage 1 ----
    T = pb.time_limit_s
    R = [p for p in range(pb.n) if p not in in_group]
    raw1 = _stage_raw(pb, R, list(range(pb.n_slots)), lambda h: h['members'])
    raw1['team_count'] = {'min': 0, 'max': pb.tc_max}
    raw1['time_limit_s'] = max(T - max(1.0, 0.1 * T), 0.5 * T)
    pb1 = Problem(raw1)
    k2_min, k2_max = group_team_counts(pb)
    lo1, hi1 = max(0, pb.tc_min - k2_max), pb.tc_max - k2_min
    if lo1 > 0 or hi1 < pb.tc_max:
        pb1.reserve_count(lo1, hi1, gsrc)
    r1 = solve_single(pb1, workers, progress_out, stop_after_first)
    first.update(status=r1['status'], objective=r1['objective'], bound=r1['bound'])
    res['stats']['build_s'] = r1['stats']['build_s']
    if r1['status'] not in ('OPTIMAL', 'FEASIBLE'):
        if 'message' in r1:
            res['message'] = r1['message']
        return done(r1['status'], r1['core'], r1['core_status']), None
    stage1 = [{'slot': t['slot'], 'members': [R[i] for i in t['members']]} for t in r1['teams']]

    # ---- stage 2 ----
    used = {t['slot'] for t in stage1}
    placed = {(v, pb.slot_opt[t['slot']]) for t in stage1 for v in t['members']}
    free = [s for s in range(pb.n_slots) if s not in used and costs[pb.slot_opt[s]] is not None]
    if not G:
        r2 = {'status': 'OPTIMAL', 'objective': 0, 'teams': []}
    elif not free:
        r2 = {'status': 'INFEASIBLE', 'objective': None, 'teams': []}
    else:
        def owner2(h):
            if any((v, h['o']) in placed for v in h['members']):
                return None
            return h['members']

        raw2 = _stage_raw(pb, G, free, owner2)
        for opt in raw2['options']:
            if opt['open'] == 'open':
                opt['open'] = 'auto'
        raw2['size']['larger'] = pb.group_larger
        raw2['size']['smaller'] = pb.group_smaller
        raw2['team_count'] = {'min': max(0, pb.tc_min - len(used)), 'max': max(0, pb.tc_max - len(used))}
        raw2['place'] += [{'p': i, 'o': o, 'cost': c}
                          for i in range(len(G)) for o, c in enumerate(costs) if c]
        raw2['worst_off_weight'] = 0
        raw2['time_limit_s'] = max(1.0, T - (time.monotonic() - start))
        r2 = solve_single(Problem(raw2), workers, None, stop_after_first, explain=False)
        res['stats']['build_s'] = round(res['stats']['build_s'] + r2['stats']['build_s'], 3)
    res['stages']['second'] = {'status': r2['status'], 'objective': r2['objective']}
    if r2['status'] == 'INFEASIBLE':
        return done('INFEASIBLE', [gsrc], 'complete'), stage1
    if r2['status'] not in ('OPTIMAL', 'FEASIBLE'):
        if 'message' in r2:
            res['message'] = r2['message']
        return done(r2['status']), stage1
    teams = stage1 + [{'slot': free[t['slot']], 'members': [G[i] for i in t['members']]}
                      for t in r2['teams']]
    res['teams'] = sorted(teams, key=lambda t: t['slot'])
    res['objective'] = r1['objective'] + r2['objective']
    both = r1['status'] == 'OPTIMAL' and r2['status'] == 'OPTIMAL'
    res['bound'] = (r1['bound'] + r2['objective']
                    if r2['status'] == 'OPTIMAL' and r1['bound'] is not None else None)
    return done('OPTIMAL' if both else 'FEASIBLE'), stage1


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
    # A group member adds their option's option_cost; the worst-off term is over everyone else.
    group = problem.get('group')
    members = set(group['members']) if group else set()
    for p in members:
        total += group['option_cost'][opt[p]] or 0
    rest = [pc[p] for p in range(N) if p not in members]
    if rest:
        total += problem['worst_off_weight'] * max(rest)
    return total


def score_parts(problem, teams):
    """(stage 1, stage 2) split of score() for a group problem, summed team by team: an open team's
    own terms (place, pairs inside it, counts, balance) go to the stage of its members, the worst-off
    term to stage 1, option_cost to stage 2."""
    group = problem['group']
    members = set(group['members'])
    place = {}
    for e in problem['place']:
        place[(e['p'], e['o'])] = place.get((e['p'], e['o']), 0) + e['cost']
    parts = [0, 0]
    rest = []
    for t in teams:
        ms = t['members']
        if not ms:
            continue
        o = problem['slots'][t['slot']]['option']
        second = ms[0] in members
        own = [place.get((p, o), 0) for p in ms]
        v = sum(own)
        inside = set(ms)
        v += sum(e['cost'] for e in problem['pair'] if e['p'] in inside and e['q'] in inside)
        for e in problem['soft_counts']:
            cnt = len(inside & set(e['members']))
            if (e.get('not_one') and cnt == 1) or (e.get('max') is not None and cnt > e['max']):
                v += e['weight']
        for e in problem['balance']:
            v += e['weight'] * abs(sum(e['values'][m] for m in ms))
        if second:
            v += len(ms) * (group['option_cost'][o] or 0)
        else:
            rest += own
        parts[1 if second else 0] += v
    if rest:
        parts[0] += problem['worst_off_weight'] * max(rest)
    return tuple(parts)


def violations(problem, teams, srcs=None):
    """Structural + hard violations. srcs: when given, only constraints whose src is in it are checked
    (used to verify cores): hard entries, forced-open options, an option's own size (the loose bounds
    hold when its src is left out) and a stage-1 oracle's count reservation (`_reserve`). A team may be
    one over its max or one under its min (never below 2); how many may is capped per stage: a team
    made only of group members counts against group.larger / group.smaller, any other team against
    size.larger / size.smaller."""
    out = []

    def active(src):
        return srcs is None or src in srcs

    N = len(problem['people'])
    slot_of = {}
    for t in teams:
        for v in t['members']:
            if v in slot_of:
                return ['person twice']
            slot_of[v] = t['slot']
    if len(slot_of) != N:
        return ['person unassigned']
    if len({t['slot'] for t in teams}) != len(teams):
        return ['slot twice']
    size = problem['size']
    group = problem.get('group')
    in_group = set(group['members']) if group else set()
    caps = [(size['larger'], size.get('smaller', 0)),
            ((group or {}).get('larger', 0), (group or {}).get('smaller', 0))]
    over, under = [0, 0], [0, 0]

    for t in teams:
        n = len(t['members'])
        if n == 0:
            continue
        stage = 1 if group and all(v in in_group for v in t['members']) else 0

        def fits(n, lo, hi, cap=caps[stage][1]):
            # One under the min only where the stage allows smaller teams (the engine has no
            # shrink variable otherwise).
            return lo <= n <= hi + 1 or (cap > 0 and n == lo - 1 and shrinks(lo))

        opt = problem['options'][problem['slots'][t['slot']]['option']]
        lo, hi = size['min'], size['max']
        own = opt.get('size')
        if own is not None:
            lo, hi = min(lo, own['min']), max(hi, own['max'])
            if not fits(n, lo, hi):
                return ['size']
            src = f"size:{opt['id']}"
            if active(src):
                lo, hi = own['min'], own['max']
                if not fits(n, lo, hi):
                    out.append(src)
                    continue
        elif not fits(n, lo, hi):
            return ['size']
        if n == hi + 1:
            over[stage] += 1
        elif n == lo - 1:
            under[stage] += 1
    if any(over[i] > caps[i][0] or under[i] > caps[i][1] for i in (0, 1)):
        return ['larger']
    open_slots = {t['slot'] for t in teams if t['members']}
    if not problem['team_count']['min'] <= len(open_slots) <= problem['team_count']['max']:
        return ['team_count']
    reserve = problem.get('_reserve')
    if reserve and active(reserve['src']) and not reserve['min'] <= len(open_slots) <= reserve['max']:
        out.append(reserve['src'])
    open_opts = {problem['slots'][s]['option'] for s in open_slots}
    for o, opt in enumerate(problem['options']):
        src = f"option:{opt['id']}"
        if opt['open'] == 'open' and o not in open_opts and active(src):
            out.append(src)

    def option_of(p):
        return problem['slots'][slot_of[p]]['option']

    for h in problem['hard']:
        if not active(h['src']):
            continue
        k = h['kind']
        if k == 'forbid_place' and option_of(h['p']) == h['o']:
            out.append(h['src'])
        elif k == 'require_place' and option_of(h['p']) != h['o']:
            out.append(h['src'])
        elif k == 'forbid_pair' and slot_of[h['p']] == slot_of[h['q']]:
            out.append(h['src'])
        elif k == 'require_pair' and slot_of[h['p']] != slot_of[h['q']]:
            out.append(h['src'])
        elif k == 'owner_if_open':
            if h['o'] in open_opts and not any(option_of(v) == h['o'] for v in h['members']):
                out.append(h['src'])
        elif k == 'team_count':
            ms = set(h['members'])
            for t in teams:
                cnt = sum(1 for v in t['members'] if v in ms)
                if (h.get('not_one') and cnt == 1) or (h.get('max') is not None and cnt > h['max']):
                    out.append(h['src'])
                    break
    group = problem.get('group')
    if group:
        ms = set(group['members'])
        for t in teams:
            inside = [v in ms for v in t['members']]
            if any(inside) and (not all(inside) or
                                group['option_cost'][problem['slots'][t['slot']]['option']] is None):
                out.append(group['src'])
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


def _ranked(pb, ranks, costs=(0, 10), other=100):
    """Place costs from picks: costs[i] for a person's i-th pick, `other` elsewhere (0s dropped)."""
    for p, picks in ranks.items():
        for o in range(len(pb['options'])):
            c = costs[picks.index(o)] if o in picks else other
            if c:
                pb['place'].append({'p': p, 'o': o, 'cost': c})


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


def fixture_big_option():
    """Option A takes teams of 2-4 while the set's teams are pairs. People 0-3 all want each other
    (-100 per pair), so the optimum puts all four on A: -600. With the set-wide K of the LP inequality
    (partners <= K * x, K = 1 for pairs) nobody on A could have three partners: -200 at best."""
    pb = _base(6, ['A', 'B'], [0, 1, 1], 2, 2)
    pb['version'] = 2
    pb['options'][0]['size'] = {'min': 2, 'max': 4}
    pb['pair'] = [{'p': p, 'q': q, 'cost': -100} for p in range(4) for q in range(p + 1, 4)]
    return pb


def fixture_size_infeasible():
    """Option A's own size is 3 while the set's teams are pairs: 4 people can't be split 3 + 1, 4 + 0
    or 0 + 4. With A at its loose bounds (2-3) they fit 2 + 2, so the core is A's size alone."""
    pb = _base(4, ['A', 'B'], [0, 1], 2, 2)
    pb['version'] = 2
    pb['options'][0]['size'] = {'min': 3, 'max': 3}
    return pb, ['size:A']


def fixture_owner():
    """Option X was pitched by person 0 alone, and a pin keeps 0 on Y. People 2 and 3 want X (0), then
    Z (40), then Y (60). owner_if_open keeps X closed, so 2 and 3 take Z: 30 + 80 = 110 (30 without
    the rule, with 2 and 3 on X)."""
    pb = _base(4, ['X', 'Y', 'Z'], [0, 1, 2], 2, 2)
    pb['version'] = 2
    pb['place'] = [{'p': 0, 'o': 1, 'cost': 30}, {'p': 0, 'o': 2, 'cost': 30},
                   {'p': 1, 'o': 0, 'cost': 50}, {'p': 1, 'o': 2, 'cost': 50},
                   {'p': 2, 'o': 1, 'cost': 60}, {'p': 2, 'o': 2, 'cost': 40},
                   {'p': 3, 'o': 1, 'cost': 60}, {'p': 3, 'o': 2, 'cost': 40}]
    pb['hard'] = [{'kind': 'owner_if_open', 'src': 'f7:owner', 'o': 0, 'members': [0]},
                  {'kind': 'require_place', 'src': 'pin:p1', 'p': 0, 'o': 1}]
    return pb


def fixture_owner_infeasible():
    """fixture_owner with X forced open: X must open, needs its pitcher 0, and the pin keeps 0 on Y.
    Dropping any one of the three srcs makes it feasible."""
    pb = fixture_owner()
    pb['options'][0]['open'] = 'open'
    return pb, ['f7:owner', 'pin:p1', 'option:X']


def fixture_group():
    """Two-stage: people 5 and 6 didn't answer (the group). Options A (two slots), B, C, D; teams of
    2-3; option_cost A 0, B 1, C 2, D null (the group may not take D). Person 0 asked for 5 (-300), which
    can't count: 5 is seated in stage 2, never with a respondent. 5 and 6 pay their own pair cost 7."""
    pb = _base(7, ['A', 'B', 'C', 'D'], [0, 0, 1, 2, 3], 2, 3)
    pb['version'] = 2
    _ranked(pb, {0: [0, 1], 1: [0, 1], 2: [1, 0], 3: [1, 2], 4: [2, 1]})
    pb['pair'] = [{'p': 0, 'q': 5, 'cost': -300}, {'p': 5, 'q': 6, 'cost': 7},
                  {'p': 1, 'q': 2, 'cost': -40}]
    pb['worst_off_weight'] = 3
    pb['group'] = {'src': 'non_respondents', 'members': [5, 6], 'option_cost': [0, 1, 2, None]}
    return pb


def fixture_group_respondents():
    """fixture_group's stage 1 written out by hand: people 0-4 (the group is last, so nobody is
    renumbered), no group, no pair with 5, and the reserved team count: k2 = ceil(2/3) = 1 and
    floor(2/2) = 1, so at most 5 - 1 = 4 teams (and at least max(0, 1 - 1) = 0)."""
    pb = fixture_group()
    del pb['group']
    pb['people'] = pb['people'][:5]
    pb['pair'] = [e for e in pb['pair'] if e['q'] < 5]
    pb['team_count'] = {'min': 0, 'max': 4}
    return pb


def fixture_group_exact():
    """Exactly 2 teams, teams of 2-4, a group of 2: stage 1 gets [2 - 1, 2 - 1] = 1 team (k2 = 1), so
    the four respondents share one team, on B (0 and 1 pay 50 each; on A, 2 and 3 would pay 60 each),
    although two pairs would cost them 0. The group takes the most wanted option left: A (cost 1
    each; B's cost is 0, C's 2). Stage 1's optimum is unique, so stage 2's objective is fixed."""
    pb = _base(6, ['A', 'B', 'C'], [0, 1, 2], 2, 4, tc={'min': 2, 'max': 2})
    pb['version'] = 2
    _ranked(pb, {0: [0], 1: [0]}, costs=(0,), other=50)
    _ranked(pb, {2: [1], 3: [1]}, costs=(0,), other=60)
    pb['group'] = {'src': 'non_respondents', 'members': [4, 5], 'option_cost': [1, 0, 2]}
    return pb


def fixture_group_no_room():
    """Pairs. Stage 1 fills A and B (the options its people ranked); the one empty slot is on C,
    which has no option_cost, so the group can't be seated: INFEASIBLE, core ['non_respondents']."""
    pb = _base(6, ['A', 'B', 'C'], [0, 1, 2], 2, 2)
    pb['version'] = 2
    _ranked(pb, {0: [0], 1: [0], 2: [1], 3: [1]}, costs=(0,))
    pb['group'] = {'src': 'non_respondents', 'members': [4, 5], 'option_cost': [0, 1, None]}
    return pb


def fixture_group_reserve():
    """Pairs, 6 respondents and a group of 2 with at most 3 teams: stage 1 may use 3 - 1 = 2 teams but
    needs 3. Stage 1 is INFEASIBLE and its core is the reservation's src alone."""
    pb = _base(8, ['A', 'B', 'C', 'D'], [0, 1, 2, 3], 2, 2, tc={'min': 1, 'max': 3})
    pb['version'] = 2
    pb['group'] = {'src': 'non_respondents', 'members': [6, 7], 'option_cost': [0, 1, 2, 3]}
    return pb


def fixture_group_larger():
    """Pairs; 3 respondents and a group of 3, and each stage has its own team of 3 (size.larger 1
    for the respondents, group.larger 1 for the group). Stage 1 takes a team of 3 and stage 2 still
    has its own: both solve, a team of 3 each."""
    pb = _base(6, ['A', 'B', 'C'], [0, 1, 2], 2, 2, larger=1)
    pb['version'] = 2
    pb['group'] = {'src': 'non_respondents', 'members': [3, 4, 5], 'option_cost': [0, 1, 2],
                   'larger': 1, 'smaller': 0}
    return pb


def fixture_group_no_larger():
    """fixture_group_larger with no team of 3 for the group (group.larger 0): 3 people can't be
    split into pairs, so stage 2 is INFEASIBLE, core ['non_respondents']."""
    pb = fixture_group_larger()
    pb['group']['larger'] = 0
    return pb


def fixture_smaller():
    """Teams of 4 (free), 7 people, one team of 3 allowed (size.smaller 1): 4 + 3. People 0-3 want
    each other (-100 per pair): the optimum keeps them together (-600)."""
    pb = _base(7, ['__free__'], [0, 0], 4, 4)
    pb['version'] = 2
    pb['size']['smaller'] = 1
    pb['pair'] = [{'p': p, 'q': q, 'cost': -100} for p in range(4) for q in range(p + 1, 4)]
    return pb


def fixture_group_owner():
    """Pairs; X (two slots) was pitched by person 0, who is in stage 1 with 1 on X. Stage 1 met X's
    owner_if_open, so the group may take X's second slot (cost 0) rather than Y (cost 1 each)."""
    pb = _base(4, ['X', 'Y'], [0, 0, 1], 2, 2)
    pb['version'] = 2
    _ranked(pb, {0: [0], 1: [0]}, costs=(0,))
    pb['hard'] = [{'kind': 'owner_if_open', 'src': 'f7:owner', 'o': 0, 'members': [0]}]
    pb['group'] = {'src': 'non_respondents', 'members': [2, 3], 'option_cost': [0, 1]}
    return pb


def fixture_group_cross():
    """A must-together between a respondent (0) and a group member (5) can never hold."""
    pb = fixture_group()
    pb['hard'].append({'kind': 'require_pair', 'src': 'f1:together@0+5', 'p': 0, 'q': 5})
    return pb, ['f1:together@0+5', 'non_respondents']


def _stages(first, second, second_status='OPTIMAL'):
    """Expected `stages` with stage 1 OPTIMAL at `first` (bound = objective)."""
    return {'first': {'status': 'OPTIMAL', 'objective': first, 'bound': first},
            'second': {'status': second_status, 'objective': second}}


ANY = '*'  # in FIXTURE_EXPECTED: not pinned


def _matches(want, got):
    if want == ANY:
        return True
    if isinstance(want, dict):
        return isinstance(got, dict) and sorted(want) == sorted(got) and all(
            _matches(want[k], got[k]) for k in want)
    return want == got


# fixtures/*.json and what --workers 2 gives: (status, objective, core, stages or None). The first
# eight are version 1 and must keep these results; free-60-balance is left out (FEASIBLE at its limit).
# A stage-2 objective is pinned only where it is the same for every optimal stage 1 (checked by
# enumeration for the small ones; for pairs-60x30-group, stage 1 with the unranked option forced open
# is proven worse, 32414 against 13192, so stage 1 never uses it).
FIXTURE_EXPECTED = {
    'pairs-small': ('OPTIMAL', 94, [], None),
    'free-small': ('OPTIMAL', 750, [], None),
    'balance-small': ('OPTIMAL', 0, [], None),
    'infeasible-must-pair': ('INFEASIBLE', None, ['f1:together', 'pin:p1'], None),
    'capacity-structural': ('INFEASIBLE', None, [], None),
    'pairs-27x20': ('OPTIMAL', 10200, [], None),
    'pairs-60x30': ('OPTIMAL', 13322, [], None),
    'free-60-teams-of-4': ('OPTIMAL', -11668, [], None),
    'sizes-over-max': ('OPTIMAL', -600, [], None),
    'size-infeasible': ('INFEASIBLE', None, ['size:A'], None),
    'owner-if-open': ('OPTIMAL', 110, [], None),
    'owner-if-open-infeasible': ('INFEASIBLE', None, ['f7:owner', 'pin:p1', 'option:X'], None),
    'group-small': ('OPTIMAL', 17, [], _stages(10, 7)),
    'group-exact-count': ('OPTIMAL', 102, [], _stages(100, 2)),
    'group-no-room': ('INFEASIBLE', None, ['non_respondents'], _stages(0, None, 'INFEASIBLE')),
    'pairs-27x20-group': ('OPTIMAL', ANY, [], _stages(10468, ANY)),
    'pairs-60x30-group': ('INFEASIBLE', None, ['non_respondents'], _stages(13192, None, 'INFEASIBLE')),
}


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


def random_problem_v2(rng):
    """random_problem plus version 2: options with their own size (min and max each above or below
    the set's; a min of 3 or 4 may shrink), a cap on smaller teams now and then, and owner_if_open
    entries (members may be empty)."""
    pb = random_problem(rng)
    pb['version'] = 2
    n, n_opt = len(pb['people']), len(pb['options'])
    for opt in pb['options']:
        if rng.random() < 0.5:
            lo = rng.randint(1, 4)
            opt['size'] = {'min': lo, 'max': lo + rng.randint(0, 3)}
    if rng.random() < 0.4:
        pb['size']['smaller'] = rng.randint(1, 2)
    for _ in range(rng.randint(0, 2)):
        pb['hard'].append({'kind': 'owner_if_open', 'src': rng.choice(['r4:owner', 'r5:owner']),
                           'o': rng.randrange(n_opt),
                           'members': sorted(rng.sample(range(n), rng.randint(0, min(2, n))))})
    return pb


def random_group_problem(rng):
    """Tiny random group problem with room for both stages most of the time (enumerable: stage 1 is
    slots**respondents <= 5**5): 2-3 options, 3-5 slots, 1-3 group members (now and then everyone),
    option_cost with some nulls, own sizes, forced-open and closed options, a user-set team count
    now and then, each stage's own larger / smaller caps, cross-stage pairs and counts, and no
    require_pair across the group's edge (compile never emits one)."""
    n_opt = rng.randint(2, 3)
    slots = sorted(list(range(n_opt)) + [rng.randrange(n_opt) for _ in range(rng.randint(0, 5 - n_opt))])
    S = len(slots)
    k = rng.randint(1, 3)
    n = k + rng.randint(0 if rng.random() < 0.05 else 1, 5)
    mn = rng.randint(1, 2)
    mx = mn + rng.randint(0, 2)
    tc_min = 1 if rng.random() < 0.7 else rng.randint(1, S)
    tc = {'min': tc_min, 'max': S if rng.random() < 0.7 else rng.randint(tc_min, S)}
    pb = _base(n, [f'o{i}' for i in range(n_opt)], slots, mn, mx, larger=rng.choice([0, 1, 1]), tc=tc)
    pb['version'] = 2
    pb['seed'] = rng.randint(0, 10 ** 9)
    members = sorted(rng.sample(range(n), k))
    in_group = set(members)
    rest = [p for p in range(n) if p not in in_group]
    costs = []
    for o in range(n_opt):
        r = rng.random()
        if r < 0.1:
            pb['options'][o]['open'] = 'open'
        elif r < 0.2:
            pb['options'][o]['open'] = 'closed'
            pb['hard'] += [{'kind': 'forbid_place', 'src': f'option:o{o}', 'p': p, 'o': o} for p in range(n)]
        if rng.random() < 0.3:
            lo = rng.randint(1, 3)
            pb['options'][o]['size'] = {'min': lo, 'max': lo + rng.randint(0, 2)}
        closed = pb['options'][o]['open'] == 'closed'
        costs.append(None if closed or rng.random() < 0.2 else rng.randint(0, n_opt))
    pb['group'] = {'src': 'non_respondents', 'members': members, 'option_cost': costs,
                   'larger': rng.choice([0, 1, 1]), 'smaller': rng.choice([0, 0, 1])}
    if rng.random() < 0.3:
        pb['size']['smaller'] = 1
    for _ in range(rng.randint(0, 2 * n)):
        who = rng.choice(rest) if rest and rng.random() < 0.85 else rng.randrange(n)
        pb['place'].append({'p': who, 'o': rng.randrange(n_opt), 'cost': rng.randint(-60, 100)})
    for _ in range(rng.randint(0, n) if n >= 2 else 0):
        p, q = sorted(rng.sample(range(n), 2))
        pb['pair'].append({'p': p, 'q': q, 'cost': rng.randint(-80, 80)})
    if rest and rng.random() < 0.3:
        pb['hard'].append({'kind': 'require_place', 'src': 'pin:p1', 'p': rng.choice(rest),
                           'o': rng.randrange(n_opt)})
    if len(rest) >= 2 and rng.random() < 0.3:
        p, q = sorted(rng.sample(rest, 2))
        pb['hard'].append({'kind': rng.choice(['require_pair', 'forbid_pair']), 'src': 'r1:together@0+1',
                           'p': p, 'q': q})
    if rng.random() < 0.3:
        pb['hard'].append({'kind': 'owner_if_open', 'src': 'r4:owner', 'o': rng.randrange(n_opt),
                           'members': sorted(rng.sample(range(n), rng.randint(0, min(2, n))))})
    if n >= 2 and rng.random() < 0.3:
        pb['hard'].append({'kind': 'team_count', 'src': 'r3:no_one_alone',
                           'members': sorted(rng.sample(range(n), rng.randint(2, n))), 'not_one': True})
    if rng.random() < 0.4:
        e = {'src': 'soft', 'members': sorted(rng.sample(range(n), rng.randint(1, n))),
             'weight': rng.randint(-20, 90), 'not_one': True}
        if rng.random() < 0.5:
            e['max'] = rng.randint(0, 2)
        pb['soft_counts'].append(e)
    if rng.random() < 0.3:
        pb['balance'].append({'src': 'bal', 'values': [rng.randint(-4, 4) * 25 for _ in range(n)],
                              'weight': rng.randint(1, 3)})
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


def stage1_problem(problem):
    """Oracle for stage 1 of a group problem, written apart from the engine's _stage_raw: the problem
    without the group's members (the rest renumbered in order), their pairs and entries dropped,
    counts and balance restricted, owner_if_open kept with its non-members, team_count 0..max and the
    reservation (same formula as group_team_counts) as `_reserve` for violations()."""
    g = problem['group']
    gone = set(g['members'])
    keep = [p for p in range(len(problem['people'])) if p not in gone]
    new = {p: i for i, p in enumerate(keep)}
    out = {k: problem[k] for k in ('options', 'slots', 'size', 'worst_off_weight', 'time_limit_s', 'seed')}
    out['version'] = 2
    out['people'] = [problem['people'][p] for p in keep]
    out['team_count'] = {'min': 0, 'max': problem['team_count']['max']}
    out['place'] = [dict(e, p=new[e['p']]) for e in problem['place'] if e['p'] in new]
    out['pair'] = [dict(e, p=new[e['p']], q=new[e['q']]) for e in problem['pair']
                   if e['p'] in new and e['q'] in new]
    out['hard'] = []
    for h in problem['hard']:
        if h['kind'] in ('team_count', 'owner_if_open'):
            out['hard'].append(dict(h, members=[new[v] for v in h['members'] if v in new]))
        elif 'q' in h:
            if h['p'] in new and h['q'] in new:
                out['hard'].append(dict(h, p=new[h['p']], q=new[h['q']]))
        elif h['p'] in new:
            out['hard'].append(dict(h, p=new[h['p']]))
    out['soft_counts'] = [dict(e, members=[new[v] for v in e['members'] if v in new])
                          for e in problem['soft_counts']]
    out['balance'] = [dict(e, values=[e['values'][p] for p in keep]) for e in problem['balance']]
    # Owner-only options (an owner_if_open naming nobody in the group, on an option stage 1 doesn't
    # surely open: not forced open, no require_place for a respondent on it) don't count.
    opened = {o for o, opt in enumerate(problem['options']) if opt['open'] == 'open'}
    opened |= {h['o'] for h in problem['hard'] if h['kind'] == 'require_place' and h['p'] not in gone}
    owner_only = {h['o'] for h in problem['hard'] if h['kind'] == 'owner_if_open'
                  and h['o'] not in opened and not gone.intersection(h['members'])}
    sizes = [problem['options'][o].get('size') or problem['size']
             for o, c in enumerate(g['option_cost']) if c is not None and o not in owner_only]
    k = len(g['members'])
    if k and sizes:
        gmax, gmin = max(s['max'] for s in sizes), min(s['min'] for s in sizes)
        k2_min = max(math.ceil(k / (gmax + 1)), math.ceil((k - g.get('larger', 0)) / gmax))
        k2_max = (k + g.get('smaller', 0)) // gmin
    else:
        k2_min, k2_max = 0, 0
    tc = problem['team_count']
    lo, hi = max(0, tc['min'] - k2_max), tc['max'] - k2_min
    if lo > 0 or hi < tc['max']:
        out['_reserve'] = {'src': g['src'], 'min': lo, 'max': hi}
    return out


def brute_stage2(problem, stage1):
    """Best stage-2 part of the score given stage 1's teams: every way to put the group's members on
    slots stage 1 left empty whose option has an option_cost, kept when the whole assignment breaks
    nothing. None = no way."""
    g = problem['group']
    used = {t['slot'] for t in stage1 if t['members']}
    free = [s for s, slot in enumerate(problem['slots'])
            if s not in used and g['option_cost'][slot['option']] is not None]
    best = None
    for assign in itertools.product(free, repeat=len(g['members'])):
        groups = {}
        for p, s in zip(g['members'], assign):
            groups.setdefault(s, []).append(p)
        teams = stage1 + [{'slot': s, 'members': groups[s]} for s in sorted(groups)]
        if violations(problem, teams):
            continue
        v = score_parts(problem, teams)[1]
        if best is None or v < best:
            best = v
    return best


def selftest():
    global MAX_LP_ONLY_CELLS, PHASE1_STOP_AFTER_FIRST, SELFTEST_GLOBAL_K, _run_phase
    default_cells = MAX_LP_ONLY_CELLS
    failures = []
    tally = {}

    def check(cond, msg):
        if not cond:
            failures.append(msg)

    def check_fields(name, r, group=False):
        check(r['engine'] == ENGINE and r['engine'].startswith('cpsat@'), f'{name}: engine {r["engine"]}')
        st = r['stats']
        check(sorted(st) == ['build_s', 'pairs', 'people', 'slots']
              and all(isinstance(v, (int, float)) and v >= 0 for v in st.values()),
              f'{name}: stats {st}')
        want_cs = ('complete', 'timeout') if r['status'] == 'INFEASIBLE' else ('n/a',)
        check(r['core_status'] in want_cs, f'{name}: core_status {r["core_status"]} for {r["status"]}')
        check(('message' in r) == (r['status'] == 'MODEL_INVALID'), f'{name}: message presence')
        check(('stages' in r) == group, f'{name}: stages presence')
        if 'stages' not in r:
            return
        stages = r['stages']
        first, second = stages.get('first'), stages.get('second')
        check(sorted(stages) == ['first', 'second'] and isinstance(first, dict)
              and sorted(first) == ['bound', 'objective', 'status'] and first['status'] in STATUS_NAMES
              and (second is None or (isinstance(second, dict) and sorted(second) == ['objective', 'status']
                                      and second['status'] in STATUS_NAMES)),
              f'{name}: stages shape {stages}')
        if r['objective'] is not None:
            check(second is not None and first['objective'] + second['objective'] == r['objective'],
                  f'{name}: stages {stages} vs objective {r["objective"]}')
        if r['status'] == 'OPTIMAL':
            check(first['status'] == 'OPTIMAL' and second is not None and second['status'] == 'OPTIMAL',
                  f'{name}: OPTIMAL with stages {stages}')

    def copy(raw):
        return json.loads(json.dumps(raw))

    def run(raw, workers=2, first=False, name='run'):
        r = solve(Problem(copy(raw)), workers=workers, stop_after_first=first)
        check_fields(name, r, 'group' in raw)
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

    def check_core(tag, raw, r):
        """r is INFEASIBLE: its core must be complete, sufficient and minimal against `raw`."""
        check(r['core_status'] == 'complete', f'{tag}: core_status {r["core_status"]}')
        core = set(r['core'])
        check(brute(raw, core, find_any=True) is None, f'{tag}: core {sorted(core)} not infeasible')
        for c in core:
            check(brute(raw, core - {c}, find_any=True) is not None,
                  f'{tag}: core {sorted(core)} not minimal ({c})')

    def random_case(raw, tag, workers, kind):
        opt = brute(raw)
        r = run(raw, workers=workers, name=tag)
        if opt is None:
            tally[kind + '_infeasible'] = tally.get(kind + '_infeasible', 0) + 1
            check(r['status'] == 'INFEASIBLE', f'{tag}: brute infeasible, solver {r["status"]}')
            if r['status'] == 'INFEASIBLE':
                check_core(tag, raw, r)
        else:
            tally[kind + '_feasible'] = tally.get(kind + '_feasible', 0) + 1
            check(r['status'] == 'OPTIMAL', f'{tag}: status {r["status"]} (brute {opt})')
            if r['teams']:
                check(not violations(raw, r['teams']), f'{tag}: violations')
                check(score(raw, r['teams']) == r['objective'], f'{tag}: objective != rescored')
                check(r['objective'] == opt, f'{tag}: objective {r["objective"]} != brute {opt}')
            f = run(raw, first=True, name=tag)
            if f['teams']:
                check(score(raw, f['teams']) == f['objective'], f'{tag}: first-solution objective != rescored')

    def group_case(raw, tag, workers=2):
        """Two-stage checks against the oracles: stage 1 against brute force on the problem without
        the group, stage 2 against brute force given the engine's own stage 1. Returns 'solved',
        'stage1_infeasible' or 'stage2_infeasible'."""
        g = raw['group']
        in_group = set(g['members'])
        r, stage1 = solve_group(Problem(copy(raw)), workers=workers)
        check_fields(tag, r, True)
        first, second = r['stages']['first'], r['stages']['second']
        s1 = stage1_problem(raw)
        opt1 = brute(s1)
        if opt1 is None:
            check(r['status'] == 'INFEASIBLE' and first['status'] == 'INFEASIBLE' and second is None
                  and r['teams'] == [], f'{tag}: stage 1 brute infeasible, engine {r["status"]} {r["stages"]}')
            if r['status'] == 'INFEASIBLE':
                check_core(tag, s1, r)
            return 'stage1_infeasible'
        check(first['status'] == 'OPTIMAL' and first['objective'] == opt1 and stage1 is not None,
              f'{tag}: stage 1 {first} != brute {opt1}')
        if stage1 is None:
            return 'solved'
        new = {p: i for i, p in enumerate(p for p in range(len(raw['people'])) if p not in in_group)}
        s1_teams = [{'slot': t['slot'], 'members': [new[p] for p in t['members']]} for t in stage1]
        check(not violations(s1, s1_teams) and score(s1, s1_teams) == first['objective'],
              f'{tag}: stage-1 teams {stage1} break the stage-1 problem or its score')
        opt2 = brute_stage2(raw, stage1)
        if opt2 is None:
            check(r['status'] == 'INFEASIBLE' and r['core'] == [g['src']] and r['core_status'] == 'complete'
                  and second is not None and second['status'] == 'INFEASIBLE' and r['teams'] == [],
                  f'{tag}: stage 2 brute infeasible, engine {r["status"]} {r["core"]} {r["stages"]}')
            return 'stage2_infeasible'
        check(r['status'] == 'OPTIMAL' and second['objective'] == opt2,
              f'{tag}: {r["status"]} stage 2 {second} != brute {opt2}')
        if r['teams']:
            check(not violations(raw, r['teams']), f'{tag}: violations {violations(raw, r["teams"])}')
            check(score(raw, r['teams']) == r['objective'], f'{tag}: objective != rescored')
            check(score_parts(raw, r['teams']) == (first['objective'], second['objective']),
                  f'{tag}: parts {score_parts(raw, r["teams"])} != stages {r["stages"]}')
            kept = [t for t in r['teams'] if not in_group & set(t['members'])]
            check(kept == sorted(stage1, key=lambda t: t['slot']), f'{tag}: stage-1 teams changed')
        f, _ = solve_group(Problem(copy(raw)), workers=workers, stop_after_first=True)
        check_fields(tag + ' first', f, True)
        if f['teams']:
            check(score(raw, f['teams']) == f['objective']
                  and score_parts(raw, f['teams']) == (f['stages']['first']['objective'],
                                                       f['stages']['second']['objective']),
                  f'{tag}: first-solution objective or parts != rescored')
        return 'solved'

    # ---- version 1: hand-built fixtures ----
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
    for i in range(300):
        raw = random_problem(rng)
        # Exercise every search plan: default then max_lp (i%3==0), a forced hand-off where phase 1 stops
        # at its first solution and max_lp continues from the hint (1), and max_lp alone (2).
        PHASE1_STOP_AFTER_FIRST = i % 3 == 1
        MAX_LP_ONLY_CELLS = 0 if i % 3 == 2 else default_cells
        random_case(raw, f'random#{i}', rng.choice([1, 2]), 'random')
    PHASE1_STOP_AFTER_FIRST = False
    MAX_LP_ONLY_CELLS = default_cells

    # ---- the fixture files give the results the README lists (the version-1 ones as before) ----
    here = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'fixtures')
    for name, (status, objective, core, stages) in FIXTURE_EXPECTED.items():
        with open(os.path.join(here, name + '.json'), encoding='utf-8') as f:
            raw = json.load(f)
        r = run(raw, name=name)
        check(r['status'] == status and _matches(objective, r['objective']) and sorted(r['core']) == sorted(core),
              f'fixture {name}: {r["status"]} {r["objective"]} core {r["core"]}')
        check(_matches(stages, r.get('stages')), f'fixture {name}: stages {r.get("stages")}')
        if r['teams']:
            check(not violations(raw, r['teams']) and score(raw, r['teams']) == r['objective'],
                  f'fixture {name}: teams break the problem or its score')

    # ---- version 2: input checks ----
    v2 = fixture_pairs()
    v2['version'] = 2
    r1, r2 = run(fixture_pairs(), name='v1 pairs'), run(v2, name='v2 pairs')
    check((r2['status'], r2['objective']) == (r1['status'], r1['objective']) == ('OPTIMAL', 94),
          f'version 2 without its fields: {r2["status"]} {r2["objective"]}')
    group_ok = {'src': 'non_respondents', 'members': [6], 'option_cost': [0, 1, 2, None]}
    for label, change in [
        ('version 3', lambda p: p.update(version=3)),
        ('version true', lambda p: p.update(version=True)),
        ('version 1 with options[].size', lambda p: p['options'][0].update(size={'min': 2, 'max': 3})),
        ('version 1 with group', lambda p: p.update(group=group_ok)),
        ('size.min 0', lambda p: p.update(version=2) or p['options'][0].update(size={'min': 0, 'max': 3})),
        ('size.max < min', lambda p: p.update(version=2) or p['options'][0].update(size={'min': 3, 'max': 2})),
        ('version 1 with size.smaller', lambda p: p['size'].update(smaller=1)),
        ('size.smaller negative', lambda p: p.update(version=2) or p['size'].update(smaller=-1)),
        ('group.larger negative',
         lambda p: p.update(version=2, group=dict(group_ok, larger=-1))),
        ('option_cost length', lambda p: p.update(version=2, group=dict(group_ok, option_cost=[0]))),
        ('option_cost negative',
         lambda p: p.update(version=2, group=dict(group_ok, option_cost=[0, -1, 2, 3]))),
        ('group member out of range', lambda p: p.update(version=2, group=dict(group_ok, members=[7]))),
        ('owner_if_open o out of range',
         lambda p: p['hard'].append({'kind': 'owner_if_open', 'src': 'f7:owner', 'o': 4, 'members': []})),
        ('owner_if_open member out of range',
         lambda p: p['hard'].append({'kind': 'owner_if_open', 'src': 'f7:owner', 'o': 0, 'members': [7]})),
    ]:
        raw = fixture_pairs()
        change(raw)
        try:
            Problem(raw)
            check(False, f'bad input accepted: {label}')
        except BadInput:
            pass

    # ---- version 2: an option whose own max is above the set's needs its own K ----
    fk = fixture_big_option()
    want = brute(fk)
    r = verify_feasible('big-option', fk)
    check(want == -600 and r['objective'] == want, f'big-option: {r["objective"]}, brute {want}')
    check(any(len(t['members']) == 4 for t in r['teams']), f'big-option: no team of 4 in {r["teams"]}')
    SELFTEST_GLOBAL_K = True
    try:
        r = run(fk, name='big-option, set-wide K')
    finally:
        SELFTEST_GLOBAL_K = False
    check(r['objective'] is not None and r['objective'] > want,
          f'big-option: the set-wide K should lose the optimum, got {r["objective"]}')

    # ---- version 2: an option's own size in a core ----
    fs, want = fixture_size_infeasible()
    r = run(fs, name='size-infeasible')
    check(r['status'] == 'INFEASIBLE' and r['core'] == want and r['core_status'] == 'complete',
          f'size-infeasible: {r["status"]} core {r["core"]} {r["core_status"]}')
    check_core('size-infeasible', fs, r)

    # ---- owner_if_open ----
    fo = fixture_owner()
    r = verify_feasible('owner', fo)
    check(r['objective'] == brute(fo) == 110, f'owner: {r["objective"]}, brute {brute(fo)}')
    check(not any(fo['slots'][t['slot']]['option'] == 0 for t in r['teams']), f'owner: X open in {r["teams"]}')
    no_rule = copy(fo)
    no_rule['hard'] = [h for h in no_rule['hard'] if h['kind'] != 'owner_if_open']
    check(brute(no_rule) == 30, f'owner: without the rule brute gives {brute(no_rule)}')
    fo2, want = fixture_owner_infeasible()
    r = run(fo2, name='owner-infeasible')
    check(r['status'] == 'INFEASIBLE' and sorted(r['core']) == sorted(want),
          f'owner-infeasible: {r["status"]} core {r["core"]}')
    check_core('owner-infeasible', fo2, r)

    # ---- version 2: random sizes and owner_if_open against brute force ----
    rng2 = random.Random(20260926)
    for i in range(300):
        raw = random_problem_v2(rng2)
        PHASE1_STOP_AFTER_FIRST = i % 3 == 1
        MAX_LP_ONLY_CELLS = 0 if i % 3 == 2 else default_cells
        random_case(raw, f'v2#{i}', rng2.choice([1, 2]), 'random_v2')
    PHASE1_STOP_AFTER_FIRST = False
    MAX_LP_ONLY_CELLS = default_cells

    # ---- two-stage: hand-built cases ----
    fg = fixture_group()
    check(group_case(fg, 'group') == 'solved', 'group: not solved')
    r, stage1 = solve_group(Problem(copy(fg)))
    alone = fixture_group_respondents()
    ra = run(alone, name='group, respondents alone')
    check(r['stages']['first']['objective'] == ra['objective'] == brute(alone),
          f'group: stage 1 {r["stages"]["first"]} vs respondents alone {ra["objective"]} / {brute(alone)}')
    used = {t['slot'] for t in stage1}
    later = [t for t in r['teams'] if set(t['members']) <= {5, 6}]
    check(len(later) == 1 and later[0]['slot'] not in used
          and fg['group']['option_cost'][fg['slots'][later[0]['slot']]['option']] is not None,
          f'group: stage-2 teams {later} (stage 1 used {sorted(used)})')

    fe = fixture_group_exact()
    check(group_case(fe, 'group-exact') == 'solved', 'group-exact: not solved')
    r, _ = solve_group(Problem(copy(fe)))
    unreserved = copy(fe)
    del unreserved['group']
    unreserved['people'] = unreserved['people'][:4]
    unreserved['team_count'] = {'min': 1, 'max': 2}
    check(r['status'] == 'OPTIMAL' and len(r['teams']) == 2 and r['stages']['first']['objective'] == 100
          and r['stages']['second']['objective'] == 2 and brute(unreserved) == 0,
          f'group-exact: {r["status"]} {r["teams"]} {r["stages"]}')

    fn = fixture_group_no_room()
    check(group_case(fn, 'group-no-room') == 'stage2_infeasible', 'group-no-room: not a stage-2 failure')
    r = run(fn, name='group-no-room')
    check(r['core'] == ['non_respondents'] and r['stages']['first']['status'] == 'OPTIMAL',
          f'group-no-room: {r["core"]} {r["stages"]}')

    fr = fixture_group_reserve()
    check(group_case(fr, 'group-reserve') == 'stage1_infeasible', 'group-reserve: not a stage-1 failure')
    r = run(fr, name='group-reserve')
    check(r['status'] == 'INFEASIBLE' and r['core'] == ['non_respondents'] and r['core_status'] == 'complete'
          and r['stages']['second'] is None, f'group-reserve: {r["status"]} {r["core"]} {r["stages"]}')

    fl = fixture_group_larger()
    check(group_case(fl, 'group-larger') == 'solved', 'group-larger: not solved')
    r = run(fl, name='group-larger')
    check(r['status'] == 'OPTIMAL' and sorted(len(t['members']) for t in r['teams']) == [3, 3],
          f'group-larger: {r["status"]} {r["teams"]}')
    fnl = fixture_group_no_larger()
    check(group_case(fnl, 'group-no-larger') == 'stage2_infeasible',
          'group-no-larger: not a stage-2 failure')

    # ---- smaller teams: one team of min - 1, never below 2 ----
    fsm = fixture_smaller()
    r = verify_feasible('smaller', fsm)
    check(r['objective'] == brute(fsm) == -600 and sorted(len(t['members']) for t in r['teams']) == [3, 4],
          f'smaller: {r["objective"]} {r["teams"]} brute {brute(fsm)}')
    none = copy(fsm)
    none['size']['smaller'] = 0
    r = run(none, name='smaller, no cap')
    check(r['status'] == 'INFEASIBLE' and r['core'] == [], f'smaller, no cap: {r["status"]} {r["core"]}')
    pairs = copy(fsm)
    pairs['size'].update(min=2, max=2)
    pairs['people'] = pairs['people'][:5]
    pairs['pair'] = []
    pairs['slots'] = [{'option': 0}] * 3
    r = run(pairs, name='smaller pairs')
    check(r['status'] == 'INFEASIBLE', f'smaller pairs (a team of 1): {r["status"]} {r["teams"]}')

    fw = fixture_group_owner()
    check(group_case(fw, 'group-owner') == 'solved', 'group-owner: not solved')
    r = run(fw, name='group-owner')
    check(r['stages']['second']['objective'] == 0 and {'slot': 1, 'members': [2, 3]} in r['teams'],
          f'group-owner: {r["teams"]} {r["stages"]}')

    # group_team_counts leaves out an owner-only option: X (teams of 2-4) was pitched by 0 alone,
    # who answered, and nothing makes stage 1 open it, so a group of 4 counts on Y (pairs) only:
    # k2_min = 4 / 2 = 2. Counted again (k2_min = 4 / 4 = 1) once X always runs, once a respondent
    # must be on it, or once a group member pitched it too.
    fk = _base(6, ['X', 'Y'], [0, 0, 1, 1], 2, 2)
    fk['version'] = 2
    fk['options'][0]['size'] = {'min': 2, 'max': 4}
    fk['hard'] = [{'kind': 'owner_if_open', 'src': 'f7:owner', 'o': 0, 'members': [0]}]
    fk['group'] = {'src': 'non_respondents', 'members': [2, 3, 4, 5], 'option_cost': [0, 1]}
    k2 = group_team_counts(Problem(copy(fk)))
    check(k2 == (2, 2), f'group-counts owner-only: {k2}')
    for label, change in [
        ('always runs', lambda raw: raw['options'][0].update(open='open')),
        ('respondent due on it',
         lambda raw: raw['hard'].append({'kind': 'require_place', 'src': 'pin:p1', 'p': 1, 'o': 0})),
        ('group member pitched it', lambda raw: raw['hard'][0].update(members=[0, 2])),
    ]:
        raw = copy(fk)
        change(raw)
        k2 = group_team_counts(Problem(raw))
        check(k2 == (1, 2), f'group-counts {label}: {k2}')

    fc, want = fixture_group_cross()
    r = run(fc, name='group-cross')
    check(r['status'] == 'INFEASIBLE' and r['core'] == want and r['stages']['second'] is None,
          f'group-cross: {r["status"]} {r["core"]} {r["stages"]}')

    # ---- two-stage: random problems against the two oracles ----
    rng3 = random.Random(20260927)
    for i in range(300):
        raw = random_group_problem(rng3)
        PHASE1_STOP_AFTER_FIRST = i % 3 == 1
        MAX_LP_ONLY_CELLS = 0 if i % 3 == 2 else default_cells
        key = 'group_' + group_case(raw, f'group#{i}', rng3.choice([1, 2]))
        tally[key] = tally.get(key, 0) + 1
    PHASE1_STOP_AFTER_FIRST = False
    MAX_LP_ONLY_CELLS = default_cells

    for m in failures:
        sys.stderr.write('FAIL ' + m + '\n')
    print(json.dumps({'type': 'selftest', 'ok': not failures, 'failures': len(failures),
                      **dict(sorted(tally.items())), 'wall_s': round(time.monotonic() - T0, 2)}))
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
