import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useRevalidator } from 'react-router';
import { TriggerAuthContext, useApiClient } from '@trigger.dev/react-hooks';

import { FetcherContext, type ActiveOperation } from '~/contexts';
import { useGitWeb } from '~/hooks/useGitWeb';
import { watchSessionRuns, type RunSource } from './sessionRuns';
import { OperationPanel, type FailureGroup, type PanelState } from './OperationPanel';

/**
 * Progress for background work, reported in a panel docked top right
 * (OperationPanel): progress while it runs, then the outcome, with what did not
 * finish grouped by reason. The panel stays until closed when something failed.
 *
 * An action that queues Trigger.dev work hands back a `triggerSession`; the
 * global fetcher picks it up and this component, mounted once at the app root,
 * watches the batch and keeps the panel current. Nothing blocks, and because
 * it lives above the router the counts keep ticking while the instructor moves
 * around the app.
 *
 * Counts come from the runs themselves rather than from an estimate the server
 * sends: Trigger reports every run carrying the session tag, queued ones
 * included, so "18 of 30 repositories" is a fact about the work rather than a
 * percentage that has to be clamped.
 */

/** One unit of work, and the task that runs exactly once per unit. */
interface UnitSpec {
  tasks: string[];
  /**
   * Runs of these tasks count as units too, but only when they carry `tag`:
   * the same task also runs as a step inside a unit, where it must not count.
   */
  alsoTagged?: { tasks: string[]; tag: string };
  running: string;
  done: string;
  noun: string;
}

interface OperationSpec {
  /**
   * Ordered: the first shape with runs in it decides what a unit is here.
   * Publishing creates repositories, unless they already exist and the work is
   * only adding this assignment to them (an issue per repo in issue mode, a
   * submission row in push mode).
   */
  units: UnitSpec[];
  /** The placeholder callout the caller opened, which this one replaces. */
  notifyKey?: string;
  /** What to try when something did not finish, if there is a usual cause. */
  failureHint?: string;
}

const OPERATIONS: Record<string, OperationSpec> = {
  PUBLISH: {
    units: [
      {
        tasks: ['gh-create_git_repo'],
        // Sync also adds missing assignments to repos that already exist; each
        // of those is one repo's whole job, tagged so by the caller.
        alsoTagged: { tasks: ['gh-create_git_repo_assignment'], tag: 'standalone' },
        running: 'Creating student repositories',
        done: 'Student repositories created',
        noun: 'repositories',
      },
      {
        tasks: ['gh-create_git_repo_assignment'],
        // Only reached when the first unit has no runs — the repositories were
        // already there and the work is linking this assignment into them.
        running: 'Adding the assignment to existing repositories',
        done: 'Assignment added to existing repositories',
        noun: 'repositories',
      },
    ],
  },
  UPDATE_REPOS: {
    units: [
      {
        tasks: ['update_git_repo'],
        running: 'Updating student repositories',
        done: 'Student repositories updated',
        noun: 'repositories',
      },
    ],
  },
  CONTRIBUTIONS: {
    notifyKey: 'CALCULATE_REPO_CONTRIBUTIONS',
    units: [
      {
        tasks: ['calculate_repo_contributions'],
        running: 'Calculating contributions',
        done: 'Contributions calculated',
        noun: 'repositories',
      },
    ],
  },
  GRADERS: {
    units: [
      {
        tasks: ['add_grader_to_git_repo_assignment'],
        running: 'Assigning graders',
        done: 'Graders assigned',
        noun: 'assignments',
      },
    ],
  },
  TOKENS: {
    units: [
      {
        tasks: ['assign_tokens_to_student'],
        running: 'Assigning tokens',
        done: 'Tokens assigned',
        noun: 'students',
      },
    ],
  },
  AUTOGRADE: {
    notifyKey: 'AUTOGRADE_GIT_REPO_ASSIGNMENT',
    failureHint: 'Check that the Classmoji app has the "workflows" permission, then try again.',
    units: [
      {
        tasks: ['gh-commit_autograde_workflow'],
        running: 'Setting up autograding',
        done: 'Autograding set up',
        noun: 'repositories',
      },
    ],
  },
};

/** The spec copy says "repositories"; a Gitlab classroom says its own word. */
const localizeUnit = (unit: UnitSpec, repos: string): UnitSpec =>
  repos === 'repositories'
    ? unit
    : {
        ...unit,
        running: unit.running.replace(/repositories/g, repos),
        done: unit.done.replace(/repositories/g, repos),
        noun: unit.noun.replace(/repositories/g, repos),
      };

/** Which operation a task identifier belongs to. */
const OPERATION_BY_TASK: Record<string, string> = {
  'gh-create_git_repo': 'PUBLISH',
  'cf-create_git_repo': 'PUBLISH',
  'gh-create_git_repo_assignment': 'PUBLISH',
  'cf-create_git_repo_assignment': 'PUBLISH',
  'gh-add_collaborator_to_repo': 'PUBLISH',
  update_git_repo: 'UPDATE_REPOS',
  calculate_repo_contributions: 'CONTRIBUTIONS',
  add_grader_to_git_repo_assignment: 'GRADERS',
  assign_tokens_to_student: 'TOKENS',
  dispatch_autograde_workflow: 'AUTOGRADE',
  'gh-commit_autograde_workflow': 'AUTOGRADE',
};

// Realtime reports statuses with underscores; both spellings are accepted so a
// failed run is never mistaken for one still pending.
const FAILED = [
  'FAILED',
  'CRASHED',
  'INTERRUPTED',
  'SYSTEM_FAILURE',
  'SYSTEM FAILURE',
  'TIMED_OUT',
  'TIMED OUT',
  'EXPIRED',
  'CANCELED',
];

/** How long to wait for the first run before giving up on a silent batch. */
const FIRST_RUN_TIMEOUT_MS = 30_000;

/**
 * A (re)connect replays its snapshot one run at a time, so the list can be
 * briefly partial (see sessionRuns). The operation only counts as over once it
 * has looked over for this long; a partial list whose first runs happen to be
 * finished never ends it early.
 */
const SETTLE_MS = 2_000;

const updatedAtOf = (run: OperationRun) => new Date(run.updatedAt ?? 0).getTime();

/** Whether a run is one of a unit's own runs, rather than a step inside one. */
const isUnitRun = (unit: UnitSpec, run: OperationRun) =>
  unit.tasks.includes(run.taskIdentifier) ||
  Boolean(
    unit.alsoTagged?.tasks.includes(run.taskIdentifier) && run.tags?.includes(unit.alsoTagged.tag)
  );

/** Every run carrying the session tag, kept current (see sessionRuns). */
const useSessionRuns = (tag: string, settled: boolean) => {
  // `useApiClient` builds a new client on every render. Holding the first one
  // keeps the connection open across renders; depending on the client
  // reopened it on every update, and the aborted fetches read as failures.
  const client = useRef(useApiClient() as unknown as RunSource);
  const [runs, setRuns] = useState<OperationRun[]>([]);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (settled) return;
    return watchSessionRuns<OperationRun>(client.current, tag, {
      onRuns: setRuns,
      onError: setError,
    });
  }, [tag, settled]);

  return { runs, error };
};

/**
 * What a run carries about the work it was doing. Trigger hands the task's
 * payload back with the run, which is the only place the student, the team or
 * the repository is named.
 */
interface RunPayload {
  student?: { name?: string; login?: string } | null;
  user?: { name?: string } | null;
  repoName?: string | null;
  name?: string | null;
  assignment?: { title?: string } | null;
  issue?: { title?: string } | null;
  /** The repository a publish or sync run was for (Retry runs Sync on it). */
  repository?: { id?: string | null } | null;
}

/**
 * What a unit's run says it is doing right now (packages/tasks helpers/progress).
 */
interface RunStatus {
  current?: string;
  /** Why the run failed, when it knew (packages/tasks helpers/progress). */
  reason?: string;
}

export interface OperationRun {
  id: string;
  taskIdentifier: string;
  status: string;
  tags?: string[];
  updatedAt?: Date | string;
  payload?: RunPayload;
  metadata?: RunStatus;
}

const outcome = (status: string) =>
  status === 'COMPLETED' ? 'done' : FAILED.includes(status) ? 'failed' : 'pending';

/**
 * Who a run was for, in the words the instructor uses. Falls back to the task
 * identifier only when the payload names nobody, which should not happen for
 * the per-student tasks but is better than an empty row.
 */
const subjectOf = (run: OperationRun): string => {
  const p = run.payload ?? {};
  return (
    p.student?.login ||
    p.student?.name ||
    p.repoName ||
    p.user?.name ||
    p.assignment?.title ||
    p.issue?.title ||
    p.name ||
    run.taskIdentifier
  );
};

/**
 * Why a unit did not finish, from what its run reported (packages/tasks
 * helpers/progress reportFailureReason), or from its status when it said
 * nothing. A few words each: the panel is small.
 */
const reasonOf = (run: OperationRun): string =>
  run.metadata?.reason ??
  (run.status === 'TIMED_OUT' || run.status === 'TIMED OUT' ? 'timed_out' : 'unknown');

const REASON_COPY = (label: string): Record<string, { title: string; fix?: string }> => ({
  permission_denied: {
    title: `${label} refused access`,
    fix: 'An org owner must let the Classmoji app add collaborators.',
  },
  template_not_found: { title: 'Template not found', fix: 'Check the repository’s template.' },
  github_unreachable: { title: `${label} unreachable`, fix: 'Retry in a few minutes.' },
  timed_out: { title: 'Took too long' },
  unknown: { title: 'Something went wrong' },
});

/** Failed units grouped by reason, the largest group first. */
const groupFailures = (failed: OperationRun[], label: string): FailureGroup[] => {
  const copy = REASON_COPY(label);
  const groups = new Map<string, FailureGroup>();
  for (const run of failed) {
    const key = reasonOf(run);
    const group = groups.get(key) ?? { key, ...(copy[key] ?? copy.unknown), names: [] };
    group.names.push(subjectOf(run));
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.names.length - a.names.length);
};

/** The repository a publish or sync was for, so Retry can run Sync on it. */
interface RetryTarget {
  classSlug: string;
  repositoryId: string;
}

const retryTargetOf = (runs: OperationRun[]): RetryTarget | null => {
  for (const run of runs) {
    const tag = run.tags?.find(t => t.startsWith('classroom_'));
    const repositoryId = run.payload?.repository?.id;
    if (tag && repositoryId) return { classSlug: tag.slice('classroom_'.length), repositoryId };
  }
  return null;
};

/** A batch with nothing left over closes itself after this long. */
const CLEAN_FINISH_CLOSE_MS = 6_000;

/**
 * Mounted once, at the app root. Holds the panel itself so the outcome stays
 * on screen after the operation ends, which is what releases the slot for the
 * next one.
 */
export const OperationProgress = () => {
  const { operation, fetcher } = useContext(FetcherContext);
  const [panel, setPanel] = useState<PanelState | null>(null);
  const [retry, setRetry] = useState<RetryTarget | null>(null);

  // A new batch takes the panel over from the last one's outcome.
  useEffect(() => {
    if (operation) {
      setRetry(null);
      setPanel({ title: 'Starting', status: 'running', done: 0, total: 0, noun: '', failures: [] });
    }
    // Keyed on the session id alone: the same operation re-rendering must not
    // reset the panel it is filling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [operation?.session.id]);

  // A clean finish says so, then gets out of the way.
  useEffect(() => {
    if (panel?.status !== 'done' || panel.failures.length > 0) return;
    const timer = setTimeout(() => setPanel(null), CLEAN_FINISH_CLOSE_MS);
    return () => clearTimeout(timer);
  }, [panel]);

  // Sync retries only what is still missing, so Retry is Sync on the
  // repository. The action is owner-only, so it is offered on /admin pages.
  const canRetry =
    retry !== null &&
    typeof window !== 'undefined' &&
    window.location.pathname.startsWith('/admin/');
  const onRetry = () => {
    if (!retry) return;
    fetcher?.submit(JSON.stringify({ assignment_id: retry.repositoryId }), {
      method: 'post',
      action: `/admin/${retry.classSlug}/repos?/sync`,
      encType: 'application/json',
    });
  };

  return (
    <>
      {operation ? (
        // Keyed by session, so a second operation starts a clean subscription.
        <OperationWatcher
          key={operation.session.id}
          operation={operation}
          onPanel={setPanel}
          onRetryTarget={setRetry}
        />
      ) : null}
      {panel && (
        <OperationPanel
          state={panel}
          onClose={() => setPanel(null)}
          onRetry={canRetry && panel.status === 'done' ? onRetry : undefined}
        />
      )}
    </>
  );
};

interface WatcherProps {
  operation: ActiveOperation;
  onPanel: (panel: PanelState | null) => void;
  onRetryTarget: (target: RetryTarget | null) => void;
}

const OperationWatcher = ({ operation, ...rest }: WatcherProps) => (
  <TriggerAuthContext.Provider value={{ accessToken: operation.session.accessToken }}>
    <OperationRuns operation={operation} {...rest} />
  </TriggerAuthContext.Provider>
);

const OperationRuns = ({ operation, onPanel, onRetryTarget }: WatcherProps) => {
  const { endOperation, dismissNotify } = useContext(FetcherContext);
  const web = useGitWeb();
  const { terms } = web;
  const { revalidate } = useRevalidator();
  const settled = useRef(false);
  const [over, setOver] = useState(false);
  const { runs, error } = useSessionRuns(`session_${operation.session.id}`, over);

  const finish = (panel: PanelState | null) => {
    settled.current = true;
    setOver(true);
    onPanel(panel);
    endOperation();
  };

  const progress = useMemo(() => {
    const all = runs;
    if (all.length === 0) return null;

    const key = all.map(r => OPERATION_BY_TASK[r.taskIdentifier]).find(Boolean);
    const spec = key ? OPERATIONS[key] : undefined;
    if (!spec) return null;

    // The first unit shape with runs in it is the one being done here. With
    // none at all, the job ended (or failed) before fanning out, or had nothing
    // to fan out to; once everything has settled that is still an ending.
    const settledAll = all.every(r => outcome(r.status) !== 'pending');
    const unit =
      // Chosen by its own tasks only: a Sync that just adds assignments is not
      // "creating repositories", even though its runs would count toward it.
      spec.units.find(u => all.some(r => u.tasks.includes(r.taskIdentifier))) ??
      (settledAll ? spec.units[0] : undefined);
    if (!unit) return null;

    const unitRuns = all.filter(r => isUnitRun(unit, r));
    let done = 0;
    for (const run of unitRuns) if (outcome(run.status) === 'done') done += 1;
    // Failures are counted across the WHOLE batch, not just the runs that count
    // as a unit. Every repository can exist and the job still be wrong: an
    // invite that never landed leaves a student locked out of their own repo.
    const failed = all.filter(r => outcome(r.status) === 'failed');
    // A unit can sit a while between being counted, so the status line says
    // what is happening now: the unit that reported most recently.
    const current = unitRuns
      .filter(r => outcome(r.status) === 'pending' && r.metadata?.current)
      .sort((a, b) => updatedAtOf(b) - updatedAtOf(a))[0]?.metadata?.current;
    return {
      key,
      spec,
      unit,
      total: unitRuns.length,
      done,
      failed,
      complete: settledAll,
      current,
      retryTarget: key === 'PUBLISH' ? retryTargetOf(all) : null,
    };
  }, [runs]);

  // Read through a ref: the timer below is set once, and `runs` in its
  // closure would always be the empty first render, which dismissed every
  // operation still going at the 30 second mark.
  const runCount = useRef(0);
  runCount.current = runs.length;

  // A batch that never reports anything would otherwise spin forever.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (settled.current || runCount.current > 0) return;
      finish(null);
    }, FIRST_RUN_TIMEOUT_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (settled.current) return;

    if (error) {
      finish({
        title: 'Background work',
        status: 'lost',
        done: 0,
        total: 0,
        noun: '',
        failures: [],
      });
      return;
    }
    if (!progress) return;

    const { spec, total, done, failed, complete, current, retryTarget } = progress;
    const unit = localizeUnit(progress.unit, terms.repos);

    // Whatever the caller put up before the work started is redundant now.
    if (spec.notifyKey) dismissNotify(spec.notifyKey);
    onRetryTarget(retryTarget);

    const running: PanelState = {
      title: unit.running,
      status: 'running',
      done,
      total,
      current,
      noun: unit.noun,
      failures: groupFailures(failed, web.label),
    };

    if (!complete) {
      onPanel(running);
      return;
    }

    // Looks over: fill the bar first, whatever the count, so even a batch of one
    // is seen to finish rather than vanishing from an empty bar. It ends only if
    // nothing new arrives for a moment (SETTLE_MS). Any update re-runs this
    // effect, which cancels the ending.
    onPanel({ ...running, done: total, current: undefined });
    const timer = setTimeout(() => {
      if (settled.current) return;
      // The work changed what the page is showing: repositories, graders, tokens.
      revalidate();
      finish({ ...running, title: unit.done, status: 'done', current: undefined });
    }, SETTLE_MS);
    return () => clearTimeout(timer);
    // `onPanel` and `onRetryTarget` are state setters; the rest are refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [progress, error]);

  return null;
};

export default OperationProgress;
